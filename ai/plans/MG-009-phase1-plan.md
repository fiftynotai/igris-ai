# MG-009 Phase 1: Local Brain Foundation — Implementation Plan

**Brief:** MG-009 — Centralized Brain Architecture
**Phase:** 1 of 4 — Local Brain Foundation
**Effort:** XL (this phase ~L)
**Created:** 2026-02-16

---

## Overview

Phase 1 establishes the `~/.igris/` directory ("The Brain") with:
- Directory structure + config files
- SQLite knowledge.db with WAL mode + FTS5
- `igris_brain_init.sh` — one-time bootstrap script
- `igris_install.sh` — per-project symlink installer
- Global `~/.claude/CLAUDE.md` bridge file
- Self-test on igris-ai repo

---

## Implementation Steps

### Step 1: Create `scripts/igris_brain_schema.sql`

SQL file defining the complete knowledge.db schema.

```sql
-- ~/.igris/memory/knowledge.db schema
-- SQLite WAL mode + FTS5 full-text search

-- === PRAGMAs (applied at connection time, not in schema file) ===
-- PRAGMA journal_mode = WAL;
-- PRAGMA busy_timeout = 5000;
-- PRAGMA synchronous = NORMAL;
-- PRAGMA foreign_keys = ON;

-- === Schema Version ===
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO schema_version (version) VALUES (1);

-- === Projects Registry ===
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,              -- e.g., "igris-ai", "my-app"
    name TEXT NOT NULL,                     -- Display name
    path TEXT NOT NULL,                     -- Absolute path
    tech_stack TEXT DEFAULT '',             -- e.g., "bash,typescript"
    igris_version TEXT DEFAULT '4.0.0',
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'inactive')),
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_session_at TEXT,
    metadata TEXT DEFAULT '{}'              -- JSON blob for extensibility
);

-- === Learnings ===
CREATE TABLE IF NOT EXISTS learnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('pattern', 'decision', 'discovery', 'mistake', 'optimization')),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT DEFAULT '',                   -- Comma-separated
    tech_stack TEXT DEFAULT '',
    scope TEXT DEFAULT 'local' CHECK (scope IN ('local', 'global')),
    source_brief TEXT DEFAULT '',           -- e.g., "BR-008"
    confidence REAL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    access_count INTEGER DEFAULT 0,
    last_accessed_at TEXT
);

-- === Errors ===
CREATE TABLE IF NOT EXISTS errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    fingerprint TEXT NOT NULL,              -- Hash of normalized error message
    message TEXT NOT NULL,
    solution TEXT DEFAULT '',
    context TEXT DEFAULT '',                -- JSON: file, line, stack trace
    tech_stack TEXT DEFAULT '',
    scope TEXT DEFAULT 'local' CHECK (scope IN ('local', 'global')),
    occurrence_count INTEGER DEFAULT 1,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
);

-- === Agent Metrics ===
CREATE TABLE IF NOT EXISTS agent_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    agent TEXT NOT NULL,                    -- e.g., "architect", "forger"
    brief_id TEXT DEFAULT '',
    action TEXT NOT NULL,                   -- e.g., "plan", "implement", "test"
    result TEXT NOT NULL CHECK (result IN ('success', 'failure', 'partial', 'blocked')),
    duration_ms INTEGER DEFAULT 0,
    retry_count INTEGER DEFAULT 0,
    metadata TEXT DEFAULT '{}',
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- === FTS5 Virtual Tables ===
CREATE VIRTUAL TABLE IF NOT EXISTS learnings_fts USING fts5(
    title, content, tags, tech_stack,
    content=learnings,
    content_rowid=id
);

CREATE VIRTUAL TABLE IF NOT EXISTS errors_fts USING fts5(
    message, solution, context,
    content=errors,
    content_rowid=id
);

-- === FTS Sync Triggers ===
-- Learnings
CREATE TRIGGER IF NOT EXISTS learnings_ai AFTER INSERT ON learnings BEGIN
    INSERT INTO learnings_fts(rowid, title, content, tags, tech_stack)
    VALUES (new.id, new.title, new.content, new.tags, new.tech_stack);
END;

CREATE TRIGGER IF NOT EXISTS learnings_au AFTER UPDATE ON learnings BEGIN
    INSERT INTO learnings_fts(learnings_fts, rowid, title, content, tags, tech_stack)
    VALUES ('delete', old.id, old.title, old.content, old.tags, old.tech_stack);
    INSERT INTO learnings_fts(rowid, title, content, tags, tech_stack)
    VALUES (new.id, new.title, new.content, new.tags, new.tech_stack);
END;

CREATE TRIGGER IF NOT EXISTS learnings_ad AFTER DELETE ON learnings BEGIN
    INSERT INTO learnings_fts(learnings_fts, rowid, title, content, tags, tech_stack)
    VALUES ('delete', old.id, old.title, old.content, old.tags, old.tech_stack);
END;

-- Errors
CREATE TRIGGER IF NOT EXISTS errors_ai AFTER INSERT ON errors BEGIN
    INSERT INTO errors_fts(rowid, message, solution, context)
    VALUES (new.id, new.message, new.solution, new.context);
END;

CREATE TRIGGER IF NOT EXISTS errors_au AFTER UPDATE ON errors BEGIN
    INSERT INTO errors_fts(errors_fts, rowid, message, solution, context)
    VALUES ('delete', old.id, old.message, old.solution, old.context);
    INSERT INTO errors_fts(rowid, message, solution, context)
    VALUES (new.id, new.message, new.solution, new.context);
END;

CREATE TRIGGER IF NOT EXISTS errors_ad AFTER DELETE ON errors BEGIN
    INSERT INTO errors_fts(errors_fts, rowid, message, solution, context)
    VALUES ('delete', old.id, old.message, old.solution, old.context);
END;

-- === Indexes ===
CREATE INDEX IF NOT EXISTS idx_learnings_project ON learnings(project);
CREATE INDEX IF NOT EXISTS idx_learnings_scope ON learnings(scope);
CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings(category);
CREATE INDEX IF NOT EXISTS idx_errors_project ON errors(project);
CREATE INDEX IF NOT EXISTS idx_errors_fingerprint ON errors(fingerprint);
CREATE INDEX IF NOT EXISTS idx_errors_scope ON errors(scope);
CREATE INDEX IF NOT EXISTS idx_agent_metrics_project ON agent_metrics(project);
CREATE INDEX IF NOT EXISTS idx_agent_metrics_agent ON agent_metrics(agent);
CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
```

