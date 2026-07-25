import asyncio
import secrets
import time
from dataclasses import dataclass
from threading import Lock

from backend.extrahop_client import ExtraHopClient


@dataclass
class SessionEntry:
    client: ExtraHopClient
    created_at: float
    last_accessed_at: float


class SessionStore:
    def __init__(self, ttl_seconds: int = 12 * 60 * 60, max_sessions: int = 32) -> None:
        self.ttl_seconds = max(60, int(ttl_seconds))
        self.max_sessions = max(1, int(max_sessions))
        self._sessions: dict[str, SessionEntry] = {}
        self._lock = Lock()
        self._close_tasks: set[asyncio.Task[None]] = set()

    def create(self, client: ExtraHopClient, replace_session_id: str | None = None) -> str:
        session_id, removed_clients = self._create(client, replace_session_id)
        self._schedule_closes(removed_clients)
        return session_id

    async def acreate(self, client: ExtraHopClient, replace_session_id: str | None = None) -> str:
        session_id, removed_clients = self._create(client, replace_session_id)
        await self._close_clients(removed_clients)
        return session_id

    def _create(
        self,
        client: ExtraHopClient,
        replace_session_id: str | None,
    ) -> tuple[str, list[ExtraHopClient]]:
        now = time.monotonic()
        session_id = secrets.token_urlsafe(32)
        removed_clients: list[ExtraHopClient] = []
        with self._lock:
            removed_clients.extend(self._prune_locked(now))
            if replace_session_id:
                replaced = self._sessions.pop(replace_session_id, None)
                if replaced:
                    removed_clients.append(replaced.client)
            while len(self._sessions) >= self.max_sessions:
                oldest_id = min(
                    self._sessions,
                    key=lambda key: self._sessions[key].last_accessed_at,
                )
                removed_clients.append(self._sessions.pop(oldest_id).client)
            self._sessions[session_id] = SessionEntry(
                client=client,
                created_at=now,
                last_accessed_at=now,
            )
        return session_id, removed_clients

    def get(self, session_id: str | None) -> ExtraHopClient | None:
        if not session_id:
            return None

        now = time.monotonic()
        removed_clients: list[ExtraHopClient]
        with self._lock:
            removed_clients = self._prune_locked(now)
            entry = self._sessions.get(session_id)
            if not entry:
                client = None
            else:
                entry.last_accessed_at = now
                client = entry.client
        self._schedule_closes(removed_clients)
        return client

    def delete(self, session_id: str | None) -> None:
        if not session_id:
            return
        with self._lock:
            entry = self._sessions.pop(session_id, None)
        self._schedule_closes([entry.client] if entry else [])

    async def adelete(self, session_id: str | None) -> None:
        if not session_id:
            return
        with self._lock:
            entry = self._sessions.pop(session_id, None)
        await self._close_clients([entry.client] if entry else [])

    def __len__(self) -> int:
        with self._lock:
            removed_clients = self._prune_locked(time.monotonic())
            length = len(self._sessions)
        self._schedule_closes(removed_clients)
        return length

    async def aclose(self) -> None:
        with self._lock:
            clients = [entry.client for entry in self._sessions.values()]
            self._sessions.clear()
        await self._close_clients(clients)
        await self.wait_for_pending_closes()

    async def wait_for_pending_closes(self) -> None:
        if self._close_tasks:
            await asyncio.gather(*tuple(self._close_tasks), return_exceptions=True)

    def _prune_locked(self, now: float) -> list[ExtraHopClient]:
        expired = [
            session_id
            for session_id, entry in self._sessions.items()
            if now - entry.last_accessed_at >= self.ttl_seconds
        ]
        removed_clients = []
        for session_id in expired:
            removed_clients.append(self._sessions.pop(session_id).client)
        return removed_clients

    @staticmethod
    async def _close_clients(clients: list[ExtraHopClient]) -> None:
        closers = [
            client.aclose()
            for client in clients
            if callable(getattr(client, "aclose", None))
        ]
        if closers:
            await asyncio.gather(*closers, return_exceptions=True)

    def _schedule_closes(self, clients: list[ExtraHopClient]) -> None:
        if not clients:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            asyncio.run(self._close_clients(clients))
            return
        task = loop.create_task(self._close_clients(clients))
        self._close_tasks.add(task)
        task.add_done_callback(self._close_tasks.discard)
