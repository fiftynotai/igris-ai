# FR-052: Brain v5.0 Phase 1 — Engine Foundation

**Type:** Feature Request
**Priority:** P0-Critical
**Effort:** L-Large (3-5d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** In Progress
**Created:** 2026-02-17
**Parent Brief:** FR-051

---

## Feature Description

**What is the proposed feature?**

Replace the monolithic `brain-mcp-server/src/index.ts` (1,671 lines, 40 tools in one switch statement) with a modular engine architecture. The engine introduces a component registry, typed event bus, API gateway, pluggable storage adapters, and config-driven component loading. All 7 existing tool domains (memory, projects, briefs, sessions, instances, metrics, sync) are refactored into isolated components that implement the `BrainComponent` interface.

**Why is this valuable?**

This is the critical-path foundation for all subsequent Brain v5.0 phases. Without the modular engine, task management (FR-053), brief migration (FR-054), scheduling (FR-055), and autonomous coordination (FR-056) cannot be built cleanly. The current monolith cannot sustain further feature additions without compounding technical debt.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] Contributors (extending Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved

**Current situation:**
- `index.ts` is 1,671 lines with a 40-case switch statement
- Components are tightly coupled — can't test or replace individually
- No event system — components call each other directly
- Storage layer is embedded in `db.ts` with no abstraction
- Adding new tools requires editing the monolith

**With this feature:**
- 7 isolated domain components, each ~200-300 lines
- Each component independently testable
- Event bus decouples all cross-component communication
- Storage adapter abstraction enables future PostgreSQL support
- New components added via config without touching existing code

---

## Technical Approach

### High-Level Design

The engine is structured into 5 architectural layers:

```
TRANSPORT → API GATEWAY → COMPONENT REGISTRY → DOMAIN COMPONENTS → STORAGE ADAPTERS
```

**Transport Layer:** MCP stdio (local), MCP HTTP/SSE (remote)
**API Gateway:** Tool routing from MCP tool names to component handlers
**Component Registry:** Loads components from config, resolves dependencies, runs migrations, wires event bus
**Domain Components:** 7 modules implementing BrainComponent interface
**Storage Adapters:** SQLite implementation (PostgreSQL interface only)

### Component Contract

Every domain component implements:

```typescript
interface BrainComponent {
  name: string;              // "memory", "projects", etc.
  version: string;           // "1.0.0"
  depends: string[];         // ["projects"] — resolved by registry

  schema(): Migration[];     // Tables this component owns
  tools(): ToolDefinition[]; // MCP tools to register
  events(): {
    emits: EventDef[];       // Events this component produces
    listens: EventDef[];     // Events this component consumes
  };

  init(ctx: ComponentContext): void;   // Receives: storage, bus, logger, config
  destroy(): void;                     // Cleanup on shutdown
}
```

### Components Affected
- `brain-mcp-server/src/index.ts` — replaced by modular engine
- `brain-mcp-server/src/db.ts` — replaced by storage adapter layer
- `brain-mcp-server/src/staging.ts` — absorbed into sync component
- `brain-mcp-server/src/tools/*.ts` — refactored into component modules
- `brain-mcp-server/package.json` — updated dependencies
- `~/.igris/config.json` — extended with component configuration

### Database Migration

Migrate from `~/.igris/memory/knowledge.db` to `~/.igris/data/brain.db`:
- All existing tables preserved with identical schema
- Each component owns its tables (declared in `schema()` method)
- Component registry runs migrations in dependency order on boot
- Old DB path kept as fallback during transition

---

## Context & Inputs

### Dependencies
- [x] Existing: `@modelcontextprotocol/sdk` ^1.22.0
- [x] Existing: `better-sqlite3` ^11.0.0
- [ ] No new dependencies for Phase 1

### Files to Create

**Engine core:**
- `brain-mcp-server/src/engine/index.ts` — Entry point, config loader, boot sequence
- `brain-mcp-server/src/engine/registry.ts` — Component registry, dependency resolver
- `brain-mcp-server/src/engine/bus.ts` — Typed event bus
- `brain-mcp-server/src/engine/gateway.ts` — MCP tool router (replaces switch)
- `brain-mcp-server/src/engine/types.ts` — Shared types (BrainComponent, ComponentContext, etc.)

**Storage layer:**
- `brain-mcp-server/src/engine/storage/adapter.ts` — StorageAdapter interface
- `brain-mcp-server/src/engine/storage/sqlite.ts` — SQLite implementation

**Domain components (refactored from existing tools):**
- `brain-mcp-server/src/engine/components/memory/index.ts`
- `brain-mcp-server/src/engine/components/projects/index.ts`
- `brain-mcp-server/src/engine/components/briefs/index.ts`
- `brain-mcp-server/src/engine/components/sessions/index.ts`
- `brain-mcp-server/src/engine/components/instances/index.ts`
- `brain-mcp-server/src/engine/components/metrics/index.ts`
- `brain-mcp-server/src/engine/components/sync/index.ts`

### Files to Modify
- `brain-mcp-server/src/index.ts` — Rewritten to boot engine instead of monolith
- `brain-mcp-server/package.json` — Build scripts, no new deps
- `brain-mcp-server/tsconfig.json` — Path mappings if needed

### Configuration Changes
- `~/.igris/config.json` — Add `engine` section with component config

---

## Constraints

### Technical Constraints
- **100% backward compatibility** — All 40 existing MCP tools must work identically
- Same tool names, same input schemas, same response formats
- Must work offline (no cloud dependency)
- Must work on macOS (local) and Linux (VPS)
- SQLite remains the only required dependency
- Existing `~/.igris/memory/knowledge.db` must continue working until migration is verified

### UX Constraints
- Zero disruption to developer workflow
- `/hunt`, `/scan`, `/awaken`, `/rest`, `/sync` must work identically
- Brain health check must still respond correctly

### Out of Scope
- Task management (FR-053)
- Brief file migration from projects (FR-054)
- Scheduling system (FR-055)
- Autonomous coordination (FR-056)
- PostgreSQL adapter implementation (interface only)
- REST API for dashboard (future)
- New MCP tools (only refactor existing ones)

---

## Tasks

### Pending
- [ ] Task 1: Create engine types (BrainComponent, ComponentContext, StorageAdapter interfaces)
- [ ] Task 2: Implement event bus with typed events
- [ ] Task 3: Implement storage adapter (SQLite implementation)
- [ ] Task 4: Implement component registry with dependency resolution
- [ ] Task 5: Implement API gateway (tool routing from MCP to components)
- [ ] Task 6: Refactor memory tools into memory component
- [ ] Task 7: Refactor projects tools into projects component
- [ ] Task 8: Refactor briefs tools into briefs component
- [ ] Task 9: Refactor sessions tools into sessions component
- [ ] Task 10: Refactor instances tools into instances component
- [ ] Task 11: Refactor metrics tools into metrics component
- [ ] Task 12: Refactor sync tools into sync component
- [ ] Task 13: Rewrite index.ts to boot engine
- [ ] Task 14: Add config-driven component loading to config.json
- [ ] Task 15: Database migration script (knowledge.db → brain.db)
- [ ] Task 16: Verify all 40 MCP tools work identically
- [ ] Task 17: Update brain init script for v5.0 directory structure

### In Progress

### Completed

---

## Workflow State

**Phase:** PAUSED (plan complete, awaiting v4.0 publish)
**Active Agent:** none
**Retry Count:** 0

### Current Work
ARCHITECT plan complete at `ai/plans/FR-052-plan.md`. HUNT paused — v4.0 publish takes priority.

### Next Steps
After v4.0 published: resume HUNT → user approves plan → BUILDING phase with FORGER.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-17 | orchestrator | Brief registration from FR-051 Phase 1 | SUCCESS |
| 2026-02-17 | orchestrator | HUNT INIT — status updated, brain synced | SUCCESS |
| 2026-02-17 | architect | Planning engine architecture and component refactoring | SUCCESS — 11-phase plan, 17 files (15 new, 2 modify), 8 components, 27 tools mapped |

### Blockers
None

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] Engine boots from config and loads all 7 domain components
2. [ ] Component registry resolves dependencies in correct order
3. [ ] Event bus delivers events between components (at least 3 event types wired)
4. [ ] Storage adapter abstracts all SQLite operations behind interface
5. [ ] API gateway routes all 40 MCP tools to correct component handlers
6. [ ] All 40 existing MCP tools return identical results to v4.0
7. [ ] Database migrated from `knowledge.db` to `brain.db` with zero data loss
8. [ ] Components can be enabled/disabled via config without code changes
9. [ ] TypeScript compilation clean (zero errors, zero warnings)
10. [ ] Brain MCP server starts successfully and passes health check
11. [ ] VPS sync (push/pull) works with new architecture
12. [ ] No regressions — `/awaken`, `/hunt`, `/rest`, `/sync` all work

