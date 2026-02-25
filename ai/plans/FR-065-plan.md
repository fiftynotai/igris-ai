# Implementation Plan: FR-065 — Distributed Task Orchestration: Multi-Agent Worker System

**Complexity:** XL (Extra Large)
**Estimated Duration:** 8-12 days across 7 waves
**Risk Level:** High

## Summary

Build the execution layer for distributed task orchestration. The brain already has task CRUD (10 tools), DAG dependencies, agent assignments, and coordination infrastructure (agent_capabilities, autonomous_decisions, coordination_config). This plan adds semantic task types, capability-filtered claiming, result storage, handler skills, a worker daemon, event wiring, and configuration — transforming inert task records into an autonomous execution pipeline.

---

## Current State Analysis

### What Already Exists

| Asset | Location | Status |
|-------|----------|--------|
| `tasks` table | `brain-mcp-server/src/engine/components/tasks/schema.ts` v2 | Has `required_capabilities`, `retry_count`, `max_retries`, `fail_reason` |
| `task_deps` table | Same schema | Fully operational DAG |
| `task_assignments` table | Same schema | Records agent assignment history |
| `agent_capabilities` table | Same schema v2 | Seeded with 20 default capabilities for 7 agents |
| `autonomous_decisions` table | Same schema v2 | Audit trail for coordination decisions |
| `coordination_config` table | Same schema v2 | Key-value config store (5 keys seeded) |
| `instances` table | `brain-mcp-server/src/db.ts` v4 | Tracks machine hostname, project, brief, phase |
| 10 task MCP tools | `brain-mcp-server/src/engine/components/tasks/index.ts` | Full CRUD + next + fail + retry |
| 6 coordination MCP tools | `brain-mcp-server/src/engine/components/coordination/index.ts` | Capabilities, priorities, config, audit |
| 4 instance MCP tools | `brain-mcp-server/src/engine/components/instances/index.ts` | Heartbeat, list, remove, agent_event |
| `igris_task_next` | `brain-mcp-server/src/engine/components/tasks/handlers.ts` | Already supports capability filtering via `agent_capabilities` table or explicit param |
| Self-healing listener | `brain-mcp-server/src/engine/components/coordination/index.ts` | `task.failed` -> diagnostic child task creation |
| 6 orphan task events | `brain-mcp-server/src/engine/components/tasks/index.ts` | `task.created`, `task.assigned`, `task.completed`, `task.blocked`, `task.unblocked`, `task.failed` |
| Event bus | `brain-mcp-server/src/engine/bus.ts` | Synchronous, wildcard support, error-safe |
| Monitoring component | `brain-mcp-server/src/engine/components/monitoring/index.ts` | Logs events to `event_log` table |
| Schedule daemon | `brain-mcp-server/src/engine/components/schedules/daemon.ts` | In-process smart-sleep timer pattern |
| Event-bus integrity tests | `brain-mcp-server/src/engine/__tests__/event-bus-integrity.test.ts` | Static source analysis for emit/listen parity |

### What Is Missing

| Gap | Description |
|-----|-------------|
| **Task type system** | `task_type` CHECK is `('brief','operational','personal','system')` -- needs semantic types `('dev','content','social-media','media-gen','research','operational')` |
| **Task claim tool** | No `igris_task_claim` -- agents can use `igris_task_next` with auto-assign, but there is no explicit claim-and-lock pattern |
| **Task result storage** | No `task_results` table -- completion only stores a text `result` on `task_assignments` |
| **Instance capabilities** | `igris_instance_heartbeat` does not accept/store capabilities -- only `agent_capabilities` table exists (static, not per-instance) |
| **Handler skills** | No `skills/task-handlers/` directory -- no portable markdown instructions per task type |
| **Worker daemon** | No `igris_worker.sh` -- no polling loop that spawns `claude -p` sessions |
| **Orphan event listeners** | 5 task events (`task.created`, `task.assigned`, `task.completed`, `task.blocked`, `task.unblocked`) are emitted but only listened to by the monitoring component (which does NOT listen to task events yet) |
| **Auto-routing** | Coordinator has no auto-assign logic beyond `igris_task_next` with capability match |
| **Worker config** | `config.json` has no worker settings; `coordination_config` has no `auto_route_enabled` |

