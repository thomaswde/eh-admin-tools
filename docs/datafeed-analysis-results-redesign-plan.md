# Datafeed Analysis Results Redesign and Device Enrichment Plan

Status: implemented; automated verification complete, live Enterprise and RevealX 360 smoke tests pending

Scope: Datafeed Analysis results experience, CSV exports, and optional ExtraHop device-name enrichment

Non-goal: a function-by-function implementation prescription

## 1. Desired outcome

Replace the current default "All findings" browser with a concise analysis dashboard that helps an operator understand the capture before reading individual flows.

The completed experience should:

- lead with visual summaries computed from the entire bounded analysis result, not the first API page;
- show two concise tables beneath the charts:
  - the top 25 flows where the reverse direction was not observed;
  - the top 25 flows with observed TCP sequence gaps;
- offer a full CSV export from each table and one full "all findings" CSV export;
- enrich IP endpoints with ExtraHop device names when an exact, defensible match is available;
- always keep the IP address as the primary identity and render a device name only as secondary decoration;
- preserve the current packet-analysis, session, cancellation, cleanup, and resource-boundary guarantees.

The implementing engineer should retain latitude over component factoring, exact responsive breakpoints, and small visual details. The data semantics, failure behavior, limits, and user-facing hierarchy described below are the intended contract.

## 2. Guiding product decisions

### 2.1 IP addresses remain authoritative

An ExtraHop device name must never replace an address in a chart, table, tooltip, or CSV.

Recommended presentation:

```text
10.10.10.25:443
web-prod-07
```

The IP and port are the primary line. The ExtraHop display name is smaller, muted secondary text. If there is no useful name, the second line is omitted rather than filled with `N/A`.

For charts with constrained label space, use the IP-and-port flow label on the axis and put optional source and destination device names in the tooltip. CSVs must keep addresses and names in separate columns.

### 2.2 Enrichment is best effort and non-authoritative

Packet analysis must succeed even when device enrichment is unavailable, times out, returns no match, or returns ambiguous matches. Ordinary no-match and ambiguity outcomes should not become warning notices.

Expose a compact neutral status when useful, for example, `ExtraHop names: 37 of 52 addresses enriched`. Detailed enrichment state belongs in the job response and tests, not in a stack of alerts.

### 2.3 Charts summarize the complete result

Do not calculate charts from a paged browser response. Compute a bounded dashboard projection on the server from the canonical job result after analysis and enrichment. Return only the aggregates and top rows needed to render the dashboard.

### 2.4 Finding categories can overlap

A directional flow can be reverse-not-observed, truncated, and sequence-gap affected at the same time. Category counts must therefore be described as affected-flow counts and must not be added together as if they were mutually exclusive.

### 2.5 Exports are full-result operations

The two visible tables stop at 25 rows. Their export buttons must download every matching row retained by the bounded job, not only the visible rows. "All findings" means every flow with at least one finding; it must exclude flows whose `findingKinds` list is empty.

## 3. Current implementation observations

The current implementation already provides strong foundations:

- `backend/pcap_analyzer/analyzer.py` is a deterministic parser with no HTTP or ExtraHop knowledge.
- `backend/pcap_analyzer/jobs.py` owns job state, paging, CSV streaming, cancellation, retention, and cleanup.
- the result row contains packet counts, byte counts, timestamps, truncation counts, reverse-direction state, connection epochs, sequence-gap observations, and sequence-gap bytes;
- `/backend/pcap-analyzer/jobs/{job_id}/results` supports a finding filter and bounded paging;
- `/backend/pcap-analyzer/jobs/{job_id}/csv` streams CSV rows rather than loading a full export into browser memory;
- the browser already has Chart.js available globally;
- System Health establishes useful presentation patterns for card-header actions, export tiles, compact table-level CSV actions, chart framing, status text, and the shared chart palette.

The current gaps this plan addresses are:

- the unfiltered result route and CSV include healthy flows;
- the browser begins with a generic paged table rather than an analytical overview;
- the current table can render a no-finding row with the generic label `Finding`;
- the browser CSV action does not preserve the selected finding filter;
- result rows have no optional ExtraHop device metadata;
- summary data does not contain every distinct-flow count needed for clear charts.

