# FR-051: Brain v5.0 — Modular Architecture with Task Management & Scheduling

**Type:** Feature Request
**Priority:** P0-Critical
**Effort:** XL-Extra Large (>1w)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** In Progress
**Created:** 2026-02-17

---

## Feature Description

**What is the proposed feature?**

Complete architectural redesign of the Igris Brain (`~/.igris/`) from a monolithic MCP server into a modular, component-based platform. The brain becomes a pluggable engine where each subsystem (memory, projects, briefs, tasks, scheduling, sessions, sync) is an isolated, replaceable module. Adds a full task management system for non-project work and a scheduling system for automated recurring tasks.

**Why is this valuable?**

The current brain (v4.0) is a 1,671-line monolithic `index.ts` with 40 tools in one switch statement, tightly coupled components, and no task or scheduling capabilities. Project management data (briefs, sessions) still lives in project repos as markdown files, polluting the project's git history with Igris management artifacts. The v5.0 redesign centralizes all management data in the brain, enables autonomous agent operation through scheduling, and ensures any component can be swapped without touching the others.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] Contributors (extending Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved

**Current situation:**
1. Brain MCP server is a monolith — 1,671-line index.ts, 40 tools in one switch, no module boundaries
2. Briefs and session files live in project repos (`ai/briefs/`, `ai/session/`) — polluting project git history with Igris management data
3. No task management — only briefs exist, no lightweight tasks for non-project work
4. No scheduling — no cron jobs, no recurring tasks, no autonomous agent execution
5. Components are tightly coupled — can't swap storage adapter or replace a subsystem
6. No event system — components call each other directly, creating spaghetti dependencies
7. Agent coordination is manual — humans must assign work, no self-assignment

**With this feature:**
1. Brain is a modular platform — 7 domain components, each ~200-300 lines, independently testable
2. All management data centralized in `~/.igris/data/brain.db` — projects stay clean
3. Full task management — briefs (rich), operational tasks (lightweight), personal tasks, all in one system
4. Scheduling system — cron expressions, recurring tasks, smart-sleep daemon
5. Any component swappable via config — storage adapter, task backend, sync strategy
6. Event bus decouples components — `brief.completed` triggers sync, task updates, session logs
7. Agents self-assign work — `igris_task_next` returns the highest-priority available task

---

## Use Cases

### Use Case 1: Autonomous Brief Execution
**Actor:** Scheduler daemon
**Goal:** Execute a brief without human intervention
**Steps:**
1. Scheduler fires at 9am Monday (cron: `0 9 * * 1`)
2. Scheduler calls `igris_task_next` — gets highest-priority ready brief
3. Scheduler invokes Claude Agent SDK with brief context
4. Agent runs full HUNT pipeline (plan → build → test → review → commit)
5. Agent calls `igris_task_complete` — marks done, triggers events
6. Sync component queues result for VPS push

**Expected Outcome:** Brief implemented, committed, and synced without human intervention.

### Use Case 2: Recurring Operational Task
**Actor:** Developer via CLI
**Goal:** Set up a weekly code audit that runs automatically
**Steps:**
1. Developer: `igris_schedule_create("weekly-audit", "0 9 * * 1", { handler: "audit", args: { type: "code_quality" } })`
2. Every Monday 9am, scheduler fires the task
3. Fresh Claude Code session runs `/audit code_quality`
4. Results stored in memory component as learnings
5. Developer reviews results on Crimson Arena dashboard

**Expected Outcome:** Recurring audit runs automatically, results accessible via dashboard.

### Use Case 3: Personal Task Management
**Actor:** Developer
**Goal:** Track non-project tasks alongside project work
**Steps:**
1. Developer: `igris_task_create({ title: "Review that article on LangGraph", scope: "personal", priority: 3 })`
2. Developer: `igris_task_create({ title: "Renew SSL cert", scope: "system", due_at: "2026-03-01", schedule: { cron: "0 9 1 */3 *" } })`
3. Developer: `igris_task_list({ scope: "all" })` — sees briefs, personal tasks, and system tasks in one view
4. Agent: `igris_task_next()` — returns highest priority unblocked task regardless of type

**Expected Outcome:** Unified task view across all task types.

