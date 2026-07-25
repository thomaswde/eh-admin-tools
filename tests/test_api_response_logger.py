import json
import tempfile
import time
import unittest
from pathlib import Path

import httpx

from backend.api_response_logger import ApiResponseLogger


class ApiResponseLoggerTests(unittest.TestCase):
    def test_error_logging_includes_the_redacted_response_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "responses.jsonl"
            logger = ApiResponseLogger(path, "errors")
            request = httpx.Request("GET", "https://sensor.example.test/api/v1/metrics/next/77")
            response = httpx.Response(
                500,
                request=request,
                json={"error_message": "remote sensor failed", "token": "secret"},
            )

            logger.log_response(
                method="GET",
                endpoint="/api/v1/metrics/next/77",
                response=response,
                started_at=time.perf_counter(),
            )

            entry = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(entry["response"]["error_message"], "remote sensor failed")
            self.assertEqual(entry["response"]["token"], "[redacted]")
            self.assertEqual(entry["response_shape"]["error_message"], "string")
