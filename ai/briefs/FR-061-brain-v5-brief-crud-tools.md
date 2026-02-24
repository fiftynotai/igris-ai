# FR-061: Brain v5.0 — Brief & Session CRUD Tools

**Type:** Feature Request
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** In Progress
**Created:** 2026-02-24
**Parent Brief:** FR-054
**Blocked By:** (none — FR-053 complete)

---

## Feature Description

**What is the proposed feature?**

Add 6 new MCP tools to the brain engine for full brief and session CRUD operations. Currently the briefs component only has `igris_brief_sync` (metadata upsert) and `igris_brief_dashboard` (listing). The session component only has `igris_session_sync` (snapshot) and `igris_session_recall` (history). Skills need tools to read/write full brief content and session files from the brain DB.

**Why is this valuable?**

These tools are the foundation for FR-062 (cache layer) and FR-063 (skill updates). Without DB-backed CRUD, skills must read/write local markdown files directly, tying briefs to project repos.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved

**Current situation:**
- `brief_files` table exists but has no read/query tools exposed via MCP
- `session_files` table exists but only has `igris_session_file_pull` (bulk pull)
- Skills can't create/read/update briefs via MCP — must use filesystem

**With this feature:**
- 4 brief tools: get (full content), list (with filters), create, update
- 2 session tools: get (one file), update (write file)
- Foundation for cache layer and skill migration

---

## Technical Approach

### Existing DB Tables (already created, schema v6/v7)

**`brief_files`:** project, brief_id, filename, content, content_hash, updated_at
**`brief_status`:** project, brief_id, title, status, priority, effort, phase, brief_type, updated_at
**`session_files`:** project, filename, content, content_hash, updated_at

### New MCP Tools (6 total)

1. **`igris_brief_get`** — Get full brief content + metadata by project + brief_id
   - Joins `brief_files` (content) with `brief_status` (metadata)
   - Returns: content, title, status, priority, effort, phase, type

2. **`igris_brief_list`** — List briefs with filters
   - Filters: project, status, type, priority
   - Returns: array of brief metadata (no content by default, optional include_content flag)
   - Supports the same filtering scan/register need

3. **`igris_brief_create`** — Create a new brief in DB
   - Writes to both `brief_files` (full content) and `brief_status` (metadata) atomically
   - Computes content_hash (SHA-256)
   - Emits `brief.created` event

4. **`igris_brief_update`** — Update brief content and/or metadata
   - Updates `brief_files` and/or `brief_status` depending on what's provided
   - Emits `brief.synced` + conditionally `brief.completed`

5. **`igris_session_get`** — Get one session file by project + filename
   - Reads from `session_files` table
   - Supports: CURRENT_SESSION.md, BLOCKERS.md, DECISIONS.md, LEARNINGS.md

6. **`igris_session_update`** — Write/update a session file
   - Upserts into `session_files` with content_hash
   - Used by /hunt, /rest, /awaken to update session state

### Components Affected
- Modified: `engine/components/briefs/index.ts` — register 4 new tools
- Modified: `engine/components/sessions/index.ts` — register 2 new tools
- Modified: `tools/briefs.ts` — add handler functions
- Modified: `tools/sessions.ts` — add handler functions

---

## Constraints

- Must use existing `brief_files`, `brief_status`, `session_files` tables (no schema changes)
- Must follow BrainComponent tool registration pattern from FR-052
- All handlers must have runtime arg validation (WARDEN standard)
- All SQL must be parameterized
- Existing tools must continue working unchanged
- `igris_brief_create` must compute content_hash for sync integrity

### Out of Scope
- Cache layer (FR-062)
- Skill instruction updates (FR-063)
- Migration script (FR-062)

---

## Tasks

### Pending
- [ ] Task 1: Implement handleBriefGet — join brief_files + brief_status
- [ ] Task 2: Implement handleBriefList — dynamic filters, pagination
- [ ] Task 3: Implement handleBriefCreate — atomic write to both tables + event
- [ ] Task 4: Implement handleBriefUpdate — partial update support + events
- [ ] Task 5: Implement handleSessionFileGet — simple read by project + filename
- [ ] Task 6: Implement handleSessionFileUpdate — upsert with content_hash
- [ ] Task 7: Register all 6 tools in engine components with input schemas
- [ ] Task 8: Build and verify — 44 total engine tools (was 38)

### In Progress

### Completed

---

## Workflow State

**Phase:** INIT
**Active Agent:** none
**Retry Count:** 0

### Current Work
HUNT initiated. Adding 6 CRUD tools to engine.

### Next Steps
Proceed to PLANNING phase.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-24 | orchestrator | Brief split from FR-054 (sub-phase A) | SUCCESS |
| 2026-02-24 | orchestrator | HUNT INIT — brief loaded, status In Progress | SUCCESS |

### Blockers
(none)

---

## Acceptance Criteria

1. [ ] `igris_brief_get` returns full content + metadata for a brief
2. [ ] `igris_brief_list` returns filtered brief list with correct counts
3. [ ] `igris_brief_create` writes to both tables atomically
4. [ ] `igris_brief_update` updates content and/or metadata
5. [ ] `igris_session_get` returns session file content
6. [ ] `igris_session_update` upserts session file with hash
7. [ ] All 6 tools registered in engine, total tools = 44
8. [ ] TypeScript compilation clean
9. [ ] Existing tools unchanged

---

## Test Plan

### Functional Tests
- Create a brief via `igris_brief_create`, verify in both tables
- Get it via `igris_brief_get`, verify content + metadata match
- List briefs with various filters, verify counts
- Update via `igris_brief_update`, verify changes persisted
- Session get/update round-trip test

### Regression Tests
- All 38 existing tools still work
- VPS sync still includes brief_files and session_files

---

**Created:** 2026-02-24
**Last Updated:** 2026-02-24
**Brief Owner:** Crimson (Igris AI)
