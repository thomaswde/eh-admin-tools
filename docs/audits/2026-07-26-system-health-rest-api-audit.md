# System Health REST API Audit and Implementation Guide

This file records the ExtraHop REST API audit of the current System Health report. A follow-up implementation pass should use these findings as its working specification.

## Scope and repository state

- Primary implementation: `js/modules/system-health-report.js`
- API wrapper: `js/api-client/extrahop-api.js`
- Local proxy/client: `backend/extrahop_client.py`
- PDF projection: `main.py`
- Report controls: `index.html`
- Existing user changes are present in the working tree. Preserve unrelated edits and inspect diffs before modifying overlapping files.
- The audit was read-only except for creating this file.

## Executive conclusion

The report uses the correct documented endpoint families:

- `GET /api/v1/appliances`
- `POST /api/v1/devices/search`
- `POST /api/v1/metrics`
- `GET /api/v1/metrics/next/{xid}`
- `POST /api/v1/metrics/totalbyobject`

However, the current collection path is not yet production-efficient or fully accurate. The main issues are:

1. Metric totals are passed through peak-oriented summarization.
2. Trigger utilization compares numerator and denominator values from potentially different intervals.
3. License-specific capacity returned by the appliance API is discarded in favor of a static model catalog.
4. Users can request extremely large time-series responses.
5. Queries fan out serially by both metric and sensor instead of using array-valued request fields.
6. XID polling can silently return partial results and is not applied to totals queries.
7. Category fallback and relative time windows can create incomplete or misaligned reports.
8. The backend recreates its HTTP client for every request and does not retry rate limits.
9. Collection behavior has effectively no automated test coverage.

## Priority findings

### P1: Keep totals and peaks as different result types

Current code:

- `collectSystemHealthMetricFallbackIfEmpty()` calls `/metrics/totalbyobject` when `/metrics` yields no interval rows.
- `normalizeSystemHealthMetricRows()` normalizes the total response exactly like a time-series response.
- `summarizeSystemHealthRows()` then records that single total as both the total and the peak.
- Packet and byte rates divide the total by the total response duration, producing a lookback average while the UI and PDF continue to call it a peak.
- Trigger totals can also be compared with time-series-derived metrics, producing mixed aggregation semantics.

Required correction:

- Represent time-series and aggregate responses as distinct types.
- Never place a `/metrics/total` or `/metrics/totalbyobject` value in `peak_values`.
- Store explicit fields such as `total`, `average_rate`, `aggregation_duration_ms`, and `aggregation_mode`.
- Use totals only where the report requests a total or average.
- If an average is shown because peak data is unavailable, label it clearly as an average and do not apply peak-risk language or peak thresholds.
- Keep the browser and PDF calculations consistent.

Best use of server-side aggregation:

- Use `/metrics/totalbyobject` for `trigger_drops`, because the report primarily needs the total and whether any drops occurred.
- It can also efficiently provide byte and packet totals or average rates when those statistics are desired in addition to peaks.
- Do not use totals as a substitute for packet-rate, throughput, or trigger-cycle peaks.

### P1: Calculate trigger utilization from aligned buckets

Current code independently selects:

- the peak `trigger_cycles`
- the peak/latest/average `trigger_cycles_avail`

Those values can occur in different intervals. Dividing independent maxima can hide the actual maximum utilization.

Required correction:

- Request `trigger_cycles` and `trigger_cycles_avail` together in the same `metric_specs` array.
- The returned `values` array is aligned to the order of `metric_specs`.
- For each sensor and time bucket, calculate:

  `trigger_utilization = trigger_cycles / trigger_cycles_avail`

- Retain the bucket with the highest valid utilization, along with the used cycles, available cycles, timestamp, and duration from that same bucket.
- Drive chart ordering and threshold alerts from this aligned ratio.
- Decide and document how zero or missing available capacity is handled.

### P1: Prefer license-specific appliance capacities

`GET /appliances` already returns:

