import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
from starlette.requests import Request

import main


def minimal_pdf_payload() -> dict:
    return {
        "report": {
            "generated_at": "2026-07-26T12:00:00Z",
            "appliances": [],
            "metrics": {},
        },
        "style": {
            "transparent": False,
            "colors": {"bg": "#ffffff", "text": "#16151f"},
        },
    }


def request_with_chunks(chunks: list[bytes], headers: list[tuple[bytes, bytes]]) -> Request:
    messages = [
        {
            "type": "http.request",
            "body": chunk,
            "more_body": index < len(chunks) - 1,
        }
        for index, chunk in enumerate(chunks)
    ]

    async def receive():
        if messages:
            return messages.pop(0)
        return {"type": "http.request", "body": b"", "more_body": False}

    return Request(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/backend/system-health/pdf",
            "raw_path": b"/backend/system-health/pdf",
            "query_string": b"",
            "headers": headers,
            "client": ("127.0.0.1", 12345),
            "server": ("127.0.0.1", 8000),
        },
        receive,
    )


class FakePage:
    def __init__(self, fail_at: str | None = None):
        self.fail_at = fail_at
        self.closed = False

    async def set_content(self, html_text, **kwargs):
        del html_text, kwargs
        if self.fail_at == "set_content":
            raise RuntimeError("set_content failed")

    async def pdf(self, **kwargs):
        del kwargs
        if self.fail_at == "pdf":
            raise RuntimeError("pdf failed")
        return b"%PDF-fake"

    async def close(self):
        self.closed = True
        if self.fail_at == "page_close":
            raise RuntimeError("page close failed")


class FakeBrowser:
    def __init__(self, page: FakePage):
        self.page = page
        self.closed = False

    async def new_page(self, **kwargs):
        del kwargs
        return self.page

    async def close(self):
        self.closed = True


class FakePlaywrightContext:
    def __init__(self, browser: FakeBrowser):
        self.browser = browser
        self.chromium = self

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        del exc_type, exc, traceback

    async def launch(self):
        return self.browser


class PdfRequestValidationTests(unittest.IsolatedAsyncioTestCase):
    def test_accepts_compact_summary_projection(self):
        payload = main.SystemHealthPdfRequest.model_validate(minimal_pdf_payload())

        self.assertEqual(payload.report["appliances"], [])
        self.assertEqual(payload.style["colors"]["bg"], "#ffffff")

    def test_rejects_raw_time_series_rows_and_unknown_top_level_fields(self):
        raw_rows = minimal_pdf_payload()
        raw_rows["report"]["metrics"] = {
            "pkts": {"rows": [{"timestamp_ms": 1, "value": 2}], "summary": {}}
        }
        with self.assertRaisesRegex(ValidationError, "send summaries only"):
            main.SystemHealthPdfRequest.model_validate(raw_rows)

        unknown = minimal_pdf_payload()
        unknown["report"]["raw_response"] = {"large": "structure"}
        with self.assertRaisesRegex(ValidationError, "unsupported report fields"):
            main.SystemHealthPdfRequest.model_validate(unknown)

    def test_rejects_oversized_collections_and_strings(self):
        too_many_appliances = minimal_pdf_payload()
        too_many_appliances["report"]["appliances"] = [
            {"id": str(index)} for index in range(main.MAX_PDF_APPLIANCES + 1)
        ]
        with self.assertRaisesRegex(ValidationError, "appliances exceeds"):
            main.SystemHealthPdfRequest.model_validate(too_many_appliances)

        oversized_string = minimal_pdf_payload()
        oversized_string["report"]["errors"] = ["x" * (main.MAX_PDF_STRING_LENGTH + 1)]
        with self.assertRaisesRegex(ValidationError, "character limit"):
            main.SystemHealthPdfRequest.model_validate(oversized_string)

    async def test_streamed_body_limit_is_enforced_before_json_validation(self):
        request = request_with_chunks(
            [b"x" * 40, b"y" * 30],
            [(b"content-type", b"application/json")],
        )
        with patch.object(main, "MAX_PDF_REQUEST_BYTES", 64):
            with self.assertRaises(HTTPException) as raised:
                await main.parse_system_health_pdf_request(request)

        self.assertEqual(raised.exception.status_code, 413)


class PdfRendererLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def render_with(self, fail_at: str | None = None):
        page = FakePage(fail_at)
        browser = FakeBrowser(page)

        def factory():
            return FakePlaywrightContext(browser)

        result = await main.render_system_health_pdf_bytes("<html></html>", playwright_factory=factory)
        return result, page, browser

    async def test_success_closes_page_and_browser(self):
        result, page, browser = await self.render_with()

        self.assertEqual(result, b"%PDF-fake")
        self.assertTrue(page.closed)
        self.assertTrue(browser.closed)

    async def test_render_failures_close_page_and_browser(self):
        for fail_at in ("set_content", "pdf"):
            with self.subTest(fail_at=fail_at):
                page = FakePage(fail_at)
                browser = FakeBrowser(page)

                def factory():
                    return FakePlaywrightContext(browser)

                with self.assertRaises(RuntimeError):
                    await main.render_system_health_pdf_bytes("<html></html>", playwright_factory=factory)

                self.assertTrue(page.closed)
                self.assertTrue(browser.closed)

    async def test_page_close_failure_still_closes_browser(self):
        page = FakePage("page_close")
        browser = FakeBrowser(page)

        def factory():
            return FakePlaywrightContext(browser)

        result = await main.render_system_health_pdf_bytes("<html></html>", playwright_factory=factory)

        self.assertEqual(result, b"%PDF-fake")
        self.assertTrue(page.closed)
        self.assertTrue(browser.closed)

    async def test_busy_semaphore_times_out_without_calling_renderer(self):
        renderer = AsyncMock(return_value=b"never")

        with self.assertRaises(main.PdfRenderBusyError):
            await main.render_system_health_pdf_bounded(
                "<html></html>",
                renderer=renderer,
                semaphore=asyncio.Semaphore(0),
                acquire_timeout=0.001,
                render_timeout=1,
            )

        renderer.assert_not_awaited()

    async def test_render_timeout_releases_semaphore(self):
        semaphore = asyncio.Semaphore(1)

        async def never_finishes(_):
            await asyncio.Event().wait()

        with self.assertRaises(main.PdfRenderTimeoutError):
            await main.render_system_health_pdf_bounded(
                "<html></html>",
                renderer=never_finishes,
                semaphore=semaphore,
                acquire_timeout=1,
                render_timeout=0.001,
            )

        await asyncio.wait_for(semaphore.acquire(), timeout=0.1)


class PdfRouteAndLifespanTests(unittest.IsolatedAsyncioTestCase):
    async def test_lifespan_closes_session_store(self):
        store = AsyncMock()
        logger = unittest.mock.Mock()
        with (
            patch.object(main, "sessions", store),
            patch.object(main, "api_response_logger", logger),
        ):
            async with main.app_lifespan(main.app):
                pass

        store.aclose.assert_awaited_once_with()
        logger.close.assert_called_once_with()


class PdfRouteResponseTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app, base_url="http://127.0.0.1")

    def test_busy_renderer_returns_retryable_503(self):
        with (
            patch("main.get_session_client", return_value=object()),
            patch(
                "main.render_system_health_pdf_bounded",
                new=AsyncMock(side_effect=main.PdfRenderBusyError("busy")),
            ),
        ):
            response = self.client.post("/backend/system-health/pdf", json=minimal_pdf_payload())

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.headers["retry-after"], str(max(1, round(main.PDF_RENDER_ACQUIRE_TIMEOUT_SECONDS))))

    def test_raw_rows_are_rejected_before_renderer_runs(self):
        payload = minimal_pdf_payload()
        payload["report"]["metrics"] = {"pkts": {"rows": [{"value": 1}]}}
        renderer = AsyncMock(return_value=b"%PDF-fake")
        with (
            patch("main.get_session_client", return_value=object()),
            patch("main.render_system_health_pdf_bounded", new=renderer),
        ):
            response = self.client.post("/backend/system-health/pdf", json=payload)

        self.assertEqual(response.status_code, 422)
        renderer.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
