# TD-027: Sync component event listeners declared but not wired

**Type:** TD
**Priority:** P1
**Effort:** TBD
**Status:** Done
**Created:** 2026-02-25
**Completed:** 2026-02-25

---

## Problem

The sync component declares 10 event listeners in its `events().listens` array (memory.stored, error.stored, project.registered, session.synced, brief.synced, instance.heartbeat, metrics.recorded, task.created, task.completed, task.assigned) but `init()` has zero `bus.on()` calls. The comment says "listeners are wired" which contradicts the code.

---

## Goal

Either wire the event listeners as no-ops (with TODO for auto-push), or remove the `listens` declarations to match reality. Fix the misleading comment.

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