## 4. Proposed completed-page hierarchy

Keep the existing capture source and status cards. Replace the current results card with the following structure after a job completes.

```text
+-----------------------------------------------------------------------+
| Summary statistics                         [ All findings CSV ]        |
| Optional neutral enrichment coverage                                 |
+----------------------------------+------------------------------------+
| Affected flows by finding        | Top conversations                  |
| full-result category bars        | [Reverse visibility | Seq gaps]    |
+----------------------------------+------------------------------------+
| Top 25 reverse-direction observations       [ Export full CSV ]       |
| native table; IP primary, optional device name secondary              |
+-----------------------------------------------------------------------+
| Top 25 observed sequence gaps                  [ Export full CSV ]     |
| native table; IP primary, optional device name secondary              |
+-----------------------------------------------------------------------+
```

On narrow screens, the two chart cards stack vertically. The tables retain horizontal scrolling rather than collapsing endpoint identity into unreadable abbreviations.

### 4.1 Summary row

Retain compact summary statistics, adjusted to emphasize useful capture facts:

- packets examined;
- directional TCP flows;
- affected flows (unique union of all finding categories);
- result completeness.

If device enrichment ran, add a small neutral line under the summary rather than another warning card.

### 4.2 Export action

Place an `All findings CSV` action near the summary or in a small results action area. Follow the visual language of the System Health export actions, but do not force Datafeed Analysis to use System Health-specific class names. Extract or introduce a shared action-tile style if that produces cleaner ownership.

The action description should make its semantics explicit: `Export every flow with one or more findings.`

### 4.3 Findings overview chart

Use a horizontal bar chart with one bar per category:

- reverse direction not observed - distinct affected flows;
- observed TCP sequence gap - distinct affected flows;
- capture truncated or sliced - distinct affected flows.

Chart requirements:

- title: `Affected flows by finding`;
- subtitle or accessible description: categories can overlap;
- tooltip: affected-flow count and percentage of all directional TCP flows;
- stable category ordering rather than sorting categories by value;
- measured zero remains zero; unavailable/partial collection is not silently shown as a conclusive zero;
- chart data comes from the full job projection.

A donut or pie chart is not recommended because the categories overlap and therefore are not parts of a whole.

### 4.4 Top conversations chart

Use one interactive horizontal bar chart with a segmented control:

- `Reverse visibility` view: top conversations ordered by packet count;
- `Sequence gaps` view: top conversations ordered by observed sequence-gap bytes, with gap observations in the tooltip.

Recommended chart row count is 10 to 15, chosen responsively from the same deterministically ranked data used by the top-25 tables.

Interaction goals:

- hover/focus tooltips show the full IP:port pair, optional ExtraHop device-name decorations, the primary ranking value, and relevant supporting values;
- the segmented control is keyboard operable and updates the title, metric label, and dataset together;
- clicking a bar may scroll to and briefly highlight the corresponding table row if that can be implemented cleanly;
- the tables remain the accessible text alternative to the chart, so canvas interaction is an enhancement rather than the only way to inspect data;
- charts are destroyed or reused correctly when a new job completes or the feature deactivates.

Use the existing chart palette resolution rather than creating a Datafeed-specific color system. Adding `chart-theme.js` as a Datafeed Analysis module dependency is appropriate if the implementation calls `chartThemeResolvedColors()`.

### 4.5 Top 25 reverse-direction table

Card title: `Top reverse-direction observations`

Card description: `Directional flows with no reverse flow observed in this capture, ranked by packet count.`

Recommended columns:

- source IP:port, with optional device name below;
- destination IP:port, with optional device name below;
- packets;
- captured bytes;
- first observed;
- last observed.

Sort order:

1. `packetCount` descending;
2. `capturedBytes` descending;
3. stable lexical flow key.

Show at most 25 rows. The card-header action `Export full CSV` downloads all reverse-not-observed rows.

### 4.6 Top 25 sequence-gap table

Card title: `Top observed sequence gaps`

Card description: `Directional flows with uncovered TCP sequence ranges, ranked by observed gap bytes.`

Recommended columns:

- source IP:port, with optional device name below;
- destination IP:port, with optional device name below;
- observed gaps;
- observed gap bytes;
- packets;
- connection epochs;
- first observed;
- last observed.

