/**
 * FR-273 D8 — the project-relation tables REPLICATE (plan §4.2 R-series). Two
 * real brain DBs, the REAL `mergeRows` and the REAL `SYNC_TABLES` entries —
 * no hand-built config. "Push A→B" selects every row of a table through the
 * entry's `columns` (what `flushBatch` / `/sync/push` send) and merges it
 * into B, exactly as the receiving `/sync/push` does.
 *
 *   - R1 an edge declared on A is live on B;
 *   - R2 a removal on A tombstones the edge on B (sync is upsert-only, #1067:
 *     the tombstone IS the replication);
 *   - R3 a merge on A leaves zero LIVE retired edges on B and the kind merged;
 *   - R4 aliases added separately on two replicas UNION on the replica that
 *     receives the NEWER row (`mergeFields: {aliases: 'merge_tags'}`) instead
 *     of last-writer-wins overwriting — and the measured residual is pinned:
 *     the replica holding the newest row does not receive the older alias
 *     until that kind row is written again elsewhere (LWW skips an older or
 *     equal row, so `merge_tags` never runs there);
 *   - R5 `processSyncPush` into a DB lacking the tables names both in
 *     `skipped` and reports `ok: false` (BR-097's per-table hold);
 *   - R6 every new `SYNC_TABLES` column exists in the projects:3 DDL, and the
 *     entries are APPENDED after `dismissed_patterns` (kinds first).
 *
 * Timestamps: `datetime('now')` has one-second resolution, so a test that
 * needs "later" backdates the earlier state explicitly rather than sleeping.
 *
 * @module tools/__tests__/sync-relations.test
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { SYNC_TABLES, mergeRows, processSyncPush } from '../sync.js';
import {
  bootRelationsDb,
  cleanupRelationsFixtures,
  registerProject,
  tmpRoot,
} from '../../engine/components/projects/__tests__/relations-fixture.js';
import { declareRelation, removeRelation } from '../../engine/components/projects/relations/write.js';
import { addKind, aliasKind, mergeKinds } from '../../engine/components/projects/relations/kinds.js';
import { RELATION_TABLES_SQL } from '../../engine/components/projects/relations/schema.js';

afterEach(() => {
  vi.restoreAllMocks();
  cleanupRelationsFixtures();
});

const TABLES = ['project_relation_kinds', 'project_relations'] as const;
const OLD = '2020-01-01 00:00:00';

function config(table: string) {
  const c = SYNC_TABLES.find((t) => t.table === table);
  if (c === undefined) throw new Error(`${table} is not in SYNC_TABLES`);
  return c;
}

/** Replicate both relation tables A → B through the real config + mergeRows. */
function push(a: Database.Database, b: Database.Database): void {
  for (const t of TABLES) {
    const c = config(t);
    const rows = a.prepare(`SELECT ${c.columns.join(', ')} FROM ${t}`).all() as Record<string, unknown>[];
    const r = b.transaction(() => mergeRows(b, c, rows))();
    expect(r.failed, `${t}: ${JSON.stringify(r.failures)}`).toBe(0);
  }
}

/** Two brains sharing the same registered projects (paths are per-machine). */
function pair(): { a: Database.Database; b: Database.Database } {
  const a = bootRelationsDb();
  const b = bootRelationsDb();
  for (const db of [a, b]) {
    const root = tmpRoot();
    for (const s of ['moca-agent-web', 'moca-agent-flutter-client', 'hadir', 'fya-hadir-app']) registerProject(db, root, s);
  }
  return { a, b };
}

function backdate(...dbs: Database.Database[]): void {
  for (const db of dbs) {
    db.prepare('UPDATE project_relations SET updated_at = ?').run(OLD);
    db.prepare("UPDATE project_relation_kinds SET updated_at = ? WHERE updated_at != '2026-09-29 00:00:00'").run(OLD);
  }
}

function edge(db: Database.Database, from: string, kind: string, to: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM project_relations WHERE from_slug = ? AND kind = ? AND to_slug = ?').get(from, kind, to) as Record<string, unknown> | undefined;
}

function aliasesOf(db: Database.Database, name: string): string[] {
  return String((db.prepare('SELECT aliases FROM project_relation_kinds WHERE name = ?').get(name) as { aliases: string }).aliases).split(',');
}

