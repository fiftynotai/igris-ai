---
name: projects
description: List all Igris-managed projects registered in the brain
disable-model-invocation: false
allowed-tools:
  - Bash
  - Read
triggers:
  - "list projects"
  - "show projects"
  - "managed projects"
---

# PROJECTS - List All Managed Projects

Display all projects registered in the Igris AI centralized brain.

## Usage

```
/projects
/projects active
/projects archived
```

## Arguments

`$ARGUMENTS` optional filter:
- Empty: Show all projects
- `active`: Only active projects
- `archived`: Only archived projects

## Execution

### 1. Check Brain Exists

Check if `~/.igris/memory/knowledge.db` exists. If not, display:
```
Brain not installed. Run: igris init
```

### 2. Query Projects

Run sqlite3 query against the brain:
```bash
sqlite3 ~/.igris/memory/knowledge.db "
  PRAGMA trusted_schema=ON;
  SELECT slug, name, path, status, registered_at, last_session_at
  FROM projects
  ORDER BY last_session_at DESC NULLS LAST;
"
```

If `$ARGUMENTS` contains a status filter, add WHERE clause.

### 3. Display Results

Format as markdown table:

```
## Igris Brain -- Managed Projects

| Project | Path | Status | Last Session |
|---------|------|--------|-------------|
| igris-ai | /Users/.../igris-ai | active | 2026-02-16 |
| my-app | /Users/.../my-app | active | 2026-02-15 |

Total: X projects (Y active, Z archived)
```

### 4. Show Quick Actions

```
Quick actions:
- `/portfolio` -- Cross-project dashboard
- `igris_project_status <slug>` -- Detailed project status
```
