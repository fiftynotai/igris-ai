---
name: ops
tier: essential
description: Cross-project ops command center for in-flight work, blockers, project roster, and brain health
disable-model-invocation: false
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - mcp__igris-brain__igris_session_recall
  - mcp__igris-brain__igris_brief_dashboard
  - mcp__igris-brain__igris_instance_list
triggers:
  - "ops"
  - "operations"
  - "cross-project"
  - "brain status"
  - "what needs me"
  - "what is in flight"
  - "list projects"
  - "show projects"
  - "managed projects"
---

# OPS - Cross-Project Command Center

Answer the operator's real cross-project question:

> Across all projects and machines, what is in flight, what is blocked, what needs me, and is the brain healthy?

`/ops` is the single cross-project OS surface. It replaces the retired `/dashboard`, `/projects`, and interim `/portfolio` command names by folding their useful brief/session/project views into one coherent command.

## Usage

```bash
/ops
/ops active
/ops archived
```

## Arguments

`$ARGUMENTS` is optional:

- Empty: show the full cross-project command center.
- `active`: limit the project roster to active projects.
- `archived`: limit the project roster to archived projects.

## Execution

### 1. Check Brain Exists

Check `~/.igris/memory/knowledge.db`. If it is missing, display:

```text
Brain not installed. Run: igris init
```

Then stop.

### 2. Brain Health

Run:

```bash
sqlite3 ~/.igris/memory/knowledge.db "PRAGMA integrity_check;"
sqlite3 ~/.igris/memory/knowledge.db "PRAGMA journal_mode;"
```

Also capture DB size:

```bash
du -k ~/.igris/memory/knowledge.db
```

### 3. Work In Flight

If the `igris-brain` MCP server is available:

- Call `igris_brief_dashboard` with no filters.
- Call `igris_instance_list` with `status='all'` when available.

If MCP is not available, use sqlite3 fallback:

```bash
sqlite3 ~/.igris/memory/knowledge.db "
  PRAGMA trusted_schema=ON;
  SELECT bs.project, bs.brief_id, bs.brief_type, bs.title, bs.status,
         bs.priority, bs.effort, bs.phase, bs.updated_at, bs.claimed_by,
         p.name as project_name
  FROM brief_status bs
  LEFT JOIN projects p ON p.slug = bs.project
  -- Folds NOTATION, not VOCABULARY (TD-340). `InProgress` / `in_progress` /
  -- `IN-PROGRESS` are the same state as `In Progress` and must appear here;
  -- `Done` / `Completed` / `Active` / `WIP` are different WORDS and must not.
  -- Same expression as the §17.2 gate — see MAINTAINING.md `brief_status.status`.
  -- The `bs.` qualifier is REQUIRED here and is the one deviation from the other
  -- copies: `projects` also has a `status` column, so a bare `status` inside this
  -- LEFT JOIN is ambiguous. Do not strip it to restore byte-identity.
  WHERE replace(replace(replace(lower(bs.status),' ',''),'-',''),'_','') IN ('inprogress','blocked')
  ORDER BY
    CASE replace(replace(replace(lower(bs.status),' ',''),'-',''),'_','')
      WHEN 'blocked' THEN 0 WHEN 'inprogress' THEN 1 ELSE 2 END,
    bs.updated_at DESC;
"
```

For active instances:

```bash
sqlite3 ~/.igris/memory/knowledge.db "
  PRAGMA trusted_schema=ON;
  SELECT id, machine_hostname, project_slug, current_brief, current_phase,
         current_task, status, lease_expires_at, state_updated_at,
         last_activity_at
  FROM instances
  ORDER BY COALESCE(state_updated_at, last_activity_at) DESC;
"
```

Treat liveness as advisory:

- Same-machine liveness belongs to `igris instance list`, which classifies `alive`, `dead`, and `dead_pid_reused` using PID/start-time metadata.
- Remote rows are coordination state, not process proof; show lease/claim state when present.
- Do not infer liveness from activity age.

### 4. Recent Sessions

If the `igris-brain` MCP server is available:

- Call `igris_session_recall` with `days=7`.

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

### 5. Project Roster

Apply the optional status filter from `$ARGUMENTS` only to this section.

```bash
sqlite3 ~/.igris/memory/knowledge.db "
  PRAGMA trusted_schema=ON;
  SELECT slug, name, path, status, archetype, tech_stack,
         registered_at, last_session_at
  FROM projects
  /* optional: WHERE status = 'active' or status = 'archived' */
  ORDER BY last_session_at DESC NULLS LAST, slug ASC;
"
```

### 6. Brain Statistics

Run the statistics that are cheap and useful for a command-center view:

```bash
sqlite3 ~/.igris/memory/knowledge.db "SELECT COUNT(*) FROM projects WHERE status='active';"
sqlite3 ~/.igris/memory/knowledge.db "SELECT COUNT(*) FROM projects WHERE status='archived';"
sqlite3 ~/.igris/memory/knowledge.db "SELECT COUNT(*) FROM learnings;"
sqlite3 ~/.igris/memory/knowledge.db "SELECT COUNT(*) FROM learnings WHERE scope='global';"
sqlite3 ~/.igris/memory/knowledge.db "SELECT COUNT(*) FROM errors;"
sqlite3 ~/.igris/memory/knowledge.db "SELECT COUNT(*) FROM errors WHERE COALESCE(solution, '') != '';"
```

Hunt cost per agent and per model (FR-267), from the brain-timed `hunt_runs` view — skip if the view does not exist yet (it arrives with the instances migration v3):

```bash
sqlite3 ~/.igris/memory/knowledge.db "
  PRAGMA trusted_schema=ON;
  SELECT agent, model_requested, COUNT(*) AS n, ROUND(AVG(duration_ms)/60000.0,1) AS avg_minutes
  FROM hunt_runs
  GROUP BY agent, model_requested
  ORDER BY agent, model_requested
  LIMIT 16;
"
```

The same role on two models is comparable row-to-row; add `WHERE project='<slug>'` to scope one project. Per-phase and per-hunt totals are GROUP BYs over the same view, never stored.

### 7. Display

Format as:

```markdown
## Igris Ops

### Needs Me
1. [Blocked or claimed work that needs operator decision]
2. [Remote/unknown leases nearing expiry]
3. [Projects with no recent session, if relevant]

### In Flight
| Project | Brief | Title | Status | Priority | Phase | Owner | Updated |
|---------|-------|-------|--------|----------|-------|-------|---------|

### Active Instances
| Instance | Machine | Project | Brief | Phase | Task | Liveness/Lease |
|----------|---------|---------|-------|-------|------|----------------|

### Recent Sessions (7 days)
| Date | Project | Brief | Phase | Summary |
|------|---------|-------|-------|---------|

### Brain Health
- Integrity: OK / issue
- Journal mode: WAL / other
- DB size: X KB
- Knowledge: X learnings (Y global), X errors (Y solved)

### Projects
| Project | Status | Archetype | Stack | Last Session | Path |
|---------|--------|-----------|-------|--------------|------|

### Recommendations
1. [Start or unblock the highest-priority blocked item]
2. [Archive or revisit stale projects]
3. [Promote recurring learnings or fix recurring errors]
```

## Output Rules

- Keep this command cross-project. For a single-project status snapshot, use `/scan`.
- Make "Needs Me" the top section even when it is empty; empty means the operator can trust there is no obvious cross-project action.
- Prefer concise tables over long prose.
- Do not show huge raw samples from dashboards; use summary counts and the top few rows.
- Treat activity timestamps as visibility metadata only, never as liveness proof.
