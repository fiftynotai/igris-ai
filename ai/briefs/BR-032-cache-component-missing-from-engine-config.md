# BR-032: Cache component missing from engine config

**Type:** BR
**Priority:** P0
**Effort:** TBD
**Status:** Done
**Created:** 2026-02-25
**Completed:** 2026-02-25

---

## Problem

The `cache` component is registered as a factory in `engine/index.ts` and included in the componentFactories array, but there is NO entry for `cache: { enabled: true }` in the engine configuration at `src/index.ts:118-130`. It works by accident via the DEFAULT_COMPONENT_CONFIG fallback, but would silently break if the config model ever changes to treat unlisted components as disabled.

---

## Goal

Add `cache: { enabled: true }` to the engine config in `brain-mcp-server/src/index.ts` between `sync` and `schedules`. 1 line fix.

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
