# ARCHITECTURE & COMPONENT CONSISTENCY AUDIT
## Brain Engine v5.0 — 12 Component System

**Audit Date:** 2026-02-25  
**Status:** HEALTHY  
**Components Audited:** 12/12  
**Issues Found:** 0 Critical, 0 Major, 2 Minor (documentation)

---

## SECTION 1: COMPONENT INTERFACE COMPLIANCE

### All 12 Components Implement BrainComponent ✓

**Verified contract from `/engine/types.ts:157-176`:**
- `name: string` — Component identifier
- `version: string` — Semantic version
- `depends: string[]` — Dependency array
- `schema(): Migration[]` — Database migrations
- `tools(): ToolDefinition[]` — MCP tool definitions
- `events(): { emits, listens }` — Event declarations
- `init(ctx): void` — Initialization hook
- `destroy(): void` — Cleanup hook

### Component Inventory & Versions:

| # | Component | File | Version | Depends | Tools | Status |
|---|-----------|------|---------|---------|-------|--------|
| 1 | memory | `/components/memory/index.ts` | 1.0.0 | [] | 4 | ✓ |
| 2 | errors | `/components/errors/index.ts` | 1.0.0 | [] | 1 | ✓ |
| 3 | projects | `/components/projects/index.ts` | 1.0.0 | [] | 3 | ✓ |
| 4 | metrics | `/components/metrics/index.ts` | 1.0.0 | [] | 3 | ✓ |
| 5 | sessions | `/components/sessions/index.ts` | 1.0.0 | [] | 4 | ✓ |
| 6 | briefs | `/components/briefs/index.ts` | 1.0.0 | [] | 6 | ✓ |
| 7 | tasks | `/components/tasks/index.ts` | 1.0.0 | ['briefs'] | 10 | ✓ |
| 8 | instances | `/components/instances/index.ts` | 1.0.0 | [] | 4 | ✓ |
| 9 | sync | `/components/sync/index.ts` | 1.0.0 | [] | 11 | ✓ |
| 10 | cache | `/components/cache/index.ts` | 1.0.0 | ['briefs', 'sessions'] | 2 | ✓ |
| 11 | schedules | `/components/schedules/index.ts` | 1.0.0 | [] | 7 | ✓ |
| 12 | coordination | `/components/coordination/index.ts` | 1.0.0 | ['tasks'] | 6 | ✓ |

**Version Consistency:** All components use 1.0.0 — consistent baseline.

### Implementation Pattern — All 12 follow identical structure:

```typescript
export function createXxxComponent(): BrainComponent {
  let _ctx: ComponentContext | null = null;

  return {
    name: 'xxx',
    version: '1.0.0',
    depends: [...],
    
    schema(): Migration[] { ... },
    tools(): ToolDefinition[] { ... },
    events(): { emits, listens } { ... },
    
    init(ctx: ComponentContext): void { 
      _ctx = ctx;
      ctx.log.info('Xxx component initialized');
    },
    
    destroy(): void {
      _ctx = null;
    },
  };
}
```

**Compliance:** 100% — All 12 components implement the full interface correctly.

---

## SECTION 2: SCHEMA MIGRATION VERSIONING

### Components with Migrations (3 of 12):

#### 2.1 Tasks Component — `/components/tasks/schema.ts`

**Sequential Versions:** 1, 2, 3 ✓

- **v1:** Core tables (tasks, task_deps, task_assignments) with 8 indexes
- **v2:** Adds coordination columns (required_capabilities, retry_count, max_retries, fail_reason)
  - Creates agent_capabilities, autonomous_decisions, coordination_config tables
  - Properly recreates dependent tables with FK references
  - Documents PRAGMA foreign_keys no-op behavior (lines 90-94)
- **v3:** Adds index idx_auto_decisions_agent for audit queries

**Quality:** Excellent. Migrations are well-documented, use CREATE IF NOT EXISTS, proper FK handling.

#### 2.2 Schedules Component — `/components/schedules/schema.ts`

**Sequential Versions:** 1, 2 ✓

- **v1:** Core tables (schedules, schedule_runs) with 5 indexes
- **v2:** Adds composite index (enabled, next_run_at) for daemon polling

**Quality:** Excellent. Clear, minimal, well-indexed.

#### 2.3 Coordination Component — `/components/coordination/schema.ts`

**Type:** No migrations — uses seed initialization instead.

**Approach:** `initCoordinationSchema()` called during component init(). Uses INSERT OR IGNORE for idempotency.