Sort order:

1. `sequenceGapBytes` descending;
2. `sequenceGapObservations` descending;
3. `packetCount` descending;
4. stable lexical flow key.

Show at most 25 rows. The card-header action `Export full CSV` downloads all sequence-gap rows.

### 4.7 Empty states

Each chart and table should have its own quiet empty state. For example, a clean reverse-direction result must not hide a populated sequence-gap section. If there are no findings at all, show a concise positive empty state and keep the all-findings export disabled.

## 5. Canonical result and dashboard projection

Extend the canonical analysis summary or a single feature-owned projection boundary so browser code does not independently re-derive finding counts and rankings.

Recommended additional summary values:

- `affectedFlowCount`: distinct flows with one or more findings;
- `truncatedFlowCount`: distinct flows with one or more truncated records;
- `sequenceGapFlowCount`: distinct flows with one or more observed gaps;
- `sequenceGapBytes`: total observed gap bytes across flows;
- capture first and last timestamps across all PCAP records, primarily to bound uploaded-PCAP enrichment.

`reverseNotObservedFlows` and `sequenceGapObservations` already exist.

Add a bounded result projection to the completed job snapshot, conceptually:

```json
{
  "dashboard": {
    "schemaVersion": 1,
    "findingCounts": {
      "affectedFlows": 0,
      "reverseNotObservedFlows": 0,
      "sequenceGapFlows": 0,
      "sequenceGapObservations": 0,
      "sequenceGapBytes": 0,
      "truncatedFlows": 0
    },
    "topReverse": [],
    "topSequenceGaps": [],
    "enrichment": {
      "status": "complete",
      "addressesConsidered": 0,
      "addressesMatched": 0,
      "addressesAmbiguous": 0,
      "addressesOmitted": 0
    }
  }
}
```

The exact internal class split is left to the engineer, but one backend projection should own:

- category membership;
- unique affected-flow counts;
- deterministic ranking;
- top-list truncation;
- application of endpoint enrichment;
- the row schema shared by dashboard lists, paged results, and CSV.

Do not put HTTP or ExtraHop lookups into `analyzer.py`. Its output should remain deterministic for identical PCAP bytes and limits.

## 6. ExtraHop device enrichment

### 6.1 Supported lookup

The ExtraHop REST API documents exact IP search through `POST /api/v1/devices/search` with an `ipaddr` filter:

```json
{
  "filter": {
    "field": "ipaddr",
    "operand": "10.10.10.200",
    "operator": "="
  }
}
```

The repository already uses `/devices/search`, and `ExtraHopClient` already treats this read-oriented POST as retryable. Use that supported endpoint for both RevealX Enterprise and RevealX 360; do not probe alternative endpoint families after an error.

Before merge, validate the exact supported `result_fields` and response shape against the built-in API Explorer and fixtures for both deployment types. Expected useful fields include `id`, `node_id`, `display_name`, `default_name`, `ipaddr4`, and `ipaddr6`, but the implementation must be based on verified schema names rather than assumptions.

### 6.2 Placement in the job lifecycle

Recommended lifecycle:

```text
collect/upload -> analyze -> build finding rows -> enrich finding IPs -> build dashboard -> complete
```

Add an `enriching` progress stage. Enrichment failure does not change analytical completeness or turn the job into `failed`.

Both upload and connected collection routes require an owning local workspace, but only connected collection requires an attached `ExtraHopClient`. Pass the optional workspace client into upload jobs so connected uploads may be enriched and offline uploads skip enrichment. Do not route enrichment from the browser through a series of generic proxy calls: server ownership is needed so full CSVs and top projections receive the same metadata and bounds.

### 6.3 Candidate addresses and time window

- collect only source and destination addresses from flows with at least one finding;
- normalize and deduplicate addresses before querying;
- for connected capture, reuse the job's absolute requested interval as `active_from` and `active_until` when supported;
- for uploaded capture, use the validated first and last PCAP record timestamps;
- if an uploaded capture has no usable time window, exact-IP lookup can proceed without an activity window, but the enrichment status should record that it was not time-constrained;
- do not query ExtraHop for healthy-flow-only addresses merely to decorate data that is not displayed or exported.