---

## Implementation Waves

### Wave 1: Extend Task Type System (Schema + Validation)

**Goal:** Expand `task_type` from 4 generic values to 6 semantic types. Backward-compatible -- old types still valid.

**Files to Modify:**

| File | Action | Changes |
|------|--------|---------|
| `brain-mcp-server/src/engine/components/tasks/schema.ts` | MODIFY | Add migration v4: ALTER tasks to expand task_type CHECK constraint via table recreation |
| `brain-mcp-server/src/engine/components/tasks/handlers.ts` | MODIFY | Update `validTypes` array in `handleTaskCreate` to include new types |
| `brain-mcp-server/src/engine/components/tasks/index.ts` | MODIFY | Update `igris_task_create` and `igris_task_list` schema enums |

**Database Migration (tasks v4):**

```sql
-- Recreate tasks table with expanded task_type CHECK
CREATE TABLE tasks_v4 (
  -- all existing columns --
  task_type TEXT NOT NULL CHECK (task_type IN (
    'brief','operational','personal','system',
    'dev','content','social-media','media-gen','research'
  )),
  -- rest unchanged --
);
INSERT INTO tasks_v4 SELECT * FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_v4 RENAME TO tasks;
-- Recreate all indexes
-- Recreate task_deps and task_assignments FKs
```

**New Task Types:**

| Type | Description | Handler Skill |
|------|-------------|---------------|
| `dev` | Code implementation, testing, refactoring | `dev.md` |
| `content` | Writing, documentation, blog posts | `content.md` |
| `social-media` | Social media posts, scheduling | `social-media.md` |
| `media-gen` | Image/video generation via AI tools | `media-gen.md` |
| `research` | Investigation, analysis, exploration | `research.md` |
| `operational` | System maintenance, config changes (existing) | `operational.md` |

**Backward Compatibility:** Old types (`brief`, `personal`, `system`) remain valid. `brief` maps to `dev` handler at runtime. `personal` and `system` have no handler skill -- they are metadata-only.

**Test Scenarios:**
- Create task with new type `dev` -- succeeds
- Create task with old type `brief` -- still succeeds
- Create task with invalid type `invalid` -- fails with validation error
- List tasks filtered by `task_type: 'dev'` -- returns only dev tasks

**Effort:** S (1 day)

---

### Wave 2: Task Result Storage

**Goal:** Add `task_results` table for structured output storage. Tasks can have multiple results (e.g., a commit SHA, a generated image path, and a text summary).

**Files to Modify/Create:**

| File | Action | Changes |
|------|--------|---------|
| `brain-mcp-server/src/engine/components/tasks/schema.ts` | MODIFY | Add migration v5: CREATE TABLE task_results |
| `brain-mcp-server/src/engine/components/tasks/handlers.ts` | MODIFY | Add `handleTaskResultAdd` and `handleTaskResultGet` handlers |
| `brain-mcp-server/src/engine/components/tasks/index.ts` | MODIFY | Register 2 new MCP tools: `igris_task_result_add`, `igris_task_result_get` |
| `brain-mcp-server/src/tools/sync.ts` | MODIFY | Add `task_results` to `SYNC_TABLES` array |

**Database Migration (tasks v5):**

```sql
CREATE TABLE IF NOT EXISTS task_results (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  result_type TEXT NOT NULL CHECK (result_type IN (
    'commit','file','text','image','url','json','error'
  )),
  content TEXT NOT NULL,
  file_path TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_results_task ON task_results(task_id);
CREATE INDEX IF NOT EXISTS idx_task_results_type ON task_results(result_type);
```

**New MCP Tools:**

| Tool | Description |
|------|-------------|
| `igris_task_result_add` | Add a result to a task (task_id, result_type, content, file_path?, metadata?) |
| `igris_task_result_get` | Get all results for a task (task_id) or filter by result_type |

