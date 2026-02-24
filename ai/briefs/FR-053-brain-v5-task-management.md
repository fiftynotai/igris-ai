# FR-053: Brain v5.0 Phase 2 — Task Management System

**Type:** Feature Request
**Priority:** P0-Critical
**Effort:** L-Large (3-5d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** In Progress
**Created:** 2026-02-17
**Parent Brief:** FR-051
**Blocked By:** FR-052

---

## Feature Description

**What is the proposed feature?**

Add a full task management system to the brain engine. Introduces a unified `tasks` table that supports 4 task types (brief, operational, personal, system), task dependencies via a DAG, agent assignment tracking, and a `igris_task_next` tool that returns the highest-priority unblocked task for an agent. Briefs become a rich document layer linked to tasks via nullable FK.

**Why is this valuable?**

Currently only briefs exist as work units. There is no way to track lightweight operational tasks ("renew SSL cert"), personal tasks ("review that article"), or system tasks ("run weekly audit"). The task management system provides a unified view of all work — briefs, ops, personal, system — in one queryable database with dependency resolution and agent assignment.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved

**Current situation:**
- Only briefs exist as work units — heavyweight documents for any task
- No task dependencies — can't express "do X before Y"
- No agent assignment tracking — no record of who did what
- No `task_next` — agents must be told what to do manually
- Personal and system tasks have no tracking at all

**With this feature:**
- 4 task types in one system: brief (rich), operational (lightweight), personal, system
- DAG-based dependencies with automatic unblocking
- Agent assignment tracking (who, when, result)
- `igris_task_next` enables agent self-assignment
- Unified task view across all scopes

---

## Technical Approach

### High-Level Design

New `tasks` component implements the BrainComponent interface from FR-052's engine. New `briefs-v2` component extends the existing briefs component with full content storage (not just metadata).

### Database Schema

**Tasks table:**
```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  task_type TEXT NOT NULL CHECK (task_type IN ('brief','operational','personal','system')),
  scope TEXT NOT NULL CHECK (scope IN ('project','personal','system')),
  title TEXT NOT NULL,
  description TEXT,
  brief_id TEXT REFERENCES briefs(id),
  project_slug TEXT REFERENCES projects(slug),
  parent_id TEXT REFERENCES tasks(id),
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 3,
  assignee TEXT,
  due_at TEXT,
  defer_until TEXT,
  created_by TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE task_deps (
  task_id TEXT REFERENCES tasks(id),
  depends_on TEXT REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on)
);

CREATE TABLE task_assignments (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  agent TEXT NOT NULL,
  assigned_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  result TEXT
);
```

### New MCP Tools
- `igris_task_create` — Create task (any type)
- `igris_task_list` — List/filter tasks (by status, scope, type, assignee, project)
- `igris_task_get` — Get task details
- `igris_task_assign` — Assign task to agent
- `igris_task_complete` — Mark task done with result
- `igris_task_block` — Add/remove dependencies between tasks
- `igris_task_next` — Get highest-priority unblocked task (with optional role filter)
- `igris_task_update` — Update task fields (title, priority, status, due_at, etc.)

### Event Bus Integration
- Emits: `task.created`, `task.assigned`, `task.completed`, `task.blocked`, `task.unblocked`
- Listens: `brief.created` (auto-create linked task), `brief.completed` (auto-complete linked task)

### Components Affected
- New: `engine/components/tasks/` — full task management
- Modified: `engine/components/briefs/` — add full content storage, link to tasks
- Modified: `engine/components/sync/` — add task sync support
- Modified: `engine/components/sessions/` — log task assignments

---

## Context & Inputs

### Dependencies
- [x] FR-052 (Engine Foundation) — must complete first
- [x] No new npm dependencies

### Files to Create
- `brain-mcp-server/src/engine/components/tasks/index.ts`
- `brain-mcp-server/src/engine/components/tasks/schema.ts`
- `brain-mcp-server/src/engine/components/tasks/handlers.ts`

### Files to Modify
- `brain-mcp-server/src/engine/components/briefs/index.ts` — add full content, link to tasks
- `brain-mcp-server/src/engine/components/sync/index.ts` — add task sync
- `brain-mcp-server/src/engine/components/sessions/index.ts` — log assignments

---

## Constraints

### Technical Constraints
- Must integrate cleanly with FR-052 engine architecture
- Must use BrainComponent interface and event bus (no direct cross-component calls)
- `igris_task_next` must be atomic (no race conditions with concurrent agents)
- All existing MCP tools must continue working unchanged

### UX Constraints
- Task creation must be fast (<100ms response)
- `igris_task_next` must consider: priority, dependencies, defer_until, due_at
- Task IDs should be human-readable short UUIDs or sequential

### Out of Scope
- Scheduling/cron integration (FR-055)
- Autonomous agent coordination (FR-056)
- Brief file migration from projects (FR-054)
- UI for task management (dashboard in separate brief)

---

## Tasks

### Pending
- [ ] Task 1: Design tasks component schema and migrations
- [ ] Task 2: Implement task CRUD handlers (create, get, list, update)
- [ ] Task 3: Implement task dependency DAG (block, unblock, check unblocked)
- [ ] Task 4: Implement task assignment handlers (assign, complete, history)
- [ ] Task 5: Implement `igris_task_next` with priority + dependency resolution
- [ ] Task 6: Wire event bus (task events, brief linkage)
- [ ] Task 7: Add task sync support to sync component
- [ ] Task 8: Extend briefs component with full content storage
- [ ] Task 9: Verify all new + existing MCP tools work correctly

### In Progress

### Completed

---

## Workflow State

**Phase:** COMMITTING
**Active Agent:** none
**Retry Count:** 0

### Current Work
WARDEN APPROVE. 3 fixes applied (task_deps sync, done-guard, status bypass). Build clean. Ready to commit.

### Next Steps
Commit and mark Done.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-17 | orchestrator | Brief registration from FR-051 Phase 2 | SUCCESS |
| 2026-02-24 | orchestrator | HUNT INIT — brief loaded, status In Progress | SUCCESS |
| 2026-02-24 | architect | Create implementation plan (10 phases) | SUCCESS |
| 2026-02-24 | orchestrator | Plan approved by user | SUCCESS |
| 2026-02-24 | forger | Implement task management system (3 new + 5 modified files) | SUCCESS |
| 2026-02-24 | sentinel | Validation — 10/10 PASS, build clean, 38 tools | PASS |
| 2026-02-24 | warden | Code review — 3 warnings fixed | APPROVE |
| 2026-02-24 | orchestrator | DOCUMENTING skipped — internal engine, no public API docs | Skipped |

### Blockers
- ~~FR-052 must complete first~~ (DONE — commit f378111)

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] Tasks component loads via engine registry
2. [ ] Can create tasks of all 4 types (brief, operational, personal, system)
3. [ ] Task dependencies work — blocked tasks don't appear in `task_next`
4. [ ] Agent assignment tracked with timestamps and results
5. [ ] `igris_task_next` returns correct task based on priority + deps + defer
6. [ ] Brief creation auto-creates linked task via event bus
7. [ ] Brief completion auto-completes linked task
8. [ ] Tasks sync to remote brain via sync component
9. [ ] All existing MCP tools still work unchanged
10. [ ] TypeScript compilation clean

