import asyncio
from contextlib import asynccontextmanager, suppress
from pathlib import Path
import json
import os
import re
import subprocess
from typing import Any

from fastapi import Cookie, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from starlette.middleware.trustedhost import TrustedHostMiddleware

from backend.api_response_logger import ApiResponseLogger, LOG_VERBOSITIES
from backend.connection_store import ConnectionStorageError, ConnectionStore
from backend.extrahop_client import ExtraHopApiError, ExtraHopClient, ExtraHopResponse
from backend.session_store import SessionStore
from backend import system_health_pdf as system_health_pdf_backend


APP_ROOT = Path(__file__).parent
SESSION_COOKIE = "eh_admin_session"
SESSION_TTL_SECONDS = int(os.environ.get("EH_SESSION_TTL_SECONDS", 12 * 60 * 60))
MAX_SESSIONS = int(os.environ.get("EH_MAX_SESSIONS", 32))
# The proxy buffers request bodies before forwarding them. 64 MiB accommodates
# normal JSON administration calls and moderately sized support/threat bundles
# while bounding memory use. Operators can raise it for firmware or other large
# binary uploads that are intentionally routed through this application.
PROXY_MAX_REQUEST_BYTES = max(
    1,
    int(os.environ.get("EH_PROXY_MAX_REQUEST_BYTES", 64 * 1024 * 1024)),
)
TENANT_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
HEX_PATTERN = r"^#[0-9a-fA-F]{6}$"
CHART_THEME_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")
# Built-in theme ids ship in js/modules/chart-theme.js and must stay unshadowed.
CHART_THEME_RESERVED_IDS = {"auto", "draft", "light", "dark", "midnight", "slate", "mono"}
VERSION_PATH = APP_ROOT.parent / "VERSION" if APP_ROOT.name == "app" else APP_ROOT / "VERSION"
APP_VERSION = VERSION_PATH.read_text(encoding="utf-8").strip() if VERSION_PATH.exists() else "development"
COMMIT_PATH = VERSION_PATH.with_name("COMMIT")


def resolve_app_commit() -> str:
    configured_commit = os.environ.get("EH_APP_COMMIT", "").strip()
    if configured_commit:
        return configured_commit
    if COMMIT_PATH.exists():
        return COMMIT_PATH.read_text(encoding="utf-8").strip()
    try:
        return subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=APP_ROOT,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (FileNotFoundError, subprocess.CalledProcessError):
        return "unknown"


def is_worktree_dirty() -> bool:
    if COMMIT_PATH.exists():
        return False
    try:
        return bool(
            subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=APP_ROOT,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False


APP_COMMIT = resolve_app_commit()


@asynccontextmanager
async def app_lifespan(_: FastAPI):
    try:
        yield
    finally:
        try:
            await sessions.aclose()
        finally:
            await asyncio.to_thread(api_response_logger.close)


app = FastAPI(title="ExtraHop Admin Tools", lifespan=app_lifespan)
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=["127.0.0.1", "localhost", "[::1]"],
)
sessions = SessionStore(ttl_seconds=SESSION_TTL_SECONDS, max_sessions=MAX_SESSIONS)
api_response_logger = ApiResponseLogger(
    Path(os.environ.get("EH_API_RESPONSE_LOG", APP_ROOT / "logs" / "api-responses.jsonl")),
    os.environ.get("EH_API_LOG_VERBOSITY", "errors"),
)
connection_store = ConnectionStore(APP_ROOT)

app.mount("/css", StaticFiles(directory=APP_ROOT / "css"), name="css")
app.mount("/js", StaticFiles(directory=APP_ROOT / "js"), name="js")
app.mount("/assets", StaticFiles(directory=APP_ROOT / "assets"), name="assets")


class ConnectionConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: str = Field(pattern="^(360|enterprise)$")
    tenant: str | None = None
    apiId: str | None = None
    apiSecret: str | None = None
    host: str | None = None
    apiKey: str | None = None
    proxyToken: str | None = None
    verifyTls: bool = True

    @field_validator("tenant")
    @classmethod
    def validate_tenant(cls, value: str | None) -> str | None:
        if value is None:
            return value
        normalized = value.strip().lower()
        if not TENANT_PATTERN.fullmatch(normalized):
            raise ValueError("Tenant must be a single DNS label, such as hoolicorp")
        return normalized

    @model_validator(mode="after")
    def validate_config(self) -> "ConnectionConfig":
        if self.type == "360":
            if not self.tenant or not self.apiId or not self.apiSecret:
                raise ValueError("Tenant, API ID, and API Secret are required for RevealX 360")
        else:
            if not self.host or not self.apiKey:
                raise ValueError("Host and API Key are required for RevealX Enterprise")
        return self


class SavedConnectionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tenant: str | None = None
    apiId: str | None = None
    apiSecret: str | None = None
    host: str | None = None
    apiKey: str | None = None
    verifyTls: bool | None = None


class SavedConnectionSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    proxyToken: str | None = None
    updates: SavedConnectionUpdate | None = None


class ApiLoggingConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    verbosity: str = Field(pattern="^(off|errors|metadata|full)$")
    path: str | None = None


class ChartThemeColors(BaseModel):
    """The five colors that define a chart theme.

    Every other color the report needs is mixed from ``bg`` and ``text`` at
    render time, in the browser and in the PDF alike.
    """

    model_config = ConfigDict(extra="forbid")

    bg: str = Field(pattern=HEX_PATTERN)
    text: str = Field(pattern=HEX_PATTERN)
    low: str = Field(pattern=HEX_PATTERN)
    mid: str = Field(pattern=HEX_PATTERN)
    high: str = Field(pattern=HEX_PATTERN)


class ChartTheme(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=60)
    colors: ChartThemeColors


@app.exception_handler(RequestValidationError)
async def request_validation_error_handler(
    request: Request,
    error: RequestValidationError,
) -> JSONResponse:
    del request
    safe_errors = [
        {key: value for key, value in item.items() if key not in {"input", "ctx", "url"}} for item in error.errors()
    ]
    return JSONResponse(status_code=422, content={"detail": safe_errors})


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(
        APP_ROOT / "index.html",
        headers={
            "Cache-Control": "no-store, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@app.get("/backend/health")
async def health() -> dict[str, str | bool]:
    return {
        "app": "extrahop-admin-tools",
        "status": "ok",
        "version": APP_VERSION,
        "commit": APP_COMMIT,
        "dirty": is_worktree_dirty(),
    }


@app.get("/favicon.png")
async def favicon() -> FileResponse:
    return FileResponse(APP_ROOT / "favicon.png")


async def establish_session(
    config: ConnectionConfig,
    response: Response,
    replace_session_id: str | None,
    *,
    save_connection: bool,
) -> dict[str, Any]:
    config_dict = config.model_dump(exclude_none=True)
    client: ExtraHopClient | None = None
    try:
        client = ExtraHopClient(config_dict, api_response_logger)
        await client.authenticate()
    except ExtraHopApiError as error:
        if client:
            await client.aclose()
        raise http_exception(error) from error
    except Exception as error:
        if client:
            await client.aclose()
        raise HTTPException(
            status_code=502,
            detail={
                "message": f"Connection failed: {error.__class__.__name__} - {str(error) or repr(error)}",
                "details": {
                    "status": "Backend Error",
                    "response": {
                        "type": error.__class__.__name__,
                        "message": str(error) or repr(error),
                    },
                },
            },
        ) from error

    session_id = await sessions.acreate(client, replace_session_id=replace_session_id)
    response.set_cookie(
        SESSION_COOKIE,
        session_id,
        httponly=True,
        samesite="strict",
        secure=False,
        max_age=SESSION_TTL_SECONDS,
        path="/",
    )
    result: dict[str, Any] = {
        "connected": True,
        "config": client.metadata.public_dict(),
    }
    if save_connection:
        try:
            saved = await asyncio.to_thread(connection_store.save, config_dict)
            result.update(
                {
                    "savedConnection": True,
                    "connectionId": saved["id"],
                    "connectionStorage": {"available": True, "message": None},
                }
            )
        except ConnectionStorageError as error:
            result.update(
                {
                    "savedConnection": False,
                    "connectionStorage": {
                        "available": False,
                        "message": str(error),
                    },
                }
            )
    return result


@app.get("/backend/connections")
async def list_saved_connections() -> dict[str, Any]:
    return await asyncio.to_thread(connection_store.list_connections)


@app.post("/backend/connections/{connection_id}/session")
async def create_saved_connection_session(
    connection_id: str,
    response: Response,
    request_body: SavedConnectionSessionRequest | None = None,
    eh_admin_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict[str, Any]:
    changes = request_body.updates.model_dump(exclude_none=True) if request_body and request_body.updates else {}
    try:
        if changes:
            stored_config = await asyncio.to_thread(
                connection_store.prepare_update,
                connection_id,
                changes,
            )
        else:
            stored_config = await asyncio.to_thread(connection_store.get, connection_id)
    except KeyError as error:
        message = "Saved connection is not editable." if changes else "Saved connection was not found."
        raise HTTPException(
            status_code=404,
            detail={"message": message},
        ) from error
    except ConnectionStorageError as error:
        raise HTTPException(
            status_code=503,
            detail={"message": str(error)},
        ) from error
    except (TypeError, ValueError) as error:
        raise HTTPException(
            status_code=422,
            detail={"message": "Saved connection changes are invalid."},
        ) from error

    runtime_config = dict(stored_config)
    proxy_token = str(request_body.proxyToken or "").strip() if request_body else ""
    if proxy_token:
        if runtime_config.get("type") != "enterprise":
            raise HTTPException(
                status_code=422,
                detail={"message": "Proxy tokens can only be used with Enterprise connections."},
            )
        runtime_config["proxyToken"] = proxy_token

    try:
        config = ConnectionConfig.model_validate(runtime_config)
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail={"message": "Saved connection settings are invalid."},
        ) from error
    result = await establish_session(
        config,
        response,
        eh_admin_session,
        save_connection=False,
    )
    if changes:
        try:
            saved = await asyncio.to_thread(
                connection_store.replace,
                connection_id,
                stored_config,
            )
            result.update(
                {
                    "savedConnection": True,
                    "connectionId": saved["id"],
                    "connectionStorage": {"available": True, "message": None},
                }
            )
        except (ConnectionStorageError, KeyError) as error:
            result.update(
                {
                    "savedConnection": False,
                    "connectionStorage": {
                        "available": False,
                        "message": str(error),
                    },
                }
            )
    return result


@app.delete("/backend/connections/{connection_id}")
async def delete_saved_connection(connection_id: str) -> dict[str, bool]:
    try:
        await asyncio.to_thread(connection_store.delete, connection_id)
    except KeyError as error:
        raise HTTPException(
            status_code=404,
            detail={"message": "Saved connection was not found or is managed by .env."},
        ) from error
    except ConnectionStorageError as error:
        raise HTTPException(
            status_code=503,
            detail={"message": str(error)},
        ) from error
    return {"deleted": True}


@app.post("/backend/session")
async def create_session(
    config: ConnectionConfig,
    response: Response,
    eh_admin_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict[str, Any]:
    return await establish_session(
        config,
        response,
        eh_admin_session,
        save_connection=True,
    )


@app.get("/backend/api-logging")
async def read_api_logging() -> dict[str, Any]:
    return api_response_logger.status()


@app.patch("/backend/api-logging")
async def update_api_logging(config: ApiLoggingConfig) -> dict[str, Any]:
    try:
        return api_response_logger.configure(config.verbosity, config.path)
    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail={"message": str(error), "valid": sorted(LOG_VERBOSITIES)},
        ) from error


@app.get("/backend/chart-themes")
async def list_chart_themes() -> dict[str, Any]:
    directory = resolve_chart_themes_dir()
    themes = []
    if directory.is_dir():
        for path in sorted(directory.glob("*.json")):
            theme = read_chart_theme(path)
            if theme:
                themes.append(theme)
    return {
        "directory": str(directory),
        "writable": chart_themes_dir_writable(directory),
        "themes": themes,
    }


@app.put("/backend/chart-themes/{theme_id}")
async def save_chart_theme(theme_id: str, theme: ChartTheme) -> dict[str, Any]:
    path = chart_theme_path(theme_id)
    payload = {"id": theme_id, "name": theme.name, "colors": theme.colors.model_dump()}
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    except OSError as error:
        raise HTTPException(
            status_code=500,
            detail={"message": f"Could not write theme file: {error}"},
        ) from error
    return payload


@app.delete("/backend/chart-themes/{theme_id}")
async def delete_chart_theme(theme_id: str) -> dict[str, bool]:
    path = chart_theme_path(theme_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail={"message": "Theme not found"})
    try:
        path.unlink()
    except OSError as error:
        raise HTTPException(
            status_code=500,
            detail={"message": f"Could not delete theme file: {error}"},
        ) from error
    return {"deleted": True}


@app.get("/backend/session")
async def read_session(
    eh_admin_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict[str, Any]:
    client = sessions.get(eh_admin_session)
    if not client:
        raise HTTPException(status_code=401, detail={"message": "Not connected to an ExtraHop instance"})
    return {"connected": True, "config": client.metadata.public_dict()}


@app.get("/backend/system-health/catalog")
async def system_health_catalog(
    eh_admin_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict[str, Any]:
    get_session_client(eh_admin_session)
    catalog_path = resolve_catalog_path()
    if not catalog_path.exists():
        return {"loaded": False, "path": str(catalog_path), "models": [], "lookup": {}}

    try:
        models = json.loads(catalog_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise HTTPException(
            status_code=500,
            detail={"message": f"Could not load product catalog: {error}"},
        ) from error

    lookup = build_catalog_lookup(models)
    return {"loaded": True, "path": str(catalog_path), "models": models, "lookup": lookup}


@app.get("/backend/system-health/catalog/lookup")
async def system_health_catalog_lookup(
    eh_admin_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict[str, Any]:
    catalog = await system_health_catalog(eh_admin_session)
    return {key: catalog[key] for key in ("loaded", "path", "lookup")}


@app.post("/backend/system-health/pdf")
async def system_health_pdf(
    request: Request,
    eh_admin_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> StreamingResponse:
    get_session_client(eh_admin_session)
    payload = await system_health_pdf_backend.parse_system_health_pdf_request(request)
    report = payload.report.model_dump(mode="python")
    html_text = system_health_pdf_backend.render_system_health_pdf_html(report, payload.style)
    try:
        pdf_bytes = await system_health_pdf_backend.render_system_health_pdf_bounded(html_text)
    except system_health_pdf_backend.PdfRendererUnavailable as error:
        raise HTTPException(
            status_code=501,
            detail={"message": str(error)},
        ) from error
    except system_health_pdf_backend.PdfRenderBusyError as error:
        raise HTTPException(
            status_code=503,
            detail={"message": str(error)},
            headers={"Retry-After": str(max(1, round(system_health_pdf_backend.PDF_RENDER_ACQUIRE_TIMEOUT_SECONDS)))},
        ) from error
    except system_health_pdf_backend.PdfRenderTimeoutError as error:
        raise HTTPException(status_code=504, detail={"message": str(error)}) from error
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail={"message": f"Could not render system health PDF: {error}"},
        ) from error

    filename = system_health_pdf_backend.system_health_pdf_filename(report)
    return StreamingResponse(
        iter([pdf_bytes]),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.delete("/backend/session")
async def delete_session(
    response: Response,
    eh_admin_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict[str, bool]:
    await sessions.adelete(eh_admin_session)
    response.delete_cookie(SESSION_COOKIE, path="/", samesite="strict")
    return {"connected": False}


@app.api_route(
    "/backend/extrahop/{endpoint:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
)
async def proxy_extrahop_request(
    endpoint: str,
    request: Request,
    eh_admin_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> Any:
    client = get_session_client(eh_admin_session)
    body = await read_proxy_request_body(request)

    upstream_task = asyncio.create_task(
        client.request(
            request.method,
            endpoint,
            query_string=request.url.query,
            body=body or None,
            content_type=request.headers.get("content-type"),
            include_metadata=True,
        )
    )
    disconnect_task = asyncio.create_task(wait_for_client_disconnect(request))
    try:
        done, _ = await asyncio.wait(
            {upstream_task, disconnect_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if disconnect_task in done and not upstream_task.done():
            upstream_task.cancel()
            with suppress(asyncio.CancelledError):
                await upstream_task
            raise HTTPException(status_code=499, detail={"message": "Client disconnected"})
        result = await upstream_task
        if not isinstance(result, ExtraHopResponse):
            return result
        headers = {"Location": result.location} if result.location else None
        if result.status_code == 204:
            return Response(status_code=204, headers=headers)
        return JSONResponse(content=result.data, status_code=result.status_code, headers=headers)
    except ExtraHopApiError as error:
        raise http_exception(error) from error
    finally:
        for task in (upstream_task, disconnect_task):
            if not task.done():
                task.cancel()
        await asyncio.gather(upstream_task, disconnect_task, return_exceptions=True)


async def read_proxy_request_body(request: Request) -> bytes:
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            declared_length = int(content_length)
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail={"message": "ExtraHop proxy request has an invalid Content-Length header."},
            ) from None
        if declared_length < 0:
            raise HTTPException(
                status_code=400,
                detail={"message": "ExtraHop proxy request has an invalid Content-Length header."},
            )
        if declared_length > PROXY_MAX_REQUEST_BYTES:
            raise HTTPException(
                status_code=413,
                detail={
                    "message": (
                        f"ExtraHop proxy request exceeds the configured {PROXY_MAX_REQUEST_BYTES:,}-byte limit."
                    )
                },
            )

    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > PROXY_MAX_REQUEST_BYTES:
            raise HTTPException(
                status_code=413,
                detail={
                    "message": (
                        f"ExtraHop proxy request exceeds the configured {PROXY_MAX_REQUEST_BYTES:,}-byte limit."
                    )
                },
            )
    return bytes(body)


async def wait_for_client_disconnect(request: Request) -> None:
    # proxy_extrahop_request() has already consumed request.stream(), so the
    # remaining ASGI receive event is the cancellable disconnect notification.
    while True:
        message = await request.receive()
        if message["type"] == "http.disconnect":
            return


def get_session_client(session_id: str | None) -> ExtraHopClient:
    client = sessions.get(session_id)
    if not client:
        raise HTTPException(status_code=401, detail={"message": "Not connected to an ExtraHop instance"})
    return client


def resolve_catalog_path() -> Path:
    env_path = os.environ.get("EH_CATALOG_PATH")
    if env_path:
        return Path(env_path).expanduser()

    return APP_ROOT / "catalog.eh.json"


def resolve_chart_themes_dir() -> Path:
    """Where custom chart themes live.

    In a distribution APP_ROOT is ``<install>/app``, so themes land one level up
    beside README.md where someone can find and back them up without digging
    through code. In a source checkout they sit at the repository root.
    """
    env_path = os.environ.get("EH_CHART_THEMES_DIR")
    if env_path:
        return Path(env_path).expanduser()

    base = APP_ROOT.parent if APP_ROOT.name == "app" else APP_ROOT
    return base / "chart-themes"


def chart_theme_path(theme_id: str) -> Path:
    if not CHART_THEME_ID_PATTERN.match(theme_id):
        raise HTTPException(
            status_code=400,
            detail={"message": "Theme id must be lowercase letters, digits, and hyphens."},
        )
    if theme_id in CHART_THEME_RESERVED_IDS:
        raise HTTPException(
            status_code=400,
            detail={"message": f"'{theme_id}' is a built-in theme name. Choose another."},
        )
    return resolve_chart_themes_dir() / f"{theme_id}.json"


def chart_themes_dir_writable(directory: Path) -> bool:
    target = directory if directory.is_dir() else directory.parent
    return os.access(target, os.W_OK)


def read_chart_theme(path: Path) -> dict[str, Any] | None:
    """Load one theme file, ignoring anything that is not a valid theme.

    A hand-edited or half-written file should not break the theme list.
    """
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        theme = ChartTheme.model_validate({"name": raw.get("name"), "colors": raw.get("colors")})
    except (OSError, json.JSONDecodeError, AttributeError, ValueError):
        return None
    return {"id": path.stem, "name": theme.name, "colors": theme.colors.model_dump()}


def build_catalog_lookup(models: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(models, list):
        return {}

    lookup: dict[str, dict[str, Any]] = {}
    for model in models:
        if not isinstance(model, dict) or not model.get("name"):
            continue
        performance = model.get("performance", {})
        if not isinstance(performance, dict):
            performance = {}
        lookup[str(model["name"]).upper()] = {
            "model": model["name"],
            "platform": model.get("platform", ""),
            "generation": model.get("generation"),
            "sale_status": model.get("sale_status", ""),
            "base_gbps": performance.get("base_gbps") or 0,
            "base_packetrate": performance.get("base_packetrate") or 0,
            "advanced_analysis": performance.get("advanced_analysis") or 0,
            "standard_analysis": performance.get("standard_analysis") or 0,
        }
    return lookup


def http_exception(error: ExtraHopApiError) -> HTTPException:
    return HTTPException(
        status_code=error.status_code,
        detail={"message": str(error), "details": error.details},
    )