### Use Case 4: Multi-Agent Coordination
**Actor:** Agent Team
**Goal:** Agents assign and coordinate work autonomously
**Steps:**
1. Team lead creates task list from brief decomposition
2. Each agent calls `igris_task_next({ agent: "forger" })` — gets work matching their role
3. Agent completes task, calls `igris_task_complete` with result
4. Event bus fires `task.completed` — unblocks dependent tasks
5. Other agents pick up newly unblocked work automatically

**Expected Outcome:** Agents self-organize around available work without human orchestration.

---

## Technical Approach

### High-Level Design

The brain is restructured into 5 architectural layers:

```
TRANSPORT → API GATEWAY → COMPONENT REGISTRY → DOMAIN COMPONENTS → STORAGE ADAPTERS
```

**Transport Layer:** MCP stdio (local), MCP HTTP/SSE (remote), REST API (dashboard)
**API Gateway:** Tool routing, auth, rate limiting, request logging
**Component Registry:** Loads components from config, resolves dependencies, runs migrations, wires event bus
**Domain Components:** 7 isolated modules (memory, projects, briefs, tasks, scheduler, sessions, sync)
**Storage Adapters:** Pluggable persistence (SQLite default, PostgreSQL future)

### Architecture Diagram

```
~/.igris/
├── config.json              # Component configuration
├── engine/                  # Brain engine source
│   ├── index.ts             # Entry: load config → boot
│   ├── registry.ts          # Component registry + dependency resolver
│   ├── bus.ts               # Event bus (typed events)
│   ├── gateway.ts           # MCP tool router
│   ├── transport/           # Transport layer
│   │   ├── stdio.ts
│   │   ├── http.ts
│   │   └── rest-api.ts
│   ├── storage/             # Storage adapters
│   │   ├── adapter.ts       # Interface definition
│   │   ├── sqlite.ts        # SQLite implementation (default)
│   │   └── postgres.ts      # PostgreSQL (future)
│   └── components/          # Domain components
│       ├── memory/           # learnings, errors, patterns
│       ├── projects/         # project registry
│       ├── briefs/           # rich task documents
│       ├── tasks/            # task management + assignment
│       ├── scheduler/        # cron, recurring, daemon
│       ├── sessions/         # session state, instances, metrics
│       └── sync/             # cross-machine sync
├── data/
│   └── brain.db             # Single SQLite DB (tables owned by components)
├── persona/                 # File-based persona system
├── core/                    # Shared agents/skills/rules (symlinked)
├── cache/                   # Generated markdown from DB
│   └── {project}/
│       ├── briefs/
│       └── session/
└── logs/
```

### Component Contract

Every domain component implements:

```typescript
interface BrainComponent {
  name: string;              // "tasks"
  version: string;           // "1.0.0"
  depends: string[];         // ["projects"]

  schema(): Migration[];     // Tables this component owns
  tools(): ToolDefinition[]; // MCP tools to register (namespaced: igris_{comp}_{op})
  events(): {
    emits: EventDef[];       // Events this component produces
    listens: EventDef[];     // Events this component consumes
  };

  init(ctx: ComponentContext): void;   // Receives: storage, bus, logger, config
  destroy(): void;                     // Cleanup on shutdown
}
```

### Database Schema (Key Tables)

