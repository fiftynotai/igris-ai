/**
 * FR-273 — the relation-kind registry core (`relations/kinds.ts`), plan §4.2
 * K-series. Every write is read back from the ROW with raw SQL.
 *
 *   - K1 `resolveKind`: canonical name, alias, folded notation, merged name
 *     (→ survivor), unknown (refused with `closest`);
 *   - K2 (AC2) `uses_packages` names `uses_package`; `calls_api` names `calls_service`;
 *   - K3 (AC3) a lexical near-duplicate is refused, naming `uses_package`;
 *   - K4 (AC3 CONTROL) a distinct `deploys_to` is accepted and read back;
 *   - K5 seed mutual acceptance: each seed re-proposed under a fresh name
 *     against the OTHER four is accepted (the gate cannot over-refuse);
 *   - K6/K7 an INJECTED semantic threshold refuses at/above and accepts below;
 *     K6b the shipped default is advisory (A0: no separating threshold);
 *   - K8 an unavailable embedder fails OPEN (`unavailable: …`) while a lexical
 *     duplicate is still refused;
 *   - K9 a name colliding with a name or an alias is refused;
 *   - K10 `alias` stores sorted, is idempotent, and refuses a collision;
 *   - K11 (AC4) merge: zero LIVE retired edges, tombstones kept, survivor rows
 *     live with detail keys unioned and no duplicate, kind `merged`, retired
 *     name aliased, a later declare under the retired name stores the survivor,
 *     and every touched row's `updated_at` bumped (LWW carries it);
 *   - K12 merge is idempotent; self-merge and an unknown survivor are refused;
 *   - K13 a lexical refusal never calls the embedder (cost rule, lexical first).
 *
 * @module engine/components/projects/__tests__/relations-kinds.test
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';

import {
  bootRelationsDb,
  cleanupRelationsFixtures,
  insertEdge,
  registerProject,
  tmpRoot,
} from './relations-fixture.js';
import {
  addKind,
  aliasKind,
  listKinds,
  mergeKinds,
  resolveKind,
  type EmbedFn,
} from '../relations/kinds.js';
import { declareRelation } from '../relations/write.js';
import { SEED_RELATION_KINDS } from '../relations/schema.js';
import { ADVISORY_ONLY, SEMANTIC_THRESHOLD } from '../relations/near-dup.js';

afterEach(() => {
  vi.restoreAllMocks();
  cleanupRelationsFixtures();
});

const OLD = '2000-01-01 00:00:00';

function kindRow(db: Database.Database, name: string): Record<string, string | null> | undefined {
  return db.prepare('SELECT * FROM project_relation_kinds WHERE name = ?').get(name) as Record<string, string | null> | undefined;
}

function edge(db: Database.Database, from: string, kind: string, to: string): Record<string, string | null> | undefined {
  return db.prepare('SELECT * FROM project_relations WHERE from_slug = ? AND kind = ? AND to_slug = ?')
    .get(from, kind, to) as Record<string, string | null> | undefined;
}

function kindCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM project_relation_kinds').get() as { n: number }).n;
}

const DEPLOYS_TO = {
  name: 'deploys_to',
  meaning: "A is deployed onto B's hosting infrastructure",
  direction: 'A → B: from = the deployed project, to = the host',
  forward_label: 'deploys to',
  inverse_label: 'hosts',
  example: 'moca-ai-agent deploys_to vps-infra',
};

/** An embedder that must never be called. */
const NEVER: EmbedFn = async () => { throw new Error('embed must not be called'); };

/** A stub embedder: a fixed vector per meaning, a default for anything else. */
function stubEmbed(map: Record<string, number[]>, fallback: number[] = [0, 0, 1]): EmbedFn {
  return async (text: string) => map[text] ?? fallback;
}

