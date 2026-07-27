# Architecture

This document is the current cross-cutting contract for ExtraHop Admin Tools. Feature details remain close to their implementations and tests.

## Local proxy boundary

The browser is served by a loopback-only FastAPI application and calls only local `/backend` routes. `main.py` validates local requests and session cookies; `backend/session_store.py` owns bounded, expiring sessions; `backend/extrahop_client.py` owns RevealX 360 OAuth, Enterprise API-key authentication, TLS policy, connection reuse, upstream retries, and ExtraHop requests. Credentials stay server-side and saved credentials use the operating-system credential service. Browser code must not call ExtraHop hosts directly or persist credentials.

The proxy also forms a data contract. Upstream error details are converted to local HTTP errors, cancellation is propagated where practical, and browser responses are normalized before native `JSON.parse` sees them.

## Deployment capabilities

`js/utils/deployment-capabilities.js` is the explicit capability matrix for deployment types. Navigation, module loading, and API wrappers must consult the same matrix. Unsupported features are hidden or rejected before an API call; 401, 403, and 404 responses are not capability discovery. At present, the `/users` family and User Manager are self-managed-only. Add future differences to the matrix with endpoint-contract evidence and tests.

## Identifier contract

ExtraHop `int64` IDs and XIDs can exceed JavaScript's safe integer range. `backend/extrahop_client.py` converts documented identifier fields to decimal strings while the response is still represented by Python integers. From that boundary onward, IDs are opaque strings:

- preserve them exactly in state, exports, URLs, and fixtures;
- compare them as strings;
- do not decode them arithmetically or pass them through `Number`/`parseInt`;
- convert only domain measurements, counts, timestamps, and durations to numbers.

When a new identifier field is introduced, extend the backend normalization contract and add a proxy-to-browser test. Browser-only fixtures containing pre-stringified large IDs do not prove transport safety. For outbound metric JSON only, the backend losslessly rehydrates decimal-string `object_ids` into the JSON integers required by the ExtraHop request schema; browser code must never perform that conversion through JavaScript numbers.

## Retry, deadline, and cancellation ownership

`backend/extrahop_client.py` owns bounded retries for transient network errors, HTTP 429, and selected transient server responses. It honors `Retry-After`, uses backoff with jitter, and retries only safe methods plus the allowlisted read-oriented POST endpoints. Permanent validation/authorization failures and cancellation are not retried.

The browser API wrapper owns a request timeout and caller cancellation. A collector that drains asynchronous ExtraHop results, such as Metrics XID continuations, owns the continuation state machine and one absolute deadline beginning before the initial request. It must not wrap backend transport retries in another retry loop. Exhaustion produces an explicit incomplete or failed state, never silent partial success or zero.

## Report windows and status semantics

A report computes one absolute `[from_ms, until_ms]` window and reuses it for all related device, metric, CSV, and renderer projections. Calendar-date inputs must use one documented timezone convention and must be validated against uploaded data coverage.

Aggregation modes remain distinct:

- a time-series bucket divided by its duration is a bucket-average rate;
- the maximum bucket is a “peak `<cycle>` average,” not an instantaneous peak;
- a total-by-object result is a period total, or a lookback-average rate only when divided by its aggregate duration;
- aligned ratios, such as trigger utilization, use numerator and denominator from the same bucket.

Every expected object carries a collection status. Measured zero is valid data and remains distinct from empty, offline, inaccessible, unauthorized, invalid, timed out, rate-limit exhausted, failed, or partial. UI, CSV, PDF, and PowerPoint consumers should project one canonical domain result rather than re-derive incompatible rules.

`js/modules/system-health-view-model.js` is that projection boundary for System Health. It converts the canonical report into sensor and Packetstore summaries, applies shared missing-data-aware findings, coverage, thresholds, overview, verdict, and recommendation rules, and can emit a compact renderer projection with no raw metric series. Browser and PowerPoint code delegate to it; renderer modules retain only DOM, canvas, presentation options, palette, filenames, and slide construction. Missing aggregate coverage remains unavailable rather than becoming zero, and Packetstore capture is described as lossless only when every relevant loss counter is conclusively reported.

## Feature lifecycle registry

The UI still loads classic feature scripts dynamically, but lifecycle ownership is explicit. Every feature script registers its actual module name with `featureRegistry` and supplies `initialize`, `activate`, and optional `cancel` or `deactivate` hooks. The loader rejects a script that finishes without registering its mapped feature; it does not derive global function names from file names.

```text
load dependencies and require registration → initialize once → switch visible DOM → activate
```

Initialization is awaited, installs listeners, and creates durable feature state exactly once after success. Concurrent initialization and same-feature switches share their in-flight work; a failed initialization may be retried. Feature switches are serialized so activation order cannot race. Activation is awaited, and the registry marks a feature active only after its hook succeeds. Before a different feature activates, the prior feature's optional cancellation and deactivation hooks run and active state is cleared even if cleanup fails. Long-running work should expose cancellation, and initial activation must share in-flight requests rather than launching work from both initialization and activation. Classic scripts remain a packaging choice, not a lifecycle interface.

## Resource bounds: logging and PDF

API response logging is diagnostic and best-effort. It uses bounded request/response previews, a maximum serialized entry size, a bounded background queue, byte-based rotation with a fixed backup count, and owner-only file permissions. Oversized response bodies are not parsed solely for logging. Shutdown must flush and close the writer without making API success depend on logging I/O.

PDF generation is an authenticated local service, but input and browser work are still untrusted resource consumers. `SystemHealthViewModel.buildRendererProjection()` owns the versioned System Health renderer contract: v1 contains only allowlisted metadata, camelCase sensor and Packetstore summaries, and canonical overview/findings/absent/verdict/recommendations. The Python renderer strictly validates that compact projection and never reconstructs report semantics from appliances or raw metrics; `tests/fixtures/system-health-renderer-v1.json` detects drift across both runtimes. The contract has bounded collection sizes and text lengths, a total request-size limit, bounded render concurrency, and guaranteed browser closure in `finally`. Legacy reports and raw time-series rows are not PDF input. Limit violations return explicit client errors; render failures do not leak a Chromium process or semaphore permit.

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