**Tasks component:**
```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  task_type TEXT NOT NULL CHECK (task_type IN ('brief','operational','personal','system')),
  scope TEXT NOT NULL CHECK (scope IN ('project','personal','system')),
  title TEXT NOT NULL,
  description TEXT,
  brief_id TEXT REFERENCES briefs(id),
  schedule_id TEXT REFERENCES schedules(id),
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

**Scheduler component:**
```sql
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  handler TEXT NOT NULL,
  payload TEXT DEFAULT '{}',
  cron_expr TEXT,
  interval_ms INTEGER,
  next_run_at INTEGER NOT NULL,
  last_run_at INTEGER,
  last_status TEXT,
  run_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  timeout_ms INTEGER DEFAULT 300000,
  enabled INTEGER DEFAULT 1,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT REFERENCES schedules(id),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  worker_id TEXT
);
```

**Briefs component (migrated from files):**
```sql
CREATE TABLE briefs (
  id TEXT PRIMARY KEY,
  brief_number TEXT NOT NULL UNIQUE,
  brief_type TEXT NOT NULL,
  project_slug TEXT REFERENCES projects(slug),
  title TEXT NOT NULL,
  problem TEXT,
  goal TEXT,
  constraints TEXT,
  acceptance_criteria TEXT DEFAULT '[]',
  test_plan TEXT,
  effort TEXT,
  content_md TEXT,
  workflow_phase TEXT DEFAULT 'INIT',
  agent_log TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### Event Bus Design

Components communicate via typed events, never direct calls:

| Event | Emitter | Listeners | Purpose |
|-------|---------|-----------|---------|
| `project.registered` | Projects | Memory, Sessions | Initialize project scope |
| `brief.created` | Briefs | Tasks, Sync | Create linked task, queue sync |
| `brief.completed` | Briefs | Tasks, Sync, Sessions, Memory | Update task, sync, log, learn |
| `task.created` | Tasks | Sync | Queue for remote sync |
| `task.assigned` | Tasks | Sessions | Log assignment |
| `task.completed` | Tasks | Scheduler, Sync | Check follow-ups, sync |
| `schedule.fired` | Scheduler | Tasks | Create task instance from template |
| `schedule.completed` | Scheduler | Sync | Log result, sync |
| `session.started` | Sessions | Sync | Sync session state |
| `memory.learned` | Memory | Sync | Queue learning for sync |

### Swappability via Config

```json
{
  "version": "5.0.0",
  "storage": {
    "adapter": "sqlite",
    "path": "~/.igris/data/brain.db"
  },
  "components": {
    "memory":    { "enabled": true },
    "projects":  { "enabled": true },
    "briefs":    { "enabled": true },
    "tasks":     { "enabled": true },
    "scheduler": { "enabled": true, "poll_interval_ms": 10000 },
    "sessions":  { "enabled": true },
    "sync":      { "enabled": true, "remote_url": "http://...:3001", "api_key": "..." }
  },
  "transport": {
    "stdio": true,
    "http": { "enabled": true, "port": 3001 }
  }
}
```

Change `"storage.adapter": "postgres"` → all components use PostgreSQL.
Set `"components.scheduler.enabled": false` → no scheduler, no cron tools.

### Components Affected

- `brain-mcp-server/src/index.ts` — **replaced** by modular engine
- `brain-mcp-server/src/db.ts` — **replaced** by storage adapter layer
- `brain-mcp-server/src/staging.ts` — absorbed into sync component
- `brain-mcp-server/src/tools/*.ts` — refactored into component modules
- `~/.igris/config.json` — extended with component configuration
- `~/.igris/memory/knowledge.db` — migrated to `~/.igris/data/brain.db` with new schema
- All skills that read `ai/briefs/` or `ai/session/` — updated to use MCP tools + cache
- `scripts/igris_install.sh` — stop creating `ai/briefs/`, `ai/session/` per project
- `scripts/igris_brain_init.sh` — updated for v5.0 directory structure

---

## Context & Inputs

### Dependencies
- [x] Existing: `@modelcontextprotocol/sdk` ^1.22.0
- [x] Existing: `better-sqlite3` ^11.0.0
- [ ] New: `@anthropic-ai/claude-agent-sdk` (for scheduler agent invocation)
- [ ] New: `cron-parser` or `cron-schedule` (for cron expression parsing)

### Research Inputs (Completed 2026-02-17)

Extensive research conducted across 4 domains:

**1. Autonomous Agent Orchestration:**
- CrewAI (hierarchical manager assigns tasks), AutoGen (actor model, Magentic-One orchestrator)
- LangGraph (state machine + Send API for scatter-gather), OpenClaw (lane queue, heartbeat daemon, cron)
- Claude Code Agent Teams (shared task list, DAG dependencies, messaging)
- Agency Swarm (directional communication graphs), MetaGPT (SOP assembly line)

**2. Task Management Architectures:**
- Taskwarrior 3.x (moved to SQLite, global DB, project tags)
- Linear (team-scoped IDs, event-driven automation), Plane.so (open source, PostgreSQL)
- Todoist (unified personal+work, natural language scheduling)
- BabyAGI pattern (execute → create new tasks → reprioritize → loop)
- Schema pattern: tasks table + briefs table linked by nullable FK

**3. Scheduling Systems:**
- node-cron (in-process, no persistence), Bree.js (worker threads, no deps)
- BullMQ (Redis-backed, repeatable jobs, production-grade), Agenda.js (MongoDB-backed)
- Temporal.io (durable execution, checkpoint recovery, native schedules)
- SQLite as job queue (BEGIN IMMEDIATE for atomic acquisition, smart-sleep loop)
- OpenClaw pattern: heartbeat (intelligent, every 30m) vs cron (deterministic, isolated sessions)

**4. Claude Code Capabilities (Feb 2026):**
- Agent SDK (`@anthropic-ai/claude-agent-sdk`) — programmatic agent invocation from TypeScript
- Hooks (14 events) — TaskCompleted, TeammateIdle, Stop, SessionStart with compact matcher
- Headless mode (`claude -p`) — JSON output, session resume, allowed tools
- Agent Teams — shared task list with DAG deps, teammate messaging
- Tool Search Tool — 85% context reduction for MCP tool discovery

### Key Architectural Decisions from Research

| Decision | Choice | Reasoning |
|----------|--------|-----------|
| Data model | Unified tasks table + separate briefs table | One system, different depths per task type |
| Scheduling backend | SQLite with smart-sleep loop | No Redis dependency, proven viable, already in ecosystem |
| Agent invocation | Claude Agent SDK (TypeScript) | Library call, not child process; session management built-in |
| Cron parsing | `cron-parser` npm package | Used by BullMQ, battle-tested |
| Component communication | Event bus | Decoupled, replaceable, testable |
| Cache strategy | DB → markdown on demand | Agents read familiar .md format, DB is source of truth |
| Heartbeat vs cron | Both (OpenClaw pattern) | Heartbeat for intelligent proactive checks, cron for deterministic schedules |
| Concurrency model | Serial per project lane (OpenClaw) | Prevents race conditions, parallel only between projects |

### Files to Create (new engine structure)
- `engine/index.ts` — Entry point, config loader, boot sequence
- `engine/registry.ts` — Component registry, dependency resolver
- `engine/bus.ts` — Typed event bus
- `engine/gateway.ts` — MCP tool router (replaces 40-case switch)
- `engine/transport/stdio.ts` — MCP stdio transport
- `engine/transport/http.ts` — MCP HTTP/SSE transport
- `engine/transport/rest-api.ts` — REST API for dashboard
- `engine/storage/adapter.ts` — StorageAdapter interface
- `engine/storage/sqlite.ts` — SQLite implementation
- `engine/components/memory/` — (index, schema, handlers, events)
- `engine/components/projects/` — (index, schema, handlers, events)
- `engine/components/briefs/` — (index, schema, handlers, events)
- `engine/components/tasks/` — (index, schema, handlers, events)
- `engine/components/scheduler/` — (index, schema, handlers, daemon, events)
- `engine/components/sessions/` — (index, schema, handlers, events)
- `engine/components/sync/` — (index, schema, handlers, events)

### Files to Modify
- `brain-mcp-server/package.json` — add new dependencies
- `~/.igris/config.json` — extend for v5.0
- `scripts/igris_brain_init.sh` — v5.0 directory structure
- `scripts/igris_install.sh` — stop creating project-local ai/briefs, ai/session

### Files to Remove (after migration)
- `brain-mcp-server/src/index.ts` — replaced by modular engine
- `brain-mcp-server/src/db.ts` — replaced by storage adapter
- `brain-mcp-server/src/staging.ts` — absorbed into sync component
- `brain-mcp-server/src/tools/*.ts` — refactored into components

---

## Alternatives Considered

### Alternative 1: OpenClaw-Style Full Gateway (Option 2 from research)
**Pros:**
- Proven production architecture (OpenClaw is deployed)
- Lane queue prevents all concurrency bugs
- Multi-channel input (CLI, webhook, chat)

**Cons:**
- XL+ effort — full gateway is a separate product
- Overkill for current scale (1 developer, 3 projects)
- Far from existing brain architecture

**Why not chosen:** Too much complexity for Phase 1. Lane queue concept adopted for future phase.

### Alternative 2: Pure Claude Code Hooks + System Cron (Option 3)
**Pros:**
- Minimal custom code
- Leverages battle-tested system cron
- No daemon to maintain

**Cons:**
- System cron can't dynamically add schedules at runtime (agents can't self-schedule)
- Less control than a custom scheduler
- Tightly coupled to Claude Code's release cycle

