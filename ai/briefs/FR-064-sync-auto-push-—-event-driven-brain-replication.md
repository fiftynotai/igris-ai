# FR-064: Sync Auto-Push — Event-Driven Brain Replication

**Type:** FR
**Priority:** P1
**Effort:** M-Medium
**Status:** In Progress
**Created:** 2026-02-25
**Completed:** _TBD_

---

## Problem

Brain data changes require manual `/sync data` to reach the VPS. The sync component has a TODO stub in `init()` designed for event-driven auto-push but never wired. Without this, brief claims aren't reflected immediately, session presence is invisible, and changes only sync on manual `/sync data`.

**Current state (after BR-034 audit):**
- SYNC_TABLES already covers 14 of ~19 syncable tables
- 5 remaining syncable tables: `agent_capabilities`, `autonomous_decisions`, `coordination_config`, `schedules`, `schedule_runs`
- 10 domain events emitted but no listeners in sync component
- `sync/index.ts` init() has a TODO stub, events() declares empty listens/emits
- Remote brain URL/API key always passed as tool args — MCP server doesn't read config.json

---

## Goal

Wire the sync component to listen to engine events and auto-push changes to the remote brain. Two-tier strategy:

**Immediate push (contention-sensitive):**
- `brief.synced` — brief status changes must reflect instantly
- `brief.created` — new briefs visible across devices
- `brief.completed` — completion status propagates
- `session.synced` — shows who's working on what
- `session.file.updated` — session file content propagates
- `instance.heartbeat` — live presence in Crimson Arena

**Batched push (10s window):**
- `memory.stored` — append-only, no contention
- `error.stored` — informational
- `project.registered` — rare event
- `metrics.recorded` — informational

**Table coverage:** Add 5 missing tables to SYNC_TABLES.

**Config:** Opt-in via `config.json` (`"auto_push": true`). Read config inside MCP server init(). Failures queue to existing sync_queue.

---

## Key Files

- `brain-mcp-server/src/engine/components/sync/index.ts` — Component with TODO stub (line 299)
- `brain-mcp-server/src/tools/sync.ts` — Push/pull handlers, SYNC_TABLES (line 77), fetchWithRetry
- `brain-mcp-server/src/db.ts` — BRAIN_DIR, schema definitions
- `brain-mcp-server/src/index.ts` — Remote API endpoints, cleanup interval pattern
- `brain-mcp-server/src/engine/__tests__/event-bus-integrity.test.ts` — Must pass after changes

---

## Tasks

### Pending
- [ ] T1: Add `auto_push` config flag to config.json and read it in sync component init()
- [ ] T2: Add 5 missing tables to SYNC_TABLES (agent_capabilities, autonomous_decisions, coordination_config, schedules, schedule_runs)
- [ ] T3: Implement immediate push handler — listen to 6 events, push affected table rows on each event
- [ ] T4: Implement batched push handler — 10s buffer for 4 events, flush in single HTTP call
- [ ] T5: Update sync component events() to declare all listened events
- [ ] T6: Add listener cleanup to destroy()
- [ ] T7: Update event-bus-integrity tests for new sync listeners
- [ ] T8: Add unit tests for auto-push logic (immediate + batched)

### In Progress
_(None yet)_

### Completed
_(None yet)_

---

## Session State

**Current State:** In Progress
**Phase:** PLANNING
**Active Agent:** architect
**Next Steps:** Architect creates implementation plan
**Last Updated:** 2026-02-25
**Blockers:** None

---

## Acceptance Criteria

1. [ ] `auto_push: true` in config.json enables event-driven sync; `false` or absent disables it
2. [ ] Brief status changes (`brief.synced`, `brief.created`, `brief.completed`) push to VPS within 1s
3. [ ] Session changes (`session.synced`, `session.file.updated`) push to VPS within 1s
4. [ ] Instance heartbeats push to VPS within 1s
5. [ ] Memory, error, project, metrics events batch and push within 10s window
6. [ ] All 19 syncable tables are in SYNC_TABLES
7. [ ] Failed pushes queue to sync_queue with existing retry mechanism
8. [ ] Event-bus-integrity tests pass (no orphan listeners, all declared)
9. [ ] Sync component destroy() cleans up all listeners and timers
10. [ ] Auto-push is silent when remote brain is not configured

---

## Agent Log

_(Agents will be logged here during implementation)_

---

**Created:** 2026-02-25
**Last Updated:** 2026-02-25
