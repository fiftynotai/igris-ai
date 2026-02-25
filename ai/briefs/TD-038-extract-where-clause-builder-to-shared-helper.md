# TD-038: Extract WHERE clause builder to shared helper

**Type:** TD
**Priority:** P3
**Effort:** S
**Status:** Done
**Completed:** 2026-02-25
**Created:** 2026-02-25

---

## Problem

The pattern of building dynamic WHERE clauses with conditions array and params array is duplicated across 3 handler files (tasks, coordination, schedules). Each handler independently constructs `const conditions: string[] = []` / `const params: any[] = []` and joins with `AND`.

---

## Goal

Extract a shared `WhereBuilder` utility or `buildWhere()` function into `engine/helpers.ts` that provides a clean API for constructing parameterized WHERE clauses. Replace duplicated patterns across handler files.

---

## Tasks

### Pending
- [ ] Identify all WHERE clause builder patterns across handler files
- [ ] Design `buildWhere()` or `WhereBuilder` API
- [ ] Implement in `engine/helpers.ts`
- [ ] Replace duplicated patterns in tasks, coordination, schedules handlers
- [ ] Build passes cleanly

### In Progress
_(None yet)_

### Completed
_(None yet)_

---

## Session State

**Current State:** Brief created
**Next Steps When Resuming:** Audit WHERE clause patterns across all handler files
**Last Updated:** 2026-02-25
**Blockers:** None

---

## Acceptance Criteria

1. [ ] Shared WHERE builder exists in `engine/helpers.ts`
2. [ ] All handler files use the shared builder
3. [ ] Zero duplicated WHERE clause construction patterns
4. [ ] Build passes cleanly

---

**Created:** 2026-02-25
**Last Updated:** 2026-02-25
