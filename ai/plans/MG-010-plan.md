# Implementation Plan: MG-010 — Cross-Project Session & Brief Sync

**Complexity:** L (Large)
**Estimated Duration:** 3-5 days
**Risk Level:** Low

## Summary

Add cross-project session snapshots and brief lifecycle tracking to the Igris Brain MCP server. 2 new database tables, 4 new MCP tools, 1 new skill, updates to 3 existing skills, a runtime schema migration, and documentation updates across 7 files. All changes are additive and backward compatible.

## Files

| # | File | Action | Changes |
|---|------|--------|---------|
| 1 | `brain-mcp-server/src/db.ts` | MODIFY | Add `migrateSchema()` function, call from `getDb()` |
| 2 | `scripts/igris_brain_schema.sql` | MODIFY | Append sessions + brief_status tables for fresh installs |
| 3 | `brain-mcp-server/src/tools/sessions.ts` | CREATE | `handleSessionSync`, `handleSessionRecall` |
| 4 | `brain-mcp-server/src/tools/briefs.ts` | CREATE | `handleBriefSync`, `handleBriefDashboard` |
| 5 | `brain-mcp-server/src/index.ts` | MODIFY | Import + register 4 new tools |
| 6 | `.claude/skills/rest/SKILL.md` | MODIFY | Add `igris_session_sync` + `igris_brief_sync` calls |
| 7 | `.claude/skills/awaken/SKILL.md` | MODIFY | Add `igris_session_recall` call |
| 8 | `.claude/skills/portfolio/SKILL.md` | MODIFY | Add active brief summary, remove "dashboard" trigger |
| 9 | `.claude/skills/dashboard/SKILL.md` | CREATE | New `/dashboard` skill |
| 10 | `ai/prompts/igris_os.md` | MODIFY | Add 4 tools to brain tools table |
| 11 | `.claude/rules/04-igris-agents.md` | MODIFY | Add `/dashboard` to skill-based operations |
| 12 | `CLAUDE.md` | MODIFY | Add `/dashboard` to skills table |
| 13 | `README.md` | MODIFY | Add `/dashboard` command + tool entries |

## Phases

### Phase 1: Schema Migration (db.ts + schema.sql)

**Complexity:** S

1. Add `migrateSchema(db)` function to `db.ts`:
   - Query `schema_version` for current version
   - If version < 2: CREATE `sessions` + `brief_status` tables + indexes in a transaction
   - INSERT version 2 into `schema_version`
   - Called automatically in `getDb()` after pragmas

2. Update `igris_brain_schema.sql`:
   - Append new tables + indexes at end (for fresh installs)
   - Add `INSERT OR IGNORE INTO schema_version (version) VALUES (2)` at end

### Phase 2: Session Tools (sessions.ts) — CREATE

**Complexity:** M

1. `handleSessionSync(args)`:
   - Close existing open sessions: `UPDATE sessions SET ended_at = datetime('now') WHERE project = ? AND ended_at IS NULL`
   - Insert new session row
   - Return confirmation with session ID

2. `handleSessionRecall(args)`:
   - Query sessions within `days` window (default 7) across all projects
   - LEFT JOIN with projects for display names
   - Group by date in TypeScript
   - Format as markdown with day headers

### Phase 3: Brief Tools (briefs.ts) — CREATE

**Complexity:** M

1. `handleBriefSync(args)`:
   - `INSERT OR REPLACE` using UNIQUE constraint on (project, brief_id)
   - Return confirmation

2. `handleBriefDashboard(args)`:
   - Dynamic WHERE clause for optional status/project filters
   - Summary counts query (by status)
   - Full list query with project names via LEFT JOIN
   - Format as markdown dashboard

### Phase 4: Index Registration (index.ts)

**Complexity:** S

1. Add imports for sessions.ts and briefs.ts handlers + types
2. Register 4 new tools in ListToolsRequestSchema with inputSchema
3. Add 4 switch cases in CallToolRequestSchema
4. Update JSDoc comment (now 15 tools)

### Phase 5: Skill Updates (rest, awaken, portfolio)

**Complexity:** S

1. `/rest` — Add `igris_session_sync` + `igris_brief_sync` calls in step 2.5
2. `/awaken` — Add `igris_session_recall` call in step 3.5 with cross-project context display
3. `/portfolio` — Add active brief summary section, **remove "dashboard" trigger** (conflict with new `/dashboard` skill)

### Phase 6: New Dashboard Skill — CREATE

**Complexity:** S

Create `.claude/skills/dashboard/SKILL.md`:
- Triggers: "dashboard", "cross-project dashboard", "brief dashboard", "what was I working on"
- Calls `igris_session_recall` (days=2) + `igris_brief_dashboard`
- Formatted dashboard with active sessions, brief summary, yesterday's work
- Fallback to sqlite3 if MCP not available

### Phase 7: Documentation

**Complexity:** S

1. `igris_os.md` — Add 4 tools to brain tools table, update integration points
2. `04-igris-agents.md` — Add `/dashboard` to skill-based operations
3. `CLAUDE.md` — Add `/dashboard` to skills table
4. `README.md` — Add `/dashboard` in all command listings, update tool count

### Phase 8: Build Verification

1. `npm run build` — zero errors
2. Schema migration test — tables exist, version=2
3. MCP inspector — 15 tools registered
4. Smoke test — /rest, /awaken, /dashboard, /portfolio

## Dependency Graph

```
Phase 1 (Schema) ─┬─> Phase 2 (Sessions) ──┐
                   │                         │
                   └─> Phase 3 (Briefs) ─────┤
                                             v
                                      Phase 4 (Index) ──> Phase 5 (Skills) ──> Phase 6 (Dashboard)
                                                                                       │
                                                                                       v
                                                                               Phase 7 (Docs) ──> Phase 8 (Verify)
```

## Critical Finding

The `/portfolio` skill has `"dashboard"` as a trigger (line 15). This MUST be removed to avoid conflict with the new `/dashboard` skill.

## Risks

| Risk | Mitigation |
|------|------------|
| Schema migration on every `getDb()` call | Fast check (tiny table), no-op after migration |
| `INSERT OR REPLACE` changes autoincrement IDs | `id` column not used as FK anywhere |
| FK on `sessions.project` could fail if unregistered | Use LEFT JOIN; `/awaken` already calls `igris_project_register` |
| Portfolio/Dashboard trigger conflict | Remove "dashboard" from `/portfolio` triggers |
