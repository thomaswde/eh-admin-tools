# Repository Working Instructions

Use these durable repository rules for ExtraHop Admin Tools. Verify implementation details against the current code and tests.

## Before editing

- Inspect the working tree and preserve unrelated changes.
- Read [docs/architecture.md](docs/architecture.md) before changing cross-cutting behavior.
- Treat `docs/audits/` and `docs/decisions/` as historical context, not active task lists.

## Working rules

- Keep the browser-to-ExtraHop boundary intact: browser code calls the loopback FastAPI service; credentials and upstream authentication stay server-side.
- Gate deployment-specific features through `js/utils/deployment-capabilities.js`. Do not discover unsupported endpoint families by making speculative runtime calls.
- Treat ExtraHop IDs and XIDs as opaque decimal strings after the backend normalizes them. Do not use `parseInt`, floating-point arithmetic, or numeric sorting on identifiers.
- Keep HTTP retry and rate-limit backoff in `backend/extrahop_client.py`. Feature collectors may own continuation polling, cancellation, and one absolute operation deadline, but must not multiply transport retries.
- For reports, compute one absolute window and reuse it. Preserve measured zero separately from offline, empty, unauthorized, failed, timed-out, or partial collection states. Never use aggregate totals as time-series peaks.
- Keep resource use bounded: pagination, metric cardinality, response logging, queues, request bodies, PDF work, and generated artifacts all require explicit limits and failure behavior.
- Prefer behavioral tests over source-string assertions. Add regression coverage with the correction, and keep browser, CSV, PDF, and PowerPoint projections consistent when they share domain semantics.
- Keep shipped runtime files in the explicit distribution allowlist maintained by `scripts/build_dist.py`.

## Verification

Run checks proportionate to the change. The standard repository checks are:

```bash
npm test
npm run check:syntax
npm run lint
python -m pytest -q
ruff check main.py backend tests
python scripts/build_dist.py
git diff --check
```

The GitLab pipeline runs the JavaScript, Python, lint, and distribution stages. Live ExtraHop coverage remains a separate manual integration activity; a green fixture suite is not evidence that every supported product version or deployment topology was exercised.
