import asyncio
import ipaddress
import json
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
        self.search_calls = []

    async def download_to_file(self, method, endpoint, **kwargs):
        self.calls.append((method, endpoint, kwargs))
        if self.error:
            raise self.error
        destination = kwargs["destination"]
        destination.write_bytes(self.capture)
        return ExtraHopDownload(200, "application/vnd.tcpdump.pcap", len(self.capture))

    async def request(self, method, endpoint, **kwargs):
        self.search_calls.append((method, endpoint, kwargs))
        return []


class SearchClient(DownloadClient):
    def __init__(self, capture, responses, deployment="enterprise"):
        super().__init__(capture, deployment=deployment)
        self.responses = list(responses)

    async def request(self, method, endpoint, **kwargs):
        self.search_calls.append((method, endpoint, kwargs))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def test_upload_job_is_session_bound_and_produces_results_and_csv(tmp_path):
    asyncio.run(_test_upload_job_is_session_bound_and_produces_results_and_csv(tmp_path))


async def _test_upload_job_is_session_bound_and_produces_results_and_csv(tmp_path):
    manager = PcapJobManager(tmp_path / ".runtime" / "pcap", settings=settings())
    await manager.startup()
    capture = pcap_bytes([tcp_packet()])
    try:
        created = await manager.create_upload(
            "owner",
            DownloadClient(b""),
            chunks(capture[:20], capture[20:]),
            declared_length=len(capture),
        )
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
        assert filename == f"datafeed-analysis-all-findings-{job.id[:12]}.csv"
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
            await manager.create_upload("owner", DownloadClient(b""), chunks(b"small"), declared_length=17)
        assert declared.value.status_code == 413

        with pytest.raises(PcapJobError) as streamed:
            await manager.create_upload(
                "owner",
                DownloadClient(b""),
                chunks(b"a" * 10, b"b" * 10),
                declared_length=None,
            )
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


@pytest.mark.parametrize("deployment", ["enterprise", "360"])
def test_device_enrichment_uses_exact_or_filters_and_preserves_opaque_ids(tmp_path, deployment):
    asyncio.run(_test_device_enrichment_uses_exact_or_filters_and_preserves_opaque_ids(tmp_path, deployment))


