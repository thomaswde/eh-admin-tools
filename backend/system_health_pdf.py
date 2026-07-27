"""Bounded System Health PDF request validation, projection, and rendering."""

import asyncio
from collections.abc import Callable
from contextlib import suppress
import html
import math
import os
import re
from typing import Any, Literal

from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

HEX_PATTERN = r"^#[0-9a-fA-F]{6}$"

MAX_PDF_REQUEST_BYTES = 2 * 1024 * 1024
MAX_PDF_JSON_DEPTH = 12
MAX_PDF_JSON_NODES = 250_000
MAX_PDF_COLLECTION_ITEMS = 5_000
MAX_PDF_STRING_LENGTH = 4_096
MAX_PDF_SENSOR_SUMMARIES = 1_000
MAX_PDF_PACKETSTORE_SUMMARIES = 1_000
PDF_RENDER_MAX_CONCURRENCY = max(1, int(os.environ.get("EH_PDF_RENDER_MAX_CONCURRENCY", "1")))
PDF_RENDER_ACQUIRE_TIMEOUT_SECONDS = max(
    0.1,
    float(os.environ.get("EH_PDF_RENDER_ACQUIRE_TIMEOUT_SECONDS", "2")),
)
PDF_RENDER_TIMEOUT_SECONDS = max(1.0, float(os.environ.get("EH_PDF_RENDER_TIMEOUT_SECONDS", "120")))
PDF_STYLE_FIELDS = frozenset({"transparent", "colors"})
PDF_STYLE_COLOR_FIELDS = frozenset(
    {
        "bg",
        "text",
        "subtle",
        "muted",
        "grid",
        "track",
        "altRow",
        "low",
        "mid",
        "high",
    }
)
PDF_RAW_SERIES_FIELDS = frozenset({"rows", "stats", "chunks", "result_chunks", "values"})


def validate_pdf_json_tree(value: Any, path: str) -> None:
    node_count = 0

    def visit(item: Any, item_path: str, depth: int) -> None:
        nonlocal node_count
        node_count += 1
        if node_count > MAX_PDF_JSON_NODES:
            raise ValueError(f"{path} exceeds the {MAX_PDF_JSON_NODES:,} value limit")
        if depth > MAX_PDF_JSON_DEPTH:
            raise ValueError(f"{item_path} exceeds the maximum nesting depth")

        if isinstance(item, dict):
            if len(item) > MAX_PDF_COLLECTION_ITEMS:
                raise ValueError(f"{item_path} exceeds the {MAX_PDF_COLLECTION_ITEMS:,} field limit")
            for key, child in item.items():
                if len(key) > 128:
                    raise ValueError(f"{item_path} contains an oversized field name")
                child_path = f"{item_path}.{key}"
                if key in PDF_RAW_SERIES_FIELDS and child not in (None, [], {}):
                    raise ValueError(f"{child_path} contains raw collection data; send summaries only")
                visit(child, child_path, depth + 1)
            return

        if isinstance(item, list):
            if len(item) > MAX_PDF_COLLECTION_ITEMS:
                raise ValueError(f"{item_path} exceeds the {MAX_PDF_COLLECTION_ITEMS:,} item limit")
            for index, child in enumerate(item):
                visit(child, f"{item_path}[{index}]", depth + 1)
            return

        if isinstance(item, str) and len(item) > MAX_PDF_STRING_LENGTH:
            raise ValueError(f"{item_path} exceeds the {MAX_PDF_STRING_LENGTH:,} character limit")
        if isinstance(item, float) and not math.isfinite(item):
            raise ValueError(f"{item_path} must be a finite number")
        if item is not None and not isinstance(item, (str, int, float, bool)):
            raise ValueError(f"{item_path} contains an unsupported value")

    visit(value, path, 0)


class StrictRendererModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class RendererTarget(StrictRendererModel):
    type: str
    tenant: str
    host: str
    name: str


class RendererWindow(StrictRendererModel):
    lookback_days: int | float | None
    from_ms: int | float | None
    until_ms: int | float | None
    from_iso: str
    until_iso: str


class RendererCyclePolicy(StrictRendererModel):
    requested_cycle: str
    query_cycle: str
    minimum_safe_cycle: str
    estimated_buckets_per_sensor: int | float | None
    estimated_scalar_points: int | float | None
    adjusted: bool
    policy: str