---

## Test Plan

### Functional Tests

**Test Case 1: Engine Boot**
**Steps:**
1. Start brain MCP server with v5.0 engine
2. Verify all 7 components load in dependency order
3. Check health endpoint responds
4. Verify tool count matches expected (40 tools)

**Expected Result:** Engine boots, all components loaded, health check passes
**Status:** [ ] Pass / [ ] Fail

**Test Case 2: Backward Compatibility**
**Steps:**
1. Call every existing v4.0 MCP tool (all 40)
2. Compare response format and data with v4.0 output
3. Verify `igris_memory_store`, `igris_brain_push`, `igris_instance_heartbeat` specifically

**Expected Result:** 100% identical behavior
**Status:** [ ] Pass / [ ] Fail

**Test Case 3: Component Isolation**
**Steps:**
1. Disable instances component in config
2. Restart engine
3. Verify instance tools are not registered
4. Verify all other tools still work
5. Re-enable, verify instance tools return

**Expected Result:** Components load/unload independently
**Status:** [ ] Pass / [ ] Fail

**Test Case 4: Event Bus**
**Steps:**
1. Call `igris_memory_store` to create a learning
2. Verify `memory.learned` event fires
3. Verify sync component queues the learning for remote sync

**Expected Result:** Events propagate between components
**Status:** [ ] Pass / [ ] Fail

