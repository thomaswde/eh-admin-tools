from pathlib import Path
import html
import json
import os
import re
from typing import Any

from fastapi import Cookie, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from starlette.middleware.trustedhost import TrustedHostMiddleware

from backend.api_response_logger import ApiResponseLogger, LOG_VERBOSITIES
from backend.extrahop_client import ExtraHopApiError, ExtraHopClient
from backend.session_store import SessionStore


APP_ROOT = Path(__file__).parent
SESSION_COOKIE = "eh_admin_session"
SESSION_TTL_SECONDS = int(os.environ.get("EH_SESSION_TTL_SECONDS", 12 * 60 * 60))
MAX_SESSIONS = int(os.environ.get("EH_MAX_SESSIONS", 32))
TENANT_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
VERSION_PATH = APP_ROOT.parent / "VERSION" if APP_ROOT.name == "app" else APP_ROOT / "VERSION"
APP_VERSION = VERSION_PATH.read_text(encoding="utf-8").strip() if VERSION_PATH.exists() else "development"

app = FastAPI(title="ExtraHop Admin Tools")
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=["127.0.0.1", "localhost", "[::1]"],
)
sessions = SessionStore(ttl_seconds=SESSION_TTL_SECONDS, max_sessions=MAX_SESSIONS)
api_response_logger = ApiResponseLogger(
    Path(os.environ.get("EH_API_RESPONSE_LOG", APP_ROOT / "logs" / "api-responses.jsonl")),
    os.environ.get("EH_API_LOG_VERBOSITY", "off"),
)

app.mount("/css", StaticFiles(directory=APP_ROOT / "css"), name="css")
app.mount("/js", StaticFiles(directory=APP_ROOT / "js"), name="js")


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


class ApiLoggingConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    verbosity: str = Field(pattern="^(off|errors|metadata|full)$")
    path: str | None = None


class SystemHealthPdfRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    report: dict[str, Any]
    style: dict[str, Any] = Field(default_factory=dict)


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
    return FileResponse(APP_ROOT / "index.html")


@app.get("/backend/health")
async def health() -> dict[str, str]:
    return {
        "app": "extrahop-admin-tools",
        "status": "ok",
        "version": APP_VERSION,
    }


@app.get("/favicon.png")
async def favicon() -> FileResponse:
    return FileResponse(APP_ROOT / "favicon.png")


@app.get("/eh_logo.png")
async def logo() -> FileResponse:
    return FileResponse(APP_ROOT / "eh_logo.png")


