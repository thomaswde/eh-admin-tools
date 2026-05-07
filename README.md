# ExtraHop Admin Tools Thick

FastAPI-backed version of ExtraHop Admin Tools. The UI remains browser-based, but ExtraHop API calls now run through a local Python server so users do not need CORS configuration or the legacy AWS proxy.

## Run locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload
```

Open http://127.0.0.1:8000.

## API response logging

Use the API Logging control in the sidebar to write proxied ExtraHop API responses to `logs/api-responses.jsonl`.

- `Off`: no response log entries.
- `Errors`: failed API responses and network errors only.
- `Metadata`: every response with status, timing, byte count, and response shape.
- `Full`: every response with parsed response bodies and redacted credential-like fields.

The default file path can be changed with `EH_API_RESPONSE_LOG`, and the startup verbosity can be changed with `EH_API_LOG_VERBOSITY`.

## Current architecture

- `main.py` serves the existing static UI and exposes the local backend API.
- `backend/extrahop_client.py` owns RevealX 360 OAuth, Enterprise API key requests, token refresh, and request forwarding.
- `backend/session_store.py` keeps in-memory server-side sessions keyed by an HTTP-only browser cookie.
- `js/api-client/extrahop-api.js` preserves the existing frontend API surface while calling the local FastAPI backend.
