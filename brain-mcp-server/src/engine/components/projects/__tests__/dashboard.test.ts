/**
 * TD-171 M3 — igris_project_dashboard handler tests (operator override
 * 2026-05-15: single filterable tool subsuming _status + _list patterns).
 *
 * Coverage:
 *   - per-slug single-project mode returns project detail + recent block
 *   - cross-project mode with status filter narrows correctly
 *   - summary_only=true returns no per-project rows (counts intact)
 *   - archetype filter narrows correctly
 *   - tech_stack substring filter narrows correctly
 *   - days window changes recent.last_n_days echo
 *   - rejects negative days
 *   - rejects invalid status enum
 *   - gateway strict-input contract (TD-128)
 *
 * @module engine/components/projects/__tests__/dashboard.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

import { getDb } from '../../../../db.js';
import { handleProjectDashboard, handleProjectStatus } from '../../../../tools/projects.js';
import { createGateway } from '../../../gateway.js';
import { createProjectsComponent } from '../index.js';

const mockedGetDb = vi.mocked(getDb);

function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      tech_stack TEXT DEFAULT '',
      archetype TEXT DEFAULT 'unclassified',
      igris_version TEXT DEFAULT '7.0.0',
      status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'inactive')),
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_session_at TEXT,
      metadata TEXT DEFAULT '{}'
    );
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      message TEXT NOT NULL,
      solution TEXT DEFAULT '',
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      occurrence_count INTEGER DEFAULT 1
    );
    CREATE TABLE brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    );
    -- FR-267: recent_metrics reads the agent_events hunt-cost record. v3 shape =
    -- the legacy db.ts v9 CREATE + the four columns instances migration v3 adds
    -- (model_requested / model_resolved / round / project).
    CREATE TABLE agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('start', 'stop', 'error', 'retry')),
      phase TEXT,
      brief_id TEXT,
      duration_ms INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read INTEGER DEFAULT 0,
      cache_create INTEGER DEFAULT 0,
      result TEXT,
      error_message TEXT,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      model_requested TEXT,
      model_resolved TEXT,
      round INTEGER NOT NULL DEFAULT 1,
      project TEXT
    );
  `);
  return db;
}

function seedProject(
  db: Database.Database,
  overrides: Partial<{
    slug: string;
    name: string;
    path: string;
    tech_stack: string;
    archetype: string;
    status: string;
  }> = {},
): void {
  const data = {
    slug: 'p',
    name: 'P',
    path: '/tmp/p',
    tech_stack: '',
    archetype: 'unclassified',
    status: 'active',
    ...overrides,
  };
  db.prepare(
    `INSERT INTO projects (slug, name, path, tech_stack, archetype, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(data.slug, data.name, data.path, data.tech_stack, data.archetype, data.status);
}

function parseJson(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('handleProjectDashboard (TD-171 M3 — operator override)', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db as unknown as ReturnType<typeof getDb>);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // (a) Single-project mode — slug set
  // -------------------------------------------------------------------------

  it('returns single-project detail view + recent block when slug is set', () => {
    seedProject(db, { slug: 'igris-ai', name: 'Igris', tech_stack: 'typescript', archetype: 'ai-agent-system' });
    db.prepare(`INSERT INTO learnings (project, category, title, content) VALUES (?, ?, ?, ?)`).run(
      'igris-ai', 'pattern', 'L1', 'c',
    );
    db.prepare(`INSERT INTO errors (project, fingerprint, message, solution) VALUES (?, ?, ?, ?)`).run(
      'igris-ai', 'fp1', 'oops', 'sol',
    );
    db.prepare(`INSERT INTO brief_status (project, brief_id, status) VALUES (?, ?, ?)`).run(
      'igris-ai', 'BR-1', 'Done',
    );
    db.prepare(`INSERT INTO brief_status (project, brief_id, status) VALUES (?, ?, ?)`).run(
      'igris-ai', 'BR-2', 'Active',
    );
    db.prepare(`INSERT INTO sessions (project, summary, ended_at) VALUES (?, ?, datetime('now'))`).run(
      'igris-ai', 'session a',
    );
    // FR-267: one paired stop (counted); one open start (not an invocation end,
    // excluded by the event_type predicate); one stop under ANOTHER project
    // (excluded by the project predicate — `project` is stamped on the row).
    const insertEvent = db.prepare(
      `INSERT INTO agent_events (instance_id, agent, event_type, result, project, model_requested, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insertEvent.run('inst-1', 'forger', 'stop', 'success', 'igris-ai', 'claude-fable-5', 1834000);
    insertEvent.run('inst-1', 'sentinel', 'start', null, 'igris-ai', 'claude-fable-5', null);
    insertEvent.run('inst-2', 'forger', 'stop', 'success', 'other-project', 'claude-fable-5', 5000);

    const result = handleProjectDashboard({ slug: 'igris-ai' });
    const payload = parseJson(result);

    expect(payload.mode).toBe('single');
    const project = payload.project as Record<string, unknown>;
    expect(project.slug).toBe('igris-ai');
    expect(project.name).toBe('Igris');
    const totals = payload.totals as Record<string, unknown>;
    expect(totals.learnings).toBe(1);
    expect(totals.errors).toBe(1);
    const briefs = totals.briefs as { total: number; by_status: Record<string, number> };
    expect(briefs.total).toBe(2);
    expect(briefs.by_status).toEqual({ Done: 1, Active: 1 });

    const recent = payload.recent as Record<string, unknown>;
    expect(recent.last_n_days).toBe(30);
    expect(recent.sessions).toBe(1);
    expect(recent.brief_completions).toBe(1);

    const recentMetrics = payload.recent_metrics as Record<string, unknown>[];
    expect(recentMetrics.length).toBe(1);
    expect(recentMetrics[0]).toMatchObject({
      agent: 'forger',
      event_type: 'stop',
      result: 'success',
      duration_ms: 1834000,
      model_requested: 'claude-fable-5',
      round: 1,
    });
  });

  it('errors when slug points at non-existent project', () => {
    const result = handleProjectDashboard({ slug: 'nope' });
    expect(result.content[0].text).toContain('not found');
  });

  it('omits recent_metrics when summary_only=true (single-project mode)', () => {
    seedProject(db, { slug: 'p1' });
    db.prepare(
      `INSERT INTO agent_events (instance_id, agent, event_type, result, project, model_requested) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('inst-1', 'forger', 'stop', 'success', 'p1', 'claude-fable-5');

    const result = handleProjectDashboard({ slug: 'p1', summary_only: true });
    const payload = parseJson(result);
    expect(payload.recent_metrics).toBeUndefined();
    // counts still computed
    expect((payload.totals as Record<string, unknown>).learnings).toBe(0);
  });

  it('igris_project_status text lists recent invocations from agent_events (FR-267)', () => {
    seedProject(db, { slug: 'p2' });
    db.prepare(
      `INSERT INTO agent_events (instance_id, agent, event_type, phase, result, brief_id, project, model_requested, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('inst-1', 'warden', 'stop', 'REVIEWING', 'success', 'FR-267', 'p2', 'claude-fable-5', 90000);
    // An open start is not an invocation end — it must not be listed.
    db.prepare(
      `INSERT INTO agent_events (instance_id, agent, event_type, project, model_requested) VALUES (?, ?, ?, ?, ?)`,
    ).run('inst-1', 'forger', 'start', 'p2', 'claude-fable-5');

    const text = handleProjectStatus({ slug: 'p2' }).content[0].text;
    expect(text).toContain('## Recent Agent Invocations (last 10)');
    expect(text).toContain('warden/stop REVIEWING -> success (90000ms) [FR-267] model=claude-fable-5');
    expect(text).not.toContain('forger/start');
  });

  it('igris_project_status says so when no agent event has been recorded (FR-267)', () => {
    seedProject(db, { slug: 'p3' });
    const text = handleProjectStatus({ slug: 'p3' }).content[0].text;
    expect(text).toContain('(no agent events recorded)');
  });

  // -------------------------------------------------------------------------
  // (b) Cross-project mode — slug omitted, status filter narrows
  // -------------------------------------------------------------------------

  it('returns cross-project view filtered by status', () => {
    seedProject(db, { slug: 'a', status: 'active', archetype: 'ai-agent-system' });
    seedProject(db, { slug: 'b', status: 'active', archetype: 'design-kit' });
    seedProject(db, { slug: 'c', status: 'archived', archetype: 'ai-agent-system' });

    const result = handleProjectDashboard({ status: 'active' });
    const payload = parseJson(result);

    expect(payload.mode).toBe('cross');
    expect(payload.status_filter).toBe('active');
    const totals = payload.totals as Record<string, unknown>;
    expect(totals.total).toBe(2);
    expect(totals.by_status).toEqual({ active: 2, archived: 0, inactive: 0 });
    const byArchetype = totals.by_archetype as Record<string, number>;
    expect(byArchetype['ai-agent-system']).toBe(1);
    expect(byArchetype['design-kit']).toBe(1);

    const projects = payload.projects as Record<string, unknown>[];
    expect(projects.length).toBe(2);
    const slugs = projects.map((p) => p.slug);
    expect(slugs.sort()).toEqual(['a', 'b']);
  });

  it('narrows by archetype filter', () => {
    seedProject(db, { slug: 'a', archetype: 'ai-agent-system' });
    seedProject(db, { slug: 'b', archetype: 'design-kit' });
    seedProject(db, { slug: 'c', archetype: 'ai-agent-system' });

    const result = handleProjectDashboard({ archetype: 'ai-agent-system' });
    const payload = parseJson(result);
    const totals = payload.totals as Record<string, unknown>;
    expect(totals.total).toBe(2);
    expect(payload.archetype_filter).toBe('ai-agent-system');
  });

  it('narrows by tech_stack substring filter', () => {
    seedProject(db, { slug: 'a', tech_stack: 'typescript,node' });
    seedProject(db, { slug: 'b', tech_stack: 'dart,flutter' });
    seedProject(db, { slug: 'c', tech_stack: 'typescript,react' });

    const result = handleProjectDashboard({ tech_stack: 'typescript' });
    const payload = parseJson(result);
    const totals = payload.totals as Record<string, unknown>;
    expect(totals.total).toBe(2);
    expect(payload.tech_stack_filter).toBe('typescript');
  });

  // -------------------------------------------------------------------------
  // (c) summary_only=true returns no per-project rows
  // -------------------------------------------------------------------------

  it('omits per-project rows when summary_only=true (cross-project mode)', () => {
    seedProject(db, { slug: 'a', status: 'active' });
    seedProject(db, { slug: 'b', status: 'active' });

    const result = handleProjectDashboard({ summary_only: true });
    const payload = parseJson(result);
    expect(payload.projects).toBeUndefined();
    const totals = payload.totals as Record<string, unknown>;
    expect(totals.total).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Misc validation
  // -------------------------------------------------------------------------

  it('echoes the days filter on recent.last_n_days', () => {
    seedProject(db);
    const result = handleProjectDashboard({ days: 7 });
    const payload = parseJson(result);
    const recent = payload.recent as Record<string, unknown>;
    expect(recent.last_n_days).toBe(7);
  });

  it('rejects negative days', () => {
    const result = handleProjectDashboard({ days: -5 });
    expect(result.content[0].text).toContain('days must be a non-negative number');
  });

  it('rejects invalid status enum (cross-project mode)', () => {
    const result = handleProjectDashboard({ status: 'bogus' as never });
    expect(result.content[0].text).toContain('invalid status');
  });

  // -------------------------------------------------------------------------
  // Strict-input contract (TD-128)
  // -------------------------------------------------------------------------

  it('rejects unknown args via the gateway strict-input contract (TD-128)', async () => {
    const gateway = createGateway();
    const component = createProjectsComponent();
    gateway.register(component.tools());

    await expect(
      gateway.dispatch('igris_project_dashboard', { bogus: 'x' }),
    ).rejects.toThrowError(/igris_project_dashboard: unknown argument 'bogus'/);
  });

  it('dispatches cleanly via the gateway with no args (cross-project, no filters)', async () => {
    const gateway = createGateway();
    const component = createProjectsComponent();
    gateway.register(component.tools());

    seedProject(db);
    const result = await gateway.dispatch('igris_project_dashboard', {});
    const payload = parseJson(result as { content: { text: string }[] });
    expect(payload.mode).toBe('cross');
    const totals = payload.totals as Record<string, unknown>;
    expect(totals.total).toBe(1);
  });
});
