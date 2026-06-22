#!/usr/bin/env node
/**
 * SQLite Database Helper for Igris Brain
 *
 * Provides connection management with WAL mode, busy_timeout,
 * and trusted_schema pragmas. Uses a singleton pattern to ensure
 * a single database connection per MCP server process.
 *
 * @module db
 * @author fifty.dev
 */

import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import type { StorageAdapter } from './engine/types.js';

/**
 * CommonJS require shim. The package is ESM (`"type": "module"`),
 * so a bare `require()` throws `ReferenceError: require is not defined`.
 * `sqlite-vec` ships both CJS and ESM entries; createRequire keeps
 * `loadSqliteVec` synchronous (callers expect a sync boolean).
 */
const requireCjs = createRequire(import.meta.url);

/** Whether sqlite-vec extension loaded successfully */
let _vecAvailable = false;

/** Root directory for the Igris brain */
const BRAIN_DIR = path.join(os.homedir(), '.igris');

/** Default path to the SQLite knowledge database. */
const DEFAULT_DB_PATH = path.join(BRAIN_DIR, 'memory', 'knowledge.db');

/**
 * Resolve the active DB path. Honors `IGRIS_DB_PATH` env var (if set and
 * non-empty) so test harnesses and CLI scripts (e.g. backfill_brief_edges
 * with `--db /tmp/sandbox.db`) can sandbox writes without touching the
 * production brain DB. Falls back to the default `~/.igris/memory/knowledge.db`.
 *
 * Resolved at call time, not module load time, so a script can set the
 * env var before its first `getDb()` call.
 */
function resolveDbPath(): string {
  const override = process.env.IGRIS_DB_PATH;
  if (override && override.length > 0) return override;
  return DEFAULT_DB_PATH;
}

/**
 * Path to the SQLite knowledge database.
 *
 * Kept as a const for backwards compatibility with existing imports
 * (src/index.ts uses it for startup banner + size reporting). The
 * env-var override is honored by `getDb()` at runtime, not by this
 * constant — callers that read DB_PATH at module load time will get
 * the default path. That's acceptable because the override is only
 * meant for CLI/test sandboxing, where the importer (the script) is
 * what holds the connection.
 */