**Why not chosen:** Agents need to create their own schedules at runtime. System cron is too rigid.

### Alternative 3: Keep Current Architecture + Add Tables
**Pros:**
- Minimal disruption
- Quick to implement

**Cons:**
- Monolithic index.ts grows further (already 1,671 lines)
- No separation of concerns
- Can't swap components
- Technical debt compounds

**Why not chosen:** The monolith is already at its limit. Adding features without restructuring creates worse tech debt.

---

## Constraints

### Technical Constraints
- Must maintain backward compatibility during migration (v4.0 tools still work)
- Must work offline (no cloud dependency)
- Must work on both macOS (local) and Linux (VPS)
- SQLite remains the default (no Redis/MongoDB required)
- Claude Agent SDK v0.2.x is still evolving — design for interface stability
- Existing skills must continue working during incremental migration

### UX Constraints
- Zero disruption to developer workflow during migration
- `/hunt`, `/scan`, `/awaken`, `/rest` must work identically
- Brief migration from files to DB must be automated (no manual data entry)
- Cache layer must produce identical markdown to what agents currently read

### Out of Scope
- PostgreSQL adapter implementation (interface only in Phase 1)
- Full OpenClaw-style gateway with lane queue (future phase)
- Heartbeat daemon (future phase — requires always-on process)
- Webhook/HTTP trigger endpoints (future phase)
- Multi-user support (single developer for now)
- UI for task management (CLI/MCP only, dashboard in separate brief)

