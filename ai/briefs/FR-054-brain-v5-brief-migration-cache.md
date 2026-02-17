# FR-054: Brain v5.0 Phase 3 — Brief Migration & Cache Layer

**Type:** Feature Request
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Ready
**Created:** 2026-02-17
**Parent Brief:** FR-051
**Blocked By:** FR-053

---

## Feature Description

**What is the proposed feature?**

Migrate all project-local briefs (`ai/briefs/*.md`) and session files (`ai/session/`) into the centralized brain database. Implement a cache layer that generates markdown files from DB on demand so agents continue reading familiar `.md` format. Update all skills (`/hunt`, `/register`, `/archive`, `/scan`) to use DB + cache instead of direct file access. Stop creating `ai/briefs/` and `ai/session/` directories per project.

**Why is this valuable?**

Brief and session files currently live in project repos, polluting git history with Igris management artifacts. Centralizing this data in the brain DB enables cross-project querying, eliminates git noise, and makes the brain the true source of truth for all management data.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved

**Current situation:**
- Brief files in `ai/briefs/` pollute project git history
- Session files in `ai/session/` are project-local (can't query across projects)
- Brief data exists in both files (full content) and DB (metadata only)
- No way to search briefs across projects without reading every file

**With this feature:**
- All brief content centralized in brain DB
- Project repos have zero Igris management files in git
- Cross-project brief queries via single SQL query
- Cache layer generates `.md` files agents already know how to read

---

## Technical Approach

### High-Level Design

1. **Migration script:** Scans `ai/briefs/*.md` in all registered projects, parses markdown, inserts into `briefs` table
2. **Cache generator:** Renders DB briefs → `~/.igris/cache/{project}/briefs/*.md`
3. **Skill updates:** `/hunt`, `/register`, `/archive`, `/scan` read from DB, write to DB, regenerate cache
4. **Session migration:** `CURRENT_SESSION.md`, `BLOCKERS.md` → DB `sessions` table columns
5. **Install update:** `igris_install.sh` stops creating `ai/briefs/` and `ai/session/` per project

### Cache Strategy

DB is source of truth. Cache is generated markdown that agents read:
```
~/.igris/cache/{project-slug}/
├── briefs/
│   ├── FR-052-brain-v5-engine-foundation.md
│   └── ...
└── session/
    └── CURRENT_SESSION.md
```

Cache regenerated on:
- Brief creation/update (selective)
- `/awaken` (full session cache)
- `/rest` (full session cache)
- Explicit `igris_cache_rebuild` tool call

### Components Affected
- Modified: `engine/components/briefs/` — full content storage + cache generation
- Modified: `engine/components/sessions/` — session state in DB + cache generation
- Modified: All skills that read `ai/briefs/` or `ai/session/`
- Modified: `scripts/igris_install.sh` — stop creating project-local dirs
- New: Migration script for existing brief files

---

## Context & Inputs

### Dependencies
- [x] FR-052 (Engine Foundation) — engine architecture
- [x] FR-053 (Task Management) — briefs-v2 with full content

### Files to Create
- `brain-mcp-server/src/engine/components/briefs/cache.ts` — Cache generator
- `brain-mcp-server/src/engine/components/sessions/cache.ts` — Session cache
- `scripts/igris_migrate_briefs.sh` — Migration script

### Files to Modify
- All skill files that reference `ai/briefs/` or `ai/session/`
- `scripts/igris_install.sh` — remove project-local dir creation
- `brain-mcp-server/src/engine/components/briefs/index.ts` — add cache hooks
- `brain-mcp-server/src/engine/components/sessions/index.ts` — add cache hooks

---

## Constraints

### Technical Constraints
- Zero data loss during migration — every brief field preserved
- Cache must produce markdown identical to what agents currently read
- Migration must be idempotent (safe to run multiple times)
- Must handle edge cases: archived briefs, draft briefs, template files

### UX Constraints
- Skills work identically before and after migration
- Developer sees no workflow change
- Migration runs once, automatically on upgrade

### Out of Scope
- Scheduling system (FR-055)
- Autonomous coordination (FR-056)
- Dashboard UI for brief management
- Brief template system redesign

---

## Tasks

### Pending
- [ ] Task 1: Implement brief markdown parser (extract all fields from .md files)
- [ ] Task 2: Implement brief cache generator (DB → markdown)
- [ ] Task 3: Write migration script (scan projects → parse briefs → insert into DB)
- [ ] Task 4: Migrate session state to DB (CURRENT_SESSION.md fields → sessions table)
- [ ] Task 5: Implement session cache generator
- [ ] Task 6: Update skills to use DB + cache (/hunt, /register, /archive, /scan)
- [ ] Task 7: Update igris_install.sh (stop creating ai/briefs/, ai/session/)
- [ ] Task 8: Verify migration with real data (all registered projects)
- [ ] Task 9: Verify skills work identically post-migration

### In Progress

### Completed

---

## Workflow State

**Phase:** INIT
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered. Blocked on FR-053 (Task Management).

### Next Steps
Complete FR-052 and FR-053 first, then HUNT FR-054.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-17 | orchestrator | Brief registration from FR-051 Phase 3 | SUCCESS |

### Blockers
- FR-053 must complete first (provides briefs-v2 with full content storage)

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] All existing briefs migrated to DB with zero data loss
2. [ ] Cache generates markdown identical to original files
3. [ ] Skills (/hunt, /register, /archive, /scan) use DB + cache
4. [ ] Session state stored in DB, cache generated for agents
5. [ ] `igris_install.sh` no longer creates `ai/briefs/` or `ai/session/`
6. [ ] Migration script is idempotent
7. [ ] Cross-project brief queries work via single SQL
8. [ ] No regressions in skill behavior

---

## Test Plan

### Functional Tests

**Test Case 1: Brief Migration**
**Steps:**
1. Run migration on project with 44+ brief files
2. Query DB — verify all briefs present with full content
3. Generate cache — compare with original files
4. Run `/scan` — verify counts match

**Expected Result:** Zero data loss, identical cache output
**Status:** [ ] Pass / [ ] Fail

**Test Case 2: Skill Compatibility**
**Steps:**
1. Run `/register bug "test"` — verify brief created in DB + cache
2. Run `/hunt` on a brief — verify reads from DB/cache
3. Run `/archive` — verify updates DB + removes cache
4. Run `/scan` — verify reads from DB

**Expected Result:** All skills work identically
**Status:** [ ] Pass / [ ] Fail

### Regression Tests
- [ ] All existing MCP tools unchanged
- [ ] VPS sync includes migrated briefs
- [ ] Session recovery works from DB-backed cache

---

## Notes

**Parent brief:** FR-051 (Brain v5.0 Modular Architecture)
**Phase:** 3 of 5
**Depends on:** FR-052, FR-053

**Key decision from FR-051:** CURRENT_SESSION.md becomes a generated cache file. DB is source of truth. Cache regenerated by `/rest` and `/awaken`.

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Crimson (Igris AI)
