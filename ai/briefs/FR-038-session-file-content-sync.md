# FR-038: Sync Session File Content to VPS Brain

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

Sync session file content (CURRENT_SESSION.md, LEARNINGS.md, DECISIONS.md, BLOCKERS.md) to the VPS brain. Currently the `sessions` table only stores metadata snapshots. The actual session files — with detailed context, next steps, blockers, and learnings — stay local and are invisible to other machines.

**Why is this valuable?**

Session files are the richest context source for resuming work. When switching machines (Mac → VPS or vice versa), the developer needs full session context — not just "session was active." The VPS brain should hold the latest session state so any machine can resume exactly where another left off.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
- `sessions` table stores metadata only (project, started_at, mode, goal, summary)
- CURRENT_SESSION.md with active briefs, resume points, next steps stays local
- LEARNINGS.md with session discoveries stays local
- DECISIONS.md with architectural decisions stays local
- BLOCKERS.md with active blockers stays local
- Switching machines = losing all session context

**With this feature:**
- All session files synced to VPS brain
- Any machine can pull session state and resume seamlessly
- Dashboard shows full session details (not just metadata)
- Cross-machine session continuity achieved

---

## Technical Approach

### High-Level Design

1. **New `session_files` table** — stores session file content per project
2. **Add to SYNC_TABLES** — include in push/pull sync pipeline
3. **Sync on session lifecycle** — push on every session update, not just /rest
4. **Pull on /awaken** — restore session files from VPS if local is empty/stale

### Schema
```sql
CREATE TABLE session_files (
  id TEXT PRIMARY KEY,  -- project:filename
  project TEXT NOT NULL,
  filename TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project, filename)
);
```

### Session Files to Sync
- `ai/session/CURRENT_SESSION.md` — Active session state
- `ai/session/LEARNINGS.md` — Session discoveries
- `ai/session/DECISIONS.md` — Architectural decisions
- `ai/session/BLOCKERS.md` — Active blockers
- `ai/session/TEST_RESULTS.md` — Test outcomes (if exists)

### Components Affected
- `brain-mcp-server/src/tools/sync.ts` — Add session_files to SYNC_TABLES
- `brain-mcp-server/src/index.ts` — Schema migration, API endpoint
- `.claude/skills/awaken/SKILL.md` — Pull session files on resume
- `.claude/hooks/` — FR-035 hooks trigger session file sync on edit

---

## Context & Inputs

### Dependencies
- [x] FR-033: Brain MCP HTTP transport fix
- [x] FR-034: Activate sync pipeline
- [ ] FR-035: Auto-sync hooks (enhances with real-time sync)

### Files to Modify
- `brain-mcp-server/src/tools/sync.ts` — Add session_files sync config
- `brain-mcp-server/src/index.ts` — Schema migration + API
- `.claude/skills/awaken/SKILL.md` — Session file pull step

---

## Constraints

### Technical Constraints
- Session files change frequently — sync must be efficient (hash-based dedup)
- Must handle concurrent sessions on different machines (LWW per project:filename)
- CURRENT_SESSION.md is the most critical — sync on every status change
- Archive files (`ai/session/archive/`) are NOT synced (too many, too large)

### Out of Scope
- Session file merging from multiple machines (LWW is sufficient)
- Archived session sync
- Real-time collaborative session editing

---

## Tasks

### Pending
- [ ] Add `session_files` table to schema (migration)
- [ ] Add `session_files` to SYNC_TABLES config in sync.ts
- [ ] Create `igris_session_file_sync` MCP tool
- [ ] Add `GET /api/sessions/:project/files` API endpoint
- [ ] Update `/awaken` to pull session files if local is stale
- [ ] Test: update session → push → VPS has latest content → pull on other machine

---

## Workflow State

**Phase:** INIT
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered.

### Next Steps
Implement after FR-033 and FR-034.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|

### Blockers
- FR-033 (MCP tools must load)

---

## Acceptance Criteria

1. [ ] `session_files` table exists in schema
2. [ ] All 5 session files synced to VPS via push
3. [ ] `/awaken` pulls session files from VPS when local is empty/stale
4. [ ] Content hash prevents redundant syncs
5. [ ] API endpoint returns session file content
6. [ ] Cross-machine session resume works (start on Mac, continue on VPS)
7. [ ] Archive files excluded from sync

---

## Notes

**Depends on:** FR-033, FR-034
**Enables:** Cross-machine session continuity, dashboard session details
**Key insight:** CURRENT_SESSION.md is the most valuable file to sync — it contains resume points

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Crimson (Fifty.ai)
