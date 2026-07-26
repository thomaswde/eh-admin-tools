import asyncio
import unittest
from collections import deque
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request

import main
from backend.extrahop_client import ExtraHopApiError


class ReceiveStream:
    def __init__(self):
        self.messages = deque([
            {"type": "http.request", "body": b"", "more_body": False},
        ])
        self.next_message = asyncio.Queue()
        self.waiting = asyncio.Event()
        self.active_waiters = 0
        self.cancelled_waiters = 0

    async def receive(self):
        if self.messages:
            return self.messages.popleft()
        self.active_waiters += 1
        self.waiting.set()
        try:
            return await self.next_message.get()
        except asyncio.CancelledError:
            self.cancelled_waiters += 1
            raise
        finally:
            self.active_waiters -= 1

    async def disconnect(self):
        await self.next_message.put({"type": "http.disconnect"})


def build_request(stream):
    return Request(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/backend/extrahop/api/v1/metrics/next/198865",
            "raw_path": b"/backend/extrahop/api/v1/metrics/next/198865",
            "query_string": b"",
            "headers": [],
            "client": ("127.0.0.1", 12345),
            "server": ("127.0.0.1", 8000),
        },
        stream.receive,
    )


class ImmediateSuccessClient:
    async def request(self, *args, **kwargs):
        return {"stats": []}


class ImmediateErrorClient:
    async def request(self, *args, **kwargs):
        raise ExtraHopApiError(
            "API request failed: 500 - gzip: invalid header",
            500,
            {"response": {"error_message": "gzip: invalid header"}},
        )


class SlowClient:
    def __init__(self):
        self.started = asyncio.Event()
        self.cancelled = asyncio.Event()

    async def request(self, *args, **kwargs):
        self.started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.cancelled.set()
            raise


class ProxyDisconnectTests(unittest.IsolatedAsyncioTestCase):
    async def call_proxy(self, stream, client):
        with patch("main.get_session_client", return_value=client):
            return await asyncio.wait_for(
                main.proxy_extrahop_request(
                    "api/v1/metrics/next/198865",
                    build_request(stream),
                    "session-id",
                ),
                timeout=1,
            )

    async def test_immediate_success_returns_without_waiting_for_disconnect(self):
        stream = ReceiveStream()

        result = await self.call_proxy(stream, ImmediateSuccessClient())

        self.assertEqual(result, {"stats": []})
        self.assertEqual(stream.active_waiters, 0)

    async def test_immediate_api_error_returns_without_waiting_for_disconnect(self):
        stream = ReceiveStream()

        with self.assertRaises(HTTPException) as raised:
            await self.call_proxy(stream, ImmediateErrorClient())

        self.assertEqual(raised.exception.status_code, 500)
        self.assertIn("gzip: invalid header", str(raised.exception.detail))
        self.assertEqual(stream.active_waiters, 0)

    async def test_browser_disconnect_cancels_slow_upstream_request(self):
        stream = ReceiveStream()
        client = SlowClient()
        proxy_task = asyncio.create_task(self.call_proxy(stream, client))
        await asyncio.wait_for(client.started.wait(), timeout=1)
        await asyncio.wait_for(stream.waiting.wait(), timeout=1)

        await stream.disconnect()

        with self.assertRaises(HTTPException) as raised:
            await asyncio.wait_for(proxy_task, timeout=1)
        self.assertEqual(raised.exception.status_code, 499)
        self.assertTrue(client.cancelled.is_set())
        self.assertEqual(stream.active_waiters, 0)

    async def test_disconnect_watcher_is_cancelled_and_awaited_after_response(self):
        stream = ReceiveStream()
        await self.call_proxy(stream, ImmediateSuccessClient())

        await asyncio.sleep(0)

        self.assertEqual(stream.cancelled_waiters, 1)
        self.assertEqual(stream.active_waiters, 0)


if __name__ == "__main__":
    unittest.main()