**Output Folder Convention:** `~/.igris/output/{task-type}/` -- the worker daemon will create this directory and reference it in `file_path` fields. This is a convention, not enforced by the schema.

**SYNC_TABLES Addition:**

```typescript
{
  table: 'task_results',
  syncKey: ['id'],
  strategy: 'lww',
  timestampCol: 'created_at',
  columns: ['id', 'task_id', 'result_type', 'content', 'file_path', 'metadata', 'created_at'],
}
```

**Test Scenarios:**
- Add a commit result to a task -- succeeds, returns result with ID
- Add multiple results to same task -- succeeds, all retrievable
- Get results for task with no results -- returns empty array
- Get results filtered by type -- returns only matching type
- Add result to non-existent task -- fails with error
- Verify task_results appears in SYNC_TABLES (update count test from 20 to 21)

**Effort:** S (1 day)

---

### Wave 3: Task Claim Tool and Instance Capabilities

**Goal:** Add explicit claim-and-lock pattern. Extend instance heartbeat to accept capabilities.

**Files to Modify:**

| File | Action | Changes |
|------|--------|---------|
| `brain-mcp-server/src/engine/components/tasks/handlers.ts` | MODIFY | Add `handleTaskClaim` handler |
| `brain-mcp-server/src/engine/components/tasks/index.ts` | MODIFY | Register `igris_task_claim` tool, emit `task.claimed` event |
| `brain-mcp-server/src/tools/instances.ts` | MODIFY | Extend `handleInstanceHeartbeat` to accept `capabilities` param, upsert into `agent_capabilities` |
| `brain-mcp-server/src/engine/components/instances/index.ts` | MODIFY | Update `igris_instance_heartbeat` schema to include `capabilities` property |
| `brain-mcp-server/src/engine/components/coordination/handlers.ts` | MODIFY | Add `handleAutoRoute` handler |
| `brain-mcp-server/src/engine/components/coordination/index.ts` | MODIFY | Register `igris_coordination_auto_route` tool, add `auto_route_enabled` to config seed |

**New MCP Tools:**

| Tool | Description |
|------|-------------|
| `igris_task_claim` | Atomically claim a specific task by ID for an agent. Fails if already claimed/active. Unlike `igris_task_next` which picks the best task, this claims a specific known task. |
| `igris_coordination_auto_route` | Run auto-routing: match pending tasks to online agents by capability overlap, assign automatically. Respects `auto_route_enabled` config. |

**`igris_task_claim` Logic:**
1. Validate task exists and status is `pending`
2. Validate agent (required)
3. Atomically update status to `active`, set assignee, create assignment record
4. Emit `task.claimed` event (alias for `task.assigned` with source: 'claim')
5. Return task + assignment

**Instance Capabilities Extension:**
- Add optional `capabilities` field to `igris_instance_heartbeat` input schema
- When provided, upsert capabilities into `agent_capabilities` table keyed by `instance_id` (not agent name)
- This allows different instances to register different capability sets

**Auto-Route Logic:**
1. Check `auto_route_enabled` config key
2. Query all pending tasks with `required_capabilities != '[]'`
3. Query all active instances (status = 'active', heartbeat within 30 min)
4. For each instance, look up capabilities from `agent_capabilities` table
5. Match: find tasks where all required capabilities are a subset of an instance's capabilities
6. Assign highest-priority match first (greedy algorithm)
7. Log decisions in `autonomous_decisions`
8. Emit `task.assigned` for each assignment

**Coordination Config Seed Addition:**

```typescript
['auto_route_enabled', 'false'],
```

**Test Scenarios:**
- Claim a pending task -- succeeds, status becomes active
- Claim an already-active task -- fails with error
- Claim a non-existent task -- fails with error
- Instance heartbeat with capabilities -- capabilities stored in agent_capabilities
- Instance heartbeat without capabilities -- existing behavior unchanged
- Auto-route with matching tasks and agents -- assigns correctly
- Auto-route with no matching agents -- no assignments, logs decision
- Auto-route when disabled -- returns early with message

