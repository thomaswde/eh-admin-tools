#!/usr/bin/env python3
"""Create a minimal, allowlisted Packetstore diagnostic from API JSONL logs."""

import json
import math
import os
import re
import sys
from pathlib import Path

TS = ("est_lookback_sec", "input_load", "compress_load", "disk_write_load")
TOTAL = ("pkts", "pkts_dropped", "pkts_dropped_wrslow", "secrets", "secrets_dropped", "if_drops", "blocks_dropped")
KNOWN = frozenset(TS + TOTAL)
POST = re.compile(r"^(?:/api/v1)?/metrics(?:/totalbyobject)?/?$")
NEXT = re.compile(r"^(?:/api/v1)?/metrics/next/([0-9]+)/?$")
CYCLE = re.compile(r"^[0-9]{1,4}(?:sec|min|hr|day)$")
MAX_BYTES, MAX_LINE, MAX_ROWS = 64 << 20, 1 << 20, 100_000
MAX_QUERIES, MAX_NEXT, MAX_STATS = 2_000, 10_000, 10_000


class BadInput(RuntimeError):
    pass


def ident(v):
    v = "" if v is None or isinstance(v, bool) else str(v)
    return v if v.isdecimal() else None


def num(v):
    return v if not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v) else None


def nat(v):
    v = num(v)
    return int(v) if v is not None and v >= 0 else None


def endpoint(v):
    return str(v or "").split("?", 1)[0].rstrip("/") or "/"


class Aliases:
    def __init__(self) -> None:
        self.systems, self.objects, self.queries = {}, {}, {}

    @staticmethod
    def add(table, raw, prefix):
        if raw not in table:
            table[raw] = f"{prefix}-{len(table) + 1:03d}"
        return table[raw]

    def system(self, v):
        raw = ident(v)
        return self.add(self.systems, raw, "system") if raw else None

    def obj(self, v):
        raw = ident(v)
        if not raw:
            return None
        return self.systems.get(raw) or self.add(self.objects, raw, "metric-object")

    def query(self, v):
        raw = ident(v)
        return self.add(self.queries, raw, "query") if raw else None


def inputs(base):
    if not base.is_file():
        raise BadInput("The input JSONL file was not found.")
    old = []
    for p in base.parent.glob(f"{base.name}.*"):
        tail = p.name[len(base.name) + 1 :]
        if p.is_file() and tail.isdecimal() and 1 <= int(tail) <= 10:
            old.append((int(tail), p))
    return [p for _, p in sorted(old, reverse=True)] + [base]


def load(paths):
    if sum(p.stat().st_size for p in paths) > MAX_BYTES:
        raise BadInput("The API logs exceed the 64 MiB input limit.")
    rows = []
    info, lines = {"bad": 0, "large": 0, "other": 0}, 0
    for p in paths:
        with p.open("rb") as f:
            for raw in f:
                if not raw.strip():
                    continue
                lines += 1
                if lines > MAX_ROWS:
                    raise BadInput("The API logs exceed the source-entry limit.")
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


def packetstore(row):
    body = row.get("request_body")
    if str(row.get("method", "")).upper() != "POST" or not POST.fullmatch(endpoint(row.get("endpoint"))):
        return None
    if not isinstance(body, dict) or body.get("metric_category") != "cpc":
        return None
    specs = body.get("metric_specs")
    if not isinstance(specs, list):
        return None
    names = [x.get("name") for x in specs if isinstance(x, dict) and x.get("name") in KNOWN]
    skipped = len(specs) - len(names)
    return (body, names, skipped) if names else None


def xid(row):
    response = row.get("response")
    return ident(response.get("xid")) if isinstance(response, dict) else None


def value(v, depth=0):
    if depth == 6:
        return {"omitted_type": "depth_limit"}
    n = num(v)
    if n is not None:
        return n
    if v is None:
        return None
    if isinstance(v, list):
        out = [value(x, depth + 1) for x in v[:64]]
        if len(v) > 64:
            out.append({"omitted_type": "item_limit", "omitted_count": len(v) - 64})
        return out
    if isinstance(v, dict):
        out = {k: value(v[k], depth + 1) for k in ("value", "freq") if k in v}
        if len(v) > len(out):
            out["omitted_field_count"] = len(v) - len(out)
        return out or {"omitted_type": "object"}
    if isinstance(v, bool):
        return {"omitted_type": "boolean"}
    if isinstance(v, (int, float)):
        return {"omitted_type": "non_finite_number"}
    return {"omitted_type": type(v).__name__.lower()}


def relative(v, start):
    v = num(v)
    return v - start if v is not None and start is not None else None


def error(row):
    status = nat(row.get("status_code"))
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


def request(body, names, skipped, aliases):
    start, end = num(body.get("from")), num(body.get("until"))
    ids = body.get("object_ids") if isinstance(body.get("object_ids"), list) else []
    systems = [x for raw in ids if (x := aliases.system(raw))]
    return {
        "metric_category": "cpc",
        "object_type": "system" if body.get("object_type") == "system" else "unexpected_or_omitted",
        "cycle": str(body.get("cycle", "")).lower() if CYCLE.fullmatch(str(body.get("cycle", "")).lower()) else None,
        "window_duration_ms": end - start if start is not None and end is not None else None,
        "systems": systems,
        "system_identifier_count_omitted": len(ids) - len(systems),
        "metric_names_in_request_order": names,
        "unexpected_metric_spec_count_omitted": skipped,
    }, start


