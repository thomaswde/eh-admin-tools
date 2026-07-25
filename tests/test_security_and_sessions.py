import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

import main
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


if __name__ == "__main__":
    unittest.main()
