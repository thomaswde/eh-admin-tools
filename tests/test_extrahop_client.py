import asyncio
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, Mock, patch

import httpx

from backend import system_health_pdf as pdf
from backend.extrahop_client import ExtraHopApiError, ExtraHopClient
from backend.session_store import SessionStore


class ChunkedAsyncStream(httpx.AsyncByteStream):
    def __init__(self, chunks, *, error=None, wait_for=None, started=None):
        self.chunks = chunks
        self.error = error
        self.wait_for = wait_for
        self.started = started

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk
        if self.started:
            self.started.set()
        if self.wait_for:
            await self.wait_for.wait()
        if self.error:
            raise self.error


class ReusableHttpClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_authentication_classifies_the_local_enterprise_appliance(self):
        client = ExtraHopClient(
            {
                "type": "enterprise",
                "host": "sensor.example.test",
                "apiKey": "key",
            }
        )
        client.request = AsyncMock(
            side_effect=[
                {"version": "9.9"},
                [
                    {"id": "12", "platform": "command"},
                    {"id": "0", "platform": "flow_collector"},
                ],
            ]
        )

        await client.authenticate()

        self.assertEqual(client.metadata.appliance_type, "sensor")
        self.assertEqual(client.metadata.public_dict()["applianceType"], "sensor")
        self.assertEqual(
            [call.args for call in client.request.await_args_list],
            [
                ("GET", "/api/v1/extrahop"),
                ("GET", "/api/v1/appliances"),
            ],
        )

    def test_local_appliance_platforms_map_to_saved_connection_categories(self):
        for platform, expected in (
            ("command", "console"),
            ("discover", "sensor"),
            ("flow_collector", "sensor"),
            ("flow-collector", "sensor"),
            ("trace", "packetstore"),
        ):
            with self.subTest(platform=platform):
                self.assertEqual(
                    ExtraHopClient._local_appliance_type(
                        [{"id": "0", "platform": platform}]
                    ),
                    expected,
                )

    async def test_inventory_denial_does_not_invalidate_enterprise_credentials(self):
        client = ExtraHopClient(
            {
                "type": "enterprise",
                "host": "sensor.example.test",
                "apiKey": "key",
            }
        )
        client.request = AsyncMock(
            side_effect=[
                {"version": "9.9"},
                ExtraHopApiError("forbidden", status_code=403),
            ]
        )

        await client.authenticate()

        self.assertIsNone(client.metadata.appliance_type)

    def test_request_log_body_parser_bounds_before_json_decoding(self):
        body = b'{"key":"' + (b"x" * 10_000) + b'"}'
        preview = ExtraHopClient._request_body_for_log(
            body,
            "application/json",
            max_bytes=64,
        )

        self.assertEqual(preview["type"], "truncated_request_preview")
        self.assertEqual(preview["request_bytes"], len(body))
        self.assertEqual(preview["preview_bytes"], 64)
        self.assertLessEqual(len(preview["preview"].encode()), 64)

    async def test_non_full_logging_does_not_decode_request_body(self):
        async def handler(_request):
            return httpx.Response(200, json={"ok": True})

        logger = Mock()
        logger.max_preview_bytes = 64
        logger.wants_request_body.return_value = False
        client = ExtraHopClient(
            {
                "type": "enterprise",
                "host": "sensor.example.test",
                "apiKey": "key",
            },
            logger,
        )
        client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

        with patch.object(
            ExtraHopClient,
            "_request_body_for_log",
            wraps=ExtraHopClient._request_body_for_log,
        ) as parser:
            await client.request(
                "POST",
                "/metrics",
                body=b'{"metric":"record_bytes"}',
                content_type="application/json",
            )

        parser.assert_not_called()
        logger.log_response.assert_called_once()
        await client.aclose()

    async def test_reuses_one_http_client_and_closes_it(self):
        requests = []

        async def handler(request):
            requests.append(request)
            return httpx.Response(200, json={"ok": True})

        client = ExtraHopClient(
            {
                "type": "enterprise",
                "host": "sensor.example.test",
                "apiKey": "key",
            }
        )
        client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        shared_client = client._http_client

        await client.request("GET", "/appliances")
        await client.request("GET", "/devices")

        self.assertIs(client._http_client, shared_client)
        self.assertEqual(len(requests), 2)
        await client.aclose()
        self.assertTrue(shared_client.is_closed)
        with self.assertRaises(ExtraHopApiError) as raised:
            await client.request("GET", "/appliances")
        self.assertEqual(raised.exception.status_code, 401)
        self.assertEqual(len(requests), 2, "a closed client must never recreate an authenticated transport")

    async def test_coalesces_identical_concurrent_dashboard_mutations_only_while_in_flight(self):
        attempts = 0
        request_started = asyncio.Event()
        release_request = asyncio.Event()

        async def handler(_request):
            nonlocal attempts
            attempts += 1
            request_started.set()
            await release_request.wait()
            return httpx.Response(204)

        client = ExtraHopClient(
            {
                "type": "enterprise",
                "host": "sensor.example.test",
                "apiKey": "key",
            }
        )
        client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

        first = asyncio.create_task(client.request("DELETE", "/dashboards/42"))
        await request_started.wait()
        duplicate = asyncio.create_task(client.request("DELETE", "/dashboards/42"))
        await asyncio.sleep(0)

        self.assertEqual(attempts, 1)
        release_request.set()
        self.assertEqual(await first, {})
        self.assertEqual(await duplicate, {})

        await client.request("DELETE", "/dashboards/42")
        self.assertEqual(attempts, 2, "completed work is not retained as a durable idempotency cache")
        await client.aclose()

    async def test_360_reauthenticates_once_after_401_with_shared_client(self):
        api_attempts = 0
        token_attempts = 0

        async def handler(request):
            nonlocal api_attempts, token_attempts
            if request.url.path == "/oauth2/token":
                token_attempts += 1
                return httpx.Response(
                    200,
                    json={
                        "access_token": f"token-{token_attempts}",
                        "expires_in": 3600,
                    },
                )
            api_attempts += 1
            if api_attempts == 1:
                return httpx.Response(401, json={"error": "expired"})
            return httpx.Response(200, json={"ok": True})

        client = ExtraHopClient(
            {
                "type": "360",
                "tenant": "tenant",
                "apiId": "id",
                "apiSecret": "secret",
            }
        )
        client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        client.access_token = "stale"
        client.access_token_expires_at = 10**12

        result = await client.request("GET", "/appliances")

        self.assertEqual(result, {"ok": True})
        self.assertEqual(api_attempts, 2)
        self.assertEqual(token_attempts, 1)
        await client.aclose()

    async def test_retries_rate_limit_and_honors_retry_after(self):
        attempts = 0

        async def handler(request):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return httpx.Response(429, headers={"Retry-After": "2"}, json={"error": "busy"})
            return httpx.Response(200, json={"ok": True})

        client = ExtraHopClient(
            {
                "type": "enterprise",
                "host": "sensor.example.test",
                "apiKey": "key",
            }
        )
        client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch("backend.extrahop_client.asyncio.sleep", new=AsyncMock()) as sleep:
            result = await client.request(
                "POST",
                "/metrics",
                body=b"{}",
                content_type="application/json",
            )

        self.assertEqual(result, {"ok": True})
        sleep.assert_awaited_once_with(2.0)
        await client.aclose()

    async def test_does_not_retry_metrics_next_sensor_failure(self):
        attempts = 0

        async def handler(request):
            nonlocal attempts
            attempts += 1
            return httpx.Response(
                500,
                json={"error_message": '"sensor-7" (ID 7 at 10.0.0.7): failed to get sessionid'},
            )

        client = ExtraHopClient(
            {
                "type": "enterprise",
                "host": "sensor.example.test",
                "apiKey": "key",
            }
        )
        client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch("backend.extrahop_client.asyncio.sleep", new=AsyncMock()) as sleep:
            with self.assertRaisesRegex(ExtraHopApiError, "failed to get sessionid"):
                await client.request("GET", "/metrics/next/77")

        self.assertEqual(attempts, 1)
        sleep.assert_not_awaited()
        await client.aclose()

    async def test_hopcloud_auth_redirect_explains_how_to_supply_the_cookie_token(self):
        async def handler(_request):
            return httpx.Response(307, text="Redirecting for authentication")

        client = ExtraHopClient(
            {
                "type": "enterprise",
                "host": "console.ra.hopcloud.extrahop.com",
                "apiKey": "key",
            }
        )
        client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

        with self.assertRaises(ExtraHopApiError) as raised:
            await client.request("GET", "/appliances")

        self.assertEqual(raised.exception.status_code, 307)
        self.assertIn("HopCloud Proxy authentication failed", str(raised.exception))
        self.assertIn("cookie named 'token'", raised.exception.details["hint"])
        self.assertIn("console.ra.hopcloud.extrahop.com", raised.exception.details["url"])
        await client.aclose()

    async def test_non_hopcloud_redirect_keeps_the_generic_api_error(self):
        async def handler(_request):
            return httpx.Response(307, text="Redirecting for authentication")

        client = ExtraHopClient(
            {
                "type": "enterprise",
                "host": "sensor.example.test",
                "apiKey": "key",
            }
        )
        client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

        with self.assertRaises(ExtraHopApiError) as raised:
            await client.request("GET", "/appliances")

        self.assertNotIn("HopCloud Proxy authentication failed", str(raised.exception))
        self.assertNotIn("hint", raised.exception.details)
        await client.aclose()

    async def test_cancellation_is_not_retried_or_wrapped(self):
        client = ExtraHopClient(
            {
                "type": "enterprise",
                "host": "sensor.example.test",
                "apiKey": "key",
            }
        )
        mock_client = AsyncMock()
        mock_client.is_closed = False
        mock_client.request.side_effect = asyncio.CancelledError()
        client._http_client = mock_client

        with self.assertRaises(asyncio.CancelledError):
            await client.request("GET", "/metrics")

        mock_client.request.assert_awaited_once()

    async def test_retries_a_transient_network_failure(self):
        client = ExtraHopClient(
            {
                "type": "enterprise",
                "host": "sensor.example.test",
                "apiKey": "key",
            }
        )
        request = httpx.Request("GET", "https://sensor.example.test/api/v1/appliances")
        mock_client = AsyncMock()
        mock_client.is_closed = False
        mock_client.request.side_effect = [
            httpx.ConnectError("temporary", request=request),
            httpx.Response(200, request=request, json={"ok": True}),
        ]
        client._http_client = mock_client

        with patch("backend.extrahop_client.asyncio.sleep", new=AsyncMock()) as sleep:
            result = await client.request("GET", "/appliances")

        self.assertEqual(result, {"ok": True})
        self.assertEqual(mock_client.request.await_count, 2)
        sleep.assert_awaited_once()

    async def test_untrusted_tls_setting_is_scoped_to_one_enterprise_session(self):
        untrusted = ExtraHopClient(
            {
                "type": "enterprise",
                "host": "lab.example.test",
                "apiKey": "key",
                "verifyTls": False,
            }
        )
        default = ExtraHopClient(
            {
                "type": "enterprise",
                "host": "prod.example.test",
                "apiKey": "key",
            }
        )
        cloud = ExtraHopClient(
            {
                "type": "360",
                "tenant": "tenant",
                "apiId": "id",
                "apiSecret": "secret",
            }
        )
        self.assertFalse(untrusted.verify_tls)
        self.assertTrue(default.verify_tls)
        self.assertTrue(cloud.verify_tls)

    async def test_streams_enterprise_download_with_auth_headers_and_json_body(self):
        requests = []

        async def handler(request):
            requests.append(request)
            return httpx.Response(
                200,
                headers={"content-type": "application/vnd.tcpdump.pcap"},
                stream=ChunkedAsyncStream([b"pcap", b"-bytes"]),
            )

        client = ExtraHopClient(
            {
                "type": "enterprise",
                "host": "console.ra.hopcloud.extrahop.com",
                "apiKey": "key",
                "proxyToken": "proxy-token",
            }
        )
        client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "capture.pcap"
            result = await client.download_to_file(
                "POST",
                "/packets/search",
                destination=destination,
                json_body={"from": "-5m", "output": "pcap"},
                max_bytes=64,
            )

            self.assertEqual(destination.read_bytes(), b"pcap-bytes")
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.content_type, "application/vnd.tcpdump.pcap")
            self.assertEqual(result.bytes_written, 10)

        self.assertEqual(len(requests), 1)
        request = requests[0]
        self.assertEqual(request.headers["Authorization"], "ExtraHop apikey=key")
        self.assertEqual(request.headers["Cookie"], "token=proxy-token")
        self.assertEqual(request.headers["Accept"], "application/vnd.tcpdump.pcap")
        self.assertEqual(json.loads(request.content), {"from": "-5m", "output": "pcap"})
        await client.aclose()

    async def test_360_download_refreshes_after_401_and_uses_new_bearer_token(self):
        authorizations = []
        token_attempts = 0

        async def handler(request):
            nonlocal token_attempts
            if request.url.path == "/oauth2/token":
                token_attempts += 1
                return httpx.Response(200, json={"access_token": "fresh", "expires_in": 3600})
            authorizations.append(request.headers["Authorization"])
            if len(authorizations) == 1:
                return httpx.Response(401, json={"error": "expired"})
            return httpx.Response(
                200,
                headers={"content-type": "application/vnd.tcpdump.pcap"},
                stream=ChunkedAsyncStream([b"pcap"]),
            )

        client = ExtraHopClient(
            {
                "type": "360",
                "tenant": "tenant",
                "apiId": "id",
                "apiSecret": "secret",
            }
        )
        client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        client.access_token = "stale"
        client.access_token_expires_at = 10**12
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "capture.pcap"
            result = await client.download_to_file(
                "POST",
                "/api/v1/packets/search",
                destination=destination,
                json_body={"from": "-5m"},
                max_bytes=64,
            )

            self.assertEqual(result.bytes_written, 4)
            self.assertEqual(destination.read_bytes(), b"pcap")

        self.assertEqual(authorizations, ["Bearer stale", "Bearer fresh"])
        self.assertEqual(token_attempts, 1)
        await client.aclose()

    async def test_204_download_removes_stale_destination_and_returns_zero_bytes(self):
        async def handler(_request):
            return httpx.Response(204)

        client = ExtraHopClient(
            {"type": "enterprise", "host": "sensor.example.test", "apiKey": "key"}
        )
        client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "capture.pcap"
            destination.write_bytes(b"stale")
            result = await client.download_to_file(
                "POST",
                "/packets/search",
                destination=destination,
                json_body={"from": "-5m"},
                max_bytes=64,
            )

            self.assertEqual(result.status_code, 204)
            self.assertEqual(result.bytes_written, 0)
            self.assertFalse(destination.exists())
        await client.aclose()

    async def test_download_hard_limit_removes_partial_destination(self):
        async def handler(_request):
            return httpx.Response(200, stream=ChunkedAsyncStream([b"1234", b"5678"]))

        client = ExtraHopClient(
            {"type": "enterprise", "host": "sensor.example.test", "apiKey": "key"}
        )
        client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "capture.pcap"
            with self.assertRaises(ExtraHopApiError) as raised:
                await client.download_to_file(
                    "POST",
                    "/packets/search",
                    destination=destination,
                    json_body={"from": "-5m"},
                    max_bytes=6,
                )

            self.assertEqual(raised.exception.status_code, 413)
            self.assertFalse(destination.exists())
        await client.aclose()

    async def test_download_maps_json_error_through_existing_api_error(self):
        async def handler(_request):
            return httpx.Response(400, json={"error_message": "invalid packet filter"})

        client = ExtraHopClient(
            {"type": "enterprise", "host": "sensor.example.test", "apiKey": "key"}
        )
        client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "capture.pcap"
            with self.assertRaisesRegex(ExtraHopApiError, "invalid packet filter") as raised:
                await client.download_to_file(
                    "POST",
                    "/packets/search",
                    destination=destination,
                    json_body={"from": "bad"},
                    max_bytes=64,
                )

            self.assertEqual(raised.exception.status_code, 400)
            self.assertEqual(raised.exception.details["response"]["error_message"], "invalid packet filter")
            self.assertFalse(destination.exists())
        await client.aclose()

    async def test_download_maps_binary_error_without_reading_packet_bytes(self):
        class MustNotReadStream(httpx.AsyncByteStream):
            async def __aiter__(self):
                raise AssertionError("binary error body must not be read")
                yield b"packet bytes"  # pragma: no cover

        async def handler(_request):
            return httpx.Response(
                403,
                headers={"content-type": "application/vnd.tcpdump.pcap"},
                stream=MustNotReadStream(),
            )

        client = ExtraHopClient(
            {"type": "enterprise", "host": "sensor.example.test", "apiKey": "key"}
        )
        client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "capture.pcap"
            with self.assertRaises(ExtraHopApiError) as raised:
                await client.download_to_file(
                    "POST",
                    "/packets/search",
                    destination=destination,
                    json_body={"from": "-5m"},
                    max_bytes=64,
                )

            self.assertEqual(raised.exception.status_code, 403)
            self.assertFalse(destination.exists())
        await client.aclose()

    async def test_download_retries_status_and_midstream_transport_errors_from_a_clean_file(self):
        attempts = 0

        async def handler(request):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return httpx.Response(503, json={"error": "busy"}, headers={"retry-after": "0"})
            if attempts == 2:
                return httpx.Response(
                    200,
                    stream=ChunkedAsyncStream(
                        [b"partial"],
                        error=httpx.ReadError("connection dropped", request=request),
                    ),
                )
            return httpx.Response(200, stream=ChunkedAsyncStream([b"complete"]))

        client = ExtraHopClient(
            {"type": "enterprise", "host": "sensor.example.test", "apiKey": "key"}
        )
        client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "capture.pcap"
            with patch("backend.extrahop_client.asyncio.sleep", new=AsyncMock()) as sleep:
                result = await client.download_to_file(
                    "POST",
                    "/packets/search",
                    destination=destination,
                    json_body={"from": "-5m"},
                    max_bytes=64,
                )

            self.assertEqual(result.bytes_written, 8)
            self.assertEqual(destination.read_bytes(), b"complete")
            self.assertEqual(attempts, 3)
            self.assertEqual(sleep.await_count, 2)
        await client.aclose()

    async def test_download_cancellation_and_deadline_propagate_and_remove_partial_files(self):
        for mode in ("cancel", "deadline"):
            started = asyncio.Event()
            never = asyncio.Event()

            async def handler(_request):
                return httpx.Response(
                    200,
                    stream=ChunkedAsyncStream(
                        [b"partial"],
                        wait_for=never,
                        started=started,
                    ),
                )

            client = ExtraHopClient(
                {"type": "enterprise", "host": "sensor.example.test", "apiKey": "key"}
            )
            client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            with tempfile.TemporaryDirectory() as directory:
                destination = Path(directory) / "capture.pcap"
                deadline = time.monotonic() + 0.02 if mode == "deadline" else None
                task = asyncio.create_task(
                    client.download_to_file(
                        "POST",
                        "/packets/search",
                        destination=destination,
                        json_body={"from": "-5m"},
                        max_bytes=64,
                        deadline=deadline,
                    )
                )
                await started.wait()
                if mode == "cancel":
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                else:
                    with self.assertRaises(ExtraHopApiError) as raised:
                        await task
                    self.assertEqual(raised.exception.status_code, 504)
                self.assertFalse(destination.exists())
            await client.aclose()


