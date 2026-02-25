# TD-034: Extract handler constants and shared error utility

**Type:** TD
**Priority:** P2
**Effort:** S
**Status:** Done
**Completed:** 2026-02-25
**Created:** 2026-02-25

---

## Problem

Multiple DRY violations and magic values across handler files:

1. **Duplicated validation arrays**: `validStatuses` and `validScopes` arrays are defined inline in `tasks/handlers.ts` at multiple call sites instead of module-level constants
2. **Repeated error extraction**: The pattern `err instanceof Error ? err.message : String(err)` appears 19x across 7 files — should be a shared `errMsg()` utility
3. **Magic number 30000**: Timeout value used without a named constant (coordination/index.ts)
4. **Magic number 1000**: Retry backoff base used without a named constant (coordination/index.ts)

---

## Goal

1. Extract `validStatuses` and `validScopes` as module-level `const` arrays in `tasks/handlers.ts`
2. Add `errMsg(err: unknown): string` to `engine/helpers.ts`
3. Replace all 19 `err instanceof Error ? err.message : String(err)` occurrences with `errMsg(err)`
4. Add `DEFAULT_TIMEOUT_MS = 30_000` and `RETRY_BACKOFF_BASE_MS = 1_000` constants in coordination

---

## Tasks

### Pending
- [ ] Add `errMsg()` to `engine/helpers.ts`
- [ ] Extract `validStatuses` and `validScopes` to module-level constants in `tasks/handlers.ts`
- [ ] Add named constants for magic numbers in `coordination/index.ts`
- [ ] Replace all 19 inline error extraction patterns with `errMsg()` across 7 files
- [ ] Build passes cleanly

### In Progress
_(None yet)_

### Completed
_(None yet)_

---

## Session State

**Current State:** Brief created
**Next Steps When Resuming:** Start with errMsg() utility, then sweep all files
**Last Updated:** 2026-02-25
**Blockers:** None

---

## Acceptance Criteria

1. [ ] `errMsg()` exists in `engine/helpers.ts`
2. [ ] Zero instances of `err instanceof Error ? err.message : String(err)` remain
3. [ ] `validStatuses` and `validScopes` are module-level constants
4. [ ] No magic numbers for timeout/backoff in coordination
5. [ ] Build passes cleanly

---

**Created:** 2026-02-25
**Last Updated:** 2026-02-25
