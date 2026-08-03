# Contributing

ExtraHop Admin Tools is a local FastAPI application with a browser client. Changes should preserve the local-proxy security boundary and keep report calculations consistent across the browser and exported artifacts.

## Development setup

Use Python 3.10 or newer and Node.js 20 or newer.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
npm ci
```

Install Chromium only when working on PDF export:

```bash
python -m playwright install chromium
```

## Required checks

```bash
npm run check
python -m pytest -q
ruff check main.py backend tests
git diff --check
```

Behavior tests are preferred over assertions that search source text. API collection tests must distinguish measured zero, empty data, unavailable data, partial results, and failures. Fixtures containing ExtraHop identifiers should include values above JavaScript's safe-integer range.

## Architecture guardrails

- Browser code calls ExtraHop only through the local `/backend/extrahop` proxy.
- Credentials and OAuth tokens stay in the Python process.
- Keep TLS verification enabled by default and scope any untrusted-TLS opt-in to one Enterprise session.
- Use one canonical time window for each report and compare values with matching units and aggregation semantics.
- Treat identifiers and XIDs as opaque strings in browser-facing JSON.
- Batch supported API operations, drain metric XIDs to completion, and preserve per-object status.
- Put transient HTTP retries in the backend client; browser collectors own cancellation and operation deadlines.
- Reconcile successful mutations immediately and reload authoritative server state after partial success.

## Distribution

`python scripts/build_dist.py` creates the end-user ZIP from an explicit allowlist. New runtime files must be added to the build script and its validation list when applicable.

## GitLab-to-GitHub publishing

GitLab is authoritative. The standard checkout uses a `gitlab` remote for
`git@digit.i.extrahop.com:thomass/eh-admin-tools.git` and a `github` remote for
`git@github.com:thomaswde/eh-admin-tools.git`. Commit and push work to GitLab first.

To mirror `main` without making a release:

```bash
scripts/publish_github_release.sh --sync-only
```

For a release, update `VERSION`, `package.json`, and `package-lock.json` in the same
GitLab commit, using `YYYY.MM.DD` in `VERSION` and the equivalent numeric npm version.
Then run:

```bash
scripts/publish_github_release.sh
# or: scripts/publish_github_release.sh --notes-file release-notes.md
```

The release command requires a clean `main` exactly matching `gitlab/main`, refuses to
overwrite GitHub-only history, runs all JavaScript and Python checks, builds and verifies
the ZIP, creates the version tag in both repositories, and publishes the artifacts as a
GitHub release. Without `--notes-file`, GitHub generates the release notes.

