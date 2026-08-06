from __future__ import annotations

import asyncio
import json
import math
import re
import time
from collections.abc import Awaitable, Callable
from typing import Any

from backend.extrahop_client import ExtraHopClient


DASHBOARD_VIEW_METRIC = "_bi_dashboard_views_id"
DASHBOARD_VIEW_CATEGORY = "ui"
DASHBOARD_VIEW_CYCLE = "auto"
DAY_MS = 24 * 60 * 60 * 1000
MAX_LOOKBACK_DAYS = 365
MAX_BUCKET_ROWS = MAX_LOOKBACK_DAYS * 24 + 2
MAX_KEYS_PER_BUCKET = 10_000
MAX_TOTAL_KEYS = 200_000
MAX_CONTINUATION_REQUESTS = 120
MAX_PENDING_RESPONSES = 60
DEFAULT_DEADLINE_SECONDS = 90.0
DECIMAL_IDENTIFIER = re.compile(r"^-?(?:0|[1-9][0-9]*)$")


class DashboardUsageError(RuntimeError):
    def __init__(self, message: str, *, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


def _json_body(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


async def _await_before_deadline(
    awaitable: Awaitable[Any],
    *,
    deadline: float,
    monotonic: Callable[[], float],
) -> Any:
    remaining = deadline - monotonic()
    if remaining <= 0:
        if hasattr(awaitable, "close"):
            awaitable.close()  # type: ignore[attr-defined]
        raise DashboardUsageError("Dashboard usage collection timed out.", status_code=504)
    try:
        return await asyncio.wait_for(awaitable, timeout=remaining)
    except asyncio.TimeoutError as error:
        raise DashboardUsageError("Dashboard usage collection timed out.", status_code=504) from error


async def _collect_metric_chunks(
    client: ExtraHopClient,
    body: dict[str, Any],
    *,
    deadline: float,
    monotonic: Callable[[], float],
    sleep: Callable[[float], Awaitable[None]],
) -> list[dict[str, Any]]:
    initial = await _await_before_deadline(
        client.request(
            "POST",
            "/api/v1/metrics",
            body=_json_body(body),
            content_type="application/json",
        ),
        deadline=deadline,
        monotonic=monotonic,
    )
    if isinstance(initial, dict) and isinstance(initial.get("stats"), list):
        return [initial]
    if not isinstance(initial, dict) or initial.get("xid") in {None, ""}:
        raise DashboardUsageError("Dashboard usage metrics returned an unexpected response.")

    xid = str(initial["xid"])
    if not DECIMAL_IDENTIFIER.fullmatch(xid):
        raise DashboardUsageError("Dashboard usage metrics returned an invalid continuation ID.")
    expected_results = initial.get("num_results")
    expected = expected_results if isinstance(expected_results, int) and expected_results >= 0 else None
    chunks: list[dict[str, Any]] = []
    pending = 0

    for _ in range(MAX_CONTINUATION_REQUESTS):
        if expected is not None and len(chunks) >= expected:
            return chunks
        chunk = await _await_before_deadline(
            client.request("GET", f"/api/v1/metrics/next/{xid}"),
            deadline=deadline,
            monotonic=monotonic,
        )
        if chunk is None:
            return chunks
        if chunk == "again":
            pending += 1
            if pending > MAX_PENDING_RESPONSES:
                raise DashboardUsageError("Dashboard usage metrics remained pending too long.", status_code=504)
            delay = min(5.0, 0.5 * (2 ** min(4, pending - 1)))
            await _await_before_deadline(
                sleep(delay),
                deadline=deadline,
                monotonic=monotonic,
            )
            continue
        if not isinstance(chunk, dict) or not isinstance(chunk.get("stats"), list):
            raise DashboardUsageError("Dashboard usage metrics returned an invalid continuation response.")
        chunks.append(chunk)
        pending = 0

    raise DashboardUsageError("Dashboard usage metrics exceeded the continuation request limit.", status_code=504)


def _dashboard_id(entry: dict[str, Any]) -> str | None:
    key = entry.get("key")
    if not isinstance(key, dict) or key.get("key_type") != "intval":
        return None
    value = key.get("intval")
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    if isinstance(value, str) and DECIMAL_IDENTIFIER.fullmatch(value):
        return value
    return None


def summarize_dashboard_views(chunks: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    bucket_rows = 0
    total_keys = 0

    for chunk in chunks:
        stats = chunk.get("stats")
        if not isinstance(stats, list):
            raise DashboardUsageError("Dashboard usage metrics included malformed statistics.")
        for stat in stats:
            bucket_rows += 1
            if bucket_rows > MAX_BUCKET_ROWS:
                raise DashboardUsageError("Dashboard usage metrics exceeded the bucket limit.")
            if not isinstance(stat, dict):
                raise DashboardUsageError("Dashboard usage metrics included a malformed bucket.")
            values = stat.get("values")
            if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], list):
                raise DashboardUsageError("Dashboard usage metrics included an unexpected value shape.")
            entries = values[0]
            if len(entries) > MAX_KEYS_PER_BUCKET:
                raise DashboardUsageError("Dashboard usage metrics exceeded the per-bucket key limit.")
            total_keys += len(entries)
            if total_keys > MAX_TOTAL_KEYS:
                raise DashboardUsageError("Dashboard usage metrics exceeded the total key limit.")

            start_ms = stat.get("time")
            duration_ms = stat.get("duration")
            if not isinstance(start_ms, int) or not isinstance(duration_ms, int) or duration_ms < 0:
                raise DashboardUsageError("Dashboard usage metrics included an invalid bucket window.")
            end_ms = start_ms + duration_ms

            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                dashboard_id = _dashboard_id(entry)
                raw_count = entry.get("value")
                if dashboard_id is None or isinstance(raw_count, bool) or not isinstance(raw_count, (int, float)):
                    continue
                if not math.isfinite(raw_count) or raw_count <= 0:
                    continue
                current = by_id.get(dashboard_id)
                if current is None:
                    current = {
                        "dashboardId": dashboard_id,
                        "lastViewedBucketStartMs": start_ms,
                        "lastViewedBucketEndMs": end_ms,
                        "viewsInWindow": 0,
                    }
                    by_id[dashboard_id] = current
                current["viewsInWindow"] += raw_count
                if end_ms > current["lastViewedBucketEndMs"]:
                    current["lastViewedBucketStartMs"] = start_ms
                    current["lastViewedBucketEndMs"] = end_ms

    return by_id


def _response_window(
    chunks: list[dict[str, Any]],
    *,
    lookback_days: int,
    fallback_until_ms: int,
) -> tuple[int, int | None, int]:
    response_from = [
        chunk["from"]
        for chunk in chunks
        if isinstance(chunk.get("from"), int) and chunk["from"] > 0
    ]
    response_until = [
        value
        for chunk in chunks
        for value in (chunk.get("until"), chunk.get("clock"))
        if isinstance(value, int) and value > 0
    ]
    until_ms = max(response_until, default=fallback_until_ms)
    requested_from_ms = min(response_from, default=until_ms - lookback_days * DAY_MS)

    # The response-level `from` value describes the requested window even when
    # older rollups have aged out. A no-view conclusion is only supportable for
    # the common window represented by actual buckets from every returned
    # source chunk.
    coverage_starts: list[int] = []
    for chunk in chunks:
        stats = chunk.get("stats")
        if not isinstance(stats, list) or not stats:
            return requested_from_ms, None, until_ms
        starts = [
            stat["time"]
            for stat in stats
            if isinstance(stat, dict)
            and isinstance(stat.get("time"), int)
            and not isinstance(stat.get("time"), bool)
            and stat["time"] > 0
        ]
        if len(starts) != len(stats):
            return requested_from_ms, None, until_ms
        coverage_starts.append(min(starts))

    coverage_from_ms = max(coverage_starts) if coverage_starts else None
    return requested_from_ms, coverage_from_ms, until_ms


def _response_cycle(chunks: list[dict[str, Any]]) -> str:
    cycles = {
        str(chunk.get("cycle", "")).strip().casefold()
        for chunk in chunks
        if str(chunk.get("cycle", "")).strip()
    }
    return next(iter(cycles)) if len(cycles) == 1 else DASHBOARD_VIEW_CYCLE


async def collect_dashboard_usage(
    client: ExtraHopClient,
    *,
    lookback_days: int = MAX_LOOKBACK_DAYS,
    now_ms: int | None = None,
    deadline_seconds: float = DEFAULT_DEADLINE_SECONDS,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> dict[str, Any]:
    days = int(lookback_days)
    if days < 1 or days > MAX_LOOKBACK_DAYS:
        raise ValueError(f"lookback_days must be between 1 and {MAX_LOOKBACK_DAYS}")
    fallback_until_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    body = {
        "cycle": DASHBOARD_VIEW_CYCLE,
        # ExtraHop evaluates negative windows and zero against its own clock.
        # Workstation time can differ enough to make an otherwise valid query
        # return a successful response with no metric buckets.
        "from": -days * DAY_MS,
        "until": 0,
        "object_type": "system",
        "object_ids": [0],
        "metric_category": DASHBOARD_VIEW_CATEGORY,
        "metric_specs": [{"name": DASHBOARD_VIEW_METRIC}],
    }
    deadline = monotonic() + max(1.0, float(deadline_seconds))
    chunks = await _collect_metric_chunks(
        client,
        body,
        deadline=deadline,
        monotonic=monotonic,
        sleep=sleep,
    )
    by_id = summarize_dashboard_views(chunks)
    requested_from_ms, coverage_from_ms, until_ms = _response_window(
        chunks,
        lookback_days=days,
        fallback_until_ms=fallback_until_ms,
    )
    cycle = _response_cycle(chunks)
    coverage_days = (
        max(0, (until_ms - coverage_from_ms) // DAY_MS)
        if coverage_from_ms is not None
        else None
    )
    if coverage_days is None:
        coverage_notice = (
            "Dashboard-view metric history could not be established, "
            "so recorded-activity filters are unavailable."
        )
    elif coverage_from_ms <= requested_from_ms:
        coverage_notice = f"Returned metric history spans the requested {days} days."
    else:
        coverage_notice = (
            f"Returned metric history spans {coverage_days} complete days of the requested {days}; "
            "longer lookbacks are not offered."
        )
    return {
        "status": "complete",
        # `fromMs` remains the browser-facing coverage boundary. Keep the
        # explicit field as well so the contract cannot be confused with the
        # independently reported requested window again.
        "fromMs": coverage_from_ms,
        "requestedFromMs": requested_from_ms,
        "coverageFromMs": coverage_from_ms,
        "untilMs": until_ms,
        "lookbackDays": days,
        "coverageDays": coverage_days,
        "cycle": cycle,
        "metric": DASHBOARD_VIEW_METRIC,
        "lastViewedByDashboardId": by_id,
        "notice": (
            "Dashboard activity is observed from the System User Interface dashboard-view "
            f"Top-N metric using appliance-selected {cycle} buckets. "
            f"{coverage_notice} "
            "Each bucket can retain up to 1,000 dashboard IDs; a recorded value is evidence "
            "of use, but no record is not proof of non-use."
        ),
    }
