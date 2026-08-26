/**
 * FR-267 — `igris_agent_event` handler: the brain-timed hunt-cost record.
 *
 * Every assertion about a stored value READS THE ROW BACK — the failure
 * class this brief exists for (FR-089 / L-1248) is a carrier that exits 0
 * while nothing lands. The fixture is built from the instances component's
 * own migrations (v1..v3), so the schema under test is the producer's, not a
 * hand copy.
 *
 * `getDb` is mocked the way `projects-budget.test.ts` does it.
 *
 * @module tools/__tests__/agent-events.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports that use them
// ---------------------------------------------------------------------------

vi.mock('../../db.js', () => ({
  getDb: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { getDb } from '../../db.js';
import {
  handleAgentEvent,
  handleAgentEventLog,
  findOpenStart,
  deriveRound,
  AgentEventValidationError,
  MODEL_REQUESTED_REQUIRED_MESSAGE,
} from '../agent_events.js';
import type { AgentEventInput } from '../agent_events.js';
import { createInstancesComponent } from '../../engine/components/instances/index.js';
import type { ComponentContext } from '../../engine/types.js';

const mockedGetDb = vi.mocked(getDb);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Legacy `brief_status` (db.ts v2) — `hunt_runs` LEFT JOINs it. */
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
`;

/** In-memory brain at the post-v3 shape, built from the component's own migrations. */
function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(LEGACY_BRIEF_STATUS_DDL);
  for (const migration of createInstancesComponent().schema()) {
    db.exec(migration.sql);
  }
  db.prepare("INSERT INTO instances (id, machine_hostname, project_slug) VALUES ('inst-1', 'host', 'igris-ai')").run();
  db.prepare("INSERT INTO instances (id, machine_hostname, project_slug) VALUES ('inst-2', 'host', 'igris-ai')").run();
  return db;
}

function base(overrides: Partial<AgentEventInput> = {}): AgentEventInput {
  return {
    instance_id: 'inst-1',
    agent: 'forger',
    event_type: 'start',
    model_requested: 'claude-fable-5',
    brief_id: 'FR-267',
    phase: 'BUILDING',
    ...overrides,
  };
}

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleAgentEvent (FR-267)', () => {
  let db: Database.Database;

  const rowById = (id: number): Row =>
    db.prepare('SELECT * FROM agent_events WHERE id = ?').get(id) as Row;
  const count = (): number =>
    (db.prepare('SELECT COUNT(*) AS c FROM agent_events').get() as { c: number }).c;

  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  describe('validation', () => {
    it('start without model_requested throws the FR-267 message and writes NO row', () => {
      const noModel: Record<string, unknown> = { ...base() };
      delete noModel.model_requested;

      expect(() => handleAgentEvent(noModel as unknown as AgentEventInput))
        .toThrow(MODEL_REQUESTED_REQUIRED_MESSAGE);
      expect(count()).toBe(0);
    });

    it('the message is the pinned FR-267 text and the error is the mapped class', () => {
      expect(MODEL_REQUESTED_REQUIRED_MESSAGE).toBe(
        'igris_agent_event: model_requested is required (FR-267) — pass the model you chose or inherit:<your model>',
      );
      let caught: unknown;
      try {
        handleAgentEvent(base({ model_requested: '' }));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AgentEventValidationError);
      expect((caught as Error).message).toBe(MODEL_REQUESTED_REQUIRED_MESSAGE);
    });

    it('a whitespace-only model_requested is rejected too', () => {
      expect(() => handleAgentEvent(base({ model_requested: '   ' }))).toThrow(MODEL_REQUESTED_REQUIRED_MESSAGE);
      expect(count()).toBe(0);
    });

    it('an unknown event_type throws and writes NO row', () => {
      expect(() => handleAgentEvent(base({ event_type: 'pause' as unknown as AgentEventInput['event_type'] })))
        .toThrow(/event_type must be one of start, stop, error, retry/);
      expect(count()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  describe('start', () => {
    it('writes duration_ms NULL, tokens NULL when omitted, round 1, project from instances, the model', () => {
      const result = handleAgentEvent(base());
      const row = rowById(result.event.id);

      expect(row).toMatchObject({
        instance_id: 'inst-1',
        agent: 'forger',
        event_type: 'start',
        phase: 'BUILDING',
        brief_id: 'FR-267',
        duration_ms: null,
        input_tokens: null,
        output_tokens: null,
        cache_read: null,
        cache_create: null,
        model_requested: 'claude-fable-5',
        model_resolved: null,
        round: 1,
        project: 'igris-ai',
        metadata: '{}',
      });
      expect(result.event).toMatchObject({ round: 1, duration_ms: null, project: 'igris-ai', paired_start_id: null });
      expect(result.content[0].text).toBe(
        `Agent event recorded: forger start (id: ${result.event.id}, round 1, model claude-fable-5)`,
      );
    });

    it('project is NULL when the instance row is gone (removed on /rest)', () => {
      const result = handleAgentEvent(base({ instance_id: 'ghost' }));
      expect(rowById(result.event.id).project).toBeNull();
      expect(result.event.project).toBeNull();
    });

    it('caller-supplied duration_ms and round are never stored', () => {
      const smuggled = { ...base(), duration_ms: 999999, round: 9 } as unknown as AgentEventInput;
      const result = handleAgentEvent(smuggled);
      const row = rowById(result.event.id);
      expect(row.duration_ms).toBeNull();
      expect(row.round).toBe(1);
    });

    it('start -> stop -> start: the second start is round 2', () => {
      handleAgentEvent(base());
      handleAgentEvent(base({ event_type: 'stop' }));
      const second = handleAgentEvent(base());

      expect(rowById(second.event.id).round).toBe(2);
      expect(second.content[0].text).toContain('round 2');
    });

    it('round is keyed to the brief (project, brief_id), so a resume in another instance continues numbering', () => {
      handleAgentEvent(base({ instance_id: 'inst-1' }));
      const resumed = handleAgentEvent(base({ instance_id: 'inst-2' }));
      expect(rowById(resumed.event.id).round).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // stop / error pairing and the brain-computed duration
  // -------------------------------------------------------------------------

  describe('stop / error', () => {
    it('a start seeded 90 s ago then a stop -> stored duration_ms in [88000, 92000], read back from the row', () => {
      const seeded = db.prepare(`
        INSERT INTO agent_events
          (instance_id, agent, event_type, brief_id, model_requested, round, project, created_at)
        VALUES ('inst-1', 'forger', 'start', 'FR-267', 'claude-fable-5', 1, 'igris-ai', datetime('now', '-90 seconds'))
      `).run();
      const startId = Number(seeded.lastInsertRowid);

      const result = handleAgentEvent(base({ event_type: 'stop', result: 'success' }));
      const row = rowById(result.event.id);

      const stored = row.duration_ms as number;
      expect(typeof stored).toBe('number');
      expect(stored).toBeGreaterThan(0);
      expect(stored).toBeGreaterThanOrEqual(88000);
      expect(stored).toBeLessThanOrEqual(92000);
      // The response reports the stored value, not a JS-side computation.
      expect(result.event.duration_ms).toBe(stored);
      expect(result.event.paired_start_id).toBe(startId);
      expect(row.round).toBe(1);
      expect(result.content[0].text).toBe(
        `Agent event recorded: forger stop (id: ${result.event.id}, round 1, duration_ms ${stored}, model claude-fable-5)`,
      );
    });

    it('stop with tokens and model_resolved stores them as given', () => {
      handleAgentEvent(base());
      const result = handleAgentEvent(base({
        event_type: 'stop',
        model_resolved: 'claude-fable-5-20260801',
        input_tokens: 1000,
        output_tokens: 200,
        cache_read: 50,
        cache_create: 0,
      }));
      const row = rowById(result.event.id);
      expect(row).toMatchObject({
        input_tokens: 1000,
        output_tokens: 200,
        cache_read: 50,
        cache_create: 0,
        model_requested: 'claude-fable-5',
        model_resolved: 'claude-fable-5-20260801',
      });
      expect(result.content[0].text).toContain('model claude-fable-5, resolved claude-fable-5-20260801');
    });

    it('a paired stop takes its round from the start it closes', () => {
      handleAgentEvent(base());
      handleAgentEvent(base({ event_type: 'stop' }));
      const secondStart = handleAgentEvent(base());
      const secondStop = handleAgentEvent(base({ event_type: 'stop' }));

      expect(rowById(secondStop.event.id).round).toBe(2);
      expect(secondStop.event.paired_start_id).toBe(secondStart.event.id);
    });

    it('stop with no open start -> duration_ms NULL and the response says so', () => {
      const result = handleAgentEvent(base({ event_type: 'stop' }));
      const row = rowById(result.event.id);

      expect(row.duration_ms).toBeNull();
      expect(row.round).toBe(1);
      expect(result.event.paired_start_id).toBeNull();
      expect(result.content[0].text).toContain('duration_ms NULL');
      expect(result.content[0].text).toContain('(no matching start — duration not computed)');
    });

    it('a second stop after a stop finds nothing (no double pairing)', () => {
      handleAgentEvent(base());
      const first = handleAgentEvent(base({ event_type: 'stop' }));
      const second = handleAgentEvent(base({ event_type: 'stop' }));

      expect(first.event.paired_start_id).not.toBeNull();
      expect(second.event.paired_start_id).toBeNull();
      expect(rowById(second.event.id).duration_ms).toBeNull();
      expect(second.content[0].text).toContain('no matching start');
    });

    it('error closes the open start exactly like stop', () => {
      const start = handleAgentEvent(base());
      const error = handleAgentEvent(base({ event_type: 'error', error_message: 'boom' }));
      const row = rowById(error.event.id);

      expect(error.event.paired_start_id).toBe(start.event.id);
      expect(typeof row.duration_ms).toBe('number');
      expect(row.error_message).toBe('boom');
      // Nothing is left open for a later stop to consume.
      expect(findOpenStart(db, 'inst-1', 'forger', 'FR-267')).toBeUndefined();
    });

    it('two briefs on one instance pair independently', () => {
      const startA = handleAgentEvent(base({ brief_id: 'FR-1' }));
      const startB = handleAgentEvent(base({ brief_id: 'FR-2' }));
      const stopB = handleAgentEvent(base({ brief_id: 'FR-2', event_type: 'stop' }));
      const stopA = handleAgentEvent(base({ brief_id: 'FR-1', event_type: 'stop' }));

      expect(stopB.event.paired_start_id).toBe(startB.event.id);
      expect(stopA.event.paired_start_id).toBe(startA.event.id);
      expect(rowById(startA.event.id).round).toBe(1);
      expect(rowById(startB.event.id).round).toBe(1);
    });

    it('brief-less events pair among themselves, never with a brief-keyed start', () => {
      handleAgentEvent(base({ brief_id: 'FR-1' }));
      const bare: AgentEventInput = { instance_id: 'inst-1', agent: 'forger', event_type: 'start', model_requested: 'm' };
      const bareStart = handleAgentEvent(bare);
      const bareStop = handleAgentEvent({ ...bare, event_type: 'stop' });

      expect(bareStop.event.paired_start_id).toBe(bareStart.event.id);
      expect(findOpenStart(db, 'inst-1', 'forger', 'FR-1')).toBeDefined(); // the brief-keyed start is still open
    });
  });

  // -------------------------------------------------------------------------
  // retry
  // -------------------------------------------------------------------------

  describe('retry', () => {
    it('is a marker: it never consumes an open start', () => {
      const start = handleAgentEvent(base());
      const retry = handleAgentEvent(base({ event_type: 'retry' }));
      const stop = handleAgentEvent(base({ event_type: 'stop' }));

      expect(rowById(retry.event.id)).toMatchObject({ event_type: 'retry', duration_ms: null, round: 1 });
      expect(retry.event.paired_start_id).toBeNull();
      expect(stop.event.paired_start_id).toBe(start.event.id);
    });

    it('between an error and the next start it reports the round in flight and the next start is round 2', () => {
      handleAgentEvent(base());
      handleAgentEvent(base({ event_type: 'error' }));
      const retry = handleAgentEvent(base({ event_type: 'retry' }));
      const next = handleAgentEvent(base());
      const stop = handleAgentEvent(base({ event_type: 'stop' }));

      expect(rowById(retry.event.id).round).toBe(1);
      expect(rowById(next.event.id).round).toBe(2);
      expect(stop.event.paired_start_id).toBe(next.event.id);
      expect(rowById(stop.event.id).round).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Exported helpers
  // -------------------------------------------------------------------------

  describe('findOpenStart / deriveRound', () => {
    const key = { project: 'igris-ai', brief_id: 'FR-267', instance_id: 'inst-1', agent: 'forger' };

    it('deriveRound: a start is 1 + prior starts; anything else is max(1, starts so far)', () => {
      expect(deriveRound(db, 'start', key)).toBe(1);
      expect(deriveRound(db, 'stop', key)).toBe(1);
      handleAgentEvent(base());
      expect(deriveRound(db, 'start', key)).toBe(2);
      expect(deriveRound(db, 'retry', key)).toBe(1);
      handleAgentEvent(base());
      expect(deriveRound(db, 'stop', key)).toBe(2);
    });

    it('findOpenStart returns the latest unclosed start and undefined once it is closed', () => {
      expect(findOpenStart(db, 'inst-1', 'forger', 'FR-267')).toBeUndefined();
      const start = handleAgentEvent(base());
      expect(findOpenStart(db, 'inst-1', 'forger', 'FR-267')?.id).toBe(start.event.id);
      handleAgentEvent(base({ event_type: 'stop' }));
      expect(findOpenStart(db, 'inst-1', 'forger', 'FR-267')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Readers
  // -------------------------------------------------------------------------

  it('handleAgentEventLog carries model_requested, model_resolved, round and project', () => {
    handleAgentEvent(base());
    const log = handleAgentEventLog({ instance_id: 'inst-1' });
    expect(log.count).toBe(1);
    expect(log.events[0]).toMatchObject({
      agent: 'forger',
      model_requested: 'claude-fable-5',
      model_resolved: null,
      round: 1,
      project: 'igris-ai',
    });
  });
});

// ---------------------------------------------------------------------------
// The tool wrapper: schema contract + bus emit + envelope shape
// ---------------------------------------------------------------------------

describe('igris_agent_event tool wrapper (FR-267)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  function agentEventTool() {
    const component = createInstancesComponent();
    const tool = component.tools().find((t) => t.name === 'igris_agent_event');
    expect(tool).toBeDefined();
    return { component, tool: tool! };
  }

  it('requires model_requested and has no duration_ms property (brain-computed)', () => {
    const { tool } = agentEventTool();
    expect(tool.inputSchema.required).toEqual(['instance_id', 'agent', 'event_type', 'model_requested']);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(tool.inputSchema.properties)).not.toContain('duration_ms');
    expect(Object.keys(tool.inputSchema.properties)).not.toContain('round');
    expect(Object.keys(tool.inputSchema.properties)).toEqual(
      expect.arrayContaining(['model_requested', 'model_resolved']),
    );
  });

  it('declares agent_event.recorded and emits it with the derived project after the row is written', async () => {
    const { component, tool } = agentEventTool();
    expect(component.events().emits.map((e) => e.name)).toContain('agent_event.recorded');

    const emit = vi.fn();
    const ctx = {
      storage: {},
      bus: { emit, on: vi.fn(), off: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      config: {},
    } as unknown as ComponentContext;
    component.init(ctx);

    const result = await tool.handler({
      instance_id: 'inst-1',
      agent: 'forger',
      event_type: 'start',
      model_requested: 'claude-fable-5',
      brief_id: 'FR-267',
    });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('agent_event.recorded', {
      instance_id: 'inst-1',
      agent: 'forger',
      event_type: 'start',
      brief_id: 'FR-267',
      project: 'igris-ai',
    });
    // The wire envelope carries the text only; the structured record stays internal.
    expect(result).not.toHaveProperty('event');
    expect(result.content[0].text).toMatch(/^Agent event recorded: forger start \(id: \d+, round 1, model claude-fable-5\)$/);
    // ...and the row is really there.
    expect((db.prepare('SELECT COUNT(*) AS c FROM agent_events').get() as { c: number }).c).toBe(1);
    component.destroy();
  });

  it('does not emit when the handler rejects the input', () => {
    const { component, tool } = agentEventTool();
    const emit = vi.fn();
    component.init({
      storage: {},
      bus: { emit, on: vi.fn(), off: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      config: {},
    } as unknown as ComponentContext);

    expect(() => tool.handler({ instance_id: 'inst-1', agent: 'forger', event_type: 'start' }))
      .toThrow(MODEL_REQUESTED_REQUIRED_MESSAGE);
    expect(emit).not.toHaveBeenCalled();
    component.destroy();
  });
});