- `advanced_analysis_capacity`
- `total_capacity`
- `license_status`
- `status_message`
- `sync_time`
- `firmware_version`
- `data_access`

The current report drops most of these fields and uses model-catalog values for Advanced and Standard Analysis capacity.

Required correction:

- Preserve the API-returned capacity and health fields in the compact appliance model.
- Prefer `advanced_analysis_capacity` and `total_capacity` for license-specific analysis-capacity reporting.
- Validate the product semantics before deriving Standard capacity. If the intended rule is `total_capacity - advanced_analysis_capacity`, encode and test it explicitly instead of silently assuming it.
- Retain the bundled catalog for hardware packet-rate and throughput ratings, which are not supplied by `GET /appliances`.
- Surface non-nominal `license_status`, unavailable `data_access`, stale synchronization, and offline status as separate health conditions rather than treating all of them as missing metric data.
- Keep the original API values in exports so capacity decisions are auditable.

### P1: Bound time-series response cardinality

The UI permits a 30-day lookback with a one-second cycle.

Maximum theoretical cardinality per sensor:

- 2,592,000 buckets per metric
- 12,960,000 scalar metric points across five metrics
- Additional JavaScript object, CSV, and PDF serialization overhead

Required correction:

- Calculate the requested bucket count before sending any API request.
- Establish a documented maximum bucket budget per sensor and for the whole report.
- Automatically choose a coarser cycle, reject the combination, or require explicit confirmation when the budget is exceeded.
- Prefer a deterministic cycle-selection policy over allowing an unbounded request.
- If `cycle: "auto"` is used, preserve the actual cycle returned by the API rather than reporting only the requested string.
- Label peaks with their aggregation interval, such as “peak 1-hour average,” because a bucketed rate is not an instantaneous peak.
- Do not send raw time-series rows to the PDF endpoint when the PDF only consumes summaries.

## Query architecture

### Current shape

The code performs a serial loop over five metric names and then a serial loop over every sensor. Normal operation requires approximately:

`5 × sensor_count` initial metric requests

Category fallback and total fallback can multiply that further. Every proxied request also creates a new TCP/TLS client.

### Recommended shape

Use a single absolute report window:

```text
until_ms = Date.now()
from_ms = until_ms - lookback_ms
```

Reuse those exact timestamps for device and metric queries.

Perform:

1. One `GET /appliances`.
2. Paginated `POST /devices/search` requests for the analysis-tier inventory.
3. One `POST /metrics` for all eligible sensor IDs with:
   - `object_type: "system"`
   - `object_ids: [all eligible sensor IDs]`
   - `metric_category: "capture"`
   - time-series `metric_specs` for:
     - `bytes`
     - `pkts`
     - `trigger_cycles`
     - `trigger_cycles_avail`
4. One `POST /metrics/totalbyobject` for all eligible sensor IDs with:
   - `trigger_drops`
   - optionally `bytes` and `pkts` if total volume or average-rate summaries are desired
5. Poll all XID responses to documented completion.

This preserves per-sensor attribution and moves total aggregation to the appliance before retrieval.

### Endpoint-specific decisions

#### `GET /appliances`

Verdict: Keep.

- It is the best portable inventory endpoint for both self-managed and RevealX 360.
- Use more of its returned capacity, license, status, and synchronization fields.
- Do not replace it with self-managed-only node or process endpoints in the portable core report.

#### `POST /devices/search`

Verdict: Keep.

- This is the documented replacement for deprecated `GET /devices`.
- Offset pagination is appropriate.
- Narrow `result_fields` is good. The API returns the device ID automatically, so explicitly requesting `id` is unnecessary.
- There is no documented server-side group-count endpoint for analysis tiers, so retrieving minimal device rows and counting by `node_id` and `analysis` client-side is reasonable.
- Consider filtering directly to the recognized analysis values if devices outside those tiers should not contribute to totals.
- Record a clear warning for devices with missing `node_id` or unrecognized analysis values.
- Protect pagination against changing datasets and rate limits.

#### `POST /metrics`

