#!/usr/bin/env python3
"""Create a minimal, allowlisted Packetstore diagnostic from API JSONL logs."""

import json
import math
import os
import re
import sys
from pathlib import Path

TIME_SERIES_METRICS = ("est_lookback_sec", "input_load", "compress_load", "disk_write_load")
TOTAL_METRICS = ("pkts", "pkts_dropped", "pkts_dropped_wrslow", "secrets", "secrets_dropped", "if_drops", "blocks_dropped")
KNOWN_METRICS = frozenset(TIME_SERIES_METRICS + TOTAL_METRICS)
METRICS_REQUEST_PATTERN = re.compile(r"^(?:/api/v1)?/metrics(?:/totalbyobject)?/?$")
METRICS_CONTINUATION_PATTERN = re.compile(r"^(?:/api/v1)?/metrics/next/([0-9]+)/?$")
METRIC_CYCLE_PATTERN = re.compile(r"^(?:auto|[0-9]{1,4}(?:sec|min|hr|day))$")
MAX_BYTES, MAX_LINE, MAX_ROWS = 64 << 20, 1 << 20, 100_000
MAX_QUERIES, MAX_NEXT, MAX_STATS = 2_000, 10_000, 10_000


class DiagnosticInputError(RuntimeError):
    pass


def decimal_identifier(raw_value):
    normalized = "" if raw_value is None or isinstance(raw_value, bool) else str(raw_value)
    return normalized if normalized.isdecimal() else None


def finite_number(raw_value):
    return raw_value if (
        not isinstance(raw_value, bool)
        and isinstance(raw_value, (int, float))
        and math.isfinite(raw_value)
    ) else None


def nonnegative_integer(raw_value):
    normalized = finite_number(raw_value)
    return int(normalized) if normalized is not None and normalized >= 0 else None


def normalize_endpoint_path(raw_value):
    return str(raw_value or "").split("?", 1)[0].rstrip("/") or "/"


class StatBudget:
    """Caps how many metric stat rows the whole document may emit."""

    def __init__(self, remaining) -> None:
        self.remaining = remaining
        self.omitted = 0

    def take(self) -> bool:
        """Claim one stat slot, or record an omission when the budget is spent."""
        if self.remaining == 0:
            self.omitted += 1
            return False
        self.remaining -= 1
        return True


class IdentifierAliases:
    def __init__(self) -> None:
        self.systems, self.objects, self.queries = {}, {}, {}

    @staticmethod
    def add_alias(table, raw, prefix):
        if raw not in table:
            table[raw] = f"{prefix}-{len(table) + 1:03d}"
        return table[raw]

    def system(self, raw_value):
        raw = decimal_identifier(raw_value)
        return self.add_alias(self.systems, raw, "system") if raw else None

    def metric_object(self, raw_value):
        raw = decimal_identifier(raw_value)
        if not raw:
            return None
        return self.systems.get(raw) or self.add_alias(self.objects, raw, "metric-object")

    def query_id(self, raw_value):
        raw = decimal_identifier(raw_value)
        return self.add_alias(self.queries, raw, "query") if raw else None


def discover_input_paths(base):
    if not base.is_file():
        raise DiagnosticInputError("The input JSONL file was not found.")
    old = []
    for p in base.parent.glob(f"{base.name}.*"):
        tail = p.name[len(base.name) + 1 :]
        if p.is_file() and tail.isdecimal() and 1 <= int(tail) <= 10:
            old.append((int(tail), p))
    return [p for _, p in sorted(old, reverse=True)] + [base]


def load_jsonl_rows(paths):
    if sum(p.stat().st_size for p in paths) > MAX_BYTES:
        raise DiagnosticInputError("The API logs exceed the 64 MiB input limit.")
    rows = []
    info, lines = {"bad": 0, "large": 0, "other": 0}, 0
    for p in paths:
        with p.open("rb") as f:
            for raw in f:
                if not raw.strip():
                    continue
                lines += 1
                if lines > MAX_ROWS:
                    raise DiagnosticInputError("The API logs exceed the source-entry limit.")
                if len(raw) > MAX_LINE:
                    info["large"] += 1
                    continue
                try:
                    row = json.loads(raw.decode())
                except (UnicodeDecodeError, json.JSONDecodeError):
                    info["bad"] += 1
                    continue
                if isinstance(row, dict):
                    rows.append(row)
                else:
                    info["other"] += 1
    return rows, info


