/**
 * FR-273 — the relation write core (`relations/write.ts`), plan §4.2 W-series.
 * Every scenario reads the ROW back with raw SQL; none trusts the result alone.
 *
 *   - W1 (AC2) a declare with an ALIAS kind stores the canonical kind;
 *   - W2 (AC5) an unregistered endpoint is refused, zero rows;
 *   - W3 (AC5) a duplicate-path endpoint (TD-402's `findPathHolder`) is refused,
 *     naming the holder, zero rows — also through a symlink;
 *   - W4 (AC5) a missing-path endpoint with `repo_url` (hadir-system) is accepted;
 *   - W5 a self-loop is refused;
 *   - W6 detail validation: absolute path, `~`, non-object, >8 keys, >200 chars,
 *     a non-string value, a bad key;
 *   - W7 re-declaring an identical live edge is a NO-OP (updated_at unchanged);
 *     a changed detail updates + bumps; `derived` is never downgraded; an
 *     omitted detail keeps the stored one;
 *   - W8 remove tombstones (row kept, updated_at bumped);
 *   - W9 re-declare after remove revives;
 *   - W10 removing an unknown edge is refused; removing a tombstone is a no-op;
 *   - W11 provenance defaults to `declared`.
 *
 * @module engine/components/projects/__tests__/relations-write.test
 */

import { describe, it, expect, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync, symlinkSync } from 'node:fs';

import {
  bootRelationsDb,
  cleanupRelationsFixtures,
  registerProject,
  tmpRoot,
} from './relations-fixture.js';
import { declareRelation, removeRelation } from '../relations/write.js';

afterEach(() => cleanupRelationsFixtures());

const OLD = '2000-01-01 00:00:00';

function rows(db: Database.Database): Record<string, string | null>[] {
  return db.prepare('SELECT * FROM project_relations ORDER BY id').all() as Record<string, string | null>[];
}

function edge(db: Database.Database, from: string, kind: string, to: string): Record<string, string | null> | undefined {
  return db.prepare('SELECT * FROM project_relations WHERE from_slug = ? AND kind = ? AND to_slug = ?')
    .get(from, kind, to) as Record<string, string | null> | undefined;
}

function fixture(): { db: Database.Database; root: string } {
  const db = bootRelationsDb();
  const root = tmpRoot();
  registerProject(db, root, 'moca-agent-web');
  registerProject(db, root, 'moca-agent-flutter-client');
  registerProject(db, root, 'hadir');
  registerProject(db, root, 'hadir-system', { onDisk: false, repoUrl: 'https://github.com/KalvadTech/hadir-system' });
  return { db, root };
}

