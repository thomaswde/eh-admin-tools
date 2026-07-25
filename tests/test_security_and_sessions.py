import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

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


class BackendRouteSecurityTests(unittest.TestCase):
    def setUp(self):
        main.sessions = SessionStore(ttl_seconds=60, max_sessions=8)
        self.client = TestClient(main.app, base_url="http://127.0.0.1")

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
                    "The operating-system credential store is unavailable; "
                    "the connection was not saved."
                ),
            ),
        ):
            response = self.client.post("/backend/session", json=config)

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["connected"])
        self.assertFalse(response.json()["savedConnection"])
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


if __name__ == "__main__":
    unittest.main()