### Step 2: Create `scripts/igris_brain_init.sh`

One-time bootstrap script that creates `~/.igris/` and initializes knowledge.db.

**Logic:**
1. Check if `~/.igris/` already exists (idempotent — skip if yes, with `--force` flag to recreate)
2. Create full directory tree: `core/{prompts,agents,skills,rules,templates}`, `personas/`, `memory/`, `memory/patterns/`, `staging/`, `mcp-server/`
3. Copy core files from igris-ai repo to `~/.igris/core/`
4. Copy personas from `ai/personas/` to `~/.igris/personas/`
5. Run `sqlite3 ~/.igris/memory/knowledge.db < schema.sql`
6. Apply WAL pragmas: `sqlite3 ~/.igris/memory/knowledge.db "PRAGMA journal_mode=WAL;"`
7. Generate `~/.igris/config.json` (version, install date, features)
8. Generate `~/.igris/user_profile.json` from current `ai/persona.json` user fields
9. Print success + next steps

**Dependencies:** sqlite3 must be available (pre-installed on macOS/Linux)

### Step 3: Create `scripts/igris_install.sh`

Per-project installer that replaces `igris_init.sh` with a symlink model.

**Logic:**
1. Check `~/.igris/` exists (error if not: "Run igris_brain_init.sh first")
2. Create project-local dirs: `ai/{briefs,session/archive,context,plugins}`, `scripts/`, `.claude/{agents,hooks,skills,rules}`
3. Create symlinks:
   - `.claude/agents/` → `~/.igris/core/agents/` (individual .md files)
   - `.claude/rules/` → `~/.igris/core/rules/` (individual .md files)
   - `ai/prompts/` → `~/.igris/core/prompts/` (individual files)
   - `ai/templates/` → `~/.igris/core/templates/` (individual files)
