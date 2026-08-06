# Architecture

This document is the current cross-cutting contract for ExtraHop Admin Tools. Feature details remain close to their implementations and tests.

## Local proxy boundary

The browser reaches a locally hosted FastAPI application through the host's loopback entrypoint and calls only local `/backend` routes. Under WSL, the guest process binds all guest interfaces so Windows can reach it across the virtual network boundary; `main.py` still enforces local Host headers and validates workspace cookies. `backend/session_store.py` owns bounded, expiring workspace entries with an optional authenticated client; `backend/extrahop_client.py` owns RevealX 360 OAuth, Enterprise API-key authentication, TLS policy, connection reuse, upstream retries, and ExtraHop requests. Credentials stay server-side and saved credentials use the operating-system credential service. Browser code must not call ExtraHop hosts directly or persist credentials.

The HttpOnly, SameSite cookie identifies a local workspace, not an authenticated ExtraHop identity. App bootstrap ensures that workspace before credentials exist. Connecting attaches a client without changing the workspace owner; disconnecting or a terminal upstream authentication failure cancels connection-bound work, closes and detaches the client, and retains local capabilities and completed local results. Workspace expiry, eviction, and shutdown remove the entry, close any client, and run owner cleanup. Routes use one of two explicit guards: workspace-only routes may perform bounded local work, while upstream proxy and collection routes additionally require an attached client.

The proxy also forms a data contract. Upstream error details are converted to local HTTP errors, cancellation is propagated where practical, and browser responses are normalized before native `JSON.parse` sees them.

Completed Device Discovery, Records, and System Health results use a separate local report cache. The cache is not an HTTP cache and does not replay individual Metrics XID fragments. A reporting page writes one versioned canonical projection only after its collection has completed, and activation may restore that historical result while clearly offering a refresh. Every report validates bounded JSON structure plus its own nested domain invariants before mutating browser state or rendering; an invalid or obsolete projection is ignored. System Health persists its per-sensor summary projection rather than its highly repetitive raw time-series rows; the compact projection preserves browser/PDF/PowerPoint semantics, while detailed API-row export requires a fresh live report. In packaged installs, entries live under `api-response-cache/<local-user>/<connection-id>/reports/` beside `chart-themes`; a credential-free connection manifest records the normalized tenant or host. The local operating-system user and the same deployment identity used for saved connections form the isolation boundary, so browser workspace rotation and reconnects do not discard results and different connections never share them. Writes are atomic, corrupt entries are ignored, and per-entry and per-user byte ceilings bound persistent storage. Credentials are never cached.

## Deployment capabilities

`js/utils/deployment-capabilities.js` is the explicit capability matrix for both runtime contexts (`offline`, `enterprise`, and `360`) and action-level capabilities. `offline` means the local service is running without an attached client; it is not an ExtraHop deployment type or evidence about air-gap status. Navigation, module loading, feature controls, and API wrappers must consult the same matrix. Known modules remain visible, unavailable modules and actions are disabled with a reason, and programmatic attempts are rejected before an API call; 401, 403, and 404 responses are not capability discovery. Datafeed local upload and System Health summary import/local exports are available offline, while Packetstore retrieval, live collection, API-row export, and administration require a client. At present, the `/users` family, User Manager, appliance cloud-services status, appliance product keys, and local-appliance firmware endpoints are self-managed-only; remote-appliance firmware discovery and upgrade are available for both connected deployment types. Connected Appliances routes local product keys through `/license/productkey`, local firmware through `/extrahop/firmware/*`, and connected targets through `/appliances/*`. Add future differences to the matrix with endpoint-contract evidence and tests.

## Identifier contract

ExtraHop `int64` IDs and XIDs can exceed JavaScript's safe integer range. `backend/extrahop_client.py` converts documented identifier fields to decimal strings while the response is still represented by Python integers. From that boundary onward, IDs are opaque strings:

- preserve them exactly in state, exports, URLs, and fixtures;
- compare them as strings;
- do not decode them arithmetically or pass them through `Number`/`parseInt`;
- convert only domain measurements, counts, timestamps, and durations to numbers.