describe('resolveKind', () => {
  it('K1: canonical, alias, folded notation, merged name, and unknown', () => {
    const db = bootRelationsDb();
    expect(resolveKind(db, 'uses_package')).toMatchObject({ ok: true, via: 'name', kind: { name: 'uses_package' } });
    expect(resolveKind(db, 'depends_on_package')).toMatchObject({ ok: true, via: 'alias', kind: { name: 'uses_package' } });
    expect(resolveKind(db, ' Depends-On-Package ')).toMatchObject({ ok: true, via: 'alias', kind: { name: 'uses_package' } });
    db.prepare(
      "INSERT INTO project_relation_kinds (name, meaning, direction, forward_label, inverse_label, example, status, merged_into) " +
      "VALUES ('old_kind', 'm', 'd', 'f', 'i', 'e', 'merged', 'uses_package')",
    ).run();
    expect(resolveKind(db, 'old_kind')).toMatchObject({ ok: true, via: 'merged', kind: { name: 'uses_package' } });
    const unknown = resolveKind(db, 'frobnicates');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.closest.length).toBeGreaterThan(0);
  });

  it('K2 (AC2): an unknown kind names the closest registered kinds', () => {
    const db = bootRelationsDb();
    const a = resolveKind(db, 'uses_packages');
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.closest).toContain('uses_package');
      expect(a.closest[0]).toBe('uses_package');
    }
    const b = resolveKind(db, 'calls_api');
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.closest[0]).toBe('calls_service');
  });
});

