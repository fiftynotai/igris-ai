# TD-031: Document cron AND-vs-OR semantics deviation from POSIX

**Type:** TD
**Priority:** P2
**Effort:** TBD
**Status:** Done
**Created:** 2026-02-25
**Completed:** 2026-02-25

---

## Problem

The cron parser in schedules/cron.ts uses AND logic for dayOfMonth and dayOfWeek fields when both are non-wildcard. Standard POSIX cron (vixie cron) uses OR semantics. This is a documented design decision but not reflected in the MCP tool description, which could confuse users familiar with standard cron.

---

## Goal

Add a note to the `igris_schedule_create` tool description explaining the AND semantics deviation. Add inline comment in cron.ts at the relevant line.

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