**Effort:** M (2 days)

---

### Wave 4: Wire Orphan Task Events to Monitoring

**Goal:** The monitoring component already logs schedule, cache, and coordination events. Extend it to log all 6 task lifecycle events + the new `task.claimed` event.

**Files to Modify:**

| File | Action | Changes |
|------|--------|---------|
| `brain-mcp-server/src/engine/components/monitoring/index.ts` | MODIFY | Add 7 task event listeners: `task.created`, `task.assigned`, `task.completed`, `task.blocked`, `task.unblocked`, `task.failed`, `task.claimed`. Add to `EVENT_COMPONENT_MAP`, `events().listens`, `init()` bus.on calls, `destroy()` bus.off calls. |

**EVENT_COMPONENT_MAP Additions:**

```typescript
'task.created': 'tasks',
'task.assigned': 'tasks',
'task.completed': 'tasks',
'task.blocked': 'tasks',
'task.unblocked': 'tasks',
'task.failed': 'tasks',
'task.claimed': 'tasks',
```

**Critical Constraint:** The event-bus integrity test at `brain-mcp-server/src/engine/__tests__/event-bus-integrity.test.ts` performs static source analysis to verify:
1. Every declared listen has a matching `bus.on()` call
2. Every `bus.on()` has a matching `bus.off()` call
3. Declarations match explicitly -- no wildcards allowed in source

This means we MUST add 7 explicit `ctx.bus.on('task.X', onEventReceived)` calls in `init()` and 7 matching `_ctx.bus.off('task.X', onEventReceived)` calls in `destroy()`. Using `task.*` wildcard would pass the bus but fail the integrity test.

**Test Scenarios:**
- Create a task -- verify event_log row with event_name='task.created', component='tasks'
- Assign a task -- verify event_log row with event_name='task.assigned'
- Complete a task -- verify event_log row with event_name='task.completed'
- Block a task -- verify event_log row
- Unblock a task -- verify event_log row
- Fail a task -- verify event_log row
- Claim a task -- verify event_log row
- Existing monitoring tests still pass (schedule/cache/coordination events)
- Event-bus integrity test passes with new listeners

**Effort:** S (0.5 days)

---

### Wave 5: Task Handler Skills

**Goal:** Create portable markdown instruction files for each semantic task type. These are agent-agnostic -- any Claude Code session can read them to understand how to handle a task.

**Files to Create:**

| File | Action | Description |
|------|--------|-------------|
| `.claude/skills/task-handlers/dev.md` | CREATE | Instructions for dev tasks: read brief, plan, implement, test, commit |
| `.claude/skills/task-handlers/content.md` | CREATE | Instructions for content tasks: research, outline, draft, review |
| `.claude/skills/task-handlers/social-media.md` | CREATE | Instructions for social media tasks: generate posts, schedule |
| `.claude/skills/task-handlers/media-gen.md` | CREATE | Instructions for media generation tasks: prompts, API calls, output storage |
| `.claude/skills/task-handlers/research.md` | CREATE | Instructions for research tasks: explore codebase, summarize findings |
| `.claude/skills/task-handlers/operational.md` | CREATE | Instructions for operational tasks: config changes, maintenance |

**Skill Format (each file follows this structure):**

```markdown
# Task Handler: {type}

## When to Use
This handler is for tasks with `task_type: '{type}'`.

## Required Capabilities
{list of capabilities this handler needs}

## Execution Steps
1. Read the task details via `igris_task_get`
2. {type-specific steps}
3. Store results via `igris_task_result_add`
4. Complete the task via `igris_task_complete`

## Output Convention
- Results stored in `~/.igris/output/{type}/`
- Result types: {relevant result_type values}

## Error Handling
- On failure: call `igris_task_fail` with reason
- On recoverable error: add diagnostic metadata, retry
```