describe('addKind — the near-duplicate gates', () => {
  it('K3 (AC3): a lexical near-duplicate is refused, naming uses_package; nothing is written', async () => {
    const db = bootRelationsDb();
    const r = await addKind(db, {
      ...DEPLOYS_TO,
      name: 'imports_code',
      meaning: "A imports B's code at compile time",
    }, { embed: null, unavailableReason: 'test' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refused.code).toBe('near_duplicate');
      expect(r.refused.existing).toBe('uses_package');
      expect(r.refused.gate).toBe('lexical-meaning');
      expect(r.refused.score).toBeGreaterThanOrEqual(0.5);
      expect(r.refused.message).toContain('uses_package');
      expect(r.refused.message).toMatch(/alias/);
    }
    expect(kindRow(db, 'imports_code')).toBeUndefined();
    expect(kindCount(db)).toBe(5);
  });

  it('K4 (AC3 CONTROL): a distinct deploys_to is accepted and the row reads back', async () => {
    const db = bootRelationsDb();
    const r = await addKind(db, { ...DEPLOYS_TO, aliases: ['hosted_on', 'deployed_on'] }, { embed: null, unavailableReason: 'disabled (test)' });
    expect(r.ok).toBe(true);
    expect(r.semantic_check).toBe('unavailable: disabled (test)');
    const row = kindRow(db, 'deploys_to')!;
    expect(row).toMatchObject({
      meaning: DEPLOYS_TO.meaning,
      direction: DEPLOYS_TO.direction,
      forward_label: 'deploys to',
      inverse_label: 'hosts',
      example: DEPLOYS_TO.example,
      aliases: 'deployed_on,hosted_on',
      status: 'active',
      merged_into: null,
    });
    expect(row.created_at).not.toBe('2026-09-29 00:00:00');
  });

  it('K5: each seed, re-proposed under a fresh name against the OTHER four, is accepted', async () => {
    for (const [i, seed] of SEED_RELATION_KINDS.entries()) {
      const db = bootRelationsDb();
      db.prepare('DELETE FROM project_relation_kinds WHERE name = ?').run(seed.name);
      const r = await addKind(db, {
        name: `probe_k${i}_zeta`,
        meaning: seed.meaning,
        direction: seed.direction,
        forward_label: seed.forward_label,
        inverse_label: seed.inverse_label,
        example: seed.example,
      }, { embed: stubEmbed({}), semanticThreshold: undefined });
      expect(r.ok, `${seed.name}: ${JSON.stringify(r)}`).toBe(true);
      expect(kindRow(db, `probe_k${i}_zeta`)).toBeDefined();
    }
  });

  const OUTMODES = {
    ...DEPLOYS_TO,
    name: 'outmodes',
    meaning: 'A renders B obsolete for users',
  };
  const supersedesMeaning = 'A replaces B';

  it('K6: an INJECTED semantic threshold refuses at/above it, naming the kind and its score', async () => {
    const db = bootRelationsDb();
    const embed = stubEmbed({ [OUTMODES.meaning]: [1, 0, 0], [supersedesMeaning]: [0.95, Math.sqrt(1 - 0.95 ** 2), 0] });
    const r = await addKind(db, OUTMODES, { embed, semanticThreshold: 0.9 });
    expect(r.ok).toBe(false);
    expect(r.semantic_check).toBe('refused');
    if (!r.ok) {
      expect(r.refused).toMatchObject({ code: 'near_duplicate', existing: 'supersedes', gate: 'semantic' });
      expect(r.refused.score).toBeCloseTo(0.95, 5);
      expect(r.refused.message).toContain('supersedes');
    }
    expect(kindRow(db, 'outmodes')).toBeUndefined();
  });

  it('K7: an injected threshold ABOVE the score accepts, and reports passed + the nearest kind', async () => {
    const db = bootRelationsDb();
    const embed = stubEmbed({ [OUTMODES.meaning]: [1, 0, 0], [supersedesMeaning]: [0.5, Math.sqrt(0.75), 0] });
    const r = await addKind(db, OUTMODES, { embed, semanticThreshold: 0.9 });
    expect(r.ok).toBe(true);
    expect(r.semantic_check).toBe('passed');
    if (r.ok) expect(r.data.semantic).toMatchObject({ nearest: 'supersedes' });
    expect(kindRow(db, 'outmodes')).toBeDefined();
  });

  it('K6b: the SHIPPED default is advisory — a high score is reported, never refused (A0)', async () => {
    expect(SEMANTIC_THRESHOLD).toBeNull();
    expect(ADVISORY_ONLY).toBe(true);
    const db = bootRelationsDb();
    const embed = stubEmbed({ [OUTMODES.meaning]: [1, 0, 0], [supersedesMeaning]: [0.99, Math.sqrt(1 - 0.99 ** 2), 0] });
    const r = await addKind(db, OUTMODES, { embed });
    expect(r.ok).toBe(true);
    expect(r.semantic_check).toBe('advisory');
    if (r.ok) {
      expect(r.data.semantic?.nearest).toBe('supersedes');
      expect(r.data.semantic?.score).toBeCloseTo(0.99, 5);
    }
  });

  it('K8: an unavailable embedder FAILS OPEN; a lexical duplicate is still refused', async () => {
    class EmbeddingsUnavailableError extends Error {
      constructor(reason: string) { super(`embeddings backend unavailable: ${reason}`); this.name = 'EmbeddingsUnavailableError'; }
    }
    const throwing: EmbedFn = async () => { throw new EmbeddingsUnavailableError('offline cold cache'); };
    const db = bootRelationsDb();
    const ok = await addKind(db, DEPLOYS_TO, { embed: throwing });
    expect(ok.ok).toBe(true);
    expect(ok.semantic_check).toMatch(/^unavailable: .*offline cold cache/);
    expect(kindRow(db, 'deploys_to')).toBeDefined();

    const dup = await addKind(db, { ...DEPLOYS_TO, name: 'imports_code', meaning: "A imports B's code at compile time" }, { embed: throwing });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.refused).toMatchObject({ code: 'near_duplicate', existing: 'uses_package' });
  });

  it('K9: a name colliding with a kind name or an alias is refused, naming the holder', async () => {
    const db = bootRelationsDb();
    const byAlias = await addKind(db, { ...DEPLOYS_TO, name: 'client_of' }, { embed: null });
    expect(byAlias.ok).toBe(false);
    if (!byAlias.ok) expect(byAlias.refused).toMatchObject({ code: 'name_collision', existing: 'calls_service' });
    const byName = await addKind(db, { ...DEPLOYS_TO, name: 'uses_package' }, { embed: null });
    expect(byName.ok).toBe(false);
    if (!byName.ok) expect(byName.refused).toMatchObject({ code: 'name_collision', existing: 'uses_package' });
    const lexName = await addKind(db, { ...DEPLOYS_TO, name: 'uses_packages' }, { embed: null });
    expect(lexName.ok).toBe(false);
    if (!lexName.ok) expect(lexName.refused).toMatchObject({ code: 'near_duplicate', existing: 'uses_package', gate: 'lexical-name' });
    const aliasOfOther = await addKind(db, { ...DEPLOYS_TO, aliases: ['replaces'] }, { embed: null });
    expect(aliasOfOther.ok).toBe(false);
    if (!aliasOfOther.ok) expect(aliasOfOther.refused).toMatchObject({ code: 'alias_collision', existing: 'supersedes' });
    expect(kindCount(db)).toBe(5);
  });

  it('K13: a lexical refusal never calls the embedder', async () => {
    const db = bootRelationsDb();
    const embed = vi.fn(NEVER);
    const r = await addKind(db, { ...DEPLOYS_TO, name: 'imports_code', meaning: "A imports B's code at compile time" }, { embed });
    expect(r.ok).toBe(false);
    expect(embed).not.toHaveBeenCalled();
  });
});

