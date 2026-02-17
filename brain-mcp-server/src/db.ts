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

/** Root directory for the Igris brain */
const BRAIN_DIR = path.join(os.homedir(), '.igris');

/** Path to the SQLite knowledge database */
const DB_PATH = path.join(BRAIN_DIR, 'memory', 'knowledge.db');

/** Singleton database instance */
let _db: Database.Database | null = null;

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
}

/**
 * Get the singleton database connection.
 * Initializes with WAL mode, busy timeout, and foreign keys on first call.
 * Runs pending schema migrations after initial connection.
 *
 * @returns The SQLite database instance
 */
function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('busy_timeout = 5000');
    _db.pragma('synchronous = NORMAL');
    _db.pragma('foreign_keys = ON');
    _db.pragma('trusted_schema = ON');
    migrateSchema(_db);
  }
  return _db;
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

export { getDb, closeDb, BRAIN_DIR, DB_PATH };
