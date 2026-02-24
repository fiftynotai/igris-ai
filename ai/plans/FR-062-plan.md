# Implementation Plan: FR-062 — Brain v5.0 Cache Layer & Brief Migration Script

**Complexity:** M (Medium)
**Estimated Duration:** 1-2 days
**Risk Level:** Medium

## Summary

Implement a filesystem cache layer that regenerates markdown files from the brain DB into `~/.igris/cache/{project}/`, plus a migration script that imports all existing project-local briefs and session files into the brain DB. The cache layer listens to existing event bus events to auto-update on writes.

## Files to Modify

| File | Action | Changes |
|------|--------|---------|
| `brain-mcp-server/src/engine/components/cache/handlers.ts` | CREATE | Cache generation logic (DB to markdown), rebuild handler |
| `brain-mcp-server/src/engine/components/cache/index.ts` | CREATE | Cache component registration, event listeners, tool definition |
| `brain-mcp-server/src/engine/index.ts` | MODIFY | Import + register cache component |
| `scripts/igris_migrate_briefs.sh` | CREATE | Migration script: scan projects, parse briefs/sessions, insert into DB |

**Total: 3 new files, 1 modified file**

## Implementation Steps

### Phase 1: Cache Handlers (`handlers.ts`)

1. `ensureCacheDir(project)` — create `~/.igris/cache/{project}/briefs/` and `session/`
2. `cacheBrief(project, briefId)` — query brief_files JOIN brief_status, write to cache
3. `cacheSessionFile(project, filename)` — query session_files, write to cache
4. `handleCacheRebuild(args)` — full regeneration tool, scope param (briefs/sessions/all)
5. `handleCacheClean(args)` — remove cache directory for a project

### Phase 2: Cache Component (`index.ts`)

- Component: name='cache', version='1.0.0', depends=['briefs','sessions']
- Tools: igris_cache_rebuild, igris_cache_clean
- Events: emits cache.rebuilt/cache.cleaned, listens brief.created/brief.synced/session.file.updated
- Event handlers wire cacheBrief/cacheSessionFile on changes

### Phase 3: Engine Registration

- Import + add createCacheComponent to componentFactories in engine/index.ts

### Phase 4: Migration Script

- `scripts/igris_migrate_briefs.sh` — scan registered projects, parse briefs, insert into DB
- Idempotent via INSERT ON CONFLICT UPDATE
- Skip templates, parse metadata, compute SHA-256
- Report totals

## Testing (14 scenarios)

1-7: Cache directory creation, content fidelity, auto-cache on create/update/session, scope, clean
8-12: Migration full run, session migration, idempotency, template exclusion, metadata accuracy
13-14: Engine boot with cache component, end-to-end flow

## Risks

| Risk | Mitigation |
|------|------------|
| Event payload missing fields | Null-check in handlers, log warnings |
| File permission errors | ensureCacheDir with recursive, catch EACCES |
| Migration misparse metadata | Reuse proven regex from igris_migrate_to_v4.sh |
| DB lock during migration | PRAGMA busy_timeout=5000, WAL mode |

---

**Created:** 2026-02-24
**Architect:** ARCHITECT Agent
