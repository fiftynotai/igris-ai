-- ~/.igris/memory/knowledge.db schema
-- SQLite WAL mode + FTS5 full-text search

-- === PRAGMAs (applied at connection time, not in schema file) ===
-- PRAGMA journal_mode = WAL;
-- PRAGMA busy_timeout = 5000;
-- PRAGMA synchronous = NORMAL;
-- PRAGMA foreign_keys = ON;
-- PRAGMA trusted_schema = ON;  -- Required for FTS5 content-sync tables (SQLite 3.31+)

-- === Schema Version ===
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO schema_version (version) VALUES (1);

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
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

-- === Sessions (v2) ===
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

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_sessions_ended_at ON sessions(ended_at);

-- === Brief Status (v2) ===
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

CREATE INDEX IF NOT EXISTS idx_brief_status_project ON brief_status(project);
CREATE INDEX IF NOT EXISTS idx_brief_status_brief_id ON brief_status(brief_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_brief_status_unique ON brief_status(project, brief_id);

-- Update schema version
INSERT OR IGNORE INTO schema_version (version) VALUES (2);