4. Copy project-local files (NOT symlinked — unique per project):
   - `ai/session/CURRENT_SESSION.md` (fresh template)
   - `ai/session/BLOCKERS.md` (fresh template)
   - `ai/session/DECISIONS.md` (fresh template)
   - `ai/session/LEARNINGS.md` (fresh template)
   - `ai/context/README.md`
   - `CLAUDE.md` (generated from template with project-specific values)
5. Register project in brain:
   ```bash
   SLUG=$(basename "$TARGET_DIR")
   sqlite3 ~/.igris/memory/knowledge.db \
     "INSERT OR IGNORE INTO projects (slug, name, path) VALUES ('$SLUG', '$SLUG', '$TARGET_DIR');"
   ```
6. Create `.igris_version` tracking file
7. Print success

**Symlink Strategy:**
- Symlink individual files, not directories (so project can add local agents alongside shared ones)
- `.claude/skills/` stays local (skills may be project-specific)
- `ai/persona.json` stays local (different personas per project)

### Step 4: Update `scripts/igris_init.sh` (backward compat)

Wrap existing script to:
1. Check if `~/.igris/` exists
2. If yes: print deprecation notice, suggest `igris_install.sh`
3. If no: run original copy-based install (v3.4 mode)
4. No breaking change — existing behavior preserved

### Step 5: Create Global `~/.claude/CLAUDE.md`

Bridge file that tells every Claude session about the brain:

```markdown
# Igris AI — Centralized Brain

The Igris AI brain is installed at `~/.igris/`.

## What This Means

- Igris AI agents, rules, and prompts are shared across all projects
- Persistent memory stored in `~/.igris/memory/knowledge.db`
- Use Igris MCP tools (igris_memory_*, igris_project_*) for cross-project intelligence

## Available MCP Tools

(Listed when Phase 2 MCP server is built)

## Project Registration

Projects using Igris are registered in the brain. Check with:
```
sqlite3 ~/.igris/memory/knowledge.db "SELECT slug, path, status FROM projects;"
```
```

### Step 6: Create `~/.igris/config.json`

```json
{
  "version": "4.0.0",
  "installed_at": "2026-02-16T00:00:00Z",
  "features": {
    "memory": true,
    "project_registry": true,
    "symlinks": true,
    "mcp_server": false,
    "staging_pipeline": false,
    "analytics": false
  },
  "paths": {
    "brain": "~/.igris",
    "core": "~/.igris/core",
    "memory": "~/.igris/memory",
    "staging": "~/.igris/staging"
  },
  "database": {
    "path": "~/.igris/memory/knowledge.db",
    "wal_mode": true,
    "busy_timeout_ms": 5000
  }
}
```

### Step 7: Create `~/.igris/user_profile.json`

```json
{
  "name": "",
  "default_addressing": "",
  "preferences": {
    "default_mask": "half",
    "default_persona": "igris",
    "auto_register_projects": true
  },
  "created_at": "2026-02-16T00:00:00Z"
}
```

### Step 8: Self-Test on igris-ai Repo

After building, test by:
1. Run `igris_brain_init.sh` — verify `~/.igris/` created with all dirs
2. Verify `knowledge.db` exists and has WAL mode enabled
3. Verify schema tables exist (projects, learnings, errors, agent_metrics)
4. Run `igris_install.sh .` on igris-ai repo itself
5. Verify symlinks are valid and point to correct targets
6. Verify project registered in DB
7. Verify `~/.claude/CLAUDE.md` exists

---

## Files to Create

