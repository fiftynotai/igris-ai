# TD-039: Move event emissions to component index files

**Type:** TD
**Priority:** P3
**Effort:** S
**Status:** Done
**Completed:** 2026-02-25
**Created:** 2026-02-25

---

## Problem

The schedules component emits events (`schedule.created`, `schedule.executed`, etc.) from `handlers.ts` instead of `index.ts`. The established architectural pattern across other components (memory, tasks, coordination) is to emit events from the component's `index.ts` where the event bus is initialized. Emitting from handlers requires passing the bus reference into handlers, creating unnecessary coupling.

---

## Goal

Move event emissions from `schedules/handlers.ts` to `schedules/index.ts`. The handler should return the data needed for emission, and the component index should emit the event after the handler completes.

---

## Tasks

### Pending
- [ ] Audit which events schedules/handlers.ts currently emits
- [ ] Design return-value pattern for handlers to signal events
- [ ] Move event emissions to schedules/index.ts
- [ ] Remove event bus dependency from handlers
- [ ] Build passes cleanly

### In Progress
_(None yet)_

### Completed
_(None yet)_

---

## Session State

**Current State:** Brief created
**Next Steps When Resuming:** Read schedules/handlers.ts to find all emit() calls
**Last Updated:** 2026-02-25
**Blockers:** None

---

## Acceptance Criteria

1. [ ] Zero `bus.emit()` or `emit()` calls in `schedules/handlers.ts`
2. [ ] All schedule events emitted from `schedules/index.ts`
3. [ ] Handler returns data needed for event emission
4. [ ] Build passes cleanly

---

**Created:** 2026-02-25
**Last Updated:** 2026-02-25
