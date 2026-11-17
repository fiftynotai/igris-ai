/**
 * TD-494 AC5 — `igris_instance_state` is a PARTIAL update: an omitted field
 * leaves the stored value as it was, and `''` is the explicit clear.
 *
 * Before TD-494 the conflict arm of `handleInstanceState`
 * (`src/tools/instances.ts`) set every caller-suppliable column to
 * `excluded.x`, and the insert binds were `args.x ?? null`. So a call that
 * omitted a field wrote NULL over it: 15 columns in all (6 core plus 9
 * optional), not just the five AC5 names. A `/hunt`-style state call that
 * carried only the phase wiped `current_brief`, `project_slug` and
 * `project_path`, and one that omitted `owner_pid` demoted a CLI-registered
 * row to `unknown_no_metadata`.
 *
 * The decision (PLAN §4) is partial: `x = COALESCE(excluded.x, instances.x)`
 * for every caller-suppliable column except the required `machine_hostname`;
 * `status`, `last_activity_at` and `state_updated_at` stay server-stamped;
 * the insert binds are unchanged, so a fresh row still gets NULLs; and `''`
 * clears a text field (NULL now means "leave unchanged", so it cannot also
 * mean "clear").
 *
 *   P1  a full row, then {instance_id, machine_hostname, current_phase}
 *       → current_brief, current_task, project_slug, project_path unchanged.
 *   P2  `''` clears current_brief, current_phase and current_task (stored as
 *       `''`, the one "no brief" value — not NULL).
 *   P3  omitted owner_pid, lease_expires_at, harness_session_id and
 *       machine_id are preserved.
 *   P3b every one of the 15 caller-suppliable columns (the schema's
 *       properties minus instance_id and machine_hostname, pinned against
 *       the schema) is preserved by a minimal call.
 *   P4  a fresh insert with omissions gives NULLs (minted id and caller id),
 *       and inherits nothing from another row.
 *   P5  machine_hostname is still overwritten; status, last_activity_at and
 *       state_updated_at are still server-stamped.
 *   P6  source pin: the conflict arm carries the decision comment; P6b the
 *       tool description documents the partial semantics and the `''` clear.
 *
 * Every case reads the row BEFORE and AFTER the call through the same
 * in-memory DB, and every "unchanged" assertion first proves the before-value
 * was non-NULL, so an equality can never pass vacuously on a seed that stored
 * nothing.
 *
 * Harness: the `instances-machine-id.test.ts` shape — `getDb` mocked onto an
 * in-memory better-sqlite3 handle with the post-v5 `instances` DDL, and the
 * call dispatched through `createGateway` + `createInstancesComponent`, so the
 * strict input schema (TD-128 reject-mode, BR-080 required walk) is exercised.
 *
 * Red on HEAD 5247c5a: P1, P3, P3b (fields nulled) and P6, P6b (no decision
 * comment, no documented clear). Green on HEAD: P2, P4, P5.
 *
 * @module tools/__tests__/instances-partial-update.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

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
import { createGateway } from '../../engine/gateway.js';
import { createInstancesComponent } from '../../engine/components/instances/index.js';

const mockedGetDb = vi.mocked(getDb);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The `instances` table at the post-v5 shape: the FR-190 v2 CREATE (with its
 * status CHECK, and `last_activity_at` already renamed so the activity-column
 * helper has nothing to do), the FR-190 ALTERs, and BR-100's `machine_id`.
 */
function makeInstancesDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE instances (
      id TEXT PRIMARY KEY,
      machine_hostname TEXT NOT NULL,
      machine_os TEXT, project_slug TEXT, project_path TEXT,
      current_brief TEXT, current_phase TEXT, current_task TEXT,
      status TEXT DEFAULT 'active' CHECK (status IN ('active', 'idle', 'stale')),
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT DEFAULT '{}',
      harness TEXT, harness_session_id TEXT, owner_pid INTEGER, owner_started_at TEXT,
      liveness_method TEXT, liveness_status TEXT, liveness_checked_at TEXT,
      lease_expires_at TEXT, state_updated_at TEXT,
      machine_id TEXT
    );
  `);
  return db;
}

/**
 * The 15 caller-suppliable columns PLAN §4 puts under COALESCE: every schema
 * property except `instance_id` (the key) and `machine_hostname` (required,
 * still overwritten). P3b pins this list against the live tool schema, so a
 * property added later without a partial-update decision reds that case.
 */
const PARTIAL_COLUMNS = [
  'machine_os',
  'project_slug',
  'project_path',
  'current_brief',
  'current_phase',
  'current_task',
  'harness',
  'harness_session_id',
  'owner_pid',
  'owner_started_at',
  'liveness_method',
  'liveness_status',
  'liveness_checked_at',
  'lease_expires_at',
  'machine_id',
] as const;

/** A row with every caller-suppliable column set to a non-NULL value. */
const FULL = {
  machine_hostname: 'host-a',
  machine_os: 'darwin',
  project_slug: 'igris-ai',
  project_path: '/Users/someone/StudioProjects/igris-ai',
  current_brief: 'TD-494',
  current_phase: 'BUILDING',
  current_task: 'writing P1-P6',
  harness: 'claude',
  harness_session_id: 'harness-session-123',
  owner_pid: 4242,
  owner_started_at: 'Tue Nov 17 10:00:00 2026',
  liveness_method: 'pid_start_time',
  liveness_status: 'alive',
  liveness_checked_at: '2026-11-17 10:00:00',
  lease_expires_at: '2099-01-01 00:00:00',
  machine_id: 'machine-abc',
} as const;

const ID = 'td494-instance-a';

type Row = Record<string, unknown>;

function pick(row: Row, keys: readonly string[]): Row {
  return Object.fromEntries(keys.map((k) => [k, row[k]]));
}

function expected(keys: readonly string[]): Row {
  return pick(FULL as unknown as Row, keys);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('TD-494 AC5 — igris_instance_state is a partial update (COALESCE; \'\' clears)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeInstancesDb();
    mockedGetDb.mockReturnValue(db);
  });

  afterEach(() => {
    db.close();
  });

  function gateway() {
    const gw = createGateway();
    gw.register(createInstancesComponent().tools());
    return gw;
  }

  async function state(args: Record<string, unknown>): Promise<string> {
    const res = await gateway().dispatch('igris_instance_state', args);
    return res.content[0].text as string;
  }

  function readRow(id: string): Row {
    const row = db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as Row | undefined;
    expect(row, `row ${id} exists`).toBeDefined();
    return row!;
  }

  /** Seed a full row through the same door, and prove every column landed non-NULL. */
  async function seedFull(id = ID): Promise<Row> {
    await state({ instance_id: id, ...FULL });
    const before = readRow(id);
    expect(pick(before, PARTIAL_COLUMNS)).toEqual(expected(PARTIAL_COLUMNS));
    return before;
  }

  it('P1 — {instance_id, machine_hostname, current_phase} leaves current_brief, current_task, project_slug and project_path unchanged (4 fields)', async () => {
    const KEPT = ['current_brief', 'current_task', 'project_slug', 'project_path'] as const;
    const before = await seedFull();
    expect(pick(before, KEPT)).toEqual(expected(KEPT));

    await state({ instance_id: ID, machine_hostname: 'host-a', current_phase: 'REVIEWING' });

    const after = readRow(ID);
    expect(pick(after, KEPT)).toEqual(pick(before, KEPT));
    // The supplied field still lands.
    expect(after.current_phase).toBe('REVIEWING');
  });

  it("P2 — '' clears current_brief, current_phase and current_task, stored as '' (the one no-brief value), not NULL", async () => {
    const CLEARED = ['current_brief', 'current_phase', 'current_task'] as const;
    const before = await seedFull();
    expect(pick(before, CLEARED)).toEqual(expected(CLEARED));

    await state({
      instance_id: ID,
      machine_hostname: 'host-a',
      current_brief: '',
      current_phase: '',
      current_task: '',
    });

    const after = readRow(ID);
    expect(pick(after, CLEARED)).toEqual({ current_brief: '', current_phase: '', current_task: '' });
  });

  it('P3 — omitted owner_pid, lease_expires_at, harness_session_id and machine_id are preserved by a brief/phase/task call (4 fields)', async () => {
    const KEPT = ['owner_pid', 'lease_expires_at', 'harness_session_id', 'machine_id'] as const;
    const before = await seedFull();
    expect(pick(before, KEPT)).toEqual(expected(KEPT));

    // The shape of a /hunt transition over MCP: brief, phase and task only.
    await state({
      instance_id: ID,
      machine_hostname: 'host-a',
      current_brief: 'TD-494',
      current_phase: 'TESTING',
      current_task: 'running P1-P6',
    });

    const after = readRow(ID);
    expect(pick(after, KEPT)).toEqual(pick(before, KEPT));
    expect(after.current_phase).toBe('TESTING');
  });

  it('P3b — all 15 caller-suppliable columns (schema properties minus instance_id and machine_hostname) survive a minimal {instance_id, machine_hostname} call', async () => {
    const tool = createInstancesComponent().tools().find((t) => t.name === 'igris_instance_state')!;
    const props = Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties)
      .filter((k) => k !== 'instance_id' && k !== 'machine_hostname')
      .sort();
    expect(props).toEqual([...PARTIAL_COLUMNS].sort());
    expect(PARTIAL_COLUMNS).toHaveLength(15);

    const before = await seedFull();

    await state({ instance_id: ID, machine_hostname: 'host-a' });

    const after = readRow(ID);
    expect(pick(after, PARTIAL_COLUMNS)).toEqual(pick(before, PARTIAL_COLUMNS));
  });

  it('P4 — a fresh insert with omissions stores NULL in all 15 columns (minted id and caller id), inheriting nothing from another row', async () => {
    // Another fully populated row exists; a fresh row must not borrow from it.
    await seedFull('td494-other-row');

    const minted = await state({ machine_hostname: 'host-fresh' });
    const mintedId = /Instance registered: (\S+)/.exec(minted)![1];
    await state({ instance_id: 'td494-fresh-caller-id', machine_hostname: 'host-fresh' });

    const nulls = Object.fromEntries(PARTIAL_COLUMNS.map((c) => [c, null]));
    for (const id of [mintedId, 'td494-fresh-caller-id']) {
      const row = readRow(id);
      expect(pick(row, PARTIAL_COLUMNS), id).toEqual(nulls);
      expect(row.machine_hostname, id).toBe('host-fresh');
      expect(row.status, id).toBe('active');
      expect(row.last_activity_at, id).not.toBeNull();
      expect(row.state_updated_at, id).not.toBeNull();
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM instances').get() as { n: number }).n).toBe(3);
  });

  it('P5 — machine_hostname is still overwritten; status, last_activity_at and state_updated_at are still server-stamped', async () => {
    await seedFull();
    db.prepare(
      "UPDATE instances SET status = 'idle', last_activity_at = '2020-01-01 00:00:00', state_updated_at = '2020-01-01 00:00:00' WHERE id = ?",
    ).run(ID);
    const before = readRow(ID);
    expect(pick(before, ['machine_hostname', 'status', 'last_activity_at', 'state_updated_at'])).toEqual({
      machine_hostname: 'host-a',
      status: 'idle',
      last_activity_at: '2020-01-01 00:00:00',
      state_updated_at: '2020-01-01 00:00:00',
    });

    await state({ instance_id: ID, machine_hostname: 'host-b' });

    const after = readRow(ID);
    expect(after.machine_hostname).toBe('host-b');
    expect(after.status).toBe('active');
    expect(after.last_activity_at).not.toBe('2020-01-01 00:00:00');
    expect(after.state_updated_at).not.toBe('2020-01-01 00:00:00');
  });

  it("P6 — source pin: handleInstanceState's conflict arm carries the TD-494 decision comment (partial, COALESCE, '' clears)", () => {
    const src = readFileSync(new URL('../instances.ts', import.meta.url), 'utf8');
    const start = src.indexOf('function handleInstanceState(');
    expect(start, 'handleInstanceState is defined in tools/instances.ts').toBeGreaterThanOrEqual(0);
    // The function ends at the next top-level JSDoc, function or export.
    const rest = src.slice(start + 1);
    const ends = ['\n/**', '\nfunction ', '\nexport ']
      .map((m) => rest.indexOf(m))
      .filter((i) => i >= 0);
    const body = src.slice(start, ends.length ? start + 1 + Math.min(...ends) : src.length);
    // Control: the extractor captured the function and its conflict arm, so
    // "no comment found" below is a measurement, not an empty slice.
    expect(body).toMatch(/ON CONFLICT\(id\) DO UPDATE/);

    const comments = [
      ...(body.match(/\/\/[^\n]*/g) ?? []),
      ...(body.match(/\/\*[\s\S]*?\*\//g) ?? []),
    ].join('\n');
    expect(comments, 'a comment inside handleInstanceState names TD-494').toMatch(/TD-494/);
    expect(comments, 'it records the decision: partial').toMatch(/partial/i);
    expect(comments, 'it names the mechanism: COALESCE').toMatch(/COALESCE/);
    expect(comments, "it documents the clear: ''").toContain("''");
  });

  it("P6b — the igris_instance_state tool description documents the partial semantics and the '' clear", () => {
    const tool = createInstancesComponent().tools().find((t) => t.name === 'igris_instance_state')!;
    expect(tool.description).toMatch(/partial|omitted|omit/i);
    expect(tool.description).toMatch(/''|""/);
  });
});