Verdict: Keep for peaks.

- Use it when bucket-level values are required.
- Batch `object_ids`.
- Batch all metric specifications that share `object_type` and `metric_category`.
- Parse every entry in `stat.values` according to the requested metric-spec order.
- Preserve response `cycle`, `from`, `until`, `clock`, and `node_id` as collection metadata.

#### `GET /metrics/next/{xid}`

Verdict: Keep, but replace the current polling logic.

Required behavior:

- Support XID responses from `/metrics`, `/metrics/total`, and `/metrics/totalbyobject`.
- Poll until the documented `null` completion response.
- Treat `"again"` as a retryable pending state.
- Use an elapsed-time deadline or separate pending-retry limit; do not count successful sensor chunks against the pending retry budget.
- Handle HTTP 429 with bounded exponential backoff and `Retry-After` when supplied.
- Raise and report an explicit incomplete-result error if a deadline or safety limit is reached.
- Do not silently return accumulated partial chunks.
- Preserve any documented result-count metadata when present, but do not depend on it unless verified against supported product versions.

#### `POST /metrics/totalbyobject`

Verdict: Promote for true per-sensor totals.

- This is the correct aggregation endpoint when each sensor must remain separate.
- Use it for trigger-drop totals.
- It may also be used for total traffic volume or lookback-average rates when explicitly requested.
- It can return an XID and must use the same generic polling collector as `/metrics`.
- Its result duration describes the aggregate interval and must not be treated as a normal bucket duration without recording the aggregation mode.

#### `POST /metrics/total`

Verdict: Do not use for the current per-sensor report.

- It combines values across all specified objects and returns an aggregate object.
- It is suitable only for a deliberate fleet-wide combined total.

#### `/metrics/catalog/search`

Verdict: Optional self-managed diagnostic only.

- It can validate metric category and metric names on self-managed systems.
- It is not part of the RevealX 360 documented surface and must not become a portable runtime dependency.
- Cache capability validation rather than running a catalog query for every report.

## P2 correctness and completeness findings

### XID polling silently truncates

The current loop stops after 120 iterations and returns whatever chunks were collected. It does not say whether:

- all sensors completed
- the limit was exhausted
- repeated `"again"` responses consumed the budget
- a partial report is being rendered

Replace it with the generic completion-aware collector described above.

### Totals fallback does not poll XIDs

`collectSystemHealthMetricFallbackIfEmpty()` directly normalizes the first `/metrics/totalbyobject` response. If that response contains an XID, it is interpreted as empty data.

All metric endpoint invocations must pass through the same XID-aware request path.

### Category fallback can return partial sensor coverage

The collector returns a category as soon as any row for any sensor contains a numeric value. A sensor that returns no rows can therefore disappear without a sensor-specific error.

Required correction:

- Track expected sensor IDs.
- Track per-sensor status: complete, zero-valued, empty, unauthorized, offline, timed out, or failed.
- Validate coverage before declaring a metric complete.
- Render missing-data state separately from a legitimate zero value.

### Use the catalog category, not a guessed qualified name

The known system-health metric category is `capture`. `system.capture` appears to be a fragment of a fully qualified stat name rather than a metric-catalog category.

Required correction:

- Remove speculative per-report fallback to `system.capture`.
- Use the documented/tested `capture` category.
- If product-version capability detection is needed, perform it once and cache the result.

### Align all report time windows

Current metric queries each use a fresh relative `from` and `until: 0`; device collection separately calculates an absolute `active_from`.

Required correction:

- Compute one absolute `from_ms` and `until_ms` at report start.
- Use them for every device and metric request.
- Store them in the report and exports.
- Do not mix absolute and relative forms within a request.
- If collection takes long enough for the end time to become stale, that is preferable to comparing different windows while calling them one report.

### Do not infer “latest” from response order

`summarizeSystemHealthRows()` overwrites `latestValues[id]` in iteration order. The API schema does not make response order part of the report’s correctness contract.

Required correction:

