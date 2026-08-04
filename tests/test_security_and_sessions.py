import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
import httpx

import main
from backend.connection_store import ConnectionStorageError
from backend.extrahop_client import ExtraHopClient, SessionMetadata
from backend.session_store import SessionStore


class DummyExtraHopClient:
    def __init__(self, config, response_logger=None):
        del response_logger
        self.config = config
        self.metadata = SessionMetadata(
            type=config["type"],
            tenant=config.get("tenant"),
            host=config.get("host"),
            verify_tls=config.get("verifyTls", True),
        )
        self.authenticate = AsyncMock()


class DummyConnectionStore:
    def __init__(self):
        self.saved = []
        self.configs = {}
        self.rechecks = 0

    def save(self, config):
        self.saved.append(config)
        return {
            "id": "enterprise-saved",
            "type": config["type"],
            "host": config.get("host"),
        }

    def get(self, connection_id):
        if connection_id not in self.configs:
            raise KeyError(connection_id)
        return self.configs[connection_id]

    def prepare_update(self, connection_id, changes):
        config = dict(self.get(connection_id))
        config.update(changes)
        return config

    def replace(self, connection_id, config):
        self.get(connection_id)
        del self.configs[connection_id]
        new_id = f"{config['type']}-updated"
        self.configs[new_id] = dict(config)
        return {
            "id": new_id,
            "type": config["type"],
            "host": config.get("host"),
            "tenant": config.get("tenant"),
        }

    def delete(self, connection_id):
        self.get(connection_id)
        del self.configs[connection_id]

    def list_connections(self):
        return {
            "connections": [
                {
                    "id": connection_id,
                    "type": config["type"],
                    "label": config.get("tenant") or config.get("host"),
                }
                for connection_id, config in self.configs.items()
            ],
            "groupByDeployment": False,
            "env": {"found": False, "connectionCount": 0},
            "secureStorage": {"available": True, "connectionCount": len(self.configs)},
            "warnings": [],
        }

    def recheck_secure_storage(self):
        self.rechecks += 1
        return self.list_connections()


class ExtraHopClientValidationTests(unittest.TestCase):
    def test_rejects_tenant_that_can_change_oauth_destination(self):
        with self.assertRaisesRegex(ValueError, "single DNS label"):
            ExtraHopClient(
                {
                    "type": "360",
                    "tenant": "evil.example/#",
                    "apiId": "id",
                    "apiSecret": "secret",
                }
            )

    def test_enterprise_tls_verification_defaults_on(self):
        client = ExtraHopClient(
            {
                "type": "enterprise",
                "host": "sensor.example.test:8443",
                "apiKey": "key",
            }
        )
        self.assertEqual(client.base_url, "https://sensor.example.test:8443")
        self.assertTrue(client.verify_tls)

    def test_rejects_enterprise_path_and_non_https_scheme(self):
        for host in ("https://sensor.example.test/api", "http://sensor.example.test"):
            with self.subTest(host=host), self.assertRaises(ValueError):
                ExtraHopClient(
                    {
                        "type": "enterprise",
                        "host": host,
                        "apiKey": "key",
                    }
                )


class SessionStoreTests(unittest.TestCase):
    def test_replace_removes_old_session(self):
        store = SessionStore(ttl_seconds=60, max_sessions=4)
        first_client = object()
        second_client = object()
        first_id = store.create(first_client)
        second_id = store.create(second_client, replace_session_id=first_id)

        self.assertIsNone(store.get(first_id))
        self.assertIs(store.get(second_id), second_client)

    def test_store_caps_sessions(self):
        store = SessionStore(ttl_seconds=60, max_sessions=2)
        first_id = store.create(object())
        store.create(object())
        store.create(object())

        self.assertEqual(len(store), 2)
        self.assertIsNone(store.get(first_id))

    def test_idle_session_expires(self):
        store = SessionStore(ttl_seconds=60, max_sessions=2)
        with patch("backend.session_store.time.monotonic", return_value=100.0):
            session_id = store.create(object())
        with patch("backend.session_store.time.monotonic", return_value=161.0):
            self.assertIsNone(store.get(session_id))

    def test_sync_remove_callback_is_supported(self):
        removed_session_ids = []
        store = SessionStore(
            ttl_seconds=60,
            max_sessions=2,
            remove_callback=removed_session_ids.append,
        )
        session_id = store.create(object())

        store.delete(session_id)

        self.assertEqual(removed_session_ids, [session_id])


class SessionStoreRemovalCallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_async_remove_callback_receives_replaced_evicted_deleted_and_closed_ids(self):
        callback = AsyncMock()
        store = SessionStore(ttl_seconds=60, max_sessions=1)
        store.set_remove_callback(callback)

        replaced_id = await store.acreate(object())
        replacement_id = await store.acreate(object(), replace_session_id=replaced_id)
        evicting_id = await store.acreate(object())
        await store.adelete(evicting_id)
        closed_id = await store.acreate(object())
        await store.aclose()

        self.assertEqual(
            [call.args[0] for call in callback.await_args_list],
            [replaced_id, replacement_id, evicting_id, closed_id],
        )

    async def test_ttl_prune_schedules_async_remove_callback_with_expired_id(self):
        callback = AsyncMock()
        store = SessionStore(ttl_seconds=60, max_sessions=2, remove_callback=callback)
        with patch("backend.session_store.time.monotonic", return_value=100.0):
            expired_id = await store.acreate(object())

        with patch("backend.session_store.time.monotonic", return_value=161.0):
            self.assertIsNone(store.get(expired_id))
        await store.wait_for_pending_closes()

        callback.assert_awaited_once_with(expired_id)


class BackendRouteSecurityTests(unittest.TestCase):
    def setUp(self):
        main.sessions = SessionStore(ttl_seconds=60, max_sessions=8)
        original_store = main.connection_store
        main.connection_store = DummyConnectionStore()
        self.addCleanup(setattr, main, "connection_store", original_store)
        self.client = self.enterContext(TestClient(main.app, base_url="http://127.0.0.1"))

    def test_validation_error_does_not_echo_credentials(self):
        secret = "do-not-echo-this-secret"
        response = self.client.post(
            "/backend/session",
            json={
                "type": "360",
                "tenant": "invalid/tenant",
                "apiId": "id",
                "apiSecret": secret,
            },
        )

        self.assertEqual(response.status_code, 422)
        self.assertNotIn(secret, response.text)
        self.assertNotIn('"input"', response.text)

    def test_untrusted_host_is_rejected(self):
        response = self.client.get(
            "/backend/health",
            headers={"host": "attacker.example"},
        )
        self.assertEqual(response.status_code, 400)

    @patch("main.is_worktree_dirty", return_value=True)
    def test_health_exposes_build_version_commit_and_dirty_state(self, _dirty):
        response = self.client.get("/backend/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["version"], main.APP_VERSION)
        self.assertEqual(response.json()["commit"], main.APP_COMMIT)
        self.assertIs(response.json()["dirty"], True)

    def test_packaged_distribution_is_never_marked_dirty(self):
        with patch("main.COMMIT_PATH") as commit_path:
            commit_path.exists.return_value = True

            self.assertFalse(main.is_worktree_dirty())

    def test_catalog_requires_session(self):
        response = self.client.get("/backend/system-health/catalog")
        self.assertEqual(response.status_code, 401)

    def test_proxy_preserves_int64_identifiers_as_strings_for_browser_json(self):
        unsafe_id = 9007199254740993
        upstream_payload = {
            "id": unsafe_id,
            "node_id": unsafe_id + 2,
            "xid": [unsafe_id + 4],
            "from": 1785067200000,
            "until": 1785067260000,
            "clock": 1785067260123,
            "edges": [{"from": unsafe_id + 10, "to": unsafe_id + 12, "weight": 42}],
            "stats": [
                {
                    "oid": unsafe_id + 6,
                    "time": 1785067200000,
                    "duration": 60000,
                    "values": [[unsafe_id + 8]],
                }
            ],
        }

        def upstream_response(request):
            return httpx.Response(
                200,
                json=upstream_payload,
                headers={"content-type": "application/json"},
                request=request,
            )

        client = ExtraHopClient(
            {
                "type": "enterprise",
                "host": "sensor.example.test",
                "apiKey": "key",
            }
        )
        client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(upstream_response))
        session_id = main.sessions.create(client)
        self.client.cookies.set(main.SESSION_COOKIE, session_id)
        self.addCleanup(lambda: asyncio.run(client.aclose()))

        response = self.client.get("/backend/extrahop/api/v1/metrics")

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["id"], str(unsafe_id))
        self.assertEqual(data["node_id"], str(unsafe_id + 2))
        self.assertEqual(data["xid"], [str(unsafe_id + 4)])
        self.assertEqual(data["stats"][0]["oid"], str(unsafe_id + 6))
        self.assertEqual(data["edges"][0]["from"], str(unsafe_id + 10))
        self.assertEqual(data["edges"][0]["to"], str(unsafe_id + 12))
        self.assertIsInstance(data["edges"][0]["weight"], int)
        self.assertIsInstance(data["from"], int)
        self.assertIsInstance(data["stats"][0]["time"], int)
        self.assertIsInstance(data["stats"][0]["duration"], int)
        self.assertIsInstance(data["stats"][0]["values"][0][0], int)

    def test_proxy_restores_opaque_metric_object_ids_for_upstream_json(self):
        unsafe_id = 9007199254740993
        captured_payloads = []

        def upstream_response(request):
            payload = json.loads(request.content)
            captured_payloads.append(payload)
            return httpx.Response(
                200,
                json={"object_ids": payload["object_ids"]},
                headers={"content-type": "application/json"},
                request=request,
            )

        client = ExtraHopClient(
            {
                "type": "enterprise",
                "host": "sensor.example.test",
                "apiKey": "key",
            }
        )
        client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(upstream_response))
        session_id = main.sessions.create(client)
        self.client.cookies.set(main.SESSION_COOKIE, session_id)
        self.addCleanup(lambda: asyncio.run(client.aclose()))

        for endpoint in ("metrics", "metrics/total", "metrics/totalbyobject"):
            with self.subTest(endpoint=endpoint):
                response = self.client.post(
                    f"/backend/extrahop/api/v1/{endpoint}",
                    json={
                        "object_type": "system",
                        "object_ids": [str(unsafe_id), "7"],
                        "metric_specs": [{"name": "pkts"}],
                    },
                )

                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["object_ids"], [str(unsafe_id), "7"])

        self.assertEqual(len(captured_payloads), 3)
        for payload in captured_payloads:
            self.assertEqual(payload["object_ids"], [unsafe_id, 7])
            self.assertTrue(all(isinstance(value, int) for value in payload["object_ids"]))

    def test_proxy_restores_firmware_system_ids_and_preserves_job_location(self):
        unsafe_id = 9007199254740993
        captured_payloads = []
        location = "/api/v1/jobs/ebbdbc9e-7113-448c"

        def upstream_response(request):
            captured_payloads.append(json.loads(request.content))
            return httpx.Response(
                202,
                headers={"Location": location},
                request=request,
            )

        client = ExtraHopClient(
            {
                "type": "enterprise",
                "host": "sensor.example.test",
                "apiKey": "key",
            }
        )
        client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(upstream_response))
        session_id = main.sessions.create(client)
        self.client.cookies.set(main.SESSION_COOKIE, session_id)
        self.addCleanup(lambda: asyncio.run(client.aclose()))

        response = self.client.post(
            "/backend/extrahop/api/v1/appliances/firmware/upgrade",
            json={"system_ids": [str(unsafe_id), "7"], "version": "26.3.1.100"},
        )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.headers["location"], location)
        self.assertEqual(response.json(), {})
        self.assertEqual(captured_payloads[0]["system_ids"], [unsafe_id, 7])
        self.assertTrue(all(isinstance(value, int) for value in captured_payloads[0]["system_ids"]))

    def test_proxy_drops_unsafe_upstream_location_header(self):
        def upstream_response(request):
            return httpx.Response(
                202,
                headers={"Location": "https://attacker.example/api/v1/jobs/7"},
                request=request,
            )

        client = ExtraHopClient(
            {
                "type": "enterprise",
                "host": "sensor.example.test",
                "apiKey": "key",
            }
        )
        client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(upstream_response))
        session_id = main.sessions.create(client)
        self.client.cookies.set(main.SESSION_COOKIE, session_id)
        self.addCleanup(lambda: asyncio.run(client.aclose()))

        response = self.client.post(
            "/backend/extrahop/api/v1/appliances/firmware/upgrade",
            json={"system_ids": ["7"], "version": "26.3.1.100"},
        )

        self.assertEqual(response.status_code, 202)
        self.assertNotIn("location", response.headers)

    def test_index_disables_browser_caching(self):
        response = self.client.get("/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "no-store, max-age=0")
        self.assertEqual(response.headers["pragma"], "no-cache")

    def test_reconnect_atomically_replaces_old_session(self):
        config = {
            "type": "enterprise",
            "host": "sensor.example.test",
            "apiKey": "key",
        }
        with patch("main.ExtraHopClient", DummyExtraHopClient):
            first_response = self.client.post("/backend/session", json=config)
            self.assertEqual(first_response.status_code, 200)
            first_id = self.client.cookies.get(main.SESSION_COOKIE)

            second_response = self.client.post("/backend/session", json=config)
            self.assertEqual(second_response.status_code, 200)
            second_id = self.client.cookies.get(main.SESSION_COOKIE)

        self.assertNotEqual(first_id, second_id)
        self.assertIsNone(main.sessions.get(first_id))
        self.assertIsNotNone(main.sessions.get(second_id))

    def test_successful_manual_connection_is_saved_server_side(self):
        config = {
            "type": "enterprise",
            "host": "sensor.example.test",
            "apiKey": "key",
        }
        store = DummyConnectionStore()
        with (
            patch("main.ExtraHopClient", DummyExtraHopClient),
            patch("main.connection_store", store),
        ):
            response = self.client.post("/backend/session", json=config)

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["savedConnection"])
        self.assertEqual(response.json()["connectionId"], "enterprise-saved")
        self.assertEqual(store.saved, [{**config, "verifyTls": True}])

    def test_secure_storage_failure_does_not_discard_active_session(self):
        config = {
            "type": "enterprise",
            "host": "sensor.example.test",
            "apiKey": "key",
        }
        store = DummyConnectionStore()
        with (
            patch("main.ExtraHopClient", DummyExtraHopClient),
            patch("main.connection_store", store),
            patch.object(
                store,
                "save",
                side_effect=ConnectionStorageError(
                    "Secure saved connections are not set up in WSL; "
                    "this connection was not saved.",
                    code="wsl-secret-service-unavailable",
                    recovery={
                        "kind": "wsl-secret-service",
                        "command": "sudo apt install gnome-keyring",
                    },
                ),
            ),
        ):
            response = self.client.post("/backend/session", json=config)

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["connected"])
        self.assertFalse(response.json()["savedConnection"])
        self.assertEqual(
            response.json()["connectionStorage"]["code"],
            "wsl-secret-service-unavailable",
        )
        self.assertIsNotNone(main.sessions.get(self.client.cookies.get(main.SESSION_COOKIE)))

    def test_saved_connection_endpoint_resolves_credentials_server_side(self):
        store = DummyConnectionStore()
        store.configs["cloud-saved"] = {
            "type": "360",
            "tenant": "tenant",
            "apiId": "id",
            "apiSecret": "secret",
        }
        with (
            patch("main.ExtraHopClient", side_effect=DummyExtraHopClient) as client_class,
            patch("main.connection_store", store),
        ):
            response = self.client.post("/backend/connections/cloud-saved/session")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["config"],
            {"type": "360", "tenant": "tenant"},
        )
        client_class.assert_called_once()
        self.assertEqual(client_class.call_args.args[0]["apiSecret"], "secret")
        self.assertNotIn("secret", response.text)

    def test_saved_enterprise_connection_accepts_transient_proxy_token(self):
        store = DummyConnectionStore()
        store.configs["enterprise-saved"] = {
            "type": "enterprise",
            "host": "sensor.example.test",
            "apiKey": "durable-key",
        }
        with (
            patch("main.ExtraHopClient", side_effect=DummyExtraHopClient) as client_class,
            patch("main.connection_store", store),
        ):
            response = self.client.post(
                "/backend/connections/enterprise-saved/session",
                json={"proxyToken": "single-use-token"},
            )

        self.assertEqual(response.status_code, 200)
        runtime_config = client_class.call_args.args[0]
        self.assertEqual(runtime_config["apiKey"], "durable-key")
        self.assertEqual(runtime_config["proxyToken"], "single-use-token")
        self.assertNotIn("proxyToken", store.configs["enterprise-saved"])
        self.assertNotIn("single-use-token", response.text)

    def test_saved_connection_edit_authenticates_then_replaces_keychain_entry(self):
        store = DummyConnectionStore()
        store.configs["enterprise-saved"] = {
            "type": "enterprise",
            "host": "sensor.example.test",
            "apiKey": "old-key",
            "verifyTls": True,
        }
        with (
            patch("main.ExtraHopClient", side_effect=DummyExtraHopClient) as client_class,
            patch("main.connection_store", store),
        ):
            response = self.client.post(
                "/backend/connections/enterprise-saved/session",
                json={
                    "updates": {
                        "host": "renamed.example.test",
                        "apiKey": "new-key",
                        "verifyTls": False,
                    }
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["savedConnection"])
        self.assertEqual(response.json()["connectionId"], "enterprise-updated")
        runtime_config = client_class.call_args.args[0]
        self.assertEqual(runtime_config["apiKey"], "new-key")
        self.assertFalse(runtime_config["verifyTls"])
        self.assertNotIn("enterprise-saved", store.configs)
        self.assertEqual(store.configs["enterprise-updated"]["apiKey"], "new-key")

    def test_delete_saved_connection_removes_only_store_entry(self):
        store = DummyConnectionStore()
        store.configs["enterprise-saved"] = {
            "type": "enterprise",
            "host": "sensor.example.test",
            "apiKey": "key",
        }
        with patch("main.connection_store", store):
            response = self.client.delete("/backend/connections/enterprise-saved")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"deleted": True})
        self.assertEqual(store.configs, {})

    def test_saved_connection_list_never_contains_credentials(self):
        store = DummyConnectionStore()
        store.configs["enterprise-saved"] = {
            "type": "enterprise",
            "host": "sensor.example.test",
            "apiKey": "secret",
        }
        with patch("main.connection_store", store):
            response = self.client.get("/backend/connections")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["connections"][0]["label"],
            "sensor.example.test",
        )
        self.assertNotIn("secret", response.text)

    def test_secure_storage_recheck_refreshes_server_side_discovery(self):
        store = DummyConnectionStore()
        with patch("main.connection_store", store):
            response = self.client.post(
                "/backend/connections/secure-storage/recheck"
            )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["secureStorage"]["available"])
        self.assertEqual(store.rechecks, 1)


if __name__ == "__main__":
    unittest.main()
