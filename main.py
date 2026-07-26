import asyncio
from contextlib import suppress
from pathlib import Path
import html
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
from backend.extrahop_client import ExtraHopApiError, ExtraHopClient
from backend.session_store import SessionStore


APP_ROOT = Path(__file__).parent
SESSION_COOKIE = "eh_admin_session"
SESSION_TTL_SECONDS = int(os.environ.get("EH_SESSION_TTL_SECONDS", 12 * 60 * 60))
MAX_SESSIONS = int(os.environ.get("EH_MAX_SESSIONS", 32))
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

app = FastAPI(title="ExtraHop Admin Tools")
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


class SystemHealthPdfRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    report: dict[str, Any]
    style: dict[str, Any] = Field(default_factory=dict)


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
        {
            key: value
            for key, value in item.items()
            if key not in {"input", "ctx", "url"}
        }
        for item in error.errors()
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
    changes = (
        request_body.updates.model_dump(exclude_none=True)
        if request_body and request_body.updates
        else {}
    )
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
        message = (
            "Saved connection is not editable."
            if changes
            else "Saved connection was not found."
        )
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
    payload: SystemHealthPdfRequest,
    eh_admin_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> StreamingResponse:
    get_session_client(eh_admin_session)
    try:
        from playwright.async_api import async_playwright
    except ImportError as error:
        raise HTTPException(
            status_code=501,
            detail={
                "message": "Playwright is not installed. Run `pip install -r requirements.txt` and `python3 -m playwright install chromium` to enable PDF export.",
            },
        ) from error

    html_text = render_system_health_pdf_html(payload.report, payload.style)
    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch()
            page = await browser.new_page(viewport={"width": 1280, "height": 960}, device_scale_factor=1)
            await page.set_content(html_text, wait_until="networkidle")
            pdf_bytes = await page.pdf(
                format="Letter",
                print_background=True,
                margin={"top": "0.35in", "right": "0.35in", "bottom": "0.35in", "left": "0.35in"},
                prefer_css_page_size=True,
            )
            await browser.close()
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail={"message": f"Could not render system health PDF: {error}"},
        ) from error

    filename = f"system-health-report-{payload.report.get('generated_at', 'export')[:10]}.pdf"
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


