/**
 * Subconscious Integrity Tests
 *
 * Bootstrap-failure observability (TD-053 Nit 4) — a rejected
 * `igris_schedule_create` dispatch fires `subconscious.bootstrap_failed` so
 * the monitoring component can log it.
 *
 * FR-118 M4b note: the ReadOnlyDb-rejection + detector data_version-invariance
 * + Phase-1 smoothing fail-soft groups were DELETED with the rule-detector
 * pipeline (`runAllDetectors`, the 4 detectors, `makeReadOnlyDb`, the
 * `pattern_observations` smoothing gate). The only invariant that still has
 * live code behind it is the schedule-bootstrap failure path below.
 *
 * @module engine/components/subconscious/__tests__/integrity.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// Mock db so `ensureScheduleExists()` reads our test database when the
// subconscious component checks whether `subconscious_engine` already exists.
vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../../../../db.js';
import { createEventBus } from '../../../bus.js';
import { createSubconsciousComponent } from '../index.js';
import type {
  ComponentContext,
  ComponentLogger,
  EventBus,
  EventPayload,
} from '../../../types.js';

// ---------------------------------------------------------------------------
// Bootstrap-failure observability (TD-053 Nit 4)
// ---------------------------------------------------------------------------

/**
 * The subconscious component dispatches `igris_schedule_create` from
 * `engine.ready`. When that dispatch rejects (e.g. schedules component
 * not loaded, daemon offline), the warn-log alone is invisible to
 * monitoring. We expect a `subconscious.bootstrap_failed` event so the
 * event_log row gets written.
 */

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
 * Build a DB with just the columns the bootstrap path inspects on
 * `schedules`. The component only reads `id WHERE name = ?` so the
 * minimal column set is fine.
 */
function makeBootstrapDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    );
  `);
  return db;
}

describe('subconscious bootstrap-failure observability', () => {
  let db: Database.Database;
  let bus: EventBus;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeBootstrapDb();
    bus = createEventBus();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('emits subconscious.bootstrap_failed when igris_schedule_create rejects', async () => {
    const captured: EventPayload[] = [];
    bus.on('subconscious.bootstrap_failed', (payload) => {
      captured.push(payload);
    });

    const dispatch = vi.fn().mockRejectedValue(new Error('schedules unavailable'));

    const comp = createSubconsciousComponent();
    comp.init(makeCtx(bus));

    bus.emit('engine.ready', { dispatch });

    // The component fires `void ensureScheduleExists()` which awaits the
    // mocked dispatch. Wait one microtask cycle for the rejection to
    // propagate into the catch block and the bus.emit to fire.
    await new Promise((r) => setImmediate(r));

    expect(dispatch).toHaveBeenCalledWith(
      'igris_schedule_create',
      expect.objectContaining({ name: 'subconscious_engine' }),
    );
    expect(captured).toHaveLength(1);
    expect(captured[0].event).toBe('subconscious.bootstrap_failed');
    expect(captured[0].data.error_message).toBe('schedules unavailable');

    comp.destroy();
  });

  it('does NOT emit subconscious.bootstrap_failed on successful dispatch', async () => {
    const captured: EventPayload[] = [];
    bus.on('subconscious.bootstrap_failed', (payload) => {
      captured.push(payload);
    });

    const dispatch = vi.fn().mockResolvedValue({});

    const comp = createSubconsciousComponent();
    comp.init(makeCtx(bus));

    bus.emit('engine.ready', { dispatch });

    await new Promise((r) => setImmediate(r));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(0);

    comp.destroy();
  });
});
