## Highlights

- Dashboard sharing now distinguishes preserving, enabling, and removing all-users access from clearing all direct user and group grants. Removing only all-users access preserves explicit grants.
- Single and bulk user deletion can optionally clear direct dashboard sharing before transferring owned objects. Sharing is preserved by default. Deletion proceeds only after cleanup receives an acknowledged write and successful verification; earlier successful changes remain applied if later work fails. Collections and activity maps retain their sharing, and shared collections can still provide dashboard access.
- Sharing replacements are verified by readback, with accepted but unverified updates reported separately from confirmed changes. An HTTP 422 response receives one readback to reconcile changes that were applied despite the API error, without repeating the mutation. A reconciled 422 still stops user deletion.
- Startup, local tools, and manual connection controls remain usable when the operating-system credential service is locked or unresponsive. Credential-store calls time out after five seconds and provide guidance to unlock the keyring or connect manually.

**Full changelog:** https://github.com/thomaswde/eh-admin-tools/compare/v2026.08.09...v2026.10.21
