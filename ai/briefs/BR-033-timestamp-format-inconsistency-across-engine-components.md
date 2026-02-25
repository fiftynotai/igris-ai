# BR-033: Timestamp format inconsistency across engine components

**Type:** BR
**Priority:** P0
**Effort:** TBD
**Status:** Done
**Created:** 2026-02-25
**Completed:** 2026-02-25

---

## Problem

Three different timestamp formats are used across the engine: tasks/coordination handlers use `YYYY-MM-DD HH:MM:SS` (SQLite format), schedules utils use `YYYY-MM-DDTHH:MM:SS.sssZ` (ISO format), and schema defaults use `datetime('now')`. Cross-component timestamp comparisons would yield incorrect results.

---

## Goal

Standardize all `now()` functions in tasks/handlers.ts, coordination/handlers.ts, and schedules/utils.ts to use ISO format. Update schema defaults in application code to match. 3 function changes.

---

## Tasks

### Pending
- [ ] TBD

### In Progress
_(None yet)_

### Completed
_(None yet)_

---

## Session State

**Current State:** Brief created
**Next Steps When Resuming:** Define tasks and acceptance criteria
**Last Updated:** 2026-02-25
**Blockers:** None

---

## Acceptance Criteria

1. [ ] TBD

---

**Created:** 2026-02-25
**Last Updated:** 2026-02-25