def metric_tuple(values, names):
    if not isinstance(values, list):
        return {"status": "non_array", "expected_count": len(names), "actual_count": None,
                "value": value(values), "missing_metric_names": names}
    actual, expected = len(values), len(names)
    out = {
        "status": "exact" if actual == expected else "short" if actual < expected else "long",
        "expected_count": expected,
        "actual_count": actual,
        "positions": [{"position": i, "metric": names[i], "value": value(values[i])} for i in range(min(actual, expected))],
    }
    if actual < expected:
        out["missing_metric_names"] = names[actual:]
    if actual > expected:
        out["unmapped_values"] = [value(x) for x in values[expected:]]
    return out


def response(row, names, start, aliases, budget):
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
        "cycle": cycle if CYCLE.fullmatch(cycle) else None,
        "from_offset_from_request_start_ms": relative(raw.get("from"), start),
        "until_offset_from_request_start_ms": relative(raw.get("until"), start),
        "clock_offset_from_request_start_ms": relative(raw.get("clock"), start),
        "system": aliases.system(raw.get("node_id")),
        "num_results": nat(raw.get("num_results")),
        "query": aliases.query(raw.get("xid")),
    })
    stats = raw.get("stats")
    if isinstance(stats, list):
        objects = [x for x in stats if isinstance(x, dict)]
        safe = []
        for stat in objects:
            if budget[0] == 0:
                budget[1] += 1
                continue
            safe.append({
                "metric_object": aliases.obj(stat.get("oid")),
                "time_offset_from_request_start_ms": relative(stat.get("time"), start),
                "duration_ms": num(stat.get("duration")),
                "tuple": metric_tuple(stat.get("values"), names),
            })
            budget[0] -= 1
        out["stats"] = safe
        out["non_object_stat_count_omitted"] = len(stats) - len(objects)
    return out


def attempt(row, names, start, aliases, budget):
    return {
        "status_code": nat(row.get("status_code")),
        "elapsed_ms": num(row.get("elapsed_ms")),
        "response_bytes": nat(row.get("response_bytes")),
        "error_category": error(row),
        "response": response(row, names, start, aliases, budget),
    }


def build(base):
    rows, info = load(inputs(base))
    selected, next_rows, post_at, no_body = [], {}, [], 0
    for pos, row in enumerate(rows):
        method, ep = str(row.get("method", "")).upper(), endpoint(row.get("endpoint"))
        if method == "POST" and POST.fullmatch(ep):
            post_at.append(pos)
            found = packetstore(row)
            if found:
                selected.append((pos, row, *found))
            elif not isinstance(row.get("request_body"), dict):
                no_body += 1
        elif method == "GET" and (match := NEXT.fullmatch(ep)):
            next_rows.setdefault(match.group(1), []).append((pos, row))

    dropped_queries = max(0, len(selected) - MAX_QUERIES)
    selected = selected[:MAX_QUERIES]
    aliases, budget = Aliases(), [MAX_STATS, 0]
    for _, _, body, _, _ in selected:
        for raw in body.get("object_ids", []) if isinstance(body.get("object_ids"), list) else []:
            aliases.system(raw)
    for _, row, _, _, _ in selected:
        aliases.query(xid(row))

    queries, matched, next_count, next_limit = [], set(), 0, False
    for number, (pos, row, body, names, skipped) in enumerate(selected, 1):
        req, start = request(body, names, skipped, aliases)
        raw_xid = xid(row)
        following = []
        if raw_xid:
            stop = next((x for x in post_at if x > pos), len(rows))
            hits = [(p, r) for p, r in next_rows.get(raw_xid, []) if pos < p < stop]
            matched.update(p for p, _ in hits)
            for p, nxt in hits:
                if next_count == MAX_NEXT:
                    next_limit = True
                    break
                following.append(attempt(nxt, names, start, aliases, budget))
                next_count += 1
        query_kind = "packetstore_probe" if names == [TS[0]] else (
            "packetstore_time_series" if names == list(TS) else
            "packetstore_totals" if names == list(TOTAL) else "packetstore_mixed_or_unexpected_order"
        )
        queries.append({"query_number": number, "kind": query_kind, "request": req,
                        "initial_attempt": attempt(row, names, start, aliases, budget), "continuations": following})

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
    if budget[1]:
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
            "stats_omitted_by_limit": budget[1], "warnings": warnings,
        },
        "queries": queries,
    }


def save(doc, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as e:
        raise BadInput("The requested output file already exists.") from e
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            json.dump(doc, f, ensure_ascii=True, indent=2, allow_nan=False)
            f.write("\n")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    except Exception:
        path.unlink(missing_ok=True)
        raise


def main() -> int:
    try:
        source = Path("api-responses.jsonl").resolve()
        target = next((source.parent / f"packetstore-diagnostics{'-' + str(n) if n > 1 else ''}.json"
                       for n in range(1, 10_000)
                       if not (source.parent / f"packetstore-diagnostics{'-' + str(n) if n > 1 else ''}.json").exists()), None)
        if target is None:
            raise BadInput("No unused diagnostic output filename is available.")
        doc = build(source)
        save(doc, target)
    except (BadInput, OSError) as e:
        print(f"Could not create the diagnostic: {e}", file=sys.stderr)
        return 2
    summary = doc["capture_summary"]
    print(f"Wrote {target.name}")
    print(f"Included {summary['packetstore_queries_included']} Packetstore queries and "
          f"{summary['correlated_continuations_included']} correlated continuations.")
    if summary["warnings"]:
        print("Warnings: " + ", ".join(summary["warnings"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
