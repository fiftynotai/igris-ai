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
// TD-328 (v22): the brief_type fold tables. Imported — never hand-copied — so
// the migration and the write boundary can never drift (the two-copies class
// that already bit CANONICAL_PHASES). `tools/brief-normalize.ts` imports
// nothing, so this edge is acyclic.
import {
  CANONICAL_BRIEF_TYPES,
  BRIEF_TYPE_ALIASES,
  BRIEF_TYPE_COMPOUND_FOLDS,
  BRIEF_ID_PREFIX_TYPES,
} from './tools/brief-normalize.js';

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
  // overlay (the FR-139 personal customization store — `igris registry`/
  // `~/.igris/registry/` at the time, renamed to `igris loadout`/
  // `~/.igris/loadout/` under FR-216) and the project registry
  // (`igris_project_*`). TD-259 freed "registry" from the lego store; the
  // reusable-assets store becomes `catalog` (table, FTS5
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

  // v20: drop the autonomous-execution (worker) substrate tables (TD-265).
  //
  // TD-265 removed the `tasks` + `coordination` brain components entirely (the
  // worker/task-queue + self-heal/auto-route autonomous-execution subsystem).
  // Their 7 tables were created by the (now-deleted) tasks-component engine
  // migrations, which are forward-only and per-component — once the component
  // is gone, its schema.ts migrations never run again, so the DROP CANNOT live
  // there (memory #53: two migration registries). It MUST live in this
  // unconditional db.ts legacy chain so it runs on existing DBs that carry the
  // tables (and is a clean no-op on fresh DBs that never had them).
  //
  // Idempotency: `DROP TABLE IF EXISTS` is a no-op on a DB without the tables.
  // Child tables are dropped before `tasks` (FK order: task_deps/task_results/
  // task_assignments reference tasks(id) ON DELETE CASCADE). Deleting the
  // engine_migrations rows lets a future re-add (if ever) re-run cleanly. The
  // orphaned `autonomous-priority-adjust` schedule row is deleted too — its
  // handler tool (igris_coordination_adjust_priorities) is gone, so the
  // schedules daemon would otherwise log a missing-tool warning on every fire.
  //
  // Gate behind v19's actual completion (re-read schema_version, L-209) so this
  // applies even on a machine where an earlier gated migration stopped the
  // module-level chain.
  let postV19Version = currentVersion;
  try {
    const row = db
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number } | undefined;
    if (row) postV19Version = row.version;
  } catch {
    // ignore — fresh DB will not get here
  }
  if (postV19Version >= 19 && postV19Version < 20) {
    const tableExists = (name: string): boolean =>
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?`,
        )
        .get(name) !== undefined;

    db.transaction(() => {
      // Child tables first (FK references to tasks(id)).
      db.exec(`DROP TABLE IF EXISTS task_deps`);
      db.exec(`DROP TABLE IF EXISTS task_assignments`);
      db.exec(`DROP TABLE IF EXISTS task_results`);
      db.exec(`DROP TABLE IF EXISTS autonomous_decisions`);
      db.exec(`DROP TABLE IF EXISTS coordination_config`);
      db.exec(`DROP TABLE IF EXISTS agent_capabilities`);
      // Parent table last.
      db.exec(`DROP TABLE IF EXISTS tasks`);

      // Drop the per-component migration ledger rows for the removed components.
      // `engine_migrations` is created by the engine storage adapter; in the
      // standalone legacy getDb() path it may not exist yet — guard accordingly.
      if (tableExists('engine_migrations')) {
        db.exec(`DELETE FROM engine_migrations WHERE component IN ('tasks','coordination')`);
      }

      // Delete the orphaned autonomous-routing schedule row (handler tool gone).
      // `schedules` is created by the schedules-component engine migration; guard
      // for DBs where it does not exist yet.
      if (tableExists('schedules')) {
        db.exec(`DELETE FROM schedules WHERE name='autonomous-priority-adjust'`);
      }

      db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (20)').run();
    })();
    console.error('[brain] Schema migrated to version 20 (TD-265 worker-subsystem table teardown)');
  }

  // TD-277: remove heartbeat vocabulary from the normal instances schema.
  // Existing local DBs created before TD-277 have `last_heartbeat_at`; rename
  // it to `last_activity_at`. Fresh DBs still pass through v4 first, so the
  // terminal schema after v21 is the clean activity column.
  let postV20Version = currentVersion;
  try {
    const row = db
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number } | undefined;
    if (row) postV20Version = row.version;
  } catch {
    // ignore — fresh DB will not get here
  }
  if (postV20Version >= 20 && postV20Version < 21) {
    const tableInfo = (name: string): Set<string> => {
      const rows = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
      return new Set(rows.map((r) => r.name));
    };

    db.transaction(() => {
      const columns = tableInfo('instances');
      if (!columns.has('last_activity_at') && columns.has('last_heartbeat_at')) {
        db.exec(`ALTER TABLE instances RENAME COLUMN last_heartbeat_at TO last_activity_at`);
      }
      db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (21)').run();
    })();
    console.error('[brain] Schema migrated to version 21 (TD-277 instance activity timestamp rename)');
  }

  // v22: brief_type vocabulary fold (TD-328).
  //
  // A one-time, idempotent DATA migration that folds the historical
  // brief_status rows to the canonical vocabulary the TD-328 write boundary now
  // enforces. `brief_type` was free text: 50 distinct non-NULL spellings plus
  // NULL for ~10 concepts. TD-238's v18 fold only ever knew TWO aliases
  // ('Tech Debt', 'Bug Fix'), and normalizeBriefType ran on WRITE only — so
  // every pre-existing row kept its spelling. Widening the map without
  // backfilling (or backfilling without widening) fixes nothing; v22 is the
  // second half.
  //
  // WHAT IT TOUCHES: `brief_status.brief_type`. NOTHING ELSE. Not content, not
  // title, not status, not phase, not claimed_by, not embedding — and
  // explicitly NOT `updated_at` (see LWW below). Same column discipline v18
  // relied on (#230).
  //
  // TD-311 CARVE-OUT (stated so a reviewer does not have to derive it): TD-311
  // forbids resolving brief-STATE contradictions by editing brief data — you do
  // not fix a status/phase/git disagreement by rewriting the brief. This
  // migration reads and writes only the TYPE vocabulary. It resolves no state
  // contradiction and creates none. It is a type-vocabulary NORMALISATION,
  // categorically outside TD-311's rule — the same carve-out v18 already used
  // when it folded priority/brief_type while leaving status alone.
  //
  // LWW: `brief_type` is in the CLI's sync column sets
  // (`cli/src/lib/brain-db.ts`), so a folded local row must NOT bump
  // `updated_at` — that would make folded rows fight an un-migrated remote
  // brain and rewrite a column v18 explicitly protects. The fold is
  // DETERMINISTIC, so once v22 has applied on both ends they converge to the
  // same value regardless of which side wins LWW. Apply v22 on the VPS brain
  // too; the D6 validator catches anything that leaks back.
  //
  // TD-338 AMENDMENT (COMMENT ONLY — no statement of this shipped migration is
  // edited; the behaviour above is untouched). Two things this paragraph said
  // or implied need correcting now that ingress normalizes:
  //   1. "Apply v22 on the VPS brain too" is now HYGIENE, not correctness. An
  //      un-migrated remote can no longer write a non-canonical spelling into
  //      us — `mergeRows` folds it on arrival, in both packages. The
  //      instruction survives because an ingress fold deliberately does not
  //      write back and no code path lets brain A migrate brain B, so it is
  //      the only way to make the remote's OWN reads clean. It is not
  //      retirable, only demotable.
  //   2. "The D6 validator catches anything that leaks back" was the whole
  //      defence, and it was never a defence — it reports, it does not prevent.
  //      The prevention is the ingress fold.
  // And the cost of NOT applying v22 on the VPS is now MEASURED rather than
  // hypothesised: 339 `brief_status` rows hold the canonical spelling here and
  // the pre-v22 spelling there, at identical timestamps, with neither side able
  // to overwrite the other (read-only census, 2026-08-03). That silent
  // content divergence at equal timestamps is the deliberate price of the
  // no-bump rule — see `core/enforcement/sync-ingress-normalization.md`.
  //
  // Three fold classes, all WHERE-guarded and all bound-param (§14 — no
  // interpolation; strictly better than v18's inline literals because the
  // values come from the single-source map rather than a hand-copied list):
  //   (A) UNCONDITIONAL alias folds — BRIEF_TYPE_ALIASES, plus a canonical
  //       case-fold so 'feature' becomes 'Feature'.
  //   (B) GATED compound folds — BRIEF_TYPE_COMPOUND_FOLDS. A compound
  //       ('Bug Fix / Compliance') encodes a second fact in a single-value
  //       field. It folds to its head type ONLY where the qualifier token
  //       already survives in the row's own title or brief_files.content, so
  //       nothing recoverable is lost. Rows failing the check stay unfolded and
  //       are reported. `Bug/Feature` has no head type and is absent from the
  //       table entirely.
  //   (C) NULL prefix inference — BRIEF_ID_PREFIX_TYPES. Decoding the mint
  //       prefix back to a type is a lossless decode of a field `/register`
  //       assigned from the very type question being asked, and it fills an
  //       ABSENCE (there is no stated value to destroy). `BR-` is deliberately
  //       absent from the table because /register maps both `bug` and `feature`
  //       to it — those rows stay NULL and are reported instead.
  //
  // Idempotency: every UPDATE is WHERE-guarded to a non-canonical source form,
  // so a second run matches zero rows; the schema_version gate also blocks
  // re-entry once 22 is recorded.
  //
  // BACKUP — AND THE DELIBERATE DIVERGENCE FROM v19: the snapshot is taken
  // OUTSIDE the transaction (VACUUM cannot run inside one), exactly like v19.
  // But v19 treats a failed snapshot as NON-FATAL because its operation (a
  // table rename) was non-destructive. **v22 IS DESTRUCTIVE** — the old
  // spelling is unrecoverable from the row itself once folded — so a failed OR
  // UNVERIFIABLE snapshot MUST ABORT the migration. We do not merely write the
  // file; we PROVE it: `PRAGMA integrity_check` must return 'ok' AND its
  // `brief_status` row count must equal the source's. On any failure v22 logs
  // and skips, leaving the DB at v21; the next boot retries. As in v19, the
  // snapshot is skipped entirely for `:memory:` / `file::memory:` DBs — there is
  // no sibling file to snapshot to, and a test DB has nothing to lose.
  //
  // Gate behind v21's actual completion (re-read schema_version, L-209) so this
  // DATA-only migration — which has NO vec dependency — applies even on a
  // vec-less machine where the v13 vec backfill stopped the chain. The
  // db-migration-v22.test.ts runs WITHOUT loading vec to prove this gate dodge.
  let postV21Version = currentVersion;
  try {
    const row = db
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number } | undefined;
    if (row) postV21Version = row.version;
  } catch {
    // ignore — fresh DB will not get here
  }
  // Precondition: `brief_status` must exist. A DB without it is a partial /
  // fixture schema, not a brain — there is nothing to fold, and recording v22
  // would falsely mark it migrated. SKIP WITHOUT RECORDING so the next boot
  // retries once the table is there (the v13 skip-then-heal precedent).
  const haveBriefStatus =
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='brief_status'`)
      .get() !== undefined;

  if (postV21Version >= 21 && postV21Version < 22 && haveBriefStatus) {
    const dbFile = db.name;
    const isFileDb =
      dbFile !== '' && dbFile !== ':memory:' && !dbFile.startsWith('file::memory:');

    // --- Backup + PROOF (abort on failure — see the divergence note above) ---
    let backupVerified = true;
    let abortReason = '';
    if (isFileDb) {
      const backupPath = `${dbFile}.pre-v22.bak`;
      const fs = requireCjs('node:fs') as typeof import('node:fs');
      try {
        if (!fs.existsSync(backupPath)) {
          // VACUUM INTO requires a literal/bound string; bind to avoid quoting.
          db.prepare('VACUUM INTO ?').run(backupPath);
          console.error(`[brain] v22 backup snapshot written: ${backupPath}`);
        }
        // PROVE the snapshot opens and is complete. A backup nobody verified is
        // not a backup — it is a hope.
        const sourceCount = (
          db.prepare('SELECT COUNT(*) AS c FROM brief_status').get() as { c: number }
        ).c;
        const bak = new Database(backupPath, { readonly: true });
        try {
          const integrity = bak.pragma('integrity_check') as Array<{
            integrity_check: string;
          }>;
          const verdict = integrity[0]?.integrity_check ?? '<none>';
          const bakCount = (
            bak.prepare('SELECT COUNT(*) AS c FROM brief_status').get() as { c: number }
          ).c;
          if (verdict !== 'ok') {
            backupVerified = false;
            abortReason = `integrity_check returned "${verdict}"`;
          } else if (bakCount !== sourceCount) {
            backupVerified = false;
            abortReason = `brief_status row count mismatch (source ${sourceCount}, backup ${bakCount})`;
          }
        } finally {
          bak.close();
        }
      } catch (err) {
        backupVerified = false;
        abortReason = err instanceof Error ? err.message : String(err);
      }
    }

    if (!backupVerified) {
      // ABORT at v21. v22 is destructive; without a proven-restorable snapshot
      // we do not fold. The next boot retries (the stale/partial .bak is left
      // in place on purpose so an operator can inspect it).
      console.error(
        `[brain] v22 ABORTED — backup snapshot unusable (${abortReason}). ` +
          'DB left at schema version 21; the fold is destructive and will not ' +
          'run without a verified backup. Resolve the snapshot and reboot.',
      );
    } else {
      const tableExists = (name: string): boolean =>
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
          .get(name) !== undefined;
      const haveBriefFiles = tableExists('brief_files');

      db.transaction(() => {
        // (A) Unconditional alias folds — the single-source map, bound params.
        const foldAlias = db.prepare(
          `UPDATE brief_status SET brief_type = ?
             WHERE brief_type IS NOT NULL AND LOWER(TRIM(brief_type)) = ?`,
        );
        for (const [alias, canonical] of Object.entries(BRIEF_TYPE_ALIASES)) {
          foldAlias.run(canonical, alias);
        }
        // (A2) Canonical case-fold — 'feature'/'  Feature ' → 'Feature'. The
        // `brief_type <> ?` guard keeps already-canonical rows untouched so the
        // statement is a genuine no-op on a second run.
        const foldCase = db.prepare(
          `UPDATE brief_status SET brief_type = ?
             WHERE brief_type IS NOT NULL
               AND LOWER(TRIM(brief_type)) = ?
               AND brief_type <> ?`,
        );
        for (const canonical of CANONICAL_BRIEF_TYPES) {
          foldCase.run(canonical, canonical.toLowerCase(), canonical);
        }

        // (B) Gated compound folds (D4). The qualifier must already survive in
        // the row's own title or content, else the row is left alone.
        const foldCompound = db.prepare(
          haveBriefFiles
            ? `UPDATE brief_status SET brief_type = ?
                 WHERE LOWER(TRIM(brief_type)) = ?
                   AND (
                     ' ' || LOWER(title) || ' ' LIKE ?
                     OR EXISTS (
                       SELECT 1 FROM brief_files bf
                        WHERE bf.project = brief_status.project
                          AND bf.brief_id = brief_status.brief_id
                          AND ' ' || LOWER(bf.content) || ' ' LIKE ?
                     )
                   )`
            : // brief_files absent (a partial/fixture schema) — title-only check.
              // Strictly more conservative: fewer rows fold, none fold wrongly.
              `UPDATE brief_status SET brief_type = ?
                 WHERE LOWER(TRIM(brief_type)) = ?
                   AND ' ' || LOWER(title) || ' ' LIKE ?`,
        );
        for (const [compound, fold] of Object.entries(BRIEF_TYPE_COMPOUND_FOLDS)) {
          for (const token of fold.tokens) {
            const pattern = `%${token}%`;
            if (haveBriefFiles) {
              foldCompound.run(fold.head, compound, pattern, pattern);
            } else {
              foldCompound.run(fold.head, compound, pattern);
            }
          }
        }

        // (C) NULL prefix inference (D5). Fills an absence; never overwrites.
        const inferFromPrefix = db.prepare(
          `UPDATE brief_status SET brief_type = ?
             WHERE brief_type IS NULL AND brief_id LIKE ?`,
        );
        for (const [prefix, type] of Object.entries(BRIEF_ID_PREFIX_TYPES)) {
          inferFromPrefix.run(type, `${prefix}-%`);
        }

        db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (22)').run();
      })();
      console.error(
        '[brain] Schema migrated to version 22 (TD-328 brief_type vocabulary fold)',
      );
    }
  }

  // -------------------------------------------------------------------------
  // v23 (FR-246): `briefs_fts` — the BM25 arm for brief search.
  // -------------------------------------------------------------------------
  //
  // WHY THIS EXISTS AT ALL. Before v23 the ONLY retrieval over briefs was
  // `briefs_vec`, and that index is much thinner than it looks:
  // `extractBriefProblem` (`tools/briefs.ts:838-851`) embeds ONLY the title plus
  // the `## Problem` section (falling back to the first 500 characters), it is
  // called at CREATE (`briefs.ts:472`) and by the backfill tool (`:1050`) and
  // NOWHERE ELSE, and the only trigger on `briefs_vec` is `briefs_vec_ad`
  // (DELETE — see `:544`). Two consequences, both measured on the operator brain
  // rather than reasoned about:
  //
  //   1. A brief's BODY is not searchable today at all. `briefs_fts` is the ONLY
  //      arm that reaches `brief_files.content`, so it is not merely the offline
  //      fallback for the vector arm — it is the only arm that can see most of a
  //      brief.
  //   2. An EDITED brief carries a STALE vector, because no update path
  //      re-embeds. The FTS index does not share that defect: its six triggers
  //      below fire on every write to either source table.
  //
  // Whether to re-embed on update is a SEPARATE brief and is deliberately NOT
  // fixed here (FR-246 operator sign-off, 2026-08-03).
  //
  // STORAGE — MEASURED, NOT ESTIMATED. On a `VACUUM INTO` snapshot of the
  // operator's brain (1,814 `brief_status` rows; 1,597 `brief_files` rows
  // totalling 6,211,271 bytes of `content`), building this index both ways and
  // re-VACUUMing gave:
  //
  //     contentful fts5(brief_id, title, content)          +11,452,416 B
  //     contentless_delete=1 (this one)                     +3,846,144 B
  //
  // A contentful fts5 keeps a second copy of every indexed byte. The reader
  // (`tools/briefs-read.ts#hybridSearchBriefs`) needs only `rowid` and `rank`
  // and hydrates every displayed column from `brief_status`, so that second copy
  // would buy nothing for 7.6 MB. Hence `content=''` + `contentless_delete=1`.
  //
  // The floor for `contentless_delete=1` is SQLite 3.43 (2023-08). Both packages
  // pin `better-sqlite3: ^11.0.0`, whose oldest member bundles 3.45.3, so the
  // declared dependency range already guarantees it; this tree measured 3.49.2.
  // If a host ever violates that floor the CREATE throws, the transaction rolls
  // back, `schema_version` is NOT advanced, and the reader reports
  // `bm25 unavailable: briefs_fts absent` — a stated degrade, not a crash.
  //
  // WHEN THIS RUNS, stated because it is easy to read the reader's `schema v23
  // not applied` message as "someone will apply it later": **this block
  // self-applies on the FIRST brain-server boot after the code lands.**
  // `getDb()` calls `migrateSchema()` on open (`db.ts` — it is the WRITE door,
  // learning 1133), so any MCP boot, any CLI path that reaches `getDb()`, and
  // the bundled-server smoke test in `copy-templates.sh` will each run it. It
  // is not gated on a verb, a flag or an operator action, and it does not wait
  // for a release. Verified in the wild during FR-246's own build: v23 applied
  // to the operator's brain at 13:38 on 2026-08-03 through exactly that path —
  // `briefs_fts` 1,815 rows against `brief_status` 1,815, `integrity_check` ok,
  // `updated_at` untouched, and a verified `.pre-v23.bak` beside it. The
  // `bm25_reason` path therefore describes a brain running OLDER CODE (or one
  // where the snapshot check aborted), not a brain waiting to be migrated.
  //
  // ONE SHARP EDGE OF CONTENTLESS FTS5, since it is invisible in the DDL:
  // inserting a rowid that is ALREADY indexed is NOT rejected (verified: no
  // UNIQUE constraint fires), it appends a second index entry for the same
  // rowid and a later MATCH can then return that rowid twice. Every trigger
  // below is therefore DELETE-then-INSERT, never a bare INSERT, and the backfill
  // runs exactly once into a table created in the same transaction.
  // `__tests__/db-migration-v23.test.ts` drives all four real writer shapes and
  // pins the resulting row count.
  //
  // WHY THE TRIGGERS USE `INSERT ... SELECT` RATHER THAN `VALUES`: the rowid is
  // `brief_status.id`, but half the content lives in `brief_files`, a different
  // table. `handleBriefCreate` writes `brief_files` FIRST and `brief_status`
  // SECOND (`briefs.ts:423-457`, one transaction), so at `brief_files`-insert
  // time the `brief_status` row may not exist yet. An `INSERT ... SELECT` whose
  // subquery matches nothing is a silent no-op — which is exactly the wanted
  // behaviour — and the `brief_status` insert that follows indexes both fields.
  // A `VALUES` form would have needed a `WHEN EXISTS` guard to do the same thing
  // less legibly.
  //
  // NO WRITER IS BYPASSED — verified by reading every one rather than assuming:
  // `briefs.ts:423`/`:437` (`ON CONFLICT DO UPDATE`), `:600`/`:615` (UPDATE),
  // `sync.ts:1595` (`ON CONFLICT DO UPDATE`) and `sync.ts#mergeRows:631-668`
  // (plain INSERT / UPDATE). None uses `INSERT OR REPLACE`, so the
  // REPLACE-skips-the-AFTER-UPDATE-trigger footgun is not on any live path.
  //
  // `updated_at` IS NEVER BUMPED by this migration. It is in the LWW sync column
  // set, and v23 issues no UPDATE against any synced table at all — it only
  // CREATEs new objects and populates them. That holds by construction, not by
  // care.
  //
  // BACKUP. v23 is ADDITIVE — it creates new objects and touches no existing
  // row, so unlike v22 nothing here is unrecoverable. The verified-snapshot +
  // ABORT shape is applied anyway, by FR-246 operator sign-off ("v23 follows
  // v22's shape exactly"), on the ground that this is still a multi-megabyte
  // structural write into the operator's live brain. Verified the same way v22
  // verifies: `PRAGMA integrity_check` must return 'ok' AND the backup's
  // `brief_status` count must equal the source's. Unverifiable ⇒ skip without
  // recording, and the next boot retries.
  //
  // Gate behind v22's actual completion (re-read `schema_version`, L-209).
  let postV22Version = currentVersion;
  try {
    const row = db
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number } | undefined;
    if (row) postV22Version = row.version;
  } catch {
    // ignore — fresh DB will not get here
  }

  // Precondition, v22's: both source tables must exist. A DB with neither is a
  // partial / fixture schema, not a brain — recording v23 against it would
  // falsely mark it migrated. SKIP WITHOUT RECORDING (the v13 skip-then-heal
  // precedent) so the next boot retries once the tables are there.
  const haveBriefSources =
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='brief_status'`)
      .get() !== undefined &&
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='brief_files'`)
      .get() !== undefined;

  if (postV22Version >= 22 && postV22Version < 23 && haveBriefSources) {
    const dbFile = db.name;
    const isFileDb =
      dbFile !== '' && dbFile !== ':memory:' && !dbFile.startsWith('file::memory:');

    let backupVerified = true;
    let abortReason = '';
    if (isFileDb) {
      const backupPath = `${dbFile}.pre-v23.bak`;
      const fs = requireCjs('node:fs') as typeof import('node:fs');
      try {
        if (!fs.existsSync(backupPath)) {
          // VACUUM INTO requires a literal/bound string; bind to avoid quoting.
          db.prepare('VACUUM INTO ?').run(backupPath);
          console.error(`[brain] v23 backup snapshot written: ${backupPath}`);
        }
        // PROVE the snapshot opens and is complete. A backup nobody verified is
        // not a backup — it is a hope.
        const sourceCount = (
          db.prepare('SELECT COUNT(*) AS c FROM brief_status').get() as { c: number }
        ).c;
        const bak = new Database(backupPath, { readonly: true });
        try {
          const integrity = bak.pragma('integrity_check') as Array<{
            integrity_check: string;
          }>;
          const verdict = integrity[0]?.integrity_check ?? '<none>';
          const bakCount = (
            bak.prepare('SELECT COUNT(*) AS c FROM brief_status').get() as { c: number }
          ).c;
          if (verdict !== 'ok') {
            backupVerified = false;
            abortReason = `integrity_check returned "${verdict}"`;
          } else if (bakCount !== sourceCount) {
            backupVerified = false;
            abortReason = `brief_status row count mismatch (source ${sourceCount}, backup ${bakCount})`;
          }
        } finally {
          bak.close();
        }
      } catch (err) {
        backupVerified = false;
        abortReason = err instanceof Error ? err.message : String(err);
      }
    }

    if (!backupVerified) {
      console.error(
        `[brain] v23 ABORTED — backup snapshot unusable (${abortReason}). ` +
          'DB left at schema version 22; briefs_fts will not be built without a ' +
          'verified backup. Resolve the snapshot and reboot.',
      );
    } else {
      try {
        db.transaction(() => {
          db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS briefs_fts USING fts5(
                brief_id, title, content,
                content='',
                contentless_delete=1
            );

            -- brief_status: the title half, and the rowid authority.
            CREATE TRIGGER IF NOT EXISTS briefs_fts_status_ai AFTER INSERT ON brief_status BEGIN
                DELETE FROM briefs_fts WHERE rowid = new.id;
                INSERT INTO briefs_fts(rowid, brief_id, title, content)
                VALUES (
                    new.id, new.brief_id, new.title,
                    COALESCE((SELECT bf.content FROM brief_files bf
                               WHERE bf.project = new.project
                                 AND bf.brief_id = new.brief_id), '')
                );
            END;

            CREATE TRIGGER IF NOT EXISTS briefs_fts_status_au AFTER UPDATE ON brief_status BEGIN
                DELETE FROM briefs_fts WHERE rowid = old.id;
                DELETE FROM briefs_fts WHERE rowid = new.id;
                INSERT INTO briefs_fts(rowid, brief_id, title, content)
                VALUES (
                    new.id, new.brief_id, new.title,
                    COALESCE((SELECT bf.content FROM brief_files bf
                               WHERE bf.project = new.project
                                 AND bf.brief_id = new.brief_id), '')
                );
            END;

            CREATE TRIGGER IF NOT EXISTS briefs_fts_status_ad AFTER DELETE ON brief_status BEGIN
                DELETE FROM briefs_fts WHERE rowid = old.id;
            END;

            -- brief_files: the content half. The rowid is resolved by subquery
            -- against brief_status; when that yields nothing the statement is a
            -- no-op (see the header note on write ORDER).
            CREATE TRIGGER IF NOT EXISTS briefs_fts_files_ai AFTER INSERT ON brief_files BEGIN
                DELETE FROM briefs_fts WHERE rowid IN (
                    SELECT id FROM brief_status
                     WHERE project = new.project AND brief_id = new.brief_id);
                INSERT INTO briefs_fts(rowid, brief_id, title, content)
                SELECT bs.id, bs.brief_id, bs.title, new.content
                  FROM brief_status bs
                 WHERE bs.project = new.project AND bs.brief_id = new.brief_id;
            END;

            -- The UPDATE trigger re-indexes BOTH keys because a re-key
            -- (project/brief_id changing) would otherwise strand the old brief's
            -- title. No live writer re-keys, but the cost is two extra
            -- statements and the alternative is a silent stale row.
            CREATE TRIGGER IF NOT EXISTS briefs_fts_files_au AFTER UPDATE ON brief_files BEGIN
                DELETE FROM briefs_fts WHERE rowid IN (
                    SELECT id FROM brief_status
                     WHERE project = old.project AND brief_id = old.brief_id);
                DELETE FROM briefs_fts WHERE rowid IN (
                    SELECT id FROM brief_status
                     WHERE project = new.project AND brief_id = new.brief_id);
                INSERT INTO briefs_fts(rowid, brief_id, title, content)
                SELECT bs.id, bs.brief_id, bs.title, ''
                  FROM brief_status bs
                 WHERE bs.project = old.project AND bs.brief_id = old.brief_id
                   AND NOT (bs.project = new.project AND bs.brief_id = new.brief_id);
                INSERT INTO briefs_fts(rowid, brief_id, title, content)
                SELECT bs.id, bs.brief_id, bs.title, new.content
                  FROM brief_status bs
                 WHERE bs.project = new.project AND bs.brief_id = new.brief_id;
            END;

            -- A deleted file leaves the brief itself alive, so the brief stays
            -- indexed by TITLE with empty content rather than disappearing from
            -- search entirely.
            CREATE TRIGGER IF NOT EXISTS briefs_fts_files_ad AFTER DELETE ON brief_files BEGIN
                DELETE FROM briefs_fts WHERE rowid IN (
                    SELECT id FROM brief_status
                     WHERE project = old.project AND brief_id = old.brief_id);
                INSERT INTO briefs_fts(rowid, brief_id, title, content)
                SELECT bs.id, bs.brief_id, bs.title, ''
                  FROM brief_status bs
                 WHERE bs.project = old.project AND bs.brief_id = old.brief_id;
            END;
          `);

          // Backfill. One statement is enough: the JOIN is on `brief_files`'s
          // own UNIQUE(project, brief_id) index (verified: zero duplicate keys
          // on the operator brain), so it emits exactly one row per
          // `brief_status` row — 1,814 rows / ~6.2 MB of text measured at ~2 s.
          // The `NOT EXISTS` guard makes it re-runnable even though the table it
          // fills was created three statements ago.
          db.exec(`
            INSERT INTO briefs_fts(rowid, brief_id, title, content)
            SELECT bs.id, bs.brief_id, bs.title, COALESCE(bf.content, '')
              FROM brief_status bs
              LEFT JOIN brief_files bf
                     ON bf.project = bs.project AND bf.brief_id = bs.brief_id
             WHERE NOT EXISTS (
                    SELECT 1 FROM briefs_fts WHERE briefs_fts.rowid = bs.id);
          `);

          db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (23)').run();
        })();
        console.error(
          '[brain] Schema migrated to version 23 (FR-246 briefs_fts BM25 arm)',
        );
      } catch (err) {
        // Degrade, never throw: the whole brain must still boot without brief
        // search. `schema_version` stays at 22 and the next boot retries.
        console.error(
          '[brain] v23 SKIPPED — briefs_fts could not be created ' +
            `(${err instanceof Error ? err.message : String(err)}). ` +
            'schema_version NOT advanced; brief search will report bm25 ' +
            'unavailable until this succeeds.',
        );
      }
    }
  }

  // v24: priority vocabulary re-fold (TD-338).
  //
  // WHAT IT TOUCHES: `brief_status.priority`. NOTHING ELSE. Not brief_type, not
  // title, not status, not phase, not claimed_by, not embedding — and
  // explicitly NOT `updated_at` (see LWW below). Same column discipline v18 and
  // v22 relied on (#230).
  //
  // WHY A SECOND PRIORITY FOLD AFTER v18 ALREADY RAN ONE — and the provenance
  // CORRECTED, because the obvious story is wrong:
  //   v18 (2026-06-22 19:15:33 on the operator brain) folded every bare `P1`/
  //   `P2` that existed at that moment. Eight non-canonical rows nevertheless
  //   carry `updated_at` values AFTER it. The natural hypothesis — and the one
  //   TD-338's plan proposed — was that the 2026-06-24 cutover from the old
  //   cleartext-IP remote to `https://brain.fifty.dev` created a FRESH `sync_state` cursor
  //   row (the key is `(remote_url, table_name)`), so the first pull from the
  //   new URL ran with `since=1970` and re-pulled the un-migrated VPS's whole
  //   `brief_status` back into an already-v18 brain.
  //
  //   THAT HYPOTHESIS IS REFUTED. Read-only forensics on the live brain:
  //     - `sync_state` shows the http remote's `brief_status` pull cursor last
  //       advanced 2026-06-22 19:17:20 — MORE THAN TWELVE HOURS BEFORE the earliest
  //       dirty row's `updated_at` (2026-06-23 08:02:02). A pull only advances
  //       that cursor when it DELIVERS rows for the table, and both ingress
  //       doors share the key, so no pull delivered these rows.
  //     - `sync_queue` id 4788 records a PUSH queued 2026-06-23 08:12:35
  //       carrying `moca-ai-agent/BR-045 priority:"P1"` with its own
  //       `updated_at:"2026-06-23 08:02:02"` — the local row was already dirty
  //       ten minutes after it was written, and we EXPORTED it.
  //     - the VPS today holds `P1-High`/`P2-Medium` for five of those rows (it
  //       booted a build carrying v18 and folded its own copies) while WE still
  //       hold the bare forms. The remote is CLEANER than us here.
  //   So these rows were BORN LOCALLY through a writer that did not normalize,
  //   and travelled OUT. Sync is not how they arrived. TD-338's ingress fold is
  //   therefore a PREVENTION (an un-migrated remote can no longer write a
  //   spelling into us on any future cursor reset or remote-side edit), not the
  //   cure for these eight rows. This migration is the cure, and it is purely
  //   local.
  //
  // WHY THIS IS SAFE TO RUN AFTER THE INGRESS FOLD LANDS, AND ONLY THEN:
  //   folding rows before closing ingress would let the next pull undo the work.
  //   With `mergeRows` normalizing (TD-338), a re-pull of these keys either
  //   skips (equal timestamps — the live case for all eight) or arrives folded.
  //
  // LWW — NO `updated_at` BUMP. `priority` is in both packages' sync column sets
  // (`sync.ts` SYNC_TABLES, `cli/src/lib/brain-db.ts` BOOT_SYNC_PULL_TABLES), so
  // a folded local row must NOT bump the LWW comparison column: that would
  // manufacture a write no operator made and mutate a column the dashboard,
  // `briefStatusSummary` and velocity ordering all read. The consequence is
  // stated plainly rather than hidden: after this migration our stored value
  // differs from the VPS's for the two rows the VPS still holds bare
  // (igris-ai TD-277 / TD-278), at EQUAL timestamps, and neither side will ever
  // push it to the other. That silent content divergence is the deliberate
  // price of keeping LWW honest, and it already exists at scale — 339 rows
  // diverge this way from the v22 brief_type fold. See the v22 comment above.
  //
  // `P4-Trivial` IS DELIBERATELY NOT TOUCHED. No fold table says
  // `Trivial` = `Low`, so folding it would be INVENTING (the same reasoning
  // TD-328 used to refuse folding `Spike`/`Investigation`), and adopting it as a
  // fifth canonical priority would trigger the FR-247 dashboard-picker mirror
  // sweep (MAINTAINING row 66) for one row of unknown provenance. It stays,
  // and `scripts/validate_brief_priority_vocabulary.sh` names it on every
  // pre-commit until a human retypes the brief through `igris_brief_update`.
  //
  // NO BACKUP SNAPSHOT — and this is a DECISION, not an oversight. v22 and v23
  // take a verified `VACUUM INTO` snapshot because v22 is DESTRUCTIVE (the old
  // brief_type spelling is unrecoverable from the row) and v23 is a
  // multi-megabyte structural write. v24 is neither: it runs the SAME
  // WHERE-guarded statements v18 already ran on this table, against SEVEN rows,
  // and every fold is meaning-preserving by the declaration of PRIORITY_ALIASES
  // (`P1` IS `P1-High`). There is nothing unrecoverable to snapshot.
  //
  // Idempotency: every UPDATE is WHERE-guarded to a non-canonical source form,
  // so a second run matches zero rows; the schema_version gate also blocks
  // re-entry once 24 is recorded. All values are fixed literals (§14 — no
  // interpolation).
  //
  // Gate behind v23's actual completion (re-read `schema_version`, L-209) so
  // this DATA-only migration — which has NO vec and NO FTS dependency — applies
  // even on a machine where an earlier structural step stopped the chain. The
  // db-migration-v24.test.ts runs WITHOUT loading vec to prove this gate dodge.
  let postV23Version = currentVersion;
  try {
    const row = db
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number } | undefined;
    if (row) postV23Version = row.version;
  } catch {
    // ignore — fresh DB will not get here
  }

  // Precondition, v22's: `brief_status` must exist. A DB without it is a partial
  // / fixture schema, not a brain — recording v24 against it would falsely mark
  // it migrated. SKIP WITHOUT RECORDING (the v13 skip-then-heal precedent) so
  // the next boot retries once the table is there.
  const haveBriefStatusV24 =
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='brief_status'`)
      .get() !== undefined;

  if (postV23Version >= 23 && postV23Version < 24 && haveBriefStatusV24) {
    try {
      db.transaction(() => {
        // The v18 statement set, verbatim. P0/P3 are included for symmetry even
        // though they match zero rows on the operator brain today — this is the
        // same total function `normalizePriority` applies, not a hand-picked
        // subset, so a bare `P0` minted tomorrow by an un-normalized writer is
        // folded by the same code rather than needing a v25.
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
        // Unset family -> NULL. Narrower than v18's version on purpose: v18
        // used `TRIM(COALESCE(priority,'')) = ''`, which also re-writes every
        // already-NULL row (a no-op write that still reports `changes`). This
        // form touches ONLY rows that are actually non-NULL and blank, so a
        // re-run is genuinely zero-changes.
        db.prepare(
          `UPDATE brief_status SET priority = NULL
             WHERE priority = 'Unset'
                OR (priority IS NOT NULL AND TRIM(priority) = '')`,
        ).run();

        db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (24)').run();
      })();
      console.error(
        '[brain] Schema migrated to version 24 (TD-338 priority vocabulary re-fold)',
      );
    } catch (err) {
      // Degrade, never throw: the whole brain must still boot. `schema_version`
      // stays at 23 and the next boot retries.
      console.error(
        '[brain] v24 SKIPPED — priority re-fold failed ' +
          `(${err instanceof Error ? err.message : String(err)}). ` +
          'schema_version NOT advanced; the priority validator will keep ' +
          'reporting the non-canonical rows until this succeeds.',
      );
    }
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