When a new identifier field is introduced, extend the backend normalization contract and add a proxy-to-browser test. Browser-only fixtures containing pre-stringified large IDs do not prove transport safety. For allowlisted outbound JSON fields that ExtraHop requires as `int64` values—currently metric `object_ids` and firmware-upgrade `system_ids`—the backend losslessly rehydrates decimal strings into JSON integers; browser code must never perform that conversion through JavaScript numbers.

## Retry, deadline, and cancellation ownership

`backend/extrahop_client.py` owns bounded retries for transient network errors, HTTP 429, and selected transient server responses. It honors `Retry-After`, uses backoff with jitter, and retries only safe methods plus the allowlisted read-oriented POST endpoints. Permanent validation/authorization failures and cancellation are not retried.

Dashboard PATCH and DELETE requests also have a bounded, per-session single-flight guard. Identical concurrent mutations share one upstream task, so a duplicate browser submission cannot repeat the same in-progress change. The guard is not a durable idempotency cache: after the first operation finishes, a later intentional request may run normally.

The browser API wrapper owns a request timeout and caller cancellation. A collector that drains asynchronous ExtraHop results, such as Metrics XID continuations, owns the continuation state machine and one absolute deadline beginning before the initial request. It must not wrap backend transport retries in another retry loop. System Health balances metric work into batches of at most 40 sensors, retains conclusive partial chunks, and may bisect unresolved batches within explicit continuation and recovery-query limits. Authorization and exhausted rate-limit responses are terminal for the affected batch and are not multiplied through recovery requests. Exhaustion produces an explicit incomplete or failed per-sensor state, never silent partial success or zero.

## Report windows and status semantics

A report computes one absolute `[from_ms, until_ms]` window and reuses it for all related device, metric, CSV, and renderer projections. Calendar-date inputs must use one documented timezone convention and must be validated against uploaded data coverage.

Aggregation modes remain distinct:

- a time-series bucket divided by its duration is a bucket-average rate;
- the maximum bucket is a “peak `<cycle>` average,” not an instantaneous peak;
- a total-by-object result is a period total, or a lookback-average rate only when divided by its aggregate duration;
- aligned ratios, such as trigger utilization, use numerator and denominator from the same bucket.

Metric requests use ExtraHop's `auto` cycle unless the page exposes an explicit cycle control. A cycle control defaults to Auto; Auto is sent upstream unchanged, while a supported explicit selection is honored when it fits the report's point budgets. Returned bucket counts and scalar points remain bounded after the upstream cycle is known, so automatic rollup selection cannot create unbounded browser work.

Dashboard administration requests at most 365 days of the System User Interface dashboard-view Top-N metric with `cycle: auto`. The collector reports the requested window separately from the common window represented by actual returned buckets across all response chunks, and the browser offers recorded-activity lookbacks only within that measured depth. The Top-N limit applies independently to each returned bucket: the union can exceed 1,000 dashboard IDs, and it is not a global list of the 1,000 most recently viewed dashboards. A returned key is positive evidence of use, but an absent key is only "not recorded in the observed window," never proof of non-use; view totals are lower bounds and UI labels, filters, and help text must preserve that distinction.

Every expected object carries a collection status. Measured zero is valid data and remains distinct from empty, offline, inaccessible, unauthorized, invalid, timed out, rate-limit exhausted, failed, or partial. UI, CSV, PDF, and PowerPoint consumers should project one canonical domain result rather than re-derive incompatible rules.

Packetstore capability requires affirmative evidence. A positive Packetstore lookback confirms a paired source, while an inventory-confirmed integrated Packetstore remains eligible even when its lookback is zero or unavailable. A zero-only `cpc` probe on an otherwise ordinary sensor is indeterminate, not detected, and must not promote generic interface-drop counters into Packetstore rows or findings.