| # | File | Purpose |
|---|------|---------|
| 1 | `scripts/igris_brain_schema.sql` | Knowledge DB schema (SQLite + FTS5) |
| 2 | `scripts/igris_brain_init.sh` | One-time brain bootstrap |
| 3 | `scripts/igris_install.sh` | Per-project symlink installer |
| 4 | `scripts/templates/CLAUDE.global.md.template` | Global CLAUDE.md template |

## Files to Modify

| # | File | Change |
|---|------|--------|
| 1 | `scripts/igris_init.sh` | Add deprecation notice + backward compat wrapper |

## Files Created at Runtime (by scripts, NOT committed)

| # | File | Created By |
|---|------|------------|
| 1 | `~/.igris/config.json` | `igris_brain_init.sh` |
| 2 | `~/.igris/user_profile.json` | `igris_brain_init.sh` |
| 3 | `~/.igris/memory/knowledge.db` | `igris_brain_init.sh` |
| 4 | `~/.claude/CLAUDE.md` | `igris_brain_init.sh` |

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| sqlite3 not available | Script fails | Check at start, error with install instructions |
| `~/.igris/` already exists | Overwrite data | Idempotent by default, `--force` flag for reset |
| Symlinks break on repo move | Project can't find core files | `igris_install.sh` can re-run to fix symlinks |
| Claude Code doesn't follow symlinks | Agents/rules not loaded | Test thoroughly; fallback to copy if needed |
| FTS5 not compiled in sqlite3 | Search won't work | Check at init time; FTS5 is standard on macOS/Linux since 2017 |
| User has existing `~/.claude/CLAUDE.md` | Overwrite their config | Check first, merge or warn |

---

## Implementation Order

```
1. igris_brain_schema.sql    (no dependencies)
2. igris_brain_init.sh       (depends on: schema.sql)
3. igris_install.sh          (depends on: brain_init.sh)
4. CLAUDE.global.md.template (no dependencies)
5. igris_init.sh update      (depends on: install.sh existing)
6. Self-test                 (depends on: all above)
```

---

## Test Cases

### T1: Brain Bootstrap
```bash
./scripts/igris_brain_init.sh
# Verify: ~/.igris/ directory structure exists
# Verify: knowledge.db created with WAL mode
# Verify: config.json and user_profile.json created
# Verify: core/ directories populated
```

### T2: Schema Integrity
```bash
sqlite3 ~/.igris/memory/knowledge.db ".tables"
# Expected: agent_metrics  errors  errors_fts  learnings  learnings_fts  projects  schema_version

sqlite3 ~/.igris/memory/knowledge.db "PRAGMA journal_mode;"
# Expected: wal
```

### T3: Project Registration
```bash
./scripts/igris_install.sh /path/to/project
sqlite3 ~/.igris/memory/knowledge.db "SELECT slug, path FROM projects;"
# Expected: project slug and path present
```

### T4: Symlink Integrity
```bash
./scripts/igris_install.sh /tmp/test-project
ls -la /tmp/test-project/.claude/agents/
# Expected: symlinks pointing to ~/.igris/core/agents/*.md
```

### T5: Idempotency
```bash
./scripts/igris_brain_init.sh  # Run twice
# Expected: No errors, no data loss
./scripts/igris_install.sh .   # Run twice on same project
# Expected: No errors, symlinks re-created
```

### T6: FTS5 Search
```bash
sqlite3 ~/.igris/memory/knowledge.db "
  INSERT INTO learnings (project, category, title, content, tags)
  VALUES ('test', 'pattern', 'SQLite WAL', 'WAL mode enables concurrent reads', 'sqlite,concurrency');
  SELECT title FROM learnings_fts WHERE learnings_fts MATCH 'concurrent';
"
# Expected: "SQLite WAL"
```

### T7: Backward Compatibility
```bash
# Remove ~/.igris/ temporarily
./scripts/igris_init.sh /tmp/legacy-project
# Expected: v3.4 copy-based install works as before
```

---

**Plan Status:** Ready for approval
**Estimated Implementation:** ~4-6 hours for all Phase 1 deliverables