@app.post("/backend/session/refresh")
async def refresh_session(
    eh_admin_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict[str, bool]:
    client = get_session_client(eh_admin_session)
    try:
        await client.refresh_if_needed()
    except ExtraHopApiError as error:
        raise http_exception(error) from error
    return {"refreshed": True}


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
    body = await request.body()

    upstream_task = asyncio.create_task(client.request(
        request.method,
        endpoint,
        query_string=request.url.query,
        body=body or None,
        content_type=request.headers.get("content-type"),
    ))
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
        return await upstream_task
    except ExtraHopApiError as error:
        raise http_exception(error) from error
    finally:
        for task in (upstream_task, disconnect_task):
            if not task.done():
                task.cancel()
        await asyncio.gather(upstream_task, disconnect_task, return_exceptions=True)


async def wait_for_client_disconnect(request: Request) -> None:
    # proxy_extrahop_request() has already consumed request.body(), so the
    # remaining ASGI receive event is the cancellable disconnect notification.
    while True:
        message = await request.receive()
        if message["type"] == "http.disconnect":
            return


@app.on_event("shutdown")
async def close_session_clients() -> None:
    await sessions.aclose()


# Used only when the browser sends an incomplete palette. These are the built-in
# Light theme values from js/modules/chart-theme.js, derived neutrals included.
SYSTEM_HEALTH_PDF_FALLBACK_COLORS = {
    "bg": "#ffffff",
    "text": "#16151f",
    "subtle": "#403f47",
    "muted": "#6a6970",
    "grid": "#dadadb",
    "track": "#e8e8e9",
    "altRow": "#f5f4f5",
    "low": "#00aaef",
    "mid": "#f59e0b",
    "high": "#ef4444",
}


def render_system_health_pdf_html(report: dict[str, Any], style: dict[str, Any]) -> str:
    rows = system_health_pdf_rows(report)
    packetstore_rows = system_health_pdf_packetstore_rows(report)
    colors = system_health_pdf_style_colors(style)
    page_background = "transparent" if colors["transparent"] else colors["bg"]
    cycle_label = system_health_pdf_cycle_label(report)
    metric_pages = [
        ("Packet Rate vs Model Capacity", f"Peak {cycle_label} average packet rate by sensor", "packet_peak", "packet_capacity", "pps", rows),
        ("Throughput vs Model Capacity", f"Peak {cycle_label} average throughput by sensor", "throughput_gbps", "throughput_capacity", "gbps", rows),
        ("Trigger Cycles vs Available Capacity", f"Maximum aligned {cycle_label} trigger utilization by sensor", "trigger_cycles_peak", "trigger_cycles_avail", "number", rows),
        ("Analysis Tier Pressure", "Advanced, Standard, and Discovery device pressure", None, None, "analysis", rows),
    ]
    pages = []
    for title, subtitle, value_key, capacity_key, unit, source_rows in metric_pages:
        for model, model_rows in system_health_pdf_model_groups(source_rows, value_key, capacity_key, unit):
            offline_names = sorted(
                str(row.get("name") or row.get("id") or "Unknown sensor")
                for row in model_rows
                if not row.get("online", True)
            )
            reporting_rows = [row for row in model_rows if row.get("online", True)]
            chunks = [reporting_rows[i:i + 22] for i in range(0, len(reporting_rows), 22)] or [[]]
            for index, chunk in enumerate(chunks, start=1):
                pages.append(system_health_pdf_page(
                    title,
                    subtitle,
                    model,
                    chunk,
                    index,
                    len(chunks),
                    value_key,
                    capacity_key,
                    unit,
                    offline_names,
                ))
    packetstore_offline_names = sorted(
        str(row.get("name") or row.get("id") or "Unknown sensor")
        for row in packetstore_rows
        if not row.get("online", True)
    )
    reporting_packetstores = [row for row in packetstore_rows if row.get("online", True)]
    packetstore_chunks = [
        reporting_packetstores[i:i + 12]
        for i in range(0, len(reporting_packetstores), 12)
    ] or ([[]] if packetstore_offline_names else [])
    for index, chunk in enumerate(packetstore_chunks, start=1):
        pages.append(system_health_pdf_packetstore_page(
            chunk,
            index,
            len(packetstore_chunks),
            system_health_pdf_packetstore_cycle_label(report),
            packetstore_offline_names,
        ))

    generated = html.escape(str(report.get("generated_at") or ""))
    lookback = html.escape(str(((report.get("window") or {}).get("lookback_days")) or ""))
    cycle = html.escape(cycle_label)
    summary = system_health_pdf_summary(rows, report, packetstore_rows)
    body_pages = "\n".join(pages)
    return f"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
@page {{ size: Letter landscape; margin: 0.35in; }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; font-family: Arial, Helvetica, sans-serif; color: {colors["text"]}; background: {page_background}; }}
.cover, .page {{ background: {page_background}; page-break-after: always; min-height: 7.8in; padding: 0.1in 0.12in; }}
.cover {{ display: flex; flex-direction: column; justify-content: space-between; }}
h1 {{ margin: 0; font-size: 34px; }}
h2 {{ margin: 0 0 4px; font-size: 24px; }}
.muted {{ color: {colors["muted"]}; }}
.meta {{ display: flex; gap: 18px; margin-top: 12px; font-size: 13px; }}
.summary {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 34px; }}
.card {{ background: {colors["card_bg"]}; border: 1px solid {colors["border"]}; border-left: 5px solid {colors["accent"]}; border-radius: 6px; padding: 14px; }}
.card b {{ display: block; font-size: 26px; margin-top: 7px; }}
.page-head {{ display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; border-bottom: 1px solid {colors["border"]}; padding-bottom: 12px; margin-bottom: 16px; }}
.model {{ text-align: right; font-size: 13px; }}
.chart {{ display: grid; gap: 7px; }}
.row {{ display: grid; grid-template-columns: 220px 1fr 150px; gap: 12px; align-items: center; min-height: 24px; }}
.name {{ font-size: 11px; text-align: right; color: {colors["subtle"]}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }}
.track {{ height: 15px; background: {colors["track"]}; position: relative; }}
.bar {{ height: 100%; background: {colors["low"]}; }}
.bar.warn {{ background: {colors["mid"]}; }}
.bar.hot {{ background: {colors["high"]}; }}
.value {{ font-size: 11px; color: {colors["text"]}; }}
.analysis {{ grid-template-columns: 190px 1fr 1fr 230px; }}
.offline-summary {{ margin-top: 8px; padding-top: 9px; border-top: 1px solid {colors["border"]}; color: {colors["high"]}; font-size: 11px; }}
.packetstore-grid {{ display: grid; grid-template-columns: 175px 1fr 1.35fr 1.25fr; gap: 8px 12px; align-items: center; font-size: 10px; }}
.packetstore-grid .head {{ font-weight: 700; color: {colors["subtle"]}; border-bottom: 1px solid {colors["border"]}; padding-bottom: 6px; }}
.mini {{ height: 9px; background: {colors["track"]}; margin: 2px 0; }}
.mini > span {{ display:block; height:100%; background:{colors["low"]}; }}
.chip {{ display: inline-block; min-width: 28px; padding: 3px 8px; border-radius: 12px; color: white; background: linear-gradient(135deg, {colors["mid"]}, {colors["high"]}); text-align: center; font-size: 10px; font-weight: 700; }}
.footer {{ position: fixed; bottom: 0.1in; left: 0.12in; right: 0.12in; display: flex; justify-content: space-between; color: {colors["muted"]}; font-size: 10px; }}
</style>
</head>
<body>
<section class="cover">
  <div>
    <h1>System Health Report</h1>
    <div class="meta"><span>Generated {generated}</span><span>Lookback {lookback} days</span><span>Cycle {cycle}</span></div>
    <div class="summary">{summary}</div>
  </div>
  <p class="muted">Each metric chart is rendered on its own print page and split by model/page to avoid awkward chart breaks.</p>
