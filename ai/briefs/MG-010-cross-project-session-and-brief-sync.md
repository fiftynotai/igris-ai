# MG-010: Cross-Project Session & Brief Sync

**Type:** Migration
**Priority:** P1-High
**Effort:** L-Large (3-5 days)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** In Progress
**Created:** 2026-02-16
**Completed:**

---

## Problem

Igris AI v4.0 introduced a centralized brain (`~/.igris/`) with persistent memory for learnings, errors, patterns, and metrics across projects. However, **session state and briefs remain project-local**. There is no way to ask "what was I working on yesterday across all my projects?" and get a unified answer.

When a developer works on 3 projects in one day, then returns the next morning:
- Each project's `CURRENT_SESSION.md` only knows about itself
- No cross-project brief tracker exists
- `/portfolio` shows stats but not active tasks or session context
- The developer must `cd` into each project and `/awaken` separately to remember state

This defeats the purpose of a centralized brain — the brain remembers *learnings* across projects but forgets *what you were doing*.

---

## Goal

After this migration, a developer can:
1. Open any project and ask "what was I working on yesterday?" — get a unified view of all projects
2. See active briefs across all projects from a single `/dashboard` command
3. Have session snapshots automatically synced to the brain on `/rest`
4. Have session context automatically recalled on `/awaken`
5. Track brief lifecycle (status changes) across the portfolio

---

## Context and Inputs

### Existing Infrastructure (from MG-009)
- `~/.igris/memory/knowledge.db` — SQLite WAL + FTS5, already has `projects`, `learnings`, `errors`, `agent_metrics` tables
- `igris-brain` MCP server — registered globally, 11 tools, stdio transport
- `/rest` skill — already syncs learnings/decisions to brain
- `/awaken` skill — already queries brain for relevant learnings
- `/portfolio` skill — shows stats but not task-level detail
- Staging pipeline — hooks write JSON to `~/.igris/staging/`

### Key Files
- `brain-mcp-server/src/db.ts` — Database singleton
- `brain-mcp-server/src/index.ts` — MCP server entry point (tool registration)
- `brain-mcp-server/src/tools/` — Tool implementations
- `scripts/igris_brain_schema.sql` — Database schema
- `.claude/skills/awaken/SKILL.md` — Session start skill
- `.claude/skills/rest/SKILL.md` — Session end skill
- `.claude/skills/portfolio/SKILL.md` — Portfolio dashboard skill

---

## Constraints

- Must be backward compatible (projects without brain still work)
- Must use existing SQLite WAL concurrency model (no new infrastructure)
- Session snapshots must be lightweight (not full CURRENT_SESSION.md dumps)
- Brief sync should capture status changes, not full brief content
- All brain features degrade gracefully if MCP not available
- Follow existing patterns: parameterized SQL, TypeScript strict mode, MCP response format

---

## Acceptance Criteria

1. [ ] New `sessions` table in knowledge.db schema
2. [ ] New `brief_status` table in knowledge.db schema
3. [ ] `igris_session_sync` MCP tool — stores session snapshot on /rest
4. [ ] `igris_session_recall` MCP tool — retrieves recent sessions across projects
5. [ ] `igris_brief_sync` MCP tool — stores brief status change
6. [ ] `igris_brief_dashboard` MCP tool — active briefs across all projects
7. [ ] `/rest` skill updated to call `igris_session_sync`
8. [ ] `/awaken` skill updated to call `igris_session_recall` and show cross-project context
9. [ ] `/dashboard` skill created — unified cross-project brief and session tracker
10. [ ] `/portfolio` skill updated to include active brief summary
11. [ ] Schema migration applied cleanly (additive, no breaking changes)
12. [ ] All existing tests still pass
13. [ ] New tools tested with concurrent access

---

## Implementation Sketch

### New Database Tables