Seeds:
- 21 default agent capabilities (architect, forger, sentinel, warden, mender, seeker, sage)
- 5 default coordination config values (autonomous_enabled=false, max_retries_default=3, etc.)

**Quality:** Good. Idempotent design allows safe re-initialization.

### Components WITHOUT Migrations (9 of 12):

All correctly return `[]` from schema():
- memory, errors, projects, metrics, sessions, briefs, instances, sync, cache

These wrap legacy tools or provide only tools/event plumbing.

**Migration Versioning Assessment:** HEALTHY

---

## SECTION 3: HANDLER PATTERN CONSISTENCY

### Handler Organization:

**4 components with handlers submodules:**
1. tasks — `./handlers.ts`
2. schedules — `./handlers.ts`
3. cache — `./handlers.ts`
4. coordination — `./handlers.ts`

### Import Pattern Audit (TD-028 - Extract Shared Helpers):

**✓ ALL handler files import from `../../helpers.js`:**

| Component | Import Statement | Line |
|-----------|------------------|------|
| tasks | `import { errorResult, successResult, now } from '../../helpers.js'` | 17 |
| schedules | `import { errorResult, successResult } from '../../helpers.js'` | 19 |
| cache | `import { errorResult, successResult } from '../../helpers.js'` | 17 |
| coordination | `import { errorResult, successResult, now } from '../../helpers.js'` | 14 |

**Shared Helpers Available (`/engine/helpers.ts`):**
```typescript
export function errorResult(message: string): ToolResult
export function successResult(text: string): ToolResult
export function now(): string  // ISO 8601 timestamp
```

**DB Access Pattern:**
All handlers use: `import { getDb } from '../../../db.js'`

Then call: `const db = getDb();`

**Assessment:** TD-028 RESOLVED ✓ — No DRY violations, centralized helper usage.

---

## SECTION 4: DEPENDENCY GRAPH

### Dependency Declaration Summary:

```
memory       → []
errors       → []
projects     → []
metrics      → []
sessions     → []
briefs       → []
tasks        → [briefs]
instances    → []
sync         → []
cache        → [briefs, sessions]
schedules    → []
coordination → [tasks]
```

### Topological Order (resolved via Kahn's algorithm in registry.ts:59-96):

```
0. memory, errors, projects, metrics, sessions, briefs, instances, sync, schedules
   (9 components with no deps — independent)
1. tasks (depends on briefs)
2. cache (depends on briefs, sessions)
3. coordination (depends on tasks)
```

### Circular Dependency Detection:

- Registry implements cycle detection (line 66-68)
- No cycles found — graph is acyclic ✓

### Dependency Validation in Registry Boot:

```typescript
// Lines 78-88: Only resolve dependencies that are registered AND enabled
const depEntry = components.get(dep);
if (!depEntry) {
  throw new Error(`Component "${name}" depends on "${dep}" which is not registered`);
}
if (!depEntry.config.enabled) {
  throw new Error(`Component "${name}" depends on "${dep}" which is disabled`);
}
```

**Assessment:** HEALTHY — No cycles, proper validation, topological ordering enforced.

---

## SECTION 5: ENGINE CONFIGURATION & BOOT

### EngineConfig Registration:

**Location:** `/src/index.ts:116-132`

```typescript
const config: EngineConfig = {
  dbPath: DB_PATH,
  components: {
    memory: { enabled: true },
    errors: { enabled: true },
    projects: { enabled: true },
    metrics: { enabled: true },
    sessions: { enabled: true },
    briefs: { enabled: true },
    tasks: { enabled: true },
    instances: { enabled: true },
    sync: { enabled: true },
    cache: { enabled: true },
    schedules: { enabled: true },
    coordination: { enabled: true },
  },
};
```

**Status:** All 12 components registered ✓

### Boot Sequence (`/engine/index.ts:64-123`):

```
1. Create storage adapter (SQLite)        → setAdapter(storage) bridges db.ts
2. Create event bus
3. Create registry
4. Register all 12 components
5. Call registry.boot()
   - Resolve dependencies via topological sort
   - Run migrations per component in order
   - Call init() on each component in order
   - Collect all ToolDefinitions
6. Create API gateway
7. Register all tools with gateway
8. Emit engine.ready event
   - Components listening (schedules, coordination) capture dispatch reference
9. Return Engine { gateway, registry, storage, bus, shutdown }
```

**Assessment:** Boot sequence is correct and complete ✓

---

