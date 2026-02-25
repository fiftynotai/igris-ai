# TD-036: Handler robustness and state cleanup

**Type:** TD
**Priority:** P3
**Effort:** S
**Status:** Done
**Completed:** 2026-02-25
**Created:** 2026-02-25

---

## Problem

Two handler code quality issues:

1. **Missing try/catch in DB operations**: Some handler functions perform database operations without try/catch, relying on the MCP framework to catch errors. Adding defense-in-depth try/catch with `errorResult()` provides better error messages and prevents unhandled rejections.

2. **Module-level mutable state**: `_handlerCtx` in `schedules/handlers.ts` is a module-level mutable variable set via `setHandlerContext()`. This pattern makes testing harder and creates implicit coupling. Consider refactoring to pass context explicitly or use a factory pattern.

---

## Goal

1. Add try/catch to handler DB operations that lack them, returning `errorResult()` with descriptive messages
2. Evaluate and optionally refactor `_handlerCtx` pattern in schedules/handlers.ts

---

## Tasks

### Pending
- [ ] Audit handler functions missing try/catch on DB operations
- [ ] Add try/catch with `errorResult()` where missing
- [ ] Evaluate `_handlerCtx` refactoring options
- [ ] Implement chosen refactoring approach
- [ ] Build passes cleanly

### In Progress
_(None yet)_

### Completed
_(None yet)_

---

## Session State

**Current State:** Brief created
**Next Steps When Resuming:** Audit all handler files for missing try/catch
**Last Updated:** 2026-02-25
**Blockers:** None

---

## Acceptance Criteria

1. [ ] All handler DB operations wrapped in try/catch
2. [ ] Error messages are descriptive (include operation context)
3. [ ] `_handlerCtx` pattern evaluated (refactored or documented as acceptable)
4. [ ] Build passes cleanly

---

**Created:** 2026-02-25
**Last Updated:** 2026-02-25