</section>
{body_pages}
</body>
</html>"""


def system_health_pdf_style_colors(style: dict[str, Any] | None) -> dict[str, Any]:
    """Map the palette the browser resolved onto the PDF template's color names.

    Theme resolution lives in the browser so a PNG and the PDF from the same run
    cannot disagree. This function only validates and renames.
    """
    style = style or {}
    palette = style.get("colors")
    palette = palette if isinstance(palette, dict) else {}
    colors = {
        key: system_health_pdf_hex(palette.get(key), fallback)
        for key, fallback in SYSTEM_HEALTH_PDF_FALLBACK_COLORS.items()
    }
    colors["border"] = colors["grid"]
    colors["card_bg"] = colors["altRow"]
    colors["accent"] = colors["low"]
    colors["transparent"] = bool(style.get("transparent"))
    return colors


def system_health_pdf_hex(value: Any, fallback: str) -> str:
    raw = str(value or "").strip().lstrip("#")
    if len(raw) == 6 and all(char in "0123456789abcdefABCDEF" for char in raw):
        return f"#{raw.lower()}"
    return fallback


def system_health_pdf_rows(report: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for sensor in report.get("appliances") or []:
        if sensor.get("appliance_role") == "packetstore":
            continue
        capacity = sensor.get("capacity") or {}
        sid = str(sensor.get("id"))
        trigger = (((report.get("trigger_utilization") or {}).get("peak_by_sensor") or {}).get(sid) or {})
        metric_status = {
            metric: (((details.get("sensor_status") or {}).get(sid) or {}).get("status") or "unknown")
            for metric, details in (report.get("metrics") or {}).items()
        }
        rows.append({
            "id": sid,
            "name": sensor.get("name") or sensor.get("hostname") or f"Appliance {sid}",
            "model": sensor.get("license_platform") or capacity.get("model") or "Unknown",
            "online": bool(sensor.get("online", True)),
            "packet_peak": metric_peak_rate(report, "pkts", sid),
            "packet_capacity": float(capacity.get("base_packetrate") or 0),
            "throughput_gbps": metric_peak_rate(report, "bytes", sid) * 8 / 1_000_000_000,
            "throughput_capacity": float(capacity.get("base_gbps") or 0),
            "trigger_cycles_peak": float(trigger.get("used_cycles") or 0),
            "trigger_cycles_avail": float(trigger.get("available_cycles") or 0),
            "trigger_utilization": float(trigger.get("utilization") or 0),
            "trigger_drops": metric_total(report, "trigger_drops", sid),
            "analysis": (report.get("device_analysis") or {}).get(sid) or {},
            "advanced_capacity": float(capacity.get("advanced_analysis") or 0),
            "standard_capacity": float(capacity.get("standard_analysis") or 0),
            "metric_status": metric_status,
            "health_conditions": sensor.get("health_conditions") or [],
        })
    return rows


def system_health_pdf_packetstore_rows(report: dict[str, Any]) -> list[dict[str, Any]]:
    packetstore = report.get("packetstore") or {}
    ids = {str(value) for value in packetstore.get("appliance_ids") or []}
    metrics = packetstore.get("metrics") or {}

    def value(metric: str, field: str, sid: str) -> float | None:
        raw = (((metrics.get(metric) or {}).get("summary") or {}).get(field) or {}).get(sid)
        try:
            return float(raw) if raw is not None else None
        except (TypeError, ValueError):
            return None

    rows = []
    for appliance in report.get("appliances") or []:
        sid = str(appliance.get("id"))
        if sid not in ids:
            continue
        packets = value("pkts", "totals", sid)
        packet_drops = value("pkts_dropped", "totals", sid)
        secrets = value("secrets", "totals", sid)
        secret_drops = value("secrets_dropped", "totals", sid)
        rows.append({
            "id": sid,
            "name": appliance.get("name") or appliance.get("hostname") or f"Appliance {sid}",
            "role": appliance.get("appliance_role") or "packetstore",
            "online": bool(appliance.get("online", True)),
            "lookback_latest": value("est_lookback_sec", "latest_values", sid),
            "lookback_min": value("est_lookback_sec", "min_values", sid),
            "packets": packets,
            "packet_drops": packet_drops,
            "packet_drop_ratio": packet_drops / packets if packets and packet_drops is not None else None,
            "slow_write_drops": value("pkts_dropped_wrslow", "totals", sid),
            "interface_drops": value("if_drops", "totals", sid),
            "secrets": secrets,
            "secret_drops": secret_drops,
            "secret_drop_ratio": secret_drops / secrets if secrets and secret_drops is not None else None,
            "input_load": value("input_load", "peak_values", sid),
            "compress_load": value("compress_load", "peak_values", sid),
            "write_load": value("disk_write_load", "peak_values", sid),
        })
    return rows


def system_health_pdf_packetstore_page(
    rows: list[dict[str, Any]],
    page: int,
    pages: int,
    cycle_label: str,
    offline_names: list[str] | None = None,
) -> str:
    offline_names = offline_names or []
    body = ["<div class='packetstore-grid'><div class='head'>APPLIANCE</div><div class='head'>RETENTION</div><div class='head'>CAPTURE &amp; SECRET FIDELITY</div><div class='head'>PEAK PROCESSING LOAD</div>"]
    for row in rows:
        latest = row.get("lookback_latest")
        minimum = row.get("lookback_min")
        lookback = f"{latest / 86400:.1f}d latest · {minimum / 86400:.1f}d min" if latest is not None and minimum is not None else "unavailable"
        packet_ratio = row.get("packet_drop_ratio")
        secret_ratio = row.get("secret_drop_ratio")
        packet_label = f"{packet_ratio * 100:.4g}%" if packet_ratio is not None else "unavailable"
        secret_label = f"{secret_ratio * 100:.4g}%" if secret_ratio is not None else "unavailable"
        fidelity = (
            f"Packets {packet_label} ({int(row.get('packet_drops') or 0):,} dropped) · "
            f"Secrets {secret_label} ({int(row.get('secret_drops') or 0):,} of {int(row.get('secrets') or 0):,} dropped)<br>"
            f"Slow-write {int(row.get('slow_write_drops') or 0):,} · interface {int(row.get('interface_drops') or 0):,}"
        )
        load_values = [("Input", row.get("input_load")), ("Compress", row.get("compress_load")), ("Write", row.get("write_load"))]
        loads = "".join(
            f"{label} {float(value):.1f}%<div class='mini'><span style='width:{min(100, max(0, float(value))):.2f}%'></span></div>"
            if value is not None else f"{label} unavailable<br>"
            for label, value in load_values
        )
        role = "All in One" if row.get("role") == "all_in_one" else "Paired Packetstore"
        body.extend([
            f"<div class='name'>{html.escape(str(row.get('name') or ''))}<br><span class='muted'>{role}</span></div>",
            f"<div>{html.escape(lookback)}</div>",
            f"<div>{fidelity}</div>",
            f"<div>{loads}</div>",
        ])
    body.append("</div>")
    if offline_names:
        body.append(f"""<div class="offline-summary"><b>OFFLINE:</b> {html.escape(", ".join(offline_names))}</div>""")
    subtitle = f"Retention, capture fidelity, and peak sampled 30-second processing load at {cycle_label} cadence"
    source_count = len(rows) + len(offline_names)
    return f"""<section class="page"><div class="page-head"><div><h2>Packetstore Health</h2><div class="muted">{html.escape(subtitle)}</div></div><div class="model">{source_count} metric sources | Page {page} of {pages}</div></div>{''.join(body)}</section>"""


def system_health_pdf_packetstore_cycle_label(report: dict[str, Any]) -> str:
    packetstore_metrics = ((report.get("packetstore") or {}).get("metrics") or {}).values()
    cycles = {
        str(cycle)
        for details in packetstore_metrics
        for cycle in (((details.get("summary") or {}).get("actual_cycles") or {}).values())
        if cycle
    }
    return "/".join(sorted(cycles)) if cycles else str(report.get("cycle") or report.get("requested_cycle") or "unknown-cycle")


def system_health_pdf_model_groups(rows: list[dict[str, Any]], value_key: str | None, capacity_key: str | None, unit: str) -> list[tuple[str, list[dict[str, Any]]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(str(row.get("model") or "Unknown"), []).append(row)
    for model_rows in grouped.values():
        if unit == "analysis":
            model_rows.sort(key=lambda row: max(ratio(row["analysis"].get("advanced", 0), row["advanced_capacity"]), ratio(row["analysis"].get("standard", 0), row["standard_capacity"])) + (0.001 if row["analysis"].get("discovery", 0) else 0), reverse=True)
        else:
            model_rows.sort(key=lambda row: ratio(row.get(value_key, 0), row.get(capacity_key, 0)), reverse=True)
    return sorted(grouped.items(), key=lambda item: (-len(item[1]), item[0]))


def system_health_pdf_page(
    title: str,
    subtitle: str,
    model: str,
    rows: list[dict[str, Any]],
    page: int,
    pages: int,
    value_key: str | None,
    capacity_key: str | None,
    unit: str,
    offline_names: list[str] | None = None,
) -> str:
    offline_names = offline_names or []
    if unit == "analysis":
        chart_rows = "\n".join(system_health_pdf_analysis_row(row) for row in rows)
    else:
        chart_rows = "\n".join(system_health_pdf_bar_row(row, value_key or "", capacity_key or "", unit) for row in rows)
    if not chart_rows and not offline_names:
        chart_rows = (
            "<p class='muted'>No device analysis data returned.</p>"
            if unit == "analysis"
            else "<p class='muted'>No metric data returned.</p>"
        )
    offline_summary = (
        f"""<div class="offline-summary"><b>OFFLINE:</b> {html.escape(", ".join(offline_names))}</div>"""
        if offline_names
        else ""
    )
    sensor_count = len(rows) + len(offline_names)
    return f"""<section class="page">
  <div class="page-head">
    <div><h2>{html.escape(title)}</h2><div class="muted">{html.escape(subtitle)}</div></div>
    <div class="model"><b>{html.escape(model)}</b><br>{sensor_count} sensors | Page {page} of {pages}</div>
  </div>
  <div class="chart">{chart_rows}{offline_summary}</div>
