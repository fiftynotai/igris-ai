# FR-037: Sync Brief File Content to VPS Brain

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

Sync full brief file content (the actual `.md` files from `ai/briefs/`) to the VPS brain, not just metadata. Currently the `brief_status` table only stores title, status, priority, and effort. The VPS dashboard and other machines cannot see the actual brief content — goals, acceptance criteria, technical approach, tasks, or agent logs.

**Why is this valuable?**

For true multi-machine collaboration, any Igris instance should be able to read any brief from any project. The dashboard should show full brief details, not just "FR-032 is In Progress." A developer working on the VPS should see the same brief content as one working on the Mac. This is the foundation for distributed brief management.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
- `brief_status` table syncs metadata only (title, status, priority, effort, phase)
- VPS can see "FR-032 is In Progress" but not the actual brief content
- Dashboard cannot show brief details, goals, acceptance criteria
- Other machines cannot read brief files from this machine
- Cross-machine brief collaboration impossible

**With this feature:**
- Full brief `.md` content synced to VPS brain
- Dashboard shows brief details (problem, goal, tasks, agent log)
- Other machines can pull and read briefs from any project
- Brief collaboration across machines enabled

---

## Technical Approach

### High-Level Design

1. **New `brief_files` table** — stores brief file content with project, brief_id, content hash
2. **Add to SYNC_TABLES** — include in push/pull sync pipeline
3. **Content deduplication** — hash-based: same content = same hash, skip re-sync
4. **Hook integration** — FR-035 hooks trigger brief file sync on edit
5. **API endpoint** — `GET /api/briefs/:id/content` returns full brief text

### Schema
```sql
CREATE TABLE brief_files (
  id TEXT PRIMARY KEY,  -- project:brief_id
  project TEXT NOT NULL,
  brief_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project, brief_id)
);
```

### Components Affected
- `brain-mcp-server/src/tools/sync.ts` — Add brief_files to SYNC_TABLES
- `brain-mcp-server/src/index.ts` — Schema migration, API endpoint
- `brain-mcp-server/src/tools/briefs.ts` — New `igris_brief_file_sync` tool

---

## Context & Inputs

### Dependencies
- [x] FR-033: Brain MCP HTTP transport fix
- [x] FR-034: Activate sync pipeline
- [ ] FR-035: Auto-sync hooks (optional but enhances)

### Files to Modify
- `brain-mcp-server/src/tools/sync.ts` — Add brief_files sync config
- `brain-mcp-server/src/index.ts` — Schema migration + API endpoint
- `brain-mcp-server/src/tools/briefs.ts` — New tool for file sync

---

## Constraints

### Technical Constraints
- Brief files can be large (1-5KB each, up to 60+ briefs per project)
- Must handle concurrent edits (LWW on updated_at)
- Content hash prevents unnecessary re-sync of unchanged files
- Must not sync template files (*-TEMPLATE.md)

### Out of Scope
- Brief file editing from VPS (read-only sync for now)
- Real-time collaborative editing
- Diff/merge for brief conflicts

---

## Tasks

### Pending
- [ ] Add `brief_files` table to schema (migration)
- [ ] Add `brief_files` to SYNC_TABLES config in sync.ts
- [ ] Create `igris_brief_file_sync` MCP tool
- [ ] Add `GET /api/briefs/:id/content` API endpoint
- [ ] Update dashboard to show brief details from content API
- [ ] Test: sync brief file → VPS has content → API returns it

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

1. [ ] `brief_files` table exists in schema
2. [ ] Brief file content synced to VPS via push
3. [ ] Content hash prevents redundant syncs
4. [ ] Template files excluded from sync
5. [ ] API endpoint returns full brief content
6. [ ] Dashboard shows brief details from synced content
7. [ ] Other machines can pull brief files from VPS

---

## Notes

**Depends on:** FR-033, FR-034
**Enables:** Full brief visibility on VPS dashboard, cross-machine brief reading
**Size estimate:** ~60 briefs, ~3KB avg = ~180KB total sync payload (manageable)

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Crimson (Fifty.ai)
