import asyncio
from email.utils import parsedate_to_datetime
import json
import random
import re
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx

from backend.api_response_logger import ApiResponseLogger


DEFAULT_360_TOKEN_TTL_SECONDS = 30 * 60
TOKEN_REFRESH_BUFFER_SECONDS = 5 * 60
MAX_REQUEST_ATTEMPTS = 4
RETRYABLE_STATUS_CODES = {429, 502, 503, 504}
TENANT_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")

# JavaScript cannot represent API int64 identifiers above 2**53 exactly.  These
# names come from the bundled ExtraHop OpenAPI schema.  Normalize identifiers at
# the Python/browser boundary, before FastAPI serializes them as JSON numbers.
# Time, duration, capacity, and metric-value fields intentionally stay numeric.
IDENTIFIER_FIELD_NAMES = frozenset({
    "id",
    "keyid",
    "oid",
    "sid",
    "xid",
})
IDENTIFIER_ARRAY_FIELD_NAMES = frozenset({"detections"})


def normalize_api_identifiers(value: Any, *, identifier_value: bool = False) -> Any:
    """Return API JSON with documented identifier values represented as strings."""
    if isinstance(value, dict):
        normalized: dict[Any, Any] = {}
        is_topology_edge = "from" in value and "to" in value and "weight" in value
        for key, item in value.items():
            field_name = str(key).lower()
            is_identifier = (
                field_name in IDENTIFIER_FIELD_NAMES
                or field_name.endswith("_id")
                or field_name.endswith("_ids")
                or field_name in IDENTIFIER_ARRAY_FIELD_NAMES
                or (is_topology_edge and field_name in {"from", "to"})
            )
            normalized[key] = normalize_api_identifiers(item, identifier_value=is_identifier)
        return normalized
    if isinstance(value, list):
        return [normalize_api_identifiers(item, identifier_value=identifier_value) for item in value]
    if identifier_value and isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    return value