**Key Design Decision:** Handler skills are NOT Claude Code skills (no SKILL.md + slash command). They are plain markdown files that the worker daemon loads as instructions when spawning a `claude -p` session for a task. The worker daemon passes the handler content as part of the prompt.

**Test Scenarios:**
- All 6 handler files exist and are valid markdown
- Each handler references the correct task_type
- Each handler includes the required MCP tool calls (igris_task_get, igris_task_result_add, igris_task_complete)

**Effort:** S (0.5 days)

---

### Wave 6: Worker Daemon

**Goal:** Create `igris_worker.sh` -- a bash polling loop that auto-spawns Claude Code sessions to handle assigned tasks.

**Files to Create/Modify:**

| File | Action | Changes |
|------|--------|---------|
| `scripts/igris_worker.sh` | CREATE | Main worker daemon script |
| `scripts/igris_worker_config.sh` | CREATE | Worker config loader (reads from `~/.igris/config.json`) |

**Worker Daemon Design:**

```
igris_worker.sh
  |
  |-- Read config from ~/.igris/config.json
  |-- Register instance via igris_instance_heartbeat (with capabilities)
  |-- LOOP:
  |     |-- Poll: call igris_task_next via claude CLI (--tool-use-only mode)
  |     |-- If task found:
  |     |     |-- Load handler skill for task_type
  |     |     |-- Spawn: claude -p "Execute task {id}. Handler: {skill content}"
  |     |     |-- Store results via igris_task_result_add
  |     |     |-- Complete via igris_task_complete OR fail via igris_task_fail
  |     |-- If no task:
  |     |     |-- Sleep for poll_interval (default 30s)
  |     |-- Heartbeat: call igris_instance_heartbeat every 5 min
  |     |-- Check max concurrent tasks
  |-- On SIGINT/SIGTERM:
  |     |-- Remove instance via igris_instance_remove
  |     |-- Exit cleanly
```

**Config in `~/.igris/config.json`:**

```json
{
  "worker": {
    "enabled": false,
    "poll_interval_seconds": 30,
    "max_concurrent_tasks": 2,
    "allowed_task_types": ["dev", "research", "operational"],
    "agent_name": "worker",
    "capabilities": ["code", "test", "research", "investigate"],
    "auto_sleep_minutes": 60,
    "log_dir": "~/.igris/logs/worker"
  }
}
```

**Key Design Decisions:**

1. **Pure bash** -- no TypeScript runtime dependency. Uses `claude` CLI for MCP tool calls.
2. **Single-machine** -- one worker per machine. Multiple machines each run their own worker.
3. **No claude -p for polling** -- uses `claude --tool-use-only` (or direct MCP call via the brain server HTTP API) to call `igris_task_next` without spawning a full session.
4. **Spawns claude -p for execution** -- each task gets its own Claude Code session with the handler skill as system prompt.
5. **Graceful shutdown** -- traps SIGINT/SIGTERM, deregisters instance.
6. **Logging** -- writes to `~/.igris/logs/worker/worker.log` with rotation.
7. **Auto-sleep** -- if no tasks found for `auto_sleep_minutes`, daemon enters sleep mode (60s poll interval instead of 30s). Wakes on first task found.

**Integration with Install Script:**
- `igris_install.sh` does NOT auto-start the worker -- it only creates the config template
- Worker is manually started: `~/.igris/scripts/igris_worker.sh start`
- Can be added to launchd (macOS) or systemd (Linux) for auto-start

**Test Scenarios:**
- Worker starts and registers instance -- verify via `igris_instance_list`
- Worker polls and finds no tasks -- sleeps for poll_interval
- Worker polls and finds a task -- spawns claude session
- Worker receives SIGINT -- deregisters instance and exits
- Worker respects max_concurrent_tasks limit
- Worker filters by allowed_task_types
- Config with worker.enabled=false -- daemon refuses to start

**Effort:** L (3 days)

---

### Wave 7: Configuration and Global CLAUDE.md Enhancement