class ClosableClient:
    def __init__(self):
        self.aclose = AsyncMock()


class SessionLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_closes_clients_on_replacement_eviction_expiration_and_logout(self):
        store = SessionStore(ttl_seconds=60, max_sessions=2)
        replaced = ClosableClient()
        replacement = ClosableClient()
        first_id = await store.acreate(replaced)
        replacement_id = await store.acreate(replacement, replace_session_id=first_id)
        replaced.aclose.assert_awaited_once()
        await store.adelete(replacement_id)
        replacement.aclose.assert_awaited_once()

        eviction_store = SessionStore(ttl_seconds=60, max_sessions=2)
        evicted = ClosableClient()
        middle = ClosableClient()
        retained = ClosableClient()
        evicted_id = await eviction_store.acreate(evicted)
        await eviction_store.acreate(middle)
        await eviction_store.acreate(retained)
        evicted.aclose.assert_awaited_once()
        self.assertIsNone(eviction_store.get(evicted_id))

        expiration_store = SessionStore(ttl_seconds=60, max_sessions=2)
        expiring = ClosableClient()
        with patch("backend.session_store.time.monotonic", return_value=100.0):
            expiring_id = await expiration_store.acreate(expiring)
        with patch("backend.session_store.time.monotonic", return_value=161.0):
            self.assertIsNone(expiration_store.get(expiring_id))
        await expiration_store.wait_for_pending_closes()
        expiring.aclose.assert_awaited_once()

        await eviction_store.aclose()
        await store.aclose()
        middle.aclose.assert_awaited_once()
        retained.aclose.assert_awaited_once()