class RendererMetadata(StrictRendererModel):
    generated_at: str
    target: RendererTarget
    window: RendererWindow
    requested_cycle: str
    cycle: str
    cycle_label: str
    packetstore_cycle_label: str
    cycle_policy: RendererCyclePolicy | None
    capacity_catalog_loaded: bool
    errors: list[str] = Field(max_length=1_000)


class RendererAnalysisSummary(StrictRendererModel):
    advanced: int | float | None
    standard: int | float | None
    discovery: int | float | None
    total: int | float | None
    status: str


class RendererHealthCondition(StrictRendererModel):
    type: str
    status: str
    message: str


class RendererSensorSummary(StrictRendererModel):
    id: str
    name: str
    model: str
    online: bool
    dataAccess: bool | None
    applianceRole: str
    collectionStatus: dict[str, str]
    analysis: RendererAnalysisSummary
    packetPeak: int | float | None
    packetCapacity: int | float | None
    throughputGbps: int | float | None
    throughputCapacity: int | float | None
    triggerCyclesPeak: int | float | None
    triggerCyclesAvail: int | float | None
    triggerUtilization: int | float | None
    triggerPeakTimestampMs: int | float | None
    triggerPeakDurationMs: int | float | None
    triggerDropsTotal: int | float | None
    advancedCapacity: int | float | None
    standardCapacity: int | float | None
    healthConditions: list[RendererHealthCondition] = Field(max_length=64)


class RendererPacketstoreSummary(StrictRendererModel):
    id: str
    name: str
    model: str
    online: bool
    applianceRole: str
    collectionStatus: dict[str, str]
    lookbackLatestSec: int | float | None
    lookbackMinSec: int | float | None
    packetsTotal: int | float | None
    packetDropsTotal: int | float | None
    packetDropRatio: int | float | None
    slowWriteDropsTotal: int | float | None
    interfaceDropsTotal: int | float | None
    blocksDroppedTotal: int | float | None
    secretsTotal: int | float | None
    secretDropsTotal: int | float | None
    secretDropRatio: int | float | None
    inputLoadPeak: int | float | None
    compressionLoadPeak: int | float | None
    diskWriteLoadPeak: int | float | None


class RendererFinding(StrictRendererModel):
    id: str
    name: str
    model: str
    severity: str
    condition: str
    evidence: str
    findings: list[str] = Field(max_length=64)
    finding_text: str
    worst_ratio: int | float
    at_capacity: bool
    absent: bool


class RendererModelCount(StrictRendererModel):
    model: str
    count: int


class RendererOverview(StrictRendererModel):
    sensors: int
    reporting: int
    healthy: int
    offline: int
    no_access: int
    absent: int
    attention: int
    at_capacity: int
    trigger_drops: int | float | None
    trigger_drops_reporting: int
    trigger_drops_unavailable: int
    packetstores: int
    packetstores_all_in_one: int
    packetstores_paired: int
    packetstores_with_loss: int
    packetstores_clean: int
    packetstores_loss_reporting: int
    packetstores_loss_unavailable: int
    packetstores_with_critical_loss: int
    packetstore_loss_severity: str
    packetstores_loaded: int
    packetstore_lookback_average_sec: int | float | None
    packetstore_lookback_reporting_sources: int
    model_counts: list[RendererModelCount] = Field(max_length=1_000)


class SystemHealthRendererProjection(StrictRendererModel):
    schema_version: Literal["1"]
    metadata: RendererMetadata
    sensor_summaries: list[RendererSensorSummary] = Field(max_length=MAX_PDF_SENSOR_SUMMARIES)
    packetstore_summaries: list[RendererPacketstoreSummary] = Field(max_length=MAX_PDF_PACKETSTORE_SUMMARIES)
    findings: list[RendererFinding] = Field(max_length=MAX_PDF_SENSOR_SUMMARIES)
    absent: list[RendererFinding] = Field(max_length=MAX_PDF_SENSOR_SUMMARIES)
    overview: RendererOverview
    verdict: str
    recommendations: list[str] = Field(max_length=5)

    @model_validator(mode="after")
    def validate_resource_bounds(self) -> "SystemHealthRendererProjection":
        validate_pdf_json_tree(self.model_dump(mode="python"), "report")
        return self


class SystemHealthPdfRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    report: SystemHealthRendererProjection
    style: dict[str, Any] = Field(default_factory=dict)

    @field_validator("style")
    @classmethod
    def validate_style(cls, value: dict[str, Any]) -> dict[str, Any]:
        unknown = set(value) - PDF_STYLE_FIELDS
        if unknown:
            raise ValueError(f"unsupported style fields: {', '.join(sorted(unknown))}")
        if "transparent" in value and not isinstance(value["transparent"], bool):
            raise ValueError("style.transparent must be a boolean")
        colors = value.get("colors", {})
        if not isinstance(colors, dict):
            raise ValueError("style.colors must be an object")
        unknown_colors = set(colors) - PDF_STYLE_COLOR_FIELDS
        if unknown_colors:
            raise ValueError(f"unsupported style colors: {', '.join(sorted(unknown_colors))}")
        for name, color in colors.items():
            if not isinstance(color, str) or re.fullmatch(HEX_PATTERN, color) is None:
                raise ValueError(f"style.colors.{name} must be a six-digit hex color")
        validate_pdf_json_tree(value, "style")
        return value


pdf_render_semaphore = asyncio.Semaphore(PDF_RENDER_MAX_CONCURRENCY)


class PdfRendererUnavailable(RuntimeError):
    pass


class PdfRenderBusyError(RuntimeError):
    pass


class PdfRenderTimeoutError(RuntimeError):
    pass


async def parse_system_health_pdf_request(request: Request) -> SystemHealthPdfRequest:
    content_type = request.headers.get("content-type", "").partition(";")[0].strip().lower()
    if content_type != "application/json":
        raise HTTPException(
            status_code=415,
            detail={"message": "System Health PDF requests must use application/json."},
        )

    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_PDF_REQUEST_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail={"message": f"System Health PDF request exceeds {MAX_PDF_REQUEST_BYTES:,} bytes."},
                )
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail={"message": "System Health PDF request has an invalid Content-Length header."},
            ) from None

    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_PDF_REQUEST_BYTES:
            raise HTTPException(
                status_code=413,
                detail={"message": f"System Health PDF request exceeds {MAX_PDF_REQUEST_BYTES:,} bytes."},
            )

    try:
        return SystemHealthPdfRequest.model_validate_json(bytes(body))
    except ValidationError as error:
        safe_errors = [
            {key: value for key, value in item.items() if key not in {"input", "ctx", "url"}} for item in error.errors()
        ]
        raise HTTPException(
            status_code=422,
            detail={"message": "System Health PDF request validation failed.", "errors": safe_errors},
        ) from error


async def close_playwright_resource(resource: Any) -> None:
    if resource is None:
        return
    with suppress(BaseException):
        await resource.close()


async def render_system_health_pdf_bytes(
    html_text: str,
    *,
    playwright_factory: Any = None,
) -> bytes:
    if playwright_factory is None:
        try:
            from playwright.async_api import async_playwright
        except ImportError as error:
            raise PdfRendererUnavailable(
                "Playwright is not installed. Run `pip install -r requirements.txt` and "
                "`python3 -m playwright install chromium` to enable PDF export."
            ) from error
        playwright_factory = async_playwright

    browser = None
    page = None
    async with playwright_factory() as playwright:
        try:
            browser = await playwright.chromium.launch()
            page = await browser.new_page(viewport={"width": 1280, "height": 960}, device_scale_factor=1)
            await page.set_content(html_text, wait_until="networkidle")
            return await page.pdf(
                format="Letter",
                print_background=True,
                margin={"top": "0.35in", "right": "0.35in", "bottom": "0.35in", "left": "0.35in"},
                prefer_css_page_size=True,
            )
        finally:
            await close_playwright_resource(page)
            await close_playwright_resource(browser)


