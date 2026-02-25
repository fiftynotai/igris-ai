# TD-037: API input/output safety

**Type:** TD
**Priority:** P3
**Effort:** XS
**Status:** Done
**Completed:** 2026-02-25
**Created:** 2026-02-25

---

## Problem

Two API safety gaps:

1. **Sync remote response error leak** (`sync.ts:485`): When a remote sync fails, the error response body may be forwarded to the client, potentially leaking server structure or internal details from the remote VPS.

2. **Unbounded query params** (`src/index.ts`): The `days` and `limit` parameters on REST API endpoints accept any integer value without bounds checking. A request with `limit=999999` could cause excessive memory usage.

---

## Goal

1. Sanitize remote error responses in sync component — return generic error message, log raw details server-side
2. Add bounds validation for `days` (1-365) and `limit` (1-1000) query parameters

---

## Tasks

### Pending
- [ ] Sanitize remote sync error responses in `sync/index.ts`
- [ ] Add bounds validation for `days` param (default 7, max 365)
- [ ] Add bounds validation for `limit` param (default 50, max 1000)
- [ ] Build passes cleanly

### In Progress
_(None yet)_

### Completed
_(None yet)_

---

## Session State

**Current State:** Brief created
**Next Steps When Resuming:** Find the sync error handling and REST param parsing
**Last Updated:** 2026-02-25
**Blockers:** None

---

## Acceptance Criteria

1. [ ] Remote sync errors return generic message, raw details logged
2. [ ] `days` param bounded to 1-365
3. [ ] `limit` param bounded to 1-1000
4. [ ] Build passes cleanly

---

**Created:** 2026-02-25
**Last Updated:** 2026-02-25