- Compare timestamps explicitly when selecting the latest point.
- Define deterministic tie handling.
- Sort exported rows explicitly if chronological order is expected.

### Preserve 64-bit identifiers safely

The API describes object IDs and XIDs as 64-bit integers. JavaScript numbers can lose precision above `Number.MAX_SAFE_INTEGER`.

Required correction:

- Avoid arithmetic decoding such as dividing a possibly large OID by `2 ** 32` unless the identifier range is verified.
- Prefer `node_id` from each response chunk for sensor attribution.
- Preserve opaque identifiers as strings when they do not require arithmetic.
- Add fixtures containing large IDs.

## P2 resilience and performance findings

### Reuse HTTP connections

`backend/extrahop_client.py` currently creates an `httpx.AsyncClient` inside every `_send()` call.

Required correction:

- Own one reusable `AsyncClient` per ExtraHop session or use a carefully managed shared client.
- Preserve the session-specific TLS verification policy.
- Close clients when sessions expire, are replaced, or are deleted.
- Update `SessionStore` cleanup paths to support asynchronous or safely scheduled client closure.
- Test reconnect, eviction, expiration, and explicit logout.

### Retry rate limits and transient failures

The metrics-next endpoint documents HTTP 429 when too many sensor requests are pending.

Required correction:

- Retry 429 and selected transient 5xx/network errors with bounded exponential backoff and jitter.
- Honor `Retry-After`.
- Do not retry permanent 4xx validation or authorization failures.
- Report exhausted retries per sensor/query without silently substituting zero.
- Keep concurrency bounded if any independent requests remain after batching.

### Avoid serial report stages where safe

After inventory and the common time window are known, device-tier pagination and metric queries are logically independent. They may run concurrently if:

- API concurrency remains bounded
- XID polling and rate limits are respected
- cancellation and error reporting remain understandable

Batching requests is the first optimization; add concurrency only after the batched path is correct.

### Add cancellation

Large report requests currently continue until completion even if the user navigates away or starts another report.

Required correction:

- Use an `AbortController` in the browser.
- Propagate client disconnect/cancellation where practical through the proxy.
- Cancel the prior collection before starting another report.

## Reporting semantics

### Packet rate and throughput

- A time-series count divided by that stat’s `duration` is the bucket-average rate.
- The report should call the maximum of those values a “peak `<cycle>` average,” not an instantaneous peak.
- Model packet and throughput capacity comparisons should state the averaging interval.
- Total-by-object divided by its aggregate duration is a lookback-average rate, not a peak.

### Trigger cycles

- Use aligned `trigger_cycles` and `trigger_cycles_avail` values.
- Alert from the maximum per-bucket utilization ratio.
- Preserve the corresponding numerator, denominator, timestamp, and duration.

### Trigger drops

- Use `/metrics/totalbyobject`.
- A sensor has drops if its total is greater than zero.
- If a peak-drop bucket is still useful for diagnostics, request the drop time series deliberately and keep that distinct from the total.

### Analysis tiers

- Prefer license-specific capacities from `GET /appliances`.
- Keep Advanced, Standard, Discovery, missing, and unrecognized analysis states distinct.
- Discovery presence is a condition, not necessarily evidence that the sensor exceeded a catalog model limit.

### Missing data

Never convert these states to an indistinguishable zero:

- valid measured zero
- no returned rows
- offline appliance
- `data_access: false`
- unauthorized endpoint or metric
- invalid category or metric
- XID timeout
- rate-limit exhaustion
- partial sensor coverage

Exports and the UI should carry a status field for each sensor and statistic.

## Portable versus self-managed-only health scope

The portable report can enrich health status using `GET /appliances` without additional calls:

- appliance online/data-access state
- license status
- licensed analysis capacity
- firmware version
- synchronization timestamp

Possible self-managed-only extensions include node, process, or license-detail endpoints, but they should be optional capability-gated modules. They are not drop-in replacements for the cross-deployment core report and may describe only the appliance receiving the API call rather than every remote sensor.