class SystemHealthPdfProjectionTests(unittest.TestCase):
    def test_pdf_uses_aligned_trigger_bucket_and_license_capacity_projection(self):
        fixture_path = Path(__file__).parent / "fixtures" / "system-health-renderer-v1.json"
        report = json.loads(fixture_path.read_text(encoding="utf-8"))
        report["metadata"]["cycle_label"] = "1sec"
        report["sensor_summaries"][0].update(
            {
                "triggerCyclesPeak": 90,
                "triggerCyclesAvail": 100,
                "triggerUtilization": 0.9,
                "advancedCapacity": 1200,
                "standardCapacity": 3800,
            }
        )

        row = pdf.system_health_pdf_rows(report)[0]

        self.assertEqual(row["trigger_cycles_peak"], 90)
        self.assertEqual(row["trigger_cycles_avail"], 100)
        self.assertEqual(row["advanced_capacity"], 1200)
        self.assertEqual(row["standard_capacity"], 3800)
        self.assertEqual(pdf.system_health_pdf_cycle_label(report), "1sec")

    def test_pdf_counts_slow_write_packet_drops_as_capture_loss(self):
        summary = pdf.system_health_pdf_summary(
            [],
            {},
            [
                {
                    "packet_drops": 0,
                    "slow_write_drops": 4,
                    "interface_drops": 0,
                    "secret_drops": 0,
                }
            ],
        )

        self.assertIn("<span>PCAP Loss</span><b>1 / 1</b>", summary)

        block_summary = pdf.system_health_pdf_summary(
            [],
            {},
            [
                {
                    "packet_drops": 0,
                    "slow_write_drops": 0,
                    "interface_drops": 0,
                    "blocks_dropped": 3,
                    "secret_drops": 0,
                }
            ],
        )
        self.assertIn("<span>PCAP Loss</span><b>1 / 1</b>", block_summary)

    def test_pdf_lists_offline_sensors_without_empty_chart_rows(self):
        html_output = pdf.system_health_pdf_page(
            "Packet Rate",
            "Peak rate",
            "EDA",
            [
                {
                    "name": "Reporting sensor",
                    "online": True,
                    "packet_peak": 50,
                    "packet_capacity": 100,
                    "metric_status": {"pkts": "complete"},
                }
            ],
            1,
            1,
            "packet_peak",
            "packet_capacity",
            "pps",
            ["Alpha sensor", "Zulu sensor"],
        )

        self.assertIn("<b>2 OFFLINE</b>", html_output)
        self.assertIn('<div class="offline-names">Alpha sensor, Zulu sensor</div>', html_output)
        self.assertEqual(html_output.count('class="row"'), 1)

        packetstore_html = pdf.system_health_pdf_packetstore_page(
            [],
            1,
            1,
            "30sec",
            ["Offline Packetstore"],
        )
        self.assertIn("<b>1 OFFLINE</b>", packetstore_html)
        self.assertIn('<div class="offline-names">Offline Packetstore</div>', packetstore_html)
        self.assertNotIn("class='mini'", packetstore_html)


if __name__ == "__main__":
    unittest.main()
