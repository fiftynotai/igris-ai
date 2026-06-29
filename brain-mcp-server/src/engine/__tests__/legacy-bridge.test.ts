/**
 * Legacy Migration Bridge Tests (BR-035)
 *
 * Verifies that:
 * 1. migrateSchema is exported from db.ts
 * 2. Engine index.ts calls migrateSchema before setAdapter
 * 3. All 5 component schemas declare version 1 migrations
 * 4. Component migration SQL is idempotent (IF NOT EXISTS) and matches legacy SQL
 * 5. Running legacy + engine migrations on the same DB does not error
 *
 * @module engine/__tests__/legacy-bridge.test
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ---------------------------------------------------------------------------
// Component imports (for schema inspection)
// ---------------------------------------------------------------------------

import { createInstancesComponent } from '../components/instances/index.js';
import { createSyncComponent } from '../components/sync/index.js';
import { createBriefsComponent } from '../components/briefs/index.js';
import { createSessionsComponent } from '../components/sessions/index.js';
import { createCacheComponent } from '../components/cache/index.js';

// ---------------------------------------------------------------------------
// Source paths for static analysis
// ---------------------------------------------------------------------------

const ENGINE_DIR = resolve(import.meta.dirname, '..');
const DB_TS_PATH = resolve(ENGINE_DIR, '..', 'db.ts');
const ENGINE_INDEX_PATH = join(ENGINE_DIR, 'index.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Legacy `brief_status` DDL — byte-equivalent to `db.ts` schema_version v2.
 * The briefs component's v2 migration (FR-127) only ALTERs this table; it
 * does not create it. Tests that run engine migrations on a bare DB must
 * pre-create it, reproducing the production boot ordering (legacy
 * migrateSchema before component migrations).
 */
const LEGACY_BRIEF_STATUS_DDL = `
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
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_brief_status_unique ON brief_status(project, brief_id);
`;

/**
 * Run legacy migrateSchema-equivalent SQL (v1-v9) on an in-memory DB.
 * This simulates what migrateSchema() does, using the actual SQL from db.ts.
 */
