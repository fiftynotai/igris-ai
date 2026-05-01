/**
 * Monitoring Component Unit Tests
 *
 * Tests the event-logging monitoring component:
 * 1. Schema tests (event_log table creation, columns, indexes)
 * 2. Handler tests (handleEventLogQuery: filters, pagination, ordering)
 * 3. Handler tests (handleEventLogCleanup: retention, defaults, clamping)
 * 4. Component tests (name, version, events, tools, schema)
 * 5. Event listener tests (insert on event, component mapping, error swallowing)
 * 6. Init behavior (retention cleanup on init)
 * 7. SYNC_TABLES (event_log entry with correct config)
 *
 * @module engine/components/monitoring/__tests__/monitoring.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createEventBus } from '../../../bus.js';
import type { EventBus, ComponentContext, ComponentLogger } from '../../../types.js';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports that use them
// ---------------------------------------------------------------------------

// Mock node:os hostname
vi.mock('node:os', () => ({
  hostname: vi.fn(() => 'test-host'),
}));

// Mock the db module
vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { getDb } from '../../../../db.js';
import { createMonitoringComponent } from '../index.js';
import { handleEventLogQuery, handleEventLogCleanup } from '../handlers.js';
import { monitoringMigrations } from '../schema.js';
import { SYNC_TABLES } from '../../../../tools/sync.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): ComponentLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeCtx(bus: EventBus): ComponentContext {
  return {
    storage: {} as ComponentContext['storage'],
    bus,
    log: makeLogger(),
    config: {},
  };
}

/**
 * Create an in-memory SQLite database with the monitoring schema applied.
 */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(monitoringMigrations[0].sql);
  return db;
}

/**
 * Insert a test event row directly.
 */
