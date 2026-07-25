from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any
import json
import os
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
    "token",
    "cookie",
)


class ApiResponseLogger:
    def __init__(self, log_path: Path, verbosity: str = "errors") -> None:
        self.log_path = log_path
        self.verbosity = self._normalize_verbosity(verbosity)
        self._lock = Lock()

    def configure(self, verbosity: str | None = None, log_path: str | None = None) -> dict[str, Any]:
        if verbosity is not None:
            self.verbosity = self._normalize_verbosity(verbosity)

        if log_path:
            self.log_path = Path(log_path).expanduser()

        return self.status()

    def status(self) -> dict[str, Any]:
        return {
            "verbosity": self.verbosity,
            "path": str(self.log_path),
            "enabled": self.verbosity != "off",
        }

    def should_log(self, status_code: int) -> bool:
        if self.verbosity == "off":
            return False
        if self.verbosity == "errors":
            return status_code < 200 or status_code >= 300
        return True

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
        if not self.should_log(response.status_code):
            return

        elapsed_ms = round((time.perf_counter() - started_at) * 1000, 2)
        entry: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "context": context,
            "method": method.upper(),
            "endpoint": endpoint,
            "url": str(response.request.url),
            "status_code": response.status_code,
            "reason": response.reason_phrase,
            "elapsed_ms": elapsed_ms,
            "content_type": response.headers.get("content-type", ""),
            "response_bytes": len(response.content or b""),
        }

        response_payload = self._response_payload(response)
        if self.verbosity in {"errors", "metadata", "full"}:
            entry["response_shape"] = self._shape(response_payload)

        if self.verbosity == "full":
            if request_body is not None:
                entry["request_body"] = self._redact(request_body)
            entry["response"] = self._redact(response_payload)
        elif self.verbosity == "errors":
            entry["response"] = self._redact(response_payload)

        self._write(entry)

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
        if self.verbosity == "off":
            return

        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "context": context,
            "method": method.upper(),
            "endpoint": endpoint,
            "url": url,
            "status_code": None,
            "reason": "Network Error",
            "elapsed_ms": round((time.perf_counter() - started_at) * 1000, 2),
            "error": {
                "type": error.__class__.__name__,
                "message": str(error) or repr(error),
            },
        }
        self._write(entry)

    def _write(self, entry: dict[str, Any]) -> None:
        try:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            line = json.dumps(entry, ensure_ascii=False, default=str)
            with self._lock:
                with self.log_path.open("a", encoding="utf-8") as handle:
                    handle.write(f"{line}\n")
                os.chmod(self.log_path, 0o600)
        except OSError:
            # Logging is diagnostic only; never break the proxied API workflow.
            return

    @staticmethod
    def _normalize_verbosity(verbosity: str) -> str:
        normalized = str(verbosity or "off").lower()
        if normalized not in LOG_VERBOSITIES:
            raise ValueError(f"Unsupported API logging verbosity: {verbosity}")
        return normalized

    @staticmethod
    def _response_payload(response: httpx.Response) -> Any:
        if not response.content:
            return {}

        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            try:
                return response.json()
            except ValueError:
                return response.text

        return response.text

    def _shape(self, value: Any, depth: int = 0) -> Any:
        if depth >= 4:
            return self._type_name(value)

        if isinstance(value, dict):
            return {
                key: self._shape(child, depth + 1)
                for key, child in list(value.items())[:50]
            }

        if isinstance(value, list):
            first_shape = self._shape(value[0], depth + 1) if value else None
            return {"type": "array", "length": len(value), "first": first_shape}

        return self._type_name(value)

    def _redact(self, value: Any) -> Any:
        if isinstance(value, dict):
            redacted: dict[str, Any] = {}
            for key, child in value.items():
                key_text = str(key).lower().replace("-", "_")
                if any(part in key_text for part in SENSITIVE_KEY_PARTS):
                    redacted[key] = REDACTED
                else:
                    redacted[key] = self._redact(child)
            return redacted

        if isinstance(value, list):
            return [self._redact(item) for item in value]

        return value

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
