/**
 * Auto-Push Unit Tests
 *
 * Tests the event-driven auto-push system in the sync component:
 * 1. Config loading (enabled/disabled, missing fields, malformed JSON)
 * 2. SYNC_TABLES completeness (27 entries — TD-171 M2 added graph_nodes)
 * 3. Immediate push (brief/session/instance events)
 * 4. Batched push (memory/error/project/metrics events with 10s window)
 * 5. Cleanup (destroy clears timers, listeners, pending set)
 * 6. Events declaration (10 listened, 0 emitted)
 *
 * @module engine/components/sync/__tests__/auto-push.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createEventBus } from '../../../bus.js';
import type { EventBus, ComponentContext, ComponentLogger } from '../../../types.js';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports that use them
// ---------------------------------------------------------------------------

// Mock node:fs readFileSync for config loading
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

// Mock node:os homedir
vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock-home'),
}));

// Mock the sync tools module
vi.mock('../../../../tools/sync.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../tools/sync.js')>();
  return {
    ...original,
    fetchWithRetry: vi.fn(),
    queueFailedRows: vi.fn(),
  };
});

// Mock the db module
vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { createSyncComponent } from '../index.js';
import {
  fetchWithRetry,
  queueFailedRows,
  SYNC_TABLES,
} from '../../../../tools/sync.js';
import { getDb } from '../../../../db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_CONFIG = JSON.stringify({
  auto_push: true,
  remote_brain: {
    url: 'https://brain.example.com',
    api_key: 'test-key-123',
  },
});

const VALID_CONFIG_TRAILING_SLASH = JSON.stringify({
  auto_push: true,
  remote_brain: {
    url: 'https://brain.example.com///',
    api_key: 'test-key-123',
  },
});

function makeLogger(): ComponentLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeMockDb() {
  const stmtAll = vi.fn().mockReturnValue([]);
  const stmtRun = vi.fn();
  const stmtGet = vi.fn().mockReturnValue(undefined);
  const stmt = { all: stmtAll, run: stmtRun, get: stmtGet };

  const db = {
    prepare: vi.fn().mockReturnValue(stmt),
    transaction: vi.fn((fn: (...args: unknown[]) => unknown) => {
      const wrapper = (...args: unknown[]) => fn(...args);
      return wrapper;
    }),
    _stmt: stmt,
  };

  return db;
}

function makeCtx(bus: EventBus): ComponentContext {
  return {
    storage: {} as ComponentContext['storage'],
    bus,
    log: makeLogger(),
    config: {},
  };
}

/** Flush microtasks so fire-and-forget async calls settle */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sync Auto-Push', () => {
  let bus: EventBus;
  let mockDb: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    bus = createEventBus();
    mockDb = makeMockDb();
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 1. Config Loading Tests
  // -------------------------------------------------------------------------

  describe('config loading', () => {
    it('disables auto-push when auto_push is false', () => {
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ auto_push: false, remote_brain: { url: 'https://x.com', api_key: 'k' } })
      );

      const comp = createSyncComponent();
      const ctx = makeCtx(bus);
      comp.init(ctx);

      bus.emit('brief.synced', { project: 'p', brief_id: 'BR-001' });

      expect(fetchWithRetry).not.toHaveBeenCalled();

      comp.destroy();
    });

    it('disables auto-push when auto_push is absent', () => {
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ remote_brain: { url: 'https://x.com', api_key: 'k' } })
      );

      const comp = createSyncComponent();
      const ctx = makeCtx(bus);
      comp.init(ctx);

      bus.emit('brief.synced', { project: 'p', brief_id: 'BR-001' });

      expect(fetchWithRetry).not.toHaveBeenCalled();

      comp.destroy();
    });

    it('disables auto-push when remote_brain.url is missing', () => {
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ auto_push: true, remote_brain: { api_key: 'k' } })
      );

      const comp = createSyncComponent();
      const ctx = makeCtx(bus);
      comp.init(ctx);

      bus.emit('brief.synced', { project: 'p', brief_id: 'BR-001' });

      expect(fetchWithRetry).not.toHaveBeenCalled();

      comp.destroy();
    });

    it('disables auto-push when remote_brain.api_key is missing', () => {
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ auto_push: true, remote_brain: { url: 'https://x.com' } })
      );

      const comp = createSyncComponent();
      const ctx = makeCtx(bus);
      comp.init(ctx);

      bus.emit('brief.synced', { project: 'p', brief_id: 'BR-001' });

      expect(fetchWithRetry).not.toHaveBeenCalled();

      comp.destroy();
    });

    it('disables auto-push when config.json does not exist', () => {
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory');
      });

      const comp = createSyncComponent();
      const ctx = makeCtx(bus);
      comp.init(ctx);

      bus.emit('brief.synced', { project: 'p', brief_id: 'BR-001' });

      expect(fetchWithRetry).not.toHaveBeenCalled();

      comp.destroy();
    });

    it('disables auto-push when config.json is malformed JSON', () => {
      vi.mocked(readFileSync).mockReturnValue('{ invalid json !!!');

      const comp = createSyncComponent();
      const ctx = makeCtx(bus);
      comp.init(ctx);

      bus.emit('brief.synced', { project: 'p', brief_id: 'BR-001' });

      expect(fetchWithRetry).not.toHaveBeenCalled();

      comp.destroy();
    });

    it('enables auto-push when all fields are present', () => {
      vi.mocked(readFileSync).mockReturnValue(VALID_CONFIG);
      mockDb._stmt.all.mockReturnValue([{ id: 1, project: 'p', brief_id: 'BR-001' }]);

      const comp = createSyncComponent();
      const ctx = makeCtx(bus);
      comp.init(ctx);

      bus.emit('brief.synced', { project: 'p', brief_id: 'BR-001' });

      expect(fetchWithRetry).toHaveBeenCalled();

      comp.destroy();
    });

    it('strips trailing slashes from URL', () => {
      vi.mocked(readFileSync).mockReturnValue(VALID_CONFIG_TRAILING_SLASH);
      mockDb._stmt.all.mockReturnValue([{ id: 1 }]);

      const comp = createSyncComponent();
      const ctx = makeCtx(bus);
      comp.init(ctx);

      bus.emit('brief.synced', { project: 'p', brief_id: 'BR-001' });

      expect(fetchWithRetry).toHaveBeenCalledWith(
        'https://brain.example.com/sync/push',
        expect.any(Object),
      );

      comp.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // 2. SYNC_TABLES Completeness
  // -------------------------------------------------------------------------

  describe('SYNC_TABLES completeness', () => {
    it('has exactly 21 entries', () => {
      // TD-265: −7 task/coordination tables (tasks, task_deps, task_results,
      // task_assignments, agent_capabilities, autonomous_decisions,
      // coordination_config) removed with the worker subsystem teardown.
      // FR-268 (2026-08-27): +1 `ceremony_events` (the ceremony record,
      // instances migration v4), 20→21.
      expect(SYNC_TABLES).toHaveLength(21);
    });

    it('EXCLUDES cognition_instances — the roster is per-machine derived state (TD-327)', () => {
      // `cognition_instances` is a projection of THIS build's extractor
      // registry, regenerated at every engine boot. Replicating it would assert
      // one machine's roster onto another — the same class of mistake that put
      // two `subconscious_engine` rows into `schedules` (a `syncKey: ['id']`
      // over a per-machine random `sch-XXXXXXXX`). It is cheap to lose and
      // wrong to merge, so it stays out and the count above stays 21 (FR-268).
      expect(SYNC_TABLES.map((t) => t.table)).not.toContain('cognition_instances');
    });

    it('EXCLUDES the six TD-440 v5 columns from the suggestions column list', () => {
      // MAINTAINING's TD-440 rule (b) says the six v5 columns are DELIBERATELY
      // out of the sync config; until this test existed that rule had no
      // mechanical pin, and `suggestions` IS synced, so an editor adding one
      // here would have shipped a per-row failure against an unmigrated remote.
      // `columns` is exactly what `mergeRows` reads and writes, so pinning the
      // list is what makes the omission a decision instead of an oversight.
      const suggestions = SYNC_TABLES.find((t) => t.table === 'suggestions');
      expect(suggestions).toBeDefined();
      for (const v5 of [
        'dedupe_key', 'entity_key', 'seen_count',
        'last_seen_at', 'recurrence_titles', 'source_instance',
      ]) {
        expect(suggestions!.columns).not.toContain(v5);
      }
      // …and the list is otherwise unchanged, so a SEVENTH column cannot slip in
      // under a name this loop does not name.
      expect(suggestions!.columns).toEqual([
        'source_module', 'project_slug', 'title', 'evidence', 'priority',
        'status', 'created_at', 'expires_at', 'dismissed_at',
        'dismissed_reason', 'acted_at', 'acted_brief_id',
        'confidence', 'suggested_action', 'type_inferred',
      ]);
    });

    it('EXCLUDES machine_id from event_log, instances AND ceremony_events (BR-100)', () => {
      // BR-100 (2026-09-06): the machine-identity stamp is a per-machine value
      // (coding_guidelines §7, TD-440) and its NON-replication is the contract —
      // L-849 inverted. No reader anywhere compares a FOREIGN row's machine_id;
      // an inbound row lands with it NULL, which is "not mine" by construction
      // (AC-5), and a pulled-back copy of my own `instances` row cannot NULL my
      // id because the LWW UPDATE iterates `config.columns` only. Adding it here
      // would buy a remote-first deploy (a per-row `has no column named
      // machine_id` on an un-migrated VPS, which BR-097 does NOT hold the
      // watermark for), an egress-manifest regeneration and two CLI mirror
      // edits — for a value nobody remote reads. This pin is the decision.
      for (const table of ['event_log', 'instances', 'ceremony_events']) {
        const entry = SYNC_TABLES.find((t) => t.table === table);
        expect(entry, table).toBeDefined();
        expect(entry!.columns, table).not.toContain('machine_id');
        expect(entry!.syncKey, table).not.toContain('machine_id');
      }
      // …and the count is unchanged: no new table joined for it either.
      expect(SYNC_TABLES).toHaveLength(21);
    });

    const newTables = [
      { table: 'schedules', syncKey: ['id'], strategy: 'lww', timestampCol: 'updated_at' },
      { table: 'schedule_runs', syncKey: ['id'], strategy: 'append', timestampCol: 'started_at' },
      // FR-105: typed-edges graph layer
      {
        table: 'entity_edges',
        // BR-083 D7 — the two qualifiers are IN the syncKey, because the key
        // exists to mirror the local uniqueness so the remote INSERT OR IGNORE
        // shares it. Leaving them out would re-create the same-id fusion ON
        // THE VPS, which is this brief's defect reproduced on another machine.
        syncKey: [
          'from_type', 'from_id', 'from_project',
          'to_type', 'to_id', 'to_project',
          'edge_type',
        ],
        strategy: 'append',
        timestampCol: 'created_at',
      },
      // FR-110: goals (outcome-level entities)
      {
        table: 'goals',
        syncKey: ['goal_id'],
        strategy: 'lww',
        timestampCol: 'updated_at',
      },
      // FR-106 Phase 1: suggestions (subconscious engine output)
      {
        table: 'suggestions',
        syncKey: ['source_module', 'project_slug', 'title'],
        strategy: 'lww',
        timestampCol: 'created_at',
      },
      // FR-106 Phase 1: dismissed_patterns (learning loop)
      {
        table: 'dismissed_patterns',
        syncKey: ['source_module', 'project_slug', 'evidence_signature'],
        strategy: 'lww',
        timestampCol: 'last_dismissed_at',
      },
      // TD-171 M2: graph_nodes (free-standing concept/decision nodes)
      {
        table: 'graph_nodes',
        syncKey: ['node_type', 'node_external_id'],
        strategy: 'append',
        timestampCol: 'created_at',
      },
    ];

    for (const expected of newTables) {
      it(`includes ${expected.table} with correct config`, () => {
        const entry = SYNC_TABLES.find((t) => t.table === expected.table);
        expect(entry).toBeDefined();
        expect(entry!.syncKey).toEqual(expected.syncKey);
        expect(entry!.strategy).toBe(expected.strategy);
        expect(entry!.timestampCol).toBe(expected.timestampCol);
      });
    }
  });

  // -------------------------------------------------------------------------
  // 3. Immediate Push Tests
  // -------------------------------------------------------------------------

  describe('immediate push', () => {
    beforeEach(() => {
      vi.mocked(readFileSync).mockReturnValue(VALID_CONFIG);
    });

    it('brief.synced triggers push of brief_status and brief_files', async () => {
      mockDb._stmt.all
        .mockReturnValueOnce([{ project: 'p', brief_id: 'BR-001', status: 'Done' }])  // brief_status
        .mockReturnValueOnce([{ project: 'p', brief_id: 'BR-001', content: 'md' }]);   // brief_files

      const comp = createSyncComponent();
      comp.init(makeCtx(bus));

      bus.emit('brief.synced', { project: 'p', brief_id: 'BR-001' });
      await flushMicrotasks();

      expect(fetchWithRetry).toHaveBeenCalledTimes(1);
      const body = JSON.parse(
        (vi.mocked(fetchWithRetry).mock.calls[0][1] as RequestInit).body as string
      );
      expect(body.tables).toHaveProperty('brief_status');
      expect(body.tables).toHaveProperty('brief_files');

      comp.destroy();
    });

    it('brief.created triggers push of brief_status and brief_files', async () => {
      mockDb._stmt.all
        .mockReturnValueOnce([{ project: 'p', brief_id: 'BR-002' }])
        .mockReturnValueOnce([{ project: 'p', brief_id: 'BR-002', content: 'x' }]);

      const comp = createSyncComponent();
      comp.init(makeCtx(bus));

      bus.emit('brief.created', { project: 'p', brief_id: 'BR-002' });
      await flushMicrotasks();

      expect(fetchWithRetry).toHaveBeenCalledTimes(1);
      const body = JSON.parse(
        (vi.mocked(fetchWithRetry).mock.calls[0][1] as RequestInit).body as string
      );
      expect(body.tables).toHaveProperty('brief_status');
      expect(body.tables).toHaveProperty('brief_files');

      comp.destroy();
    });

    it('brief.completed triggers push of brief_status only', async () => {
      mockDb._stmt.all.mockReturnValueOnce([{ project: 'p', brief_id: 'BR-003', status: 'Done' }]);

      const comp = createSyncComponent();
      comp.init(makeCtx(bus));

      bus.emit('brief.completed', { project: 'p', brief_id: 'BR-003' });
      await flushMicrotasks();

      expect(fetchWithRetry).toHaveBeenCalledTimes(1);
      const body = JSON.parse(
        (vi.mocked(fetchWithRetry).mock.calls[0][1] as RequestInit).body as string
      );
      expect(body.tables).toHaveProperty('brief_status');
      expect(body.tables).not.toHaveProperty('brief_files');

      comp.destroy();
    });

    it('session.synced triggers push of sessions', async () => {
      mockDb._stmt.all.mockReturnValueOnce([{ project: 'p', started_at: '2026-01-01' }]);

      const comp = createSyncComponent();
      comp.init(makeCtx(bus));

      bus.emit('session.synced', { project: 'p' });
      await flushMicrotasks();

      expect(fetchWithRetry).toHaveBeenCalledTimes(1);
      const body = JSON.parse(
        (vi.mocked(fetchWithRetry).mock.calls[0][1] as RequestInit).body as string
      );
      expect(body.tables).toHaveProperty('sessions');

      comp.destroy();
    });

    it('session.file.updated triggers push of session_files', async () => {
      mockDb._stmt.all.mockReturnValueOnce([{ project: 'p', filename: 'CURRENT_SESSION.md' }]);

      const comp = createSyncComponent();
      comp.init(makeCtx(bus));

      bus.emit('session.file.updated', { project: 'p', filename: 'CURRENT_SESSION.md' });
      await flushMicrotasks();

      expect(fetchWithRetry).toHaveBeenCalledTimes(1);
      const body = JSON.parse(
        (vi.mocked(fetchWithRetry).mock.calls[0][1] as RequestInit).body as string
      );
      expect(body.tables).toHaveProperty('session_files');

      comp.destroy();
    });

    it('instance.state_updated triggers push of instances', async () => {
      mockDb._stmt.all.mockReturnValueOnce([{ machine_hostname: 'host-1', status: 'active' }]);

      const comp = createSyncComponent();
      comp.init(makeCtx(bus));

      bus.emit('instance.state_updated', { machine_hostname: 'host-1' });
      await flushMicrotasks();

      expect(fetchWithRetry).toHaveBeenCalledTimes(1);
      const body = JSON.parse(
        (vi.mocked(fetchWithRetry).mock.calls[0][1] as RequestInit).body as string
      );
      expect(body.tables).toHaveProperty('instances');

      comp.destroy();
    });

    it('queues to sync_queue on push failure via queueFailedRows', async () => {
      mockDb._stmt.all.mockReturnValueOnce([{ project: 'p', brief_id: 'BR-001' }]);
      vi.mocked(fetchWithRetry).mockRejectedValueOnce(new Error('Network error'));

      const comp = createSyncComponent();
      comp.init(makeCtx(bus));

      bus.emit('brief.completed', { project: 'p', brief_id: 'BR-001' });
      await flushMicrotasks();

      expect(queueFailedRows).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({ brief_status: expect.any(Array) }),
        'Network error',
      );

      comp.destroy();
    });

    it('does not call fetchWithRetry when auto-push is disabled', async () => {
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ auto_push: false })
      );

      const comp = createSyncComponent();
      comp.init(makeCtx(bus));

      bus.emit('brief.synced', { project: 'p', brief_id: 'BR-001' });
      bus.emit('session.synced', { project: 'p' });
      bus.emit('instance.state_updated', { machine_hostname: 'h' });
      await flushMicrotasks();

      expect(fetchWithRetry).not.toHaveBeenCalled();

      comp.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Batch Push Tests
  // -------------------------------------------------------------------------

  describe('batch push', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.mocked(readFileSync).mockReturnValue(VALID_CONFIG);
    });

    it('single batched event starts timer', () => {
      const comp = createSyncComponent();
      comp.init(makeCtx(bus));

      bus.emit('memory.stored', { project: 'p' });

      // Timer should be pending — fetchWithRetry NOT called yet
      expect(fetchWithRetry).not.toHaveBeenCalled();

      comp.destroy();
    });

    it('multiple batched events within window accumulate tables', async () => {
      mockDb._stmt.get.mockReturnValue(undefined); // no sync_state row
      mockDb._stmt.all.mockReturnValue([{ id: 1 }]); // rows for any table query

      const comp = createSyncComponent();
      comp.init(makeCtx(bus));

      bus.emit('memory.stored', { project: 'p' });
      bus.emit('error.stored', { project: 'p' });
      bus.emit('project.registered', { slug: 'proj' });

      // Advance past the 10s batch window
      await vi.advanceTimersByTimeAsync(10_000);

      expect(fetchWithRetry).toHaveBeenCalledTimes(1);

      comp.destroy();
    });

    it('timer fires after 10s and triggers push', async () => {
      mockDb._stmt.get.mockReturnValue(undefined);
      mockDb._stmt.all.mockReturnValue([{ id: 1, content: 'test' }]);

      const comp = createSyncComponent();
      comp.init(makeCtx(bus));

      bus.emit('agent_event.recorded', { project: 'p' });

      // Not fired yet at 9.9s
      await vi.advanceTimersByTimeAsync(9_999);
      expect(fetchWithRetry).not.toHaveBeenCalled();

      // Fires at 10s
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchWithRetry).toHaveBeenCalledTimes(1);

      comp.destroy();
    });

    it('pending set is cleared after flush', async () => {
      mockDb._stmt.get.mockReturnValue(undefined);
      mockDb._stmt.all.mockReturnValue([{ id: 1 }]);

      const comp = createSyncComponent();
      comp.init(makeCtx(bus));

      bus.emit('memory.stored', { project: 'p' });

      // Flush batch
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchWithRetry).toHaveBeenCalledTimes(1);
      vi.mocked(fetchWithRetry).mockClear();

      // Second event after flush should start a new timer
      bus.emit('memory.stored', { project: 'p' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchWithRetry).toHaveBeenCalledTimes(1);

      comp.destroy();
    });

    it('multiple events for same table deduplicate (set behavior)', async () => {
      mockDb._stmt.get.mockReturnValue(undefined);
      mockDb._stmt.all.mockReturnValue([{ id: 1 }]);

      const comp = createSyncComponent();
      comp.init(makeCtx(bus));

      // Emit same event type 3 times
      bus.emit('memory.stored', { project: 'p' });
      bus.emit('memory.stored', { project: 'p' });
      bus.emit('memory.stored', { project: 'p' });

      await vi.advanceTimersByTimeAsync(10_000);

      // Should push once, with learnings table queried once
      expect(fetchWithRetry).toHaveBeenCalledTimes(1);

      comp.destroy();
    });

    it('does not start timer when auto-push is disabled', async () => {
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ auto_push: false })
      );

      const comp = createSyncComponent();
      comp.init(makeCtx(bus));

      bus.emit('memory.stored', { project: 'p' });

      await vi.advanceTimersByTimeAsync(15_000);

      expect(fetchWithRetry).not.toHaveBeenCalled();

      comp.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // 5. Cleanup Tests
  // -------------------------------------------------------------------------

  describe('cleanup', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.mocked(readFileSync).mockReturnValue(VALID_CONFIG);
    });

    it('destroy() clears batch timer', async () => {
      const comp = createSyncComponent();
      comp.init(makeCtx(bus));

      bus.emit('memory.stored', { project: 'p' });

      // Destroy before timer fires
      comp.destroy();

      // Advance past batch window — should NOT call fetchWithRetry
      await vi.advanceTimersByTimeAsync(15_000);
      expect(fetchWithRetry).not.toHaveBeenCalled();
    });

    it('destroy() unregisters all 10 listeners', () => {
      const comp = createSyncComponent();
      const ctx = makeCtx(bus);
      comp.init(ctx);

      comp.destroy();

      // After destroy, emitting events should NOT trigger any handler behavior.
      // With auto-push enabled, if listeners were still registered they would
      // try to query the DB. Reset the mock to verify no new calls.
      vi.mocked(getDb).mockClear();
      mockDb.prepare.mockClear();

      bus.emit('brief.synced', { project: 'p', brief_id: 'BR-001' });
      bus.emit('brief.created', { project: 'p', brief_id: 'BR-001' });
      bus.emit('brief.completed', { project: 'p', brief_id: 'BR-001' });
      bus.emit('session.synced', { project: 'p' });
      bus.emit('session.file.updated', { project: 'p', filename: 'f' });
      bus.emit('instance.state_updated', { machine_hostname: 'h' });
      bus.emit('memory.stored', { project: 'p' });
      bus.emit('error.stored', { project: 'p' });
      bus.emit('project.registered', { slug: 's' });
      bus.emit('agent_event.recorded', { project: 'p' });

      // No DB calls or fetch calls should have been made
      expect(fetchWithRetry).not.toHaveBeenCalled();
    });

    it('pending batch is cleared on destroy', async () => {
      mockDb._stmt.get.mockReturnValue(undefined);
      mockDb._stmt.all.mockReturnValue([{ id: 1 }]);

      const comp = createSyncComponent();
      comp.init(makeCtx(bus));

      // Add pending batched events
      bus.emit('memory.stored', { project: 'p' });
      bus.emit('error.stored', { project: 'p' });

      comp.destroy();

      // Even if we somehow trigger flushBatch, pending should be empty
      await vi.advanceTimersByTimeAsync(15_000);
      expect(fetchWithRetry).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 6. Events Declaration
  // -------------------------------------------------------------------------

  describe('events declaration', () => {
    it('declares 10 listened events', () => {
      vi.mocked(readFileSync).mockReturnValue(VALID_CONFIG);

      const comp = createSyncComponent();
      const { listens } = comp.events();

      expect(listens).toHaveLength(10);
    });

    it('declares 0 emitted events', () => {
      vi.mocked(readFileSync).mockReturnValue(VALID_CONFIG);

      const comp = createSyncComponent();
      const { emits } = comp.events();

      expect(emits).toHaveLength(0);
    });

    it('all 10 event names match expected names', () => {
      vi.mocked(readFileSync).mockReturnValue(VALID_CONFIG);

      const comp = createSyncComponent();
      const { listens } = comp.events();

      const expectedEvents = [
        'brief.synced',
        'brief.created',
        'brief.completed',
        'session.synced',
        'session.file.updated',
        'instance.state_updated',
        'memory.stored',
        'error.stored',
        'project.registered',
        'agent_event.recorded',
      ];

      const listenNames = listens.map((e) => e.name);
      expect(listenNames).toEqual(expect.arrayContaining(expectedEvents));
      expect(expectedEvents).toEqual(expect.arrayContaining(listenNames));
    });
  });
});
