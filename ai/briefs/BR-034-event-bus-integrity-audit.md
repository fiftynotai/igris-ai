# BR-034: Event Bus Integrity Audit — Brain Engine v5.0

**Type:** Bug Report  
**Priority:** P1-High  
**Effort:** M-Medium (2-3 hours)  
**Status:** Done
**Created:** 2025-02-25  

## Problem

The brain engine event bus system has multiple integrity issues that break event-driven architecture and prevent component coordination:

1. **6 phantom events** declared in component `events().emits` but emitted in handler functions outside component control
2. **16 orphan events** that are emitted but have no listeners, breaking event-driven patterns
3. **1 incomplete TODO** (sync auto-push) that was never implemented
4. **Architecture violation** where handlers emit events instead of components

These issues prevent:
- Event-driven automation (e.g., auto-sync on brief completion)
- Cross-component coordination (tasks → metrics, cache → notifications)
- System extensibility (new components cannot hook into event streams)
- Proper monitoring and audit trails

## Goal

Audit and repair the event bus system to ensure:
- Every declared event has a matching emission point
- All emitted events are properly declared
- All declared listeners are actually wired
- Orphan events have intended consumers or are documented
- Architecture pattern is consistent (handlers don't emit events)

## Context and Inputs

**Scope:** All 12 components in `brain-mcp-server/src/engine/components/`

**Affected Components:**
- briefs, tasks, cache, coordination
- schedules, sessions, projects, instances
- memory, errors, metrics, sync

**Key Files:**
- Brain engine type definitions: `brain-mcp-server/src/engine/types.ts`
- Event bus implementation: `brain-mcp-server/src/engine/gateway.ts`
- All component index.ts and handlers.ts files

## Constraints

- Do NOT break existing event emissions
- Do NOT change component dependencies
- Maintain backward compatibility with engine.ready signal
- All cleanup must be in destroy() methods

## Acceptance Criteria

1. ✓ Remove `coordination.adjustment` phantom event or implement it
2. ✓ Move all schedule event emissions from handlers.ts to component tool handlers
3. ✓ Document why 13+ orphan events exist (intentional or missing consumers?)
4. ✓ Implement sync component auto-push listeners (or mark as future work)
5. ✓ Add integration tests verifying:
   - Every emitted event is declared
   - Every declared emit has a matching bus.emit() call
   - Every declared listen has a matching bus.on() call in init()
   - Every bus.on() has matching bus.off() in destroy()
6. ✓ All tests pass: `npm run test`
7. ✓ No linter errors: `npm run lint`

## Test Plan

### Manual Testing
1. Run engine initialization: `npm run test -- engine`
2. Verify no warnings about missing event declarations
3. Trigger events manually and verify listeners fire:
   - Create a brief → watch for brief.created event
   - Create a task → watch for task.created event
   - Complete a task → watch for task.completed + task.unblocked events
4. Verify cleanup on component destroy

### Automated Testing
1. Unit tests for each component's events() method
2. Integration test: bootstrap all components, verify wiring is correct
3. Event flow test: emit events through the bus, verify listeners execute
4. Cleanup test: destroy components, verify all listeners are unregistered

## Delivery

**Files to Update:**
- `brain-mcp-server/src/engine/components/*/index.ts` (event declarations)
- `brain-mcp-server/src/engine/components/schedules/handlers.ts` (event emission)
- `brain-mcp-server/src/engine/components/sync/index.ts` (auto-push wiring)
- `brain-mcp-server/src/engine/components/coordination/index.ts` (phantom event removal)
- New file: `brain-mcp-server/src/tests/event-bus-integrity.test.ts` (integration tests)

**Documentation:**
- Update component docstrings with event flow details
- Document why orphan events exist in code comments
- Create event bus architecture guide

## Notes

**Audit Report:** Complete findings in `/tmp/event_integrity_matrix.txt` with:
- 6 phantom events (schedules component)
- 16 orphan events (no listeners)
- 1 incomplete TODO (sync auto-push)
- 1 architecture violation (handlers emitting)

**Pattern Analysis:**
The schedules component is the outlier — it emits events from handlers.ts instead of from the component tool handlers. This should be standardized.