async def _test_device_enrichment_uses_exact_or_filters_and_preserves_opaque_ids(tmp_path, deployment):
    manager = PcapJobManager(tmp_path / ".runtime" / deployment / "pcap", settings=settings())
    await manager.startup()
    client = SearchClient(
        pcap_bytes([tcp_packet()]),
        [
            [
                {
                    "id": 9223372036854775806,
                    "node_id": 9223372036854775805,
                    "display_name": "web-prod-07",
                    "default_name": "192.0.2.1",
                    "ipaddr4": "192.0.2.1",
                    "ipaddr6": None,
                }
            ]
        ],
        deployment=deployment,
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
        assert snapshot["state"] == "completed"
        assert snapshot["progress"] == {"stage": "completed", "percent": 100}
        assert snapshot["enrichment"]["status"] == "complete"
        assert snapshot["enrichment"]["addressesMatched"] == 1
        row = snapshot["dashboard"]["topReverse"][0]
        assert row["sourceAddress"] == "192.0.2.1"
        assert row["sourceDevice"] == {
            "displayName": "web-prod-07",
            "matchStatus": "unique",
            "matchCount": 1,
            "deviceId": "9223372036854775806",
            "nodeId": "9223372036854775805",
        }

        method, endpoint, kwargs = client.search_calls[0]
        assert (method, endpoint) == ("POST", "/api/v1/devices/search")
        payload = json.loads(kwargs["body"])
        assert payload["active_from"] == 1_000
        assert payload["active_until"] == 31_000
        assert payload["result_fields"] == [
            "id",
            "node_id",
            "display_name",
            "default_name",
            "ipaddr4",
            "ipaddr6",
        ]
        assert payload["filter"]["operator"] == "or"
        assert {rule["operand"] for rule in payload["filter"]["rules"]} == {
            "192.0.2.1",
            "198.51.100.2",
        }
        assert all(rule["field"] == "ipaddr" and rule["operator"] == "=" for rule in payload["filter"]["rules"])
    finally:
        await manager.shutdown()


def test_upload_enrichment_uses_capture_bounds_and_conflicting_names_are_ambiguous(tmp_path):
    asyncio.run(_test_upload_enrichment_uses_capture_bounds_and_conflicting_names_are_ambiguous(tmp_path))


async def _test_upload_enrichment_uses_capture_bounds_and_conflicting_names_are_ambiguous(tmp_path):
    manager = PcapJobManager(tmp_path / ".runtime" / "pcap", settings=settings())
    await manager.startup()
    capture = pcap_bytes([tcp_packet()])
    client = SearchClient(
        b"",
        [
            [
                {"id": "1", "display_name": "web-a", "ipaddr4": "192.0.2.1"},
                {"id": "2", "display_name": "web-b", "ipaddr4": "192.0.2.1"},
            ]
        ],
    )
    try:
        created = await manager.create_upload("owner", client, chunks(capture), declared_length=len(capture))
        job = manager._jobs[created["id"]]
        await job.task

        snapshot = manager.get("owner", job.id)
        payload = json.loads(client.search_calls[0][2]["body"])
        assert payload["active_from"] == 1_000
        assert payload["active_until"] == 1_001
        assert snapshot["state"] == "completed"
        assert snapshot["enrichment"]["addressesAmbiguous"] == 1
        source = snapshot["dashboard"]["topReverse"][0]["sourceDevice"]
        assert source == {"matchStatus": "ambiguous", "matchCount": 2}
    finally:
        await manager.shutdown()


def test_later_enrichment_page_failure_retains_partial_decorations(tmp_path):
    asyncio.run(_test_later_enrichment_page_failure_retains_partial_decorations(tmp_path))


async def _test_later_enrichment_page_failure_retains_partial_decorations(tmp_path):
    manager = PcapJobManager(
        tmp_path / ".runtime" / "pcap",
        settings=settings(enrichment_page_size=1),
    )
    await manager.startup()
    capture = pcap_bytes([tcp_packet()])
    client = SearchClient(
        b"",
        [
            [{"id": "1", "display_name": "web-a", "ipaddr4": "192.0.2.1"}],
            ExtraHopApiError("rate limited", 429),
        ],
    )
    try:
        created = await manager.create_upload("owner", client, chunks(capture), declared_length=len(capture))
        job = manager._jobs[created["id"]]
        await job.task
        snapshot = manager.get("owner", job.id)

        assert snapshot["state"] == "completed"
        assert snapshot["enrichment"]["status"] == "partial"
        assert snapshot["dashboard"]["topReverse"][0]["sourceDevice"]["displayName"] == "web-a"
        assert len(client.search_calls) == 2
    finally:
        await manager.shutdown()


def test_initial_enrichment_failure_does_not_fail_analysis(tmp_path):
    asyncio.run(_test_initial_enrichment_failure_does_not_fail_analysis(tmp_path))


async def _test_initial_enrichment_failure_does_not_fail_analysis(tmp_path):
    manager = PcapJobManager(tmp_path / ".runtime" / "pcap", settings=settings())
    await manager.startup()
    capture = pcap_bytes([tcp_packet()])
    client = SearchClient(b"", [ExtraHopApiError("forbidden", 403)])
    try:
        created = await manager.create_upload("owner", client, chunks(capture), declared_length=len(capture))
        job = manager._jobs[created["id"]]
        await job.task
        snapshot = manager.get("owner", job.id)

        assert snapshot["state"] == "completed"
        assert snapshot["completeness"] == "complete"
        assert snapshot["enrichment"]["status"] == "unavailable"
        assert snapshot["dashboard"]["findingCounts"]["affectedFlows"] == 1
    finally:
        await manager.shutdown()


def test_dashboard_uses_full_result_and_limits_top_rankings_to_25(tmp_path):
    asyncio.run(_test_dashboard_uses_full_result_and_limits_top_rankings_to_25(tmp_path))


async def _test_dashboard_uses_full_result_and_limits_top_rankings_to_25(tmp_path):
    packets = []
    for source_port in range(10_000, 10_030):
        packet = bytearray(tcp_packet())
        packet[34:36] = struct.pack("!H", source_port)
        packets.append(bytes(packet))
    capture = pcap_bytes(packets)
    manager = PcapJobManager(
        tmp_path / ".runtime" / "pcap",
        settings=settings(
            analyzer_limits=AnalyzerLimits(max_packets=100, max_flows=40, max_findings=100),
        ),
    )
    await manager.startup()
    try:
        created = await manager.create_upload(
            "owner",
            DownloadClient(b""),
            chunks(capture),
            declared_length=len(capture),
        )
        job = manager._jobs[created["id"]]
        await job.task
        snapshot = manager.get("owner", job.id)

        assert snapshot["dashboard"]["findingCounts"]["affectedFlows"] == 30
        assert snapshot["dashboard"]["findingCounts"]["reverseNotObservedFlows"] == 30
        assert len(snapshot["dashboard"]["topReverse"]) == 25
        assert [row["sourcePort"] for row in snapshot["dashboard"]["topReverse"][:3]] == [10_000, 10_001, 10_002]
    finally:
        await manager.shutdown()


def test_enrichment_candidate_limit_prioritizes_dashboard_rows_and_reports_omissions(tmp_path):
    manager = PcapJobManager(
        tmp_path / ".runtime" / "pcap",
        settings=settings(max_enrichment_addresses=2),
    )
    rows = [
        {
            "sourceAddress": "192.0.2.10",
            "destinationAddress": "198.51.100.10",
            "packetCount": 50,
            "capturedBytes": 500,
            "flowKey": "high",
            "findingKinds": ["reverse_not_observed"],
        },
        {
            "sourceAddress": "192.0.2.20",
            "destinationAddress": "198.51.100.20",
            "packetCount": 1,
            "capturedBytes": 10,
            "flowKey": "low",
            "findingKinds": ["reverse_not_observed"],
        },
        {
            "sourceAddress": "192.0.2.30",
            "destinationAddress": "198.51.100.30",
            "packetCount": 100,
            "capturedBytes": 1_000,
            "flowKey": "healthy",
            "findingKinds": [],
        },
    ]

    candidates, total = manager._candidate_addresses(rows)
    assert candidates == ["192.0.2.10", "198.51.100.10"]
    assert total == 4


def test_device_match_resolution_handles_common_and_non_enriching_names(tmp_path):
    manager = PcapJobManager(tmp_path / ".runtime" / "pcap", settings=settings())

    common = manager._resolve_device_match(
        "192.0.2.10",
        [
            {"id": "1", "display_name": "Web Prod", "ipaddr4": "192.0.2.10"},
            {"id": "2", "display_name": " web   prod ", "ipaddr4": "192.0.2.10"},
        ],
    )
    ip_shaped = manager._resolve_device_match(
        "192.0.2.10",
        [{"id": "1", "display_name": "192.0.2.10", "ipaddr4": "192.0.2.10"}],
    )

    assert common == {
        "displayName": "Web Prod",
        "matchStatus": "common",
        "matchCount": 2,
    }
    assert ip_shaped is None


def test_cancel_owner_discards_completed_job_metadata(tmp_path):
    asyncio.run(_test_cancel_owner_discards_completed_job_metadata(tmp_path))


async def _test_cancel_owner_discards_completed_job_metadata(tmp_path):
    manager = PcapJobManager(tmp_path / ".runtime" / "pcap", settings=settings())
    await manager.startup()
    capture = pcap_bytes([tcp_packet()])
    try:
        created = await manager.create_upload(
            "owner",
            DownloadClient(b""),
            chunks(capture),
            declared_length=len(capture),
        )
        job = manager._jobs[created["id"]]
        await job.task
        assert job.id in manager._jobs

        await manager.cancel_owner("owner")
        assert job.id not in manager._jobs
        with pytest.raises(PcapJobError, match="not found"):
            manager.get("owner", job.id)
    finally:
        await manager.shutdown()


def test_disconnect_cancels_only_connection_bound_jobs(tmp_path):
    asyncio.run(_test_disconnect_cancels_only_connection_bound_jobs(tmp_path))


async def _test_disconnect_cancels_only_connection_bound_jobs(tmp_path):
    manager = PcapJobManager(tmp_path / ".runtime" / "pcap", settings=settings())
    await manager.startup()
    try:
        local_job = await manager._new_job("owner", "upload")
        connected_job = await manager._new_job("owner", "extrahop")
        local_job.task = asyncio.create_task(asyncio.sleep(60))
        connected_job.task = asyncio.create_task(asyncio.sleep(60))

        await manager.cancel_owner_collections("owner")

        assert not local_job.cancel_event.is_set()
        assert local_job.task is not None and not local_job.task.done()
        assert connected_job.cancel_event.is_set()
        assert connected_job.task is not None and connected_job.task.cancelled()
        assert local_job.id in manager._jobs
        assert connected_job.id in manager._jobs
    finally:
        await manager.shutdown()


def test_session_removal_callback_discards_owned_job_metadata(tmp_path):
    asyncio.run(_test_session_removal_callback_discards_owned_job_metadata(tmp_path))


async def _test_session_removal_callback_discards_owned_job_metadata(tmp_path):
    manager = PcapJobManager(tmp_path / ".runtime" / "pcap", settings=settings())
    store = SessionStore(ttl_seconds=60, max_sessions=2, remove_callback=manager.cancel_owner)
    await manager.startup()
    capture = pcap_bytes([tcp_packet()])
    try:
        session_id = await store.acreate(DownloadClient(b""))
        created = await manager.create_upload(
            session_id,
            store.get(session_id),
            chunks(capture),
            declared_length=len(capture),
        )
        job = manager._jobs[created["id"]]
        await job.task

        await store.adelete(session_id)

        assert job.id not in manager._jobs
    finally:
        await store.aclose()
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
    job = SimpleNamespace(
        state="completed",
        rows=[{"sourceAddress": "=cmd", "findingKinds": ["reverse_not_observed"]}],
        id="job-id",
    )
    manager._owned_job = lambda owner, job_id: job
    _, lines = manager.csv_rows("owner", "job-id")
    assert "'=cmd" in "".join(lines)


def test_scoped_csv_excludes_healthy_rows_and_preserves_multi_finding_rows(tmp_path):
    manager = PcapJobManager(tmp_path / ".runtime" / "pcap", settings=settings())
    rows = [
        {"sourceAddress": "healthy", "findingKinds": []},
        {
            "sourceAddress": "192.0.2.1",
            "destinationAddress": "198.51.100.2",
            "findingKinds": ["reverse_not_observed"],
            "sourceDevice": {"displayName": "=formula", "matchStatus": "unique"},
        },
        {
            "sourceAddress": "192.0.2.2",
            "destinationAddress": "198.51.100.3",
            "findingKinds": ["sequence_gap"],
        },
        {
            "sourceAddress": "192.0.2.3",
            "destinationAddress": "198.51.100.4",
            "findingKinds": ["reverse_not_observed", "sequence_gap"],
        },
    ]
    job = SimpleNamespace(state="completed", rows=rows, id="job-id")
    manager._owned_job = lambda owner, job_id: job

    filename, all_lines = manager.csv_rows("owner", "job-id")
    all_csv = "".join(all_lines)
    assert filename == "datafeed-analysis-all-findings-job-id.csv"
    assert "healthy" not in all_csv
    assert all_csv.count("192.0.2.") == 3
    assert "'=formula" in all_csv

    reverse_filename, reverse_lines = manager.csv_rows("owner", "job-id", scope="reverse_not_observed")
    reverse_csv = "".join(reverse_lines)
    assert reverse_filename == "datafeed-analysis-reverse-direction-job-id.csv"
    assert "192.0.2.1" in reverse_csv and "192.0.2.3" in reverse_csv
    assert "192.0.2.2" not in reverse_csv

    sequence_filename, sequence_lines = manager.csv_rows("owner", "job-id", scope="sequence_gap")
    sequence_csv = "".join(sequence_lines)
    assert sequence_filename == "datafeed-analysis-sequence-gaps-job-id.csv"
    assert "192.0.2.2" in sequence_csv and "192.0.2.3" in sequence_csv
    assert "192.0.2.1" not in sequence_csv


def test_unfiltered_paged_results_exclude_healthy_rows(tmp_path):
    manager = PcapJobManager(tmp_path / ".runtime" / "pcap", settings=settings())
    manager._owned_job = lambda owner, job_id: SimpleNamespace(
        state="completed",
        rows=[
            {"flowKey": "healthy", "findingKinds": []},
            {"flowKey": "affected", "findingKinds": ["capture_truncated"]},
        ],
    )

    result = manager.results("owner", "job-id", offset=0, limit=20, finding=None)
    assert result["total"] == 1
    assert result["items"][0]["flowKey"] == "affected"


def test_csv_route_rejects_unknown_scope():
    original_sessions = main.sessions
    main.sessions = SessionStore(ttl_seconds=60, max_sessions=2)
    try:
        with TestClient(main.app, base_url="http://127.0.0.1") as client:
            session_id = main.sessions.ensure()
            client.cookies.set(main.SESSION_COOKIE, session_id)
            response = client.get("/backend/pcap-analyzer/jobs/not-used/csv?scope=everything")
        assert response.status_code == 422
    finally:
        main.sessions = original_sessions


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
            client.cookies.set(main.SESSION_COOKIE, "expired-or-forged-session")
            forged = client.post(
                "/backend/pcap-analyzer/upload",
                content=pcap_bytes([tcp_packet()]),
                headers={"content-type": "application/vnd.tcpdump.pcap"},
            )
        assert response.status_code == 401
        assert forged.status_code == 401
    finally:
        main.sessions = original_sessions


def test_upload_route_runs_job_and_exposes_bounded_results_and_csv():
    original_sessions = main.sessions
    main.sessions = SessionStore(ttl_seconds=60, max_sessions=2)
    try:
        with TestClient(main.app, base_url="http://127.0.0.1") as client:
            bootstrap = client.get("/backend/session")
            assert bootstrap.status_code == 200
            assert bootstrap.json()["connected"] is False
            session_id = client.cookies.get(main.SESSION_COOKIE)
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

            disconnected = client.delete("/backend/session")
            assert disconnected.status_code == 200
            assert client.cookies.get(main.SESSION_COOKIE) == session_id
            preserved = client.get(f"/backend/pcap-analyzer/jobs/{job_id}/results?limit=1")
            assert preserved.status_code == 200

            with TestClient(main.app, base_url="http://127.0.0.1") as other_client:
                other_client.get("/backend/session")
                cross_workspace = other_client.get(
                    f"/backend/pcap-analyzer/jobs/{job_id}"
                )
            assert cross_workspace.status_code == 404
    finally:
        main.sessions = original_sessions


def test_offline_collection_route_rejects_before_upstream_transport():
    original_sessions = main.sessions
    main.sessions = SessionStore(ttl_seconds=60, max_sessions=2)
    try:
        with TestClient(main.app, base_url="http://127.0.0.1") as client:
            client.get("/backend/session")
            response = client.post(
                "/backend/pcap-analyzer/collect",
                json={
                    "fromMs": 1_785_000_000_000,
                    "untilMs": 1_785_000_060_000,
                    "windowSeconds": 60,
                },
            )

        assert response.status_code == 401
        assert response.json()["detail"]["code"] == "extrahop_not_connected"
    finally:
        main.sessions = original_sessions