function insertEvent(
  db: Database.Database,
  overrides: Partial<{
    event_name: string;
    component: string;
    payload: string;
    machine_hostname: string;
    project_slug: string | null;
    instance_id: string | null;
    created_at: string;
  }> = {},
): void {
  const defaults = {
    event_name: 'schedule.created',
    component: 'schedules',
    payload: '{}',
    machine_hostname: 'test-host',
    project_slug: null,
    instance_id: null,
    created_at: new Date().toISOString(),
  };
  const row = { ...defaults, ...overrides };
  db.prepare(
    `INSERT INTO event_log (event_name, component, payload, machine_hostname, project_slug, instance_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.event_name,
    row.component,
    row.payload,
    row.machine_hostname,
    row.project_slug,
    row.instance_id,
    row.created_at,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Monitoring Component', () => {
  let db: Database.Database;
  let bus: EventBus;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    bus = createEventBus();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Schema Tests
  // -------------------------------------------------------------------------

  describe('schema', () => {
    it('migration creates event_log table successfully', () => {
      // Table was created in createTestDb — verify it exists
      const tableInfo = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_log'")
        .get() as { name: string } | undefined;
      expect(tableInfo).toBeDefined();
      expect(tableInfo!.name).toBe('event_log');
    });

    it('table has correct columns', () => {
      const columns = db.prepare('PRAGMA table_info(event_log)').all() as {
        name: string;
      }[];
      const columnNames = columns.map((c) => c.name);
      expect(columnNames).toEqual(
        expect.arrayContaining([
          'id',
          'event_name',
          'component',
          'payload',
          'machine_hostname',
          'project_slug',
          'instance_id',
          'created_at',
        ]),
      );
      expect(columnNames).toHaveLength(8);
    });

    it('indexes exist', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='event_log'")
        .all() as { name: string }[];
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_event_log_name');
      expect(indexNames).toContain('idx_event_log_component');
      expect(indexNames).toContain('idx_event_log_created');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Handler Tests — handleEventLogQuery
  // -------------------------------------------------------------------------

  describe('handleEventLogQuery', () => {
    it('returns all events when no filters provided', () => {
      insertEvent(db, { event_name: 'schedule.created', created_at: '2026-01-01T00:00:00.000Z' });
      insertEvent(db, { event_name: 'cache.rebuilt', created_at: '2026-01-02T00:00:00.000Z' });

      const result = handleEventLogQuery({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.events).toHaveLength(2);
      expect(parsed.total).toBe(2);
    });

    it('filters by event_name', () => {
      insertEvent(db, { event_name: 'schedule.created' });
      insertEvent(db, { event_name: 'cache.rebuilt' });

      const result = handleEventLogQuery({ event_name: 'cache.rebuilt' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.events).toHaveLength(1);
      expect(parsed.events[0].event_name).toBe('cache.rebuilt');
      expect(parsed.total).toBe(1);
    });

    it('filters by component', () => {
      insertEvent(db, { event_name: 'schedule.created', component: 'schedules' });
      insertEvent(db, { event_name: 'cache.rebuilt', component: 'cache' });

      const result = handleEventLogQuery({ component: 'cache' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.events).toHaveLength(1);
      expect(parsed.events[0].component).toBe('cache');
    });

    it('filters by project_slug', () => {
      insertEvent(db, { project_slug: 'project-a' });
      insertEvent(db, { project_slug: 'project-b' });

      const result = handleEventLogQuery({ project_slug: 'project-a' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.events).toHaveLength(1);
      expect(parsed.events[0].project_slug).toBe('project-a');
    });

    it('filters by date range (since/until)', () => {
      insertEvent(db, { created_at: '2026-01-01T00:00:00.000Z' });
      insertEvent(db, { created_at: '2026-01-15T00:00:00.000Z' });
      insertEvent(db, { created_at: '2026-02-01T00:00:00.000Z' });

      const result = handleEventLogQuery({
        since: '2026-01-10T00:00:00.000Z',
        until: '2026-01-20T00:00:00.000Z',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.events).toHaveLength(1);
      expect(parsed.events[0].created_at).toBe('2026-01-15T00:00:00.000Z');
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        insertEvent(db, { created_at: `2026-01-0${i + 1}T00:00:00.000Z` });
      }

      const result = handleEventLogQuery({ limit: 2 });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.events).toHaveLength(2);
      expect(parsed.total).toBe(5);
      expect(parsed.limit).toBe(2);
    });

    it('respects offset parameter', () => {
      for (let i = 0; i < 5; i++) {
        insertEvent(db, {
          event_name: `event.${i}`,
          created_at: `2026-01-0${i + 1}T00:00:00.000Z`,
        });
      }

      // Events ordered DESC: event.4 (Jan 5), event.3 (Jan 4), event.2 (Jan 3), event.1 (Jan 2), event.0 (Jan 1)
      const result = handleEventLogQuery({ limit: 2, offset: 2 });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.events).toHaveLength(2);
      expect(parsed.offset).toBe(2);
      // Should skip the first 2 (event.4, event.3) and return event.2, event.1
      expect(parsed.events[0].event_name).toBe('event.2');
      expect(parsed.events[1].event_name).toBe('event.1');
    });

    it('clamps limit to max 1000', () => {
      insertEvent(db);

      const result = handleEventLogQuery({ limit: 5000 });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.limit).toBe(1000);
    });

    it('defaults limit to 100', () => {
      insertEvent(db);

      const result = handleEventLogQuery({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.limit).toBe(100);
    });

    it('returns total count alongside results', () => {
      for (let i = 0; i < 10; i++) {
        insertEvent(db, { created_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` });
      }

      const result = handleEventLogQuery({ limit: 3 });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.events).toHaveLength(3);
      expect(parsed.total).toBe(10);
    });

    it('orders by created_at DESC', () => {
      insertEvent(db, { event_name: 'oldest', created_at: '2026-01-01T00:00:00.000Z' });
      insertEvent(db, { event_name: 'newest', created_at: '2026-01-03T00:00:00.000Z' });
      insertEvent(db, { event_name: 'middle', created_at: '2026-01-02T00:00:00.000Z' });

      const result = handleEventLogQuery({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.events[0].event_name).toBe('newest');
      expect(parsed.events[1].event_name).toBe('middle');
      expect(parsed.events[2].event_name).toBe('oldest');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Handler Tests — handleEventLogCleanup
  // -------------------------------------------------------------------------

  describe('handleEventLogCleanup', () => {
    it('deletes events older than specified retention_days', () => {
      // Insert an old event (60 days ago)
      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      insertEvent(db, { event_name: 'old.event', created_at: oldDate });
      // Insert a recent event
      insertEvent(db, { event_name: 'recent.event', created_at: new Date().toISOString() });

      const result = handleEventLogCleanup({ retention_days: 30 });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.deleted).toBe(1);
      expect(parsed.retention_days).toBe(30);

      // Verify only recent event remains
      const remaining = db.prepare('SELECT COUNT(*) as count FROM event_log').get() as { count: number };
      expect(remaining.count).toBe(1);
    });

    it('defaults to 30 days', () => {
      const result = handleEventLogCleanup({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.retention_days).toBe(30);
    });

    it('clamps retention_days to minimum 1', () => {
      const result = handleEventLogCleanup({ retention_days: -5 });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.retention_days).toBe(1);
    });

    it('returns correct deleted count', () => {
      // Insert 3 old events
      const oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      insertEvent(db, { event_name: 'old.1', created_at: oldDate });
      insertEvent(db, { event_name: 'old.2', created_at: oldDate });
      insertEvent(db, { event_name: 'old.3', created_at: oldDate });
      // Insert 1 recent event
      insertEvent(db, { event_name: 'recent.1', created_at: new Date().toISOString() });

      const result = handleEventLogCleanup({ retention_days: 30 });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.deleted).toBe(3);
    });

    it('does not delete events within retention period', () => {
      // Insert only recent events
      insertEvent(db, { event_name: 'recent.1', created_at: new Date().toISOString() });
      insertEvent(db, { event_name: 'recent.2', created_at: new Date().toISOString() });

      const result = handleEventLogCleanup({ retention_days: 30 });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.deleted).toBe(0);

      const remaining = db.prepare('SELECT COUNT(*) as count FROM event_log').get() as { count: number };
      expect(remaining.count).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Component Tests
  // -------------------------------------------------------------------------

  describe('component metadata', () => {
    it('component name is "monitoring"', () => {
      const comp = createMonitoringComponent();
      expect(comp.name).toBe('monitoring');
    });

    it('component version is "1.0.0"', () => {
      const comp = createMonitoringComponent();
      expect(comp.version).toBe('1.0.0');
    });

    it('events() declares 38 listened events', () => {
      // 34 base + 4 perception lifecycle events added in TD-074
      // (perception.run_started/succeeded/failed/skipped).
      const comp = createMonitoringComponent();
      const { listens } = comp.events();
      expect(listens).toHaveLength(38);
    });

    it('events() declares 0 emitted events', () => {
      const comp = createMonitoringComponent();
      const { emits } = comp.events();
      expect(emits).toHaveLength(0);
    });

    it('tools() returns 2 tools (igris_event_log, igris_event_log_cleanup)', () => {
      const comp = createMonitoringComponent();
      const tools = comp.tools();
      expect(tools).toHaveLength(2);
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('igris_event_log');
      expect(toolNames).toContain('igris_event_log_cleanup');
    });

    it('schema() returns 1 migration', () => {
      const comp = createMonitoringComponent();
      const migrations = comp.schema();
      expect(migrations).toHaveLength(1);
      expect(migrations[0].version).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Event Listener Tests
  // -------------------------------------------------------------------------

  describe('event listeners', () => {
    it('event received inserts row into event_log', () => {
      const comp = createMonitoringComponent();
      comp.init(makeCtx(bus));

      bus.emit('schedule.created', { schedule_id: 'sch-1', project: 'my-project' });

      const rows = db.prepare('SELECT * FROM event_log').all() as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0].event_name).toBe('schedule.created');

      comp.destroy();
    });

    it('correct component name derived from event', () => {
      const comp = createMonitoringComponent();
      comp.init(makeCtx(bus));

      bus.emit('schedule.created', {});
      bus.emit('cache.rebuilt', {});
      bus.emit('coordination.self_heal', {});

      const rows = db.prepare('SELECT event_name, component FROM event_log ORDER BY id').all() as {
        event_name: string;
        component: string;
      }[];

      expect(rows[0]).toEqual({ event_name: 'schedule.created', component: 'schedules' });
      expect(rows[1]).toEqual({ event_name: 'cache.rebuilt', component: 'cache' });
      expect(rows[2]).toEqual({ event_name: 'coordination.self_heal', component: 'coordination' });

      comp.destroy();
    });

    it('project_slug extracted from payload.data.project', () => {
      const comp = createMonitoringComponent();
      comp.init(makeCtx(bus));

      bus.emit('schedule.created', { project: 'igris-ai' });

      const row = db.prepare('SELECT project_slug FROM event_log').get() as { project_slug: string };
      expect(row.project_slug).toBe('igris-ai');

      comp.destroy();
    });

    it('payload stored as JSON string', () => {
      const comp = createMonitoringComponent();
      comp.init(makeCtx(bus));

      bus.emit('schedule.created', { schedule_id: 'sch-1', name: 'nightly-cleanup' });

      const row = db.prepare('SELECT payload FROM event_log').get() as { payload: string };
      const parsed = JSON.parse(row.payload);
      expect(parsed.schedule_id).toBe('sch-1');
      expect(parsed.name).toBe('nightly-cleanup');

      comp.destroy();
    });

    it('machine_hostname is set', () => {
      const comp = createMonitoringComponent();
      comp.init(makeCtx(bus));

      bus.emit('schedule.created', {});

      const row = db.prepare('SELECT machine_hostname FROM event_log').get() as { machine_hostname: string };
      expect(row.machine_hostname).toBe('test-host');

      comp.destroy();
    });

    it('task events logged with correct component name', () => {
      const comp = createMonitoringComponent();
      comp.init(makeCtx(bus));

      const taskEvents = [
        'task.created',
        'task.assigned',
        'task.completed',
        'task.blocked',
        'task.unblocked',
        'task.failed',
        'task.claimed',
      ] as const;

      for (const evt of taskEvents) {
        bus.emit(evt, { task_id: `t-${evt}` });
      }

      const rows = db.prepare('SELECT event_name, component FROM event_log ORDER BY id').all() as {
        event_name: string;
        component: string;
      }[];

      expect(rows).toHaveLength(7);
      for (const row of rows) {
        expect(row.component).toBe('tasks');
        expect(row.event_name).toMatch(/^task\./);
      }

      comp.destroy();
    });

    it('brief events logged with correct component name', () => {
      const comp = createMonitoringComponent();
      comp.init(makeCtx(bus));

      const briefEvents = [
        'brief.synced',
        'brief.created',
        'brief.completed',
      ] as const;

      for (const evt of briefEvents) {
        bus.emit(evt, { brief_id: `b-${evt}` });
      }

      const rows = db.prepare('SELECT event_name, component FROM event_log ORDER BY id').all() as {
        event_name: string;
        component: string;
      }[];

      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.component).toBe('briefs');
        expect(row.event_name).toMatch(/^brief\./);
      }

      comp.destroy();
    });

    it('session events logged with correct component name', () => {
      const comp = createMonitoringComponent();
      comp.init(makeCtx(bus));

      const sessionEvents = [
        'session.synced',
        'session.file.updated',
      ] as const;

      for (const evt of sessionEvents) {
        bus.emit(evt, { session_id: `s-${evt}` });
      }

      const rows = db.prepare('SELECT event_name, component FROM event_log ORDER BY id').all() as {
        event_name: string;
        component: string;
      }[];

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.component).toBe('sessions');
        expect(row.event_name).toMatch(/^session\./);
      }

      comp.destroy();
    });

    it('instance.heartbeat logged with correct component name', () => {
      const comp = createMonitoringComponent();
      comp.init(makeCtx(bus));

      bus.emit('instance.heartbeat', { instance_id: 'inst-1' });

      const rows = db.prepare('SELECT event_name, component FROM event_log').all() as {
        event_name: string;
        component: string;
      }[];

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ event_name: 'instance.heartbeat', component: 'instances' });

      comp.destroy();
    });

    it('memory.stored logged with correct component name', () => {
      const comp = createMonitoringComponent();
      comp.init(makeCtx(bus));

      bus.emit('memory.stored', { key: 'test-key' });

      const rows = db.prepare('SELECT event_name, component FROM event_log').all() as {
        event_name: string;
        component: string;
      }[];

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ event_name: 'memory.stored', component: 'memory' });

      comp.destroy();
    });

    it('error.stored logged with correct component name', () => {
      const comp = createMonitoringComponent();
      comp.init(makeCtx(bus));

      bus.emit('error.stored', { error: 'test-error' });

      const rows = db.prepare('SELECT event_name, component FROM event_log').all() as {
        event_name: string;
        component: string;
      }[];

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ event_name: 'error.stored', component: 'errors' });

      comp.destroy();
    });

    it('project.registered logged with correct component name', () => {
      const comp = createMonitoringComponent();
      comp.init(makeCtx(bus));

      bus.emit('project.registered', { project: 'my-project' });

      const rows = db.prepare('SELECT event_name, component FROM event_log').all() as {
        event_name: string;
        component: string;
      }[];

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ event_name: 'project.registered', component: 'projects' });

      comp.destroy();
    });

    it('metrics.recorded logged with correct component name', () => {
      const comp = createMonitoringComponent();
      comp.init(makeCtx(bus));

      bus.emit('metrics.recorded', { metric: 'tokens', value: 100 });

      const rows = db.prepare('SELECT event_name, component FROM event_log').all() as {
        event_name: string;
        component: string;
      }[];

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ event_name: 'metrics.recorded', component: 'metrics' });

      comp.destroy();
    });

    it('instance_id extracted from payload.data.instance_id', () => {
      const comp = createMonitoringComponent();
      comp.init(makeCtx(bus));

      bus.emit('instance.heartbeat', { instance_id: 'inst-abc-123' });

      const row = db.prepare('SELECT instance_id FROM event_log').get() as { instance_id: string };
      expect(row.instance_id).toBe('inst-abc-123');

      comp.destroy();
    });

    it('instance_id falls back to payload.data.machine_hostname', () => {
      const comp = createMonitoringComponent();
      comp.init(makeCtx(bus));

      bus.emit('schedule.created', { machine_hostname: 'worker-01' });

      const row = db.prepare('SELECT instance_id FROM event_log').get() as { instance_id: string };
      expect(row.instance_id).toBe('worker-01');

      comp.destroy();
    });

    it('instance_id is null when neither instance_id nor machine_hostname in payload', () => {
      const comp = createMonitoringComponent();
      comp.init(makeCtx(bus));

      bus.emit('cache.rebuilt', { reason: 'manual' });

      const row = db.prepare('SELECT instance_id FROM event_log').get() as { instance_id: string | null };
      expect(row.instance_id).toBeNull();

      comp.destroy();
    });

    it('handler does not throw on DB error (swallows with log)', () => {
      // Use a closed DB to simulate error
      const closedDb = new Database(':memory:');
      closedDb.close();
      vi.mocked(getDb).mockReturnValue(closedDb as unknown as ReturnType<typeof getDb>);

      const ctx = makeCtx(bus);
      const comp = createMonitoringComponent();
      comp.init(ctx);

      // This should NOT throw
      expect(() => bus.emit('schedule.created', {})).not.toThrow();

      // Error should be logged
      expect(ctx.log.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to log event schedule.created'),
      );

      comp.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // 6. Init Behavior
  // -------------------------------------------------------------------------

  describe('init behavior', () => {
    it('retention cleanup runs on init', () => {
      // Insert an old event directly before init
      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      insertEvent(db, { event_name: 'old.event', created_at: oldDate });
      // Insert a recent event
      insertEvent(db, { event_name: 'recent.event', created_at: new Date().toISOString() });

      // Verify 2 rows before init
      const beforeCount = db.prepare('SELECT COUNT(*) as count FROM event_log').get() as { count: number };
      expect(beforeCount.count).toBe(2);

      const comp = createMonitoringComponent();
      const ctx = makeCtx(bus);
      comp.init(ctx);

      // After init, old events should be purged
      const afterCount = db.prepare('SELECT COUNT(*) as count FROM event_log').get() as { count: number };
      expect(afterCount.count).toBe(1);

      // Should log the purge
      expect(ctx.log.info).toHaveBeenCalledWith(
        expect.stringContaining('Purged 1 event log entries older than 30 days'),
      );

      comp.destroy();
    });

    it('old events are purged on init', () => {
      // Insert 3 old events
      const oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      insertEvent(db, { event_name: 'old.1', created_at: oldDate });
      insertEvent(db, { event_name: 'old.2', created_at: oldDate });
      insertEvent(db, { event_name: 'old.3', created_at: oldDate });

      const comp = createMonitoringComponent();
      comp.init(makeCtx(bus));

      const count = db.prepare('SELECT COUNT(*) as count FROM event_log').get() as { count: number };
      expect(count.count).toBe(0);

      comp.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // 7. SYNC_TABLES
  // -------------------------------------------------------------------------

  describe('SYNC_TABLES', () => {
    it('event_log entry exists in SYNC_TABLES', () => {
      const entry = SYNC_TABLES.find((t) => t.table === 'event_log');
      expect(entry).toBeDefined();
    });

    it('strategy is "append"', () => {
      const entry = SYNC_TABLES.find((t) => t.table === 'event_log');
      expect(entry!.strategy).toBe('append');
    });

    it('syncKey is ["id"]', () => {
      const entry = SYNC_TABLES.find((t) => t.table === 'event_log');
      expect(entry!.syncKey).toEqual(['id']);
    });

    it('timestampCol is "created_at"', () => {
      const entry = SYNC_TABLES.find((t) => t.table === 'event_log');
      expect(entry!.timestampCol).toBe('created_at');
    });
  });
});
