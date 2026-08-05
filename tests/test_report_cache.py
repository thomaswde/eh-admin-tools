import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

import main
from backend.extrahop_client import SessionMetadata
from backend.report_cache import (
    ReportCache,
    ReportCacheLimitError,
    cache_user_key,
    connection_cache_id,
)
from backend.session_store import SessionStore


class DummyClient:
    def __init__(self, host: str):
        self.config = {
            "type": "enterprise",
            "host": f"https://{host}",
            "apiKey": "must-not-be-cached",
        }
        self.metadata = SessionMetadata(type="enterprise", host=host)
        self.aclose = AsyncMock()


class ReportCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "api-response-cache"
        self.cache = ReportCache(self.root, username="Alice Example")
        self.connection = {
            "type": "enterprise",
            "host": "sensor.example.test",
            "apiKey": "secret",
        }

    def test_cache_is_organized_by_user_connection_and_report(self):
        written = self.cache.write("system-health", self.connection, {"report": {"sensors": 2}})

        connection_id = connection_cache_id(self.connection)
        user_dir = self.root / cache_user_key("Alice Example")
        report_path = user_dir / connection_id / "reports" / "system-health.json"
        manifest_path = user_dir / connection_id / "connection.json"
        self.assertTrue(report_path.is_file())
        self.assertEqual(self.cache.read("system-health", self.connection), written)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest["connection"]["host"], "sensor.example.test")
        self.assertNotIn("apiKey", manifest["connection"])
        self.assertNotIn("secret", manifest_path.read_text(encoding="utf-8"))

    def test_connections_do_not_share_cached_reports(self):
        self.cache.write("records-report", self.connection, {"value": 1})

        other = {"type": "enterprise", "host": "other.example.test"}
        self.assertIsNone(self.cache.read("records-report", other))

    def test_unsupported_report_id_cannot_create_an_arbitrary_path(self):
        with self.assertRaisesRegex(ValueError, "unsupported"):
            self.cache.write("../escape", self.connection, {})

    def test_oversized_entry_fails_without_replacing_the_previous_cache(self):
        cache = ReportCache(self.root, username="Alice", max_entry_bytes=300)
        cache.write("records-report", self.connection, {"value": "small"})

        with self.assertRaises(ReportCacheLimitError):
            cache.write("records-report", self.connection, {"value": "x" * 500})

        self.assertEqual(cache.read("records-report", self.connection)["payload"], {"value": "small"})

    def test_corrupt_file_is_ignored(self):
        self.cache.write("device-discovery", self.connection, {"value": 1})
        path = (
            self.cache.user_directory
            / connection_cache_id(self.connection)
            / "reports"
            / "device-discovery.json"
        )
        path.write_text("{not json", encoding="utf-8")

        self.assertIsNone(self.cache.read("device-discovery", self.connection))

    def test_connection_count_is_bounded_and_keeps_the_newest_connection(self):
        cache = ReportCache(self.root, username="Alice", max_connections=1)
        cache.write("records-report", self.connection, {"value": 1})
        other = {"type": "enterprise", "host": "other.example.test"}

        cache.write("records-report", other, {"value": 2})

        self.assertIsNone(cache.read("records-report", self.connection))
        self.assertEqual(cache.read("records-report", other)["payload"], {"value": 2})


class ReportCacheRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.original_sessions = main.sessions
        self.original_cache = main.report_cache
        main.sessions = SessionStore(ttl_seconds=60, max_sessions=8)
        main.report_cache = ReportCache(Path(self.temp.name), username="route-user")
        self.addCleanup(setattr, main, "sessions", self.original_sessions)
        self.addCleanup(setattr, main, "report_cache", self.original_cache)
        self.client = self.enterContext(TestClient(main.app, base_url="http://127.0.0.1"))

    def connect(self, host: str = "sensor.example.test") -> DummyClient:
        connected = DummyClient(host)
        workspace_id = main.sessions.ensure()
        main.sessions.attach(workspace_id, connected)
        self.client.cookies.set(main.SESSION_COOKIE, workspace_id)
        return connected

    def test_route_round_trip_uses_normalized_connection_metadata(self):
        self.connect()
        payload = {"report": {"source_type": "api", "metrics": {}}}

        saved = self.client.put("/backend/report-cache/system-health", json=payload)
        loaded = self.client.get("/backend/report-cache/system-health")

        self.assertEqual(saved.status_code, 200)
        self.assertEqual(loaded.status_code, 200)
        self.assertTrue(loaded.json()["cached"])
        self.assertEqual(loaded.json()["payload"], payload)
        self.assertEqual(
            loaded.json()["connectionId"],
            connection_cache_id({"type": "enterprise", "host": "sensor.example.test"}),
        )

    def test_route_does_not_return_another_connections_cache(self):
        first = self.connect("one.example.test")
        self.client.put("/backend/report-cache/device-discovery", json={"total": 1})
        workspace_id = self.client.cookies.get(main.SESSION_COOKIE)
        second = DummyClient("two.example.test")
        main.sessions.attach(workspace_id, second)

        response = self.client.get("/backend/report-cache/device-discovery")

        self.assertEqual(response.json(), {"cached": False})
        first.aclose.assert_awaited_once_with()

    def test_cache_requires_a_connected_session(self):
        self.client.get("/backend/session")

        response = self.client.get("/backend/report-cache/system-health")

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["detail"]["code"], "extrahop_not_connected")

    def test_unknown_report_page_is_rejected(self):
        self.connect()

        response = self.client.put("/backend/report-cache/not-a-report", json={})

        self.assertEqual(response.status_code, 404)


class ReportCacheDirectoryTests(unittest.TestCase):
    def test_distribution_layout_puts_cache_beside_custom_themes(self):
        with patch.object(main, "APP_ROOT", Path("/opt/eh-admin-tools/app")), patch.dict(
            main.os.environ, {}, clear=False
        ):
            main.os.environ.pop("EH_REPORT_CACHE_DIR", None)
            self.assertEqual(
                main.resolve_report_cache_dir(),
                Path("/opt/eh-admin-tools/api-response-cache"),
            )

    def test_environment_override_wins(self):
        with patch.dict(main.os.environ, {"EH_REPORT_CACHE_DIR": "/tmp/report-cache"}):
            self.assertEqual(main.resolve_report_cache_dir(), Path("/tmp/report-cache"))


if __name__ == "__main__":
    unittest.main()
