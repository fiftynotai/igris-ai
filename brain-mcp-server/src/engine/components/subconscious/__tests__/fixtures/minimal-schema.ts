/**
 * Brain Engine v5.0 — Subconscious Test Fixtures
 *
 * Minimal slice of the production schema covering only the tables the
 * Phase 1 detectors and runner reference. Lives in the test fixtures
 * directory so the engine's real migrations stay untouched and the
 * fixture remains independently auditable.
 *
 * Tables included:
 *   - projects        : status (active/archived), registered_at
 *   - learnings       : created_at — for project-quiet activity max
 *   - brief_status    : status / updated_at — for stalled + project-quiet
 *   - brief_files     : content — for done-with-unchecked-AC scan
 *
 * Phase 2 will extend with `learnings_vec` and `agent_metrics` for the
 * conflict and pattern detectors.
 *
 * @module engine/components/subconscious/__tests__/fixtures/minimal-schema
 */

import type Database from 'better-sqlite3';

export const minimalSchemaSql = `
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'inactive')),
    registered_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS learnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'pattern',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS brief_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    brief_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    priority TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project, brief_id)
  );

  CREATE TABLE IF NOT EXISTS brief_files (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    brief_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project, brief_id)
  );
`;

/** Apply the minimal fixture schema to a `Database`. */
export function applyMinimalSchema(db: Database.Database): void {
  db.exec(minimalSchemaSql);
}

// ---------------------------------------------------------------------------
// Seed helpers — keep tests free of repetitive INSERT boilerplate.
// ---------------------------------------------------------------------------

/**
 * Compute an ISO-ish timestamp `daysAgo` days before now in the format
 * SQLite's `datetime('now')` produces (`YYYY-MM-DD HH:MM:SS`). Letting
 * tests pass these strings directly into julianday() comparisons keeps
 * the fixture deterministic without freezing wall-clock time.
 */
export function daysAgo(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

export interface SeedProjectOptions {
  slug: string;
  name?: string;
  status?: 'active' | 'archived' | 'inactive';
  registered_days_ago?: number;
}

export function seedProject(db: Database.Database, opts: SeedProjectOptions): void {
  db.prepare(
    `INSERT INTO projects (slug, name, path, status, registered_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    opts.slug,
    opts.name ?? opts.slug,
    `/tmp/${opts.slug}`,
    opts.status ?? 'active',
    daysAgo(opts.registered_days_ago ?? 30),
  );
}

export interface SeedBriefOptions {
  project: string;
  brief_id: string;
  status: string;
  title?: string;
  updated_days_ago?: number;
}

export function seedBrief(db: Database.Database, opts: SeedBriefOptions): void {
  db.prepare(
    `INSERT INTO brief_status (project, brief_id, title, status, priority, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.project,
    opts.brief_id,
    opts.title ?? `${opts.brief_id} title`,
    opts.status,
    'P2-Medium',
    daysAgo(opts.updated_days_ago ?? 0),
  );
}

export interface SeedBriefFileOptions {
  project: string;
  brief_id: string;
  content: string;
}

export function seedBriefFile(db: Database.Database, opts: SeedBriefFileOptions): void {
  db.prepare(
    `INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    `${opts.project}:${opts.brief_id}`,
    opts.project,
    opts.brief_id,
    `${opts.brief_id}.md`,
    opts.content,
    'hash',
  );
}

export interface SeedLearningOptions {
  project: string;
  title: string;
  content?: string;
  created_days_ago?: number;
}

export function seedLearning(db: Database.Database, opts: SeedLearningOptions): void {
  db.prepare(
    `INSERT INTO learnings (project, category, title, content, created_at)
     VALUES (?, 'pattern', ?, ?, ?)`,
  ).run(
    opts.project,
    opts.title,
    opts.content ?? 'body',
    daysAgo(opts.created_days_ago ?? 0),
  );
}
