# FR-036: Offline Sync Queue & Retry Mechanism

**Type:** Feature Request
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Ready
**Created:** 2026-02-17

---

## Feature Description

**What is the proposed feature?**

Implement a sync queue that captures failed push operations and retries them when connectivity returns. Currently, if `igris_brain_push` fails (VPS unreachable, timeout, network error), the data is silently lost. This feature ensures offline-first reliability: work locally, queue changes, sync when connected.

**Why is this valuable?**

For a truly distributed agent, network reliability cannot be assumed. Developers may work offline (airplane, coffee shop, VPN issues), or the VPS may have downtime. Without a queue, every failed push means lost data — learnings, sessions, metrics, brief updates never reach the centralized brain. A queue guarantees eventual consistency.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
- `igris_brain_push` fails silently on network errors
- No retry mechanism — data lost permanently
- No indication to user that sync failed
- `~/.igris/staging/` exists but only used for learning extraction, not sync queuing

**With this feature:**
- Failed pushes queued in `sync_queue` table with retry metadata
- Automatic retry on next `/awaken` or `/rest` (or periodic timer)
- User notified: "3 sync operations queued, will retry on next session"
- Guaranteed eventual consistency between local and VPS brain

---

## Technical Approach

### High-Level Design

1. **`sync_queue` table** in knowledge.db — tracks pending sync operations
2. **On push failure** — insert failed rows into sync_queue instead of discarding
3. **On /awaken** — process sync_queue before pulling (push stale data first)
4. **On /rest** — process sync_queue as part of final push
5. **Retry logic** — exponential backoff, max 5 retries, then mark as failed

### Schema
```sql
CREATE TABLE sync_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_data TEXT NOT NULL,  -- JSON of the row to sync
  operation TEXT DEFAULT 'push' CHECK (operation IN ('push', 'pull')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'retrying', 'sent', 'failed')),
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 5,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_retry_at TEXT,
  sent_at TEXT
);
```

### Components Affected
- `brain-mcp-server/src/tools/sync.ts` — Add queue-on-failure to push logic
- `brain-mcp-server/src/index.ts` — Add `igris_sync_queue_status` tool
- `.claude/skills/awaken/SKILL.md` — Add queue drain step
- `.claude/skills/rest/SKILL.md` — Add queue drain step
- Schema migration — Add sync_queue table

---

## Context & Inputs

### Dependencies
- [x] FR-033: Brain MCP HTTP transport fix
- [x] FR-034: Activate sync pipeline
- [x] `~/.igris/staging/` directory exists (repurpose for file-based queue backup)

### Files to Modify
- `brain-mcp-server/src/tools/sync.ts` — Queue on failure
- `brain-mcp-server/src/index.ts` — New MCP tool + schema migration
- `.claude/skills/awaken/SKILL.md` — Queue drain step
- `.claude/skills/rest/SKILL.md` — Queue drain step

---

## Constraints

### Technical Constraints
- Queue must be local (SQLite) — works offline by definition
- Retry must not block session start/end
- Queue processing must be idempotent (safe to retry same row)
- Must handle VPS schema changes between queue and retry (version check)
- Max queue size: 10,000 rows (prevent unbounded growth)

### Out of Scope
- Real-time WebSocket sync (future)
- Pull queue (only push queue for now)
- Conflict resolution beyond LWW (existing merge strategy sufficient)

---

## Tasks

### Pending
- [ ] Add `sync_queue` table to schema (migration v5)
- [ ] Modify `igris_brain_push` to queue on failure instead of silent discard
- [ ] Add `igris_sync_queue_status` MCP tool (show queue depth/status)
- [ ] Add `igris_sync_queue_drain` MCP tool (process pending queue)
- [ ] Update `/awaken` to drain queue before pull
- [ ] Update `/rest` to drain queue during push
- [ ] Add retry logic with exponential backoff
- [ ] Test: push with VPS down → rows queued → VPS back → auto-retry succeeds

---

## Workflow State

**Phase:** INIT
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered. Blocked by FR-033.

### Next Steps
Implement after FR-033 and FR-034.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|

### Blockers
- FR-033 (MCP tools must load)

---

## Acceptance Criteria

1. [ ] Failed push operations queued in `sync_queue` table (not lost)
2. [ ] Queue processed on `/awaken` (drain before pull)
3. [ ] Queue processed on `/rest` (drain during push)
4. [ ] Retry with exponential backoff (max 5 retries)
5. [ ] Failed rows marked as `failed` after max retries (not retried forever)
6. [ ] `igris_sync_queue_status` shows queue depth and status
7. [ ] User notified of queued operations ("X items queued for sync")
8. [ ] Queue capped at 10,000 rows (prevent unbounded growth)

---

## Notes

**Depends on:** FR-033, FR-034
**Enables:** Offline-first distributed workflow, guaranteed eventual consistency
**Pattern:** Similar to message queue (SQS-lite in SQLite)

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Crimson (Fifty.ai)
