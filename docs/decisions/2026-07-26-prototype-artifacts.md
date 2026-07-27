# Prototype Artifact Retention

- Date: 2026-07-26
- Status: Accepted, revisit when design history has a durable archive
- Artifacts: `ui-mockup.html` and `docs/pptx-polish/`

## Context

These files were created while exploring application UI and PowerPoint visual direction. They duplicate some production assets and contain generated presentations and experimental scripts, but they also preserve useful visual provenance for later design comparison. They are not referenced by the application, tests, launcher, or distribution runtime.

The distribution is built from the explicit allowlist in `scripts/build_dist.py`. Neither root `ui-mockup.html` nor the `docs` tree is copied, so these artifacts are excluded from end-user ZIPs.

## Decision

Retain the artifacts in the repository as historical prototypes for now. They are:

- non-runtime and unsupported as product entry points;
- excluded from distributions and release validation;
- not authoritative for current UI, report semantics, branding, or PowerPoint output;
- exempt from normal runtime lint/test expectations where configuration supports exclusions;
- changed only for deliberate design archaeology or archival work.

Retention avoids deleting potentially useful design evidence during the correctness overhaul and avoids mixing binary-history cleanup with runtime changes. The cost is approximately one megabyte of repository content and some discoverability noise, addressed by this record.

## Revisit criteria

Move the artifacts to a durable design archive or remove them in a dedicated history-cleanup change when all of the following are true:

- current design decisions are represented by maintained source and documentation;
- the prototype files are no longer used for comparison;
- any needed screenshots or rationale have been preserved in a lighter design record;
- repository owners agree on whether binary history should be rewritten or only future files removed.

Until then, do not import, package, modernize, or delete these files as part of unrelated feature work.