const DB_PATH = DEFAULT_DB_PATH;

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
  if (process.env.IGRIS_DISABLE_VEC === '1') {
    console.error('[brain] sqlite-vec disabled via IGRIS_DISABLE_VEC=1');
    return false;
  }
  try {
    const sqliteVec = requireCjs('sqlite-vec') as { load: (db: Database.Database) => void };
    sqliteVec.load(db);
    // Smoke check — confirms the native binary actually loaded.
    const row = db.prepare('SELECT vec_version() AS v').get() as { v: string };
    console.error(`[brain] sqlite-vec extension loaded successfully (vec_version=${row.v})`);
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

  if (currentVersion < 13) {
    // TD-050: Backfill missing vec0 virtual tables + AFTER DELETE triggers.
    //
    // Background: TD-048 fixed the sqlite-vec ESM loader. Before that fix,
    // migrations v10/v11 ran with `_vecAvailable=false` (loader threw silently),
    // so the gated `if (_vecAvailable)` blocks did nothing — but v10/v11 still
    // recorded their version rows. Result on the live brain DB:
    // schema_version=12, but `learnings_vec`, `errors_vec`, `briefs_vec` and
    // their `*_vec_ad` triggers are missing.
    //
    // v13 creates the 3 vec tables + triggers idempotently and backfills any
    // existing BLOB embeddings stored in `learnings.embedding`,
    // `errors.embedding`, `brief_status.embedding`.
    //
    // Self-healing skip: when vec is NOT available on the connection, we do
    // NOT record version 13 in `schema_version`. This means the next boot
    // (after vec becomes available) will retry. This deliberately avoids
    // repeating the v10/v11 bug pattern where skipping while still recording
    // permanently masked the missing tables.
    //
    // We probe the connection directly (not the module-level `_vecAvailable`)
    // because `migrateSchema` can run via two paths:
    //   1. `getDb()` legacy fallback — sets `_vecAvailable` correctly.
    //   2. `bootEngine()` — loads vec via the adapter but does NOT update
    //      `_vecAvailable` (it stays false). The connection itself has vec
    //      loaded; only the module flag is stale. Probing the connection is
    //      the source of truth.
    let vecOnConnection = false;
    try {
      db.prepare('SELECT vec_version()').get();
      vecOnConnection = true;
    } catch {
      vecOnConnection = false;
    }

    if (!vecOnConnection) {
      console.error(
        '[brain] migration v13 skipped — sqlite-vec not loaded on connection. schema_version NOT advanced; will retry next boot.',
      );
    } else {
      db.transaction(() => {
        // Idempotent DDL — safe whether tables/triggers already exist or not.
        // Mirrors v10/v11 SQL exactly so a fresh DB and a healed DB converge
        // to the same schema.
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS learnings_vec USING vec0(
            embedding float[384]
          );

          CREATE VIRTUAL TABLE IF NOT EXISTS errors_vec USING vec0(
            embedding float[384]
          );

          CREATE VIRTUAL TABLE IF NOT EXISTS briefs_vec USING vec0(
            embedding float[384]
          );

          CREATE TRIGGER IF NOT EXISTS learnings_vec_ad AFTER DELETE ON learnings BEGIN
            DELETE FROM learnings_vec WHERE rowid = old.id;
          END;

          CREATE TRIGGER IF NOT EXISTS errors_vec_ad AFTER DELETE ON errors BEGIN
            DELETE FROM errors_vec WHERE rowid = old.id;
          END;

          CREATE TRIGGER IF NOT EXISTS briefs_vec_ad AFTER DELETE ON brief_status BEGIN
            DELETE FROM briefs_vec WHERE rowid = old.id;
          END;
        `);

        // Backfill: copy existing BLOB embeddings into the vec0 tables.
        // - INSERT OR IGNORE → safe to re-run if a developer already populated
        //   some rows manually.
        // - Per-row try/catch → one corrupt embedding doesn't abort the
        //   migration; it gets logged and skipped.
        // - 384 floats * 4 bytes = 1536-byte length check catches dimension
        //   drift before sqlite-vec throws an opaque internal error.
        const EXPECTED_BYTES = 384 * 4;
        const sources: Array<{ src: string; vec: string }> = [
          { src: 'learnings', vec: 'learnings_vec' },
          { src: 'errors', vec: 'errors_vec' },
          { src: 'brief_status', vec: 'briefs_vec' },
        ];

        for (const { src, vec } of sources) {
          const rows = db.prepare(
            `SELECT id, embedding FROM ${src} WHERE embedding IS NOT NULL`,
          ).all() as Array<{ id: number; embedding: Buffer | Uint8Array | null }>;

          const insert = db.prepare(
            `INSERT OR IGNORE INTO ${vec}(rowid, embedding) VALUES (?, ?)`,
          );

          let ok = 0;
          let skipped = 0;
          for (const r of rows) {
            try {
              if (!r.embedding || (r.embedding as Buffer).length !== EXPECTED_BYTES) {
                skipped++;
                continue;
              }
              // sqlite-vec's vec0 virtual table requires the rowid to be
              // bound as a BigInt — a plain JS number raises "Only integers
              // are allows for primary key values" even when the value IS an
              // integer. BigInt(r.id) is safe up to Number.MAX_SAFE_INTEGER
              // (9.0e15), well above any realistic id range.
              insert.run(BigInt(r.id), r.embedding);
              ok++;
            } catch (err) {
              skipped++;
              console.error(
                `[brain] v13 backfill skip ${src}#${r.id}:`,
                err instanceof Error ? err.message : err,
              );
            }
          }
          console.error(
            `[brain] v13 backfilled ${vec}: ${ok} ok, ${skipped} skipped (of ${rows.length})`,
          );
        }

        db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (13)').run();
      })();
      console.error('[brain] Schema migrated to version 13 (vec0 backfill + triggers)');
    }
  }

  // v14: provenance tag on learnings (FR-107)
  // Adds an optional `provenance` column to the learnings table that records
  // how/why a learning was acquired. Default 'observed' backfills existing rows
  // in O(1) via SQLite's ALTER TABLE DEFAULT clause.
  // Vocabulary intentionally diverges from edges.provenance — see
  // docs/architecture/provenance.md.
  //
  // Gate v14 behind v13's actual completion (re-read schema_version) so that
  // a vec-unavailable boot — which deliberately skips v13 without recording —
  // also defers v14 instead of leap-frogging the missing v13.
  let postV13Version = currentVersion;
  try {
    const row = db
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number } | undefined;
    if (row) postV13Version = row.version;
  } catch {
    // table may not exist on a fresh empty DB, but if we got here v1+ ran.
  }
  if (postV13Version >= 13 && postV13Version < 14) {
    db.transaction(() => {
      // Defensive: detect the column on partially-applied migrations so a re-run
      // of an older DB that already has the column doesn't fail.
      const cols = db.prepare(`PRAGMA table_info(learnings)`).all() as Array<{ name: string }>;
      const hasProvenance = cols.some((c) => c.name === 'provenance');
      if (!hasProvenance) {
        db.exec(`
          ALTER TABLE learnings ADD COLUMN provenance TEXT NOT NULL DEFAULT 'observed'
            CHECK(provenance IN ('observed','inferred','synthesized','ambiguous','human_asserted'))
        `);
      }
      db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (14)').run();
    })();
    console.error('[brain] Schema migrated to version 14 (learnings.provenance)');
  }

  // v15: review_status + source_extractor on learnings (FR-109 perception channel)
  // Adds two columns:
  //   1. `review_status` — gates conscious-channel visibility
  //      (`igris_memory_recall`, `_search`, etc.). Default 'approved' backfills
  //      existing rows so the migration is a no-op for the conscious channel:
  //      every pre-FR-109 row stays visible.
  //   2. `source_extractor` — records which extractor produced the row
  //      (`rule:learned_marker`, `rule:retry_chain`, `rule:blocker_resolution`,
  //      `rule:error_fingerprint`, `llm`, or `manual` for direct memory_store
  //      calls). Persisted on the row (not buried in evidence JSON) so /awaken
  //      4.9 can render terse `[rule:learned_marker, conf 0.85]` labels without
  //      a JSON parse on every row. Default 'manual' covers existing rows
  //      created via `igris_memory_store` directly.
  //
  // Why no CHECK constraint via ALTER TABLE: SQLite cannot add a CHECK
  // constraint via ALTER TABLE without rewriting the table. Mirroring v14's
  // strategy (constraint at handler layer + index for fast filtering) keeps
  // the migration O(1).
  //
  // Vocabulary for review_status: `'pending_review' | 'approved'`. A future
  // status like `'rejected'` is unnecessary because perception-channel
  // rejection is a hard DELETE — no soft-delete row needed.
  let postV14Version = postV13Version;
  try {
    const row = db
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number } | undefined;
    if (row) postV14Version = row.version;
  } catch {
    // ignore — fresh DB will not get here
  }
  if (postV14Version >= 14 && postV14Version < 15) {
    db.transaction(() => {
      // Defensive PRAGMA check: tolerate partial migrations / hot reloads where
      // one column landed but the other did not. Mirror v14's pattern.
      const cols = db.prepare(`PRAGMA table_info(learnings)`).all() as Array<{ name: string }>;
      const hasReviewStatus = cols.some((c) => c.name === 'review_status');
      if (!hasReviewStatus) {
        db.exec(`
          ALTER TABLE learnings ADD COLUMN review_status TEXT NOT NULL DEFAULT 'approved'
        `);
      }
      const hasSourceExtractor = cols.some((c) => c.name === 'source_extractor');
      if (!hasSourceExtractor) {
        db.exec(`
          ALTER TABLE learnings ADD COLUMN source_extractor TEXT NOT NULL DEFAULT 'manual'
        `);
      }
      // Index for the lazy-on-read filter that gates recall/search/hybrid/pattern.
      // Composite (review_status, project) means the most common filter
      // (review_status='approved' AND project=?) hits the index head.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_learnings_review_status
          ON learnings(review_status, project)
      `);
      // Index on source_extractor for /awaken's pending-review render path.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_learnings_source_extractor
          ON learnings(source_extractor)
      `);
      db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (15)').run();
    })();
    console.error(
      '[brain] Schema migrated to version 15 (learnings.review_status + source_extractor)',
    );
  }

  // v16: learnings.promoted_to_doc (FR-200 M2 — memory→doc promotion pipeline)
  //
  // Adds one nullable column recording the project-context doc (path[#anchor])
  // that a learning's standard was promoted into. NULL = not promoted (every
  // pre-FR-200 row). Set by `igris_memory_mark_promoted`; read by
  // `handleMemoryRecall` to surface a "Promoted → <doc>" pointer and stop
  // double-surfacing the now-doc-owned standard (one-fact-one-source, FR-196).
  //
  // PLACEMENT (FR-200 verification, L-142): this is a CONSCIOUS-channel column
  // — it gates the same recall path `review_status` gates and replicates via
  // SYNC_TABLES, exactly like v15's review_status. It is the closest sibling to
  // review_status of anything in the schema. The memory component owns NO
  // migrations (`memory/index.ts` schema() returns []; the TD-171 comment in
  // memory.ts is explicit that `memory/schema.ts` is intentionally absent), so
  // the established home for a conscious-channel learnings ALTER is this legacy
  // registry — exactly where v14 (provenance) and v15 (review_status +
  // source_extractor) live. Perception's `seen_again_count`/`last_seen_at` ALTERs
  // live in perception/schema.ts because they are perception-CHANNEL-specific
  // (excluded from sync); promoted_to_doc is not, so it belongs here.
  //
  // Why no CHECK constraint: SQLite's ALTER TABLE cannot add a CHECK without
  // rewriting the table; the value is a free-form doc path validated in the
  // handler. Nullable ADD COLUMN is O(1) metadata-only.
  //
  // Gate behind v15's actual completion (re-read schema_version) so a partial
  // migration that stopped before v15 does not leap-frog the missing column.
  let postV15Version = currentVersion;
  try {
    const row = db
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number } | undefined;
    if (row) postV15Version = row.version;
  } catch {
    // ignore — fresh DB will not get here
  }
  if (postV15Version >= 15 && postV15Version < 16) {
    db.transaction(() => {
      // Defensive PRAGMA check: tolerate partial migrations / hot reloads where
      // the column already landed. Mirror v15's `cols.some(...)` guard.
      const cols = db.prepare(`PRAGMA table_info(learnings)`).all() as Array<{ name: string }>;
      const hasPromotedToDoc = cols.some((c) => c.name === 'promoted_to_doc');
      if (!hasPromotedToDoc) {
        db.exec(`
          ALTER TABLE learnings ADD COLUMN promoted_to_doc TEXT
        `);
      }
      db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (16)').run();
    })();
    console.error('[brain] Schema migrated to version 16 (learnings.promoted_to_doc)');
  }

  // v17: registry asset-reference columns (FR-198 — the "lego" catalog)
  //
  // Generalizes the registry table into the reusable-assets catalog shape by
  // adding three nullable columns:
  //   - when_to_use   TEXT — "reach for this lego block when ..." (today this
  //                          is folded into `description`; a dedicated column
  //                          makes the reuse-fit queryable/renderable).
  //   - source        TEXT — where the asset lives: "pub.dev" | "github" |
  //                          "npm" | etc. fifty_flutter_kit packages live on
  //                          pub.dev, not github — `github_repo` alone could not
  //                          express that. (D-2 Option A: NO `type` CHECK widen;
  //                          `source` distinguishes pub.dev packages from repos,
  //                          so `template|module` stays expressive enough.)
  //   - source_ref    TEXT — the source-specific locator (package name, npm
  //                          spec, etc.) — generic companion to `github_repo`/
  //                          `github_path` for non-github sources.
  // All three are NULL on every pre-FR-198 row (back-compat preserved).
  //
  // PLACEMENT (FR-198 verification, L-53 / L-142): the L-142 convention is
  // "per-component migrations own ALTERs even on globally-shared tables" — BUT
  // the registry component explicitly does NOT own its migrations: its
  // `schema()` returns [] and is annotated "Migrations handled by legacy db.ts
  // migrateSchema()" (engine/components/registry/index.ts:44-47). The registry
  // TABLE itself was created here in v12. So the established home for a registry
  // ALTER is this legacy registry — exactly where v12 created the table. Putting
  // it here matches the registry's existing migration ownership.
  //
  // Why no CHECK constraint: SQLite's ALTER TABLE cannot add a CHECK without
  // rewriting the table; `source` is a free-form locator-kind validated (if at
  // all) in the handler. Nullable ADD COLUMN is O(1) metadata-only — NULL-safe
  // for all existing rows, the same pattern v14/v15/v16 used.
  //
  // The new columns are NOT added to registry_fts (R-2): FTS coverage of
  // when_to_use is a deliberate follow-on (rebuilding the FTS table + 3 triggers
  // is its own risk surface). Search still hits name/description/tags/framework.
  //
  // Gate behind v16's actual completion (re-read schema_version, L-209) so a
  // partial migration that stopped before v16 cannot leap-frog these columns.
  let postV16Version = currentVersion;
  try {
    const row = db
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number } | undefined;
    if (row) postV16Version = row.version;
  } catch {
    // ignore — fresh DB will not get here
  }
  if (postV16Version >= 16 && postV16Version < 17) {
    db.transaction(() => {
      // Defensive PRAGMA check: tolerate partial migrations / hot reloads where
      // a column already landed. Mirror v16's per-column guard.
      const cols = db.prepare(`PRAGMA table_info(registry)`).all() as Array<{ name: string }>;
      const has = (name: string): boolean => cols.some((c) => c.name === name);
      if (!has('when_to_use')) {
        db.exec(`ALTER TABLE registry ADD COLUMN when_to_use TEXT`);
      }
      if (!has('source')) {
        db.exec(`ALTER TABLE registry ADD COLUMN source TEXT`);
      }
      if (!has('source_ref')) {
        db.exec(`ALTER TABLE registry ADD COLUMN source_ref TEXT`);
      }
      db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (17)').run();
    })();
    console.error(
      '[brain] Schema migrated to version 17 (registry asset-reference columns: when_to_use, source, source_ref)',
    );
  }

  // v18: brief metadata normalization + C1 phase reconciliation (TD-238)
  //
  // A one-time, idempotent DATA migration that folds existing brief_status rows
  // to the canonical metadata form the TD-238 write boundary now enforces, and
  // applies the C1 reconciliation from the build-state invariant (#811 / TD-257).
  // It rewrites ONLY the metadata columns (priority, brief_type, phase) — NEVER
  // content, title, status, claimed_by, updated_at, or embedding (#230).
  //
  //   - Priority fold: bare/spaced legacy forms → canonical P{N}-{Word}; the
  //     "unset" family (literal 'Unset' / empty / whitespace) → NULL (the
  //     dashboard renders NULL as "Unset"; this collapses the split buckets the
  //     dashboard was double-counting — the G-05 bug TD-238 fixes).
  //   - brief_type fold: 'Tech Debt' → 'Technical Debt', 'Bug Fix' → 'Bug'.
  //     Unknown types are left untouched (read-widen — never drop operator data).
  //   - C1 reconciliation: status IN ('Done','Archived') ⇒ phase='COMPLETE'.
  //     status is the authoritative build-state source; the invariant pivots on
  //     COMPLETE. Only C1 is migrated here — C2 (Done-but-no-commit) and C3
  //     (committed-but-open) are human-disposition judgment calls left for the
  //     TD-257 read-side validator to keep WARNing (git stays out of this
  //     migration entirely).
  //
  // Idempotency: every UPDATE is WHERE-guarded to a canonical target, so a
  // second run matches zero rows. The schema_version gate also blocks re-entry
  // once v18 is recorded. All values are fixed literals (§14 — no interpolation).
  //
  // Gate behind v17's actual completion (re-read schema_version, L-209) so this
  // DATA-only migration — which has NO vec dependency — applies even on a vec-
  // less machine where the v13 vec backfill stopped the chain. The
  // db-migration-v18.test.ts runs WITHOUT loading vec to prove this gate dodge.
  let postV17Version = currentVersion;
  try {
    const row = db
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number } | undefined;
    if (row) postV17Version = row.version;
  } catch {
    // ignore — fresh DB will not get here
  }
  if (postV17Version >= 17 && postV17Version < 18) {
    db.transaction(() => {
      // Priority fold — one WHERE-guarded UPDATE per alias → canonical pair.
      db.prepare(
        `UPDATE brief_status SET priority = 'P0-Critical'
           WHERE priority IN ('P0', 'P0 - Critical')`,
      ).run();
      db.prepare(
        `UPDATE brief_status SET priority = 'P1-High'
           WHERE priority IN ('P1', 'P1 - High')`,
      ).run();
      db.prepare(
        `UPDATE brief_status SET priority = 'P2-Medium'
           WHERE priority IN ('P2', 'P2 - Medium')`,
      ).run();
      db.prepare(
        `UPDATE brief_status SET priority = 'P3-Low'
           WHERE priority IN ('P3', 'P3 - Low')`,
      ).run();
      // Unset family (literal 'Unset' / empty / whitespace-only) → NULL.
      db.prepare(
        `UPDATE brief_status SET priority = NULL
           WHERE priority = 'Unset' OR TRIM(COALESCE(priority, '')) = ''`,
      ).run();

      // brief_type fold — known aliases only; unknown types untouched.
      db.prepare(
        `UPDATE brief_status SET brief_type = 'Technical Debt'
           WHERE brief_type = 'Tech Debt'`,
      ).run();
      db.prepare(
        `UPDATE brief_status SET brief_type = 'Bug'
           WHERE brief_type = 'Bug Fix'`,
      ).run();

      // C1 reconciliation — terminal status ⇒ terminal phase. C2/C3 deferred.
      db.prepare(
        `UPDATE brief_status SET phase = 'COMPLETE'
           WHERE status IN ('Done', 'Archived')
             AND COALESCE(phase, '') != 'COMPLETE'`,
      ).run();

      db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (18)').run();
    })();
    console.error(
      '[brain] Schema migrated to version 18 (brief field normalization + C1 phase reconciliation)',
    );
  }

  // v19: rename the reusable-assets store `registry` → `catalog` (TD-259).
  //
  // The lego store was named `registry`, colliding with the personal surface
  // overlay (`igris registry …`, `~/.igris/registry/…`) and the project
  // registry (`igris_project_*`). TD-259 reclaims "registry" exclusively for the
  // surface overlay; the reusable-assets store becomes `catalog` (table, FTS5
  // virtual table, triggers, indexes — and the `igris_catalog_*` MCP tools).
  //
  // Strategy (D-3): `ALTER TABLE registry RENAME TO catalog` is an O(1)
  // metadata-only op that preserves rows, the PK, CHECK constraints, the three
  // FR-198 columns (when_to_use/source/source_ref), and rowids — no copy, no
  // rowid drift. The FTS5 external-content table + its 3 triggers hard-reference
  // the old name (`content=registry`, trigger bodies write `registry_fts`), so
  // they must be dropped + recreated against `catalog` regardless of strategy,
  // then the FTS index is REBUILT from the renamed content table so the
  // pre-existing rows stay searchable. The 4 indexes auto-follow the RENAME but
  // keep their `idx_registry_*` names — rename them too for vocabulary coherence
  // (index names are not a contract; renaming is cosmetic + idempotent).
  //
  // Backup (rollback artifact): before the transaction, snapshot the DB file via
  // `VACUUM INTO '<dbpath>.pre-v19.bak'`. VACUUM cannot run inside a transaction,
  // so it sits outside the db.transaction() block. It runs once — only when the
  // backup does not already exist AND `registry` still exists (i.e. the rename is
  // about to happen) — and only for real on-disk DBs (skipped for `:memory:`
  // test DBs, which have nothing to snapshot to a sibling file).
  //
  // Idempotency: probe-guarded (haveOld && !haveNew gates the ALTER) +
  // IF EXISTS / IF NOT EXISTS on the FTS/trigger/index DDL + the schema_version
  // gate blocks re-entry once 19 is recorded. A re-run sees catalog present and
  // registry absent → every step is a no-op.
  //
  // Gate behind v18's actual completion (re-read schema_version, L-209) so this
  // rename applies even on a vec-less machine where the v13 vec backfill stopped
  // the module-level chain. The db-migration-v19.test.ts runs WITHOUT loading
  // vec to prove this gate dodge.
  let postV18Version = currentVersion;
  try {
    const row = db
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number } | undefined;
    if (row) postV18Version = row.version;
  } catch {
    // ignore — fresh DB will not get here
  }
  if (postV18Version >= 18 && postV18Version < 19) {
    const tableExists = (name: string): boolean =>
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?`,
        )
        .get(name) !== undefined;

    const haveOldPre = tableExists('registry');
    const haveNewPre = tableExists('catalog');

    // Backup snapshot (outside the transaction — VACUUM cannot run in one).
    // Only when the rename is actually about to happen, on a real file DB.
    const dbFile = db.name;
    const isFileDb = dbFile !== '' && dbFile !== ':memory:' && !dbFile.startsWith('file::memory:');
    if (isFileDb && haveOldPre && !haveNewPre) {
      const backupPath = `${dbFile}.pre-v19.bak`;
      const fs = requireCjs('node:fs') as typeof import('node:fs');
      if (!fs.existsSync(backupPath)) {
        try {
          // VACUUM INTO requires a literal/bound string; bind to avoid quoting.
          db.prepare('VACUUM INTO ?').run(backupPath);
          console.error(`[brain] v19 backup snapshot written: ${backupPath}`);
        } catch (err) {
          // Non-fatal: the rename below is itself non-destructive (no data
          // dropped), so a failed snapshot does not block the migration.
          console.error('[brain] v19 backup snapshot failed (continuing):', err);
        }
      }
    }

    db.transaction(() => {
      const haveOld = tableExists('registry');
      const haveNew = tableExists('catalog');

      // 1. Rename the base table (carries rows, PK, CHECKs, FR-198 columns).
      if (haveOld && !haveNew) {
        db.exec(`ALTER TABLE registry RENAME TO catalog`);
      }

      // 2. Rename the 4 indexes for vocabulary coherence (idempotent).
      db.exec(`DROP INDEX IF EXISTS idx_registry_type`);
      db.exec(`DROP INDEX IF EXISTS idx_registry_archetype`);
      db.exec(`DROP INDEX IF EXISTS idx_registry_framework`);
      db.exec(`DROP INDEX IF EXISTS idx_registry_status`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_catalog_type ON catalog(type)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_catalog_archetype ON catalog(archetype)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_catalog_framework ON catalog(framework)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_catalog_status ON catalog(status)`);

      // 3. Drop the old FTS triggers + FTS table (external-content — dropping
      //    does NOT lose source rows; they live in `catalog` now).
      db.exec(`DROP TRIGGER IF EXISTS registry_ai`);
      db.exec(`DROP TRIGGER IF EXISTS registry_au`);
      db.exec(`DROP TRIGGER IF EXISTS registry_ad`);
      db.exec(`DROP TABLE IF EXISTS registry_fts`);

      // 4. Recreate the FTS5 external-content table against `catalog`.
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS catalog_fts USING fts5(
          name, description, tags, framework,
          content=catalog,
          content_rowid=rowid
        );
      `);

      // 5. Recreate the 3 FTS triggers writing into `catalog_fts`.
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS catalog_ai AFTER INSERT ON catalog BEGIN
          INSERT INTO catalog_fts(rowid, name, description, tags, framework)
          VALUES (new.rowid, new.name, new.description, new.tags, new.framework);
        END;
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS catalog_au AFTER UPDATE ON catalog BEGIN
          INSERT INTO catalog_fts(catalog_fts, rowid, name, description, tags, framework)
          VALUES ('delete', old.rowid, old.name, old.description, old.tags, old.framework);
          INSERT INTO catalog_fts(rowid, name, description, tags, framework)
          VALUES (new.rowid, new.name, new.description, new.tags, new.framework);
        END;
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS catalog_ad AFTER DELETE ON catalog BEGIN
          INSERT INTO catalog_fts(catalog_fts, rowid, name, description, tags, framework)
          VALUES ('delete', old.rowid, old.name, old.description, old.tags, old.framework);
        END;
      `);

      // 6. Rebuild the FTS index from the renamed content table so pre-existing
      //    rows remain searchable (the dropped/recreated FTS table is empty).
      db.exec(`INSERT INTO catalog_fts(catalog_fts) VALUES('rebuild')`);

      db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (19)').run();
    })();
    console.error('[brain] Schema migrated to version 19 (registry → catalog rename)');
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

  // Legacy fallback (pre-engine boot or standalone usage).
  // Resolve the path at call time so IGRIS_DB_PATH overrides set
  // *before* the first getDb() call (e.g. by backfill_brief_edges
  // CLI's --db flag) take effect. Once the singleton is created
  // it persists for the process — subsequent env var changes are
  // ignored, which is the correct semantic for a connection pool.
  if (!_db) {
    const dbPath = resolveDbPath();
    _db = new Database(dbPath);
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