function runLegacyMigrations(db: Database.Database): void {
  // Minimal subset: create the 5 tables that the bridge targets
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

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

    -- brief_status is created by legacy db.ts migrateSchema() (schema_version
    -- v2). The briefs component's v2 migration (FR-127) ALTERs it, so the
    -- legacy simulation must create it for the engine migrations to apply
    -- cleanly on top — exactly the production boot ordering.
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
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_brief_status_unique ON brief_status(project, brief_id);

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
  `);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Legacy Migration Bridge (BR-035)', () => {
  // -------------------------------------------------------------------------
  // Part 1: db.ts exports migrateSchema
  // -------------------------------------------------------------------------

  describe('db.ts export', () => {
    it('should export migrateSchema in the export statement', () => {
      const source = readFileSync(DB_TS_PATH, 'utf-8');
      expect(source).toContain('export');
      // The export line should include migrateSchema
      const exportMatch = source.match(/export\s*\{([^}]+)\}/);
      expect(exportMatch).toBeTruthy();
      expect(exportMatch![1]).toContain('migrateSchema');
    });
  });

  // -------------------------------------------------------------------------
  // Part 2: engine/index.ts calls migrateSchema before setAdapter
  // -------------------------------------------------------------------------

  describe('engine/index.ts boot sequence', () => {
    it('should import migrateSchema from db.ts', () => {
      const source = readFileSync(ENGINE_INDEX_PATH, 'utf-8');
      expect(source).toMatch(/import\s*\{[^}]*migrateSchema[^}]*\}\s*from\s*['"]\.\.\/db\.js['"]/);
    });

    it('should call migrateSchema before setAdapter', () => {
      const source = readFileSync(ENGINE_INDEX_PATH, 'utf-8');
      const migratePos = source.indexOf('migrateSchema(storage.rawConnection)');
      const setAdapterPos = source.indexOf('setAdapter(storage)');
      expect(migratePos).toBeGreaterThan(-1);
      expect(setAdapterPos).toBeGreaterThan(-1);
      expect(migratePos).toBeLessThan(setAdapterPos);
    });
  });

  // -------------------------------------------------------------------------
  // Part 3: Component schema declarations
  // -------------------------------------------------------------------------

  describe('component schema declarations', () => {
    // `migrationCount` is the number of migrations the component currently
    // ships. sessions ships 2 as of FR-130 (v1 = session_files DDL, v2 =
    // instance_id + state columns); briefs ships 2 as of FR-127 (v1 =
    // brief_files DDL, v2 = claimed_by + claimed_at on brief_status); the
    // instances ships 2 as of FR-190 (v1 = agent_events DDL, v2 = instance
    // liveness columns on the legacy instances table). The TD-277 activity
    // timestamp rename is owned by legacy db.ts because the engine runs that
    // chain before component migrations. The remaining components ship a single
    // v1. The v1 migration of every component still owns
    // the primary table-creation DDL, so the sub-tests below read migrations[0].
    const componentFactories = [
      { name: 'instances', factory: createInstancesComponent, table: 'agent_events', migrationCount: 2 },
      { name: 'sync', factory: createSyncComponent, table: 'sync_queue', migrationCount: 1 },
      { name: 'briefs', factory: createBriefsComponent, table: 'brief_files', migrationCount: 2 },
      { name: 'sessions', factory: createSessionsComponent, table: 'session_files', migrationCount: 2 },
      { name: 'cache', factory: createCacheComponent, table: 'definition_files', migrationCount: 1 },
    ];

    for (const { name, factory, table, migrationCount } of componentFactories) {
      describe(`${name} component`, () => {
        it(`should return exactly ${migrationCount} migration(s), the first at version 1`, () => {
          const component = factory();
          const migrations = component.schema();
          expect(migrations).toHaveLength(migrationCount);
          expect(migrations[0].version).toBe(1);
        });

        it(`should create the ${table} table with IF NOT EXISTS`, () => {
          const component = factory();
          const migrations = component.schema();
          const sql = migrations[0].sql;
          expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
        });

        it(`should create indexes with IF NOT EXISTS`, () => {
          const component = factory();
          const migrations = component.schema();
          const sql = migrations[0].sql;
          expect(sql).toContain('CREATE INDEX IF NOT EXISTS');
        });

        it('should have a non-empty description', () => {
          const component = factory();
          const migrations = component.schema();
          expect(migrations[0].description.length).toBeGreaterThan(0);
        });
      });
    }
  });

  // -------------------------------------------------------------------------
  // Part 4: Idempotency — engine migrations on fresh DB
  // -------------------------------------------------------------------------

  describe('fresh DB (engine migrations only)', () => {
    it('should create all 5 tables without error', () => {
      const db = new Database(':memory:');
      db.pragma('journal_mode = WAL');

      // brief_status is a legacy-created table the briefs v2 migration ALTERs.
      db.exec(LEGACY_BRIEF_STATUS_DDL);

      const components = [
        createInstancesComponent(),
        createSyncComponent(),
        createBriefsComponent(),
        createSessionsComponent(),
        createCacheComponent(),
      ];

      for (const component of components) {
        for (const migration of component.schema()) {
          db.exec(migration.sql);
        }
      }

      // Verify tables exist
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all() as { name: string }[];
      const tableNames = tables.map((t) => t.name);

      expect(tableNames).toContain('agent_events');
      expect(tableNames).toContain('sync_queue');
      expect(tableNames).toContain('brief_files');
      expect(tableNames).toContain('session_files');
      expect(tableNames).toContain('definition_files');

      db.close();
    });
  });

  // -------------------------------------------------------------------------
  // Part 5: Idempotency — engine migrations AFTER legacy migrations
  // -------------------------------------------------------------------------

  describe('idempotency (legacy + engine migrations)', () => {
    it('should not error when engine migrations run after legacy migrations', () => {
      const db = new Database(':memory:');
      db.pragma('journal_mode = WAL');

      // Run legacy first
      runLegacyMigrations(db);

      // Then run engine migrations — should succeed (IF NOT EXISTS)
      const components = [
        createInstancesComponent(),
        createSyncComponent(),
        createBriefsComponent(),
        createSessionsComponent(),
        createCacheComponent(),
      ];

      expect(() => {
        for (const component of components) {
          for (const migration of component.schema()) {
            db.exec(migration.sql);
          }
        }
      }).not.toThrow();

      db.close();
    });

    it('should preserve existing data after double-migration', () => {
      const db = new Database(':memory:');
      db.pragma('journal_mode = WAL');

      // Run legacy + insert test data
      runLegacyMigrations(db);
      db.prepare(
        "INSERT INTO sync_queue (table_name, row_data) VALUES ('test', '{}')"
      ).run();
      db.prepare(
        "INSERT INTO agent_events (instance_id, agent, event_type) VALUES ('i1', 'forger', 'start')"
      ).run();

      // Run engine migrations on top
      const components = [
        createInstancesComponent(),
        createSyncComponent(),
        createBriefsComponent(),
        createSessionsComponent(),
        createCacheComponent(),
      ];

      for (const component of components) {
        for (const migration of component.schema()) {
          db.exec(migration.sql);
        }
      }

      // Verify data is still there
      const syncCount = (db.prepare('SELECT COUNT(*) as c FROM sync_queue').get() as { c: number }).c;
      const eventCount = (db.prepare('SELECT COUNT(*) as c FROM agent_events').get() as { c: number }).c;
      expect(syncCount).toBe(1);
      expect(eventCount).toBe(1);

      db.close();
    });
  });

  // -------------------------------------------------------------------------
  // Part 6: Table column verification
  // -------------------------------------------------------------------------

  describe('table column verification', () => {
    let db: Database.Database;

    function getColumns(tableName: string): string[] {
      const info = db.pragma(`table_info(${tableName})`) as { name: string }[];
      return info.map((c) => c.name);
    }

    function setup(): void {
      db = new Database(':memory:');
      db.pragma('journal_mode = WAL');
      // brief_status is a legacy-created table the briefs v2 migration ALTERs.
      db.exec(LEGACY_BRIEF_STATUS_DDL);
      const components = [
        createInstancesComponent(),
        createSyncComponent(),
        createBriefsComponent(),
        createSessionsComponent(),
        createCacheComponent(),
      ];
      for (const component of components) {
        for (const migration of component.schema()) {
          db.exec(migration.sql);
        }
      }
    }

    it('agent_events should have all expected columns', () => {
      setup();
      const cols = getColumns('agent_events');
      expect(cols).toContain('id');
      expect(cols).toContain('instance_id');
      expect(cols).toContain('agent');
      expect(cols).toContain('event_type');
      expect(cols).toContain('phase');
      expect(cols).toContain('brief_id');
      expect(cols).toContain('duration_ms');
      expect(cols).toContain('input_tokens');
      expect(cols).toContain('output_tokens');
      expect(cols).toContain('cache_read');
      expect(cols).toContain('cache_create');
      expect(cols).toContain('result');
      expect(cols).toContain('error_message');
      expect(cols).toContain('metadata');
      expect(cols).toContain('created_at');
      db.close();
    });

    it('sync_queue should have all expected columns', () => {
      setup();
      const cols = getColumns('sync_queue');
      expect(cols).toContain('id');
      expect(cols).toContain('table_name');
      expect(cols).toContain('row_data');
      expect(cols).toContain('operation');
      expect(cols).toContain('status');
      expect(cols).toContain('retry_count');
      expect(cols).toContain('max_retries');
      expect(cols).toContain('error_message');
      expect(cols).toContain('created_at');
      expect(cols).toContain('last_retry_at');
      expect(cols).toContain('sent_at');
      db.close();
    });

    it('brief_files should have all expected columns', () => {
      setup();
      const cols = getColumns('brief_files');
      expect(cols).toContain('id');
      expect(cols).toContain('project');
      expect(cols).toContain('brief_id');
      expect(cols).toContain('filename');
      expect(cols).toContain('content');
      expect(cols).toContain('content_hash');
      expect(cols).toContain('updated_at');
      db.close();
    });

    it('session_files should have all expected columns', () => {
      setup();
      const cols = getColumns('session_files');
      expect(cols).toContain('id');
      expect(cols).toContain('project');
      expect(cols).toContain('filename');
      expect(cols).toContain('content');
      expect(cols).toContain('content_hash');
      expect(cols).toContain('updated_at');
      // FR-130: per-instance keying + 3-state lifecycle columns.
      expect(cols).toContain('instance_id');
      expect(cols).toContain('state');
      db.close();
    });

    it('definition_files should have all expected columns', () => {
      setup();
      const cols = getColumns('definition_files');
      expect(cols).toContain('id');
      expect(cols).toContain('type');
      expect(cols).toContain('name');
      expect(cols).toContain('filename');
      expect(cols).toContain('content');
      expect(cols).toContain('content_hash');
      expect(cols).toContain('version');
      expect(cols).toContain('updated_at');
      db.close();
    });
  });
});