**Goal:** Wire worker settings into config.json, add `auto_route_enabled` to coordination config, and enhance the global `~/.claude/CLAUDE.md` with core Igris worker identity.

**Files to Modify:**

| File | Action | Changes |
|------|--------|---------|
| `scripts/igris_brain_init.sh` | MODIFY | Add worker config section to generated `config.json` |
| `scripts/igris_install.sh` | MODIFY | Create `~/.igris/logs/worker/` and `~/.igris/output/` directories. Copy worker script to `~/.igris/scripts/`. |
| `brain-mcp-server/src/engine/components/coordination/schema.ts` | MODIFY | Add `auto_route_enabled` to default config seed |

**Global CLAUDE.md Enhancement:**

The global `~/.claude/CLAUDE.md` (auto-generated by `igris_brain_init.sh`) should be expanded to include:

```markdown
## Worker Mode

When running as a worker daemon (`igris_worker.sh`), Claude Code sessions are spawned
with task-specific handler skills. The worker identity includes:

- **Role:** Task executor (not interactive assistant)
- **MCP Connection:** Brain MCP server at ~/.igris/memory/knowledge.db
- **Task Flow:** Claim -> Execute -> Store Results -> Complete/Fail
- **Required Tools:** igris_task_get, igris_task_result_add, igris_task_complete, igris_task_fail

When you receive a task prompt from the worker daemon:
1. Read the full task via igris_task_get
2. Follow the handler skill instructions
3. Store ALL outputs via igris_task_result_add
4. Complete the task via igris_task_complete (or igris_task_fail on error)
5. Do NOT ask for user input -- work autonomously
```

**Config.json Schema (full):**

```json
{
  "auto_push": false,
  "remote_brain": {
    "url": "",
    "api_key": ""
  },
  "worker": {
    "enabled": false,
    "poll_interval_seconds": 30,
    "max_concurrent_tasks": 2,
    "allowed_task_types": ["dev", "research", "operational"],
    "agent_name": "worker",
    "capabilities": ["code", "test", "research"],
    "auto_sleep_minutes": 60,
    "log_dir": "~/.igris/logs/worker"
  }
}
```

**Coordination Config Addition:**
- `auto_route_enabled` seeded as `'false'` in `initCoordinationSchema()`

**Test Scenarios:**
- `igris_brain_init.sh` generates config.json with worker section
- Worker config loads correctly from config.json
- `auto_route_enabled` appears in `igris_coordination_config_get` output
- Global CLAUDE.md includes worker mode section

**Effort:** S (1 day)

---

## Complete File Inventory

### Files to MODIFY (14)

| # | File | Wave | Changes |
|---|------|------|---------|
| 1 | `brain-mcp-server/src/engine/components/tasks/schema.ts` | 1, 2 | Migrations v4 (task types) + v5 (task_results) |
| 2 | `brain-mcp-server/src/engine/components/tasks/handlers.ts` | 1, 2, 3 | New types, result handlers, claim handler |
| 3 | `brain-mcp-server/src/engine/components/tasks/index.ts` | 1, 2, 3 | New tool registrations, schema updates, events |
| 4 | `brain-mcp-server/src/engine/components/coordination/handlers.ts` | 3 | Auto-route handler |
| 5 | `brain-mcp-server/src/engine/components/coordination/index.ts` | 3 | Auto-route tool, config seed |
| 6 | `brain-mcp-server/src/engine/components/coordination/schema.ts` | 7 | Seed `auto_route_enabled` |
| 7 | `brain-mcp-server/src/engine/components/instances/index.ts` | 3 | Heartbeat capabilities param |
| 8 | `brain-mcp-server/src/tools/instances.ts` | 3 | Heartbeat capabilities logic |
| 9 | `brain-mcp-server/src/engine/components/monitoring/index.ts` | 4 | 7 new task event listeners |
| 10 | `brain-mcp-server/src/tools/sync.ts` | 2 | Add task_results to SYNC_TABLES |
| 11 | `brain-mcp-server/src/engine/components/sync/__tests__/auto-push.test.ts` | 2 | Update SYNC_TABLES count from 20 to 21 |
| 12 | `scripts/igris_brain_init.sh` | 7 | Worker config in generated config.json |
| 13 | `scripts/igris_install.sh` | 7 | Create worker/output dirs, copy worker script |
| 14 | `brain-mcp-server/src/engine/components/monitoring/__tests__/monitoring.test.ts` | 4 | Update listener count assertions |