describe('project relations replicate (D8)', () => {
  it('R1: an edge declared on A is live on B', () => {
    const { a, b } = pair();
    expect(declareRelation(a, { from: 'moca-agent-web', kind: 'uses', to: 'moca-agent-flutter-client', detail: { ref: 'v2.0.0' } }).ok).toBe(true);
    push(a, b);
    const e = edge(b, 'moca-agent-web', 'uses_package', 'moca-agent-flutter-client')!;
    expect(e).toMatchObject({ removed_at: null, provenance: 'declared' });
    expect(JSON.parse(String(e.detail))).toEqual({ ref: 'v2.0.0' });
  });

  it('R2: a removal on A tombstones the edge on B', () => {
    const { a, b } = pair();
    declareRelation(a, { from: 'hadir', kind: 'supersedes', to: 'fya-hadir-app' });
    push(a, b);
    backdate(a, b);
    expect(removeRelation(a, { from: 'hadir', kind: 'supersedes', to: 'fya-hadir-app' }).ok).toBe(true);
    push(a, b);
    const e = edge(b, 'hadir', 'supersedes', 'fya-hadir-app')!;
    expect(e).toBeDefined();
    expect(e.removed_at).not.toBeNull();
  });

  it('R3: a merge on A leaves ZERO live retired edges on B and the kind merged', async () => {
    const { a, b } = pair();
    expect((await addKind(a, {
      name: 'rebrand_of', meaning: 'A is B rebranded for a specific customer', direction: 'A → B',
      forward_label: 'rebrands', inverse_label: 'rebranded as', example: 'x rebrand_of y',
    }, { embed: null })).ok).toBe(true);
    declareRelation(a, { from: 'fya-hadir-app', kind: 'rebrand_of', to: 'hadir' });
    push(a, b);
    expect(edge(b, 'fya-hadir-app', 'rebrand_of', 'hadir')).toMatchObject({ removed_at: null });
    backdate(a, b);
    expect(mergeKinds(a, { retired: 'rebrand_of', survivor: 'white_label_of' }).ok).toBe(true);
    push(a, b);
    expect((b.prepare("SELECT COUNT(*) AS n FROM project_relations WHERE kind = 'rebrand_of' AND removed_at IS NULL").get() as { n: number }).n).toBe(0);
    expect(edge(b, 'fya-hadir-app', 'rebrand_of', 'hadir')!.removed_at).not.toBeNull();
    expect(edge(b, 'fya-hadir-app', 'white_label_of', 'hadir')).toMatchObject({ removed_at: null });
    expect(b.prepare("SELECT status, merged_into FROM project_relation_kinds WHERE name = 'rebrand_of'").get())
      .toEqual({ status: 'merged', merged_into: 'white_label_of' });
    expect(aliasesOf(b, 'white_label_of')).toContain('rebrand_of');
  });

  it('R4: separate alias additions UNION on the replica receiving the newer row — the newest writer\'s residual is pinned', () => {
    const { a, b } = pair();
    expect(aliasKind(a, { name: 'uses_package', alias: 'pulls_in' }).ok).toBe(true);
    expect(aliasKind(b, { name: 'uses_package', alias: 'links_to' }).ok).toBe(true);
    // A wrote first, B later (explicit, not slept).
    a.prepare("UPDATE project_relation_kinds SET updated_at = '2026-10-01 00:00:01' WHERE name = 'uses_package'").run();
    b.prepare("UPDATE project_relation_kinds SET updated_at = '2026-10-01 00:00:02' WHERE name = 'uses_package'").run();

    // A hub replica H receives both pushes; A and B then pull from it.
    const h = bootRelationsDb();
    push(a, h);
    push(b, h);
    const union = ['depends_on_package', 'imports_package', 'links_to', 'pulls_in', 'uses'];
    expect(aliasesOf(h, 'uses_package').sort()).toEqual(union);
    push(h, a);
    expect(aliasesOf(a, 'uses_package').sort()).toEqual(union);
    push(h, b);
    // RESIDUAL (measured, not designed): B holds the newest row, so LWW skips
    // the equal-timestamp hub row and merge_tags never runs on B. B converges
    // on the next write of this kind row anywhere.
    expect(aliasesOf(b, 'uses_package')).not.toContain('pulls_in');
    a.prepare("UPDATE project_relation_kinds SET updated_at = '2026-10-01 00:00:03' WHERE name = 'uses_package'").run();
    push(a, b);
    expect(aliasesOf(b, 'uses_package').sort()).toEqual(union);
  });

  it('R5: /sync/push into a DB lacking the tables names both in skipped[], ok:false', () => {
    const { a } = pair();
    declareRelation(a, { from: 'hadir', kind: 'supersedes', to: 'fya-hadir-app' });
    const old = bootRelationsDb({ maxVersion: 2 });
    const payload: Record<string, Record<string, unknown>[]> = {};
    for (const t of TABLES) payload[t] = a.prepare(`SELECT ${config(t).columns.join(', ')} FROM ${t}`).all() as Record<string, unknown>[];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = processSyncPush(old, payload);
    expect(r.ok).toBe(false);
    expect(r.skipped).toEqual([...TABLES]);
    expect(r.errors).toEqual({});
  });

  it('R6: every new SYNC_TABLES column exists in the v3 DDL; the entries are appended, kinds first', () => {
    const db = bootRelationsDb();
    for (const t of TABLES) {
      const c = config(t);
      const cols = new Set((db.pragma(`table_info(${t})`) as { name: string }[]).map((x) => x.name));
      for (const col of [...c.columns, ...c.syncKey, c.timestampCol]) expect(cols.has(col), `${t}.${col}`).toBe(true);
      expect(c.strategy).toBe('lww');
      expect(c.timestampCol).toBe('updated_at');
      expect(c.redactCols ?? []).toEqual([]);
      expect(c.columns).not.toContain('id');
      expect(RELATION_TABLES_SQL).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
    }
    expect(config('project_relations').syncKey).toEqual(['from_slug', 'kind', 'to_slug']);
    expect(config('project_relations').columns).toContain('removed_at');
    expect(config('project_relation_kinds').syncKey).toEqual(['name']);
    expect(config('project_relation_kinds').mergeFields).toEqual({ aliases: 'merge_tags' });
    const names = SYNC_TABLES.map((t) => t.table);
    expect(names.slice(-3)).toEqual(['dismissed_patterns', 'project_relation_kinds', 'project_relations']);
  });
});