</section>"""


def system_health_pdf_bar_row(row: dict[str, Any], value_key: str, capacity_key: str, unit: str) -> str:
    value = float(row.get(value_key) or 0)
    capacity = float(row.get(capacity_key) or 0)
    util = ratio(value, capacity)
    metric = "pkts" if value_key == "packet_peak" else "bytes" if value_key == "throughput_gbps" else "trigger_cycles"
    collection_status = str((row.get("metric_status") or {}).get(metric) or "unknown")
    available = collection_status in {"complete", "zero_valued"}
    width = min(100, max(0, util * 100 if capacity else value)) if available else 0
    state = "hot" if util >= 1 else "warn" if util >= 0.8 else ""
    label = "offline" if not row.get("online", True) else collection_status.replace("_", " ") if not available else f"{util * 100:.0f}% | {format_pdf_value(value, unit)}" if capacity else format_pdf_value(value, unit)
    return f"""<div class="row"><div class="name">{html.escape(str(row.get("name") or ""))}</div><div class="track"><div class="bar {state}" style="width:{width:.2f}%"></div></div><div class="value">{html.escape(label)}</div></div>"""


def system_health_pdf_analysis_row(row: dict[str, Any]) -> str:
    analysis = row.get("analysis") or {}
    if analysis.get("status") not in {None, "complete", "zero_valued"}:
        status = html.escape(str(analysis.get("status") or "unknown").replace("_", " "))
        return f"""<div class="row analysis"><div class="name">{html.escape(str(row.get("name") or ""))}</div><div class="muted">{status}</div><div></div><div></div></div>"""
    advanced = float(analysis.get("advanced") or 0)
    standard = float(analysis.get("standard") or 0)
    discovery = int(analysis.get("discovery") or 0)
    adv_util = ratio(advanced, row.get("advanced_capacity") or 0)
    std_util = ratio(standard, row.get("standard_capacity") or 0)
    discovery_label = f"<span class='chip'>{discovery:,}</span>" if discovery else "<span class='muted'>-</span>"
    return f"""<div class="row analysis"><div class="name">{html.escape(str(row.get("name") or ""))}</div><div class="track"><div class="bar {'hot' if adv_util >= 1 else 'warn' if adv_util >= 0.8 else ''}" style="width:{min(100, adv_util * 100):.2f}%"></div></div><div class="track"><div class="bar {'hot' if std_util >= 1 else 'warn' if std_util >= 0.8 else ''}" style="width:{min(100, std_util * 100):.2f}%"></div></div><div class="value">{advanced:,.0f} adv | {standard:,.0f} std | {discovery_label}</div></div>"""


def system_health_pdf_summary(rows: list[dict[str, Any]], report: dict[str, Any], packetstore_rows: list[dict[str, Any]] | None = None) -> str:
    packetstore_rows = packetstore_rows or []
    cards = [
        ("Sensors", f"{len(rows):,}", "Discover sensors returned"),
        ("Packet Risk", f"{sum(1 for r in rows if ratio(r['packet_peak'], r['packet_capacity']) >= 1):,}", "At model packet rating"),
        ("Throughput Watch", f"{sum(1 for r in rows if ratio(r['throughput_gbps'], r['throughput_capacity']) >= 0.8):,}", "At 80%+ throughput"),
        ("Trigger Drops", f"{sum(1 for r in rows if r['trigger_drops'] > 0):,}", "Sensors with drops"),
        ("PCAP Sources", f"{len(packetstore_rows):,}", "Packetstore-backed sensors detected by cpc metrics"),
        ("PCAP Loss", f"{sum(1 for r in packetstore_rows if (r.get('packet_drops') or 0) > 0 or (r.get('slow_write_drops') or 0) > 0 or (r.get('interface_drops') or 0) > 0 or (r.get('secret_drops') or 0) > 0):,}", "Stores with observed loss"),
    ]
    return "".join(f"<div class='card'><span>{html.escape(label)}</span><b>{html.escape(value)}</b><small class='muted'>{html.escape(note)}</small></div>" for label, value, note in cards)


def system_health_pdf_cycle_label(report: dict[str, Any]) -> str:
    cycles = {
        str(cycle)
        for details in (report.get("metrics") or {}).values()
        for cycle in (((details.get("summary") or {}).get("actual_cycles") or {}).values())
        if cycle
    }
    cycles.update(
        str(metadata.get("cycle"))
        for details in (report.get("metrics") or {}).values()
        for metadata in (details.get("collection_metadata") or [])
        if isinstance(metadata, dict) and metadata.get("cycle")
    )
    return "/".join(sorted(cycles)) if cycles else str(report.get("cycle") or report.get("requested_cycle") or "unknown-cycle")


def metric_peak(report: dict[str, Any], metric: str, sid: str) -> float:
    return float((((report.get("metrics") or {}).get(metric) or {}).get("summary") or {}).get("peak_values", {}).get(sid) or 0)


def metric_total(report: dict[str, Any], metric: str, sid: str) -> float:
    return float((((report.get("metrics") or {}).get(metric) or {}).get("summary") or {}).get("totals", {}).get(sid) or 0)


def metric_capacity(report: dict[str, Any], metric: str, sid: str) -> float:
    summary = (((report.get("metrics") or {}).get(metric) or {}).get("summary") or {})
    return float((summary.get("peak_values") or {}).get(sid) or (summary.get("latest_values") or {}).get(sid) or (summary.get("avg_values") or {}).get(sid) or 0)


def metric_peak_rate(report: dict[str, Any], metric: str, sid: str) -> float:
    summary = (((report.get("metrics") or {}).get(metric) or {}).get("summary") or {})
    duration_ms = float((summary.get("peak_duration_ms") or {}).get(sid) or cycle_to_ms(report.get("cycle")))
    return metric_peak(report, metric, sid) / (duration_ms / 1000) if duration_ms else 0


def cycle_to_ms(cycle: Any) -> int:
    return {"1sec": 1000, "30sec": 30000, "5min": 300000, "1hr": 3600000, "24hr": 86400000}.get(str(cycle), 3600000)


def ratio(value: Any, capacity: Any) -> float:
    capacity_float = float(capacity or 0)
    return float(value or 0) / capacity_float if capacity_float else 0


def format_pdf_value(value: float, unit: str) -> str:
    if unit == "gbps":
        return f"{value:.2f} Gbps"
    if unit == "pps":
        return f"{value / 1_000_000:.2f} Mpps" if value >= 1_000_000 else f"{value / 1_000:.1f} Kpps"
    return f"{value:,.0f}"


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
