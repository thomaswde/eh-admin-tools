# ExtraHop Admin Tools

FastAPI-backed ExtraHop administration tools for managing complex ExtraHop deployments with support for multi-tenancy. 

## Recommended local start

Requires Python 3.10 or newer and internet access on the first launch.

```bash
./start.sh
```

The launcher creates a private, versioned Python environment, installs the locked dependencies, installs Chromium for PDF export when possible, selects a free local port, opens the browser, and keeps the server in the foreground.

Useful options:

```bash
./start.sh --no-browser
./start.sh --port 8005
./start.sh --diagnostics
./start.sh --reset-runtime
./start.sh --skip-pdf-setup
```

### Windows Subsystem for Linux (WSL 2)

Run `./start.sh` inside WSL, keep that terminal open, and open the printed URL in
the Windows browser. The launcher automatically listens on the WSL virtual
network interface so Windows localhost forwarding and explicit port proxies can
reach it; native Linux and macOS launches remain loopback-only.

## Developer start

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.lock
python -m playwright install chromium
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000>.

## Local workspace and connected mode

The local service creates a workspace as soon as the app opens. 
Without a connection, **Datafeed Analysis** can analyze and export a local classic PCAP,
and **System Health** can load a unified summary CSV and use the same charts, findings, detail
table, CSV, PNG, PDF, and PowerPoint projections as a collected report. Packetstore retrieval,
live System Health collection, detailed API-row export, and the administration tools require an
authenticated RevealX Enterprise or RevealX 360 connection. 

## Saved ExtraHop connections

After a manual connection authenticates successfully, its credentials are saved through the
operating-system credential service: macOS Keychain or Linux Secret Service. The browser receives
only the tenant or hostname, an opaque connection ID, and the HTTP-only workspace cookie. The same
workspace identifier remains in use when an ExtraHop client is attached or detached. If the
operating-system credential service is unavailable, the active connection still works and the UI
shows that it could not be saved.

The app can also read credentials from a local `.env` file at startup. 
Copy `.env.example` to `.env`, replace the example values, and restart:

```bash
cp .env.example .env
```

Connections use numbered variables, so additional RevealX 360 or Enterprise entries can use
indexes `2`, `3`, and so on. `.env`. 
It's recommended to use the connection form and operating-system credential store for normal use.

## Cached reports

After a Device Discovery, Records, or System Health collection completes, the app keeps its latest
canonical result in `api-response-cache` beside `chart-themes`. Reopening that reporting page after
a reload restores the historical result immediately and labels it as cached; generate or run the
report again whenever current data is required. The cache stores completed report data rather than
partial Metrics XID polling responses, so one result always retains its original time window and
collection statuses. System Health caches its compact per-sensor summary, which preserves charts,
findings, tables, PDF, and PowerPoint output without duplicating raw time-series rows. Use a fresh
live report when the detailed **All API data** export is needed.

Entries are organized as `<local-user>/<connection-id>/reports/<report>.json`. Each connection
directory includes a `connection.json` manifest containing only the normalized deployment type and
tenant or host; credentials are never written there. Atomic replacement, a 32 MiB per-report
default, a 512 MiB per-user default, and at most 64 connection directories keep the cache bounded.
Set `EH_REPORT_CACHE_DIR`, `EH_REPORT_CACHE_MAX_ENTRY_BYTES`,
`EH_REPORT_CACHE_MAX_USER_BYTES`, or `EH_REPORT_CACHE_MAX_CONNECTIONS` before startup to change
those defaults. Cached report data can contain sensitive operational details; protect it and
review it before sharing.

