# FR-055: Brain v5.0 Phase 4 — Scheduling System

**Type:** Feature Request
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Ready
**Created:** 2026-02-17
**Parent Brief:** FR-051
**Blocked By:** FR-053

---

## Feature Description

**What is the proposed feature?**

Add a cron-based scheduling system to the brain engine. Introduces a `schedules` table with cron expressions, a smart-sleep daemon that calculates the next due task and sleeps until then (no fixed polling), schedule run tracking, and Claude Agent SDK integration for automated task execution. Agents can self-register recurring tasks at runtime.

**Why is this valuable?**

Currently all work requires human initiation. There is no way to run recurring audits, automated syncs, or scheduled maintenance without a human typing a command. The scheduling system enables autonomous agent operation — cron fires, agent executes, results stored.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved

**Current situation:**
- All work requires human initiation (type a command)
- No recurring tasks (must manually run `/audit` every week)
- No automated syncs (must manually run `/sync data`)
- System cron is too rigid — agents can't create schedules at runtime

**With this feature:**
- Cron-based scheduling with persistent storage
- Smart-sleep daemon (efficient, not polling)
- Agents can self-register recurring tasks
- Claude Agent SDK executes tasks in isolated sessions
- Schedule run history tracked for debugging

---

## Technical Approach

### High-Level Design

New `scheduler` component implements BrainComponent interface. Uses SQLite as the job queue with a smart-sleep loop (calculate next due → setTimeout → execute → repeat). Claude Agent SDK invokes agents in isolated sessions for each scheduled task.

### Database Schema

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

### New MCP Tools
- `igris_schedule_create` — Create schedule (cron or interval)
- `igris_schedule_list` — List all schedules with status
- `igris_schedule_get` — Get schedule details + recent runs
- `igris_schedule_enable` — Enable a schedule
- `igris_schedule_disable` — Disable a schedule
- `igris_schedule_fire_now` — Manually trigger a schedule immediately
- `igris_schedule_delete` — Remove a schedule

### Smart-Sleep Loop

```typescript
async function schedulerLoop() {
  while (running) {
    const next = db.prepare('SELECT * FROM schedules WHERE enabled=1 ORDER BY next_run_at LIMIT 1').get();
    if (!next) { await sleep(60000); continue; }

    const delay = Math.max(0, next.next_run_at - Date.now());
    if (delay > 0) { await sleep(delay); continue; }

    // Execute
    await executeSchedule(next);

    // Calculate next run
    const nextRun = cronParser.parseExpression(next.cron_expr).next().getTime();
    db.prepare('UPDATE schedules SET next_run_at=?, last_run_at=?, run_count=run_count+1 WHERE id=?')
      .run(nextRun, Date.now(), next.id);
  }
}
```

### Event Bus Integration
- Emits: `schedule.fired`, `schedule.completed`, `schedule.failed`
- Listens: `task.completed` (update schedule status if task was scheduled)

### Claude Agent SDK Integration
- Each scheduled task spawns an isolated Claude Code session via Agent SDK
- Session receives task context, executes handler, returns result
- PM2 or launchd manages the scheduler daemon process

---

## Context & Inputs

### Dependencies
- [x] FR-052 (Engine Foundation) — engine architecture
- [x] FR-053 (Task Management) — task creation from schedules
- [ ] New: `cron-parser` npm package (cron expression parsing)
- [ ] New: `@anthropic-ai/claude-agent-sdk` (agent invocation)

### Files to Create
- `brain-mcp-server/src/engine/components/scheduler/index.ts`
- `brain-mcp-server/src/engine/components/scheduler/schema.ts`
- `brain-mcp-server/src/engine/components/scheduler/handlers.ts`
- `brain-mcp-server/src/engine/components/scheduler/daemon.ts` — Smart-sleep loop

### Files to Modify
- `brain-mcp-server/package.json` — add cron-parser, agent SDK
- Engine config — add scheduler options (poll_interval, enabled)

---

## Constraints

### Technical Constraints
- Smart-sleep loop must be efficient (no fixed-interval polling)
- Schedule execution must be atomic (BEGIN IMMEDIATE for job acquisition)
- Must handle daemon restart gracefully (recalculate missed runs)
- Agent SDK version may be pre-1.0 — design for interface stability

### UX Constraints
- `igris_schedule_create` must accept human-readable cron expressions
- Schedule listing must show next run time in human-readable format
- `fire_now` must provide immediate feedback

### Out of Scope
- Heartbeat daemon (future, beyond v5.0 phases)
- Webhook/HTTP triggers (future)
- Multi-worker distribution (single daemon for now)
- UI for schedule management (dashboard in separate brief)

---

## Tasks

### Pending
- [ ] Task 1: Design scheduler component schema and migrations
- [ ] Task 2: Implement schedule CRUD handlers
- [ ] Task 3: Implement smart-sleep daemon loop
- [ ] Task 4: Implement cron expression parsing and next-run calculation
- [ ] Task 5: Implement schedule run tracking and history
- [ ] Task 6: Integrate Claude Agent SDK for task execution
- [ ] Task 7: Wire event bus (schedule events, task linkage)
- [ ] Task 8: Add PM2/launchd configuration for daemon
- [ ] Task 9: Test schedule lifecycle (create → fire → track → repeat)

### In Progress

### Completed

---

## Workflow State

**Phase:** INIT
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered. Blocked on FR-053 (Task Management).

### Next Steps
Complete FR-052 and FR-053 first, then HUNT FR-055.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-17 | orchestrator | Brief registration from FR-051 Phase 4 | SUCCESS |

### Blockers
- FR-053 must complete first (schedules create tasks)

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] Scheduler component loads via engine registry
2. [ ] Can create schedules with cron expressions
3. [ ] Smart-sleep daemon fires tasks on schedule
4. [ ] Schedule runs tracked with status, result, timing
5. [ ] `fire_now` triggers immediate execution
6. [ ] Claude Agent SDK executes tasks in isolated sessions
7. [ ] Daemon survives restart (recalculates next runs)
8. [ ] PM2 configuration for daemon management
9. [ ] All existing MCP tools unchanged

---

## Test Plan

### Functional Tests

**Test Case 1: Schedule Lifecycle**
**Steps:**
1. Create schedule: `igris_schedule_create("test", "*/1 * * * *", { handler: "echo" })`
2. Wait 60 seconds
3. Check schedule_runs table
4. Verify run completed with result

**Expected Result:** Cron fires on time, run recorded
**Status:** [ ] Pass / [ ] Fail

**Test Case 2: Fire Now**
**Steps:**
1. Create schedule with future cron (next year)
2. Call `igris_schedule_fire_now`
3. Verify immediate execution
4. Verify run tracked in schedule_runs

**Expected Result:** Immediate execution regardless of cron
**Status:** [ ] Pass / [ ] Fail

### Regression Tests
- [ ] All existing MCP tools unchanged
- [ ] Engine boot with scheduler enabled/disabled
- [ ] VPS sync includes schedule data

---

## Notes

**Parent brief:** FR-051 (Brain v5.0 Modular Architecture)
**Phase:** 4 of 5
**Depends on:** FR-052, FR-053

**Key design decisions from FR-051:**
- SQLite as job queue (BEGIN IMMEDIATE for atomic acquisition)
- Smart-sleep loop (not fixed polling) — efficient, event-driven
- OpenClaw pattern: heartbeat (intelligent, proactive) vs cron (deterministic, scheduled)
- Claude Agent SDK for programmatic agent invocation

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Crimson (Igris AI)
