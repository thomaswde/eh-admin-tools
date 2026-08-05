import json
import stat
from pathlib import Path

from scripts import sanitize_packetstore_log as s


def put(path: Path, rows: list[object]) -> None:
    path.write_text("".join(json.dumps(x) + "\n" for x in rows), encoding="utf-8")


def query(endpoint="/api/v1/metrics/totalbyobject", response=None, **changes):
    row = {
        "timestamp": "2026-08-04T22:01:02+00:00",
        "method": "POST", "endpoint": endpoint, "url": "https://redacted.invalid/api/v1/metrics?token=****",
        "status_code": 200, "reason": "redacted", "elapsed_ms": 12.5,
        "content_type": "application/json", "response_bytes": 900,
        "request_body": {
            "cycle": "1hr", "from": 1_700_000_000_000, "until": 1_700_003_600_000,
            "object_type": "system", "object_ids": ["9007199254740993"], "metric_category": "cpc",
            "metric_specs": [{"name": x} for x in s.TOTAL], "extra": "****",
        },
        "response": response or {
            "cycle": "1hr", "from": 1_700_000_000_000, "until": 1_700_003_600_000,
            "clock": 1_700_003_600_500, "node_id": "9007199254740993", "num_results": 1,
            "stats": [{"oid": "9007199254740993", "time": 1_700_003_600_000,
                       "duration": 3_600_000, "values": [0, 0, 0, 0, 0, 6_849_985_555, 0], "extra": "****"}],
            "hostname": "redacted",
        },
    }
    row.update(changes)
    return row


def test_allowlist_keeps_tuple_mapping_and_omits_other_text(tmp_path):
    path = tmp_path / "api-responses.jsonl"
    put(path, [{"method": "GET", "endpoint": "/api/v1/appliances", "response": [{"name": "****"}]}, query()])
    doc = s.build(path)
    text = json.dumps(doc)
    q = doc["queries"][0]
    assert q["kind"] == "packetstore_totals"
    assert q["request"]["systems"] == ["system-001"]
    assert q["request"]["window_duration_ms"] == 3_600_000
    r = q["initial_attempt"]["response"]
    assert r["system"] == "system-001"
    assert r["clock_offset_from_request_start_ms"] == 3_600_500
    assert r["stats"][0]["tuple"]["positions"][5] == {"position": 5, "metric": "if_drops", "value": 6_849_985_555}
    for omitted in ("redacted.invalid", "****", "9007199254740993", "1700000000000"):
        assert omitted not in text


def test_correlates_continuation_and_reports_short_tuple(tmp_path):
    path = tmp_path / "api-responses.jsonl"
    first = query("/api/v1/metrics", {"xid": "77"})
    first["request_body"]["metric_specs"] = [{"name": x} for x in s.TS]
    nxt = {"method": "GET", "endpoint": "/api/v1/metrics/next/77", "status_code": 200,
           "response": {"node_id": "9007199254740993", "stats": [{"oid": "9007199254740993",
           "time": 1_700_000_030_000, "duration": 30_000, "values": [10, 20, 30]}]}}
    put(path, [first, {**nxt, "endpoint": "/api/v1/metrics/next/88"}, nxt])
    doc = s.build(path)
    q = doc["queries"][0]
    assert q["initial_attempt"]["response"]["query"] == "query-001"
    assert len(q["continuations"]) == 1
    data = q["continuations"][0]["response"]["stats"][0]["tuple"]
    assert data["status"] == "short"
    assert data["missing_metric_names"] == ["disk_write_load"]
    assert doc["capture_summary"]["uncorrelated_metric_continuations_omitted"] == 1


def test_new_metrics_post_stops_reused_xid_correlation(tmp_path):
    path = tmp_path / "api-responses.jsonl"
    first = query("/api/v1/metrics", {"xid": "77"})
    first["request_body"]["metric_specs"] = [{"name": x} for x in s.TS]
    other = query("/api/v1/metrics", {"xid": "77"})
    other["request_body"].update(metric_category="capture", metric_specs=[{"name": "bytes"}])
    nxt = {"method": "GET", "endpoint": "/api/v1/metrics/next/77", "status_code": 200,
           "response": {"stats": [{"oid": "1", "time": 1, "duration": 1, "values": [999]}]}}
    put(path, [first, other, nxt])
    doc = s.build(path)
    assert doc["queries"][0]["continuations"] == []
    assert doc["capture_summary"]["uncorrelated_metric_continuations_omitted"] == 1


def test_error_text_is_replaced_with_category(tmp_path):
    path = tmp_path / "api-responses.jsonl"
    put(path, [query(status_code=400, response={"error_message": "invalid stat name 'extrahop.system.cpc': ****"})])
    doc = s.build(path)
    text = json.dumps(doc)
    assert doc["queries"][0]["initial_attempt"]["error_category"] == "unsupported_cpc_metric_category"
    assert "****" not in text
    assert "invalid stat name" not in text


def test_metadata_mode_is_flagged(tmp_path):
    path = tmp_path / "api-responses.jsonl"
    put(path, [{"method": "POST", "endpoint": "/api/v1/metrics", "status_code": 200, "response_shape": {"xid": "integer"}}])
    doc = s.build(path)
    assert doc["queries"] == []
    assert doc["capture_summary"]["warnings"] == [
        "no_packetstore_requests_found",
        "metric_requests_without_full_request_bodies_were_omitted_enable_full_logging",
    ]


def test_rotations_are_oldest_first_and_output_is_owner_only(tmp_path):
    path = tmp_path / "api-responses.jsonl"
    put(path.with_name(path.name + ".2"), [query(elapsed_ms=2)])
    put(path.with_name(path.name + ".1"), [query(elapsed_ms=1)])
    put(path, [query(elapsed_ms=0)])
    doc = s.build(path)
    out = tmp_path / "diagnostic.json"
    s.save(doc, out)
    assert [q["initial_attempt"]["elapsed_ms"] for q in doc["queries"]] == [2, 1, 0]
    assert stat.S_IMODE(out.stat().st_mode) == 0o600