def parse_packetstore_request(row):
    body = row.get("request_body")
    if (
        str(row.get("method", "")).upper() != "POST"
        or not METRICS_REQUEST_PATTERN.fullmatch(normalize_endpoint_path(row.get("endpoint")))
    ):
        return None
    if not isinstance(body, dict) or body.get("metric_category") != "cpc":
        return None
    specs = body.get("metric_specs")
    if not isinstance(specs, list):
        return None
    names = [x.get("name") for x in specs if isinstance(x, dict) and x.get("name") in KNOWN_METRICS]
    skipped = len(specs) - len(names)
    return (body, names, skipped) if names else None


def response_xid(row):
    response_body = row.get("response")
    return decimal_identifier(response_body.get("xid")) if isinstance(response_body, dict) else None


def sanitize_numeric_structure(raw_value, depth=0):
    if depth == 6:
        return {"omitted_type": "depth_limit"}
    normalized_number = finite_number(raw_value)
    if normalized_number is not None:
        return normalized_number
    if raw_value is None:
        return None
    if isinstance(raw_value, list):
        out = [sanitize_numeric_structure(item, depth + 1) for item in raw_value[:64]]
        if len(raw_value) > 64:
            out.append({"omitted_type": "item_limit", "omitted_count": len(raw_value) - 64})
        return out
    if isinstance(raw_value, dict):
        out = {
            key: sanitize_numeric_structure(raw_value[key], depth + 1)
            for key in ("value", "freq")
            if key in raw_value
        }
        if len(raw_value) > len(out):
            out["omitted_field_count"] = len(raw_value) - len(out)
        return out or {"omitted_type": "object"}
    if isinstance(raw_value, bool):
        return {"omitted_type": "boolean"}
    if isinstance(raw_value, (int, float)):
        return {"omitted_type": "non_finite_number"}
    return {"omitted_type": type(raw_value).__name__.lower()}


def relative_milliseconds(raw_value, start):
    normalized = finite_number(raw_value)
    return normalized - start if normalized is not None and start is not None else None


def classify_error(row):
    status = nonnegative_integer(row.get("status_code"))
    if status is None and "error" in row:
        return "network_error"
    if status is not None and 200 <= status < 300:
        return None
    text = json.dumps(row.get("response"), ensure_ascii=True, default=str).lower() if status == 400 else ""
    if "extrahop.system.cpc" in text and "invalid stat name" in text:
        return "unsupported_cpc_metric_category"
    if status in (401, 403):
        return "authorization_error"
    if status == 429:
        return "rate_limited"
    if status is not None and status >= 500:
        return "upstream_server_error"
    return "upstream_client_error" if status is not None and status >= 400 else "unknown_error"


def build_sanitized_request(body, names, skipped, aliases):
    start, end = finite_number(body.get("from")), finite_number(body.get("until"))
    ids = body.get("object_ids") if isinstance(body.get("object_ids"), list) else []
    systems = [x for raw in ids if (x := aliases.system(raw))]
    return {
        "metric_category": "cpc",
        "object_type": "system" if body.get("object_type") == "system" else "unexpected_or_omitted",
        "cycle": (
            str(body.get("cycle", "")).lower()
            if METRIC_CYCLE_PATTERN.fullmatch(str(body.get("cycle", "")).lower())
            else None
        ),
        "window_duration_ms": end - start if start is not None and end is not None else None,
        "systems": systems,
        "system_identifier_count_omitted": len(ids) - len(systems),
        "metric_names_in_request_order": names,
        "unexpected_metric_spec_count_omitted": skipped,
    }, start


