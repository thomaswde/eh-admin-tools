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

## Saved ExtraHop connections

After a manual connection authenticates successfully, its credentials are saved through the
operating-system credential service: macOS Keychain or Linux Secret Service. The browser receives
only the tenant or hostname, an opaque connection ID, and the active session cookie. If the
operating-system credential service is unavailable, the active connection still works and the UI
shows that it could not be saved.

The app also reads a local `.env` file at startup. Copy `.env.example` to `.env`, replace the
example values, and restart:

```bash
cp .env.example .env
```

Connections use numbered variables, so additional RevealX 360 or Enterprise entries can use
indexes `2`, `3`, and so on. `.env` is ignored by Git, but it contains plaintext secrets; prefer
the connection form and operating-system credential store for normal use.

## Tests

```bash
python -m unittest discover -s tests -v
node --test tests/*.test.js
for file in $(find js -name '*.js'); do node --check "$file"; done
```

## System Health collection limits

System Health uses one absolute report window, one batched time-series request for packet, byte,
and aligned trigger-cycle metrics, and one per-object totals request for trigger drops. The client
automatically coarsens the selected cycle to keep each sensor at or below 10,000 buckets and the
whole time-series response at or below 500,000 scalar points. A request that still exceeds the
report-wide budget at the 24-hour cycle is rejected before it reaches ExtraHop.

## API response logging

Use the API Logging control in the sidebar to write proxied ExtraHop API responses to `logs/api-responses.jsonl`, or to the launcher-managed state directory when using `start.sh`.

- `Off`: no response log entries.
- `Errors`: failed API responses and network errors only.
- `Metadata`: every response with status, timing, byte count, and response shape.
- `Full`: every response with parsed response bodies and credential-shaped fields redacted.

Full response logs can still contain sensitive operational data. Review them before sharing. API response logging defaults to `Errors`; the default file path can be changed with `EH_API_RESPONSE_LOG`, and startup verbosity with `EH_API_LOG_VERBOSITY`.

## Security defaults

- The server binds to `127.0.0.1` only.
- Browser sessions use HTTP-only, SameSite cookies and expire after 12 idle hours.
- RevealX 360 tenant names are restricted to one DNS label.
- Enterprise TLS certificates are verified by default. The UI provides an explicit opt-in for a known self-signed lab certificate.
- API credentials remain server-side, password fields are cleared, and successful manual
  connections are persisted through macOS Keychain or Linux Secret Service.
- Product-catalog file overrides are accepted only through the startup environment variable `EH_CATALOG_PATH`.

## Theme

The UI follows the operating system theme by default. The control in the top-right switches
between Light, Auto, and Dark, and the choice persists in `localStorage`.

Charts in the System Health report are deliberately independent of the app theme. Their palette
is set in the report's own Chart style panel so exported PNGs, PDFs, and PowerPoint decks use the
same resolved colors regardless of how the app is being viewed. PowerPoint export is generated
in the browser: charts are portable high-resolution PNGs, while slide text and appendix tables
remain editable.

## Styling

`css/styles.css` is the only stylesheet. It defines semantic tokens in `:root`, overrides them
under `[data-theme="dark"]`, and builds every component from those tokens. There is no CSS build
step and no utility-class framework.

## Current architecture

- `main.py` serves the static UI and exposes the local backend API.
- `backend/extrahop_client.py` owns RevealX 360 OAuth, Enterprise API-key requests, token refresh, TLS policy, and request forwarding.
- `backend/session_store.py` keeps bounded, expiring server-side sessions keyed by an HTTP-only browser cookie.
- `js/api-client/extrahop-api.js` preserves the existing frontend API surface while calling the local backend.
- `scripts/build_dist.py` creates the end-user ZIP from an explicit file allowlist.