---

## Phased Delivery

This is an XL effort decomposed into 6 phases (Phase 0-5). Each phase is a separate brief with its own HUNT cycle.

### Phase 0: Global Agent/Skill/Rule Installation (M-effort) — FR-058
**Goal:** Move Igris agents, skills, and rules from per-project symlinks to Claude Code's native global directories.
- Symlink `~/.igris/core/{agents,skills,rules}` → `~/.claude/{agents,skills,rules}` (one-time, in brain init)
- Remove all per-project symlink creation from install and migration scripts
- Clean stale project-level symlinks from existing installations
- No dependency on engine work — can be done in parallel with FR-052
- **Success criteria:** Zero per-project symlinks for agents/skills/rules; all projects see definitions via global path

### Phase 1: Engine Foundation (L-effort) — FR-052
**Goal:** Replace monolithic index.ts with modular engine architecture.
- Create engine scaffold: registry, bus, gateway, transport, storage adapter
- Refactor existing 7 tool modules (memory, projects, briefs, sessions, instances, metrics, sync) into component format
- Maintain 100% backward compatibility — same 40 MCP tools, same behavior
- Migrate from `~/.igris/memory/knowledge.db` to `~/.igris/data/brain.db`
- Add config-driven component loading
- **Success criteria:** All existing MCP tools work identically with new architecture

### Phase 2: Task Management System (L-effort) — FR-053
**Goal:** Add full task management with unified data model.
- Create tasks component (tasks table, task_deps, task_assignments)
- Create briefs-v2 component (briefs table with full content, not just metadata)
- Link tasks ↔ briefs via nullable FK
- New MCP tools: igris_task_create, igris_task_assign, igris_task_complete, igris_task_next, igris_task_list, igris_task_block
- Event bus wiring: task events trigger sync, session updates
- **Success criteria:** Can create, assign, complete, and query tasks via MCP tools

### Phase 3: Brief Migration & Cache Layer (M-effort) — FR-054
**Goal:** Migrate project-local briefs to centralized brain DB.
- Automated migration script: scan `ai/briefs/*.md` → insert into briefs table
- Cache generator: render DB briefs → `~/.igris/cache/{project}/briefs/*.md`
- Update all skills (/hunt, /register, /archive, /scan) to use DB + cache
- Update igris_install.sh — stop creating `ai/briefs/` and `ai/session/` per project
- Session file migration: CURRENT_SESSION.md, BLOCKERS.md → DB
- **Success criteria:** Projects have no `ai/briefs/` or `ai/session/` directories; all data in brain DB

### Phase 4: Scheduling System (M-effort) — FR-055
**Goal:** Add cron-based scheduling with smart-sleep daemon.
- Create scheduler component (schedules table, schedule_runs table)
- Implement smart-sleep loop (setTimeout to next due task, not fixed polling)
- New MCP tools: igris_schedule_create, igris_schedule_list, igris_schedule_enable, igris_schedule_disable, igris_schedule_fire_now
- Agent self-registration: agents can call igris_schedule_create to set up their own recurring tasks
- PM2/launchd integration for daemon management
- Claude Agent SDK integration for automated task execution
- **Success criteria:** Cron tasks fire on schedule, agents execute them autonomously

