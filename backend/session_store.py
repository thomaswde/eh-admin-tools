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

    def create(self, client: ExtraHopClient, replace_session_id: str | None = None) -> str:
        now = time.monotonic()
        session_id = secrets.token_urlsafe(32)
        with self._lock:
            self._prune_locked(now)
            if replace_session_id:
                self._sessions.pop(replace_session_id, None)
            while len(self._sessions) >= self.max_sessions:
                oldest_id = min(
                    self._sessions,
                    key=lambda key: self._sessions[key].last_accessed_at,
                )
                self._sessions.pop(oldest_id, None)
            self._sessions[session_id] = SessionEntry(
                client=client,
                created_at=now,
                last_accessed_at=now,
            )
        return session_id

    def get(self, session_id: str | None) -> ExtraHopClient | None:
        if not session_id:
            return None

        now = time.monotonic()
        with self._lock:
            self._prune_locked(now)
            entry = self._sessions.get(session_id)
            if not entry:
                return None
            entry.last_accessed_at = now
            return entry.client

    def delete(self, session_id: str | None) -> None:
        if not session_id:
            return
        with self._lock:
            self._sessions.pop(session_id, None)

    def __len__(self) -> int:
        with self._lock:
            self._prune_locked(time.monotonic())
            return len(self._sessions)

    def _prune_locked(self, now: float) -> None:
        expired = [
            session_id
            for session_id, entry in self._sessions.items()
            if now - entry.last_accessed_at >= self.ttl_seconds
        ]
        for session_id in expired:
            self._sessions.pop(session_id, None)