**Test Case 5: Database Migration**
**Steps:**
1. Back up `~/.igris/memory/knowledge.db`
2. Run migration script
3. Verify `~/.igris/data/brain.db` has identical data
4. Verify all queries return same results

**Expected Result:** Zero data loss during migration
**Status:** [ ] Pass / [ ] Fail

### Regression Tests
- [ ] All 40 existing MCP tools return identical results
- [ ] VPS sync push/pull works with new architecture
- [ ] Crimson Arena dashboard reads from correct DB
- [ ] Skills (/hunt, /scan, /register, /archive) work unchanged
- [ ] Performance: tool response time within 2x of v4.0

---

## Delivery

### Documentation
- [ ] Architecture doc: `docs/BRAIN_V5_ARCHITECTURE.md`
- [ ] Component development guide (inline comments in types.ts)

### Deployment Notes
- [ ] Requires brain MCP server restart after deploy
- [ ] Database migration runs automatically on first boot
- [ ] VPS deployment via `/sync code` to update remote brain server
- [ ] Rollback: revert commit + restore knowledge.db backup

---

## Success Metrics

- All 40 MCP tools work identically with new architecture
- New component can be scaffolded in <30 minutes (following contract)
- Engine boot time within 2x of v4.0 monolith startup
- Zero data loss during database migration

---

## Notes

**Parent brief:** FR-051 (Brain v5.0 Modular Architecture)
**Phase:** 1 of 5
**Critical path:** This must complete before FR-053, FR-054, FR-055, FR-056 can begin.

**Key architectural decisions (from FR-051):**
- Option C: Hybrid DB + Cache — DB is source of truth, markdown generated on demand
- Component contract: BrainComponent interface with schema(), tools(), events(), init(), destroy()
- Event bus pattern: components communicate via typed events, never direct calls
- Storage adapter: interface-first design, SQLite default

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Crimson (Igris AI)