### Phase 5: Autonomous Coordination (M-effort) — FR-056
**Goal:** Enable agents to self-assign and coordinate work without human intervention.
- `igris_task_next` with role-based filtering (agent capabilities)
- Task priority auto-adjustment based on due dates and dependencies
- Self-healing: failed tasks auto-retry with mender agent
- Integration with Claude Code hooks (TaskCompleted validation, TeammateIdle assignment)
- Session-level automation: `/awaken` auto-assigns available work
- **Success criteria:** Agent can execute a full work session (pick task → implement → complete → pick next) without human input

---

## Tasks

### Pending

### In Progress

### Completed
- [x] Task 1: Register Phase 1 brief (FR-052) — Engine Foundation
- [x] Task 2: Register Phase 2 brief (FR-053) — Task Management System
- [x] Task 3: Register Phase 3 brief (FR-054) — Brief Migration & Cache Layer
- [x] Task 4: Register Phase 4 brief (FR-055) — Scheduling System
- [x] Task 5: Register Phase 5 brief (FR-056) — Autonomous Coordination
- [x] Task 6: Register Phase 0 brief (FR-058) — Global Agent/Skill/Rule Installation

---

## Workflow State

**Phase:** INIT
**Active Agent:** none
**Retry Count:** 0

### Current Work
All 5 phase briefs registered (FR-052 through FR-056). Ready to begin Phase 1.

### Next Steps
1. HUNT FR-058 (Global Install) — no dependencies, simplifies install/migration scripts
2. HUNT FR-052 (Engine Foundation) — can run in parallel with FR-058
3. Then FR-053 (Task Management) — depends on FR-052
4. Then FR-054 (Brief Migration) — depends on FR-053, simplified by FR-058
5. FR-055 (Scheduling) — depends on FR-053
6. FR-056 (Autonomous Coordination) — depends on FR-055

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-17 | orchestrator | Research — agent orchestration, task mgmt, scheduling, Claude Code | COMPLETE |
| 2026-02-17 | orchestrator | Architecture design — modular brain with 7 components | COMPLETE |
| 2026-02-17 | orchestrator | Brief registration | SUCCESS |

### Blockers
None

### Key Design Decisions (Captured During Planning)

**Session Definition (2026-02-17):**
- A session = one Claude Code conversation, from `/awaken` to `/clear` or `/rest`
- Sessions are **short-lived** (one conversation). Tasks are **long-lived** (span many sessions).
- `/awaken` creates a new session row in DB. `/clear` or `/rest` closes it with summary + end time.
- Sessions have a **many-to-many** relationship with tasks via `session_tasks` junction table
- A session can have multiple active tasks (briefs, personal tasks, cron jobs all at once)
- A task can span multiple sessions (started in session A, finished in session B)
- `session_tasks` tracks: status (active/completed/paused/deferred), started_in_session, completed_in_session
- `/awaken` shows ALL active tasks in the session, not just one brief
- `/rest` records which tasks were active vs completed vs deferred
- Session summary is generated from `session_tasks` completion data
- `context_instructions` tells the NEXT session what to do (context recovery across `/clear`)
- The old "Active Brief: FR-050" single-value model is replaced by a task set per session

**Session State Architecture (2026-02-17):**
- CURRENT_SESSION.md becomes a **generated cache file** at `~/.igris/cache/{project}/session/CURRENT_SESSION.md`
- DB `sessions` table is the source of truth — stores structured state (mode, brief, phase) + free-form `context_instructions` column for "Next Session Instructions"
- Cache file is regenerated by `/rest` (on save) and `/awaken` (on resume)
- `SessionStart` hook with `compact` matcher reads cache file for context recovery after compaction
- BLOCKERS.md → `sessions.blockers` column in DB
- DECISIONS.md → `memory` component (category='decision')
- LEARNINGS.md → `memory` component (category='pattern')
- Only CURRENT_SESSION.md survives as a cache file because it serves the unique role of LLM context recovery
- Project-local `ai/session/` directory is eliminated entirely

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] Brain engine is modular — 7 domain components, each independently testable
2. [ ] Component contract enforced — every component implements BrainComponent interface
3. [ ] Storage adapter is pluggable — config change swaps SQLite for PostgreSQL
4. [ ] Event bus decouples all components — no direct cross-component table access
5. [ ] Task management works — create, assign, complete, query tasks via MCP tools
6. [ ] Brief system migrated — all briefs in DB, markdown cache generated on demand
7. [ ] Scheduling works — cron expressions fire tasks on schedule
8. [ ] Agents self-assign — `igris_task_next` returns available work
9. [ ] Existing tools backward compatible — all 40 v4.0 MCP tools still function
10. [ ] Project repos clean — no `ai/briefs/` or `ai/session/` directories
11. [ ] VPS sync works — all components sync to remote brain
12. [ ] All 5 phases delivered with their own HUNT cycles

