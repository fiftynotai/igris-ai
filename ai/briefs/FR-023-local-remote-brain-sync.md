# FR-023: Local + Remote Brain Sync

**Type:** Feature Request
**Priority:** P2-Medium
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-16

---

## Feature Description

**What is the proposed feature?**

Add bidirectional sync between a local brain (`~/.igris/knowledge.db`) and the remote VPS brain. Push local changes on `/rest`, pull remote changes on `/awaken`. Enables offline-first workflow with centralized backup.

**Why is this valuable?**

Working locally is fast and works offline. But changes made locally (learnings, errors, metrics) need to reach the VPS so other machines see them. And changes made from other machines need to reach the local DB. Sync bridges the gap.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
With FR-022, you either use local OR remote brain. Changes on one don't appear on the other.

**With this feature:**
Work locally for speed, sync to VPS on session end. Resume on any machine with full context.

---

## Use Cases

### Use Case 1: End-of-Session Sync
**Actor:** Developer finishing work on primary machine
**Goal:** Push all local brain changes to VPS
**Steps:**
1. Developer runs `/rest` to end session
2. Igris automatically calls `igris_brain_push`
3. Local learnings, errors, metrics, sessions, briefs push to VPS
4. VPS brain now has complete state

**Expected Outcome:** VPS DB contains all local changes.

### Use Case 2: Start-of-Session Pull
**Actor:** Developer starting work on a different machine
**Goal:** Get latest brain state from VPS
**Steps:**
1. Developer runs `/awaken` on new machine
2. Igris automatically calls `igris_brain_pull`
3. Remote learnings, errors, sessions pull to local DB
4. Developer has full context from previous sessions

**Expected Outcome:** Local DB contains all remote changes.

---

## Technical Approach

### High-Level Design

Two new MCP tools: `igris_brain_push` and `igris_brain_pull`. These work as HTTP clients that connect to the remote brain's sync API endpoint.

**Sync protocol:**
1. Each table tracks `updated_at` or `created_at` timestamps
2. Push: Query local rows WHERE updated_at > last_sync_at, POST to remote `/sync/push`
3. Pull: GET from remote `/sync/pull?since=last_sync_at`, INSERT OR REPLACE locally
4. Track `last_sync_at` in a local `sync_state` table

**Conflict resolution: Last-Write-Wins by timestamp**

| Table | Sync Key | Strategy |
|-------|----------|----------|
| learnings | `(project, category, title)` | Latest `created_at` wins, merge tags |
| errors | `(project, fingerprint)` | Latest `last_seen_at` wins, sum occurrence_count |
| projects | `slug` | Latest `last_session_at` wins |
| sessions | `id` | Append-only (no conflicts possible) |
| brief_status | `(project, brief_id)` | Latest `updated_at` wins |
| agent_metrics | `id` | Append-only (no conflicts possible) |

### Components Affected
- `brain-mcp-server/src/index.ts` — Register 2 new tools + sync HTTP endpoints
- `brain-mcp-server/src/tools/sync.ts` — New sync tool handlers
- `brain-mcp-server/src/db.ts` — Add `sync_state` table migration (v3)
- `.claude/skills/rest/SKILL.md` — Add `igris_brain_push` call
- `.claude/skills/awaken/SKILL.md` — Add `igris_brain_pull` call

### API/Interface Design

**New MCP tools:**
```
igris_brain_push(remote_url, api_key)
  → Pushes local changes since last sync to remote

igris_brain_pull(remote_url, api_key)
  → Pulls remote changes since last sync to local
```

**New HTTP endpoints on remote:**
```
POST /sync/push   — Receive and merge pushed data
GET  /sync/pull   — Return changes since timestamp
```

---

## Context & Inputs

### Dependencies
- [x] FR-022 (VPS Remote Brain) — must be deployed first

### Files to Create
- `brain-mcp-server/src/tools/sync.ts` — Sync handlers

### Files to Modify
- `brain-mcp-server/src/index.ts` — Register sync tools + endpoints
- `brain-mcp-server/src/db.ts` — Schema v3 migration (sync_state table)
- `.claude/skills/rest/SKILL.md` — Auto-push on session end
- `.claude/skills/awaken/SKILL.md` — Auto-pull on session start

---

## Constraints

### Technical Constraints
- Must work over HTTPS (sync contains project data)
- Must be idempotent (running sync twice = same result)
- Must handle network failures gracefully (retry with backoff)
- Append-only tables (sessions, metrics) never conflict
- Last-write-wins is acceptable for single-developer use case

### Out of Scope
- Real-time sync (push/pull on every tool call)
- Multi-user conflict resolution (CRDTs, merge strategies)
- Streaming replication

---

## Tasks

### Pending
- [ ] Design sync_state table schema (last_sync_at per table per remote)
- [ ] Implement `igris_brain_push` tool handler
- [ ] Implement `igris_brain_pull` tool handler
- [ ] Add `/sync/push` and `/sync/pull` HTTP endpoints to remote server
- [ ] Add schema v3 migration for sync_state table
- [ ] Integrate push into `/rest` skill
- [ ] Integrate pull into `/awaken` skill
- [ ] Handle network failures with retry logic
- [ ] Test sync with 2 machines

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Current Work
Done. Committed as `3ae2091`.

### Next Steps
None — brief complete.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-16 | architect | PLANNING phase | Plan complete — 1 new file, 5 modified, 11 steps |
| 2026-02-16 | forger | BUILDING phase | Complete — 1 new file, 5 modified, build passes |
| 2026-02-16 | sentinel | TESTING phase | PASS — build clean, all 7 checks passed, no regressions |
| 2026-02-16 | warden | REVIEWING phase | APPROVE — no critical/major issues, 5 minor suggestions |

### Blockers
None — FR-022 completed (commit `020a964`).

---

## Acceptance Criteria

1. [ ] `igris_brain_push` sends local changes to remote successfully
2. [ ] `igris_brain_pull` receives remote changes to local successfully
3. [ ] Append-only tables (sessions, metrics) merge without duplicates
4. [ ] Timestamp-based tables resolve conflicts via last-write-wins
5. [ ] `/rest` automatically triggers push
6. [ ] `/awaken` automatically triggers pull
7. [ ] Network failures don't corrupt local or remote DB
8. [ ] Sync is idempotent (running twice = same result)

---

## Test Plan

### Functional Tests
**Test Case 1: Push Local Changes**
1. Add learnings locally
2. Run `igris_brain_push`
3. Query remote DB
**Expected Result:** Remote has the new learnings

**Test Case 2: Pull Remote Changes**
1. Add errors on remote (from another machine)
2. Run `igris_brain_pull` locally
3. Query local DB
**Expected Result:** Local has the new errors

**Test Case 3: Conflict Resolution**
1. Modify same learning locally and remotely with different timestamps
2. Run sync
**Expected Result:** Latest timestamp wins, no data loss

---

## Delivery

- [ ] New sync tools registered in brain-mcp-server
- [ ] Sync endpoints on remote server
- [ ] Updated /rest and /awaken skills

---

## Notes

**Key design decision:** Last-write-wins is simple and correct for single-developer use. If multi-user support is ever needed, this would need CRDTs or operational transforms — but that's out of scope.

**Depends on:** FR-022 (VPS Remote Brain)
**Blocks:** Nothing

---

**Created:** 2026-02-16
**Last Updated:** 2026-02-16
**Brief Owner:** Crimson (Fifty.ai)