async def render_system_health_pdf_bounded(
    html_text: str,
    *,
    renderer: Any = None,
    semaphore: asyncio.Semaphore | None = None,
    acquire_timeout: float | None = None,
    render_timeout: float | None = None,
) -> bytes:
    renderer = renderer or render_system_health_pdf_bytes
    semaphore = semaphore or pdf_render_semaphore
    acquire_timeout = PDF_RENDER_ACQUIRE_TIMEOUT_SECONDS if acquire_timeout is None else acquire_timeout
    render_timeout = PDF_RENDER_TIMEOUT_SECONDS if render_timeout is None else render_timeout

    try:
        await asyncio.wait_for(semaphore.acquire(), timeout=acquire_timeout)
    except TimeoutError as error:
        raise PdfRenderBusyError("Another PDF export is already rendering. Retry shortly.") from error

    try:
        try:
            return await asyncio.wait_for(renderer(html_text), timeout=render_timeout)
        except TimeoutError as error:
            raise PdfRenderTimeoutError(f"System Health PDF rendering exceeded {render_timeout:g} seconds.") from error
    finally:
        semaphore.release()


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
        (
            "Packet Rate vs Model Capacity",
            f"Peak {cycle_label} average packet rate by sensor",
            "packet_peak",
            "packet_capacity",
            "pps",
            rows,
        ),
        (
            "Throughput vs Model Capacity",
            f"Peak {cycle_label} average throughput by sensor",
            "throughput_gbps",
            "throughput_capacity",
            "gbps",
            rows,
        ),
        (
            "Trigger Cycles vs Available Capacity",
            f"Maximum aligned {cycle_label} trigger utilization by sensor",
            "trigger_cycles_peak",
            "trigger_cycles_avail",
            "number",
            rows,
        ),
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
            chunks = [reporting_rows[i : i + 22] for i in range(0, len(reporting_rows), 22)] or [[]]
            for index, chunk in enumerate(chunks, start=1):
                pages.append(
                    system_health_pdf_page(
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
                    )
                )
    packetstore_offline_names = sorted(
        str(row.get("name") or row.get("id") or "Unknown sensor")
        for row in packetstore_rows
        if not row.get("online", True)
    )
    reporting_packetstores = [row for row in packetstore_rows if row.get("online", True)]
    packetstore_chunks = [reporting_packetstores[i : i + 12] for i in range(0, len(reporting_packetstores), 12)] or (
        [[]] if packetstore_offline_names else []
    )
    for index, chunk in enumerate(packetstore_chunks, start=1):
        pages.append(
            system_health_pdf_packetstore_page(
                chunk,
                index,
                len(packetstore_chunks),
                system_health_pdf_packetstore_cycle_label(report),
                packetstore_offline_names,
            )
        )

    metadata = report.get("metadata") or {}
    generated = html.escape(str(metadata.get("generated_at") or ""))
    lookback = html.escape(str(((metadata.get("window") or {}).get("lookback_days")) or ""))
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
.offline-summary {{ margin-top: 12px; padding: 12px 0 8px; border-top: 1px solid {colors["border"]}; font-size: 11px; }}
.offline-summary b {{ display: block; margin-bottom: 5px; color: {colors["high"]}; }}
.offline-summary .offline-names {{ color: {colors["muted"]}; line-height: 1.4; overflow-wrap: anywhere; }}
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
    rows: list[dict[str, Any]] = []
    for sensor in report.get("sensor_summaries") or []:
        statuses = sensor.get("collectionStatus") or {}
        rows.append(
            {
                "id": str(sensor.get("id") or ""),
                "name": sensor.get("name") or f"Appliance {sensor.get('id') or ''}",
                "model": sensor.get("model") or "Unknown",
                "online": bool(sensor.get("online")),
                "packet_peak": sensor.get("packetPeak"),
                "packet_capacity": sensor.get("packetCapacity"),
                "throughput_gbps": sensor.get("throughputGbps"),
                "throughput_capacity": sensor.get("throughputCapacity"),
                "trigger_cycles_peak": sensor.get("triggerCyclesPeak"),
                "trigger_cycles_avail": sensor.get("triggerCyclesAvail"),
                "trigger_utilization": sensor.get("triggerUtilization"),
                "trigger_drops": sensor.get("triggerDropsTotal"),
                "analysis": sensor.get("analysis") or {},
                "advanced_capacity": sensor.get("advancedCapacity"),
                "standard_capacity": sensor.get("standardCapacity"),
                "metric_status": {
                    **statuses,
                    "trigger_cycles": statuses.get("trigger_utilization", statuses.get("trigger_cycles", "unknown")),
                },
                "health_conditions": sensor.get("healthConditions") or [],
            }
        )
    return rows