### Files to CREATE (9)

| # | File | Wave | Description |
|---|------|------|-------------|
| 1 | `.claude/skills/task-handlers/dev.md` | 5 | Dev task handler skill |
| 2 | `.claude/skills/task-handlers/content.md` | 5 | Content task handler skill |
| 3 | `.claude/skills/task-handlers/social-media.md` | 5 | Social media task handler skill |
| 4 | `.claude/skills/task-handlers/media-gen.md` | 5 | Media generation task handler skill |
| 5 | `.claude/skills/task-handlers/research.md` | 5 | Research task handler skill |
| 6 | `.claude/skills/task-handlers/operational.md` | 5 | Operational task handler skill |
| 7 | `scripts/igris_worker.sh` | 6 | Worker daemon main script |
| 8 | `scripts/igris_worker_config.sh` | 6 | Worker config loader helper |
| 9 | `brain-mcp-server/src/engine/components/tasks/__tests__/task-results.test.ts` | 2 | Unit tests for task results |

---

## Database Migrations Summary

| Component | Version | Description | Wave |
|-----------|---------|-------------|------|
| tasks | 4 | Expand task_type CHECK constraint with 5 new semantic types | 1 |
| tasks | 5 | Create task_results table with indexes | 2 |

**Migration Safety:** Both migrations use the established table-recreation pattern (CREATE new -> INSERT -> DROP old -> RENAME) that is already proven in the tasks v2 migration. The migration runner at `brain-mcp-server/src/engine/storage/sqlite.ts` wraps each migration in a transaction.

---

## New MCP Tools Summary

| Tool | Component | Wave | Description |
|------|-----------|------|-------------|
| `igris_task_result_add` | tasks | 2 | Add a structured result to a task |
| `igris_task_result_get` | tasks | 2 | Get results for a task (optionally by type) |
| `igris_task_claim` | tasks | 3 | Atomically claim a specific task for an agent |
| `igris_coordination_auto_route` | coordination | 3 | Auto-assign pending tasks to online agents by capability match |

**Total tool count change:** 63 existing + 4 new = 67 tools

---

## New Event Listeners Summary

| Event | Listener Component | Wave | Action |
|-------|--------------------|------|--------|
| `task.created` | monitoring | 4 | Log to event_log |
| `task.assigned` | monitoring | 4 | Log to event_log |
| `task.completed` | monitoring | 4 | Log to event_log |
| `task.blocked` | monitoring | 4 | Log to event_log |
| `task.unblocked` | monitoring | 4 | Log to event_log |
| `task.failed` | monitoring | 4 | Log to event_log (coordination already listens for self-heal) |
| `task.claimed` | monitoring | 4 | Log to event_log |

**Note:** `task.failed` already has a listener in the coordination component (self-healing). Adding the monitoring listener is additive -- both fire on the same event.

---

## SYNC_TABLES Impact

Current count: 20 tables.
After Wave 2: 21 tables (add `task_results`).

The `auto-push.test.ts` test asserts `SYNC_TABLES.toHaveLength(20)` -- this MUST be updated to 21 in Wave 2.

---

## Testing Strategy

### Unit Tests per Wave