`js/modules/system-health-view-model.js` is that projection boundary for System Health. It converts the canonical report into sensor and Packetstore summaries, applies shared missing-data-aware findings, coverage, thresholds, overview, verdict, and recommendation rules, and can emit a compact renderer projection with no raw metric series. Browser and PowerPoint code delegate to it; renderer modules retain only DOM, canvas, presentation options, palette, filenames, and slide construction. Missing aggregate coverage remains unavailable rather than becoming zero, and Packetstore capture is described as lossless only when every relevant loss counter is conclusively reported.

## Feature lifecycle registry

The UI still loads classic feature scripts dynamically, but lifecycle ownership is explicit. Every feature script registers its actual module name with `featureRegistry` and supplies `initialize`, `activate`, and optional `cancel` or `deactivate` hooks. The loader rejects a script that finishes without registering its mapped feature; it does not derive global function names from file names.

```text
load dependencies and require registration → initialize once → switch visible DOM → activate
```

Initialization is awaited, installs listeners, and creates durable feature state exactly once after success. Concurrent initialization and same-feature switches share their in-flight work; a failed initialization may be retried. Feature switches are serialized so activation order cannot race. Activation is awaited, and the registry marks a feature active only after its hook succeeds. Before a different feature activates, the prior feature's optional cancellation and deactivation hooks run and active state is cleared even if cleanup fails. Long-running work should expose cancellation, and initial activation must share in-flight requests rather than launching work from both initialization and activation. Classic scripts remain a packaging choice, not a lifecycle interface.

## Resource bounds: logging and PDF

API response logging is diagnostic and best-effort. It uses bounded request/response previews, a maximum serialized entry size, a bounded background queue, byte-based rotation with a fixed backup count, and owner-only file permissions. Oversized response bodies are not parsed solely for logging. Shutdown must flush and close the writer without making API success depend on logging I/O.

PDF generation is a workspace-owned local service, but input and browser work are still untrusted resource consumers. `SystemHealthViewModel.buildRendererProjection()` owns the versioned System Health renderer contract: v1 contains only allowlisted metadata, camelCase sensor and Packetstore summaries, and canonical overview/findings/absent/verdict/recommendations. The Python renderer strictly validates that compact projection and never reconstructs report semantics from appliances or raw metrics; `tests/fixtures/system-health-renderer-v1.json` detects drift across both runtimes. The contract has bounded collection sizes and text lengths, a total request-size limit, bounded render concurrency, and guaranteed browser closure in `finally`. Legacy reports and raw time-series rows are not PDF input. Limit violations return explicit client errors; render failures do not leak a Chromium process or semaphore permit.

System Health unified-summary CSV import is another untrusted-input boundary. The browser checks the 5 MiB file limit before reading, then enforces the canonical column count, at most 1,000 sensor rows, 128 KiB cells, and bounded decoded JSON size, depth, node count, key length, and string length. It rejects duplicate identifiers, mixed metadata/schema, and inconsistent report windows without partially replacing the current report. Imported and API-collected reports share the canonical view model and renderers; imports never synthesize unavailable raw API rows or turn missing collection states into measured zero.

## Datafeed Analysis boundary

Datafeed Analysis is a feature-owned workflow, not a special mode of the generic ExtraHop proxy. `backend/pcap_analyzer/analyzer.py` is a deterministic, bounded classic-PCAP engine with no HTTP, workspace, or ExtraHop knowledge. `backend/pcap_analyzer/jobs.py` owns workspace-bound jobs, uploads, connected collection, progress, cancellation, result paging, CSV, expiration, and temporary-file cleanup. `main.py` exposes only the narrow `/backend/pcap-analyzer/*` route surface, and `js/modules/pcap-analyzer.js` owns the browser workflow through the normal feature lifecycle registry.

Connected collection uses the documented `POST /api/v1/packets/search` JSON contract for both RevealX Enterprise and RevealX 360. `ExtraHopClient.download_to_file()` is the shared authenticated binary seam: it preserves API-key, proxy-token, OAuth refresh, TLS, retry, deadline, and cancellation behavior while streaming bytes directly to a bounded generated path. Packet bytes never pass through JSON normalization or ordinary response previews. HTTP 422 is handled as the documented no-Packetstore/no-saved-packets outcome; it is not used to discover whether the endpoint family exists.

