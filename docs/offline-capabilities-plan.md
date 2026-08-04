# Offline Capabilities Implementation Plan

Status: proposed implementation plan

Scope: make Datafeed Analysis and the import-driven parts of System Health available without an authenticated ExtraHop connection while keeping upstream API operations explicitly disabled.

## 1. Desired outcome

ExtraHop Admin Tools should open into a useful local mode before the user connects to RevealX Enterprise or RevealX 360.

The completed experience should:

- allow a local classic PCAP to be uploaded, analyzed, reviewed, and exported without ExtraHop credentials;
- allow a System Health unified summary CSV to be loaded and projected through the existing charts, findings, detail table, CSV, PNG, PDF, and PowerPoint outputs;
- keep ExtraHop-backed packet retrieval and System Health API collection unavailable until a connection is authenticated;
- show unavailable modules and actions as disabled with a concise explanation instead of removing them from navigation;
- preserve the loopback FastAPI boundary, server-side credential handling, job ownership, cleanup, resource limits, and explicit deployment-capability checks;
- use the same domain models and renderers for imported and API-collected System Health reports so offline output does not acquire separate semantics.

## 2. Non-goals

- Running the application by opening `index.html` directly without the local FastAPI service.
- Moving PCAP analysis, PDF rendering, credential handling, or ExtraHop requests into browser code.
- Caching credentials, PCAP bytes, or imported reports in browser storage.
- Emulating ExtraHop API responses or making other administration modules partially functional offline.
- Treating offline mode as an ExtraHop deployment type or as proof that a connected Enterprise deployment is air-gapped.
- Reconstructing detailed System Health API rows from the unified summary CSV.
- Changing the analytical meaning of Datafeed findings or System Health collection states.

## 3. Product capability contract

`offline` is an application runtime context: the local service is available, but no authenticated `ExtraHopClient` is attached. RevealX Enterprise and RevealX 360 remain the only deployment types.

| Capability | Offline | Enterprise | RevealX 360 |
| --- | --- | --- | --- |
| Datafeed Analysis module | Available | Available | Available |
| Upload and analyze local PCAP | Available | Available | Available |
| Retrieve PCAP from Packetstore | Disabled | Available | Available |
| System Health module | Available | Available | Available |
| Load unified summary CSV | Available | Available | Available |
| Render charts and findings from a loaded CSV | Available | Available | Available |
| Export summary/detail CSV and PNG | Available | Available | Available |
| Export PowerPoint | Available | Available | Available |
| Export PDF through the local renderer | Available | Available | Available |
| Poll appliances, devices, and metrics | Disabled | Available | Available |
| Export detailed API response CSVs | Disabled unless the current report came from an API collection | Report-dependent | Report-dependent |
| Other administration modules | Disabled | Deployment-dependent | Deployment-dependent |

Packet retrieval being available for a connected deployment does not promise that Packetstore exists, contains the requested interval, or observes the same feed as a Packet Sensor. Existing partial and indeterminate coverage semantics remain unchanged.

## 4. Architectural decisions

### 4.1 Separate workspace identity from ExtraHop authentication

The browser needs a bounded, expiring local workspace identity even when it is not authenticated to ExtraHop. That identity owns local jobs and expensive local operations; it is not an authorization claim about an ExtraHop deployment.

Recommended session shape:

```text
WorkspaceSession
  id: cryptographically random cookie value
  client: ExtraHopClient | null
  created_at
  last_accessed_at
```

The existing HttpOnly, SameSite `eh_admin_session` cookie can continue to carry the workspace identifier. `backend/session_store.py` should evolve from storing only authenticated clients to storing workspace entries with an optional client.

Lifecycle:

```text
first app bootstrap -> ensure workspace session -> local features available
connect -> authenticate server-side -> attach ExtraHopClient to workspace
disconnect -> cancel connection-bound work -> detach and close client
workspace expiry -> cancel owned work and remove the entry
```

Connecting should not create a different job owner. Disconnecting should not delete completed local-upload results solely because the upstream client was detached.

Introduce two explicit backend guards:

- `require_workspace_session`: validates local ownership and permits local-only routes;
- `get_session_client` or `require_extrahop_client`: additionally requires an authenticated upstream client.

