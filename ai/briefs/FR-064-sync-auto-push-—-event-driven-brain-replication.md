# FR-064: Sync Auto-Push — Event-Driven Brain Replication

**Type:** FR
**Priority:** P1
**Effort:** TBD
**Status:** Ready
**Created:** 2026-02-25
**Completed:** _TBD_

---

## Problem

Brain data changes require manual `/sync data` to reach the VPS. In a multi-user scenario, this means stale data — brief claims aren't reflected immediately, session presence is invisible, and 19 of 25 tables never sync at all. The sync component has orphan event listeners (TODO) that were designed for this but never wired.

Specific gaps:
1. Only 6 of 25 tables push to VPS (learnings, errors, projects, sessions, brief_status, agent_metrics)
2. `brief_files` and `session_files` content never pushes — other devices can't read full briefs/sessions
3. Tasks, coordination, schedules, instances, agent_events, definition_files all local-only
4. No event-driven push — all sync is manual via `/sync data`
5. Instance heartbeats only fire on `/awaken` and `/rest`, not continuously

---

## Goal

Wire the sync component to listen to engine events and auto-push changes to the remote brain. Use a two-tier strategy:

**Immediate push (contention-sensitive):**
- `brief.synced` — brief status/claim changes must reflect instantly for multi-user coordination
- `session.synced` — shows who's working on what right now
- `instance.heartbeat` — live presence in Crimson Arena, event-driven (not tied to /awaken or /rest)

**Batched push (10s window):**
- `memory.stored` — learnings are append-only, no contention
- `error.stored` — error catalog is informational
- `project.registered` — rare event
- `metrics.recorded` — agent metrics are informational

**Table coverage expansion:**
- Add `brief_files`, `session_files`, `definition_files` to push tables
- Add `tasks`, `task_deps`, `task_assignments`, `agent_capabilities` to push tables
- Add `autonomous_decisions`, `coordination_config` to push tables
- Add `schedules`, `schedule_runs` to push tables
- Add `instances`, `agent_events` to push tables

**Configuration:**
- Opt-in via `config.json` (`"auto_push": true`) — users without VPS are unaffected
- Failures queue to existing sync_queue for retry on next drain
- Batch buffer collects changes for 10s then flushes in one HTTP call

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
