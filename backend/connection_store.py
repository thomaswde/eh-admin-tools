from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path
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
    r"(TENANT|API_ID|API_SECRET|HOST|API_KEY|PROXY_TOKEN|VERIFY_TLS)$"
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
        storage_error: str | None = None
        try:
            keychain_configs = self._read_keychain_configs()
        except ConnectionStorageError as error:
            storage_error = str(error)

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
            warnings.append(storage_error)

        return {
            "connections": connections,
            "groupByDeployment": types == {"360", "enterprise"},
            "env": {
                "found": self.env_path.is_file(),
                "connectionCount": len(env_configs),
            },
            "secureStorage": {
                "available": storage_error is None and self._keyring is not None,
                "connectionCount": len(keychain_configs),
                "message": storage_error,
            },
            "warnings": warnings,
        }

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
        normalized = self._normalize_config(config)
        connection_id = self._connection_id(normalized)
        with self._lock:
            configs = self._read_keychain_configs()
            configs[connection_id] = normalized
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
                raise ConnectionStorageError(
                    "The operating-system credential store is unavailable; "
                    "the connection was not saved."
                ) from error
        return self._metadata(normalized, source="keychain")

    def _read_keychain_configs(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            try:
                payload = self._require_keyring().get_password(
                    KEYRING_SERVICE,
                    KEYRING_ACCOUNT,
                )
            except Exception as error:
                raise ConnectionStorageError(
                    "The operating-system credential store is unavailable."
                ) from error
            if not payload:
                return {}
            try:
                document = json.loads(payload)
                raw_configs = document["connections"]
                if document.get("version") != 1 or not isinstance(raw_configs, dict):
                    raise ValueError("unsupported credential payload")
                return {
                    connection_id: self._normalize_config(config)
                    for connection_id, config in raw_configs.items()
                    if connection_id == self._connection_id(config)
                }
            except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
                raise ConnectionStorageError(
                    "Saved ExtraHop connections in the operating-system credential "
                    "store could not be read."
                ) from error

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
                    if fields.get("PROXY_TOKEN"):
                        config["proxyToken"] = fields["PROXY_TOKEN"]
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
        return metadata
