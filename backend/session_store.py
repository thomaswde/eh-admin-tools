import asyncio
from collections.abc import Awaitable, Callable
import inspect
import secrets
import time
from dataclasses import dataclass
from threading import Lock

from backend.extrahop_client import ExtraHopClient


SessionRemoveCallback = Callable[[str], Awaitable[None] | None]


@dataclass
class SessionEntry:
    client: ExtraHopClient | None
    created_at: float
    last_accessed_at: float


class SessionStore:
    def __init__(
        self,
        ttl_seconds: int = 12 * 60 * 60,
        max_sessions: int = 32,
        remove_callback: SessionRemoveCallback | None = None,
    ) -> None:
        self.ttl_seconds = max(60, int(ttl_seconds))
        self.max_sessions = max(1, int(max_sessions))
        self._sessions: dict[str, SessionEntry] = {}
        self._lock = Lock()
        self._remove_callback = remove_callback
        self._close_tasks: set[asyncio.Task[None]] = set()

    def set_remove_callback(self, callback: SessionRemoveCallback | None) -> None:
        with self._lock:
            self._remove_callback = callback

    def create(
        self,
        client: ExtraHopClient | None = None,
        replace_session_id: str | None = None,
    ) -> str:
        session_id, removed_sessions = self._create(client, replace_session_id)
        self._schedule_cleanup(removed_sessions)
        return session_id

    async def acreate(
        self,
        client: ExtraHopClient | None = None,
        replace_session_id: str | None = None,
    ) -> str:
        session_id, removed_sessions = self._create(client, replace_session_id)
        await self._cleanup_removed(removed_sessions)
        return session_id

    def _create(
        self,
        client: ExtraHopClient | None,
        replace_session_id: str | None,
    ) -> tuple[str, list[tuple[str, ExtraHopClient | None]]]:
        now = time.monotonic()
        session_id = secrets.token_urlsafe(32)
        removed_sessions: list[tuple[str, ExtraHopClient | None]] = []
        with self._lock:
            removed_sessions.extend(self._prune_locked(now))
            if replace_session_id:
                replaced = self._sessions.pop(replace_session_id, None)
                if replaced:
                    removed_sessions.append((replace_session_id, replaced.client))
            while len(self._sessions) >= self.max_sessions:
                oldest_id = min(
                    self._sessions,
                    key=lambda key: self._sessions[key].last_accessed_at,
                )
                removed_sessions.append((oldest_id, self._sessions.pop(oldest_id).client))
            self._sessions[session_id] = SessionEntry(
                client=client,
                created_at=now,
                last_accessed_at=now,
            )
        return session_id, removed_sessions

    def ensure(self, session_id: str | None = None) -> str:
        workspace_id, removed_sessions = self._ensure(session_id)
        self._schedule_cleanup(removed_sessions)
        return workspace_id

    async def aensure(self, session_id: str | None = None) -> str:
        workspace_id, removed_sessions = self._ensure(session_id)
        await self._cleanup_removed(removed_sessions)
        return workspace_id

    def _ensure(
        self,
        session_id: str | None,
    ) -> tuple[str, list[tuple[str, ExtraHopClient | None]]]:
        now = time.monotonic()
        removed_sessions: list[tuple[str, ExtraHopClient | None]] = []
        with self._lock:
            removed_sessions.extend(self._prune_locked(now))
            entry = self._sessions.get(session_id) if session_id else None
            if entry:
                entry.last_accessed_at = now
                return session_id, removed_sessions

            while len(self._sessions) >= self.max_sessions:
                oldest_id = min(
                    self._sessions,
                    key=lambda key: self._sessions[key].last_accessed_at,
                )
                removed = self._sessions.pop(oldest_id)
                removed_sessions.append((oldest_id, removed.client))

            workspace_id = secrets.token_urlsafe(32)
            self._sessions[workspace_id] = SessionEntry(
                client=None,
                created_at=now,
                last_accessed_at=now,
            )
        return workspace_id, removed_sessions

    def attach(self, session_id: str | None, client: ExtraHopClient) -> str:
        workspace_id, removed_sessions, detached_clients = self._attach(
            session_id,
            client,
        )
        self._schedule_cleanup(removed_sessions)
        self._schedule_client_close(detached_clients)
        return workspace_id

    async def aattach(self, session_id: str | None, client: ExtraHopClient) -> str:
        workspace_id, removed_sessions, detached_clients = self._attach(
            session_id,
            client,
        )
        await self._cleanup_removed(removed_sessions)
        await self._close_clients(detached_clients)
        return workspace_id

    def _attach(
        self,
        session_id: str | None,
        client: ExtraHopClient,
    ) -> tuple[
        str,
        list[tuple[str, ExtraHopClient | None]],
        list[ExtraHopClient | None],
    ]:
        now = time.monotonic()
        removed_sessions: list[tuple[str, ExtraHopClient | None]] = []
        detached_clients: list[ExtraHopClient | None] = []
        with self._lock:
            removed_sessions.extend(self._prune_locked(now))
            entry = self._sessions.get(session_id) if session_id else None
            if not entry:
                while len(self._sessions) >= self.max_sessions:
                    oldest_id = min(
                        self._sessions,
                        key=lambda key: self._sessions[key].last_accessed_at,
                    )
                    removed = self._sessions.pop(oldest_id)
                    removed_sessions.append((oldest_id, removed.client))
                session_id = secrets.token_urlsafe(32)
                entry = SessionEntry(
                    client=None,
                    created_at=now,
                    last_accessed_at=now,
                )
                self._sessions[session_id] = entry
            if entry.client is not None and entry.client is not client:
                detached_clients.append(entry.client)
            entry.client = client
            entry.last_accessed_at = now
        return session_id, removed_sessions, detached_clients

    def detach(self, session_id: str | None) -> bool:
        detached, removed_sessions, detached_clients = self._detach(session_id)
        self._schedule_cleanup(removed_sessions)
        self._schedule_client_close(detached_clients)
        return detached

    async def adetach(self, session_id: str | None) -> bool:
        detached, removed_sessions, detached_clients = self._detach(session_id)
        await self._cleanup_removed(removed_sessions)
        await self._close_clients(detached_clients)
        return detached

    def _detach(
        self,
        session_id: str | None,
    ) -> tuple[
        bool,
        list[tuple[str, ExtraHopClient | None]],
        list[ExtraHopClient | None],
    ]:
        now = time.monotonic()
        detached_clients: list[ExtraHopClient | None] = []
        with self._lock:
            removed_sessions = self._prune_locked(now)
            entry = self._sessions.get(session_id) if session_id else None
            if not entry:
                return False, removed_sessions, detached_clients
            if entry.client is not None:
                detached_clients.append(entry.client)
            entry.client = None
            entry.last_accessed_at = now
        return bool(detached_clients), removed_sessions, detached_clients

    def has_workspace(self, session_id: str | None) -> bool:
        if not session_id:
            return False

        now = time.monotonic()
        with self._lock:
            removed_sessions = self._prune_locked(now)
            entry = self._sessions.get(session_id)
            if entry:
                entry.last_accessed_at = now
        self._schedule_cleanup(removed_sessions)
        return entry is not None

    def get(self, session_id: str | None) -> ExtraHopClient | None:
        if not session_id:
            return None

        now = time.monotonic()
        removed_sessions: list[tuple[str, ExtraHopClient | None]]
        with self._lock:
            removed_sessions = self._prune_locked(now)
            entry = self._sessions.get(session_id)
            if not entry:
                client = None
            else:
                entry.last_accessed_at = now
                client = entry.client
        self._schedule_cleanup(removed_sessions)
        return client

    def delete(self, session_id: str | None) -> None:
        if not session_id:
            return
        with self._lock:
            entry = self._sessions.pop(session_id, None)
        self._schedule_cleanup([(session_id, entry.client)] if entry else [])

    async def adelete(self, session_id: str | None) -> None:
        if not session_id:
            return
        with self._lock:
            entry = self._sessions.pop(session_id, None)
        await self._cleanup_removed([(session_id, entry.client)] if entry else [])

    def __len__(self) -> int:
        with self._lock:
            removed_sessions = self._prune_locked(time.monotonic())
            length = len(self._sessions)
        self._schedule_cleanup(removed_sessions)
        return length

    async def aclose(self) -> None:
        with self._lock:
            removed_sessions = [
                (session_id, entry.client)
                for session_id, entry in self._sessions.items()
            ]
            self._sessions.clear()
        await self._cleanup_removed(removed_sessions)
        await self.wait_for_pending_closes()

    async def wait_for_pending_closes(self) -> None:
        if self._close_tasks:
            await asyncio.gather(*tuple(self._close_tasks), return_exceptions=True)

    def _prune_locked(
        self,
        now: float,
    ) -> list[tuple[str, ExtraHopClient | None]]:
        expired = [
            session_id
            for session_id, entry in self._sessions.items()
            if now - entry.last_accessed_at >= self.ttl_seconds
        ]
        removed_sessions = []
        for session_id in expired:
            removed_sessions.append((session_id, self._sessions.pop(session_id).client))
        return removed_sessions

    async def _cleanup_removed(
        self,
        removed_sessions: list[tuple[str, ExtraHopClient | None]],
    ) -> None:
        if not removed_sessions:
            return
        callback = self._remove_callback
        if callback:
            callback_awaitables = []
            for session_id, _ in removed_sessions:
                try:
                    result = callback(session_id)
                except Exception:
                    continue
                if inspect.isawaitable(result):
                    callback_awaitables.append(result)
            if callback_awaitables:
                await asyncio.gather(*callback_awaitables, return_exceptions=True)
        await self._close_clients([client for _, client in removed_sessions])

    @staticmethod
    async def _close_clients(clients: list[ExtraHopClient | None]) -> None:
        closers = [
            client.aclose()
            for client in clients
            if callable(getattr(client, "aclose", None))
        ]
        if closers:
            await asyncio.gather(*closers, return_exceptions=True)

    def _schedule_cleanup(
        self,
        removed_sessions: list[tuple[str, ExtraHopClient | None]],
    ) -> None:
        if not removed_sessions:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            asyncio.run(self._cleanup_removed(removed_sessions))
            return
        task = loop.create_task(self._cleanup_removed(removed_sessions))
        self._close_tasks.add(task)
        task.add_done_callback(self._close_tasks.discard)

    def _schedule_client_close(self, clients: list[ExtraHopClient | None]) -> None:
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
