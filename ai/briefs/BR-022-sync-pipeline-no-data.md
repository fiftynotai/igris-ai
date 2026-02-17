# BR-022: Fix Sync Pipeline Cards — No Data

**Type:** Bug Fix
**Priority:** P2-Medium
**Effort:** M-Medium (4-8h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** In Progress
**Created:** 2026-02-17

---

## Problem

The Sync Pipeline cards on the Crimson Arena dashboard show nothing and have never displayed any data. The cards exist in the UI but are empty — either the sync status API returns no data, the brain server doesn't expose the right endpoints, or the frontend doesn't render what it receives.

**Why does it matter?**
Sync pipeline visibility is critical for monitoring brain push/pull operations, queue status, and cross-device synchronization health. Without it, sync failures go unnoticed.

---

## Goal

Sync Pipeline cards display real-time sync status — last push/pull times, queue depth, chunk progress, success/failure counts.

---

## Context & Inputs

### Related Files
- `dashboard/server.py` — API endpoint serving sync status
- `dashboard/static/app.js` — Frontend rendering of sync cards
- `brain-mcp-server/src/tools/sync.ts` — Sync operations that should emit status
- `brain-mcp-server/src/index.ts` — Brain server HTTP endpoints

---

## Investigation Findings (Seeker)

### Root Cause: `/api/sync-status` endpoint does not exist on brain server
- Dashboard at `server.py:1635-1638` defines `/api/sync-status` endpoint
- `build_sync_status()` at `server.py:1082-1087` proxies to brain server via `brain_request(app, "/api/sync-status")`
- Brain server (`index.ts`) only implements: `/health`, `/api/instances`, `/api/projects`, `/api/briefs`, `/api/sessions`, `/api/brain-stats`, `/sync/push`, `/sync/pull`
- **No `/api/sync-status` HTTP endpoint exists** — returns 404
- Dashboard falls back to `{status: "offline", last_push: null, last_pull: null, queue_depth: 0}`
- Frontend at `app.js:282` fetches `/api/sync-status`, gets failure, `syncStatus` stays undefined
- `renderSyncPanel()` at `app.js:2409-2442` returns early because `data` is undefined

### Available Data (not exposed via HTTP)
- MCP tool `igris_sync_queue_status` exists and can query sync_queue table
- sync_queue table has: status (pending/sent/retrying/failed), retry_count, timestamps
- sync_state table has: last push/pull timestamps per table
- This data just needs an HTTP endpoint to expose it

### Fix Plan
1. **Brain Server:** Add `GET /api/sync-status` endpoint to `index.ts` (~line 1264)
   - Query sync_queue for counts by status (pending, sent, retrying, failed)
   - Query sync_state for last push/pull timestamps
   - Return `{status, last_push, last_pull, queue_depth, pending, sent, failed}`
2. **Dashboard:** No backend changes needed — `build_sync_status()` already handles the response
3. **Frontend:** No changes needed — rendering code is correct

### Key Line References
| File | Lines | What |
|------|-------|------|
| `server.py` | 1082-1087 | `build_sync_status()` proxy call |
| `server.py` | 1635-1638 | `/api/sync-status` endpoint |
| `app.js` | 282 | Frontend fetch |
| `app.js` | 2409-2442 | `renderSyncPanel()` render |
| `index.ts` | ~1264 | Where to add new endpoint |

---

## Acceptance Criteria

1. [ ] Brain server exposes `GET /api/sync-status` HTTP endpoint
2. [ ] Endpoint returns queue depth, last push/pull times, status counts
3. [ ] Dashboard sync cards render real pipeline state
4. [ ] Data updates via WebSocket or polling

---

**Created:** 2026-02-17
**Brief Owner:** Crimson
