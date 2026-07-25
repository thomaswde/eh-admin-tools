import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import httpx

import main
from backend.extrahop_client import ExtraHopClient
from backend.session_store import SessionStore


class ReusableHttpClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_reuses_one_http_client_and_closes_it(self):
        requests = []

        async def handler(request):
            requests.append(request)
            return httpx.Response(200, json={"ok": True})

        client = ExtraHopClient({
            "type": "enterprise",
            "host": "sensor.example.test",
            "apiKey": "key",
        })
        client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        shared_client = client._http_client

        await client.request("GET", "/appliances")
        await client.request("GET", "/devices")

        self.assertIs(client._http_client, shared_client)
        self.assertEqual(len(requests), 2)
        await client.aclose()
        self.assertTrue(shared_client.is_closed)

    async def test_360_reauthenticates_once_after_401_with_shared_client(self):
        api_attempts = 0
        token_attempts = 0

        async def handler(request):
            nonlocal api_attempts, token_attempts
            if request.url.path == "/oauth2/token":
                token_attempts += 1
                return httpx.Response(200, json={
                    "access_token": f"token-{token_attempts}",
                    "expires_in": 3600,
                })
            api_attempts += 1
            if api_attempts == 1:
                return httpx.Response(401, json={"error": "expired"})
            return httpx.Response(200, json={"ok": True})

        client = ExtraHopClient({
            "type": "360",
            "tenant": "tenant",
            "apiId": "id",
            "apiSecret": "secret",
        })
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

        client = ExtraHopClient({
            "type": "enterprise",
            "host": "sensor.example.test",
            "apiKey": "key",
        })
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

    async def test_cancellation_is_not_retried_or_wrapped(self):
        client = ExtraHopClient({
            "type": "enterprise",
            "host": "sensor.example.test",
            "apiKey": "key",
        })
        mock_client = AsyncMock()
        mock_client.is_closed = False
        mock_client.request.side_effect = asyncio.CancelledError()
        client._http_client = mock_client

        with self.assertRaises(asyncio.CancelledError):
            await client.request("GET", "/metrics")

        mock_client.request.assert_awaited_once()

    async def test_retries_a_transient_network_failure(self):
        client = ExtraHopClient({
            "type": "enterprise",
            "host": "sensor.example.test",
            "apiKey": "key",
        })
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
        untrusted = ExtraHopClient({
            "type": "enterprise",
            "host": "lab.example.test",
            "apiKey": "key",
            "verifyTls": False,
        })
        default = ExtraHopClient({
            "type": "enterprise",
            "host": "prod.example.test",
            "apiKey": "key",
        })
        cloud = ExtraHopClient({
            "type": "360",
            "tenant": "tenant",
            "apiId": "id",
            "apiSecret": "secret",
        })
        self.assertFalse(untrusted.verify_tls)
        self.assertTrue(default.verify_tls)
        self.assertTrue(cloud.verify_tls)


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
        report = {
            "cycle": "auto",
            "appliances": [{
                "id": "7",
                "name": "sensor-7",
                "online": True,
                "license_platform": "EDA 9300",
                "capacity": {
                    "base_packetrate": 100,
                    "base_gbps": 10,
                    "advanced_analysis": 1200,
                    "standard_analysis": 3800,
                },
            }],
            "device_analysis": {
                "7": {"advanced": 100, "standard": 200, "discovery": 0, "status": "complete"},
            },
            "metrics": {
                "pkts": {
                    "sensor_status": {"7": {"status": "complete"}},
                    "summary": {
                        "peak_values": {"7": 1000},
                        "peak_duration_ms": {"7": 1000},
                        "actual_cycles": {"7": "1sec"},
                    },
                },
                "bytes": {
                    "sensor_status": {"7": {"status": "complete"}},
                    "summary": {
                        "peak_values": {"7": 125000000},
                        "peak_duration_ms": {"7": 1000},
                        "actual_cycles": {"7": "1sec"},
                    },
                },
                "trigger_cycles": {"sensor_status": {"7": {"status": "complete"}}, "summary": {}},
                "trigger_drops": {
                    "sensor_status": {"7": {"status": "zero_valued"}},
                    "summary": {"aggregation_mode": "total_by_object", "totals": {"7": 0}, "peak_values": {}},
                },
            },
            "trigger_utilization": {
                "peak_by_sensor": {
                    "7": {
                        "used_cycles": 90,
                        "available_cycles": 100,
                        "utilization": 0.9,
                    },
                },
            },
        }

        row = main.system_health_pdf_rows(report)[0]

        self.assertEqual(row["trigger_cycles_peak"], 90)
        self.assertEqual(row["trigger_cycles_avail"], 100)
        self.assertEqual(row["advanced_capacity"], 1200)
        self.assertEqual(row["standard_capacity"], 3800)
        self.assertEqual(main.system_health_pdf_cycle_label(report), "1sec")


if __name__ == "__main__":
    unittest.main()
