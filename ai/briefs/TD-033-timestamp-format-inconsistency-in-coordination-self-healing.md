# TD-033: Fix timestamp format inconsistency in coordination self-healing

**Type:** TD
**Priority:** P1
**Effort:** XS
**Status:** Done
**Completed:** 2026-02-25
**Created:** 2026-02-25

---

## Problem

The self-healing handler in `coordination/index.ts:143` uses a truncated timestamp format (`new Date().toISOString().replace('T', ' ').substring(0, 19)`) instead of the standardized `now()` helper from `engine/helpers.ts`. This was missed by BR-033's timestamp standardization sweep and produces inconsistent format in the `autonomous_decisions` table.

---

## Goal

Replace the inline timestamp with `now()` from `engine/helpers.ts` to ensure all coordination records use ISO 8601 format consistently.

---

## Tasks

### Pending
- [ ] Import `now` from `../../helpers.js` in `coordination/index.ts`
- [ ] Replace `new Date().toISOString().replace('T', ' ').substring(0, 19)` with `now()` at line ~143
- [ ] Verify no other truncated timestamp patterns remain in the file

### In Progress
_(None yet)_

### Completed
_(None yet)_

---

## Session State

**Current State:** Brief created
**Next Steps When Resuming:** Implement one-line fix
**Last Updated:** 2026-02-25
**Blockers:** None

---

## Acceptance Criteria

1. [ ] `coordination/index.ts` uses `now()` from helpers instead of inline timestamp
2. [ ] No truncated timestamp formats remain in the file
3. [ ] Build passes cleanly

---

**Created:** 2026-02-25
**Last Updated:** 2026-02-25
