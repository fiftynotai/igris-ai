# FR-067: Live Event Monitoring — Event Log, WebSocket Stream & Audit Trail

**Type:** FR
**Priority:** P1
**Effort:** TBD
**Status:** Ready
**Created:** 2026-02-25
**Completed:** _TBD_

---

## Problem

9 orphan monitoring events (schedules, cache, coordination) fire into the void with no storage, no streaming, and no audit trail. The engine does work but nobody can observe it in real-time. There's no event history for debugging or auditing. When FR-065 (task orchestration) lands, task lifecycle events will also need the same observability layer.

Specific gaps:
1. No event storage — events fire and disappear, no historical record
2. No real-time streaming — no WebSocket support on brain server, no way for dashboards or agents to subscribe to live events
3. No event query API — no MCP tool to search/filter event history
4. 9 monitoring events completely unlistened: schedule.created/enabled/disabled/deleted/fire_now/run_start/run_complete, cache.rebuilt/cleaned, coordination.self_heal
5. No retention policy — no mechanism to age out old events
6. When FR-065 lands, task lifecycle events (created/assigned/completed/blocked/unblocked) and instance.heartbeat will also need this layer

---

## Goal

Build the event logging, storage, and real-time streaming infrastructure in the brain engine.

**Event Log Table:**
- New `event_log` table in brain: id, event_name, component, payload (JSON), machine_hostname, project_slug, instance_id, created_at
- Indexed on event_name, component, created_at for fast queries
- All 9 monitoring events stored automatically via sync component listener
- Extensible — FR-065 task events and any future events plug into the same table

**Sync Component Event Listeners:**
- Wire bus.on() in sync component init() for all 9 monitoring events
- Each listener writes to event_log table (local brain DB)
- AND pushes to remote brain via WebSocket if connected (see below)
- Matching bus.off() in destroy() for clean shutdown

**WebSocket Support on Brain REST Server:**
- Add WebSocket endpoint to the brain HTTP server (already exists for REST API in sync component HTTP mode)
- Clients connect and subscribe to event streams with optional filters (by event_name, component, project)
- Server broadcasts events to all connected subscribers in real-time
- Authentication via same API key used for REST
- Graceful handling: if no WebSocket clients connected, events still stored in DB (no wasted resources)

**Event Query MCP Tool:**
- `igris_event_log` tool: query event history with filters (event_name, component, project, date range, limit)
- `igris_event_stream_subscribe` tool: subscribe current session to live events (for agents that want real-time awareness)
- Returns structured JSON for dashboard consumption

**Retention Policy:**
- Configurable in config.json: `event_log.retention_days` (default: 30)
- Cleanup runs on engine init and periodically (e.g., daily via schedules daemon)
- Option to set per-event-type retention (e.g., coordination.self_heal kept 90 days for audit, cache.cleaned kept 7 days)

**Events Captured (Phase 1 — monitoring orphans):**
- schedule.created, schedule.enabled, schedule.disabled, schedule.deleted
- schedule.fire_now, schedule.run_start, schedule.run_complete
- cache.rebuilt, cache.cleaned
- coordination.self_heal

**Events Captured (Phase 2 — after FR-065 lands):**
- task.created, task.assigned, task.completed, task.blocked, task.unblocked
- instance.heartbeat
- brief.synced, session.synced (contention events from FR-064)

**Hybrid Storage + Streaming:**
- Every event: stored in local event_log table (history/audit)
- Every event: pushed to remote brain via WebSocket (real-time)
- Dashboard connects via WebSocket for live feed, queries REST for historical
- If WebSocket unavailable, events still stored locally and pushed on next sync

---

## Tasks

### Pending
- [ ] TBD

### In Progress
_(None yet)_

### Completed
_(None yet)_

---

## Session State

**Current State:** Brief created
**Next Steps When Resuming:** Define tasks and acceptance criteria
**Last Updated:** 2026-02-25
**Blockers:** None

---

## Acceptance Criteria

1. [ ] TBD

---

**Created:** 2026-02-25
**Last Updated:** 2026-02-25
