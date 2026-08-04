import asyncio
import ipaddress
import struct
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import main
from backend.extrahop_client import ExtraHopApiError, ExtraHopDownload
from backend.pcap_analyzer import AnalyzerLimits
from backend.pcap_analyzer.jobs import PcapJobError, PcapJobManager, PcapJobSettings
from backend.session_store import SessionStore


def tcp_packet(*, reverse=False, payload=b"hello"):
    source = "198.51.100.2" if reverse else "192.0.2.1"
    destination = "192.0.2.1" if reverse else "198.51.100.2"
    source_port = 443 if reverse else 12345
    destination_port = 12345 if reverse else 443
    offset_flags = (5 << 12) | 0x10
    tcp = struct.pack("!HHIIHHHH", source_port, destination_port, 100, 0, offset_flags, 8192, 0, 0) + payload
    ip = struct.pack(
        "!BBHHHBBH4s4s",
        0x45,
        0,
        20 + len(tcp),
        1,
        0,
        64,
        6,
        0,
        ipaddress.ip_address(source).packed,
        ipaddress.ip_address(destination).packed,
    )
    return b"\0" * 12 + struct.pack("!H", 0x0800) + ip + tcp


def pcap_bytes(records):
    output = bytearray(b"\xd4\xc3\xb2\xa1" + struct.pack("<HHiiii", 2, 4, 0, 0, 65535, 1))
    for index, packet in enumerate(records, 1):
        output.extend(struct.pack("<IIII", index, 0, len(packet), len(packet)))
        output.extend(packet)
    return bytes(output)


async def chunks(*values):
    for value in values:
        yield value


def settings(**changes):
    values = {
        "max_upload_bytes": 4096,
        "upstream_window_limit": "1KB",
        "max_window_bytes": 4096,
        "max_total_collection_bytes": 8192,
        "min_window_seconds": 1,
        "max_window_seconds": 60,
        "default_window_seconds": 30,
        "max_windows": 4,
        "max_interval_ms": 120_000,
        "operation_deadline_seconds": 5,
        "retention_seconds": 60,
        "max_jobs": 4,
        "max_concurrent_jobs": 1,
        "max_result_page": 20,
        "analyzer_limits": AnalyzerLimits(max_packets=100, max_flows=20, max_findings=20),
    }
    values.update(changes)
    return PcapJobSettings(**values)


class DownloadClient:
    def __init__(self, capture, deployment="enterprise", error=None):
        self.capture = capture
        self.metadata = SimpleNamespace(type=deployment)
        self.error = error
        self.calls = []

    async def download_to_file(self, method, endpoint, **kwargs):
        self.calls.append((method, endpoint, kwargs))
        if self.error:
            raise self.error
        destination = kwargs["destination"]
        destination.write_bytes(self.capture)
        return ExtraHopDownload(200, "application/vnd.tcpdump.pcap", len(self.capture))


def test_upload_job_is_session_bound_and_produces_results_and_csv(tmp_path):
    asyncio.run(_test_upload_job_is_session_bound_and_produces_results_and_csv(tmp_path))


async def _test_upload_job_is_session_bound_and_produces_results_and_csv(tmp_path):
    manager = PcapJobManager(tmp_path / ".runtime" / "pcap", settings=settings())
    await manager.startup()
    capture = pcap_bytes([tcp_packet()])
    try:
        created = await manager.create_upload("owner", chunks(capture[:20], capture[20:]), declared_length=len(capture))
        job = manager._jobs[created["id"]]
        await job.task

        snapshot = manager.get("owner", job.id)
        assert snapshot["state"] == "completed"
        assert snapshot["completeness"] == "complete"
        assert snapshot["summary"]["tcpPackets"] == 1
        result = manager.results("owner", job.id, offset=0, limit=10, finding="reverse_not_observed")
        assert result["total"] == 1
        assert result["items"][0]["findingKinds"] == ["reverse_not_observed"]
        filename, lines = manager.csv_rows("owner", job.id)
        assert filename == f"datafeed-analysis-{job.id[:12]}.csv"
        assert "sourceAddress" in "".join(lines)
        with pytest.raises(PcapJobError) as denied:
            manager.get("different-owner", job.id)
        assert denied.value.status_code == 404
        assert not job.temp_dir.exists()
    finally:
        await manager.shutdown()


def test_upload_enforces_declared_and_streamed_byte_limits(tmp_path):
    asyncio.run(_test_upload_enforces_declared_and_streamed_byte_limits(tmp_path))


async def _test_upload_enforces_declared_and_streamed_byte_limits(tmp_path):
    manager = PcapJobManager(tmp_path / ".runtime" / "pcap", settings=settings(max_upload_bytes=16))
    await manager.startup()
    try:
        with pytest.raises(PcapJobError) as declared:
            await manager.create_upload("owner", chunks(b"small"), declared_length=17)
        assert declared.value.status_code == 413

        with pytest.raises(PcapJobError) as streamed:
            await manager.create_upload("owner", chunks(b"a" * 10, b"b" * 10), declared_length=None)
        assert streamed.value.status_code == 413
        assert not manager._jobs
    finally:
        await manager.shutdown()


def test_window_plan_is_half_open_and_has_no_extra_exact_boundary(tmp_path):
    manager = PcapJobManager(tmp_path / ".runtime" / "pcap", settings=settings())
    assert manager._plan_windows(1_000, 61_000, 30) == [(1_000, 30_999), (31_000, 60_999)]