```sql
-- Session snapshots (synced on /rest)
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    brief_id TEXT,
    phase TEXT,
    mode TEXT,
    summary TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    FOREIGN KEY (project) REFERENCES projects(slug)
);

CREATE INDEX idx_sessions_project ON sessions(project);
CREATE INDEX idx_sessions_ended_at ON sessions(ended_at);

-- Brief status tracking (synced on status changes)
CREATE TABLE IF NOT EXISTS brief_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    brief_id TEXT NOT NULL,
    brief_type TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    priority TEXT,
    effort TEXT,
    phase TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (project) REFERENCES projects(slug)
);

CREATE INDEX idx_brief_status_project ON brief_status(project);
CREATE INDEX idx_brief_status_brief_id ON brief_status(brief_id);
CREATE UNIQUE INDEX idx_brief_status_unique ON brief_status(project, brief_id);
```

### New MCP Tools

**igris_session_sync** — Called by `/rest`
- Input: project, brief_id, phase, mode, summary
- Upsert into sessions table (one active session per project)

**igris_session_recall** — Called by `/awaken`
- Input: days (default 7)
- Returns: recent sessions across all projects, grouped by day
- Output: "Yesterday: Project A (BR-012, BUILDING), Project B (FR-005, TESTING)..."

**igris_brief_sync** — Called when brief status changes
- Input: project, brief_id, brief_type, title, status, priority, effort, phase
- Upsert into brief_status table

**igris_brief_dashboard** — Called by `/dashboard`
- Input: status filter (optional), project filter (optional)
- Returns: all active briefs across projects with current phase

### New Skill: `/dashboard`

Cross-project brief and session tracker showing:
```
## Cross-Project Dashboard

### Active Sessions (last 48h)
| Project | Brief | Phase | Last Active |
|---------|-------|-------|-------------|
| project-a | BR-012 | BUILDING | 2h ago |
| project-b | FR-005 | TESTING | 5h ago |

### Brief Summary
- In Progress: 2 (across 2 projects)
- Blocked: 0
- Completed today: 1 (TD-003 in project-c)

### Yesterday's Work
- project-a: Worked on BR-012 (auth fix), reached BUILDING phase
- project-b: Worked on FR-005 (dark mode), tests failing
- project-c: Completed TD-003 (API refactor), committed
```

---

## Test Plan

### Automated
- Schema migration: new tables created without breaking existing data
- igris_session_sync: store and retrieve session snapshots
- igris_session_recall: returns correct sessions within time window
- igris_brief_sync: upsert works (insert new, update existing)
- igris_brief_dashboard: filters by status and project correctly
- Concurrent access: 3 simultaneous session syncs don't corrupt

### Manual
- Work on 2 projects, `/rest` both, next day `/awaken` in one — see both sessions recalled
- Run `/dashboard` — see briefs from all registered projects

---

## Delivery

- [ ] Schema migration (additive — new tables only)
- [ ] 4 new MCP tool implementations
- [ ] 1 new skill (`/dashboard`)
- [ ] 2 updated skills (`/awaken`, `/rest`)
- [ ] 1 updated skill (`/portfolio`)
- [ ] Update igris_os.md brain tools table
- [ ] Update README with /dashboard command

---

## References

- **Depends on:** MG-009 (Centralized Brain Architecture) — completed
- **Blocks:** MG-003 (Desktop UI MCP Client) — will consume these tools
- **Related:** FR-009 (Token Tracking), FR-011 (Digivice Context Window)

---

## Notes

- This is a natural extension of MG-009 — the infrastructure is already there
- Schema changes are purely additive (new tables, no modifications to existing)
- The `/dashboard` skill is the user-facing payoff — "what's happening across my projects?"
- Brief sync should happen at key lifecycle moments: status changes during /hunt, /rest, /archive
- Session recall on /awaken creates a "welcome back" experience across the portfolio

---

## Workflow State

**Phase:** COMMITTING
**Active Agent:** none
**Retry Count:** 0

### Current Work
Warden approved. Committing changes.

### Next Steps
Commit → COMPLETE.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-16 | planner | Create implementation plan | SUCCESS — 8 phases, 13 files (2 create, 11 modify) |
| 2026-02-16 | forger | Implement all phases | SUCCESS — 13 files (3 created, 10 modified), build clean |
| 2026-02-16 | sentinel | Run test suite | PASS — 10/10 categories, 0 warnings |
| 2026-02-16 | warden | Code review | APPROVE — 3 minor doc fixes applied |

### Blockers
None

---

**Created:** 2026-02-16
**Last Updated:** 2026-02-16
**Brief Owner:** Crimson (Fifty.ai)
