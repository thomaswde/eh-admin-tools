## Highlights

- Dashboard and user administration now includes compound filters, recorded-activity lookbacks, select-all-filtered workflows, and guarded bulk changes. High-impact dashboard changes require an additional confirmation, optional configuration backups are available before destructive changes, and bulk user deletion can transfer owned objects.
- Completed Device Discovery, Records, and System Health reports now persist in a bounded, connection-isolated local cache so results survive reloads and reconnects. System Health stores a compact canonical summary, restores it across export formats, and more clearly preserves partial, unavailable, and measured-zero states.
- Network locality CSV imports now run as bounded backend jobs with pagination, cancellation, retained per-row outcomes, and downloadable outcome CSVs. Imports can be reviewed after a reload or reconnect without treating ambiguous or unattempted rows as successful.
- Dashboard activity collection is capability-aware across RevealX 360 and supported Enterprise console connections. Saved appliance connections are classified more accurately, including EDA/EFC sensors, ETA Packetstores, ECA consoles, and virtual appliance variants, so unsupported controls stay gated without speculative API calls.
- Added a bounded Packetstore diagnostic-log sanitizer that redacts sensitive values while preserving useful troubleshooting context.
- Reporting and collection resilience improved across System Health and related views, including safer metric batching, cache validation, consistent filter state, and clearer handling of incomplete appliance data.

**Full changelog:** https://github.com/thomaswde/eh-admin-tools/compare/v2026.08.04...v2026.08.06
