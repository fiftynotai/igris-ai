/**
 * FR-273 — shared fixture for the project-relations suites (not a `*.test.ts`,
 * so vitest never collects it).
 *
 * `bootRelationsDb` reproduces production boot order (`bootEngine`): the REAL
 * legacy `migrateSchema` chain, then the projects component chain through the
 * REAL `runMigrations`. Every DB is a temp file under `mkdtemp`; nothing here
 * opens `~/.igris/memory/knowledge.db`.
 *
 * `seedGraph` registers the brief's nine seed projects (real directories under
 * the temp root, except `hadir-system`, whose working copy is deleted — the
 * FR-265 `source-reclaimed` shape) and writes the eight seed edges with raw
 * SQL, so the READ suites never depend on the write core they are not testing.
 *
 * @module engine/components/projects/__tests__/relations-fixture
 */

import type Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSqliteAdapter } from '../../../storage/sqlite.js';
import { migrateSchema } from '../../../../db.js';
import { createProjectsComponent } from '../index.js';
import type { Migration, StorageAdapter } from '../../../types.js';

const tmpDirs: string[] = [];
const openStorages: StorageAdapter[] = [];

/** Close every storage and remove every temp dir this module created. */
export function cleanupRelationsFixtures(): void {
  while (openStorages.length) {
    try { openStorages.pop()?.close(); } catch { /* already closed */ }
  }
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
}

/** A fresh realpath-resolved temp directory, removed by the cleanup. */
export function tmpRoot(prefix = 'fr273-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

/** Open a sqlite adapter on `dbPath` (tracked for cleanup). */
export function openStorage(dbPath: string): StorageAdapter {
  const storage = createSqliteAdapter(dbPath);
  openStorages.push(storage);
  return storage;
}

/**
 * Production boot order on a temp DB: legacy chain, then the projects chain
 * filtered to `version <= maxVersion` (3 = FR-273, 2 = a pre-FR-273 bundle),
 * plus any extra (probe) migrations.
 */
export function bootRelationsStorage(
  opts: { dbPath?: string; maxVersion?: number; extra?: Migration[] } = {},
): StorageAdapter {
  const dbPath = opts.dbPath ?? join(tmpRoot('fr273-db-'), 'brain.db');
  const storage = openStorage(dbPath);
  migrateSchema(storage.rawConnection);
  const max = opts.maxVersion ?? Number.MAX_SAFE_INTEGER;
  storage.runMigrations('projects', [
    ...createProjectsComponent().schema().filter((m) => m.version <= max),
    ...(opts.extra ?? []),
  ]);
  return storage;
}

/** {@link bootRelationsStorage}'s raw handle. */
export function bootRelationsDb(opts: { dbPath?: string; maxVersion?: number } = {}): Database.Database {
  return bootRelationsStorage(opts).rawConnection;
}

/** The nine seed projects of the brief, in brief order. */
export const SEED_SLUGS = [
  'moca-app',
  'moca-agent-web',
  'moca-agent-flutter-client',
  'moca-ai-agent',
  'hadir',
  'moca-hadir-app',
  'fya-hadir-app',
  'hadir-system',
  'attendance_app',
] as const;

/** The eight seed edges of the brief (edge 7 = hadir → hadir-system ONLY). */
export const SEED_EDGES: readonly { from: string; kind: string; to: string; detail: Record<string, string> }[] = [
  { from: 'moca-agent-web', kind: 'uses_package', to: 'moca-agent-flutter-client', detail: { package: 'moca_agent_client_ui', ref: 'v2.0.0' } },
  { from: 'moca-app', kind: 'uses_package', to: 'moca-agent-flutter-client', detail: { note: 'dependency on the branch holding a60331d4, not bm-final-phase' } },
  { from: 'moca-agent-flutter-client', kind: 'calls_service', to: 'moca-ai-agent', detail: { protocol: 'HTTP/SSE' } },
  { from: 'moca-hadir-app', kind: 'white_label_of', to: 'hadir', detail: {} },
  { from: 'fya-hadir-app', kind: 'white_label_of', to: 'hadir', detail: {} },
  { from: 'moca-hadir-app', kind: 'variant_of', to: 'moca-app', detail: { note: 'subset for outsourced employees not on the client Oracle system' } },
  { from: 'hadir', kind: 'calls_service', to: 'hadir-system', detail: { role: 'backend' } },
  { from: 'hadir', kind: 'supersedes', to: 'attendance_app', detail: { note: 'abandoned single-repo attempt' } },
];

/**
 * Register a project row with raw SQL. `onDisk: false` points the row at a
 * path that does not exist (the hadir-system shape).
 */
export function registerProject(
  db: Database.Database,
  root: string,
  slug: string,
  opts: { onDisk?: boolean; repoUrl?: string | null; path?: string } = {},
): string {
  const path = opts.path ?? join(root, 'repos', slug);
  if (opts.onDisk !== false && opts.path === undefined) mkdirSync(path, { recursive: true });
  db.prepare('INSERT INTO projects (slug, name, path, repo_url) VALUES (?, ?, ?, ?)')
    .run(slug, slug, path, opts.repoUrl ?? `https://github.com/KalvadTech/${slug}`);
  return path;
}

/** Insert one edge with raw SQL (the read suites never go through write.ts). */
export function insertEdge(
  db: Database.Database,
  e: { from: string; kind: string; to: string; detail?: Record<string, string>; provenance?: string; removed_at?: string | null },
): void {
  db.prepare(
    'INSERT INTO project_relations (from_slug, kind, to_slug, detail, provenance, removed_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(e.from, e.kind, e.to, JSON.stringify(e.detail ?? {}), e.provenance ?? 'declared', e.removed_at ?? null);
}

/** The nine seed projects (hadir-system off disk) and the eight seed edges. */
export function seedGraph(db: Database.Database, root: string): void {
  for (const slug of SEED_SLUGS) registerProject(db, root, slug, { onDisk: slug !== 'hadir-system' });
  for (const e of SEED_EDGES) insertEdge(db, e);
}

/** Every relation row, raw, in key order. */
export function relationRows(db: Database.Database): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM project_relations ORDER BY from_slug, kind, to_slug').all() as Record<string, unknown>[];
}

/** Every kind row, raw, by name. */
export function kindRows(db: Database.Database): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM project_relation_kinds ORDER BY name').all() as Record<string, unknown>[];
}