No route should infer capability by attempting an ExtraHop request and interpreting 401, 403, or 404.

### 4.2 Add runtime and action capabilities

Keep `js/utils/deployment-capabilities.js` as the single capability source, but distinguish:

- runtime context: `offline`, `enterprise`, or `360`;
- module capability: whether a page can be opened;
- action capability: whether a specific operation can run.

Initial action keys should cover at least:

```text
datafeed.upload
datafeed.collect
systemHealth.import
systemHealth.collect
systemHealth.exportLocal
systemHealth.exportApiRows
```

The module loader, navigation, and feature controls must consult the same matrix. The backend remains authoritative even when a browser control is disabled.

### 4.3 Keep local processing behind FastAPI

Offline means “no ExtraHop authentication,” not “browser-only.”

- PCAP bytes continue to stream to generated owner-only files outside static directories.
- `backend/pcap_analyzer/analyzer.py` remains deterministic and unaware of HTTP, sessions, or ExtraHop.
- The product catalog continues to come from the packaged local catalog.
- PDF requests continue to use the compact renderer projection and bounded local renderer.
- PowerPoint, PNG, and CSV generation can remain browser-side where they already are.

### 4.4 Preserve one System Health domain model

The existing unified summary CSV schema and `buildSystemHealthReportFromUnifiedCsv` already reconstruct the canonical report shape. Offline mode should open that path; it should not introduce an “offline report” renderer.

Imported reports retain `source_type: summary_csv`. Consequently:

- summary/detail CSV, PNG, PDF, and PowerPoint remain available;
- detailed API-data export remains disabled;
- missing raw time-series rows are not synthesized;
- measured zero remains distinct from missing, offline, failed, unauthorized, timed-out, or partial collection states.

## 5. Backend route classification

| Route family | Required state | Notes |
| --- | --- | --- |
| App bootstrap/session status | Workspace | Creates or refreshes a bounded workspace session. |
| Product catalog | Workspace or immutable local read | Must not require an ExtraHop client. |
| Chart themes | Workspace | Retain current file and validation bounds. |
| System Health PDF | Workspace | Retain request, projection, concurrency, timeout, and browser-cleanup limits. |
| Datafeed upload | Workspace | No upstream client required. |
| Datafeed job status/results/CSV/cancel | Owning workspace | Do not require an upstream client after job creation. |
| Datafeed collection | Authenticated client | Uses `ExtraHopClient.download_to_file`. |
| Generic `/backend/extrahop/*` proxy | Authenticated client | Unchanged. |
| System Health API collection through proxy | Authenticated client | Unchanged. |

The route audit should explicitly verify that local job reads do not accidentally call `get_session_client`, while connected collection still does.

## 6. User experience contract

### 6.1 Navigation

- Show the tool navigation whenever the local app is running.
- Keep every known module visible.
- Disable unsupported modules instead of setting `hidden`.
- Supply a short reason through visible secondary text or an accessible tooltip, such as `Connect to an ExtraHop deployment to use this tool.`
- Never leave an unavailable module marked active.

The welcome page should explain both paths: connect for administration and live collection, or open Datafeed Analysis/System Health for local work.

### 6.2 Datafeed Analysis

Offline activation should:

- select Local PCAP mode;
- keep upload, cancel, results, filtering, and CSV controls functional;
- disable the Connected ExtraHop segment with an explanation;
- reject a programmatic connected-collection attempt before browser transport;
- preserve job polling if the workspace session is still valid.

When connected, both source modes remain available. Optional device enrichment described in `docs/datafeed-analysis-results-redesign-plan.md` must remain best effort: offline uploads complete without enrichment, while a connected workspace may enrich them if the later implementation chooses to do so.

### 6.3 System Health

Offline activation should:

- load the packaged product catalog;
- keep Load CSV and chart-theme controls active;
- disable Run report with a connection explanation;
- enable report-derived exports only after a valid CSV is loaded;
- keep All API data disabled for imported reports with the existing explanation.

On connection loss, an imported report may remain visible. An API-collected report must not be silently represented as live or refreshed; the implementation should either retain it as a clearly historical snapshot or clear it through the established environment-reset boundary.

### 6.4 Session expiry

Differentiate two failures:

