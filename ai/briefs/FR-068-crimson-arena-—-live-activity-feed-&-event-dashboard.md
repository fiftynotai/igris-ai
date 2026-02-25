# FR-068: Crimson Arena — Live Activity Feed & Event Dashboard

**Type:** FR
**Priority:** P2
**Effort:** L-Large
**Status:** In Progress
**Created:** 2026-02-25
**Completed:** _TBD_

---

## Problem

Crimson Arena currently shows static snapshots of brain data — briefs, sessions, instances, metrics. After FR-067 (live event monitoring) adds the event_log table and WebSocket streaming to the brain, Crimson Arena has no UI to consume it. The dashboard needs a real-time activity feed showing engine events as they happen across all machines and agents.

Dependencies:
- FR-067 must land first (event_log table + WebSocket endpoint)
- FR-065 (task orchestration) adds task lifecycle events to the stream
- FR-064 (sync auto-push) adds contention events to the stream

---

## Goal

Add a Live Activity panel to Crimson Arena that connects to the brain WebSocket and displays real-time engine events.

**Live Activity Feed:**
- WebSocket connection to brain server event stream
- Real-time event cards: timestamp, event name, component, machine, payload summary
- Color-coded by component (schedules=blue, cache=green, coordination=orange, tasks=purple)
- Auto-scroll with pause-on-hover
- Filterable by: component, event type, machine, project

**Event History View:**
- Query brain REST API for historical events (from event_log table)
- Date range picker, pagination
- Search/filter by event name, component, payload content
- Export to CSV/JSON for audit purposes

**Dashboard Enhancements:**
- Instance cards show live heartbeat pulse (green=active, yellow=idle, red=stale)
- Task board view (if FR-065 landed): kanban-style task tracking across agents
- Agent workload visualization: which agent is handling what right now

**Connection Status:**
- WebSocket connection indicator (connected/reconnecting/disconnected)
- Auto-reconnect with exponential backoff
- Fallback to polling if WebSocket unavailable

---

## Tasks

### Wave 1: Brain REST Endpoints (igris-ai)
- [ ] Add `GET /api/events` — query event_log with filters (event_name, component, project, since, until, limit, offset)
- [ ] Add `GET /api/events/stream` — SSE endpoint streaming real-time engine events via EventBus wildcard
- [ ] Add `GET /api/tasks` — list tasks with filters (status, type, project, assignee, scope, limit, offset)
- [ ] Verify existing tests pass (vitest + bats)

### Wave 2-5: Crimson Arena Dashboard (crimson-arena repo, separate hunt)
- [ ] Wave 2: FastAPI proxy endpoints + SSE bridge + WS broadcast
- [ ] Wave 3: Flutter data layer (models, API service, WS service, routing)
- [ ] Wave 4: Events page UI (live feed + history table + filters + export)
- [ ] Wave 5: Tasks page (kanban board) + instance heartbeat pulse

### In Progress
- Wave 1: Brain REST Endpoints

### Completed
_(None yet)_

---

## Session State

**Current State:** BUILDING (Wave 1)
**Next Steps When Resuming:** Implement 3 REST endpoints in brain-mcp-server/src/index.ts
**Last Updated:** 2026-02-26
**Blockers:** None

---

## Acceptance Criteria

### Wave 1 (Brain REST Endpoints)
1. [ ] `GET /api/events` returns paginated event_log entries with filter support
2. [ ] `GET /api/events/stream` emits SSE events in real-time from EventBus
3. [ ] `GET /api/tasks` returns paginated tasks with filter support and status summary
4. [ ] All 3 endpoints require Bearer token auth (existing middleware)
5. [ ] Existing vitest suite passes (180 tests)
6. [ ] Existing bats suite passes (32 tests)

### Wave 2-5 (Crimson Arena — separate hunt)
7. [ ] EVENTS page shows live feed with color-coded event cards
8. [ ] EVENTS page shows historical events with filters, pagination, export
9. [ ] TASKS page shows kanban board with status columns
10. [ ] Instance cards show heartbeat pulse (green/yellow/red)

---

**Created:** 2026-02-25
**Last Updated:** 2026-02-25
