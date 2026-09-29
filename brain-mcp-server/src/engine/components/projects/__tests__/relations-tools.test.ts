/**
 * FR-273 — the three round-A MCP tools THROUGH `gateway.dispatch` (plan §4.2
 * T-series). The component is registered on a real gateway; `getDb` is mocked
 * to a fixture DB (the register.test.ts idiom, with `migrateSchema` kept real).
 *
 *   - T1 a missing `to` gets the BR-080 gateway message (the handler never runs);
 *   - T2 an extra key is rejected (strict-input contract);
 *   - T3 `kinds add` without `meaning` gets the ACTION LAYER's in-band message
 *     (`required` is `['action']` — JSON Schema cannot express per-action keys);
 *   - T4 every write that CHANGED a row emits `project.relation_changed` exactly
 *     once; a refusal, a no-op re-declare and every read emit nothing;
 *   - T5 the handlers are THIN: the text equals `JSON.stringify(await
 *     <action>(db, sameArgs))` and `isError === !ok`.
 *
 * `IGRIS_RELATIONS_SEMANTIC=off` is set for the whole file (restored after), so
 * a `kinds add` through the real default embedder can never load the model.
 *
 * @module engine/components/projects/__tests__/relations-tools.test
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('../../../../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../db.js')>();
  return { ...actual, getDb: vi.fn() };
});

import { getDb } from '../../../../db.js';
import { createGateway } from '../../../gateway.js';
import { createProjectsComponent } from '../index.js';
import type { ComponentContext, EventBus } from '../../../types.js';
import {
  bootRelationsDb,
  cleanupRelationsFixtures,
  seedGraph,
  tmpRoot,
} from './relations-fixture.js';
import { kindsAction, lookupAction, relateAction } from '../relations/actions.js';

const mockedGetDb = vi.mocked(getDb);
let savedSemantic: string | undefined;

beforeAll(() => {
  savedSemantic = process.env.IGRIS_RELATIONS_SEMANTIC;
  process.env.IGRIS_RELATIONS_SEMANTIC = 'off';
});
afterAll(() => {
  if (savedSemantic === undefined) delete process.env.IGRIS_RELATIONS_SEMANTIC;
  else process.env.IGRIS_RELATIONS_SEMANTIC = savedSemantic;
});
afterEach(() => cleanupRelationsFixtures());

interface Rig {
  db: Database.Database;
  dispatch: (name: string, args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  emitted: { event: string; data: Record<string, unknown> }[];
}

function rig(root: string = tmpRoot()): Rig {
  const db = bootRelationsDb();
  seedGraph(db, root);
  mockedGetDb.mockReturnValue(db as unknown as ReturnType<typeof getDb>);
  const emitted: Rig['emitted'] = [];
  const bus: EventBus = { on: () => {}, off: () => {}, emit: (event, data) => { emitted.push({ event, data }); } };
  const comp = createProjectsComponent();
  comp.init({ bus, log: { info: () => {}, warn: () => {}, error: () => {} } } as unknown as ComponentContext);
  const gw = createGateway();
  gw.register(comp.tools());
  return {
    db,
    emitted,
    dispatch: (name, args) => gw.dispatch(name, args) as Promise<{ content: { text: string }[]; isError?: boolean }>,
  };
}

const DEPLOYS_TO = {
  action: 'add',
  name: 'deploys_to',
  meaning: "A is deployed onto B's hosting infrastructure",
  direction: 'A → B',
  forward_label: 'deploys to',
  inverse_label: 'hosts',
  example: 'x deploys_to y',
};

describe('the three round-A tools through gateway.dispatch', () => {
  it('registers exactly the four relation tools with the planned `required` lists', () => {
    const tools = Object.fromEntries(createProjectsComponent().tools().map((t) => [t.name, t]));
    expect(tools.igris_project_relations.inputSchema.required).toEqual(['slug']);
    expect(tools.igris_project_relate.inputSchema.required).toEqual(['action', 'from', 'kind', 'to']);
    expect(tools.igris_project_relation_kinds.inputSchema.required).toEqual(['action']);
    expect(tools.igris_project_relations_derive.inputSchema.required).toEqual(['slug']);
    for (const n of ['igris_project_relations', 'igris_project_relate', 'igris_project_relation_kinds', 'igris_project_relations_derive']) {
      expect(tools[n].inputSchema.additionalProperties, n).toBe(false);
    }
  });

  it('T1: a missing `to` gets the BR-080 message', async () => {
    const { dispatch } = rig();
    await expect(dispatch('igris_project_relate', { action: 'declare', from: 'hadir', kind: 'calls_service' }))
      .rejects.toThrow(/igris_project_relate: missing required argument 'to'.*BR-080/);
  });

  it('T2: an extra key is rejected', async () => {
    const { dispatch } = rig();
    await expect(dispatch('igris_project_relations', { slug: 'hadir', bogus: 1 }))
      .rejects.toThrow(/igris_project_relations: unknown argument 'bogus'/);
  });

  it('T3: kinds add without `meaning` gets the action layer\'s in-band message', async () => {
    const { dispatch, db } = rig();
    const { meaning: _m, ...noMeaning } = DEPLOYS_TO;
    const r = await dispatch('igris_project_relation_kinds', noMeaning);
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body).toMatchObject({ ok: false, action: 'kinds.add', refused: { code: 'missing_argument' } });
    expect(body.refused.message).toMatch(/'meaning'/);
    expect(db.prepare("SELECT 1 FROM project_relation_kinds WHERE name = 'deploys_to'").get()).toBeUndefined();
  });

  it('T4: each CHANGED write emits project.relation_changed exactly once; refusals, no-ops and reads emit nothing', async () => {
    const { dispatch, emitted } = rig();
    const count = (): number => emitted.filter((e) => e.event === 'project.relation_changed').length;
    const steps: [string, Record<string, unknown>, number][] = [
      ['igris_project_relate', { action: 'declare', from: 'moca-app', kind: 'supersedes', to: 'attendance_app' }, 1],
      ['igris_project_relate', { action: 'declare', from: 'moca-app', kind: 'supersedes', to: 'attendance_app' }, 0], // no-op
      ['igris_project_relate', { action: 'declare', from: 'moca-app', kind: 'nope_kind', to: 'attendance_app' }, 0], // refused
      ['igris_project_relate', { action: 'remove', from: 'moca-app', kind: 'supersedes', to: 'attendance_app' }, 1],
      ['igris_project_relate', { action: 'remove', from: 'moca-app', kind: 'supersedes', to: 'attendance_app' }, 0], // tombstone no-op
      ['igris_project_relation_kinds', DEPLOYS_TO, 1],
      ['igris_project_relation_kinds', { action: 'alias', name: 'deploys_to', alias: 'hosted_on' }, 1],
      ['igris_project_relation_kinds', { action: 'alias', name: 'deploys_to', alias: 'hosted_on' }, 0],
      ['igris_project_relation_kinds', { action: 'merge', retired: 'deploys_to', survivor: 'calls_service' }, 1],
      ['igris_project_relation_kinds', { action: 'list' }, 0],
      ['igris_project_relations', { slug: 'hadir' }, 0],
      ['igris_project_relations_derive', { slug: 'hadir' }, 0], // a suggestion is not a relation
    ];
    for (const [tool, args, delta] of steps) {
      const before = count();
      await dispatch(tool, args);
      expect(count() - before, `${tool} ${JSON.stringify(args)}`).toBe(delta);
    }
    expect(emitted.every((e) => e.event === 'project.relation_changed')).toBe(true);
    expect(emitted[0].data).toMatchObject({ action: 'relate.declare' });
  });

  it('T5: the handlers are thin — text === JSON.stringify(action(db, sameArgs)), isError === !ok', async () => {
    const strip = (s: string): string => JSON.stringify(JSON.parse(s), (k, v) => (k === 'created_at' || k === 'updated_at' ? undefined : v));
    const cases: [string, Record<string, unknown>, (db: Database.Database, a: Record<string, unknown>) => Promise<unknown>][] = [
      ['igris_project_relations', { slug: 'moca-agent-web', depth: 2 }, lookupAction],
      ['igris_project_relations', { slug: 'hadir', kind: 'nope_kind' }, lookupAction],
      ['igris_project_relate', { action: 'declare', from: 'moca-app', kind: 'replaces', to: 'attendance_app', detail: { note: 'n' } }, relateAction],
      ['igris_project_relate', { action: 'declare', from: 'ghost', kind: 'supersedes', to: 'hadir' }, relateAction],
      ['igris_project_relation_kinds', { action: 'list' }, kindsAction],
      ['igris_project_relation_kinds', DEPLOYS_TO, kindsAction],
    ];
    for (const [tool, args, action] of cases) {
      // Two identical fixtures over ONE project root (so the paths match):
      // a write case must not see the other caller's row.
      const root = tmpRoot();
      const viaTool = rig(root);
      const r = await viaTool.dispatch(tool, { ...args });
      const direct = rig(root);
      const expected = JSON.stringify(await action(direct.db, { ...args }));
      expect(strip(r.content[0].text), tool).toBe(strip(expected));
      expect(r.isError === true, tool).toBe(!(JSON.parse(expected) as { ok: boolean }).ok);
    }
  });
});