def build_sanitized_metric_tuple(values, names):
    if not isinstance(values, list):
        return {"status": "non_array", "expected_count": len(names), "actual_count": None,
                "value": sanitize_numeric_structure(values), "missing_metric_names": names}
    actual, expected = len(values), len(names)
    out = {
        "status": "exact" if actual == expected else "short" if actual < expected else "long",
        "expected_count": expected,
        "actual_count": actual,
        "positions": [
            {"position": index, "metric": names[index], "value": sanitize_numeric_structure(values[index])}
            for index in range(min(actual, expected))
        ],
    }
    if actual < expected:
        out["missing_metric_names"] = names[actual:]
    if actual > expected:
        out["unmapped_values"] = [sanitize_numeric_structure(item) for item in values[expected:]]
    return out


def build_sanitized_response(row, names, start, aliases, budget):
    raw = row.get("response")
    state = "entry_truncated" if row.get("entry_truncated") is True else (
        "response_not_captured" if "response" not in row else
        "bounded_truncated" if isinstance(raw, dict) and (raw.get("truncated") or raw.get("[truncated]")) else
        "bounded_structured"
    )
    out = {"capture_state": state}
    if not isinstance(raw, dict):
        out["top_level_type"] = type(raw).__name__.lower() if "response" in row else "omitted"
        return out
    cycle = str(raw.get("cycle", "")).lower()
    out.update({
        "cycle": cycle if METRIC_CYCLE_PATTERN.fullmatch(cycle) else None,
        "from_offset_from_request_start_ms": relative_milliseconds(raw.get("from"), start),
        "until_offset_from_request_start_ms": relative_milliseconds(raw.get("until"), start),
        "clock_offset_from_request_start_ms": relative_milliseconds(raw.get("clock"), start),
        "system": aliases.system(raw.get("node_id")),
        "num_results": nonnegative_integer(raw.get("num_results")),
        "query": aliases.query_id(raw.get("xid")),
    })
    stats = raw.get("stats")
    if isinstance(stats, list):
        objects = [x for x in stats if isinstance(x, dict)]
        safe = []
        for stat in objects:
            if not budget.take():
                continue
            safe.append({
                "metric_object": aliases.metric_object(stat.get("oid")),
                "time_offset_from_request_start_ms": relative_milliseconds(stat.get("time"), start),
                "duration_ms": finite_number(stat.get("duration")),
                "tuple": build_sanitized_metric_tuple(stat.get("values"), names),
            })
        out["stats"] = safe
        out["non_object_stat_count_omitted"] = len(stats) - len(objects)
    return out


def build_sanitized_attempt(row, names, start, aliases, budget):
    return {
        "status_code": nonnegative_integer(row.get("status_code")),
        "elapsed_ms": finite_number(row.get("elapsed_ms")),
        "response_bytes": nonnegative_integer(row.get("response_bytes")),
        "error_category": classify_error(row),
        "response": build_sanitized_response(row, names, start, aliases, budget),
    }