## Testing requirements

There are currently no substantive automated tests for System Health API collection. Add tests before or alongside the refactor.

Required JavaScript/unit fixtures:

1. Inline `/metrics` response with one metric and one sensor.
2. Batched response with multiple metric specs and aligned `values`.
3. Multiple sensors returned through XID chunks.
4. `"again"` followed by data and then `null`.
5. Repeated `"again"` that reaches the deadline and raises an incomplete-result error.
6. HTTP 429 with `Retry-After`, then success.
7. XID response from `/metrics/totalbyobject`.
8. Valid zero values distinct from empty rows.
9. One sensor missing while others return data.
10. Large OID/node IDs.
11. Out-of-order timestamps and deterministic latest selection.
12. Total response kept separate from peak summaries.
13. Trigger numerator and denominator aligned by bucket.
14. Maximum-bucket-budget validation for every UI cycle.
15. `cycle: "auto"` with the actual response cycle preserved.

Required Python/backend tests:

1. HTTP client reuse across requests.
2. Client closure on logout, session replacement, expiration, and capacity eviction.
3. OAuth refresh still retries one 401 correctly with a reusable client.
4. TLS verification remains enabled by default.
5. Explicit self-managed untrusted-TLS behavior remains scoped to that session.
6. Rate-limit and transient-network retry policy.
7. Cancellation and timeout behavior.

Required integration fixtures:

1. Self-managed sensor queried directly.
2. Self-managed console with multiple connected sensors and XID results.
3. RevealX 360 with multiple sensors/sites where available.
4. Offline and `data_access: false` appliances.
5. Non-nominal license status.
6. A report with legitimate zero trigger drops.
7. A report where interval data is absent but totals exist.

## Verification status from the audit

- JavaScript syntax checks passed with `node --check`.
- `git diff --check` passed.
- The Python suite did not execute in the audit environment:
  - the repository `.venv` did not contain `.venv/bin/python`
  - the system Python did not have FastAPI installed
- The only existing System Health test found verifies that the catalog route requires a session.

Do not treat the unavailable Python test run as a code failure, but restore a working test environment before considering the implementation complete.

## Suggested implementation order

1. Add metric/XID normalization tests and fixtures.
2. Introduce one absolute report window and response-cardinality validation.
3. Implement a generic XID-aware metric request collector with retry/backoff.
4. Batch sensor IDs and metric specs.
5. Separate time-series summaries from totals summaries.
6. Compute aligned trigger utilization.
7. Use license-specific appliance capacities and health fields.
8. Update browser rendering, CSV exports, and PDF calculations together.
9. Reuse backend HTTP clients and implement lifecycle cleanup.
10. Add integration coverage for console/XID and RevealX 360 behavior.

## Completion criteria

The follow-up pass is complete only when:

- No total is labeled or consumed as a peak.
- Trigger utilization uses aligned buckets.
- All expected sensors have an explicit success or failure state.
- One report uses one absolute time window.
- Metric requests batch object IDs and compatible metric specs.
- XID responses from every metric endpoint are fully drained or explicitly reported incomplete.
- Requested time-series cardinality is bounded.
- Appliance API license capacities are preferred over static catalog analysis capacities.
- `trigger_drops` uses server-side per-object totals.
- Browser, CSV, and PDF values agree.
- Rate limits and transient failures have bounded retry behavior.
- Automated tests cover the collection and aggregation cases above.

## References

- ExtraHop REST API skill reference: `/Users/thomass/.codex/skills/extrahop-rest-api/SKILL.md`
- Bundled endpoint catalogs: `/Users/thomass/.codex/skills/extrahop-rest-api/references/`
- Bundled OpenAPI document: `/Users/thomass/.codex/skills/extrahop-rest-api/references/api-docs.json`
- RevealX 360 REST API guide: <https://docs.extrahop.com/current/rx360-rest-api/>
- ExtraHop IDS Sensor REST API guide: <https://docs.extrahop.com/current/ids-rest-api/>