One analysis job owns one absolute half-open `[from_ms, until_ms)` interval. Millisecond packet-search windows are transport chunks and use adjacent inclusive API boundaries without overlap; flow aggregation and reverse-direction conclusions happen only after every available capture chunk is processed. Execution state is distinct from result completeness. A job can execute successfully while its dynamic coverage remains `indeterminate`, because ExtraHop's approximate byte and search-duration limits do not prove that a successful response exhausted the requested interval. Failed or skipped windows produce `partial`, never silent success or measured zero.

Packetstore packets are evidence from the Packetstore observation point. Their feed can differ from a Packet Sensor feed, and some deployments have no Packetstore. Uniform small record capture lengths, especially permission-driven slices, are surfaced as a slicing warning rather than automatically attributed to sensor snaplen. Results use cautious labels: reverse direction not observed, capture truncated or sliced, and observed TCP sequence gap. They do not claim definitive network packet loss.

Inputs, packet records, flows, findings, sequence intervals, windows, transferred bytes, runtime, concurrent jobs, result pages, and retention all have explicit bounds. Uploaded and downloaded captures use generated owner-only paths outside static directories and are removed after every terminal outcome; only bounded result metadata remains until job expiration. Local upload requires only the bounded workspace owner and runs without ExtraHop credentials. If a client is attached, upload enrichment is best effort; without one, enrichment is skipped and analysis remains complete. Client detachment cancels active connected-collection jobs but does not delete completed local results. Workspace expiry or removal cancels all owned work and removes retained metadata.

## Network locality bulk imports

Interactive network locality edits remain browser-managed drafts, but CSV imports are connection-bound backend jobs because a browser tab is not a durable execution or audit boundary. The backend parses a bounded UTF-8 CSV, checks the authoritative locality list once, applies new entries with bounded concurrency and one absolute deadline, and persists the source-row projection, job metadata, and append-only per-row outcomes under the same local-user and deployment identity boundary as cached reports. Completed and interrupted jobs remain queryable after browser reloads and app restarts for a bounded retention period and job count.

Every non-empty CSV row has an exportable outcome: created, conclusively failed, skipped as a duplicate, invalid, unknown when transport failure makes application ambiguous, or not attempted when the job ended before that row. Unknown is never collapsed into failure, and unattempted work is never presented as applied. Active imports are cancelled when their owning ExtraHop connection is detached; their persisted outcomes remain available after reconnecting to the same deployment. The ordinary locality query can still return the complete upstream array, but the browser renders only one bounded editable page at a time so large deployments do not create an unbounded DOM.

## Tests and CI

Behavioral JavaScript tests use Node's test runner, and backend tests use the Python test configuration in `pyproject.toml`. ESLint, Ruff, syntax checks, and distribution construction are first-class checks. `.gitlab-ci.yml` runs separate JavaScript and Python stages, then builds the allowlisted distribution only after both pass.

Tests should exercise outputs, state transitions, API calls, retry/partial behavior, and the real proxy serialization boundary. Source-regex tests are appropriate only for static packaging or markup invariants that cannot reasonably be executed. The build allowlist is also a security and product-boundary test: repository-only docs, fixtures, tools, and prototypes must not enter the shipped ZIP accidentally.

## Known live-integration limits

The automated suite uses fixtures and local transports. It does not currently provide continuous authenticated coverage for:

- a self-managed sensor queried directly;
- a self-managed console returning multi-sensor XID chunks;
- RevealX 360 across multiple sites/sensors;
- every supported firmware's metric names, capacity semantics, and continuation behavior;
- offline, `data_access: false`, non-nominal license, and rate-limit conditions produced by live appliances;
- browser-specific end-to-end workflows against a live ExtraHop system.

Changes to endpoint families or product semantics require verification against the bundled OpenAPI reference and, when access exists, targeted live smoke tests. Record the deployment type, firmware, topology, window, and expected status without checking credentials or customer data into the repository.
