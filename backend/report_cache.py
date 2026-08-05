from __future__ import annotations

from datetime import datetime, timezone
import getpass
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import tempfile
from threading import Lock
from typing import Any, Mapping


REPORT_CACHE_SCHEMA_VERSION = 1
REPORT_IDS = frozenset({"device-discovery", "records-report", "system-health"})
DEFAULT_MAX_ENTRY_BYTES = 32 * 1024 * 1024
DEFAULT_MAX_USER_BYTES = 512 * 1024 * 1024
DEFAULT_MAX_CONNECTIONS = 64
_SAFE_COMPONENT = re.compile(r"[^a-z0-9._-]+")


class ReportCacheError(RuntimeError):
    pass


class ReportCacheLimitError(ReportCacheError):
    pass


def cache_user_key(username: str | None = None) -> str:
    """Return a stable, filesystem-safe key for the local OS user."""
    raw = str(username if username is not None else getpass.getuser()).strip() or "local-user"
    slug = _SAFE_COMPONENT.sub("-", raw.casefold()).strip("-._")[:40] or "local-user"
    digest = sha256(raw.encode("utf-8")).hexdigest()[:10]
    return f"{slug}-{digest}"


def connection_cache_id(config: Mapping[str, Any]) -> str:
    """Match the saved-connection identity without including credentials."""
    deployment_type = str(config.get("type", "")).strip().casefold()
    if deployment_type == "360":
        destination = str(config.get("tenant", "")).strip().casefold()
    elif deployment_type == "enterprise":
        destination = str(config.get("host", "")).strip().casefold()
    else:
        raise ValueError("unsupported connection type")
    if not destination:
        raise ValueError("connection destination is missing")
    digest = sha256(f"{deployment_type}:{destination}".encode("utf-8")).hexdigest()
    return f"{deployment_type}-{digest[:20]}"


def public_connection_metadata(config: Mapping[str, Any]) -> dict[str, Any]:
    deployment_type = str(config.get("type", "")).strip().casefold()
    if deployment_type == "360":
        return {
            "id": connection_cache_id(config),
            "type": "360",
            "tenant": str(config.get("tenant", "")).strip().casefold(),
        }
    if deployment_type == "enterprise":
        return {
            "id": connection_cache_id(config),
            "type": "enterprise",
            "host": str(config.get("host", "")).strip().casefold(),
        }
    raise ValueError("unsupported connection type")