---

## Test Plan

### Functional Tests

**Test Case 1: Component Isolation**
**Steps:**
1. Disable tasks component in config
2. Start brain engine
3. Call memory, projects, sessions tools
4. Verify no task-related tools registered
5. Re-enable tasks, restart, verify tools appear

**Expected Result:** Components load/unload independently
**Status:** [ ] Pass / [ ] Fail

**Test Case 2: Task Lifecycle**
**Steps:**
1. Create a task via igris_task_create
2. Assign via igris_task_assign
3. Complete via igris_task_complete
4. Verify task.created, task.assigned, task.completed events fired
5. Verify sync component queued the changes

**Expected Result:** Full task lifecycle with event propagation
**Status:** [ ] Pass / [ ] Fail

**Test Case 3: Scheduler Execution**
**Steps:**
1. Create schedule: `igris_schedule_create("test", "* * * * *", { handler: "echo" })`
2. Wait 60 seconds
3. Check schedule_runs table
4. Verify task was created and executed

**Expected Result:** Cron fires on schedule, creates and executes task
**Status:** [ ] Pass / [ ] Fail

**Test Case 4: Brief Migration**
**Steps:**
1. Run migration script on project with 44 active briefs
2. Verify all 44 briefs in DB with full content
3. Generate cache, verify markdown matches original files
4. Run `/scan` — verify brief counts match

**Expected Result:** Zero data loss during migration
**Status:** [ ] Pass / [ ] Fail

**Test Case 5: Backward Compatibility**
**Steps:**
1. Start v5.0 brain engine
2. Call every existing v4.0 MCP tool (all 40)
3. Verify identical behavior and response format
4. Run `/awaken`, `/hunt`, `/rest`, `/sync` — verify all work

**Expected Result:** 100% backward compatibility
**Status:** [ ] Pass / [ ] Fail

### Regression Tests
- [ ] All 40 existing MCP tools return identical results
- [ ] VPS sync push/pull works with new schema
- [ ] Crimson Arena dashboard reads new DB structure
- [ ] Skills (/hunt, /scan, /register, /archive) work unchanged
- [ ] Performance: tool response time within 2x of v4.0

---

## Delivery

### Documentation
- [ ] Architecture doc: `docs/BRAIN_ARCHITECTURE.md`
- [ ] Component development guide: how to create new components
- [ ] Migration guide: v4.0 → v5.0
- [ ] README update: reflect new brain capabilities

### Announcement
- [ ] Changelog entry: "Brain v5.0: Modular architecture with task management and scheduling"

---

## Success Metrics

**How will we know this feature is valuable?**

- Agent can execute 3+ briefs in a session without human task assignment
- Cron jobs run reliably for 7+ consecutive days
- Zero data loss during brief migration from files to DB
- New component can be added in <1 hour (following contract)
- All existing workflows work identically after migration

---

## Notes

### Research Sources (2026-02-17)
- OpenClaw: Lane queue, heartbeat daemon, cron system — closest reference architecture
- Claude Agent SDK: Programmatic agent invocation from TypeScript
- Taskwarrior 3.x: Moved from files to SQLite — validates DB-first approach
- BabyAGI: Task self-generation loop (execute → create → reprioritize → repeat)
- Temporal.io: Durable execution with checkpoints — aspirational for Phase 5+

### Key Design Insight
"The hardest part of autonomous agents is not the AI — it is the runtime: queuing, channel normalization, memory, scheduling, and concurrency safety." — OpenClaw architecture lessons

### Future Enhancements (Beyond Phase 5)
- Lane queue for per-project concurrency isolation (OpenClaw pattern)
- Heartbeat daemon — agent wakes every 30m, checks HEARTBEAT.md, decides what to do
- Webhook/HTTP triggers for event-driven automation
- PostgreSQL adapter for VPS (scale beyond SQLite)
- Multi-user support with role-based access
- Crimson Arena integration — manage tasks from dashboard UI
- A2A protocol support (Google's Agent-to-Agent standard)

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Crimson (Igris AI)