def system_health_pdf_packetstore_rows(report: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for appliance in report.get("packetstore_summaries") or []:
        rows.append(
            {
                "id": str(appliance.get("id") or ""),
                "name": appliance.get("name") or f"Appliance {appliance.get('id') or ''}",
                "role": appliance.get("applianceRole") or "packetstore",
                "online": bool(appliance.get("online")),
                "lookback_latest": appliance.get("lookbackLatestSec"),
                "lookback_min": appliance.get("lookbackMinSec"),
                "packets": appliance.get("packetsTotal"),
                "packet_drops": appliance.get("packetDropsTotal"),
                "packet_drop_ratio": appliance.get("packetDropRatio"),
                "slow_write_drops": appliance.get("slowWriteDropsTotal"),
                "interface_drops": appliance.get("interfaceDropsTotal"),
                "blocks_dropped": appliance.get("blocksDroppedTotal"),
                "secrets": appliance.get("secretsTotal"),
                "secret_drops": appliance.get("secretDropsTotal"),
                "secret_drop_ratio": appliance.get("secretDropRatio"),
                "input_load": appliance.get("inputLoadPeak"),
                "compress_load": appliance.get("compressionLoadPeak"),
                "write_load": appliance.get("diskWriteLoadPeak"),
            }
        )
    return rows


def system_health_pdf_packetstore_page(
    rows: list[dict[str, Any]],
    page: int,
    pages: int,
    cycle_label: str,
    offline_names: list[str] | None = None,
) -> str:
    offline_names = offline_names or []
    body = [
        "<div class='packetstore-grid'><div class='head'>APPLIANCE</div><div class='head'>RETENTION</div><div class='head'>CAPTURE &amp; SECRET FIDELITY</div><div class='head'>PEAK PROCESSING LOAD</div>"
    ]
    for row in rows:
        latest = row.get("lookback_latest")
        minimum = row.get("lookback_min")
        lookback = (
            f"{latest / 86400:.1f}d latest · {minimum / 86400:.1f}d min"
            if latest is not None and minimum is not None
            else "unavailable"
        )
        packet_ratio = row.get("packet_drop_ratio")
        secret_ratio = row.get("secret_drop_ratio")
        packet_label = f"{packet_ratio * 100:.4g}%" if packet_ratio is not None else "unavailable"
        secret_label = f"{secret_ratio * 100:.4g}%" if secret_ratio is not None else "unavailable"
        packet_drops = row.get("packet_drops")
        packet_detail = (
            f"Packets {packet_label} ({format_pdf_counter(packet_drops)} dropped)"
            if packet_drops is not None
            else "Packets unavailable (drop counter unavailable)"
        )
        secret_drops = row.get("secret_drops")
        secrets = row.get("secrets")
        if secret_drops is None and secrets is None:
            secret_detail = "Secrets unavailable (drop and total counters unavailable)"
        elif secret_drops is None:
            secret_detail = f"Secrets unavailable (drop counter unavailable; total {format_pdf_counter(secrets)})"
        elif secrets is None:
            secret_detail = (
                f"Secrets unavailable ({format_pdf_counter(secret_drops)} dropped; total counter unavailable)"
            )
        else:
            secret_detail = (
                f"Secrets {secret_label} ({format_pdf_counter(secret_drops)} of {format_pdf_counter(secrets)} dropped)"
            )
        fidelity = (
            f"{packet_detail} · {secret_detail}<br>"
            f"Slow-write {format_pdf_counter(row.get('slow_write_drops'))} · "
            f"interface {format_pdf_counter(row.get('interface_drops'))} · "
            f"blocks {format_pdf_counter(row.get('blocks_dropped'))}"
        )
        load_values = [
            ("Input", row.get("input_load")),
            ("Compress", row.get("compress_load")),
            ("Write", row.get("write_load")),
        ]
        loads = "".join(
            f"{label} {float(value):.1f}%<div class='mini'><span style='width:{min(100, max(0, float(value))):.2f}%'></span></div>"
            if value is not None
            else f"{label} unavailable<br>"
            for label, value in load_values
        )
        role = "All in One" if row.get("role") == "all_in_one" else "Paired Packetstore"
        body.extend(
            [
                f"<div class='name'>{html.escape(str(row.get('name') or ''))}<br><span class='muted'>{role}</span></div>",
                f"<div>{html.escape(lookback)}</div>",
                f"<div>{fidelity}</div>",
                f"<div>{loads}</div>",
            ]
        )
    body.append("</div>")
    if offline_names:
        body.append(
            f"""<div class="offline-summary"><b>{len(offline_names):,} OFFLINE</b>"""
            f"""<div class="offline-names">{html.escape(", ".join(offline_names))}</div></div>"""
        )
    subtitle = f"Retention, capture fidelity, and peak sampled 30-second processing load at {cycle_label} cadence"
    source_count = len(rows) + len(offline_names)
    return f"""<section class="page"><div class="page-head"><div><h2>Packetstore Health</h2><div class="muted">{html.escape(subtitle)}</div></div><div class="model">{source_count} metric sources | Page {page} of {pages}</div></div>{"".join(body)}</section>"""


def system_health_pdf_packetstore_cycle_label(report: dict[str, Any]) -> str:
    metadata = report.get("metadata") or {}
    return str(metadata.get("packetstore_cycle_label") or metadata.get("cycle_label") or "unknown-cycle")


def system_health_pdf_model_groups(
    rows: list[dict[str, Any]], value_key: str | None, capacity_key: str | None, unit: str
) -> list[tuple[str, list[dict[str, Any]]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(str(row.get("model") or "Unknown"), []).append(row)
    for model_rows in grouped.values():
        if unit == "analysis":
            model_rows.sort(
                key=lambda row: (
                    max(
                        ratio(row["analysis"].get("advanced", 0), row["advanced_capacity"]),
                        ratio(row["analysis"].get("standard", 0), row["standard_capacity"]),
                    )
                    + (0.001 if row["analysis"].get("discovery", 0) else 0)
                ),
                reverse=True,
            )
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
        chart_rows = "\n".join(
            system_health_pdf_bar_row(row, value_key or "", capacity_key or "", unit) for row in rows
        )
    if not chart_rows and not offline_names:
        chart_rows = (
            "<p class='muted'>No device analysis data returned.</p>"
            if unit == "analysis"
            else "<p class='muted'>No metric data returned.</p>"
        )
    offline_summary = (
        f"""<div class="offline-summary"><b>{len(offline_names):,} OFFLINE</b>"""
        f"""<div class="offline-names">{html.escape(", ".join(offline_names))}</div></div>"""
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
    label = (
        "offline"
        if not row.get("online", True)
        else collection_status.replace("_", " ")
        if not available
        else f"{util * 100:.0f}% | {format_pdf_value(value, unit)}"
        if capacity
        else format_pdf_value(value, unit)
    )
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
    return f"""<div class="row analysis"><div class="name">{html.escape(str(row.get("name") or ""))}</div><div class="track"><div class="bar {"hot" if adv_util >= 1 else "warn" if adv_util >= 0.8 else ""}" style="width:{min(100, adv_util * 100):.2f}%"></div></div><div class="track"><div class="bar {"hot" if std_util >= 1 else "warn" if std_util >= 0.8 else ""}" style="width:{min(100, std_util * 100):.2f}%"></div></div><div class="value">{advanced:,.0f} adv | {standard:,.0f} std | {discovery_label}</div></div>"""


def system_health_pdf_summary(
    rows: list[dict[str, Any]], report: dict[str, Any], packetstore_rows: list[dict[str, Any]] | None = None
) -> str:
    packetstore_rows = packetstore_rows or []

    def reporting_card(
        source_rows: list[dict[str, Any]],
        is_reporting: Callable[[dict[str, Any]], bool],
        matches: Callable[[dict[str, Any]], bool],
        note: str,
    ) -> tuple[str, str]:
        reporting = [row for row in source_rows if is_reporting(row)]
        unavailable = len(source_rows) - len(reporting)
        value = f"{sum(1 for row in reporting if matches(row)):,} / {len(reporting):,}" if reporting else "N/A"
        card_note = f"{note} / reporting"
        if unavailable:
            card_note += f" ({unavailable:,} unavailable)"
        return value, card_note

    packet_risk_value, packet_risk_note = reporting_card(
        rows,
        lambda row: (
            (row.get("metric_status") or {}).get("pkts") in {"complete", "zero_valued"}
            and float(row.get("packet_capacity") or 0) > 0
        ),
        lambda row: ratio(row["packet_peak"], row["packet_capacity"]) >= 1,
        "At model packet rating",
    )
    throughput_watch_value, throughput_watch_note = reporting_card(
        rows,
        lambda row: (
            (row.get("metric_status") or {}).get("bytes") in {"complete", "zero_valued"}
            and float(row.get("throughput_capacity") or 0) > 0
        ),
        lambda row: ratio(row["throughput_gbps"], row["throughput_capacity"]) >= 0.8,
        "At 80%+ throughput",
    )
    trigger_drop_reporting = [row for row in rows if row.get("trigger_drops") is not None]
    trigger_drop_unavailable = len(rows) - len(trigger_drop_reporting)
    trigger_drop_value = (
        f"{sum(1 for row in trigger_drop_reporting if row['trigger_drops'] > 0):,} / {len(trigger_drop_reporting):,}"
        if trigger_drop_reporting
        else "N/A"
    )
    trigger_drop_note = "Sensors with drops / reporting"
    if trigger_drop_unavailable:
        trigger_drop_note += f" ({trigger_drop_unavailable:,} unavailable)"
    packetstore_loss_fields = (
        "packet_drops",
        "slow_write_drops",
        "interface_drops",
        "blocks_dropped",
        "secret_drops",
    )

    def packetstore_has_loss(row: dict[str, Any]) -> bool:
        return any(row.get(field) is not None and float(row[field]) > 0 for field in packetstore_loss_fields)

    def packetstore_loss_is_reporting(row: dict[str, Any]) -> bool:
        return packetstore_has_loss(row) or all(row.get(field) is not None for field in packetstore_loss_fields)

    packetstore_loss_value, packetstore_loss_note = reporting_card(
        packetstore_rows,
        packetstore_loss_is_reporting,
        packetstore_has_loss,
        "Stores with observed loss",
    )
    cards = [
        ("Sensors", f"{len(rows):,}", "Discover sensors returned"),
        ("Packet Risk", packet_risk_value, packet_risk_note),
        ("Throughput Watch", throughput_watch_value, throughput_watch_note),
        ("Trigger Drops", trigger_drop_value, trigger_drop_note),
        ("PCAP Sources", f"{len(packetstore_rows):,}", "Packetstore-backed sensors detected by cpc metrics"),
        ("PCAP Loss", packetstore_loss_value, packetstore_loss_note),
    ]
    return "".join(
        f"<div class='card'><span>{html.escape(label)}</span><b>{html.escape(value)}</b><small class='muted'>{html.escape(note)}</small></div>"
        for label, value, note in cards
    )


def system_health_pdf_cycle_label(report: dict[str, Any]) -> str:
    metadata = report.get("metadata") or {}
    return str(metadata.get("cycle_label") or metadata.get("cycle") or "unknown-cycle")


def ratio(value: Any, capacity: Any) -> float:
    capacity_float = float(capacity or 0)
    return float(value or 0) / capacity_float if capacity_float else 0


def format_pdf_counter(value: Any) -> str:
    if value is None:
        return "unavailable"
    try:
        return f"{int(value):,}"
    except (TypeError, ValueError, OverflowError):
        return "unavailable"


def format_pdf_value(value: float, unit: str) -> str:
    if unit == "gbps":
        return f"{value:.2f} Gbps"
    if unit == "pps":
        return f"{value / 1_000_000:.2f} Mpps" if value >= 1_000_000 else f"{value / 1_000:.1f} Kpps"
    return f"{value:,.0f}"


def system_health_pdf_filename(report: dict[str, Any]) -> str:
    generated = str(((report.get("metadata") or {}).get("generated_at")) or "")
    report_day = generated[:10] if re.fullmatch(r"\d{4}-\d{2}-\d{2}", generated[:10]) else "export"
    return f"system-health-report-{report_day}.pdf"