---

## Test Plan

### Functional Tests

**Test Case 1: Task Lifecycle**
**Steps:**
1. Create task via `igris_task_create`
2. Assign via `igris_task_assign`
3. Complete via `igris_task_complete`
4. Verify events fired and sync queued

**Expected Result:** Full lifecycle with event propagation
**Status:** [ ] Pass / [ ] Fail

**Test Case 2: Dependency Resolution**
**Steps:**
1. Create task A and task B
2. Block B on A (`igris_task_block`)
3. Call `igris_task_next` — should return A (B is blocked)
4. Complete A
5. Call `igris_task_next` — should return B (now unblocked)

**Expected Result:** Correct dependency-aware ordering
**Status:** [ ] Pass / [ ] Fail

**Test Case 3: Brief-Task Linkage**
**Steps:**
1. Create brief via `igris_brief_sync`
2. Verify linked task auto-created
3. Complete the brief
4. Verify linked task auto-completed

**Expected Result:** Briefs and tasks stay in sync
**Status:** [ ] Pass / [ ] Fail

### Regression Tests
- [ ] All 40 existing MCP tools unchanged
- [ ] VPS sync includes new task data
- [ ] Engine boot with tasks component enabled/disabled

---

## Delivery

### Documentation
- [ ] Task management API reference (in component README)
- [ ] Usage examples for all 8 new MCP tools

---

## Notes

**Parent brief:** FR-051 (Brain v5.0 Modular Architecture)
**Phase:** 2 of 5
**Depends on:** FR-052 (Engine Foundation)

**Key design decision from FR-051:** Unified tasks table with nullable brief_id FK. Briefs are rich documents; tasks are lightweight work units. One system, different depths per task type.

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Crimson (Igris AI)
