from __future__ import annotations

from hashlib import sha256
import json
import os
from pathlib import Path
import platform
import re
import threading
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit

try:
    import keyring
except ImportError:  # Keep .env connections usable in a damaged runtime.
    keyring = None

try:
    from dotenv import dotenv_values
except ImportError:  # Keep the app importable so diagnostics can explain the runtime issue.
    dotenv_values = None


KEYRING_SERVICE = "com.extrahop.admin-tools.connections"
KEYRING_ACCOUNT = "saved-connections-v1"
ENV_CONNECTION_PATTERN = re.compile(
    r"^EH_CONNECTION_(360|ENTERPRISE)_([1-9][0-9]*)_"
    r"(TENANT|API_ID|API_SECRET|HOST|API_KEY|VERIFY_TLS)$"
)
TENANT_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
PLACEHOLDER_SECRET_VALUES = {
    "replace-with-api-id",
    "replace-with-api-key",
    "replace-with-api-secret",
    "replace-with-proxy-token",
}


class ConnectionStorageError(RuntimeError):
    """Raised when the operating-system credential store cannot be used."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "unavailable",
        recovery: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.recovery = dict(recovery) if recovery else None

    def public_status(self) -> dict[str, Any]:
        return {
            "available": False,
            "message": str(self),
            "code": self.code,
            "recovery": self.recovery,
        }


def _is_wsl() -> bool:
    if platform.system() != "Linux":
        return False
    release = platform.release().casefold()
    return "microsoft" in release or bool(os.environ.get("WSL_INTEROP"))


def _wsl_secret_service_setup_command() -> str:
    try:
        os_release = platform.freedesktop_os_release()
    except OSError:
        os_release = {}

    distribution_ids = {
        str(os_release.get("ID", "")).casefold(),
        *str(os_release.get("ID_LIKE", "")).casefold().split(),
    }
    if distribution_ids & {"debian", "ubuntu"}:
        return "sudo apt install gnome-keyring"
    if distribution_ids & {"fedora", "rhel", "centos"}:
        return "sudo dnf install gnome-keyring"
    if "arch" in distribution_ids:
        return "sudo pacman -S gnome-keyring"
    if distribution_ids & {"opensuse", "suse"}:
        return "sudo zypper install gnome-keyring"
    return ""


def _is_missing_keyring_backend(error: Exception) -> bool:
    errors = getattr(keyring, "errors", None) if keyring is not None else None
    error_type = getattr(errors, "NoKeyringError", None)
    return isinstance(error, error_type) if isinstance(error_type, type) else False


def resolve_local_env_path(app_root: Path) -> Path:
    """Resolve the local .env without walking into parent directories."""
    candidates = [Path.cwd() / ".env", app_root / ".env"]
    if app_root.name == "app":
        candidates.append(app_root.parent / ".env")

    seen: set[Path] = set()
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        if resolved.is_file():
            return resolved
    return (app_root / ".env").resolve()


class ConnectionStore:
    def __init__(
        self,
        app_root: Path,
        *,
        env_path: Path | None = None,
        keyring_backend: Any | None = None,
        dotenv_loader: Callable[..., Mapping[str, str | None]] | None = None,
    ) -> None:
        self.app_root = Path(app_root).resolve()
        self.env_path = (
            Path(env_path).resolve()
            if env_path
            else resolve_local_env_path(self.app_root)
        )
        self._keyring = keyring_backend if keyring_backend is not None else keyring
        self._dotenv_loader = dotenv_loader if dotenv_loader is not None else dotenv_values
        self._lock = threading.RLock()

    def list_connections(self) -> dict[str, Any]:
        env_configs, env_warnings = self._read_env_configs()
        keychain_configs: dict[str, dict[str, Any]] = {}
        storage_error: ConnectionStorageError | None = None
        try:
            keychain_configs = self._read_keychain_configs()
        except ConnectionStorageError as error:
            storage_error = error

        env_configs, skipped_env = self._without_placeholders(env_configs)
        keychain_configs, skipped_keychain = self._without_placeholders(keychain_configs)

        merged: dict[str, dict[str, Any]] = {}
        for config in keychain_configs.values():
            metadata = self._metadata(config, source="keychain")
            merged[metadata["id"]] = metadata
        for config in env_configs.values():
            metadata = self._metadata(config, source="env")
            existing = merged.get(metadata["id"])
            if existing:
                metadata["sources"] = ["env", "keychain"]
            merged[metadata["id"]] = metadata

        connections = sorted(
            merged.values(),
            key=lambda item: (
                0 if item["type"] == "360" else 1,
                item["label"].casefold(),
                item["id"],
            ),
        )
        types = {item["type"] for item in connections}
        warnings = list(env_warnings)
        skipped_placeholders = skipped_env + skipped_keychain
        if skipped_placeholders:
            warnings.append(
                f"Skipped {skipped_placeholders} example connection"
                f"{'' if skipped_placeholders == 1 else 's'} with placeholder values."
            )
        if storage_error:
            warnings.append(str(storage_error))

        secure_storage = {
            "available": storage_error is None and self._keyring is not None,
            "connectionCount": len(keychain_configs),
            "message": str(storage_error) if storage_error else None,
            "code": storage_error.code if storage_error else None,
            "recovery": storage_error.recovery if storage_error else None,
        }

        return {
            "connections": connections,
            "groupByDeployment": types == {"360", "enterprise"},
            "env": {
                "found": self.env_path.is_file(),
                "connectionCount": len(env_configs),
            },
            "secureStorage": secure_storage,
            "warnings": warnings,
        }

    def recheck_secure_storage(self) -> dict[str, Any]:
        """Refresh keyring backend discovery after the user changes OS setup."""
        with self._lock:
            if self._keyring is keyring and keyring is not None:
                initializer = getattr(
                    getattr(keyring, "core", None),
                    "init_backend",
                    None,
                )
                if callable(initializer):
                    initializer()
            return self.list_connections()

    def get(self, connection_id: str) -> dict[str, Any]:
        env_configs, _warnings = self._read_env_configs()
        if connection_id in env_configs:
            config = env_configs[connection_id]
            if self._is_placeholder_config(config):
                raise KeyError(connection_id)
            return dict(config)

        keychain_configs = self._read_keychain_configs()
        if connection_id not in keychain_configs:
            raise KeyError(connection_id)
        config = keychain_configs[connection_id]
        if self._is_placeholder_config(config):
            raise KeyError(connection_id)
        return dict(config)

    def save(self, config: Mapping[str, Any]) -> dict[str, Any]:
        normalized = self._persisted_config(config)
        connection_id = self._connection_id(normalized)
        with self._lock:
            configs = self._read_keychain_configs()
            configs[connection_id] = normalized
            self._write_keychain_configs(configs)
        return self._metadata(normalized, source="keychain")

    def prepare_update(
        self,
        connection_id: str,
        changes: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Merge browser-supplied changes without exposing stored secrets."""
        with self._lock:
            configs = self._read_keychain_configs()
            if connection_id not in configs:
                raise KeyError(connection_id)
            merged = dict(configs[connection_id])
            merged.update(
                {
                    key: value
                    for key, value in changes.items()
                    if value is not None
                }
            )
            return self._persisted_config(merged)

    def replace(
        self,
        connection_id: str,
        config: Mapping[str, Any],
    ) -> dict[str, Any]:
        normalized = self._persisted_config(config)
        new_connection_id = self._connection_id(normalized)
        with self._lock:
            configs = self._read_keychain_configs()
            if connection_id not in configs:
                raise KeyError(connection_id)
            del configs[connection_id]
            configs[new_connection_id] = normalized
            self._write_keychain_configs(configs)
        return self._metadata(normalized, source="keychain")

    def delete(self, connection_id: str) -> None:
        with self._lock:
            configs = self._read_keychain_configs()
            if connection_id not in configs:
                raise KeyError(connection_id)
            del configs[connection_id]
            self._write_keychain_configs(configs)

    def _read_keychain_configs(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            try:
                payload = self._require_keyring().get_password(
                    KEYRING_SERVICE,
                    KEYRING_ACCOUNT,
                )
            except Exception as error:
                raise self._unavailable_error(error, update=False) from error
            if not payload:
                return {}
            try:
                document = json.loads(payload)
                raw_configs = document["connections"]
                if document.get("version") != 1 or not isinstance(raw_configs, dict):
                    raise ValueError("unsupported credential payload")
                configs: dict[str, dict[str, Any]] = {}
                remove_transient_tokens = False
                for connection_id, config in raw_configs.items():
                    normalized = self._persisted_config(config)
                    if connection_id == self._connection_id(normalized):
                        configs[connection_id] = normalized
                    if isinstance(config, Mapping) and config.get("proxyToken"):
                        remove_transient_tokens = True
                if remove_transient_tokens:
                    self._write_keychain_configs(configs)
                return configs
            except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
                raise ConnectionStorageError(
                    "Saved ExtraHop connections in the operating-system credential "
                    "store could not be read."
                ) from error

    def _write_keychain_configs(
        self,
        configs: Mapping[str, Mapping[str, Any]],
    ) -> None:
        payload = json.dumps(
            {"version": 1, "connections": configs},
            separators=(",", ":"),
            sort_keys=True,
        )
        try:
            self._require_keyring().set_password(
                KEYRING_SERVICE,
                KEYRING_ACCOUNT,
                payload,
            )
        except Exception as error:
            raise self._unavailable_error(error, update=True) from error

    def _read_env_configs(self) -> tuple[dict[str, dict[str, Any]], list[str]]:
        if not self.env_path.is_file():
            return {}, []
        if self._dotenv_loader is None:
            return {}, ["The local .env file was found, but python-dotenv is unavailable."]

        try:
            values = self._dotenv_loader(self.env_path, interpolate=False)
        except Exception:
            return {}, ["The local .env file could not be read."]

        grouped: dict[tuple[str, int], dict[str, str]] = {}
        for key, value in values.items():
            match = ENV_CONNECTION_PATTERN.fullmatch(str(key))
            if not match or value is None:
                continue
            deployment, index_text, field = match.groups()
            grouped.setdefault((deployment, int(index_text)), {})[field] = str(value).strip()

        configs: dict[str, dict[str, Any]] = {}
        warnings: list[str] = []
        for (deployment, index), fields in sorted(grouped.items()):
            try:
                if deployment == "360":
                    config = {
                        "type": "360",
                        "tenant": fields["TENANT"],
                        "apiId": fields["API_ID"],
                        "apiSecret": fields["API_SECRET"],
                    }
                else:
                    config = {
                        "type": "enterprise",
                        "host": fields["HOST"],
                        "apiKey": fields["API_KEY"],
                        "verifyTls": self._parse_bool(fields.get("VERIFY_TLS", "true")),
                    }
                normalized = self._normalize_config(config)
                configs[self._connection_id(normalized)] = normalized
            except (KeyError, TypeError, ValueError):
                warnings.append(
                    f"Skipped invalid EH_CONNECTION_{deployment}_{index} settings in .env."
                )
        return configs, warnings

    def _require_keyring(self) -> Any:
        if self._keyring is None:
            raise ConnectionStorageError(
                "The operating-system credential store dependency is unavailable."
            )
        return self._keyring

    @staticmethod
    def _unavailable_error(error: Exception, *, update: bool) -> ConnectionStorageError:
        if _is_wsl() and _is_missing_keyring_backend(error):
            message = "Secure saved connections are not set up in WSL"
            if update:
                message += "; this connection was not saved."
            else:
                message += "."
            return ConnectionStorageError(
                message,
                code="wsl-secret-service-unavailable",
                recovery={
                    "kind": "wsl-secret-service",
                    "command": _wsl_secret_service_setup_command(),
                },
            )

        message = "The operating-system credential store is unavailable"
        if update:
            message += "; saved connections were not updated."
        else:
            message += "."
        return ConnectionStorageError(message)

    @classmethod
    def _without_placeholders(
        cls,
        configs: Mapping[str, dict[str, Any]],
    ) -> tuple[dict[str, dict[str, Any]], int]:
        filtered = {
            connection_id: config
            for connection_id, config in configs.items()
            if not cls._is_placeholder_config(config)
        }
        return filtered, len(configs) - len(filtered)

    @classmethod
    def _is_placeholder_config(cls, config: Mapping[str, Any]) -> bool:
        normalized = cls._normalize_config(config)
        secret_fields = ("apiId", "apiSecret", "apiKey", "proxyToken")
        if any(
            str(normalized.get(field, "")).strip().lower() in PLACEHOLDER_SECRET_VALUES
            for field in secret_fields
        ):
            return True

        if normalized["type"] != "enterprise":
            return False
        candidate = f"https://{normalized['host']}"
        hostname = (urlsplit(candidate).hostname or "").casefold().rstrip(".")
        return hostname == "example.test" or hostname.endswith(".example.test")

    @staticmethod
    def _parse_bool(value: str) -> bool:
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
        raise ValueError("expected a boolean")

    @staticmethod
    def _normalize_config(config: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(config, Mapping):
            raise TypeError("connection config must be a mapping")

        deployment = str(config.get("type", "")).strip().lower()
        if deployment == "360":
            tenant = str(config.get("tenant", "")).strip().lower()
            api_id = str(config.get("apiId", "")).strip()
            api_secret = str(config.get("apiSecret", "")).strip()
            if not TENANT_PATTERN.fullmatch(tenant) or not api_id or not api_secret:
                raise ValueError("invalid RevealX 360 connection")
            return {
                "type": "360",
                "tenant": tenant,
                "apiId": api_id,
                "apiSecret": api_secret,
            }

        if deployment == "enterprise":
            host = ConnectionStore._normalize_enterprise_host(config.get("host", ""))
            api_key = str(config.get("apiKey", "")).strip()
            if not api_key:
                raise ValueError("invalid RevealX Enterprise connection")
            normalized = {
                "type": "enterprise",
                "host": host,
                "apiKey": api_key,
                "verifyTls": bool(config.get("verifyTls", True)),
            }
            proxy_token = str(config.get("proxyToken", "")).strip()
            if proxy_token:
                normalized["proxyToken"] = proxy_token
            return normalized

        raise ValueError("unsupported deployment type")

    @staticmethod
    def _persisted_config(config: Mapping[str, Any]) -> dict[str, Any]:
        normalized = ConnectionStore._normalize_config(config)
        # Remote-access proxy tokens are short-lived, single-use session
        # inputs. They must never be retained alongside durable credentials.
        normalized.pop("proxyToken", None)
        return normalized

    @staticmethod
    def _normalize_enterprise_host(raw_host: Any) -> str:
        value = str(raw_host or "").strip()
        candidate = value if "://" in value else f"https://{value}"
        try:
            parsed = urlsplit(candidate)
            port = parsed.port
        except ValueError as error:
            raise ValueError("invalid Enterprise host") from error
        if (
            parsed.scheme.lower() != "https"
            or parsed.username
            or parsed.password
            or not parsed.hostname
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("invalid Enterprise host")
        hostname = parsed.hostname
        formatted = f"[{hostname}]" if ":" in hostname else hostname
        if port is not None and port != 443:
            formatted = f"{formatted}:{port}"
        return formatted

    @classmethod
    def _connection_id(cls, config: Mapping[str, Any]) -> str:
        normalized = cls._normalize_config(config)
        if normalized["type"] == "360":
            destination = normalized["tenant"]
        else:
            destination = normalized["host"].casefold()
        digest = sha256(f"{normalized['type']}:{destination}".encode("utf-8")).hexdigest()
        return f"{normalized['type']}-{digest[:20]}"

    @classmethod
    def _metadata(cls, config: Mapping[str, Any], *, source: str) -> dict[str, Any]:
        normalized = cls._normalize_config(config)
        if normalized["type"] == "360":
            label = normalized["tenant"]
            metadata: dict[str, Any] = {
                "id": cls._connection_id(normalized),
                "type": "360",
                "label": label,
                "tenant": label,
            }
        else:
            label = normalized["host"]
            metadata = {
                "id": cls._connection_id(normalized),
                "type": "enterprise",
                "label": label,
                "host": label,
                "verifyTls": normalized["verifyTls"],
            }
        metadata["source"] = source
        metadata["sources"] = [source]
        metadata["editable"] = source == "keychain"
        return metadata
