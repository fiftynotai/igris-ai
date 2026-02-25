# TD-029: Add missing database indexes for autonomous decisions and schedules

**Type:** TD
**Priority:** P2
**Effort:** TBD
**Status:** Done
**Created:** 2026-02-25
**Completed:** 2026-02-25

---

## Problem

Two missing indexes: (1) `autonomous_decisions.agent` — handleAuditList supports filtering by agent but does a full table scan. (2) Composite index `(enabled, next_run_at)` on schedules — daemon's primary query would benefit from a composite index instead of two separate indexes.

---

## Goal

Add migration v3 for tasks schema with `idx_auto_decisions_agent` index. Add migration v2 for schedules schema with composite `idx_schedules_enabled_next` index.

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