def build_packetstore_diagnostic(base):
    rows, info = load_jsonl_rows(discover_input_paths(base))
    selected, next_rows, post_at, no_body = [], {}, [], 0
    for pos, row in enumerate(rows):
        method = str(row.get("method", "")).upper()
        endpoint_path = normalize_endpoint_path(row.get("endpoint"))
        if method == "POST" and METRICS_REQUEST_PATTERN.fullmatch(endpoint_path):
            post_at.append(pos)
            found = parse_packetstore_request(row)
            if found:
                selected.append((pos, row, *found))
            elif not isinstance(row.get("request_body"), dict):
                no_body += 1
        elif method == "GET" and (match := METRICS_CONTINUATION_PATTERN.fullmatch(endpoint_path)):
            next_rows.setdefault(match.group(1), []).append((pos, row))

    dropped_queries = max(0, len(selected) - MAX_QUERIES)
    selected = selected[:MAX_QUERIES]
    aliases, budget = IdentifierAliases(), StatBudget(MAX_STATS)
    for _, _, body, _, _ in selected:
        for raw in body.get("object_ids", []) if isinstance(body.get("object_ids"), list) else []:
            aliases.system(raw)
    for _, row, _, _, _ in selected:
        aliases.query_id(response_xid(row))

    queries, matched, next_count, next_limit = [], set(), 0, False
    for number, (pos, row, body, names, skipped) in enumerate(selected, 1):
        sanitized_request, start = build_sanitized_request(body, names, skipped, aliases)
        raw_xid = response_xid(row)
        following = []
        if raw_xid:
            stop = next((x for x in post_at if x > pos), len(rows))
            hits = [(p, r) for p, r in next_rows.get(raw_xid, []) if pos < p < stop]
            matched.update(p for p, _ in hits)
            for p, nxt in hits:
                if next_count == MAX_NEXT:
                    next_limit = True
                    break
                following.append(build_sanitized_attempt(nxt, names, start, aliases, budget))
                next_count += 1
        query_kind = "packetstore_probe" if names == [TIME_SERIES_METRICS[0]] else (
            "packetstore_time_series" if names == list(TIME_SERIES_METRICS) else
            "packetstore_totals" if names == list(TOTAL_METRICS) else "packetstore_mixed_or_unexpected_order"
        )
        queries.append({
            "query_number": number,
            "kind": query_kind,
            "request": sanitized_request,
            "initial_attempt": build_sanitized_attempt(row, names, start, aliases, budget),
            "continuations": following,
        })

    warnings = []
    if not queries:
        warnings.append("no_packetstore_requests_found")
    if no_body:
        warnings.append("metric_requests_without_full_request_bodies_were_omitted_enable_full_logging")
    if info["bad"] or info["large"] or info["other"]:
        warnings.append("invalid_or_oversized_source_lines_were_omitted")
    if dropped_queries:
        warnings.append("packetstore_query_limit_reached")
    if next_limit:
        warnings.append("continuation_limit_reached")
    if budget.omitted:
        warnings.append("stat_limit_reached")
    all_next = sum(len(x) for x in next_rows.values())
    return {
        "schema_version": "eh-packetstore-diagnostic-v1",
        "privacy": {
            "policy": "strict_allowlist_unknown_fields_omitted",
            "identifiers": "stable_aliases_scoped_to_this_file",
            "absolute_times": "omitted_offsets_only",
            "urls_hostnames_credentials_and_arbitrary_text": "omitted",
            "errors": "fixed_categories_only",
            "response_values": "numeric_structure_only",
        },
        "capture_summary": {
            "packetstore_queries_included": len(selected), "packetstore_queries_omitted_by_limit": dropped_queries,
            "correlated_continuations_included": next_count,
            "correlated_continuations_omitted_by_limit": max(0, len(matched) - next_count),
            "uncorrelated_metric_continuations_omitted": max(0, all_next - len(matched)),
            "stats_omitted_by_limit": budget.omitted, "warnings": warnings,
        },
        "queries": queries,
    }


def save_diagnostic(diagnostic, output_path):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as error:
        raise DiagnosticInputError("The requested output file already exists.") from error
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output_file:
            json.dump(diagnostic, output_file, ensure_ascii=True, indent=2, allow_nan=False)
            output_file.write("\n")
        try:
            os.chmod(output_path, 0o600)
        except OSError:
            pass
    except Exception:
        output_path.unlink(missing_ok=True)
        raise


def main() -> int:
    try:
        source = Path("api-responses.jsonl").resolve()
        target = next((source.parent / f"packetstore-diagnostics{'-' + str(n) if n > 1 else ''}.json"
                       for n in range(1, 10_000)
                       if not (source.parent / f"packetstore-diagnostics{'-' + str(n) if n > 1 else ''}.json").exists()), None)
        if target is None:
            raise DiagnosticInputError("No unused diagnostic output filename is available.")
        diagnostic = build_packetstore_diagnostic(source)
        save_diagnostic(diagnostic, target)
    except (DiagnosticInputError, OSError) as error:
        print(f"Could not create the diagnostic: {error}", file=sys.stderr)
        return 2
    summary = diagnostic["capture_summary"]
    print(f"Wrote {target.name}")
    print(f"Included {summary['packetstore_queries_included']} Packetstore queries and "
          f"{summary['correlated_continuations_included']} correlated continuations.")
    if summary["warnings"]:
        print("Warnings: " + ", ".join(summary["warnings"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