class ExtraHopApiError(Exception):
    def __init__(self, message: str, status_code: int = 502, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.details = details or {}


@dataclass
class SessionMetadata:
    type: str
    tenant: str | None = None
    host: str | None = None
    verify_tls: bool = True

    def public_dict(self) -> dict[str, Any]:
        if self.type == "360":
            return {"type": "360", "tenant": self.tenant or ""}
        return {
            "type": "enterprise",
            "host": self.host or "",
            "verifyTls": self.verify_tls,
        }


class ExtraHopClient:
    def __init__(self, config: dict[str, Any], response_logger: ApiResponseLogger | None = None):
        self.config = config
        self.response_logger = response_logger
        self.access_token: str | None = None
        self.access_token_expires_at = 0.0
        self.verify_tls = True
        self._http_client: httpx.AsyncClient | None = None
        self._auth_lock = asyncio.Lock()

        if config["type"] == "360":
            tenant = config["tenant"].strip().lower()
            if not TENANT_PATTERN.fullmatch(tenant):
                raise ValueError("RevealX 360 tenant must be a single DNS label")
            self.base_url = f"https://{tenant}.api.cloud.extrahop.com"
            self.metadata = SessionMetadata(type="360", tenant=tenant)
        else:
            self.base_url, host = self._normalize_enterprise_url(config["host"])
            self.verify_tls = bool(config.get("verifyTls", True))
            self.metadata = SessionMetadata(
                type="enterprise",
                host=host,
                verify_tls=self.verify_tls,
            )

    async def authenticate(self) -> None:
        if self.config["type"] == "360":
            await self._authenticate_360(force=True)
            return

        await self.request("GET", "/api/v1/extrahop")

    async def _authenticate_360(self, *, force: bool) -> None:
        async with self._auth_lock:
            if (
                not force
                and self.access_token
                and time.time() < self.access_token_expires_at - TOKEN_REFRESH_BUFFER_SECONDS
            ):
                return
            payload = {
                "grant_type": "client_credentials",
                "client_id": self.config["apiId"],
                "client_secret": self.config["apiSecret"],
            }

            url = f"{self.base_url}/oauth2/token"
            started_at = time.perf_counter()
            try:
                response = await self._client().post(
                    url,
                    data=payload,
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                    timeout=30.0,
                )
            except httpx.RequestError as error:
                if self.response_logger:
                    self.response_logger.log_network_error(
                        method="POST",
                        endpoint="/oauth2/token",
                        url=url,
                        error=error,
                        started_at=started_at,
                        context="auth",
                    )
                raise self._network_error(error, url, "Authentication request failed") from error

            if self.response_logger:
                self.response_logger.log_response(
                    method="POST",
                    endpoint="/oauth2/token",
                    response=response,
                    started_at=started_at,
                    request_body={"grant_type": payload["grant_type"], "client_id": payload["client_id"]},
                    context="auth",
                )

            if response.status_code < 200 or response.status_code >= 300:
                raise self._api_error_from_response(response, "Authentication failed")

            try:
                data = response.json()
            except ValueError as error:
                raise self._malformed_response_error(response, "Authentication response was not valid JSON") from error

            access_token = data.get("access_token") if isinstance(data, dict) else None
            if not isinstance(access_token, str) or not access_token:
                raise self._malformed_response_error(response, "Authentication response did not include an access token")

            try:
                ttl = int(data.get("expires_in") or DEFAULT_360_TOKEN_TTL_SECONDS)
            except (TypeError, ValueError) as error:
                raise self._malformed_response_error(response, "Authentication response included an invalid token lifetime") from error

            self.access_token = access_token
            self.access_token_expires_at = time.time() + ttl

    async def refresh_if_needed(self) -> None:
        if self.config["type"] != "360":
            return

        if not self.access_token or time.time() >= self.access_token_expires_at - TOKEN_REFRESH_BUFFER_SECONDS:
            await self._authenticate_360(force=False)

    async def request(
        self,
        method: str,
        endpoint: str,
        *,
        query_string: str = "",
        body: bytes | None = None,
        content_type: str | None = None,
    ) -> Any:
        endpoint = self._normalize_endpoint(endpoint)
        await self.refresh_if_needed()

        response = await self._send(method, endpoint, query_string, body, content_type)
        if response.status_code == 401 and self.config["type"] == "360":
            await self._authenticate_360(force=True)
            response = await self._send(method, endpoint, query_string, body, content_type)

        if response.status_code < 200 or response.status_code >= 300:
            raise self._api_error_from_response(response, "API request failed")

        if response.status_code == 204 or not response.content:
            return {}

        content_type_header = response.headers.get("content-type", "")
        if "application/json" in content_type_header:
            try:
                return normalize_api_identifiers(response.json())
            except ValueError as error:
                raise self._malformed_response_error(response, "API response was not valid JSON") from error
        return response.text

    async def _send(
        self,
        method: str,
        endpoint: str,
        query_string: str,
        body: bytes | None,
        content_type: str | None,
    ) -> httpx.Response:
        headers = {"Accept": "application/json"}

        if self.config["type"] == "360":
            headers["Authorization"] = f"Bearer {self.access_token}"
            url = f"{self.base_url}{endpoint}"
        else:
            headers["Authorization"] = f"ExtraHop apikey={self.config['apiKey']}"
            if self.config.get("proxyToken"):
                headers["Cookie"] = f"token={self.config['proxyToken']}"
            url = f"{self.base_url}{endpoint}"

        if body:
            headers["Content-Type"] = content_type or "application/json"

        if query_string:
            url = f"{url}?{query_string}"

        request_body_for_log = (
            self._request_body_for_log(
                body,
                content_type,
                max_bytes=self.response_logger.max_preview_bytes,
            )
            if self.response_logger and self.response_logger.wants_request_body()
            else None
        )
        last_error: httpx.RequestError | None = None
        for attempt in range(MAX_REQUEST_ATTEMPTS):
            started_at = time.perf_counter()
            try:
                response = await self._client().request(method, url, headers=headers, content=body)
            except asyncio.CancelledError:
                raise
            except httpx.RequestError as error:
                last_error = error
                if self.response_logger:
                    self.response_logger.log_network_error(
                        method=method,
                        endpoint=endpoint,
                        url=url,
                        error=error,
                        started_at=started_at,
                    )
                if (
                    not self._retryable_request(method, endpoint)
                    or not self._retryable_network_error(error)
                    or attempt >= MAX_REQUEST_ATTEMPTS - 1
                ):
                    raise self._network_error(error, url, "API request failed") from error
                await asyncio.sleep(self._retry_delay_seconds(attempt, None))
                continue

            if self.response_logger:
                self.response_logger.log_response(
                    method=method,
                    endpoint=endpoint,
                    response=response,
                    started_at=started_at,
                    request_body=request_body_for_log,
                )

            if (
                response.status_code not in RETRYABLE_STATUS_CODES
                or not self._retryable_request(method, endpoint)
                or attempt >= MAX_REQUEST_ATTEMPTS - 1
            ):
                return response
            await asyncio.sleep(self._retry_delay_seconds(attempt, response.headers.get("retry-after")))

        if last_error:
            raise self._network_error(last_error, url, "API request failed") from last_error
        raise ExtraHopApiError("API request failed after retry exhaustion", 502, {"url": url})

    def _client(self) -> httpx.AsyncClient:
        if self._http_client is None or self._http_client.is_closed:
            self._http_client = httpx.AsyncClient(timeout=60.0, verify=self.verify_tls)
        return self._http_client

    async def aclose(self) -> None:
        if self._http_client is not None and not self._http_client.is_closed:
            await self._http_client.aclose()

    @staticmethod
    def _retryable_network_error(error: httpx.RequestError) -> bool:
        return isinstance(
            error,
            (
                httpx.ConnectError,
                httpx.ConnectTimeout,
                httpx.ReadTimeout,
                httpx.RemoteProtocolError,
            ),
        )

    @staticmethod
    def _retryable_request(method: str, endpoint: str) -> bool:
        if method.upper() in {"GET", "HEAD", "OPTIONS"}:
            return True
        return method.upper() == "POST" and endpoint in {
            "/api/v1/devices/search",
            "/api/v1/metrics",
            "/api/v1/metrics/total",
            "/api/v1/metrics/totalbyobject",
            "/api/v1/metrics/catalog/search",
        }

    @staticmethod
    def _retry_delay_seconds(attempt: int, retry_after: str | None) -> float:
        if retry_after:
            try:
                return max(0.0, float(retry_after))
            except ValueError:
                try:
                    retry_at = parsedate_to_datetime(retry_after)
                    return max(0.0, retry_at.timestamp() - time.time())
                except (TypeError, ValueError, OverflowError):
                    pass
        base = min(10.0, 0.5 * (2 ** attempt))
        return base * random.uniform(0.8, 1.2)

    def _normalize_endpoint(self, endpoint: str) -> str:
        if not endpoint.startswith("/"):
            endpoint = f"/{endpoint}"

        if endpoint.startswith("/api/v1") or endpoint.startswith("/oauth2"):
            return endpoint

        return f"/api/v1{endpoint}"

    def _api_error_from_response(self, response: httpx.Response, prefix: str) -> ExtraHopApiError:
        try:
            response_body: Any = response.json()
        except ValueError:
            response_body = response.text

        message = self._extract_error_message(response_body) or response.reason_phrase
        details = {
            "url": str(response.request.url),
            "status": f"{response.status_code} {response.reason_phrase}",
            "response": response_body,
        }
        if response.headers.get("retry-after"):
            details["retry_after"] = response.headers["retry-after"]
        return ExtraHopApiError(f"{prefix}: {response.status_code} - {message}", response.status_code, details)

    def _network_error(self, error: httpx.RequestError, url: str, prefix: str) -> ExtraHopApiError:
        message = str(error) or repr(error)
        hint = self._network_error_hint(error)
        details = {
            "url": url,
            "status": "Network Error",
            "response": {
                "type": error.__class__.__name__,
                "message": message,
                "hint": hint,
            },
        }
        return ExtraHopApiError(f"{prefix}: {error.__class__.__name__} - {message}. {hint}", 502, details)

    def _network_error_hint(self, error: httpx.RequestError) -> str:
        message = str(error).lower()
        if isinstance(error, httpx.ConnectError) and (
            "certificate verify failed" in message
            or "certificate_verify_failed" in message
            or "self-signed certificate" in message
        ):
            return (
                "TLS certificate verification failed. Confirm the appliance hostname and certificate trust. "
                "For a known self-signed lab appliance, reconnect with the explicit untrusted-certificate option."
            )
        if isinstance(error, httpx.ConnectTimeout):
            return (
                "The local Python backend could not open a TCP connection to the ExtraHop API host. "
                "If the browser-only version connects with the same credentials, it is likely using the legacy AWS proxy "
                "or browser-specific network routing; verify local server egress to the tenant on TCP/443."
            )
        if isinstance(error, httpx.ConnectError):
            return "The local Python backend could not resolve or connect to the ExtraHop API host."
        if isinstance(error, httpx.ReadTimeout):
            return "The ExtraHop API connection opened, but the backend timed out waiting for a response."
        return "The local Python backend could not complete the outbound ExtraHop API request."

    @staticmethod
    def _normalize_enterprise_url(raw_host: str) -> tuple[str, str]:
        value = str(raw_host or "").strip()
        candidate = value if "://" in value else f"https://{value}"
        try:
            parsed = urlsplit(candidate)
            port = parsed.port
        except ValueError as error:
            raise ValueError("Enterprise host contains an invalid port or URL") from error

        if parsed.scheme.lower() != "https":
            raise ValueError("Enterprise host must use HTTPS")
        if parsed.username or parsed.password:
            raise ValueError("Enterprise host must not include embedded credentials")
        if not parsed.hostname:
            raise ValueError("Enterprise host must include a hostname or IP address")
        if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise ValueError("Enterprise host must not include a path, query string, or fragment")

        hostname = parsed.hostname
        formatted_host = f"[{hostname}]" if ":" in hostname else hostname
        if port is not None and port != 443:
            formatted_host = f"{formatted_host}:{port}"
        return f"https://{formatted_host}", formatted_host

    @staticmethod
    def _malformed_response_error(response: httpx.Response, message: str) -> ExtraHopApiError:
        details = {
            "url": str(response.request.url),
            "status": f"{response.status_code} {response.reason_phrase}",
            "response": {
                "message": message,
                "content_type": response.headers.get("content-type", ""),
                "response_bytes": len(response.content or b""),
            },
        }
        return ExtraHopApiError(message, 502, details)

    @staticmethod
    def _extract_error_message(response_body: Any) -> str | None:
        if isinstance(response_body, dict):
            return (
                response_body.get("error_description")
                or response_body.get("error_message")
                or response_body.get("error")
            )
        if isinstance(response_body, str) and response_body.strip():
            return response_body.strip()
        return None

    @staticmethod
    def _request_body_for_log(
        body: bytes | None,
        content_type: str | None,
        *,
        max_bytes: int,
    ) -> Any:
        if not body:
            return None

        limit = max(1, int(max_bytes))
        if len(body) > limit:
            return {
                "type": "truncated_request_preview",
                "request_bytes": len(body),
                "preview_bytes": limit,
                "preview": body[:limit].decode("utf-8", errors="replace"),
            }

        if content_type and "application/json" in content_type:
            try:
                return json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                return body.decode("utf-8", errors="replace")

        return body.decode("utf-8", errors="replace")
