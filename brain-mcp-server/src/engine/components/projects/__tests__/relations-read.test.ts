/**
 * FR-273 — the pure relations reader (`relations/read.ts`): the lookup (plan
 * §4.2 L-series) and the /boot digest + line (B-series). Seed-graph fixture:
 * the brief's nine projects (hadir-system OFF disk) and eight edges, written
 * with raw SQL so this suite never depends on the write core.
 *
 *   - L1 (AC6) both directions at depth 1, every AC6 field on every neighbour;
 *   - L2 (AC6) the depth chain moca-agent-web → client (d1) → agent (d2, via client);
 *   - L3 direction filters; L4 a cycle at depth 5 terminates, each node once;
 *   - L5 depth 1 never returns depth-2 nodes; L6 tombstones are excluded;
 *   - L7 an unknown kind is tolerated (raw kind, null labels);
 *   - L8 `on_disk`; L9 watermark `lines` equal `igris_project_status`'s lines;
 *   - L10 an absent path costs zero git spawns; L11 at most 4 checks, the rest
 *     `skipped:cap` with NO lines (M17 — a null check must never render the false
 *     "no watermark recorded"); L11b the time budget; L12 `check_watermarks:false`
 *     spawns nothing; L13 a pre-projects:2 DB gives `watermark: null`;
 *   - L14 `system.members` for hadir covers all nine projects;
 *   - B1/B2 the exact D5 lines; B3 no edges → null; B4 unregistered → null +
 *     `registered:false`; B5 no projects:3 → degraded, `line: null`; B6 boot
 *     mode spawns nothing; B7 7 segments → 4 + `(+3 more)`, ≤ 240 chars.
 *
 * `node:child_process` is a PASS-THROUGH spy so spawn counts are observable;
 * every git fixture runs with a scratch GIT_CONFIG_GLOBAL and every inherited
 * GIT_* location variable stripped. `getDb` is mocked (L9 drives the real
 * `handleProjectStatus` against the fixture DB); `migrateSchema` stays real.
 *
 * @module engine/components/projects/__tests__/relations-read.test
 */

import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../db.js')>();
  return { ...actual, getDb: vi.fn() };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

import { getDb } from '../../../../db.js';
import { handleProjectStatus } from '../../../../tools/projects.js';
import {
  bootRelationsDb,
  bootRelationsStorage,
  cleanupRelationsFixtures,
  insertEdge,
  registerProject,
  seedGraph,
  SEED_SLUGS,
  tmpRoot,
} from './relations-fixture.js';
import {
  lookupRelations,
  relationsBootDigest,
  renderBootLine,
  WATERMARK_CHECK_CAP,
  WATERMARK_BUDGET_MS,
} from '../relations/read.js';
import { relationsMigrationV3 } from '../relations/schema.js';
import { createInstancesComponent } from '../../instances/index.js';

const spawn = vi.mocked(execFileSync);
const mockedGetDb = vi.mocked(getDb);

afterEach(() => {
  cleanupRelationsFixtures();
  spawn.mockClear();
});

// ---------------------------------------------------------------------------
// git fixtures (scratch config, no inherited GIT_* locations)
// ---------------------------------------------------------------------------

let gitHome: string;
const GIT_LOCATIONS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX'];
const savedGit: Record<string, string | undefined> = {};