### 6.4 Bounds and transport ownership

Enrichment requires explicit settings and failure behavior. Recommended starting points, to be confirmed with fixtures and a live smoke test:

- maximum unique finding addresses per job: 2,000;
- maximum exact-IP rules per request: 50;
- maximum returned device rows per job: 10,000;
- one job-level absolute deadline shared across collection, analysis orchestration, and enrichment;
- no more than 30 seconds of the remaining job budget may be spent on enrichment;
- bounded pagination per request batch;
- cancellation checks between batches and pages.

Expose these through `PcapJobSettings` and `EH_PCAP_*` environment variables if operational tuning is warranted. If the unique-address limit is reached, rank candidate addresses by appearance in the displayed/exported finding rows and report the omitted count in neutral enrichment metadata.

The job establishes its absolute deadline before the first stage begins and never extends it. The enrichment collector owns batching, pagination, cancellation, and use of the remaining deadline; a shorter enrichment-stage budget may reduce that remaining time but must not create a fresh operation window. `ExtraHopClient` continues to own HTTP retries and rate-limit backoff; do not add an outer transport retry loop.

### 6.5 Match resolution

Device identity can vary by discovery mode and sensor context, and a console or RevealX 360 tenant can return multiple devices for one IP. The packet result does not currently provide a reliable sensor identity with which to choose among them.

Use these rules:

1. Zero matches: leave the name absent.
2. One match with a meaningful name: attach it as decoration.
3. Multiple matches with the same normalized meaningful display name: the common name may be shown, while retaining `matchCount` in metadata.
4. Multiple matches with conflicting names: do not choose one. Keep the IP alone and mark the address as ambiguous.
5. A display name equal to the IP address, an empty value, or another clearly non-enriching default is treated as no useful name.

Prefer `display_name`, with a verified fallback such as `default_name`. Do not fall back to local reverse DNS. Device IDs and node IDs remain opaque decimal strings after backend normalization and must not be parsed numerically in JavaScript.

Suggested endpoint decoration shape:

```json
{
  "address": "10.10.10.25",
  "port": 443,
  "device": {
    "displayName": "web-prod-07",
    "matchStatus": "unique",
    "matchCount": 1,
    "deviceId": "9223372036854775806"
  }
}
```

Omit the `device` object when no useful decoration exists. An ExtraHop device link can be considered later, but it is not required for this change.

## 7. CSV contract

Extend the existing server-streamed CSV route with an allowlisted scope or finding query. One reasonable route shape is:

- `/backend/pcap-analyzer/jobs/{id}/csv?scope=all_findings`
- `/backend/pcap-analyzer/jobs/{id}/csv?finding=reverse_not_observed`
- `/backend/pcap-analyzer/jobs/{id}/csv?finding=sequence_gap`

Equivalent explicit subroutes are acceptable if they produce clearer validation. Do not accept arbitrary sort fields or expressions.

Semantics:

- reverse export: every row whose `findingKinds` contains `reverse_not_observed`;
- sequence export: every row whose `findingKinds` contains `sequence_gap`;
- all-findings export: every row with a non-empty `findingKinds` list;
- a flow with multiple findings appears once in all-findings CSV with the combined finding list;
- no export includes healthy flows;
- visible top-25 limits never affect CSV selection.

Recommended added columns:

- `sourceDeviceName`;
- `sourceDeviceMatchStatus`;
- `destinationDeviceName`;
- `destinationDeviceMatchStatus`.

Keep `sourceAddress` and `destinationAddress` unchanged and ahead of the decoration fields. Preserve CSV formula neutralization for every text column and numeric treatment for measured values. Do not expose credentials, raw packet content, or unbounded lists of ambiguous device candidates.

Suggested filenames:

- `datafeed-analysis-all-findings-{job}.csv`;
- `datafeed-analysis-reverse-direction-{job}.csv`;
- `datafeed-analysis-sequence-gaps-{job}.csv`.

Use the server `Content-Disposition` filename or a matching browser filename rather than a generic hard-coded name.

## 8. Frontend implementation concepts

Likely files:

