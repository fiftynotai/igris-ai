# FR-062: Brain v5.0 — Cache Layer & Brief Migration Script

**Type:** Feature Request
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-24
**Parent Brief:** FR-054
**Blocked By:** FR-061

---

## Feature Description

**What is the proposed feature?**

Implement a cache layer that generates markdown files from DB on demand, plus a migration script that imports all existing project-local briefs and session files into the brain DB. Cache files live at `~/.igris/cache/{project}/` and serve as the filesystem interface for agents.

**Why is this valuable?**

After FR-061 adds CRUD tools, the DB has the data but agents still need markdown files to read. The cache layer bridges this gap — DB is source of truth, cache is the agent-readable output. The migration script populates the DB from existing project files.

---

## Technical Approach

### Cache Generator
- `briefs/cache.ts`: DB → `~/.igris/cache/{project}/briefs/*.md`
- `sessions/cache.ts`: DB → `~/.igris/cache/{project}/session/*.md`
- New tool: `igris_cache_rebuild` — full cache regeneration
- Cache hooks: auto-regenerate on brief_create/update, session_update

### Migration Script
- `scripts/igris_migrate_briefs.sh`: scan registered projects, parse briefs, insert into DB
- Idempotent (INSERT ON CONFLICT UPDATE)
- Skip template files (*TEMPLATE*)
- Report: X briefs, Y sessions migrated

### Components Affected
- New: `engine/components/briefs/cache.ts`
- New: `engine/components/sessions/cache.ts`
- New: `scripts/igris_migrate_briefs.sh`
- Modified: brief/session tool handlers (add cache hooks)

---

## Acceptance Criteria

1. [ ] Cache generates markdown identical to original files
2. [ ] Migration imports all 44+ briefs with zero data loss
3. [ ] Migration is idempotent (safe to run multiple times)
4. [ ] `igris_cache_rebuild` tool regenerates all cache for a project
5. [ ] Cache auto-updates on brief_create/update and session_update
6. [ ] Template files excluded from migration

---

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 1
**Completed:** 2026-02-24

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-24 | architect | Create implementation plan | SUCCESS — 4 files (3 create, 1 modify), 4 phases |
| 2026-02-24 | forger | Implement changes | SUCCESS — 3 created, 1 modified, 27 briefs + 6 sessions migrated |
| 2026-02-24 | sentinel | Run test suite | PASS 10/10 — build clean, migration verified, idempotent, templates excluded |
| 2026-02-24 | warden | Code review | REJECT — 2 critical (path traversal, missing brief_status table), 2 major (rmSync risk, missing main()) |
| 2026-02-24 | forger | Fix warden issues | SUCCESS — safePath() added, brief_status table, input validation, main() wrapper |
| 2026-02-24 | sentinel | Re-test after fixes | PASS 7/7 — build clean, safePath verified, migration confirmed |
| 2026-02-24 | warden | Re-review after fixes | APPROVE — all 4 fixes verified, no new issues |

### Next Steps
Done. Ready for archive.

---

**Created:** 2026-02-24
**Brief Owner:** Crimson (Igris AI)
