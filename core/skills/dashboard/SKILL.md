---
name: dashboard
description: Cross-project brief and session tracker using brain MCP tools
disable-model-invocation: false
allowed-tools:
  - Bash
  - Read
  - mcp__igris-brain__igris_session_recall
  - mcp__igris-brain__igris_brief_dashboard
triggers:
  - "dashboard"
  - "cross-project dashboard"
  - "brief dashboard"
  - "what was I working on"
---

# DASHBOARD - Cross-Project Brief & Session Tracker

Display a focused dashboard of active briefs and recent sessions across all projects.

## Usage

```
/dashboard
```

## Execution

### 1. Query Sessions

If the `igris-brain` MCP server is available:
- Call `igris_session_recall` with days=7

If MCP is not available, use sqlite3 fallback:
```bash
sqlite3 ~/.igris/memory/knowledge.db "
  PRAGMA trusted_schema=ON;
  SELECT s.project, s.brief_id, s.phase, s.mode, s.summary,
         s.started_at, s.ended_at, p.name as project_name
  FROM sessions s
  LEFT JOIN projects p ON p.slug = s.project
  WHERE s.started_at >= datetime('now', '-7 days')
  ORDER BY s.started_at DESC;
"
```

### 2. Query Briefs

If the `igris-brain` MCP server is available:
- Call `igris_brief_dashboard` with no filters

If MCP is not available, use sqlite3 fallback:
```bash
sqlite3 ~/.igris/memory/knowledge.db "
  PRAGMA trusted_schema=ON;
  SELECT bs.project, bs.brief_id, bs.brief_type, bs.title, bs.status,
         bs.priority, bs.effort, bs.phase, bs.updated_at,
         p.name as project_name
  FROM brief_status bs
  LEFT JOIN projects p ON p.slug = bs.project
  ORDER BY bs.updated_at DESC;
"
```

### 3. Display Dashboard

Format as:

```
## Cross-Project Dashboard

### Recent Sessions (last 7 days)

#### 2025-01-15
- **igris-ai** (igris-ai): Implemented MG-010 session sync [MG-010], BUILDING
- **my-app** (my-app): Fixed authentication bug [BR-012], TESTING

#### 2025-01-14
- **igris-ai** (igris-ai): Completed pattern suggest tool [BR-009], COMPLETE

### Brief Summary
- In Progress: 3
- Ready: 5
- Done: 12
- Blocked: 1

### Active Briefs (all projects)
| Project | Brief | Type | Title | Status | Priority | Phase | Updated |
|---------|-------|------|-------|--------|----------|-------|---------|
| igris-ai | MG-010 | Migration | Cross-Project Session Sync | In Progress | P1-High | BUILDING | 2025-01-15 |
| my-app | BR-012 | Bug | Auth token refresh | In Progress | P0 | TESTING | 2025-01-15 |

### Recommendations
1. [Highlight blocked briefs that need attention]
2. [Suggest next priority brief to work on]
3. [Note projects with no recent activity]

_Use `/portfolio` for full brain health and analytics._
```