- `index.html`: replace the generic finding selector/table with dashboard canvases, export action, and two top-table cards;
- `js/modules/pcap-analyzer.js`: consume the dashboard projection, manage charts, render endpoint decoration, and invoke scoped exports;
- `js/utils/module-loader.js`: add the shared chart-theme dependency if used;
- `css/styles.css`: add Datafeed-owned responsive chart/table styles or extract genuinely shared action styles;
- `tests/pcap-analyzer.test.js` and `tests/module-loader.test.js`: cover behavior and dependency changes.

Implementation principles:

- keep the existing feature registry lifecycle and cancel behavior;
- clear prior dashboard state when a new analysis begins;
- enable export controls only for a completed job with matching rows;
- use DOM `textContent` for names and addresses;
- keep address text selectable and monospaced where practical;
- use native tables for the top 25, not canvas-rendered tables;
- include an accessible chart description and preserve the tables as equivalent detail;
- use responsive horizontal charts that grow vertically with row count rather than compressing labels;
- avoid creating a separate chart-theme editor inside Datafeed Analysis.

System Health patterns worth reusing conceptually:

- export action tiles with a short title and explanatory description;
- small export buttons in a card header for table-specific CSV;
- a status line that confirms the exported filename;
- shared palette resolution and chart frames;
- deterministic render cleanup when report data changes.

Datafeed Analysis should continue to stream potentially large CSVs from the backend. System Health's in-browser Blob export is appropriate for its already-loaded report model, but is not the right precedent for full Datafeed result exports.

## 9. Backend implementation concepts

Likely files:

- `backend/pcap_analyzer/analyzer.py`: add capture bounds and missing distinct-flow summary values if the canonical result should own them;
- `backend/pcap_analyzer/jobs.py`: add enrichment state, bounded device lookup, row decoration, dashboard projection, deterministic rankings, and scoped CSV selection;
- `main.py`: pass the workspace's optional attached client to upload jobs and validate CSV scope/finding query parameters; offline uploads skip enrichment;
- `backend/extrahop_client.py`: only if a verified device response introduces an identifier field not already covered by the normalization contract;
- `tests/test_pcap_analyzer.py`, `tests/test_pcap_jobs.py`, and route/session tests.

Keep one canonical row builder. Dashboard top lists, paged results, and CSV should not each invent their own finding membership, endpoint naming, or sort semantics.

Consider introducing small immutable projection types for endpoint decoration, enrichment status, and dashboard data. Exact class names and file splitting are implementation choices; a separate module is justified only if it keeps `jobs.py` materially clearer. Any new shipped runtime file must be added to `scripts/build_dist.py`.

## 10. Failure and partial-state behavior

- Packet analysis failure remains a failed job.
- Packet collection partiality remains independent of enrichment status.
- Enrichment authorization failure, timeout, rate-limit exhaustion, malformed response, or no match does not erase packet results.
- Enrichment should report `complete`, `partial`, `unavailable`, `skipped`, or an equivalently explicit small status vocabulary.
- A normal no-match is data, not an error.
- An address omitted by the enrichment cap is distinct from no match.
- Chart counts and exports remain available when enrichment is incomplete.
- CSV endpoints remain workspace-bound and job-owner-bound.
- Workspace expiration or removal continues to remove all retained result metadata; detaching the ExtraHop client does not remove completed local-upload results.

## 11. Test plan

### 11.1 Analyzer and projection tests

- distinct affected-flow counts are correct when one flow has multiple finding kinds;
- reverse, truncation, and sequence-gap flow counts remain separate;
- total gap bytes and observations are not conflated;
- capture bounds use all records and are stable across multiple input files;
- top-25 rankings follow the specified deterministic tie-breakers;
- dashboard values use the entire result, not a paged subset;
- measured zero and unavailable/partial state remain distinguishable.

### 11.2 Enrichment tests

- exact `ipaddr` filters are sent through `POST /api/v1/devices/search` for both Enterprise and RevealX 360 fixtures;
- candidate IPs are normalized and deduplicated;
- batch, page, row, address, deadline, and cancellation limits are enforced;
- the capture interval is reused in device search where supported;
- upload jobs receive only the optional client attached to the owning workspace; offline uploads receive no client and skip enrichment;
- a unique useful name decorates but never replaces the IP;
- no match leaves the decoration absent;
- identical multiple names are handled deterministically;
- conflicting multiple names remain ambiguous and do not select a winner;
- IP-shaped names are suppressed as non-enrichment;
- device and node IDs remain exact opaque strings;
- authorization, timeout, and rate-limit outcomes do not fail the packet analysis;
- transport retries are not multiplied outside `ExtraHopClient`.