- workspace expired: re-establish local workspace state and explain that active local jobs may no longer be available;
- ExtraHop client expired or disconnected: transition to offline capabilities without describing the local app as unavailable.

A 401 from an upstream route must not hide or disable local features.

## 7. Resource and input limits

Opening System Health import offline makes its CSV parser a prominent untrusted-input boundary. Add explicit limits before release:

- maximum selected CSV byte size, checked before `File.text()`;
- maximum sensor rows, aligned with renderer and practical chart limits;
- maximum columns and maximum characters per cell;
- maximum decoded JSON size and collection depth for JSON-bearing cells;
- rejection of duplicate identifiers, mixed schema versions, and inconsistent report windows;
- clear client errors that do not partially replace the current report.

Datafeed Analysis must retain its existing upload bytes, packet, flow, finding, sequence interval, runtime, concurrent job, result page, retention, and temporary-file limits. Workspace creation must remain bounded so unauthenticated browser activity cannot create unlimited job owners.

## 8. Implementation phases

### Phase 1: Workspace-session foundation

Goal: represent local workspace state independently from ExtraHop authentication.

Work:

- refactor `backend/session_store.py` entries to hold an optional client;
- make app bootstrap create or refresh a workspace entry and return `{ connected: false }` when no client is attached;
- attach a successfully authenticated client to the existing workspace;
- make disconnect detach and close the client rather than deleting the workspace;
- add explicit workspace-only and connected-client guards;
- define cleanup behavior for workspace eviction, expiry, shutdown, and connection replacement.

Primary files:

- `backend/session_store.py`
- `main.py`
- `js/api-client/extrahop-api.js`
- `js/app.js`
- `js/auth/auth-manager.js`
- session and security tests

Exit criteria:

- a fresh browser receives a bounded workspace without credentials;
- connecting and disconnecting do not change the workspace owner identifier;
- credentials remain server-side;
- upstream proxy routes still return 401 without an attached client;
- expiry and eviction close clients and cancel owned active work.

### Phase 2: Runtime capability model and navigation

Goal: make module and action availability explicit for offline, Enterprise, and RevealX 360 contexts.

Work:

- extend the capability matrix with the offline runtime context and action keys;
- remove the blanket `state.connected` module-click gate;
- have the module loader reject only modules unsupported in the current runtime context;
- show and disable unavailable navigation items instead of hiding them;
- update the welcome page, connection chip, accessible descriptions, and disabled styling;
- keep API-family assertions for deployment-specific endpoint families.

Primary files:

- `js/utils/deployment-capabilities.js`
- `js/utils/module-loader.js`
- `js/utils/common.js`
- `js/app.js`
- `css/styles.css`
- `index.html`
- capability and module-loader tests

Exit criteria:

- Datafeed Analysis and System Health open offline;
- all other tool modules are visible and disabled offline;
- User Manager and other unsupported Enterprise-only actions remain disabled on RevealX 360;
- unsupported modules do not load scripts or make network requests.

### Phase 3: Offline Datafeed Analysis

Goal: make local upload, analysis, results, and CSV fully workspace-owned.

Work:

- change upload and job read/result/CSV/cancel routes to require only the owning workspace;
- keep collection creation behind the connected-client guard;
- make backend cancellation distinguish local-upload jobs from connection-bound collection jobs;
- gate the source selector and collection action through action capabilities;
- verify that terminal cleanup removes every temporary capture file;
- preserve bounded polling and cancellation across feature activation changes.

Primary files:

- `main.py`
- `backend/pcap_analyzer/jobs.py`
- `js/modules/pcap-analyzer.js`
- `index.html`
- Datafeed route, job, lifecycle, and browser tests

Exit criteria:

- an offline workspace can complete an upload job and download its CSV;
- another workspace cannot read or cancel that job;
- the connected collection route rejects offline callers before upstream transport;
- disconnecting during connected collection cancels it without invalidating completed local-upload results;
- upload, execution, pagination, retention, and cleanup limits remain enforced.

### Phase 4: Offline System Health

Goal: make the existing unified summary CSV path a complete offline review workflow.

Work:

