from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from itertools import islice
from pathlib import Path
from queue import Empty, Full, Queue
from threading import Event, Lock, Thread
from typing import Any
import json
import os
import re
import time

import httpx


LOG_VERBOSITIES = {"off", "errors", "metadata", "full"}
REDACTED = "[redacted]"
SENSITIVE_KEY_PARTS = (
    "authorization",
    "apikey",
    "api_key",
    "apiid",
    "api_id",
    "api_secret",
    "secret",
    "password",
    "product_key",
    "token",
    "cookie",
)

DEFAULT_MAX_PREVIEW_BYTES = 16 * 1024
DEFAULT_MAX_ENTRY_BYTES = 64 * 1024
DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024
DEFAULT_BACKUP_COUNT = 3
DEFAULT_QUEUE_SIZE = 256
MIN_ENTRY_BYTES = 256
MAX_PREVIEW_ITEMS = 50
MAX_PREVIEW_DEPTH = 6

_STOP = object()
_JSON_SECRET_PATTERN = re.compile(
    r'(?P<prefix>["\'](?P<key>[^"\']+)["\']\s*:\s*)'
    r'(?P<value>["\'][^"\']*["\']|[^,}\]\s]+)',
    re.IGNORECASE,
)
_KEY_VALUE_SECRET_PATTERN = re.compile(
    r"(?P<prefix>(?:authorization|apikey|api_key|apiid|api_id|api_secret|secret|password|product_key|token|cookie)\s*=\s*)"
    r"(?P<value>[^&\s,;]+)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class _QueuedLine:
    path: Path
    line: bytes


@dataclass(frozen=True)
class _FlushRequest:
    completed: Event


class ApiResponseLogger:
    def __init__(
        self,
        log_path: Path,
        verbosity: str = "errors",
        *,
        max_preview_bytes: int = DEFAULT_MAX_PREVIEW_BYTES,
        max_entry_bytes: int = DEFAULT_MAX_ENTRY_BYTES,
        max_log_bytes: int = DEFAULT_MAX_LOG_BYTES,
        backup_count: int = DEFAULT_BACKUP_COUNT,
        queue_size: int = DEFAULT_QUEUE_SIZE,
    ) -> None:
        self.log_path = Path(log_path)
        self.verbosity = self._normalize_verbosity(verbosity)
        self.max_preview_bytes = max(1, int(max_preview_bytes))
        self.max_log_bytes = max(MIN_ENTRY_BYTES, int(max_log_bytes))
        self.max_entry_bytes = min(
            self.max_log_bytes,
            max(MIN_ENTRY_BYTES, int(max_entry_bytes)),
        )
        self.backup_count = max(0, int(backup_count))
        self._queue: Queue[Any] = Queue(maxsize=max(1, int(queue_size)))
        self._state_lock = Lock()
        self._closed = False
        self._dropped_entries = 0
        self._writer = Thread(
            target=self._writer_loop,
            name="api-response-log-writer",
            daemon=True,
        )
        self._writer.start()

    def configure(self, verbosity: str | None = None, log_path: str | None = None) -> dict[str, Any]:
        normalized = self._normalize_verbosity(verbosity) if verbosity is not None else None
        with self._state_lock:
            if normalized is not None:
                self.verbosity = normalized
            if log_path:
                self.log_path = Path(log_path).expanduser()
        return self.status()

    def status(self) -> dict[str, Any]:
        with self._state_lock:
            return {
                "verbosity": self.verbosity,
                "path": str(self.log_path),
                "enabled": self.verbosity != "off" and not self._closed,
                "closed": self._closed,
                "queued_entries": self._queue.qsize(),
                "dropped_entries": self._dropped_entries,
            }

    def should_log(self, status_code: int) -> bool:
        with self._state_lock:
            verbosity = self.verbosity
            closed = self._closed
        if closed or verbosity == "off":
            return False
        if verbosity == "errors":
            return status_code < 200 or status_code >= 300
        return True

    def wants_request_body(self) -> bool:
        """Return whether the caller should pay to decode a request payload."""
        with self._state_lock:
            return not self._closed and self.verbosity == "full"

    def log_response(
        self,
        *,
        method: str,
        endpoint: str,
        response: httpx.Response,
        started_at: float,
        request_body: Any = None,
        context: str = "api",
    ) -> None:
        try:
            if not self.should_log(response.status_code):
                return

            with self._state_lock:
                verbosity = self.verbosity

            elapsed_ms = round((time.perf_counter() - started_at) * 1000, 2)
            response_payload, response_truncated = self._response_payload(response)
            entry: dict[str, Any] = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "context": self._bounded_text(context),
                "method": self._bounded_text(method.upper()),
                "endpoint": self._bounded_text(endpoint),
                "url": self._bounded_text(str(response.request.url)),
                "status_code": response.status_code,
                "reason": self._bounded_text(response.reason_phrase),
                "elapsed_ms": elapsed_ms,
                "content_type": self._bounded_text(response.headers.get("content-type", "")),
                "response_bytes": len(response.content or b""),
            }

            if verbosity in {"errors", "metadata", "full"}:
                entry["response_shape"] = (
                    {
                        "type": "truncated_preview",
                        "preview_bytes": self.max_preview_bytes,
                        "response_bytes": len(response.content or b""),
                    }
                    if response_truncated
                    else self._shape(response_payload)
                )

            if verbosity == "full":
                if request_body is not None:
                    entry["request_body"] = self._preview_value(request_body)
                entry["response"] = response_payload
            elif verbosity == "errors":
                entry["response"] = response_payload

            self._enqueue(entry)
        except Exception:
            # Logging is diagnostic only; never break the proxied API workflow.
            return

    def log_binary_response(
        self,
        *,
        method: str,
        endpoint: str,
        response: httpx.Response,
        started_at: float,
        response_bytes: int,
        context: str = "binary_download",
    ) -> None:
        """Log binary transfer metadata without reading or previewing its body."""
        try:
            if not self.should_log(response.status_code):
                return

            entry = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "context": self._bounded_text(context),
                "method": self._bounded_text(method.upper()),
                "endpoint": self._bounded_text(endpoint),
                "url": self._bounded_text(str(response.request.url)),
                "status_code": response.status_code,
                "reason": self._bounded_text(response.reason_phrase),
                "elapsed_ms": round((time.perf_counter() - started_at) * 1000, 2),
                "content_type": self._bounded_text(response.headers.get("content-type", "")),
                "response_bytes": max(0, int(response_bytes)),
                "response_shape": {"type": "binary"},
            }
            self._enqueue(entry)
        except Exception:
            # Logging is diagnostic only; never break the binary transfer.
            return

    def log_network_error(
        self,
        *,
        method: str,
        endpoint: str,
        url: str,
        error: httpx.RequestError,
        started_at: float,
        context: str = "api",
    ) -> None:
        try:
            with self._state_lock:
                if self._closed or self.verbosity == "off":
                    return

            entry = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "context": self._bounded_text(context),
                "method": self._bounded_text(method.upper()),
                "endpoint": self._bounded_text(endpoint),
                "url": self._bounded_text(url),
                "status_code": None,
                "reason": "Network Error",
                "elapsed_ms": round((time.perf_counter() - started_at) * 1000, 2),
                "error": {
                    "type": self._bounded_text(error.__class__.__name__),
                    "message": self._bounded_text(str(error) or repr(error)),
                },
            }
            self._enqueue(entry)
        except Exception:
            return

    def flush(self, timeout: float | None = 5.0) -> bool:
        with self._state_lock:
            if self._closed:
                return not self._writer.is_alive()

        request = _FlushRequest(Event())
        deadline = None if timeout is None else time.monotonic() + max(0.0, timeout)
        try:
            if deadline is None:
                self._queue.put(request)
            else:
                self._queue.put(request, timeout=max(0.0, deadline - time.monotonic()))
        except Full:
            return False

        remaining = None if deadline is None else max(0.0, deadline - time.monotonic())
        return request.completed.wait(remaining)

    def close(self, timeout: float | None = 5.0) -> bool:
        with self._state_lock:
            if self._closed and not self._writer.is_alive():
                return True
            self._closed = True

        deadline = None if timeout is None else time.monotonic() + max(0.0, timeout)
        request = _FlushRequest(Event())
        try:
            if deadline is None:
                self._queue.put(request)
            else:
                self._queue.put(request, timeout=max(0.0, deadline - time.monotonic()))
        except Full:
            return False

        remaining = None if deadline is None else max(0.0, deadline - time.monotonic())
        if not request.completed.wait(remaining):
            return False

        try:
            if deadline is None:
                self._queue.put(_STOP)
            else:
                self._queue.put(_STOP, timeout=max(0.0, deadline - time.monotonic()))
        except Full:
            return False

        self._writer.join(None if deadline is None else max(0.0, deadline - time.monotonic()))
        return not self._writer.is_alive()

    def _enqueue(self, entry: dict[str, Any]) -> None:
        line = self._serialize_entry(entry)
        with self._state_lock:
            if self._closed:
                return
            path = self.log_path
        try:
            self._queue.put_nowait(_QueuedLine(path=path, line=line))
        except Full:
            with self._state_lock:
                self._dropped_entries += 1

    def _writer_loop(self) -> None:
        while True:
            try:
                item = self._queue.get(timeout=0.5)
            except Empty:
                continue

            try:
                if item is _STOP:
                    return
                if isinstance(item, _FlushRequest):
                    item.completed.set()
                    continue
                if isinstance(item, _QueuedLine):
                    try:
                        self._write_line(item)
                    except Exception:
                        # A malformed diagnostic item must not kill the writer.
                        pass
            finally:
                self._queue.task_done()

    def _write_line(self, item: _QueuedLine) -> None:
        try:
            item.path.parent.mkdir(parents=True, exist_ok=True)
            self._rotate_if_needed(item.path, len(item.line))
            with item.path.open("ab") as handle:
                handle.write(item.line)
            os.chmod(item.path, 0o600)
        except OSError:
            return

    def _rotate_if_needed(self, path: Path, incoming_bytes: int) -> None:
        try:
            current_bytes = path.stat().st_size
        except FileNotFoundError:
            return

        if current_bytes == 0 or current_bytes + incoming_bytes <= self.max_log_bytes:
            return

        if self.backup_count == 0:
            path.unlink(missing_ok=True)
            return

        oldest = Path(f"{path}.{self.backup_count}")
        oldest.unlink(missing_ok=True)
        for number in range(self.backup_count - 1, 0, -1):
            source = Path(f"{path}.{number}")
            if source.exists():
                os.replace(source, Path(f"{path}.{number + 1}"))
        os.replace(path, Path(f"{path}.1"))
        for number in range(1, self.backup_count + 1):
            backup = Path(f"{path}.{number}")
            if backup.exists():
                os.chmod(backup, 0o600)

    def _serialize_entry(self, entry: dict[str, Any]) -> bytes:
        line = self._json_line(entry)
        if len(line) <= self.max_entry_bytes:
            return line

        reduced = dict(entry)
        reduced.pop("request_body", None)
        reduced.pop("response", None)
        reduced.pop("response_shape", None)
        reduced["entry_truncated"] = True
        line = self._json_line(reduced)
        if len(line) <= self.max_entry_bytes:
            return line

        minimal = {
            "timestamp": entry.get("timestamp"),
            "context": entry.get("context"),
            "method": entry.get("method"),
            "endpoint": entry.get("endpoint"),
            "status_code": entry.get("status_code"),
            "reason": entry.get("reason"),
            "entry_truncated": True,
        }
        text_limit = max(8, self.max_entry_bytes // 8)
        for key in ("timestamp", "context", "method", "endpoint", "reason"):
            minimal[key] = self._bounded_text(minimal.get(key, ""), text_limit)
        line = self._json_line(minimal)
        if len(line) <= self.max_entry_bytes:
            return line

        # The configured minimum allows this final valid JSON marker to fit.
        return self._json_line({"entry_truncated": True})

    @staticmethod
    def _json_line(entry: dict[str, Any]) -> bytes:
        return (json.dumps(entry, ensure_ascii=False, default=str) + "\n").encode("utf-8")

    @staticmethod
    def _normalize_verbosity(verbosity: str) -> str:
        normalized = str(verbosity or "off").lower()
        if normalized not in LOG_VERBOSITIES:
            raise ValueError(f"Unsupported API logging verbosity: {verbosity}")
        return normalized

    def _response_payload(self, response: httpx.Response) -> tuple[Any, bool]:
        content = response.content or b""
        if not content:
            return {}, False

        if len(content) > self.max_preview_bytes:
            preview = content[: self.max_preview_bytes].decode("utf-8", errors="replace")
            return {
                "preview": self._redact_text_preview(preview),
                "truncated": True,
                "preview_bytes": self.max_preview_bytes,
            }, True

        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            try:
                return self._preview_value(response.json()), False
            except ValueError:
                pass

        return self._preview_value(content.decode("utf-8", errors="replace")), False

    def _preview_value(self, value: Any) -> Any:
        remaining = [self.max_preview_bytes]
        return self._redact_bounded(value, remaining, 0)

    def _redact_bounded(self, value: Any, remaining: list[int], depth: int) -> Any:
        if remaining[0] <= 0:
            return "[truncated]"
        if depth >= MAX_PREVIEW_DEPTH:
            return f"[{self._type_name(value)} truncated]"

        if isinstance(value, dict):
            preview: dict[Any, Any] = {}
            items = list(islice(value.items(), MAX_PREVIEW_ITEMS))
            for key, child in items:
                key_text = str(key)
                remaining[0] -= min(len(key_text), remaining[0])
                if self._is_sensitive_key(key_text):
                    preview[key] = REDACTED
                else:
                    preview[key] = self._redact_bounded(child, remaining, depth + 1)
                if remaining[0] <= 0:
                    break
            if len(value) > len(items) or remaining[0] <= 0:
                preview["[truncated]"] = True
            return preview

        if isinstance(value, (list, tuple)):
            preview = []
            for child in value[:MAX_PREVIEW_ITEMS]:
                preview.append(self._redact_bounded(child, remaining, depth + 1))
                if remaining[0] <= 0:
                    break
            if len(value) > len(preview):
                preview.append("[truncated]")
            return preview

        if isinstance(value, bytes):
            value = value.decode("utf-8", errors="replace")
        if isinstance(value, str):
            allowed = max(0, min(len(value), remaining[0]))
            remaining[0] -= allowed
            preview = value if allowed == len(value) else f"{value[:allowed]}[truncated]"
            return self._redact_text_preview(preview)

        remaining[0] -= min(16, remaining[0])
        return value

    def _redact_text_preview(self, value: str) -> str:
        def replace(match: re.Match[str]) -> str:
            if self._is_sensitive_key(match.group("key")):
                return f'{match.group("prefix")}"{REDACTED}"'
            return match.group(0)

        redacted = _JSON_SECRET_PATTERN.sub(replace, value)
        return _KEY_VALUE_SECRET_PATTERN.sub(
            lambda match: f'{match.group("prefix")}{REDACTED}',
            redacted,
        )

    @staticmethod
    def _is_sensitive_key(key: str) -> bool:
        key_text = str(key).lower().replace("-", "_")
        return any(part in key_text for part in SENSITIVE_KEY_PARTS)

    def _bounded_text(self, value: Any, limit: int | None = None) -> str:
        text = str(value or "")
        maximum = self.max_preview_bytes if limit is None else max(1, int(limit))
        preview = text if len(text) <= maximum else f"{text[:maximum]}[truncated]"
        return self._redact_text_preview(preview)

    def _shape(self, value: Any, depth: int = 0) -> Any:
        if depth >= 4:
            return self._type_name(value)

        if isinstance(value, dict):
            return {
                key: self._shape(child, depth + 1)
                for key, child in islice(value.items(), MAX_PREVIEW_ITEMS)
            }

        if isinstance(value, list):
            first_shape = self._shape(value[0], depth + 1) if value else None
            return {"type": "array", "length": len(value), "first": first_shape}

        return self._type_name(value)

    @staticmethod
    def _type_name(value: Any) -> str:
        if value is None:
            return "null"
        if isinstance(value, bool):
            return "boolean"
        if isinstance(value, int) and not isinstance(value, bool):
            return "integer"
        if isinstance(value, float):
            return "number"
        if isinstance(value, str):
            return "string"
        return value.__class__.__name__
