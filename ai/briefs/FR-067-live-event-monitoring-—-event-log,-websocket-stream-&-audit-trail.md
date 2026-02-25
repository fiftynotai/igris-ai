# FR-067: Live Event Monitoring — Event Log, WebSocket Stream & Audit Trail

**Type:** FR
**Priority:** P1
**Effort:** M-Medium
**Status:** In Progress
**Created:** 2026-02-25
**Completed:** _TBD_

---

## Problem

9 orphan monitoring events fire into the void with no storage and no audit trail. The engine does work but nobody can observe it. There's no event history for debugging or auditing.

**Orphan events (confirmed — zero listeners):**
- `schedule.created`, `schedule.enabled`, `schedule.disabled`, `schedule.deleted`
- `schedule.fire_now`, `schedule.run_start`, `schedule.run_complete`
- `cache.rebuilt`, `cache.cleaned`
- `coordination.self_heal`

---

## Goal

Build a new **monitoring** engine component (13th component) that:

1. **Creates `event_log` table** — stores all engine events with structured metadata
2. **Wires listeners for all 9 orphan events** — stores each event in event_log automatically
3. **Provides `igris_event_log` MCP tool** — query event history with filters (name, component, project, date range)
4. **Provides `igris_event_log_cleanup` MCP tool** — purge old events by retention policy
5. **Runs retention cleanup on init** — purge events older than configured retention_days

**Deferred to FR-068:** WebSocket streaming, live subscriptions, dashboard endpoints. The event_log table is the foundation they'll build on.

---

## Key Files

- `brain-mcp-server/src/engine/components/monitoring/index.ts` — NEW component (13th)
- `brain-mcp-server/src/engine/components/monitoring/schema.ts` — NEW event_log migration
- `brain-mcp-server/src/engine/components/monitoring/handlers.ts` — NEW tool handlers
- `brain-mcp-server/src/engine/index.ts` — Register monitoring component in factory array
- `brain-mcp-server/src/index.ts` — Enable monitoring in config
- `brain-mcp-server/src/engine/__tests__/event-bus-integrity.test.ts` — Must pass after changes

### Event Payloads (from seeker research)

| Event | Payload | Source |
|-------|---------|--------|
| `schedule.created` | `{ schedule_id, name, cron_expr }` | schedules/index.ts:131 |
| `schedule.enabled` | `{ schedule_id }` | schedules/index.ts:215 |
| `schedule.disabled` | `{ schedule_id }` | schedules/index.ts:243 |
| `schedule.deleted` | `{ schedule_id, name }` | schedules/index.ts:293 |
| `schedule.fire_now` | `{ schedule_id, run_id }` | schedules/handlers.ts:419 |
| `schedule.run_start` | `{ schedule_id, run_id }` | schedules/daemon.ts:92 |
| `schedule.run_complete` | `{ schedule_id, run_id, status }` | schedules/daemon.ts:127, handlers.ts:451 |
| `cache.rebuilt` | `{ project, scope }` | cache/index.ts:108 |
| `cache.cleaned` | `{ project }` | cache/index.ts:136 |
| `coordination.self_heal` | `{ taskId, reason, retryCount }` | coordination/index.ts:171 |

---

## Tasks

### Pending
- [ ] T1: Create monitoring component scaffold (index.ts, schema.ts, handlers.ts)
- [ ] T2: Create event_log table schema with indexes
- [ ] T3: Wire 9 orphan event listeners in init() with bus.off() in destroy()
- [ ] T4: Implement igris_event_log query tool (filters: event_name, component, project, since, until, limit)
- [ ] T5: Implement igris_event_log_cleanup tool (retention_days param)
- [ ] T6: Run retention cleanup on component init (default 30 days)
- [ ] T7: Register component in engine/index.ts and enable in src/index.ts config
- [ ] T8: Add event_log to SYNC_TABLES in tools/sync.ts
- [ ] T9: Add unit tests for monitoring component
- [ ] T10: Verify event-bus-integrity tests pass

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

1. [ ] New `monitoring` component loads as 13th engine component
2. [ ] `event_log` table created with indexes on event_name, component, created_at
3. [ ] All 9 orphan events stored in event_log with correct metadata
4. [ ] `igris_event_log` MCP tool returns filtered event history
5. [ ] `igris_event_log_cleanup` MCP tool purges events older than retention_days
6. [ ] Retention cleanup runs on component init (default 30 days)
7. [ ] `event_log` table added to SYNC_TABLES for remote brain replication
8. [ ] Event-bus-integrity tests pass (9 new listeners declared and wired)
9. [ ] All listeners cleaned up in destroy()
10. [ ] Component is opt-in via engine config (enabled: true)

---

## Agent Log

_(Agents will be logged here during implementation)_

---

**Created:** 2026-02-25
**Last Updated:** 2026-02-25
