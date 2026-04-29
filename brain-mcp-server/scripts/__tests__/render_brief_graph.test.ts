/**
 * FR-111 — render_brief_graph integration tests
 *
 * Boots a temp SQLite DB with the same schema set used in production
 * (brief_status v2, brief_files v6, goals v1, entity_edges v1+v2),
 * seeds a known graph, and runs `renderGraphForProject` against a
 * temp output path. Verifies:
 *   - end-to-end render shape (file exists, contains markers)
 *   - output path override works
 *   - performance budget (200 nodes / 500 edges < 500ms)
 *   - HTML size budget (< 1.5 MB)
 *   - XSS-attempt brief title is rendered inert
 *   - idempotency (byte-identical output for identical inputs)
 *
 * @module scripts/__tests__/render_brief_graph.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { renderGraphFromDb } from '../../src/engine/components/edges/visualization-tool.js';
import { edgeMigrations } from '../../src/engine/components/edges/schema.js';

// ---------------------------------------------------------------------------
// Test DB setup (mirrors visualization.test.ts)
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      brief_type TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT,
      effort TEXT,
      phase TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project, brief_id)
    );
    CREATE TABLE brief_files (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project, brief_id)
    );
    CREATE TABLE goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id TEXT NOT NULL UNIQUE,
      project_slug TEXT,
      title TEXT NOT NULL,
      description TEXT,
      outcome TEXT NOT NULL,
      deadline TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      priority TEXT NOT NULL DEFAULT 'P2-Medium',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      achieved_at TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );
  `);
  for (const migration of edgeMigrations) {
    db.exec(migration.sql);
  }
  return db;
}

function seedSmallGraph(db: Database.Database): void {
  // 5 briefs, 7 edges (mix of edge types).
  const briefs = [
    ['FR-001', 'Feature one'],
    ['FR-002', 'Feature two'],
    ['TD-003', 'Tech debt three'],
    ['BR-004', 'Bug four'],
    ['MG-005', 'Migration five'],
  ];
  for (const [id, title] of briefs) {
    db.prepare(
      `INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority, effort, phase)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('test-proj', id, 'Feature', title, 'In Progress', 'P2-Medium', 'M-Medium (1-2d)', 'BUILDING');
  }
  const edges = [
    ['FR-001', 'FR-002', 'depends_on'],
    ['FR-001', 'TD-003', 'related_to'],
    ['FR-002', 'BR-004', 'blocks'],
    ['TD-003', 'MG-005', 'depends_on'],
    ['BR-004', 'MG-005', 'related_to'],
    ['FR-001', 'BR-004', 'related_to'],
    ['FR-002', 'MG-005', 'parent_of'],
  ];
  for (const [from, to, type] of edges) {
    db.prepare(
      `INSERT INTO entity_edges (from_type, from_id, to_type, to_id, edge_type, confidence, provenance, metadata)
       VALUES ('brief', ?, 'brief', ?, ?, 1.0, 'observed', '{}')`,
    ).run(from, to, type);
  }
}

/** Seed N briefs and M random edges for performance benchmarking. */
function seedLargeGraph(db: Database.Database, n: number, m: number): void {
  const insertBrief = db.prepare(
    `INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority)
     VALUES (?, ?, 'Feature', ?, 'In Progress', 'P2-Medium')`,
  );
  const txn = db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const id = `FR-${String(i).padStart(4, '0')}`;
      insertBrief.run('large-proj', id, `Title ${i}`);
    }
    const insertEdge = db.prepare(
      `INSERT INTO entity_edges (from_type, from_id, to_type, to_id, edge_type, confidence, provenance, metadata)
       VALUES ('brief', ?, 'brief', ?, 'related_to', 1.0, 'observed', '{}')`,
    );
    let inserted = 0;
    let attempts = 0;
    while (inserted < m && attempts < m * 5) {
      attempts++;
      const a = Math.floor(Math.random() * n);
      const b = Math.floor(Math.random() * n);
      if (a === b) continue; // related_to disallows self-loops
      const fromId = `FR-${String(a).padStart(4, '0')}`;
      const toId = `FR-${String(b).padStart(4, '0')}`;
      try {
        insertEdge.run(fromId, toId);
        inserted++;
      } catch {
        // UNIQUE collision — retry
      }
    }
  });
  txn();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('renderGraphFromDb integration', () => {
  let db: Database.Database;
  let tmpDir: string;
  // Path to the actual template (resolved relative to this test file).
  // Uses fileURLToPath for cross-platform portability (Windows file URLs
  // produce paths like `/C:/...` from `URL.pathname`).
  const templateFile = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'render_brief_graph.template.html',
  );

  beforeEach(() => {
    db = createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr111-test-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // §4.2 #1 — End-to-end render
  // -------------------------------------------------------------------------
  it('renders a self-contained HTML file with vis-network, payload, and structural markers', () => {
    seedSmallGraph(db);
    const outPath = path.join(tmpDir, 'graph.html');

    const result = renderGraphFromDb({
      db,
      project: 'test-proj',
      outPath,
      generatedAt: '2026-04-29T12:00:00Z',
      templateFile,
    });

    expect(result.outPath).toBe(outPath);
    expect(fs.existsSync(outPath)).toBe(true);

    const html = fs.readFileSync(outPath, 'utf8');
    expect(html).toContain('<title>Igris Brief Graph');
    expect(html).toContain('vis-network@9.1.9');
    expect(html).toContain('Brief Graph: ');
    // Payload is parseable.
    expect(html).toContain('"project":"test-proj"');
    expect(html).toContain('"brief_count":5');
    expect(html).toContain('"edge_count":7');
    expect(html).toContain('"goal_count":0');
    expect(result.payload.nodes).toHaveLength(5);
    expect(result.payload.edges).toHaveLength(7);
  });

  // -------------------------------------------------------------------------
  // §4.2 #2 — Output path override
  // -------------------------------------------------------------------------
  it('honors the outPath override', () => {
    seedSmallGraph(db);
    const outPath = path.join(tmpDir, 'sub', 'nested', 'g.html');

    const result = renderGraphFromDb({
      db,
      project: 'test-proj',
      outPath,
      templateFile,
    });

    expect(result.outPath).toBe(outPath);
    expect(fs.existsSync(outPath)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // §4.2 #3 — Performance budget
  // -------------------------------------------------------------------------
  it('renders 200 nodes / 500 edges in under 500ms', () => {
    seedLargeGraph(db, 200, 500);
    const outPath = path.join(tmpDir, 'large.html');

    const result = renderGraphFromDb({
      db,
      project: 'large-proj',
      outPath,
      templateFile,
    });

    expect(result.payload.nodes).toHaveLength(200);
    // We may have collisions during random seeding — but should be near 500.
    expect(result.payload.edges.length).toBeGreaterThan(400);
    // Performance budget per AC.
    expect(result.renderTimeMs).toBeLessThan(500);
  });

  // -------------------------------------------------------------------------
  // §4.2 #4 — HTML size budget
  // -------------------------------------------------------------------------
  it('keeps the output HTML under 1.5 MB for 200/500 graph', () => {
    seedLargeGraph(db, 200, 500);
    const outPath = path.join(tmpDir, 'large.html');
    const result = renderGraphFromDb({
      db,
      project: 'large-proj',
      outPath,
      templateFile,
    });
    expect(result.htmlSizeBytes).toBeLessThan(1.5 * 1024 * 1024);
  });

  // -------------------------------------------------------------------------
  // §4.2 #5 — No XSS via brief title
  // -------------------------------------------------------------------------
  it('renders inert when a brief title contains a script-tag-break payload', () => {
    db.prepare(
      `INSERT INTO brief_status (project, brief_id, brief_type, title, status)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('xss-proj', 'BR-XSS', 'Bug', '</script><script>alert(1)</script>', 'In Progress');

    const outPath = path.join(tmpDir, 'xss.html');
    renderGraphFromDb({
      db,
      project: 'xss-proj',
      outPath,
      templateFile,
    });
    const html = fs.readFileSync(outPath, 'utf8');

    // The injected </script> must be neutralized — not appear as a literal tag.
    // Total </script> count should be exactly 2 (vis-network CDN script + our inline script).
    const closeCount = (html.match(/<\/script>/g) || []).length;
    expect(closeCount).toBe(2);

    // The brief title contained <script>alert(1)</script> — that literal must
    // not appear in the HTML at all (escaped to </> in the JSON).
    expect(html).not.toContain('<script>alert(1)</script>');
    // The escaped form must be present.
    expect(html).toContain('\\u003cscript\\u003ealert');
  });

  // -------------------------------------------------------------------------
  // §4.2 #6 — Idempotency (byte-identical output for fixed timestamp)
  // -------------------------------------------------------------------------
  it('produces byte-identical output across two renders with the same generatedAt', () => {
    seedSmallGraph(db);
    const a = path.join(tmpDir, 'a.html');
    const b = path.join(tmpDir, 'b.html');
    const generatedAt = '2026-04-29T12:00:00Z';

    renderGraphFromDb({ db, project: 'test-proj', outPath: a, generatedAt, templateFile });
    renderGraphFromDb({ db, project: 'test-proj', outPath: b, generatedAt, templateFile });

    const ha = fs.readFileSync(a);
    const hb = fs.readFileSync(b);
    expect(ha.equals(hb)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Empty project — no error, empty graph
  // -------------------------------------------------------------------------
  it('returns an empty graph for projects with no briefs', () => {
    const outPath = path.join(tmpDir, 'empty.html');
    const result = renderGraphFromDb({
      db,
      project: 'no-such-project',
      outPath,
      templateFile,
    });

    expect(result.payload.stats.brief_count).toBe(0);
    expect(result.payload.stats.edge_count).toBe(0);
    expect(fs.existsSync(outPath)).toBe(true);
    const html = fs.readFileSync(outPath, 'utf8');
    expect(html).toContain('"project":"no-such-project"');
  });
});
