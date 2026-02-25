# FR-068: Crimson Arena — Live Activity Feed & Event Dashboard

**Type:** FR
**Priority:** P2
**Effort:** TBD
**Status:** Ready
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
