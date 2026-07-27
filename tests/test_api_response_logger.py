import json
import stat
import tempfile
import time
import unittest
from pathlib import Path

import httpx

from backend.api_response_logger import ApiResponseLogger


class TrackingJsonResponse(httpx.Response):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.json_calls = 0

    def json(self, **kwargs):
        self.json_calls += 1
        return super().json(**kwargs)


class ApiResponseLoggerTests(unittest.TestCase):
    def make_logger(self, path: Path, verbosity: str = "errors", **kwargs) -> ApiResponseLogger:
        logger = ApiResponseLogger(path, verbosity, **kwargs)
        self.addCleanup(logger.close)
        return logger

    @staticmethod
    def response(status: int, *, content=None, json_body=None, content_type=None):
        request = httpx.Request("GET", "https://sensor.example.test/api/v1/metrics/next/77")
        headers = {"content-type": content_type} if content_type else None
        if json_body is not None:
            return httpx.Response(status, request=request, json=json_body, headers=headers)
        return httpx.Response(status, request=request, content=content or b"", headers=headers)

    def test_error_logging_includes_redacted_bounded_request_and_response_payloads(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "responses.jsonl"
            logger = self.make_logger(path, "full", max_preview_bytes=512)
            request = httpx.Request(
                "POST",
                "https://sensor.example.test/api/v1/metrics?token=url-secret",
            )
            response = httpx.Response(
                500,
                request=request,
                json={
                    "error_message": "remote sensor failed",
                    "nested": {"token": "response-secret"},
                },
            )

            logger.log_response(
                method="POST",
                endpoint="/api/v1/metrics/next/77",
                response=response,
                started_at=time.perf_counter(),
                request_body={
                    "api-key": "request-secret",
                    "safe": {"password": "also-secret", "value": "kept"},
                    "raw": "token=raw-secret&mode=test",
                },
            )
            self.assertTrue(logger.flush())

            entry = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(entry["response"]["error_message"], "remote sensor failed")
            self.assertEqual(entry["response"]["nested"]["token"], "[redacted]")
            self.assertEqual(entry["request_body"]["api-key"], "[redacted]")
            self.assertEqual(entry["request_body"]["safe"]["password"], "[redacted]")
            self.assertEqual(entry["request_body"]["safe"]["value"], "kept")
            self.assertEqual(entry["request_body"]["raw"], "token=[redacted]&mode=test")
            self.assertNotIn("url-secret", entry["url"])
            self.assertIn("token=[redacted]", entry["url"])
            self.assertEqual(entry["response_shape"]["error_message"], "string")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_only_full_logging_requests_body_capture(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "responses.jsonl"
            logger = self.make_logger(path, "errors")
            self.assertFalse(logger.wants_request_body())
            logger.configure("metadata")
            self.assertFalse(logger.wants_request_body())
            logger.configure("full")
            self.assertTrue(logger.wants_request_body())

    def test_product_keys_are_redacted_from_structured_and_text_response_logging(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "responses.jsonl"
            logger = self.make_logger(path, "full", max_preview_bytes=512)
            product_key = "AAAA-BBBB-CCCC-DDDD"
            response = self.response(
                200,
                json_body=[{"product_key": product_key}],
            )

            logger.log_response(
                method="GET",
                endpoint="/api/v1/appliances/7/productkey",
                response=response,
                started_at=time.perf_counter(),
            )
            self.assertTrue(logger.flush())

            entry = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(entry["response"][0]["product_key"], "[redacted]")
            self.assertNotIn(product_key, path.read_text(encoding="utf-8"))

    def test_oversized_json_response_is_truncated_and_never_parsed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "responses.jsonl"
            logger = self.make_logger(path, "errors", max_preview_bytes=80)
            request = httpx.Request("GET", "https://sensor.example.test/api/v1/devices")
            content = b'{"token":"secret-value","data":"' + (b"x" * 10_000) + b'"}'
            response = TrackingJsonResponse(
                500,
                request=request,
                content=content,
                headers={"content-type": "application/json"},
            )

            logger.log_response(
                method="GET",
                endpoint="/api/v1/devices",
                response=response,
                started_at=time.perf_counter(),
            )
            self.assertTrue(logger.flush())

            entry = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(response.json_calls, 0)
            self.assertTrue(entry["response"]["truncated"])
            self.assertEqual(entry["response"]["preview_bytes"], 80)
            self.assertIn("[redacted]", entry["response"]["preview"])
            self.assertNotIn("secret-value", entry["response"]["preview"])
            self.assertEqual(entry["response_shape"]["type"], "truncated_preview")
            self.assertEqual(entry["response_bytes"], len(content))

    def test_serialized_entries_are_capped_even_when_metadata_is_oversized(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "responses.jsonl"
            logger = self.make_logger(
                path,
                "errors",
                max_preview_bytes=1_024,
                max_entry_bytes=256,
                max_log_bytes=2_048,
            )
            response = self.response(
                500,
                json_body={"message": "m" * 800},
            )

            logger.log_response(
                method="GET",
                endpoint="/api/v1/" + ("very-long/" * 300),
                response=response,
                started_at=time.perf_counter(),
            )
            self.assertTrue(logger.flush())

            line = path.read_bytes()
            self.assertLessEqual(len(line), 256)
            self.assertTrue(json.loads(line)["entry_truncated"])

    def test_rotation_caps_file_size_and_number_of_backups(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "responses.jsonl"
            logger = self.make_logger(
                path,
                "errors",
                max_preview_bytes=128,
                max_entry_bytes=350,
                max_log_bytes=700,
                backup_count=2,
            )
            request = httpx.Request("GET", "https://sensor.example.test/api/v1/devices")

            for number in range(12):
                logger.log_network_error(
                    method="GET",
                    endpoint=f"/api/v1/devices?offset={number}",
                    url=str(request.url),
                    error=httpx.ConnectError(f"connection failure {number}", request=request),
                    started_at=time.perf_counter(),
                )

            self.assertTrue(logger.flush())

            files = [path, Path(f"{path}.1"), Path(f"{path}.2")]
            self.assertTrue(all(candidate.exists() for candidate in files))
            self.assertFalse(Path(f"{path}.3").exists())
            for candidate in files:
                self.assertLessEqual(candidate.stat().st_size, 700)
                self.assertEqual(stat.S_IMODE(candidate.stat().st_mode), 0o600)
                for line in candidate.read_text(encoding="utf-8").splitlines():
                    json.loads(line)

    def test_flush_and_close_drain_the_queue_and_reject_later_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "responses.jsonl"
            logger = ApiResponseLogger(path, "errors", queue_size=2)
            request = httpx.Request("GET", "https://sensor.example.test/api/v1/devices")

            for number in range(2):
                logger.log_network_error(
                    method="GET",
                    endpoint=f"/api/v1/devices/{number}",
                    url=str(request.url),
                    error=httpx.ConnectError(f"failure {number}", request=request),
                    started_at=time.perf_counter(),
                )

            self.assertTrue(logger.flush())
            self.assertEqual(len(path.read_text(encoding="utf-8").splitlines()), 2)
            self.assertTrue(logger.close())
            self.assertTrue(logger.status()["closed"])

            logger.log_network_error(
                method="GET",
                endpoint="/api/v1/devices/after-close",
                url=str(request.url),
                error=httpx.ConnectError("must not be logged", request=request),
                started_at=time.perf_counter(),
            )
            self.assertEqual(len(path.read_text(encoding="utf-8").splitlines()), 2)


if __name__ == "__main__":
    unittest.main()
