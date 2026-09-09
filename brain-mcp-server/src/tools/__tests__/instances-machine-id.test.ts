/**
 * BR-100 — `igris_instance_state` carries `machine_id` through the STRICT gateway.
 *
 * The gateway rejects any arg the tool schema does not declare
 * (`additionalProperties: false`, TD-128 reject-mode), so declaring
 * `machine_id` is not optional: an undeclared arg would be a loud refusal at
 * the door, not a stored NULL. Three cases:
 *   - declared + passed → accepted and STORED verbatim (the handler never
 *     derives — it also serves `POST /api/instances/state` from remote clients);
 *   - omitted → NULL (a legacy/remote caller keeps working; readers fall back
 *     to the alias list);
 *   - an UNDECLARED key on the same call → rejected (the control that proves
 *     the gate is in reject mode, so the first case is a declaration and not
 *     a permissive pass-through).
 *
 * @module tools/__tests__/instances-machine-id.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../db.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../../db.js';
import { createGateway } from '../../engine/gateway.js';
import { createInstancesComponent } from '../../engine/components/instances/index.js';

const mockedGetDb = getDb as ReturnType<typeof vi.fn>;

/** The `instances` table at the post-v5 shape (v9 base + FR-190 ALTERs + BR-100). */
function makeInstancesDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE instances (
      id TEXT PRIMARY KEY,
      machine_hostname TEXT NOT NULL,
      machine_os TEXT, project_slug TEXT, project_path TEXT,
      current_brief TEXT, current_phase TEXT, current_task TEXT,
      status TEXT DEFAULT 'active',
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

describe('BR-100 — igris_instance_state.machine_id through the strict gateway', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeInstancesDb();
    mockedGetDb.mockReturnValue(db);
  });

  afterEach(() => {
    db.close();
  });

  function gatewayWithInstances() {
    const gateway = createGateway();
    gateway.register(createInstancesComponent().tools());
    return gateway;
  }

  it('the tool schema DECLARES machine_id (additionalProperties:false makes an undeclared arg a rejection)', () => {
    const tool = createInstancesComponent().tools().find((t) => t.name === 'igris_instance_state')!;
    const schema = tool.inputSchema as { additionalProperties?: boolean; properties: Record<string, unknown>; required: string[] };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).toHaveProperty('machine_id');
    // Optional — a legacy or remote caller keeps working.
    expect(schema.required).not.toContain('machine_id');
    expect(schema.required).toEqual(['machine_hostname']);
  });

  it('passed → accepted at the gate and STORED verbatim; a later update carrying it keeps it', async () => {
    const gateway = gatewayWithInstances();
    const res = await gateway.dispatch('igris_instance_state', {
      machine_hostname: 'Mohameds-MacBook-Air-2',
      machine_id: 'my-machine-id',
      project_slug: 'p',
    });
    const id = /Instance registered: (\S+)/.exec(res.content[0].text)![1];
    const row = db.prepare('SELECT machine_hostname, machine_id FROM instances WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row).toEqual({ machine_hostname: 'Mohameds-MacBook-Air-2', machine_id: 'my-machine-id' });

    await gateway.dispatch('igris_instance_state', {
      instance_id: id,
      machine_hostname: 'Mohameds-MacBook-Air-2',
      machine_id: 'my-machine-id',
      current_phase: 'TESTING',
    });
    const after = db.prepare('SELECT current_phase, machine_id FROM instances WHERE id = ?').get(id) as Record<string, unknown>;
    expect(after).toEqual({ current_phase: 'TESTING', machine_id: 'my-machine-id' });
  });

  it('omitted → stored NULL (the legacy / remote posture; readers fall back to the alias list)', async () => {
    const gateway = gatewayWithInstances();
    const res = await gateway.dispatch('igris_instance_state', { machine_hostname: 'vps-host' });
    const id = /Instance registered: (\S+)/.exec(res.content[0].text)![1];
    const row = db.prepare('SELECT machine_id FROM instances WHERE id = ?').get(id) as { machine_id: unknown };
    expect(row.machine_id).toBeNull();
  });

  it('CONTROL — an UNDECLARED key on the same tool is rejected at the gate, so the acceptance above is a declaration', async () => {
    const gateway = gatewayWithInstances();
    await expect(
      gateway.dispatch('igris_instance_state', { machine_hostname: 'h', machine_identity: 'x' }),
    ).rejects.toThrow(/machine_identity/);
    expect((db.prepare('SELECT COUNT(*) AS n FROM instances').get() as { n: number }).n).toBe(0);
  });

  it('on a brain WITHOUT the column (pre-v5) the handler still registers; the arg is simply dropped', async () => {
    db.close();
    db = new Database(':memory:');
    db.exec(`CREATE TABLE instances (id TEXT PRIMARY KEY, machine_hostname TEXT NOT NULL, machine_os TEXT,
      project_slug TEXT, project_path TEXT, current_brief TEXT, current_phase TEXT, current_task TEXT,
      status TEXT DEFAULT 'active', last_activity_at TEXT)`);
    mockedGetDb.mockReturnValue(db);
    const gateway = gatewayWithInstances();
    const res = await gateway.dispatch('igris_instance_state', { machine_hostname: 'h', machine_id: 'X' });
    expect(res.content[0].text).toMatch(/Instance registered/);
    expect((db.prepare('SELECT COUNT(*) AS n FROM instances').get() as { n: number }).n).toBe(1);
  });
});