@app.post("/backend/session")
async def create_session(
    config: ConnectionConfig,
    response: Response,
    eh_admin_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict[str, Any]:
    try:
        client = ExtraHopClient(config.model_dump(exclude_none=True), api_response_logger)
        await client.authenticate()
    except ExtraHopApiError as error:
        raise http_exception(error) from error
    except Exception as error:
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

    session_id = sessions.create(client, replace_session_id=eh_admin_session)
    response.set_cookie(
        SESSION_COOKIE,
        session_id,
        httponly=True,
        samesite="strict",
        secure=False,
        max_age=SESSION_TTL_SECONDS,
        path="/",
    )
    return {"connected": True, "config": client.metadata.public_dict()}


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
    sessions.delete(eh_admin_session)
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

    try:
        return await client.request(
            request.method,
            endpoint,
            query_string=request.url.query,
            body=body or None,
            content_type=request.headers.get("content-type"),
        )
    except ExtraHopApiError as error:
        raise http_exception(error) from error


SYSTEM_HEALTH_PDF_PALETTE = {
    "sapphire": "#261f63",
    "plum": "#7f2854",
    "magenta": "#ec0089",
    "cyan": "#00aaef",
    "tangerine": "#f05918",
    "border": "#e5e7eb",
    "text": "#261f63",
}


def render_system_health_pdf_html(report: dict[str, Any], style: dict[str, Any]) -> str:
    rows = system_health_pdf_rows(report)
    colors = system_health_pdf_style_colors(style)
    page_background = "transparent" if colors["transparent"] else colors["bg"]
    metric_pages = [
        ("Packet Rate vs Model Capacity", "Peak packet rate by sensor", "packet_peak", "packet_capacity", "pps", rows),
        ("Throughput vs Model Capacity", "Peak throughput by sensor", "throughput_gbps", "throughput_capacity", "gbps", rows),
        ("Trigger Cycles vs Available Capacity", "Peak trigger cycles consumed by sensor", "trigger_cycles_peak", "trigger_cycles_avail", "number", rows),
        ("Analysis Tier Pressure", "Advanced, Standard, and Discovery device pressure", None, None, "analysis", rows),
    ]
    pages = []
    for title, subtitle, value_key, capacity_key, unit, source_rows in metric_pages:
        for model, model_rows in system_health_pdf_model_groups(source_rows, value_key, capacity_key, unit):
            chunks = [model_rows[i:i + 22] for i in range(0, len(model_rows), 22)] or [[]]
            for index, chunk in enumerate(chunks, start=1):
                pages.append(system_health_pdf_page(title, subtitle, model, chunk, index, len(chunks), value_key, capacity_key, unit))

    generated = html.escape(str(report.get("generated_at") or ""))
    lookback = html.escape(str(((report.get("window") or {}).get("lookback_days")) or ""))
    cycle = html.escape(str(report.get("cycle") or ""))
    summary = system_health_pdf_summary(rows, report)
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
.card {{ background: {colors["card_bg"]}; border: 1px solid {colors["border"]}; border-left: 5px solid {colors["advanced"]}; border-radius: 6px; padding: 14px; }}
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
.chip {{ display: inline-block; min-width: 28px; padding: 3px 8px; border-radius: 12px; color: white; background: linear-gradient(135deg, {colors["discovery"]}, {colors["high"]}); text-align: center; font-size: 10px; font-weight: 700; }}
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
    style = system_health_pdf_normalize_style(style)
    presets = {
        "light": {
            "bg": "#ffffff",
            "text": SYSTEM_HEALTH_PDF_PALETTE["text"],
            "muted": "#6b7280",
            "subtle": "#4b5563",
            "border": SYSTEM_HEALTH_PDF_PALETTE["border"],
            "track": "#eef2f7",
            "card_bg": "#ffffff",
            "low": "#4aa7df",
            "mid": SYSTEM_HEALTH_PDF_PALETTE["tangerine"],
            "high": SYSTEM_HEALTH_PDF_PALETTE["magenta"],
            "advanced": SYSTEM_HEALTH_PDF_PALETTE["cyan"],
            "standard": SYSTEM_HEALTH_PDF_PALETTE["plum"],
            "discovery": SYSTEM_HEALTH_PDF_PALETTE["tangerine"],
        },
        "dark": {
            "bg": SYSTEM_HEALTH_PDF_PALETTE["sapphire"],
            "text": "#ffffff",
            "muted": "#dbe4f0",
            "subtle": "#f5f5fb",
            "border": "#64748b",
            "track": "#334155",
            "card_bg": "rgba(255,255,255,0.05)",
            "low": "#4aa7df",
            "mid": SYSTEM_HEALTH_PDF_PALETTE["tangerine"],
            "high": SYSTEM_HEALTH_PDF_PALETTE["magenta"],
            "advanced": SYSTEM_HEALTH_PDF_PALETTE["cyan"],
            "standard": SYSTEM_HEALTH_PDF_PALETTE["plum"],
            "discovery": SYSTEM_HEALTH_PDF_PALETTE["tangerine"],
        },
        "mono": {
            "bg": "#ffffff",
            "text": "#111827",
            "muted": "#6b7280",
            "subtle": "#4b5563",
            "border": "#d1d5db",
            "track": "#e5e7eb",
            "card_bg": "#ffffff",
            "low": "#9ca3af",
            "mid": "#6b7280",
            "high": "#111827",
            "advanced": "#111827",
            "standard": "#6b7280",
            "discovery": "#d1d5db",
        },
    }
    theme = str(style.get("theme") or "light")
    if theme == "custom":
        bg = system_health_pdf_hex(style.get("bgHex"), "#ffffff")
        dark = not system_health_pdf_is_light_hex(bg)
        colors = {
            "bg": bg,
            "text": system_health_pdf_hex(style.get("textHex"), "#ffffff" if dark else SYSTEM_HEALTH_PDF_PALETTE["text"]),
            "muted": "#cbd5e1" if dark else "#6b7280",
            "subtle": "#e5e7eb" if dark else "#4b5563",
            "border": "#64748b" if dark else SYSTEM_HEALTH_PDF_PALETTE["border"],
            "track": "#334155" if dark else "#eef2f7",
            "card_bg": "rgba(255,255,255,0.05)" if dark else "#ffffff",
            "low": system_health_pdf_hex(style.get("advHex"), SYSTEM_HEALTH_PDF_PALETTE["cyan"]),
            "mid": system_health_pdf_hex(style.get("stdHex"), SYSTEM_HEALTH_PDF_PALETTE["plum"]),
            "high": system_health_pdf_hex(style.get("discHex"), SYSTEM_HEALTH_PDF_PALETTE["tangerine"]),
            "advanced": system_health_pdf_hex(style.get("advHex"), SYSTEM_HEALTH_PDF_PALETTE["cyan"]),
            "standard": system_health_pdf_hex(style.get("stdHex"), SYSTEM_HEALTH_PDF_PALETTE["plum"]),
            "discovery": system_health_pdf_hex(style.get("discHex"), SYSTEM_HEALTH_PDF_PALETTE["tangerine"]),
        }
    else:
        colors = presets.get(theme, presets["light"]).copy()
    colors["transparent"] = bool(style.get("transparent"))
    return colors


def system_health_pdf_normalize_style(style: dict[str, Any] | None) -> dict[str, Any]:
    style = dict(style or {})
    theme = str(style.get("theme") or "light")
    if theme == "default":
        theme = "light"
    legacy_bg = style.get("bg")
    if legacy_bg == "transparent":
        style["transparent"] = True
    elif legacy_bg == "sapphire":
        theme = "dark"
    elif legacy_bg == "custom":
        theme = "custom"
    if theme not in {"light", "dark", "mono", "custom"}:
        theme = "light"
    style["theme"] = theme
    return style


def system_health_pdf_hex(value: Any, fallback: str) -> str:
    raw = str(value or "").strip()
    if len(raw) == 7 and raw.startswith("#"):
        body = raw[1:]
    elif len(raw) == 6:
        body = raw
    else:
        return fallback
    if all(char in "0123456789abcdefABCDEF" for char in body):
        return f"#{body.lower()}"
    return fallback


def system_health_pdf_is_light_hex(hex_value: str) -> bool:
    raw = system_health_pdf_hex(hex_value, "#ffffff").lstrip("#")
    value = int(raw, 16)
    red = (value >> 16) & 255
    green = (value >> 8) & 255
    blue = value & 255
    return (0.299 * red + 0.587 * green + 0.114 * blue) > 160


def system_health_pdf_rows(report: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for sensor in report.get("appliances") or []:
        capacity = sensor.get("capacity") or {}
        sid = str(sensor.get("id"))
        rows.append({
            "id": sid,
            "name": sensor.get("name") or sensor.get("hostname") or f"Appliance {sid}",
            "model": sensor.get("license_platform") or capacity.get("model") or "Unknown",
            "online": bool(sensor.get("online", True)),
            "packet_peak": metric_peak_rate(report, "pkts", sid),
            "packet_capacity": float(capacity.get("base_packetrate") or 0),
            "throughput_gbps": metric_peak_rate(report, "bytes", sid) * 8 / 1_000_000_000,
            "throughput_capacity": float(capacity.get("base_gbps") or 0),
            "trigger_cycles_peak": metric_peak(report, "trigger_cycles", sid),
            "trigger_cycles_avail": metric_capacity(report, "trigger_cycles_avail", sid),
            "trigger_drops": metric_total(report, "trigger_drops", sid),
            "analysis": (report.get("device_analysis") or {}).get(sid) or {},
            "advanced_capacity": float(capacity.get("advanced_analysis") or 0),
            "standard_capacity": float(capacity.get("standard_analysis") or 0),
        })
    return rows


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


def system_health_pdf_page(title: str, subtitle: str, model: str, rows: list[dict[str, Any]], page: int, pages: int, value_key: str | None, capacity_key: str | None, unit: str) -> str:
    if unit == "analysis":
        chart_rows = "\n".join(system_health_pdf_analysis_row(row) for row in rows) or "<p class='muted'>No device analysis data returned.</p>"
    else:
        chart_rows = "\n".join(system_health_pdf_bar_row(row, value_key or "", capacity_key or "", unit) for row in rows) or "<p class='muted'>No metric data returned.</p>"
    return f"""<section class="page">
  <div class="page-head">
    <div><h2>{html.escape(title)}</h2><div class="muted">{html.escape(subtitle)}</div></div>
    <div class="model"><b>{html.escape(model)}</b><br>{len(rows)} sensors | Page {page} of {pages}</div>
  </div>
  <div class="chart">{chart_rows}</div>
</section>"""


def system_health_pdf_bar_row(row: dict[str, Any], value_key: str, capacity_key: str, unit: str) -> str:
    value = float(row.get(value_key) or 0)
    capacity = float(row.get(capacity_key) or 0)
    util = ratio(value, capacity)
    width = min(100, max(0, util * 100 if capacity else value))
    state = "hot" if util >= 1 else "warn" if util >= 0.8 else ""
    label = "offline" if not row.get("online", True) else f"{util * 100:.0f}% | {format_pdf_value(value, unit)}" if capacity else format_pdf_value(value, unit)
    return f"""<div class="row"><div class="name">{html.escape(str(row.get("name") or ""))}</div><div class="track"><div class="bar {state}" style="width:{width:.2f}%"></div></div><div class="value">{html.escape(label)}</div></div>"""


def system_health_pdf_analysis_row(row: dict[str, Any]) -> str:
    analysis = row.get("analysis") or {}
    advanced = float(analysis.get("advanced") or 0)
    standard = float(analysis.get("standard") or 0)
    discovery = int(analysis.get("discovery") or 0)
    adv_util = ratio(advanced, row.get("advanced_capacity") or 0)
    std_util = ratio(standard, row.get("standard_capacity") or 0)
    discovery_label = f"<span class='chip'>{discovery:,}</span>" if discovery else "<span class='muted'>-</span>"
    return f"""<div class="row analysis"><div class="name">{html.escape(str(row.get("name") or ""))}</div><div class="track"><div class="bar {'hot' if adv_util >= 1 else 'warn' if adv_util >= 0.8 else ''}" style="width:{min(100, adv_util * 100):.2f}%"></div></div><div class="track"><div class="bar {'hot' if std_util >= 1 else 'warn' if std_util >= 0.8 else ''}" style="width:{min(100, std_util * 100):.2f}%"></div></div><div class="value">{advanced:,.0f} adv | {standard:,.0f} std | {discovery_label}</div></div>"""


def system_health_pdf_summary(rows: list[dict[str, Any]], report: dict[str, Any]) -> str:
    cards = [
        ("Sensors", f"{len(rows):,}", "Discover sensors returned"),
        ("Packet Risk", f"{sum(1 for r in rows if ratio(r['packet_peak'], r['packet_capacity']) >= 1):,}", "At model packet rating"),
        ("Throughput Watch", f"{sum(1 for r in rows if ratio(r['throughput_gbps'], r['throughput_capacity']) >= 0.8):,}", "At 80%+ throughput"),
        ("Trigger Drops", f"{sum(1 for r in rows if r['trigger_drops'] > 0):,}", "Sensors with drops"),
    ]
    return "".join(f"<div class='card'><span>{html.escape(label)}</span><b>{html.escape(value)}</b><small class='muted'>{html.escape(note)}</small></div>" for label, value, note in cards)


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