## SECTION 6: EVENT WIRING & INTER-COMPONENT COMMUNICATION

### Event Emissions by Component:

| Component | Events Emitted |
|-----------|-----------------|
| memory | memory.stored |
| errors | error.stored |
| projects | project.registered |
| metrics | metrics.recorded |
| sessions | session.synced, session.file.updated |
| briefs | brief.synced, brief.created, brief.completed |
| tasks | task.created, task.assigned, task.completed, task.blocked, task.unblocked, task.failed |
| instances | instance.heartbeat |
| sync | (none) |
| cache | cache.rebuilt, cache.cleaned |
| schedules | schedule.created, schedule.enabled, schedule.disabled, schedule.deleted, schedule.fire_now, schedule.run_start, schedule.run_complete |
| coordination | coordination.self_heal |

### Event Listeners by Component:

| Component | Events Listened |
|-----------|-----------------|
| tasks | brief.created, brief.completed |
| cache | brief.created, brief.synced, session.file.updated |
| schedules | engine.ready |
| coordination | task.failed, engine.ready |

### Event Flow Examples:

**Flow 1: Brief Creation → Auto-Task**
```
1. Brief synced → briefs component emits brief.created
2. Tasks component listens for brief.created
3. onBriefCreated() → handleTaskCreate() → auto-creates linked task
4. task.created event emitted
```

**Flow 2: Brief Completion → Auto-Cache**
```
1. Brief status → Done → briefs component emits brief.completed
2. Cache component listens for brief.synced/created
3. Cache regenerates markdown file to ~/.igris/cache/{project}/
```

**Flow 3: Task Failure → Self-Healing**
```
1. Task fails → tasks component emits task.failed
2. Coordination component listens for task.failed
3. onTaskFailed() checks autonomous_enabled + self_healing_enabled
4. Creates diagnostic child task if retry budget allows
5. coordination.self_heal event emitted
```

### Event Listener Cleanup:

All components that register listeners also unregister them in destroy():

- **tasks** (line 602-605): Unregisters brief.created, brief.completed
- **cache** (line 172-177): Unregisters brief.created, brief.synced, session.file.updated
- **schedules** (line 326): Unregisters engine.ready
- **coordination** (line 369-372): Unregisters engine.ready, task.failed

**Assessment:** HEALTHY — Event system is well-structured, listeners are properly wired and cleaned up.

---

## SECTION 7: MISSING INDEXES (TD-029)

### Tasks Component Schema:

**Current Indexes (v1-v3):**
```sql
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_type ON tasks(task_type);
CREATE INDEX idx_tasks_scope ON tasks(scope);
CREATE INDEX idx_tasks_project ON tasks(project_slug);
CREATE INDEX idx_tasks_brief ON tasks(brief_id);
CREATE INDEX idx_tasks_priority ON tasks(priority);
CREATE INDEX idx_tasks_parent ON tasks(parent_id);
CREATE INDEX idx_tasks_defer ON tasks(defer_until);
CREATE INDEX idx_task_assignments_task ON task_assignments(task_id);
CREATE INDEX idx_task_assignments_agent ON task_assignments(agent);
CREATE INDEX idx_auto_decisions_task ON autonomous_decisions(task_id);
CREATE INDEX idx_auto_decisions_type ON autonomous_decisions(decision_type);
CREATE INDEX idx_auto_decisions_time ON autonomous_decisions(created_at);
CREATE INDEX idx_auto_decisions_agent ON autonomous_decisions(agent);
```

**Recommended Additions:**

1. **Composite index for task.next query** (used frequently in igris_task_next):
   ```sql
   CREATE INDEX idx_tasks_status_priority_defer 
     ON tasks(status, priority, defer_until)
     WHERE status NOT IN ('done', 'cancelled', 'failed');
   ```

2. **Autonomous decisions compound query:**
   ```sql
   CREATE INDEX idx_auto_decisions_type_time
     ON autonomous_decisions(decision_type, created_at DESC);
   ```

3. **Coordination config lookup:**
   ```sql
   CREATE INDEX idx_coordination_config_key
     ON coordination_config(key);
   ```
   (Table is small, but good practice)

**TD-029 Status:** MINOR — Non-critical performance optimization opportunity.

---

## SECTION 8: INTEGRATION & HEALTH CHECKS

### Tools Count:

