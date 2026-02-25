# TD-028: Extract shared handler helpers to reduce DRY violations

**Type:** TD
**Priority:** P1
**Effort:** TBD
**Status:** Done
**Created:** 2026-02-25
**Completed:** 2026-02-25

---

## Problem

`errorResult()`, `successResult()`, and `now()` are copy-pasted identically across 4 handler files: tasks/handlers.ts, coordination/handlers.ts, schedules/handlers.ts, and cache/handlers.ts. DRY violation that compounds as the engine grows.

---

## Goal

Extract these 3 functions into a shared `brain-mcp-server/src/engine/helpers.ts` module. Update all 4 handler files to import from the shared module. Standardize `now()` to use ISO format (aligns with BR-033 timestamp fix).

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