class ReportCache:
    def __init__(
        self,
        root: Path,
        *,
        username: str | None = None,
        max_entry_bytes: int = DEFAULT_MAX_ENTRY_BYTES,
        max_user_bytes: int = DEFAULT_MAX_USER_BYTES,
        max_connections: int = DEFAULT_MAX_CONNECTIONS,
    ) -> None:
        self.root = Path(root)
        self.user_key = cache_user_key(username)
        self.max_entry_bytes = max(1, int(max_entry_bytes))
        self.max_user_bytes = max(self.max_entry_bytes, int(max_user_bytes))
        self.max_connections = max(1, int(max_connections))
        self._lock = Lock()

    @property
    def user_directory(self) -> Path:
        return self.root / self.user_key

    def read(self, report_id: str, connection: Mapping[str, Any]) -> dict[str, Any] | None:
        report_path = self._report_path(report_id, connection)
        try:
            raw = report_path.read_bytes()
        except FileNotFoundError:
            return None
        except OSError as error:
            raise ReportCacheError(f"Could not read cached report: {error}") from error
        if len(raw) > self.max_entry_bytes:
            return None
        try:
            document = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        expected_connection_id = connection_cache_id(connection)
        if (
            not isinstance(document, dict)
            or document.get("schema_version") != REPORT_CACHE_SCHEMA_VERSION
            or document.get("report_id") != report_id
            or document.get("connection_id") != expected_connection_id
            or "payload" not in document
        ):
            return None
        return document

    def write(self, report_id: str, connection: Mapping[str, Any], payload: Any) -> dict[str, Any]:
        report_path = self._report_path(report_id, connection)
        connection_metadata = public_connection_metadata(connection)
        cached_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        document = {
            "schema_version": REPORT_CACHE_SCHEMA_VERSION,
            "report_id": report_id,
            "connection_id": connection_metadata["id"],
            "cached_at": cached_at,
            "payload": payload,
        }
        try:
            encoded = (json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        except (TypeError, ValueError) as error:
            raise ReportCacheError("Cached report payload is not valid JSON") from error
        if len(encoded) > self.max_entry_bytes:
            raise ReportCacheLimitError(
                f"Cached report exceeds the configured {self.max_entry_bytes:,}-byte entry limit."
            )

        with self._lock:
            try:
                report_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                self._write_json_atomic(
                    report_path.parent.parent / "connection.json",
                    {
                        "schema_version": REPORT_CACHE_SCHEMA_VERSION,
                        "connection": connection_metadata,
                        "updated_at": cached_at,
                    },
                )
                self._write_bytes_atomic(report_path, encoded)
                self._prune_user_cache(report_path)
            except ReportCacheError:
                raise
            except OSError as error:
                raise ReportCacheError(f"Could not write cached report: {error}") from error
        return document

    def _report_path(self, report_id: str, connection: Mapping[str, Any]) -> Path:
        if report_id not in REPORT_IDS:
            raise ValueError("unsupported report cache id")
        return self.user_directory / connection_cache_id(connection) / "reports" / f"{report_id}.json"

    def _write_json_atomic(self, path: Path, value: Any) -> None:
        encoded = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        self._write_bytes_atomic(path, encoded)

    @staticmethod
    def _write_bytes_atomic(path: Path, content: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        temp_path = Path(temp_name)
        try:
            os.chmod(temp_path, 0o600)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            temp_path.replace(path)
            os.chmod(path, 0o600)
        except Exception:
            try:
                os.close(descriptor)
            except OSError:
                pass
            temp_path.unlink(missing_ok=True)
            raise

    def _prune_user_cache(self, protected_path: Path) -> None:
        entries = []
        total_bytes = 0
        if not self.user_directory.is_dir():
            return
        for path in self.user_directory.glob("*/reports/*.json"):
            try:
                stat = path.stat()
            except OSError:
                continue
            total_bytes += stat.st_size
            if path != protected_path:
                entries.append((stat.st_mtime, path, stat.st_size))
        for _, path, size in sorted(entries):
            if total_bytes <= self.max_user_bytes:
                break
            try:
                path.unlink()
            except OSError:
                continue
            total_bytes -= size

        self._remove_empty_connections()
        connection_dirs = []
        for connection_dir in self.user_directory.iterdir():
            reports_dir = connection_dir / "reports"
            if not connection_dir.is_dir() or not reports_dir.is_dir():
                continue
            report_files = list(reports_dir.glob("*.json"))
            if not report_files:
                continue
            modified = []
            for path in report_files:
                try:
                    modified.append(path.stat().st_mtime)
                except OSError:
                    continue
            newest = max(modified, default=0)
            connection_dirs.append((newest, connection_dir))
        protected_connection = protected_path.parent.parent
        removable = [item for item in sorted(connection_dirs) if item[1] != protected_connection]
        while len(connection_dirs) > self.max_connections and removable:
            _, connection_dir = removable.pop(0)
            self._remove_connection(connection_dir)
            connection_dirs = [item for item in connection_dirs if item[1] != connection_dir]

    def _remove_empty_connections(self) -> None:
        for connection_dir in self.user_directory.iterdir():
            reports_dir = connection_dir / "reports"
            if not connection_dir.is_dir() or not reports_dir.is_dir():
                continue
            if any(reports_dir.glob("*.json")):
                continue
            self._remove_connection(connection_dir)

    @staticmethod
    def _remove_connection(connection_dir: Path) -> None:
        reports_dir = connection_dir / "reports"
        if reports_dir.is_dir():
            for path in reports_dir.glob("*.json"):
                path.unlink(missing_ok=True)
            try:
                reports_dir.rmdir()
            except OSError:
                return
        (connection_dir / "connection.json").unlink(missing_ok=True)
        try:
            connection_dir.rmdir()
        except OSError:
            return