- make the packaged catalog available without an ExtraHop client;
- gate Run report through `systemHealth.collect` while keeping Load CSV active;
- add CSV byte, row, cell, and embedded-JSON limits;
- make PDF rendering workspace-only instead of ExtraHop-authenticated;
- verify browser exports and canonical view-model projections from an imported report;
- define behavior when connection state changes while an imported or API report is visible.

Primary files:

- `main.py`
- `js/modules/system-health-report.js`
- `js/modules/system-health-view-model.js` only if a projection contract correction is required
- `backend/system_health_pdf.py` only if workspace-aware throttling is added
- System Health CSV, lifecycle, view-model, PDF, and PowerPoint tests

Exit criteria:

- an offline workspace loads the app's own schema-v3 summary export;
- all chart inputs and report metadata round-trip unchanged;
- opaque IDs and legitimate zeroes remain exact;
- PDF and PowerPoint exports work from imported data;
- oversized or malformed imports fail before rendering and leave the prior report intact;
- API collection and detailed API export cannot run offline.

### Phase 5: Hardening, documentation, and integration validation

Goal: verify the combined lifecycle and prepare the feature for release.

Work:

- add browser-level scenarios for fresh offline startup, connect, disconnect, expiry, and reconnect;
- verify same-origin cookie behavior and trusted-host rejection for workspace-only routes;
- test resource exhaustion and cleanup for multiple offline workspaces;
- update `docs/architecture.md`, `README.md`, and `README-DIST.md` with the local workspace model and capability table;
- reconcile authentication assumptions in `docs/datafeed-analysis-results-redesign-plan.md`;
- verify the distribution contains every required runtime file and no generated artifacts;
- perform targeted live smoke tests for connected packet retrieval and System Health collection on Enterprise and RevealX 360 when access is available.

Exit criteria:

- the full standard repository verification set passes;
- no local capability depends on an authenticated ExtraHop client;
- no upstream capability succeeds without one;
- temporary files, clients, renderer slots, and jobs are released on every terminal path;
- documentation clearly distinguishes offline app context, connected Enterprise, connected RevealX 360, and genuinely air-gapped deployments.

## 9. Behavioral test matrix

At minimum, add regression coverage for:

| Scenario | Expected behavior |
| --- | --- |
| Fresh app, no cookie | Workspace established; offline navigation rendered. |
| Offline Datafeed upload | Job completes; results and CSV are owner-readable. |
| Cross-workspace job access | 404 without leaking job existence. |
| Offline Datafeed collection | Disabled in UI and rejected by backend. |
| Disconnect during local upload | Local job remains valid unless the workspace itself is destroyed. |
| Disconnect during connected collection | Collection is cancelled and upstream client is closed. |
| Offline System Health import | Canonical charts, findings, and exports render. |
| Oversized/malformed System Health CSV | Explicit error; prior report remains intact. |
| Offline System Health Run report | Disabled in UI and no proxy call occurs. |
| Offline System Health PDF | Bounded renderer accepts the compact projection. |
| Imported report API-data export | Disabled with explanatory text. |
| RevealX 360 User Manager | Visible but disabled; no `/users` request. |
| Workspace expiry | Local state recovers cleanly; inaccessible jobs are not leaked. |
| ExtraHop session loss | App transitions to offline capabilities without hiding local tools. |

Run the standard repository checks after each phase:

```bash
npm test
npm run check:syntax
npm run lint
python -m pytest -q
ruff check main.py backend tests
python scripts/build_dist.py
git diff --check
```

## 10. Open implementation decisions

Resolve these during Phase 1 without changing the product contract above:

1. Whether `GET /backend/session` should ensure the workspace directly or whether a narrow `/backend/workspace` bootstrap route makes the state transition clearer.
2. Whether client detachment should retain API-collected reports in the DOM as historical snapshots or always return to the welcome page and clear environment-bound content.
3. Whether local workspace throttling needs per-owner PDF limits in addition to the existing global renderer semaphore.
4. The exact System Health CSV byte and row limits. They should be consistent with the compact PDF projection limits and realistic supported fleet sizes.
5. Whether local Datafeed job identifiers should be restored from `sessionStorage` after a page reload. This is optional convenience and must not become the ownership mechanism.

None of these decisions should weaken the core separation: a local workspace owns bounded local work, while only an attached authenticated `ExtraHopClient` can reach ExtraHop.