```

## API response logging

Use the API Logging control in the sidebar to write proxied ExtraHop API responses to `logs/api-responses.jsonl`, or to the launcher-managed state directory when using `start.sh`.

- `Off`: no response log entries.
- `Errors`: failed API responses and network errors only.
- `Metadata`: every response with status, timing, byte count, and response shape.
- `Full`: every response with request and response previews and credential-shaped fields redacted.

Full response logs can still contain sensitive operational data. Preview and entry sizes are bounded, oversized JSON is not parsed solely for logging, and the log rotates by bytes with a fixed backup count. API response logging defaults to `Errors`; the default file path can be changed with `EH_API_RESPONSE_LOG`, and startup verbosity with `EH_API_LOG_VERBOSITY`.

## Datafeed Analysis

Datafeed Analysis accepts a local classic PCAP without ExtraHop credentials or retrieves
PCAP windows from a connected ExtraHop system. Connected collection uses the same authenticated
server-side client for RevealX Enterprise and RevealX 360. 
Local uploads remain complete without device enrichment; when a client is attached, 
any enrichment is best effort and never changes analytical completeness.

The results report directional TCP flows where the reverse direction was not observed, capture
records that were truncated or sliced, and observed TCP sequence gaps. These are capture-level
observations, not proof of network packet loss. Packetstore traffic can differ from the Packet
Sensor feed, and deployments without a Packetstore return an explicit unavailable result.

Uploads, collection bytes, intervals, packets, flows, findings, runtime, concurrent jobs, result
pages, and retention are bounded. Captures use owner-only generated paths during a job and are
deleted after completion, failure, or cancellation. Results expire after 30 minutes by default.
Operators can use the `EH_PCAP_*` environment variables in `backend/pcap_analyzer/jobs.py` to lower
or deliberately raise individual ceilings.

## Security defaults

- The launcher binds to `127.0.0.1` on native Linux and macOS. Under WSL it binds to the WSL virtual network interfaces so the Windows host can reach it; explicit Windows port proxies should listen on `127.0.0.1` to avoid exposing the app to the LAN.
- Local workspaces use HTTP-only, SameSite cookies, are bounded in count, and expire after 12 idle hours.
- RevealX 360 tenant names are restricted to one DNS label.
- Enterprise TLS certificates are verified by default. The UI provides an explicit opt-in for a known self-signed lab certificate.
- API credentials remain server-side, password fields are cleared, and successful manual
  connections are persisted through macOS Keychain or Linux Secret Service.
- Product-catalog file overrides are accepted only through the startup environment variable `EH_CATALOG_PATH`.
- Proxied ExtraHop request bodies are capped at 64 MiB because the proxy buffers them before forwarding. Set `EH_PROXY_MAX_REQUEST_BYTES` to a positive byte count when an intentional binary upload, such as firmware, requires a different ceiling.

## Theme

The UI follows the operating system theme by default. The control in the top-right switches
between Light, Auto, and Dark, and the choice persists in `localStorage`.

Charts in the System Health report are deliberately independent of the app theme. Their palette
is set in the report's own Chart style panel so exported PNGs, PDFs, and PowerPoint decks use the
same resolved colors regardless of how the app is being viewed. PowerPoint export is generated
in the browser with editable native shapes and text. Decks request Source Sans 3; distributions
include installable Regular and Bold font files because PowerPoint otherwise substitutes a local
font and can change text proportions.

Single-series charts use cyan. Generic categorical charts share one eight-color palette, while
capacity and health charts use the Connected Appliances warning orange and error red. Dark-theme
selected controls stay neutral gray so application chrome does not compete with chart data.

## Styling

`css/styles.css` is the only stylesheet. It defines semantic tokens in `:root`, overrides them
under `[data-theme="dark"]`, and builds every component from those tokens. There is no CSS build
step and no utility-class framework.

## Current architecture

- `main.py` serves the static UI and exposes the local backend API.
- `backend/extrahop_client.py` owns RevealX 360 OAuth, Enterprise API-key requests, token refresh, TLS policy, and request forwarding.
- `backend/build_identity.py` derives source-checkout display versions from Git commit dates and validates packaged `VERSION` metadata.
- `backend/session_store.py` keeps bounded, expiring workspace sessions with an optional authenticated client, keyed by an HTTP-only browser cookie.
- `backend/pcap_analyzer/` owns bounded PCAP parsing, collection jobs, results, CSV, cancellation, and cleanup.
- `backend/report_cache.py` owns connection-scoped, per-user persistence of completed reporting results.
- `js/api-client/extrahop-api.js` preserves the existing frontend API surface while calling the local backend.
- `scripts/build_dist.py` creates the end-user ZIP from an explicit file allowlist.

Cross-cutting contracts and design history:

- [Architecture](docs/architecture.md)
- [Current repository overhaul decision](docs/decisions/2026-07-26-repository-overhaul.md)
- [Historical System Health REST audit](docs/audits/2026-07-26-system-health-rest-api-audit.md)
- [Prototype artifact retention decision](docs/decisions/2026-07-26-prototype-artifacts.md)