describe('declareRelation', () => {
  it('W1 (AC2): an alias kind is stored under its canonical name', () => {
    const { db } = fixture();
    const r = declareRelation(db, { from: 'moca-agent-web', kind: 'depends_on_package', to: 'moca-agent-flutter-client', detail: { package: 'moca_agent_client_ui', ref: 'v2.0.0' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toMatchObject({ outcome: 'created', changed: true, resolved_kind: { input: 'depends_on_package', canonical: 'uses_package', via: 'alias' } });
    const all = rows(db);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ from_slug: 'moca-agent-web', kind: 'uses_package', to_slug: 'moca-agent-flutter-client', removed_at: null });
    expect(JSON.parse(all[0].detail!)).toEqual({ package: 'moca_agent_client_ui', ref: 'v2.0.0' });
    expect(edge(db, 'moca-agent-web', 'depends_on_package', 'moca-agent-flutter-client')).toBeUndefined();
  });

  it('an unknown kind is refused with closest, zero rows', () => {
    const { db } = fixture();
    const r = declareRelation(db, { from: 'moca-agent-web', kind: 'uses_packages', to: 'moca-agent-flutter-client' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refused.code).toBe('unknown_kind');
      expect(r.refused.closest).toContain('uses_package');
      expect(r.refused.message).toContain('uses_package');
    }
    expect(rows(db)).toHaveLength(0);
  });

  it('W2 (AC5): an unregistered endpoint is refused — either side — zero rows', () => {
    const { db } = fixture();
    for (const [from, to] of [['ghost-app', 'hadir'], ['hadir', 'ghost-app']]) {
      const r = declareRelation(db, { from, kind: 'calls_service', to });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.refused.code).toBe('unregistered_endpoint');
        expect(r.refused.message).toContain('ghost-app');
      }
    }
    expect(rows(db)).toHaveLength(0);
  });

  it('W3 (AC5): a duplicate-path endpoint is refused, naming the holder, zero rows', () => {
    const { db, root } = fixture();
    const path = registerProject(db, root, 'customerpulse-flutter');
    registerProject(db, root, 'customerpulse_flutter', { path });
    const r = declareRelation(db, { from: 'customerpulse-flutter', kind: 'uses_package', to: 'moca-agent-flutter-client' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refused.code).toBe('duplicate_path');
      expect(r.refused.message).toContain('customerpulse-flutter');
      expect(r.refused.message).toContain('customerpulse_flutter');
      expect(r.refused.message).toMatch(/duplicate-path/);
    }
    // The TO side too, and through a symlink (realpath on both sides).
    const real = join(root, 'real-dir');
    mkdirSync(real);
    const link = join(root, 'link-dir');
    symlinkSync(real, link);
    registerProject(db, root, 'twin-a', { path: real });
    registerProject(db, root, 'twin-b', { path: link });
    const viaLink = declareRelation(db, { from: 'hadir', kind: 'calls_service', to: 'twin-b' });
    expect(viaLink.ok).toBe(false);
    if (!viaLink.ok) {
      expect(viaLink.refused.code).toBe('duplicate_path');
      expect(viaLink.refused.message).toContain('twin-a');
    }
    expect(rows(db)).toHaveLength(0);
  });

  it('W4 (AC5): hadir-system — path gone, repo_url set — is a valid endpoint', () => {
    const { db } = fixture();
    const r = declareRelation(db, { from: 'hadir', kind: 'calls_service', to: 'hadir-system', detail: { role: 'backend' } });
    expect(r.ok).toBe(true);
    expect(edge(db, 'hadir', 'calls_service', 'hadir-system')).toMatchObject({ removed_at: null, provenance: 'declared' });
  });

  it('W5: a self-loop is refused', () => {
    const { db } = fixture();
    const r = declareRelation(db, { from: 'hadir', kind: 'supersedes', to: 'hadir' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refused.code).toBe('self_loop');
    expect(rows(db)).toHaveLength(0);
  });

  it('W6: detail validation — every malformed shape is refused, zero rows', () => {
    const { db } = fixture();
    const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'v']));
    const bad: unknown[] = [
      { path: '/Users/someone/code/x' },
      { path: '~/code/x' },
      { path: '~' },
      'a string',
      ['an', 'array'],
      null,
      nine,
      { note: 'x'.repeat(201) },
      { version: 2 },
      { 'Bad Key': 'v' },
      { repo: 'https://ci-user:ghp_TOKEN@github.com/acme/x.git' }, // F1: credentials never replicate
      { repo: 'ssh://deploy@github.com/acme/x.git' },
      // Warden M1: every local-path shape, not only a leading / or ~.
      { path: 'file:///Users/x/pkg' },
      { path: 'C:\\Users\\x' },
      { path: 'c:/Users/x' },
      { path: '\\\\server\\share\\x' },
      // Sentinel F-R4-1: scheme and drive matches are case-insensitive.
      { path: 'FILE:///Users/x/pkg' },
      { path: 'File:///x' },
    ];
    for (const detail of bad) {
      const r = declareRelation(db, { from: 'moca-agent-web', kind: 'uses_package', to: 'moca-agent-flutter-client', detail: detail as Record<string, string> });
      expect(r.ok, JSON.stringify(detail)).toBe(false);
      if (!r.ok) expect(r.refused.code, JSON.stringify(detail)).toBe('invalid_detail');
    }
    expect(rows(db)).toHaveLength(0);
    // Boundary controls: exactly 8 keys and exactly 200 chars are accepted.
    const eight = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, 'v']));
    expect(declareRelation(db, { from: 'moca-agent-web', kind: 'uses_package', to: 'moca-agent-flutter-client', detail: eight }).ok).toBe(true);
    expect(declareRelation(db, { from: 'hadir', kind: 'calls_service', to: 'hadir-system', detail: { note: 'x'.repeat(200) } }).ok).toBe(true);
  });

  it('W7: identical re-declare is a no-op; a changed detail bumps; derived is never downgraded; omitted detail keeps', () => {
    const { db } = fixture();
    const args = { from: 'moca-agent-web', kind: 'uses_package', to: 'moca-agent-flutter-client', detail: { ref: 'v2.0.0' } };
    expect(declareRelation(db, args, { provenance: 'derived' }).ok).toBe(true);
    db.prepare('UPDATE project_relations SET updated_at = ?').run(OLD);

    const same = declareRelation(db, args);
    expect(same.ok).toBe(true);
    if (same.ok) expect(same.data).toMatchObject({ outcome: 'unchanged', changed: false });
    expect(edge(db, 'moca-agent-web', 'uses_package', 'moca-agent-flutter-client')!.updated_at).toBe(OLD);
    expect(edge(db, 'moca-agent-web', 'uses_package', 'moca-agent-flutter-client')!.provenance).toBe('derived');

    const omitted = declareRelation(db, { from: args.from, kind: args.kind, to: args.to });
    expect(omitted.ok).toBe(true);
    if (omitted.ok) expect(omitted.data.outcome).toBe('unchanged');
    expect(JSON.parse(edge(db, args.from, args.kind, args.to)!.detail!)).toEqual({ ref: 'v2.0.0' });

    const changed = declareRelation(db, { ...args, detail: { ref: 'v2.1.0' } });
    expect(changed.ok).toBe(true);
    if (changed.ok) expect(changed.data).toMatchObject({ outcome: 'updated', changed: true });
    const row = edge(db, args.from, args.kind, args.to)!;
    expect(JSON.parse(row.detail!)).toEqual({ ref: 'v2.1.0' });
    expect(row.updated_at).not.toBe(OLD);
    expect(row.provenance).toBe('derived');
    expect(rows(db)).toHaveLength(1);
  });

  it('W11: provenance defaults to declared; detail defaults to {}', () => {
    const { db } = fixture();
    expect(declareRelation(db, { from: 'hadir', kind: 'calls_service', to: 'hadir-system' }).ok).toBe(true);
    expect(edge(db, 'hadir', 'calls_service', 'hadir-system')).toMatchObject({ provenance: 'declared', detail: '{}' });
  });
});