| Wave | Test File | Scenarios |
|------|-----------|-----------|
| 1 | Existing task handler tests (extend) | New type validation, backward compat |
| 2 | `brain-mcp-server/src/engine/components/tasks/__tests__/task-results.test.ts` (new) | Result CRUD, type filtering, FK constraints |
| 2 | `brain-mcp-server/src/engine/components/sync/__tests__/auto-push.test.ts` (modify) | SYNC_TABLES count 20->21, task_results entry |
| 3 | Extend existing task tests | Claim success/failure, double-claim prevention |
| 3 | Extend coordination tests | Auto-route with/without matches, disabled mode |
| 4 | `brain-mcp-server/src/engine/components/monitoring/__tests__/monitoring.test.ts` (modify) | Task event logging, listener count assertions |
| 4 | `brain-mcp-server/src/engine/__tests__/event-bus-integrity.test.ts` | Must pass with new listeners (auto-verified) |
| 5 | Manual verification | Handler files exist, contain required tool references |
| 6 | Integration test (manual) | Worker starts, polls, spawns, completes |
| 7 | Integration test (manual) | Config generation, directory creation |

### Regression Safety

All 179 existing tests must continue to pass. Key risk areas:
- Event-bus integrity test: MUST add explicit on/off pairs for new listeners
- SYNC_TABLES length assertion: MUST update from 20 to 21
- Monitoring test: MUST update listener count assertions

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Task type migration breaks existing tasks** | Low | High | Table recreation preserves all data; old types remain valid |
| **Event-bus integrity test fails** | Medium | High | Follow exact pattern: explicit bus.on/bus.off per event (no wildcards) |
| **SYNC_TABLES count test fails** | High | Low | Update assertion in same commit as SYNC_TABLES addition |
| **Worker daemon spawns too many Claude sessions** | Medium | High | `max_concurrent_tasks` config with default 2; queue-based execution |
| **Race condition in task claim** | Low | Medium | SQLite WAL + transaction isolation; claim checks status atomically |
| **Worker daemon fails to communicate with brain** | Medium | Medium | Health check on startup; retry with backoff; graceful degradation |
| **Handler skills become stale** | Low | Low | Skills are markdown -- easy to update; no compilation needed |
| **Auto-route assigns to offline agent** | Medium | Medium | Only consider instances with heartbeat < 30 min; verify before assign |
| **Foreign key violations in task_results** | Low | High | ON DELETE CASCADE on task_id FK; validate task exists before insert |
| **Breaking change to igris_instance_heartbeat** | Low | Medium | New `capabilities` field is optional; existing callers unaffected |

---

## Effort Summary

| Wave | Description | Effort | Dependencies |
|------|-------------|--------|--------------|
| 1 | Task Type System | S (1 day) | None |
| 2 | Task Result Storage | S (1 day) | None (parallel with Wave 1) |
| 3 | Task Claim + Instance Caps + Auto-Route | M (2 days) | Wave 1 |
| 4 | Wire Orphan Events to Monitoring | S (0.5 days) | Wave 3 (for task.claimed) |
| 5 | Task Handler Skills | S (0.5 days) | None (parallel with any wave) |
| 6 | Worker Daemon | L (3 days) | Waves 1-5 |
| 7 | Configuration + Global CLAUDE.md | S (1 day) | Wave 6 |

**Critical Path:** Wave 1 -> Wave 3 -> Wave 4 -> Wave 6 -> Wave 7
**Parallel Track A:** Wave 2 (can start immediately, no deps)
**Parallel Track B:** Wave 5 (can start immediately, no deps)

**Total:** 9 days on critical path, reducible to 7-8 days with parallelism.

---

## Commit Strategy

Each wave produces 1-2 independently committable units:

| Wave | Commits |
|------|---------|
| 1 | `feat(brain): expand task_type system with semantic types (dev, content, research, media-gen, social-media)` |
| 2 | `feat(brain): add task_results table and MCP tools for structured output storage` |
| 3a | `feat(brain): add igris_task_claim tool for atomic task claiming` |
| 3b | `feat(brain): add instance capabilities to heartbeat and auto-route coordination` |
| 4 | `feat(brain): wire task lifecycle events to monitoring component` |
| 5 | `feat(brain): add task handler skills for 6 semantic task types` |
| 6 | `feat(brain): add igris_worker.sh daemon for autonomous task execution` |
| 7 | `feat(brain): add worker configuration and global CLAUDE.md enhancement` |
