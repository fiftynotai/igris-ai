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