describe('aliasKind', () => {
  it('K10: stores sorted and bumps updated_at; idempotent; a collision is refused', () => {
    const db = bootRelationsDb();
    const r = aliasKind(db, { name: 'uses_package', alias: 'pulls_in' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.changed).toBe(true);
    const row = kindRow(db, 'uses_package')!;
    expect(row.aliases).toBe('depends_on_package,imports_package,pulls_in,uses');
    expect(row.updated_at).not.toBe('2026-09-29 00:00:00');

    const again = aliasKind(db, { name: 'uses_package', alias: 'pulls_in' });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.data.changed).toBe(false);

    const onAlias = aliasKind(db, { name: 'supersedes', alias: 'calls' });
    expect(onAlias.ok).toBe(false);
    if (!onAlias.ok) expect(onAlias.refused).toMatchObject({ code: 'alias_collision', existing: 'calls_service' });
    const onName = aliasKind(db, { name: 'supersedes', alias: 'variant_of' });
    expect(onName.ok).toBe(false);
    if (!onName.ok) expect(onName.refused).toMatchObject({ code: 'alias_collision', existing: 'variant_of' });
    expect(kindRow(db, 'supersedes')!.aliases).toBe('replaces,successor_of');
  });
});

describe('mergeKinds (AC4)', () => {
  async function mergeFixture(): Promise<Database.Database> {
    const db = bootRelationsDb();
    const added = await addKind(db, {
      name: 'rebrand_of',
      meaning: 'A is B rebranded for a specific customer',
      direction: 'A → B',
      forward_label: 'rebrands',
      inverse_label: 'rebranded as',
      example: 'x rebrand_of y',
      aliases: ['rebranded_build'],
    }, { embed: null });
    expect(added.ok).toBe(true);
    insertEdge(db, { from: 'x', kind: 'rebrand_of', to: 'y', detail: { note: 'a' } });
    insertEdge(db, { from: 'p', kind: 'rebrand_of', to: 'q', detail: { note: 'from-retired', ticket: 'R' } });
    insertEdge(db, { from: 'p', kind: 'white_label_of', to: 'q', detail: { ticket: '1' } });
    insertEdge(db, { from: 'm', kind: 'rebrand_of', to: 'n', provenance: 'derived' });
    insertEdge(db, { from: 'm', kind: 'white_label_of', to: 'n', removed_at: '2001-01-01 00:00:00' });
    insertEdge(db, { from: 'r', kind: 'rebrand_of', to: 's', removed_at: '2001-01-01 00:00:00' });
    db.prepare('UPDATE project_relations SET updated_at = ?').run(OLD);
    db.prepare('UPDATE project_relation_kinds SET updated_at = ? WHERE name IN (?, ?)').run(OLD, 'rebrand_of', 'white_label_of');
    return db;
  }

  it('K11: rewrites every live edge, keeps tombstones, unions detail, aliases the retired name, bumps updated_at', async () => {
    const db = await mergeFixture();
    const r = mergeKinds(db, { retired: 'rebrand_of', survivor: 'white_label_of' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toMatchObject({ retired: 'rebrand_of', survivor: 'white_label_of', rewritten: 3, tombstoned: 3, changed: true });

    // Zero LIVE edges on the retired name; the tombstones ARE the replication (#1067).
    expect((db.prepare("SELECT COUNT(*) AS n FROM project_relations WHERE kind = 'rebrand_of' AND removed_at IS NULL").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM project_relations WHERE kind = 'rebrand_of'").get() as { n: number }).n).toBe(4);
    for (const [f, t] of [['x', 'y'], ['p', 'q'], ['m', 'n']]) {
      const old = edge(db, f, 'rebrand_of', t)!;
      expect(old.removed_at).not.toBeNull();
      expect(old.updated_at).not.toBe(OLD);
    }
    // The pre-existing tombstone is untouched.
    expect(edge(db, 'r', 'rebrand_of', 's')!.updated_at).toBe(OLD);

    const xy = edge(db, 'x', 'white_label_of', 'y')!;
    expect(xy.removed_at).toBeNull();
    expect(JSON.parse(xy.detail!)).toEqual({ note: 'a' });
    const pq = edge(db, 'p', 'white_label_of', 'q')!;
    expect(pq.removed_at).toBeNull();
    expect(JSON.parse(pq.detail!)).toEqual({ note: 'from-retired', ticket: '1' }); // existing keys win
    expect(pq.updated_at).not.toBe(OLD);
    const mn = edge(db, 'm', 'white_label_of', 'n')!;
    expect(mn.removed_at).toBeNull(); // revived
    expect(mn.provenance).toBe('derived'); // never downgraded
    expect((db.prepare("SELECT COUNT(*) AS n FROM project_relations WHERE kind = 'white_label_of' AND from_slug = 'p'").get() as { n: number }).n).toBe(1);

    const retired = kindRow(db, 'rebrand_of')!;
    expect(retired).toMatchObject({ status: 'merged', merged_into: 'white_label_of' });
    expect(retired.updated_at).not.toBe(OLD);
    const survivor = kindRow(db, 'white_label_of')!;
    expect(survivor.aliases!.split(',')).toEqual(expect.arrayContaining(['rebrand_of', 'rebranded_build', 'white_label', 'branded_build_of']));
    expect(survivor.aliases!.split(',')).toEqual([...survivor.aliases!.split(',')].sort());
    expect(survivor.updated_at).not.toBe(OLD);

    // listKinds keeps the merged kind visible with its status.
    expect(listKinds(db).find((k) => k.name === 'rebrand_of')).toMatchObject({ status: 'merged', merged_into: 'white_label_of' });

    // A later declare with the retired name stores the survivor.
    const root = tmpRoot();
    registerProject(db, root, 'a-app');
    registerProject(db, root, 'b-app');
    const d = declareRelation(db, { from: 'a-app', kind: 'rebrand_of', to: 'b-app' });
    expect(d.ok).toBe(true);
    expect(edge(db, 'a-app', 'white_label_of', 'b-app')).toBeDefined();
    expect(edge(db, 'a-app', 'rebrand_of', 'b-app')).toBeUndefined();
  });

  it('K12: merge is idempotent; self-merge and an unknown survivor are refused', async () => {
    const db = await mergeFixture();
    expect(mergeKinds(db, { retired: 'rebrand_of', survivor: 'white_label_of' }).ok).toBe(true);
    const snapshot = JSON.stringify(db.prepare('SELECT * FROM project_relations ORDER BY id').all());
    const again = mergeKinds(db, { retired: 'rebrand_of', survivor: 'white_label_of' });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.data.changed).toBe(false);
    expect(JSON.stringify(db.prepare('SELECT * FROM project_relations ORDER BY id').all())).toBe(snapshot);

    const self = mergeKinds(db, { retired: 'variant_of', survivor: 'variant_of' });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.refused.code).toBe('self_merge');
    const selfViaAlias = mergeKinds(db, { retired: 'variant_of', survivor: 'subset_of' });
    expect(selfViaAlias.ok).toBe(false);
    if (!selfViaAlias.ok) expect(selfViaAlias.refused.code).toBe('self_merge');
    const unknown = mergeKinds(db, { retired: 'variant_of', survivor: 'white_labell_of' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.refused.code).toBe('unknown_kind');
      expect(unknown.refused.closest).toContain('white_label_of');
    }
    const unknownRetired = mergeKinds(db, { retired: 'nope_kind', survivor: 'variant_of' });
    expect(unknownRetired.ok).toBe(false);
    if (!unknownRetired.ok) expect(unknownRetired.refused.code).toBe('unknown_kind');
    expect(kindRow(db, 'variant_of')!.status).toBe('active');
  });
});

describe('addKind — concurrency (warden M10)', () => {
  it('a colliding kind added by another writer during the embed await is REFUSED in-band, never a thrown UNIQUE error', async () => {
    const db = bootRelationsDb();
    let raced = false;
    const racingEmbed: EmbedFn = async () => {
      if (!raced) {
        raced = true;
        db.prepare(
          "INSERT INTO project_relation_kinds (name, meaning, direction, forward_label, inverse_label, example) VALUES ('deploys_to', 'm', 'd', 'f', 'i', 'e')",
        ).run();
      }
      return [1, 0, 0];
    };
    const r = await addKind(db, DEPLOYS_TO, { embed: racingEmbed });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refused).toMatchObject({ code: 'name_collision', existing: 'deploys_to' });
    expect(kindCount(db)).toBe(6);
  });
});