**Per Component:**
- memory: 4 (store, search, recall, pattern_suggest)
- errors: 1 (error_lookup)
- projects: 3 (register, list, status)
- metrics: 3 (record, query, velocity)
- sessions: 4 (sync, recall, file_get, file_update)
- briefs: 6 (sync, dashboard, get, list, create, update)
- tasks: 10 (create, list, get, assign, complete, block, next, update, fail, retry)
- instances: 4 (heartbeat, list, remove, agent_event)
- sync: 11 (brain_push, brain_pull, queue_status, queue_drain, brief_file_sync, session_file_sync, session_file_pull, definition_sync, definition_pull, file_push, file_pull)
- cache: 2 (rebuild, clean)
- schedules: 7 (create, list, get, enable, disable, fire_now, delete)
- coordination: 6 (capability_set, capability_list, adjust_priorities, config_set, config_get, audit)

**Total Tools:** 61 ✓

### Database Bridge:

**Pattern:** All handlers use `import { getDb } from '../../../db.js'`

Legacy tool modules continue to work via:
```typescript
// engine/index.ts:71
setAdapter(storage);  // Bridges new StorageAdapter to legacy getDb()
```

**Assessment:** HEALTHY — Bridge is transparent, legacy code unchanged.

---

## SECTION 9: TIMESTAMP CONSISTENCY

### Timestamp Format Audit:

**ISO 8601 Format Check:**

All components using timestamps:
- `helpers.ts:31`: `new Date().toISOString()` → "2026-02-25T14:30:45.123Z"
- `coordination/handlers.ts:143`: Custom format for autonomy audit log: "YYYY-MM-DD HH:MM:SS" (truncated ISO)
- All migration CREATE TABLE DEFAULT clauses: `datetime('now')` → "YYYY-MM-DD HH:MM:SS"

**Minor Note:** Coordination audit timestamp (line 143) uses truncated ISO format instead of full ISO. This is consistent with SQLite's datetime convention but differs from full ISO-8601.

**Assessment:** MOSTLY CONSISTENT ✓ (Minor formatting variation acceptable for database storage)

---

## SECTION 10: CRON SEMANTICS (TD-031)

### Schedules Component Cron Implementation:

**File:** `/components/schedules/cron.ts`

**Documented Deviation (index.ts:84-86):**
```
Note: uses AND logic when both day-of-month and day-of-week are specified 
(differs from POSIX OR semantics). Examples: "0 * * * *" (hourly), 
"30 2 * * 1" (Mon 2:30am)
```

**Status:** Deviation is documented in tool description ✓

---

## AUDIT RESULTS SUMMARY

| Category | Assessment | Status |
|----------|------------|--------|
| **Interface Compliance** | All 12 ✓ implement BrainComponent | ✓ PASS |
| **Version Consistency** | All v1.0.0, aligned | ✓ PASS |
| **Migration Versioning** | v1, v2, v3 sequential (tasks, schedules); coordination seeds | ✓ PASS |
| **Handler Patterns** | All use ../../helpers.js, ../../db.js | ✓ PASS |
| **DRY Violations** | TD-028 RESOLVED — centralized helpers | ✓ PASS |
| **Dependency Graph** | No cycles, proper topological order | ✓ PASS |
| **Engine Configuration** | All 12 registered, boot sequence correct | ✓ PASS |
| **Event Wiring** | Proper emit/listen, cleanup in destroy() | ✓ PASS |
| **Missing Indexes** | TD-029 identified 3 opportunities (non-critical) | ⚠ MINOR |
| **Timestamp Format** | Mostly ISO-8601 consistent | ✓ PASS |
| **Cron Semantics** | Deviation documented | ✓ PASS |
| **Cache Component** | Present, correctly wired | ✓ PASS |

---

## ARCHITECTURE VERDICT

### OVERALL HEALTH: GREEN ✓

**Strengths:**
1. Perfect component interface implementation (12/12)
2. No circular dependencies
3. Clean event-driven architecture
4. Proper lifecycle management (init/destroy)
5. DRY code with shared helpers
6. Well-documented deviations (PRAGMA, cron)

**Minor Opportunities:**
1. **TD-029**: Add 3 composite indexes for query optimization (non-blocking)
2. **TD-031**: CRON AND/OR semantics already documented (no action needed)
3. **TD-028**: RESOLVED ✓

**Risk Assessment:** NONE — System is stable and consistent.

**Recommendation:** Deploy as-is. TD-029 (indexes) can be addressed in next optimization cycle.

---

**Audit Date:** 2026-02-25  
**Auditor:** SEEKER (Codebase Research Specialist)  
**Confidence:** HIGH
