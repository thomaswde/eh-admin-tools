# ExtraHop Admin Tools

FastAPI-backed ExtraHop administration tools. The browser UI talks only to a local Python service; ExtraHop API calls and credentials do not pass through a third-party proxy.

## Recommended local start

Requires Python 3.10 or newer and internet access on the first launch.

```bash
./start.sh
```

The launcher creates a private, versioned Python environment outside the repository, installs the locked dependencies, installs Chromium for PDF export when possible, selects a free loopback port, opens the browser, and keeps the server in the foreground. Never open `index.html` directly.

Useful options:

```bash
./start.sh --no-browser
./start.sh --port 8005
./start.sh --diagnostics
./start.sh --reset-runtime
./start.sh --skip-pdf-setup
```

## Developer start

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.lock
python -m playwright install chromium
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000>.

## Tests

```bash
python -m unittest discover -s tests -v
for file in $(find js -name '*.js'); do node --check "$file"; done
```

## API response logging

Use the API Logging control in the sidebar to write proxied ExtraHop API responses to `logs/api-responses.jsonl`, or to the launcher-managed state directory when using `start.sh`.

- `Off`: no response log entries.
- `Errors`: failed API responses and network errors only.
- `Metadata`: every response with status, timing, byte count, and response shape.
- `Full`: every response with parsed response bodies and credential-shaped fields redacted.

Full response logs can still contain sensitive operational data. Review them before sharing. The default file path can be changed with `EH_API_RESPONSE_LOG`, and startup verbosity with `EH_API_LOG_VERBOSITY`.

## Security defaults

- The server binds to `127.0.0.1` only.
- Browser sessions use HTTP-only, SameSite cookies and expire after 12 idle hours.
- RevealX 360 tenant names are restricted to one DNS label.
- Enterprise TLS certificates are verified by default. The UI provides an explicit opt-in for a known self-signed lab certificate.
- API credentials remain server-side after login and password fields are cleared.
- Product-catalog file overrides are accepted only through the startup environment variable `EH_CATALOG_PATH`.

## Current architecture

- `main.py` serves the static UI and exposes the local backend API.
- `backend/extrahop_client.py` owns RevealX 360 OAuth, Enterprise API-key requests, token refresh, TLS policy, and request forwarding.
- `backend/session_store.py` keeps bounded, expiring server-side sessions keyed by an HTTP-only browser cookie.
- `js/api-client/extrahop-api.js` preserves the existing frontend API surface while calling the local backend.
- `scripts/build_dist.py` creates the end-user ZIP from an explicit file allowlist.
