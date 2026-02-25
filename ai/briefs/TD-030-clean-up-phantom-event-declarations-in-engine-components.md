# TD-030: Clean up phantom event declarations in engine components

**Type:** TD
**Priority:** P2
**Effort:** TBD
**Status:** Done
**Created:** 2026-02-25
**Completed:** 2026-02-25

---

## Problem

Two events are declared in component `events().emits` but never actually emitted: (1) `memory.promoted` in memory component. (2) `coordination.adjustment` in coordination component. These phantom declarations pollute the event registry and confuse future developers.

---

## Goal

Either implement the event emissions at the appropriate code paths, or remove the declarations from the `emits` arrays. If removing, add a comment noting they were considered but deferred.

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
