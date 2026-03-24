#!/usr/bin/env node
/**
 * SQLite Database Helper for Igris Brain
 *
 * Provides connection management with WAL mode, busy_timeout,
 * and trusted_schema pragmas. Uses a singleton pattern to ensure
 * a single database connection per MCP server process.
 *
 * @module db
 * @author Fifty.ai
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import type { StorageAdapter } from './engine/types.js';

/** Whether sqlite-vec extension loaded successfully */
let _vecAvailable = false;

/** Root directory for the Igris brain */
const BRAIN_DIR = path.join(os.homedir(), '.igris');

/** Path to the SQLite knowledge database */
const DB_PATH = path.join(BRAIN_DIR, 'memory', 'knowledge.db');

/** Singleton database instance */
let _db: Database.Database | null = null;

/**
 * Engine adapter bridge.
 * Once the engine calls setAdapter(), all tool modules that use getDb()
 * will get the adapter's underlying connection. Zero code changes needed
 * in tool handler functions.
 */
let _adapter: StorageAdapter | null = null;

/**
 * Load the sqlite-vec extension into a database connection.
 *
 * Returns true if successfully loaded, false otherwise.
 * Failure is non-fatal — vector search will be unavailable
 * but FTS5 search continues to work.
 *
 * @param db - The database instance to load the extension into
 * @returns Whether sqlite-vec was loaded successfully
 */
function loadSqliteVec(db: Database.Database): boolean {
  try {
    // Dynamic import resolved at build time — sqlite-vec provides a load() helper
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(db);
    console.error('[brain] sqlite-vec extension loaded successfully');
    return true;
  } catch (err) {
    console.error('[brain] sqlite-vec extension not available — vector search disabled:', err);
    return false;
  }
}

/**
 * Check whether the sqlite-vec extension is available.
 *
 * @returns true if sqlite-vec was loaded on the current connection
 */
function isVecAvailable(): boolean {
  return _vecAvailable;
}

/**
 * Run incremental schema migrations.
 *
 * Checks the current schema version and applies any pending migrations.
 * Each migration runs inside a transaction for atomicity.
 *
 * @param db - The database instance to migrate
 */
