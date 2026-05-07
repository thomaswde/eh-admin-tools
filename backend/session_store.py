import secrets

from backend.extrahop_client import ExtraHopClient


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, ExtraHopClient] = {}

    def create(self, client: ExtraHopClient) -> str:
        session_id = secrets.token_urlsafe(32)
        self._sessions[session_id] = client
        return session_id

    def get(self, session_id: str | None) -> ExtraHopClient | None:
        if not session_id:
            return None
        return self._sessions.get(session_id)

    def delete(self, session_id: str | None) -> None:
        if session_id:
            self._sessions.pop(session_id, None)
