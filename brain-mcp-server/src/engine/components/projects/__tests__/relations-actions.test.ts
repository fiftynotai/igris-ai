/**
 * FR-273 — the action layer (`relations/actions.ts`) called DIRECTLY, with no
 * gateway (plan §4.2 A-series). The CLI reaches this layer without the BR-080
 * gateway walk, so it re-validates presence, types and enums in-band.
 *
 *   - A1 `relateAction` without `to` → `ok:false` with an in-band presence
 *     message, never a throw;
 *   - A2 an unknown `action` enum value is refused (relate and kinds);
 *   - A3 `kinds add` without `meaning` is refused in-band;
 *   - A4 `IGRIS_RELATIONS_SEMANTIC=off` → `unavailable: disabled…` and the
 *     embedder is never called — even an injected one (the seam wins); a
 *     CONTROL with the seam unset calls it;
 *   - A5 the result key sets are stable (a snapshot of KEYS, not values);
 *   - plus: a pre-projects:3 DB is `not_migrated`, never a throw; lookup
 *     argument handling (depth clamp, bad depth/direction, alias kind filter).
 *
 * @module engine/components/projects/__tests__/relations-actions.test
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  bootRelationsDb,
  cleanupRelationsFixtures,
  seedGraph,
  tmpRoot,
} from './relations-fixture.js';
import {
  kindsAction,
  lookupAction,
  relateAction,
  resolveDefaultEmbed,
  RELATIONS_SEMANTIC_ENV,
} from '../relations/actions.js';

afterEach(() => {
  vi.restoreAllMocks();
  cleanupRelationsFixtures();
});

const DEPLOYS_TO = {
  action: 'add',
  name: 'deploys_to',
  meaning: "A is deployed onto B's hosting infrastructure",
  direction: 'A → B',
  forward_label: 'deploys to',
  inverse_label: 'hosts',
  example: 'x deploys_to y',
};

function seeded() {
  const db = bootRelationsDb();
  seedGraph(db, tmpRoot());
  return db;
}

describe('in-band validation (no gateway)', () => {
  it('A1: relate without `to` → ok:false, an in-band presence message, no throw', async () => {
    const db = seeded();
    const r = await relateAction(db, { action: 'declare', from: 'hadir', kind: 'calls_service' });
    expect(r.ok).toBe(false);
    expect(r.action).toBe('relate.declare');
    expect(r.refused).toMatchObject({ code: 'missing_argument' });
    expect(r.refused!.message).toMatch(/'to'/);
    const typed = await relateAction(db, { action: 'declare', from: 'hadir', kind: 'calls_service', to: 7 });
    expect(typed.refused).toMatchObject({ code: 'invalid_argument' });
    const notObject = await relateAction(db, null as unknown as Record<string, unknown>);
    expect(notObject.ok).toBe(false);
  });

  it('A2: an unknown action value is refused, naming the valid ones', async () => {
    const db = seeded();
    const r = await relateAction(db, { action: 'delete', from: 'a', kind: 'uses_package', to: 'b' });
    expect(r).toMatchObject({ ok: false, action: 'relate', refused: { code: 'invalid_argument' } });
    expect(r.refused!.message).toMatch(/declare.*remove/);
    const k = await kindsAction(db, { action: 'rename' });
    expect(k).toMatchObject({ ok: false, action: 'kinds', refused: { code: 'invalid_argument' } });
    expect(k.refused!.message).toMatch(/list.*add.*alias.*merge/);
    const missing = await kindsAction(db, {});
    expect(missing.refused).toMatchObject({ code: 'missing_argument' });
  });

  it('A3: kinds add without `meaning` is refused in-band; nothing written', async () => {
    const db = seeded();
    const { meaning: _m, ...noMeaning } = DEPLOYS_TO;
    const r = await kindsAction(db, noMeaning, { env: { [RELATIONS_SEMANTIC_ENV]: 'off' } });
    expect(r).toMatchObject({ ok: false, action: 'kinds.add', refused: { code: 'missing_argument' } });
    expect(r.refused!.message).toMatch(/'meaning'/);
    expect(db.prepare("SELECT 1 FROM project_relation_kinds WHERE name = 'deploys_to'").get()).toBeUndefined();
    const badAliases = await kindsAction(db, { ...DEPLOYS_TO, aliases: 'hosted_on' }, { env: { [RELATIONS_SEMANTIC_ENV]: 'off' } });
    expect(badAliases.refused).toMatchObject({ code: 'invalid_argument' });
  });

  it('A4: IGRIS_RELATIONS_SEMANTIC=off → unavailable: disabled…, the embedder never called; CONTROL: unset → called', async () => {
    const db = seeded();
    const spy = vi.fn(async () => [1, 0, 0]);
    const off = await kindsAction(db, DEPLOYS_TO, { embed: spy, env: { [RELATIONS_SEMANTIC_ENV]: 'off' } });
    expect(off.ok).toBe(true);
    expect(off.semantic_check).toBe('unavailable: disabled (IGRIS_RELATIONS_SEMANTIC=off)');
    expect(spy).not.toHaveBeenCalled();

    const db2 = seeded();
    const on = await kindsAction(db2, DEPLOYS_TO, { embed: spy, env: {} });
    expect(on.ok).toBe(true);
    expect(on.semantic_check).toBe('advisory');
    expect(spy).toHaveBeenCalled();

    expect(resolveDefaultEmbed({ [RELATIONS_SEMANTIC_ENV]: ' OFF ' })).toEqual({ embed: null, reason: 'disabled (IGRIS_RELATIONS_SEMANTIC=off)' });
    expect(typeof resolveDefaultEmbed({}).embed).toBe('function');
  });

  it('A5: the result key sets are stable', async () => {
    const db = seeded();
    const off = { env: { [RELATIONS_SEMANTIC_ENV]: 'off' } };
    expect(Object.keys(await lookupAction(db, { slug: 'hadir' }))).toEqual(['ok', 'action', 'data']);
    expect(Object.keys(await lookupAction(db, { slug: 'hadir', kind: 'nope_kind' }))).toEqual(['ok', 'action', 'refused']);
    expect(Object.keys(await relateAction(db, { action: 'declare', from: 'hadir', kind: 'calls', to: 'hadir-system' }))).toEqual(['ok', 'action', 'data']);
    expect(Object.keys(await relateAction(db, { action: 'remove', from: 'hadir', kind: 'uses_package', to: 'nobody' }))).toEqual(['ok', 'action', 'refused']);
    expect(Object.keys(await kindsAction(db, { action: 'list' }))).toEqual(['ok', 'action', 'data']);
    expect(Object.keys(await kindsAction(db, DEPLOYS_TO, off))).toEqual(['ok', 'action', 'data', 'semantic_check']);
    expect(Object.keys(await kindsAction(db, { ...DEPLOYS_TO, name: 'imports_code', meaning: "A imports B's code at compile time" }, off)))
      .toEqual(['ok', 'action', 'refused']);
    const d = await relateAction(db, { action: 'declare', from: 'moca-app', kind: 'supersedes', to: 'attendance_app' });
    expect(Object.keys(d.data as object)).toEqual(['outcome', 'changed', 'relation']);
  });
});

describe('lookupAction', () => {
  it('a pre-projects:3 DB is refused not_migrated — every action — never a throw', async () => {
    const db = bootRelationsDb({ maxVersion: 2 });
    for (const r of [
      await lookupAction(db, { slug: 'x' }),
      await relateAction(db, { action: 'declare', from: 'a', kind: 'uses_package', to: 'b' }),
      await kindsAction(db, { action: 'list' }),
    ]) {
      expect(r.ok).toBe(false);
      expect(r.refused).toMatchObject({ code: 'not_migrated' });
      expect(r.refused!.message).toMatch(/projects:3/);
    }
  });

  it('depth is clamped to 5; a bad depth or direction is refused; an alias kind filter resolves', async () => {
    const db = seeded();
    const deep = await lookupAction(db, { slug: 'moca-agent-web', depth: 9 });
    expect(deep.ok).toBe(true);
    expect((deep.data as { depth: number }).depth).toBe(5);
    for (const depth of [0, -1, 1.5, '2']) {
      const r = await lookupAction(db, { slug: 'moca-agent-web', depth });
      expect(r.refused, String(depth)).toMatchObject({ code: 'invalid_argument' });
    }
    expect((await lookupAction(db, { slug: 'x', direction: 'sideways' })).refused).toMatchObject({ code: 'invalid_argument' });
    const byAlias = await lookupAction(db, { slug: 'hadir', kind: 'client_of' });
    expect((byAlias.data as { kind: string }).kind).toBe('calls_service');
    const unknownKind = await lookupAction(db, { slug: 'hadir', kind: 'calls_api' });
    expect(unknownKind.refused).toMatchObject({ code: 'unknown_kind' });
    expect(unknownKind.refused!.closest![0]).toBe('calls_service');
    expect((await lookupAction(db, {})).refused).toMatchObject({ code: 'missing_argument' });
  });
});
