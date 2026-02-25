# TD-035: Refactor long handler functions over 100 lines

**Type:** TD
**Priority:** P3
**Effort:** M
**Status:** Done
**Completed:** 2026-02-25
**Created:** 2026-02-25

---

## Problem

Three handler functions exceed 100 lines, reducing readability and maintainability:

1. `handleTaskNext` in `tasks/handlers.ts` — complex priority scoring + query building
2. `handleAdjustPriorities` in `coordination/handlers.ts` — multi-step adjustment logic
3. `handleTaskBlock` in `tasks/handlers.ts` — block/unblock with cascading updates

---

## Goal

Extract logical sub-operations from each function into well-named private helpers. Target: no function exceeds ~80 lines. Preserve exact behavior — pure refactoring, no logic changes.

---

## Tasks

### Pending
- [ ] Identify extractable sub-operations in `handleTaskNext`
- [ ] Identify extractable sub-operations in `handleAdjustPriorities`
- [ ] Identify extractable sub-operations in `handleTaskBlock`
- [ ] Extract helpers, keeping them private to the module
- [ ] Verify build passes and behavior unchanged

### In Progress
_(None yet)_

### Completed
_(None yet)_

---

## Session State

**Current State:** Brief created
**Next Steps When Resuming:** Read the 3 functions and identify extraction points
**Last Updated:** 2026-02-25
**Blockers:** None

---

## Acceptance Criteria

1. [ ] No handler function exceeds 80 lines
2. [ ] Extracted helpers have descriptive names
3. [ ] Zero behavior changes
4. [ ] Build passes cleanly

---

**Created:** 2026-02-25
**Last Updated:** 2026-02-25