def test_window_plan_rejects_zero_instead_of_treating_it_as_default(tmp_path):
    manager = PcapJobManager(tmp_path / ".runtime" / "pcap", settings=settings())
    with pytest.raises(PcapJobError) as error:
        manager._plan_windows(1_000, 31_000, 0)
    assert error.value.status_code == 422


@pytest.mark.parametrize("deployment", ["enterprise", "360"])
def test_dynamic_collection_uses_same_documented_post_contract_for_both_deployments(tmp_path, deployment):
    asyncio.run(_test_dynamic_collection_uses_same_documented_post_contract_for_both_deployments(tmp_path, deployment))


async def _test_dynamic_collection_uses_same_documented_post_contract_for_both_deployments(tmp_path, deployment):
    manager = PcapJobManager(tmp_path / ".runtime" / deployment / "pcap", settings=settings())
    await manager.startup()
    client = DownloadClient(pcap_bytes([tcp_packet(), tcp_packet(reverse=True)]), deployment=deployment)
    try:
        created = await manager.create_collection(
            "owner",
            client,
            from_ms=1_000,
            until_ms=31_000,
            window_seconds=30,
        )
        job = manager._jobs[created["id"]]
        await job.task

        snapshot = manager.get("owner", job.id)
        assert snapshot["state"] == "completed"
        assert snapshot["completeness"] == "indeterminate"
        assert snapshot["summary"]["reverseNotObservedFlows"] == 0
        assert client.calls[0][0:2] == ("POST", "/api/v1/packets/search")
        body = client.calls[0][2]["json_body"]
        assert body["from"] == "1000"
        assert body["until"] == "30999"
        assert body["output"] == "pcap"
        assert body["always_return_body"] is False
        assert snapshot["warnings"] == []
    finally:
        await manager.shutdown()


def test_dynamic_422_reports_missing_packetstore_without_speculative_probe(tmp_path):
    asyncio.run(_test_dynamic_422_reports_missing_packetstore_without_speculative_probe(tmp_path))


async def _test_dynamic_422_reports_missing_packetstore_without_speculative_probe(tmp_path):
    manager = PcapJobManager(tmp_path / ".runtime" / "pcap", settings=settings())
    await manager.startup()
    client = DownloadClient(
        b"",
        error=ExtraHopApiError("no packets available", 422, {"response": "No Packetstore"}),
    )
    try:
        created = await manager.create_collection(
            "owner",
            client,
            from_ms=1_000,
            until_ms=31_000,
            window_seconds=30,
        )
        job = manager._jobs[created["id"]]
        await job.task
        snapshot = manager.get("owner", job.id)
        assert snapshot["state"] == "failed"
        assert "Packetstore" in snapshot["error"]["message"]
        assert snapshot["collection"]["failedWindows"] == 1
    finally:
        await manager.shutdown()


def test_csv_neutralizes_formula_prefixed_text(tmp_path):
    manager = PcapJobManager(tmp_path / ".runtime" / "pcap", settings=settings())
    job = SimpleNamespace(state="completed", rows=[{"sourceAddress": "=cmd", "findingKinds": []}], id="job-id")
    manager._owned_job = lambda owner, job_id: job
    _, lines = manager.csv_rows("owner", "job-id")
    assert "'=cmd" in "".join(lines)


def test_routes_require_an_active_session_for_upload():
    original_sessions = main.sessions
    main.sessions = SessionStore(ttl_seconds=60, max_sessions=2)
    try:
        with TestClient(main.app, base_url="http://127.0.0.1") as client:
            response = client.post(
                "/backend/pcap-analyzer/upload",
                content=pcap_bytes([tcp_packet()]),
                headers={"content-type": "application/vnd.tcpdump.pcap"},
            )
        assert response.status_code == 401
    finally:
        main.sessions = original_sessions


def test_upload_route_runs_job_and_exposes_bounded_results_and_csv():
    original_sessions = main.sessions
    main.sessions = SessionStore(ttl_seconds=60, max_sessions=2)
    try:
        with TestClient(main.app, base_url="http://127.0.0.1") as client:
            session_id = main.sessions.create(object())
            client.cookies.set(main.SESSION_COOKIE, session_id)
            response = client.post(
                "/backend/pcap-analyzer/upload",
                content=pcap_bytes([tcp_packet()]),
                headers={"content-type": "application/vnd.tcpdump.pcap"},
            )
            assert response.status_code == 202
            job_id = response.json()["id"]

            for _ in range(100):
                status = client.get(f"/backend/pcap-analyzer/jobs/{job_id}")
                assert status.status_code == 200
                if status.json()["state"] in {"completed", "failed", "cancelled"}:
                    break
                time.sleep(0.01)

            assert status.json()["state"] == "completed"
            results = client.get(f"/backend/pcap-analyzer/jobs/{job_id}/results?limit=1")
            assert results.status_code == 200
            assert results.json()["total"] == 1
            exported = client.get(f"/backend/pcap-analyzer/jobs/{job_id}/csv")
            assert exported.status_code == 200
            assert exported.headers["content-type"].startswith("text/csv")
            assert "192.0.2.1" in exported.text
    finally:
        main.sessions = original_sessions
