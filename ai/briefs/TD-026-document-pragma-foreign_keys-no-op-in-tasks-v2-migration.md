# TD-026: Document PRAGMA foreign_keys no-op in tasks v2 migration

**Type:** TD
**Priority:** P1
**Effort:** TBD
**Status:** Done
**Created:** 2026-02-25
**Completed:** 2026-02-25

---

## Problem

Tasks schema v2 migration wraps `PRAGMA foreign_keys = OFF/ON` inside a transaction (via sqlite.ts runMigrations). SQLite ignores PRAGMA changes inside transactions, making these statements no-ops. The migration data is safe (one-time, self-referential FKs), but the code is misleading.

---

## Goal

Add explanatory comment in tasks/schema.ts documenting why the PRAGMAs are benign. Consider restructuring to execute PRAGMAs outside the transaction wrapper, or document that the migration runner handles this.

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