beforeAll(() => {
  gitHome = mkdtempSync(join(tmpdir(), 'fr273-git-'));
  writeFileSync(join(gitHome, 'gitconfig'), '[user]\n\tname = fr273\n\temail = fr273@igris.invalid\n[init]\n\tdefaultBranch = main\n');
  for (const k of [...GIT_LOCATIONS, 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) savedGit[k] = process.env[k];
  for (const k of GIT_LOCATIONS) delete process.env[k];
  process.env.GIT_CONFIG_GLOBAL = join(gitHome, 'gitconfig');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedGit)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(gitHome, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return String(execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' })).trim();
}

/** Make `path` a git repo with one commit; return HEAD. */
function gitRepo(path: string): string {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q');
  writeFileSync(join(path, 'f.txt'), 'x');
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'one');
  return git(path, 'rev-parse', 'HEAD');
}

function setWatermark(db: Database.Database, slug: string, sha: string, branch: string | null = 'main'): void {
  db.prepare("UPDATE projects SET knowledge_sha = ?, knowledge_branch = ?, knowledge_recorded_at = '2026-09-29 10:00:00' WHERE slug = ?")
    .run(sha, branch, slug);
}

function seeded(): { db: Database.Database; root: string } {
  const db = bootRelationsDb();
  const root = tmpRoot();
  seedGraph(db, root);
  return { db, root };
}

const AC6_FIELDS = [
  'slug', 'depth', 'side', 'kind', 'forward_label', 'inverse_label', 'label', 'detail',
  'provenance', 'registered', 'repo_url', 'path', 'on_disk', 'watermark', 'via',
];

// ---------------------------------------------------------------------------
// L — lookup
// ---------------------------------------------------------------------------

describe('lookupRelations', () => {
  it('L1 (AC6): moca-agent-flutter-client, depth 1, both directions, every field', () => {
    const { db, root } = seeded();
    const r = lookupRelations(db, { slug: 'moca-agent-flutter-client' });
    expect(r.project).toBe('moca-agent-flutter-client');
    expect(r.registered).toBe(true);
    expect(r.depth).toBe(1);
    expect(r.direction).toBe('both');
    expect(r.neighbours.map((n) => [n.slug, n.side, n.kind])).toEqual([
      ['moca-ai-agent', 'out', 'calls_service'],
      ['moca-agent-web', 'in', 'uses_package'],
      ['moca-app', 'in', 'uses_package'],
    ]);
    for (const n of r.neighbours) expect(Object.keys(n).sort()).toEqual([...AC6_FIELDS].sort());
    const [agent, web] = r.neighbours;
    expect(agent).toMatchObject({
      depth: 1, forward_label: 'calls', inverse_label: 'called by', label: 'calls',
      detail: { protocol: 'HTTP/SSE' }, provenance: 'declared', registered: true,
      repo_url: 'https://github.com/KalvadTech/moca-ai-agent',
      path: join(root, 'repos', 'moca-ai-agent'), on_disk: true, watermark: null,
      via: { from: 'moca-agent-flutter-client', kind: 'calls_service', to: 'moca-ai-agent' },
    });
    expect(web).toMatchObject({
      label: 'used by', inverse_label: 'used by', detail: { package: 'moca_agent_client_ui', ref: 'v2.0.0' },
      via: { from: 'moca-agent-web', kind: 'uses_package', to: 'moca-agent-flutter-client' },
    });
  });

  it('L2 (AC6): moca-agent-web depth 2 out is exactly client (d1) → agent (d2, via client)', () => {
    const { db } = seeded();
    const r = lookupRelations(db, { slug: 'moca-agent-web', depth: 2, direction: 'out' });
    expect(r.neighbours.map((n) => [n.slug, n.depth])).toEqual([
      ['moca-agent-flutter-client', 1],
      ['moca-ai-agent', 2],
    ]);
    expect(r.neighbours[1].via).toEqual({ from: 'moca-agent-flutter-client', kind: 'calls_service', to: 'moca-ai-agent' });
    expect(r.edges.map((e) => `${e.from} ${e.kind} ${e.to}`)).toEqual([
      'moca-agent-web uses_package moca-agent-flutter-client',
      'moca-agent-flutter-client calls_service moca-ai-agent',
    ]);
  });

  it('L3: direction filters apply to every hop', () => {
    const { db } = seeded();
    expect(lookupRelations(db, { slug: 'moca-agent-flutter-client', direction: 'out' }).neighbours.map((n) => n.slug)).toEqual(['moca-ai-agent']);
    expect(lookupRelations(db, { slug: 'moca-agent-flutter-client', direction: 'in' }).neighbours.map((n) => n.slug)).toEqual(['moca-agent-web', 'moca-app']);
    // `in` at depth 2 follows to→from again: web and app have no in-edges... but moca-app has one (variant_of from moca-hadir-app).
    expect(lookupRelations(db, { slug: 'moca-agent-flutter-client', direction: 'in', depth: 2 }).neighbours.map((n) => [n.slug, n.depth])).toEqual([
      ['moca-agent-web', 1], ['moca-app', 1], ['moca-hadir-app', 2],
    ]);
  });

  it('L4: a cycle at depth 5 terminates and lists each node once, at its minimum depth', () => {
    const db = bootRelationsDb();
    const root = tmpRoot();
    for (const s of ['a1', 'b1', 'c1']) registerProject(db, root, s);
    insertEdge(db, { from: 'a1', kind: 'supersedes', to: 'b1' });
    insertEdge(db, { from: 'b1', kind: 'supersedes', to: 'c1' });
    insertEdge(db, { from: 'c1', kind: 'supersedes', to: 'a1' });
    const r = lookupRelations(db, { slug: 'a1', depth: 5, direction: 'both' });
    expect(r.neighbours.map((n) => [n.slug, n.depth])).toEqual([['b1', 1], ['c1', 1]]);
    const out = lookupRelations(db, { slug: 'a1', depth: 5, direction: 'out' });
    expect(out.neighbours.map((n) => [n.slug, n.depth])).toEqual([['b1', 1], ['c1', 2]]);
    expect(out.edges).toHaveLength(3);
  });

  it('L5: depth 1 never returns a depth-2 node', () => {
    const { db } = seeded();
    const r = lookupRelations(db, { slug: 'moca-agent-web', depth: 1 });
    expect(r.neighbours.map((n) => n.slug)).toEqual(['moca-agent-flutter-client']);
    expect(r.neighbours.every((n) => n.depth === 1)).toBe(true);
  });

  it('L6: a tombstoned edge is invisible', () => {
    const { db } = seeded();
    db.prepare("UPDATE project_relations SET removed_at = datetime('now') WHERE kind = 'calls_service' AND from_slug = 'moca-agent-flutter-client'").run();
    expect(lookupRelations(db, { slug: 'moca-agent-flutter-client', direction: 'out' }).neighbours).toEqual([]);
    expect(lookupRelations(db, { slug: 'moca-ai-agent' }).neighbours).toEqual([]);
  });

  it('L7: an edge whose kind is not in the local registry is tolerated (raw kind, null labels)', () => {
    const { db } = seeded();
    insertEdge(db, { from: 'moca-ai-agent', kind: 'mystery_kind', to: 'hadir' });
    const r = lookupRelations(db, { slug: 'moca-ai-agent', direction: 'out' });
    expect(r.neighbours).toHaveLength(1);
    expect(r.neighbours[0]).toMatchObject({ slug: 'hadir', kind: 'mystery_kind', forward_label: null, inverse_label: null, label: null });
  });

  it('L8: on_disk reflects the row path; an unregistered neighbour reads registered:false', () => {
    const { db } = seeded();
    const h = lookupRelations(db, { slug: 'hadir' });
    expect(h.neighbours.find((n) => n.slug === 'hadir-system')).toMatchObject({ on_disk: false, registered: true, repo_url: 'https://github.com/KalvadTech/hadir-system' });
    expect(h.neighbours.find((n) => n.slug === 'attendance_app')).toMatchObject({ on_disk: true });
    insertEdge(db, { from: 'hadir', kind: 'uses_package', to: 'gone-pkg' });
    const g = lookupRelations(db, { slug: 'hadir' }).neighbours.find((n) => n.slug === 'gone-pkg')!;
    expect(g).toMatchObject({ registered: false, repo_url: null, path: null, on_disk: false, watermark: null });
  });

  it('L9: a checked watermark renders EXACTLY the igris_project_status lines for that row', () => {
    // The instances chain adds the agent_events columns handleProjectStatus reads.
    const storage = bootRelationsStorage();
    storage.runMigrations('instances', createInstancesComponent().schema());
    const db = storage.rawConnection;
    const root = tmpRoot();
    seedGraph(db, root);
    const sha = gitRepo(join(root, 'repos', 'moca-ai-agent'));
    setWatermark(db, 'moca-ai-agent', sha);
    const n = lookupRelations(db, { slug: 'moca-agent-flutter-client', direction: 'out' }).neighbours[0];
    expect(n.watermark).toMatchObject({ sha, branch: 'main', recorded_at: '2026-09-29 10:00:00', check: 'reachable' });
    const lines = n.watermark!.lines!;
    expect(lines.length).toBeGreaterThanOrEqual(3);
    mockedGetDb.mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    const status = handleProjectStatus({ slug: 'moca-ai-agent' }).content[0].text.split('\n');
    const at = status.indexOf(lines[0]);
    expect(at).toBeGreaterThan(-1);
    expect(status.slice(at, at + lines.length)).toEqual(lines);
  });

  it('L10: an absent path costs zero spawns; no recorded SHA is watermark:null and zero spawns', () => {
    const { db } = seeded();
    setWatermark(db, 'hadir-system', 'a'.repeat(40));
    spawn.mockClear();
    const r = lookupRelations(db, { slug: 'hadir' });
    const hs = r.neighbours.find((n) => n.slug === 'hadir-system')!;
    expect(hs.watermark).toMatchObject({ sha: 'a'.repeat(40), check: 'absent' });
    expect(hs.watermark!.lines!.join('\n')).toMatch(/not verified: no git working copy/);
    expect(r.neighbours.find((n) => n.slug === 'attendance_app')!.watermark).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('L11 (M16/M17): 6 watermarked neighbours — at most 4 checked, the rest skipped:cap with NO lines', () => {
    const db = bootRelationsDb();
    const root = tmpRoot();
    registerProject(db, root, 'hub');
    for (let i = 1; i <= 6; i++) {
      const slug = `n${i}`;
      const path = registerProject(db, root, slug);
      setWatermark(db, slug, gitRepo(path));
      insertEdge(db, { from: 'hub', kind: 'uses_package', to: slug });
    }
    expect(WATERMARK_CHECK_CAP).toBe(4);
    const r = lookupRelations(db, { slug: 'hub' });
    const checked = r.neighbours.filter((n) => n.watermark?.check === 'reachable');
    const skipped = r.neighbours.filter((n) => n.watermark?.check === 'skipped:cap');
    expect(checked.map((n) => n.slug)).toEqual(['n1', 'n2', 'n3', 'n4']);
    expect(skipped.map((n) => n.slug)).toEqual(['n5', 'n6']);
    for (const n of checked) expect(n.watermark!.lines!.length).toBeGreaterThan(0);
    for (const n of skipped) {
      expect(n.watermark).not.toHaveProperty('lines');
      expect(JSON.stringify(n.watermark)).not.toMatch(/no watermark recorded/);
    }
  });

  it('L11b: the time budget — once elapsed ≥ budget, later neighbours are skipped:budget', () => {
    const db = bootRelationsDb();
    const root = tmpRoot();
    registerProject(db, root, 'hub');
    for (let i = 1; i <= 3; i++) {
      const path = registerProject(db, root, `n${i}`);
      setWatermark(db, `n${i}`, gitRepo(path));
      insertEdge(db, { from: 'hub', kind: 'uses_package', to: `n${i}` });
    }
    let t = 0;
    const r = lookupRelations(db, { slug: 'hub' }, { now: () => { const v = t; t += WATERMARK_BUDGET_MS; return v; } });
    expect(r.neighbours.map((n) => n.watermark?.check)).toEqual(['reachable', 'skipped:budget', 'skipped:budget']);
  });

  it('L12: check_watermarks:false spawns nothing and marks skipped:off', () => {
    const { db, root } = seeded();
    setWatermark(db, 'moca-ai-agent', gitRepo(join(root, 'repos', 'moca-ai-agent')));
    spawn.mockClear();
    const n = lookupRelations(db, { slug: 'moca-agent-flutter-client', check_watermarks: false }).neighbours[0];
    expect(n.watermark).toMatchObject({ check: 'skipped:off' });
    expect(n.watermark).not.toHaveProperty('lines');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('L13: a DB without projects:2 (no watermark columns) gives watermark:null', () => {
    const storage = bootRelationsStorage({ maxVersion: 1 });
    const db = storage.rawConnection;
    db.exec(relationsMigrationV3.sql);
    const root = tmpRoot();
    registerProject(db, root, 'a1');
    registerProject(db, root, 'b1');
    insertEdge(db, { from: 'a1', kind: 'uses_package', to: 'b1' });
    const r = lookupRelations(db, { slug: 'a1' });
    expect(r.neighbours[0].watermark).toBeNull();
  });

  it('L14: system.members for hadir covers all nine seed projects (joined through edge 6)', () => {
    const { db } = seeded();
    const r = lookupRelations(db, { slug: 'hadir' });
    expect(r.system!.members).toEqual([...SEED_SLUGS].sort());
    expect(r.system!.size).toBe(9);
    expect(r.system!.truncated).toBe(false);
    expect(lookupRelations(db, { slug: 'hadir', include_system: false }).system).toBeUndefined();
  });

  it('a kind filter keeps only that kind on every hop', () => {
    const { db } = seeded();
    const r = lookupRelations(db, { slug: 'hadir', kind: 'white_label_of' });
    expect(r.neighbours.map((n) => n.slug)).toEqual(['fya-hadir-app', 'moca-hadir-app']);
    expect(r.kind).toBe('white_label_of');
  });
});

// ---------------------------------------------------------------------------
// B — the /boot digest and line
// ---------------------------------------------------------------------------

describe('relationsBootDigest / renderBootLine', () => {
  it('B1: moca-agent-web renders the exact D5 line', () => {
    const { db } = seeded();
    expect(relationsBootDigest(db, 'moca-agent-web')).toEqual({
      degraded: false,
      reason: null,
      project: 'moca-agent-web',
      registered: true,
      line: 'Connected: uses moca-agent-flutter-client (v2.0.0) → calls moca-ai-agent · more: igris project relations',
      neighbours: 1,
    });
  });

  it('B2: hadir renders the exact D5 line', () => {
    const { db } = seeded();
    const d = relationsBootDigest(db, 'hadir');
    expect(d.line).toBe('Connected: calls hadir-system; supersedes attendance_app; white-labelled as fya-hadir-app, moca-hadir-app · more: igris project relations');
    expect(d.neighbours).toBe(4);
  });

  it('B3: a registered project with no live edges → line null', () => {
    const { db, root } = seeded();
    registerProject(db, root, 'igris-ai');
    expect(relationsBootDigest(db, 'igris-ai')).toMatchObject({ degraded: false, registered: true, line: null, neighbours: 0 });
  });

  it('B4: an unregistered project → line null, registered false', () => {
    const { db } = seeded();
    expect(relationsBootDigest(db, 'nobody')).toMatchObject({ degraded: false, registered: false, line: null, neighbours: 0 });
  });

  it('B5: no projects:3 → degraded, line null, the reason named', () => {
    const db = bootRelationsDb({ maxVersion: 2 });
    const d = relationsBootDigest(db, 'moca-agent-web');
    expect(d.degraded).toBe(true);
    expect(d.line).toBeNull();
    expect(d.reason).toMatch(/projects:3/);
  });

  it('B6: boot mode spawns no git process, even with watermarked on-disk neighbours', () => {
    const { db, root } = seeded();
    setWatermark(db, 'moca-agent-flutter-client', gitRepo(join(root, 'repos', 'moca-agent-flutter-client')));
    spawn.mockClear();
    expect(relationsBootDigest(db, 'moca-agent-web').line).not.toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('B7: 7 segments → the first 4 plus (+3 more), and never over 240 characters', () => {
    const db = bootRelationsDb();
    const root = tmpRoot();
    registerProject(db, root, 'hub');
    for (let i = 1; i <= 7; i++) {
      registerProject(db, root, `neighbour-project-number-${i}`);
      insertEdge(db, { from: 'hub', kind: 'uses_package', to: `neighbour-project-number-${i}` });
    }
    const line = relationsBootDigest(db, 'hub').line!;
    expect(line.length).toBeLessThanOrEqual(240);
    expect(line.startsWith('Connected: ')).toBe(true);
    expect(line.endsWith(' · more: igris project relations')).toBe(true);
    const body = line.slice('Connected: '.length, line.length - ' · more: igris project relations'.length);
    const m = /^(.*) \(\+(\d+) more\)$/.exec(body)!;
    expect(m).not.toBeNull();
    const shown = m[1].split('; ');
    expect(shown.length + Number(m[2])).toBe(7);
    expect(shown.length).toBeLessThanOrEqual(4);
    expect(shown[0]).toBe('uses neighbour-project-number-1');
  });

  it('renderBootLine is pure: no segments → null', () => {
    expect(renderBootLine([])).toBeNull();
    expect(renderBootLine(['uses x'])).toBe('Connected: uses x · more: igris project relations');
  });
});