describe('removeRelation', () => {
  it('W8: remove tombstones — the row stays, removed_at + updated_at set', () => {
    const { db } = fixture();
    declareRelation(db, { from: 'hadir', kind: 'calls_service', to: 'hadir-system' });
    db.prepare('UPDATE project_relations SET updated_at = ?').run(OLD);
    const r = removeRelation(db, { from: 'hadir', kind: 'client_of', to: 'hadir-system' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toMatchObject({ outcome: 'removed', changed: true });
    const row = edge(db, 'hadir', 'calls_service', 'hadir-system')!;
    expect(row.removed_at).not.toBeNull();
    expect(row.updated_at).not.toBe(OLD);
    expect(rows(db)).toHaveLength(1);
  });

  it('W9: re-declare after remove revives the same row', () => {
    const { db } = fixture();
    declareRelation(db, { from: 'hadir', kind: 'calls_service', to: 'hadir-system' });
    const id = edge(db, 'hadir', 'calls_service', 'hadir-system')!.id;
    removeRelation(db, { from: 'hadir', kind: 'calls_service', to: 'hadir-system' });
    const r = declareRelation(db, { from: 'hadir', kind: 'calls_service', to: 'hadir-system' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toMatchObject({ outcome: 'revived', changed: true });
    const row = edge(db, 'hadir', 'calls_service', 'hadir-system')!;
    expect(row.removed_at).toBeNull();
    expect(row.id).toBe(id);
  });

  it('W10: an unknown edge is refused; removing a tombstone is an idempotent no-op', () => {
    const { db } = fixture();
    const r = removeRelation(db, { from: 'hadir', kind: 'calls_service', to: 'hadir-system' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refused.code).toBe('unknown_edge');
    declareRelation(db, { from: 'hadir', kind: 'calls_service', to: 'hadir-system' });
    removeRelation(db, { from: 'hadir', kind: 'calls_service', to: 'hadir-system' });
    const tomb = edge(db, 'hadir', 'calls_service', 'hadir-system')!;
    const again = removeRelation(db, { from: 'hadir', kind: 'calls_service', to: 'hadir-system' });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.data).toMatchObject({ outcome: 'unchanged', changed: false });
    expect(edge(db, 'hadir', 'calls_service', 'hadir-system')).toEqual(tomb);
    const badKind = removeRelation(db, { from: 'hadir', kind: 'nope', to: 'hadir-system' });
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) expect(badKind.refused.code).toBe('unknown_kind');
  });

  it('M10: declareRelation is atomic — a failure after the write leaves no partial row', () => {
    const { db } = fixture();
    // A proxy that throws when the write core reads the row BACK after writing.
    let wrote = false;
    const proxy = new Proxy(db, {
      get(target, prop, recv) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (/^(INSERT|UPDATE) /.test(sql)) wrote = true;
            if (wrote && /^SELECT from_slug, kind, to_slug, detail/.test(sql)) throw new Error('read-back failed');
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as Database.Database;
    expect(() => declareRelation(proxy, { from: 'hadir', kind: 'calls_service', to: 'hadir-system' })).toThrow(/read-back failed/);
    expect(rows(db)).toHaveLength(0);
  });
});