### 11.3 CSV tests

- all-findings CSV excludes rows with no findings;
- reverse and sequence CSVs contain every matching row, not just 25;
- a multi-finding flow occurs once in all-findings CSV;
- enrichment uses separate name/status columns and retains IP columns;
- formula-like device names and addresses are neutralized;
- numeric measurements remain numeric;
- filenames identify the selected export;
- workspace ownership, expiry, and nonterminal-job errors remain enforced.

### 11.4 Browser tests

- a completed job renders summary cards, both charts, and both top tables without requesting an unfiltered default result page;
- the top tables never render more than 25 rows;
- IP:port is primary and the device name is secondary;
- missing/ambiguous enrichment never removes an IP or creates `undefined` text;
- chart values and tooltips use the dashboard projection;
- the category-overlap explanation is present;
- the segmented chart control changes metric, title, tooltip data, and rows together;
- empty states are independent per section;
- each export control requests the correct full-result scope;
- all-findings export is disabled when there are no findings;
- charts are cleaned up or reused across reruns and feature deactivation;
- module-loader tests reflect any added chart-theme dependency.

### 11.5 Verification and live smoke tests

Run the standard repository checks:

```bash
npm test
npm run check:syntax
npm run lint
python -m pytest -q
ruff check main.py backend tests
python scripts/build_dist.py
git diff --check
```

The fixture suite cannot prove device-search parity across live deployments. Before merge or release, run bounded smoke tests against:

- one self-managed sensor or console;
- one RevealX 360 tenant;
- one IP with a unique device match;
- one no-match IP;
- where available, an IP that produces multiple device matches.

Record deployment type, product version, query window, result fields, and match behavior without retaining credentials or customer packet data.

## 12. Acceptance criteria

The work is complete when:

- the completed-job default contains no generic "All findings" table or unfiltered finding page;
- charts are computed from the full bounded result and clearly disclose overlapping categories;
- the reverse and sequence tables show no more than 25 deterministic top rows;
- each table exports every row in its category;
- all-findings CSV exports every affected flow exactly once and no healthy flows;
- every UI and CSV endpoint keeps IP addresses as the canonical value;
- a unique useful ExtraHop device name appears only as optional decoration;
- ambiguous or failed enrichment never guesses, replaces an IP, or fails analysis;
- enrichment and export work is explicitly bounded and cancellable;
- Enterprise and RevealX 360 use the same documented device-search family;
- identifier normalization, workspace ownership, temporary-file cleanup, and distribution allowlisting remain intact;
- all standard checks pass.

## 13. Deferred or explicitly out of scope

- local reverse-DNS lookup;
- replacing IP labels with device names;
- claiming that an ExtraHop device match proves the Packetstore and Packet Sensor observed identical traffic;
- per-gap packet timelines or packet-payload inspection;
- an interactive browser for every retained flow;
- PDF or PowerPoint export;
- direct links into an ExtraHop device page unless a stable cross-deployment URL contract is separately verified;
- resolving conflicting multi-device matches by arbitrary device ID, newest modification time, or first response order.

## 14. Evidence reviewed

Repository implementation:

- [Architecture contract](architecture.md)
- [PCAP analyzer](../backend/pcap_analyzer/analyzer.py)
- [PCAP job and CSV manager](../backend/pcap_analyzer/jobs.py)
- [Datafeed Analysis browser module](../js/modules/pcap-analyzer.js)
- [Datafeed Analysis markup](../index.html)
- [System Health report and export patterns](../js/modules/system-health-report.js)
- [Shared chart theme](../js/modules/chart-theme.js)
- [Device search usage](../js/modules/device-discovery.js)

ExtraHop references:

- [Search for a device through the REST API](https://docs.extrahop.com/9.5/rest-search-for-device/)
- [ExtraHop REST API Guide](https://docs.extrahop.com/current/rest-api-guide/)
- [Devices overview and device-name behavior](https://docs.extrahop.com/current/devices-overview/)
