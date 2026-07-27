# Repository Overhaul Decision Record

- Date: 2026-07-26
- Status: Accepted
- Scope: correctness, resilience, architecture, and repository engineering controls

## Context

The original System Health REST audit identified aggregation, alignment, cardinality, continuation, capacity, connection, and testing problems. That work was subsequently implemented and covered by focused tests. A broader review then found high-priority defects in Records reporting, Audit Logs, dashboard mutations, Network Localities, identifier transport, and deployment capability gating, plus unbounded diagnostic and PDF paths and architectural coupling in global browser modules.

Leaving the System Health audit in `AGENTS.md` made completed findings look like current repository instructions. The repository also lacked one concise statement of its cross-cutting contracts.

## Decision

1. Correct observable data and mutation semantics before broad module rewrites. Each P1 correction receives behavioral regression tests.
2. Make cross-boundary contracts explicit: local proxy ownership, deployment capabilities, opaque identifiers, retry/deadline ownership, absolute report windows, and collection statuses.
3. Preserve partial failure honestly. Successful mutations are reconciled and authoritative state is reloaded; failed collection is not converted to zero or silently omitted.
4. Bound work at every high-cardinality boundary: pagination, metrics, queues, logs, request bodies, PDF rendering, and distribution contents.
5. Keep one transport retry policy in the backend. Feature code owns only feature-specific polling, cancellation, and an absolute deadline.
6. Move gradually from global classic scripts toward explicit feature interfaces and ES modules. Do not combine correctness fixes with an all-at-once browser rewrite.
7. Treat automated tests, linting, and distribution construction as release gates. Keep live-appliance verification explicit because fixtures cannot establish product-version compatibility.
8. Archive completed audits under `docs/audits/`. They remain historical evidence and are not active specifications.

The resulting contracts are summarized in [../architecture.md](../architecture.md). The original System Health audit is preserved verbatim at [../audits/2026-07-26-system-health-rest-api-audit.md](../audits/2026-07-26-system-health-rest-api-audit.md).

## Consequences

- Some duplication remains while browser modules are migrated incrementally.
- Capability differences must be maintained as data and tested rather than inferred from failures.
- Renderers and exports should consume canonical report models; changes that affect one projection may require coordinated updates to all projections.
- Resource-limit failures become visible to users instead of allowing unbounded or misleading work.
- Live ExtraHop verification remains a deliberate manual activity until suitable non-customer integration environments and credential handling exist.

## Follow-up direction

- Finish the reviewed P1 correctness slices and their behavior tests.
- Extract canonical report/view models before further renderer growth.
- Introduce an awaited feature registry with cancellation, then migrate modules in coherent slices.
- Add targeted browser end-to-end and live integration smoke coverage when stable environments are available.
- Revisit historical prototype retention according to [2026-07-26-prototype-artifacts.md](2026-07-26-prototype-artifacts.md).
