# BR-019: Fix VPS Brain Push HTTP 500

**Type:** Bug Fix
**Priority:** P1-High
**Effort:** S-Small (< 4h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** In Progress
**Created:** 2026-02-17

---

## Problem

**What's broken or missing?**

The VPS brain server's `/sync/push` endpoint rejects large payloads with HTTP 500. The Express body-parser middleware is hardcoded to `10mb` limit at `brain-mcp-server/src/index.ts:1513`. When `igris_sync_queue_drain` or `igris_brain_push` sends 28+ queued items (estimated ~14MB), the payload exceeds the limit and Express rejects it.

Error manifests as: `Sync queue drain failed: HTTP 500`

**Why does it matter?**

28 sync queue items are stuck and cannot be pushed to the VPS brain. This breaks cross-device brain synchronization and the Crimson Arena dashboard data flow. Data loss risk if items exceed max_retries.

---

## Goal

**What should happen after this brief is completed?**

1. Sync queue drain completes successfully — all 28 items pushed to VPS
2. Future large payloads are handled gracefully via chunking
3. No data loss from payload size limits

---

## Context & Inputs

### Affected Modules
- [x] brain-mcp-server (Express server + sync tools)

### Layers Touched
- [x] Business Logic (sync.ts tool handlers)
- [x] Data Layer (Express endpoint middleware)

### API Changes
- [x] Modified endpoint: POST /sync/push — increase body-parser limit

### Related Files
- `brain-mcp-server/src/index.ts` — line 1513 (body-parser limit)
- `brain-mcp-server/src/tools/sync.ts` — lines 323-439 (handleBrainPush), 646-752 (handleSyncQueueDrain)

---

## Constraints

### Architecture Rules
- Must not break existing sync protocol (schema_version: 8)
- Chunked pushes must be idempotent (safe to retry individual chunks)

### Out of Scope
- Changing sync queue schema
- Modifying pull endpoint

---

## Tasks

### Pending
- [ ] Task 1: Increase body-parser limit on /sync/push to 50mb
- [ ] Task 2: Add payload chunking to handleSyncQueueDrain()
- [ ] Task 3: Add payload chunking to handleBrainPush()
- [ ] Task 4: Test sync queue drain succeeds with 28 queued items
- [ ] Task 5: Deploy to VPS via /sync code

### In Progress

### Completed

---

## Workflow State

**Phase:** COMMITTING
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered, ready for HUNT pipeline.

### Next Steps
Start HUNT — delegate to architect for planning.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-17 17:15 | seeker | Investigation | Root cause: body-parser 10mb limit at index.ts:1513 |
| 2026-02-17 17:20 | architect | Plan | 4-phase plan: limit increase + chunkTablesForPush + refactor push + refactor drain |
| 2026-02-17 17:25 | forger | Implementation | 2 files modified, tsc --noEmit PASS |
| 2026-02-17 17:30 | sentinel | Testing | PASS 6/6 checks, tsc strict clean, no lint/test suite available |
| 2026-02-17 17:35 | warden | Review | APPROVE — no critical/major findings, 5 minor notes |

### Blockers
None

---

## Acceptance Criteria

**The fix is complete when:**

1. [ ] body-parser limit increased to 50mb on /sync/push endpoint
2. [ ] handleSyncQueueDrain() chunks payloads into <5MB batches
3. [ ] handleBrainPush() chunks payloads into <5MB batches
4. [ ] Sync queue drain succeeds (28 items pushed)
5. [ ] No regression on pull endpoint
6. [ ] Deployed to VPS

---

## Test Plan

### Manual Test Cases

#### Test Case 1: Drain sync queue
**Steps:**
1. Call igris_sync_queue_drain with remote brain URL
2. Verify all 28 items are pushed successfully
3. Verify VPS brain received the data

**Expected Result:** All items pushed, queue empty

---

## Delivery

### Code Changes
- [ ] Modified: `brain-mcp-server/src/index.ts` (body-parser limit)
- [ ] Modified: `brain-mcp-server/src/tools/sync.ts` (chunking logic)

### Deployment Notes
- [ ] Requires VPS deploy: Yes (`/sync code`)
- [ ] Rollback plan: Revert limit change, re-queue items

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Crimson