function migrateSchema(db: Database.Database): void {
  let currentVersion = 0;
  try {
    const row = db.prepare(
      'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1'
    ).get() as { version: number } | undefined;
    if (row) {
      currentVersion = row.version;
    }
  } catch {
    // schema_version table may not exist yet — treat as version 0
  }

  if (currentVersion < 1) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            tech_stack TEXT DEFAULT '',
            igris_version TEXT DEFAULT '4.0.0',
            status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'inactive')),
            registered_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_session_at TEXT,
            metadata TEXT DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS learnings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project TEXT NOT NULL,
            category TEXT NOT NULL CHECK (category IN ('pattern', 'decision', 'discovery', 'mistake', 'optimization')),
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            tags TEXT DEFAULT '',
            tech_stack TEXT DEFAULT '',
            scope TEXT DEFAULT 'local' CHECK (scope IN ('local', 'global')),
            source_brief TEXT DEFAULT '',
            confidence REAL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            access_count INTEGER DEFAULT 0,
            last_accessed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS errors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            message TEXT NOT NULL,
            solution TEXT DEFAULT '',
            context TEXT DEFAULT '',
            tech_stack TEXT DEFAULT '',
            scope TEXT DEFAULT 'local' CHECK (scope IN ('local', 'global')),
            occurrence_count INTEGER DEFAULT 1,
            first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
            resolved_at TEXT
        );

        CREATE TABLE IF NOT EXISTS agent_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project TEXT NOT NULL,
            agent TEXT NOT NULL,
            brief_id TEXT DEFAULT '',
            action TEXT NOT NULL,
            result TEXT NOT NULL CHECK (result IN ('success', 'failure', 'partial', 'blocked')),
            duration_ms INTEGER DEFAULT 0,
            retry_count INTEGER DEFAULT 0,
            metadata TEXT DEFAULT '{}',
            recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- FTS5 virtual tables
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

        -- FTS5 triggers: learnings
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

        -- FTS5 triggers: errors
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

        -- Indexes
        CREATE INDEX IF NOT EXISTS idx_learnings_project ON learnings(project);
        CREATE INDEX IF NOT EXISTS idx_learnings_scope ON learnings(scope);
        CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings(category);
        CREATE INDEX IF NOT EXISTS idx_errors_project ON errors(project);
        CREATE INDEX IF NOT EXISTS idx_errors_fingerprint ON errors(fingerprint);
        CREATE INDEX IF NOT EXISTS idx_errors_scope ON errors(scope);
        CREATE INDEX IF NOT EXISTS idx_agent_metrics_project ON agent_metrics(project);
        CREATE INDEX IF NOT EXISTS idx_agent_metrics_agent ON agent_metrics(agent);
        CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

        INSERT OR IGNORE INTO schema_version (version) VALUES (1);
      `);
    })();
    console.error('[brain] Schema migrated to version 1 (base tables + FTS5 triggers)');
  }

  if (currentVersion < 2) {
    db.transaction(() => {
      db.exec(`
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

        INSERT OR IGNORE INTO schema_version (version) VALUES (2);
      `);
    })();
    console.error('[brain] Schema migrated to version 2 (sessions + brief_status)');
  }

  if (currentVersion < 3) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_state (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            remote_url TEXT NOT NULL,
            table_name TEXT NOT NULL,
            last_push_at TEXT,
            last_pull_at TEXT,
            UNIQUE(remote_url, table_name)
        );

        INSERT OR IGNORE INTO schema_version (version) VALUES (3);
      `);
    })();
    console.error('[brain] Schema migrated to version 3 (sync_state)');
  }

  if (currentVersion < 4) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS instances (
            id TEXT PRIMARY KEY,
            machine_hostname TEXT NOT NULL,
            machine_os TEXT,
            project_slug TEXT,
            project_path TEXT,
            current_brief TEXT,
            current_phase TEXT,
            current_task TEXT,
            status TEXT DEFAULT 'active' CHECK (status IN ('active', 'idle', 'stale')),
            started_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
            metadata TEXT DEFAULT '{}'
        );

        CREATE INDEX IF NOT EXISTS idx_instances_status ON instances(status);
        CREATE INDEX IF NOT EXISTS idx_instances_project ON instances(project_slug);

        INSERT OR IGNORE INTO schema_version (version) VALUES (4);
      `);
    })();
    console.error('[brain] Schema migrated to version 4 (instances)');
  }

  if (currentVersion < 5) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          table_name TEXT NOT NULL,
          row_data TEXT NOT NULL,
          operation TEXT DEFAULT 'push' CHECK (operation IN ('push', 'pull')),
          status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'retrying', 'sent', 'failed')),
          retry_count INTEGER DEFAULT 0,
          max_retries INTEGER DEFAULT 5,
          error_message TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_retry_at TEXT,
          sent_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status);

        INSERT OR IGNORE INTO schema_version (version) VALUES (5);
      `);
    })();
    console.error('[brain] Schema migrated to version 5 (sync_queue)');
  }

  if (currentVersion < 6) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS brief_files (
          id TEXT PRIMARY KEY,
          project TEXT NOT NULL,
          brief_id TEXT NOT NULL,
          filename TEXT NOT NULL,
          content TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(project, brief_id)
        );

        CREATE INDEX IF NOT EXISTS idx_brief_files_project ON brief_files(project);

        INSERT OR IGNORE INTO schema_version (version) VALUES (6);
      `);
    })();
    console.error('[brain] Schema migrated to version 6 (brief_files)');
  }

  if (currentVersion < 7) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_files (
          id TEXT PRIMARY KEY,
          project TEXT NOT NULL,
          filename TEXT NOT NULL,
          content TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(project, filename)
        );

        CREATE INDEX IF NOT EXISTS idx_session_files_project ON session_files(project);

        INSERT OR IGNORE INTO schema_version (version) VALUES (7);
      `);
    })();
    console.error('[brain] Schema migrated to version 7 (session_files)');
  }

  if (currentVersion < 8) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS definition_files (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK (type IN ('agent', 'skill', 'rule', 'prompt')),
          name TEXT NOT NULL,
          filename TEXT NOT NULL,
          content TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          version TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(type, name)
        );

        CREATE INDEX IF NOT EXISTS idx_definition_files_type ON definition_files(type);

        INSERT OR IGNORE INTO schema_version (version) VALUES (8);
      `);
    })();
    console.error('[brain] Schema migrated to version 8 (definition_files)');
  }

  if (currentVersion < 9) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            instance_id TEXT NOT NULL,
            agent TEXT NOT NULL,
            event_type TEXT NOT NULL CHECK (event_type IN ('start', 'stop', 'error', 'retry')),
            phase TEXT,
            brief_id TEXT,
            duration_ms INTEGER DEFAULT 0,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            cache_read INTEGER DEFAULT 0,
            cache_create INTEGER DEFAULT 0,
            result TEXT,
            error_message TEXT,
            metadata TEXT DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_agent_events_instance ON agent_events(instance_id);
        CREATE INDEX IF NOT EXISTS idx_agent_events_agent ON agent_events(agent);
        CREATE INDEX IF NOT EXISTS idx_agent_events_created ON agent_events(created_at);

        INSERT OR IGNORE INTO schema_version (version) VALUES (9);
      `);
    })();
    console.error('[brain] Schema migrated to version 9 (agent_events)');
  }

  if (currentVersion < 10) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE learnings ADD COLUMN embedding BLOB;
        ALTER TABLE learnings ADD COLUMN embedding_model TEXT DEFAULT '';

        INSERT OR IGNORE INTO schema_version (version) VALUES (10);
      `);
    })();
    console.error('[brain] Schema migrated to version 10 (embedding columns)');

    // Create vec0 virtual table and cleanup trigger only if sqlite-vec is available
    if (_vecAvailable) {
      try {
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS learnings_vec USING vec0(
            embedding float[384]
          );

          CREATE TRIGGER IF NOT EXISTS learnings_vec_ad AFTER DELETE ON learnings BEGIN
            DELETE FROM learnings_vec WHERE rowid = old.id;
          END;
        `);
        console.error('[brain] Created learnings_vec virtual table and cleanup trigger');
      } catch (err) {
        console.error('[brain] Failed to create learnings_vec table:', err);
      }
    }
  }

  if (currentVersion < 11) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE errors ADD COLUMN embedding BLOB;
        ALTER TABLE errors ADD COLUMN embedding_model TEXT DEFAULT '';

        ALTER TABLE brief_status ADD COLUMN embedding BLOB;
        ALTER TABLE brief_status ADD COLUMN embedding_model TEXT DEFAULT '';

        INSERT OR IGNORE INTO schema_version (version) VALUES (11);
      `);
    })();
    console.error('[brain] Schema migrated to version 11 (embedding columns for errors + brief_status)');

    // Create vec0 virtual tables and cleanup triggers only if sqlite-vec is available
    if (_vecAvailable) {
      try {
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS errors_vec USING vec0(
            embedding float[384]
          );

          CREATE VIRTUAL TABLE IF NOT EXISTS briefs_vec USING vec0(
            embedding float[384]
          );

          CREATE TRIGGER IF NOT EXISTS errors_vec_ad AFTER DELETE ON errors BEGIN
            DELETE FROM errors_vec WHERE rowid = old.id;
          END;

          CREATE TRIGGER IF NOT EXISTS briefs_vec_ad AFTER DELETE ON brief_status BEGIN
            DELETE FROM briefs_vec WHERE rowid = old.id;
          END;
        `);
        console.error('[brain] Created errors_vec and briefs_vec virtual tables with cleanup triggers');
      } catch (err) {
        console.error('[brain] Failed to create errors_vec/briefs_vec tables:', err);
      }
    }
  }

  if (currentVersion < 12) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE projects ADD COLUMN archetype TEXT DEFAULT 'unclassified';
        CREATE INDEX IF NOT EXISTS idx_projects_archetype ON projects(archetype);

        CREATE TABLE IF NOT EXISTS registry (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('template', 'module')),
          archetype TEXT,
          framework TEXT,
          github_repo TEXT NOT NULL,
          github_path TEXT,
          github_branch TEXT DEFAULT 'main',
          description TEXT,
          install_command TEXT,
          standalone INTEGER DEFAULT 1,
          parent_template TEXT,
          tags TEXT DEFAULT '[]',
          rebrand_checklist TEXT,
          source_project TEXT,
          status TEXT DEFAULT 'available' CHECK(status IN ('available', 'deprecated', 'draft')),
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_registry_type ON registry(type);
        CREATE INDEX IF NOT EXISTS idx_registry_archetype ON registry(archetype);
        CREATE INDEX IF NOT EXISTS idx_registry_framework ON registry(framework);
        CREATE INDEX IF NOT EXISTS idx_registry_status ON registry(status);

        -- FTS5 for registry search
        CREATE VIRTUAL TABLE IF NOT EXISTS registry_fts USING fts5(
          name, description, tags, framework,
          content=registry,
          content_rowid=rowid
        );

        -- FTS5 triggers: registry
        CREATE TRIGGER IF NOT EXISTS registry_ai AFTER INSERT ON registry BEGIN
          INSERT INTO registry_fts(rowid, name, description, tags, framework)
          VALUES (new.rowid, new.name, new.description, new.tags, new.framework);
        END;

        CREATE TRIGGER IF NOT EXISTS registry_au AFTER UPDATE ON registry BEGIN
          INSERT INTO registry_fts(registry_fts, rowid, name, description, tags, framework)
          VALUES ('delete', old.rowid, old.name, old.description, old.tags, old.framework);
          INSERT INTO registry_fts(rowid, name, description, tags, framework)
          VALUES (new.rowid, new.name, new.description, new.tags, new.framework);
        END;

        CREATE TRIGGER IF NOT EXISTS registry_ad AFTER DELETE ON registry BEGIN
          INSERT INTO registry_fts(registry_fts, rowid, name, description, tags, framework)
          VALUES ('delete', old.rowid, old.name, old.description, old.tags, old.framework);
        END;

        INSERT OR IGNORE INTO schema_version (version) VALUES (12);
      `);
    })();
    console.error('[brain] Schema migrated to version 12 (archetype column + registry table + FTS5)');
  }
}

/**
 * Get the singleton database connection.
 *
 * If setAdapter() has been called by the engine, returns the adapter's
 * underlying connection — ensuring all tool modules share the same DB.
 * Otherwise falls back to legacy singleton initialization with WAL mode,
 * busy timeout, and foreign keys.
 *
 * @returns The SQLite database instance
 */
function getDb(): Database.Database {
  // Engine bridge: if adapter is set, delegate to it
  if (_adapter) {
    return _adapter.rawConnection;
  }

  // Legacy fallback (pre-engine boot or standalone usage)
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('busy_timeout = 5000');
    _db.pragma('synchronous = NORMAL');
    _db.pragma('foreign_keys = ON');
    _db.pragma('trusted_schema = OFF');

    // Load sqlite-vec extension (graceful degradation if unavailable)
    _vecAvailable = loadSqliteVec(_db);

    migrateSchema(_db);
  }
  return _db;
}

/**
 * Bridge the engine's storage adapter to the getDb() singleton.
 *
 * Once called, all tool modules that import getDb() will receive
 * the adapter's underlying better-sqlite3 connection. This ensures
 * a single shared connection across the entire server.
 *
 * @param adapter - The engine's StorageAdapter instance
 */
function setAdapter(adapter: StorageAdapter): void {
  _adapter = adapter;
  // Clear legacy singleton if it exists — adapter takes over
  if (_db) {
    // Do NOT close _db here — if something already has a reference,
    // closing it would break ongoing queries. The adapter's connection
    // is the canonical one from now on.
    _db = null;
  }
}

/**
 * Close the database connection and clear the singleton.
 */
function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export { getDb, closeDb, setAdapter, migrateSchema, loadSqliteVec, isVecAvailable, BRAIN_DIR, DB_PATH };
