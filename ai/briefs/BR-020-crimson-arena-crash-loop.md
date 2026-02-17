# BR-020: Fix Crimson Arena Crash Loop on Startup

**Type:** Bug Fix
**Priority:** P1-High
**Effort:** S-Small (< 4h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-17

---

## Problem

Crimson Arena dashboard crash-loops on startup with:
```
sqlite3.OperationalError: cannot start a transaction within a transaction
```

At `dashboard/server.py:580`, `insert_event()` calls `BEGIN IMMEDIATE` but aiosqlite already has an implicit transaction from prior inserts in the same function. PM2 shows "online" but the process dies immediately — port 8001 is NOT listening.

**Why does it matter?**
Dashboard is completely unreachable. All monitoring and cost tracking is offline.

---

## Goal

Crimson Arena starts cleanly, port 8001 responds, events sync from events.jsonl.

---

## Context & Inputs

### Related Files
- `dashboard/server.py` — line 580 (BEGIN IMMEDIATE in insert_event)

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-17 17:45 | orchestrator | Investigation | Crash at server.py:580 — nested transaction in aiosqlite |
| 2026-02-17 17:46 | orchestrator | Fix | Removed BEGIN IMMEDIATE/commit/rollback block, let outer commit handle it |
| 2026-02-17 17:46 | orchestrator | Deploy | ab2a02f deployed to VPS, port 8001 responding |

---

## Acceptance Criteria

1. [x] Crimson Arena starts without crash
2. [x] Port 8001 responds
3. [x] events.jsonl syncs on startup

---

**Created:** 2026-02-17
**Brief Owner:** Crimson
