/**
 * FR-240 — `tools/briefs-read.ts` unit tests.
 *
 * These run against a fixture DB passed as a PARAMETER. There is no `getDb`
 * mock in this file and no `vi.mock('../../db.js')` — that absence is itself
 * evidence for the D1 claim: a pure reader is reachable from a caller that owns
 * its own handle, which is exactly what the dashboard will be.
 *
 * WHAT THESE GATES PROVE
 * ----------------------
 * That each filter BINDS (by asserting the excluded ids too, not just the
 * included ones), that pagination is stable, and that both `getBrief` branches
 * return the same key shape.
 *
 * WHAT THEY DO NOT PROVE
 * ----------------------
 *  - That the MCP wrappers still emit the same bytes over these results.
 *    **Sibling:** `wrapper-wire-parity.test.ts`.
 *  - That the module is import-pure. **Sibling:** `pure-read-purity.test.ts`.
 *  - That the HTTP layer forwards them. **Sibling:**
 *    `cli/src/__tests__/dashboard-layers-endpoint.test.ts`.
 *
 * @module tools/__tests__/briefs-read.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { listBriefs, getBrief } from '../briefs-read.js';

let db: Database.Database;

/**
 * Fixture with DISAGREEING filter partitions (G-EP-1): no two filter values
 * select the same row set, so a test cannot pass with a WHERE clause deleted.
 *
 *  id      | project   | type      | status      | priority  | effort
 *  FR-240  | igris-ai  | feature   | In Progress | P1-High   | XL
 *  TD-312  | igris-ai  | tech-debt | Pending     | P2-Medium | S
 *  BR-001  | igris-ai  | bug       | Done        | P1-High   | M
 *  BR-001  | other     | bug       | Pending     | P3-Low    | S     <- BR-078
 */
function makeDb(): Database.Database {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL, brief_id TEXT NOT NULL, brief_type TEXT,
      title TEXT NOT NULL, status TEXT NOT NULL, priority TEXT,
      effort TEXT, phase TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE brief_files (
      id TEXT PRIMARY KEY, project TEXT NOT NULL, brief_id TEXT NOT NULL,
      filename TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL, UNIQUE(project, brief_id)
    );
  `);
  const ins = d.prepare(
    `INSERT INTO brief_status
       (project, brief_id, brief_type, title, status, priority, effort, phase, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  ins.run('igris-ai', 'FR-240', 'feature', 'Layer views', 'In Progress', 'P1-High', 'XL', 'BUILDING', '2026-07-30 09:00:00');
  ins.run('igris-ai', 'TD-312', 'tech-debt', 'CI gap', 'Pending', 'P2-Medium', 'S', null, '2026-07-29 09:00:00');
  ins.run('igris-ai', 'BR-001', 'bug', 'Igris bug', 'Done', 'P1-High', 'M', null, '2026-07-28 09:00:00');
  ins.run('other', 'BR-001', 'bug', 'Other-project bug', 'Pending', 'P3-Low', 'S', null, '2026-07-27 09:00:00');

  d.prepare(
    `INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('bf-1', 'igris-ai', 'FR-240', 'FR-240.md', '# body', 'hash1', '2026-07-30 08:00:00');
  return d;
}

/** `(project, brief_id)` pairs of a result, in returned order. */
function keys(rows: Record<string, unknown>[]): string[] {
  return rows.map((r) => `${String(r.project)}/${String(r.brief_id)}`);
}

beforeEach(() => {
  db = makeDb();
});
afterEach(() => {
  db.close();
});

describe('listBriefs — ordering and pagination', () => {
  it('orders by updated_at DESC and reports count/total/limit/offset', () => {
    const r = listBriefs(db);
    expect(keys(r.briefs)).toEqual([
      'igris-ai/FR-240',
      'igris-ai/TD-312',
      'igris-ai/BR-001',
      'other/BR-001',
    ]);
    expect(r.count).toBe(4);
    expect(r.total).toBe(4);
    expect(r.limit).toBe(25);
    expect(r.offset).toBe(0);
  });

  it('paginates without losing or repeating rows', () => {
    const page1 = listBriefs(db, { limit: 2, offset: 0 });
    const page2 = listBriefs(db, { limit: 2, offset: 2 });
    expect(keys(page1.briefs)).toEqual(['igris-ai/FR-240', 'igris-ai/TD-312']);
    expect(keys(page2.briefs)).toEqual(['igris-ai/BR-001', 'other/BR-001']);
    // `total` is the UNPAGINATED count on both pages — the property a pager needs.
    expect(page1.total).toBe(4);
    expect(page2.total).toBe(4);
    expect(page2.count).toBe(2);
  });

  it('limit 0 means "no LIMIT clause", not "zero rows" (briefs.ts:409 semantic)', () => {
    const r = listBriefs(db, { limit: 0 });
    expect(r.count).toBe(4);
    expect(r.limit).toBe(0);
  });

  it('clamps a negative limit up to 1 and a negative offset to 0', () => {
    const r = listBriefs(db, { limit: -5, offset: -3 });
    expect(r.limit).toBe(1);
    expect(r.offset).toBe(0);
    expect(r.count).toBe(1);
  });
});

describe('listBriefs — every filter binds (G-EP-1: assert the EXCLUSIONS)', () => {
  it('project', () => {
    const r = listBriefs(db, { project: 'other' });
    expect(keys(r.briefs)).toEqual(['other/BR-001']);
    expect(keys(r.briefs)).not.toContain('igris-ai/BR-001');
    expect(r.total).toBe(1);
  });

  it('status', () => {
    const r = listBriefs(db, { status: 'Pending' });
    expect(keys(r.briefs)).toEqual(['igris-ai/TD-312', 'other/BR-001']);
    expect(keys(r.briefs)).not.toContain('igris-ai/FR-240');
  });

  it('brief_type', () => {
    const r = listBriefs(db, { brief_type: 'bug' });
    expect(keys(r.briefs)).toEqual(['igris-ai/BR-001', 'other/BR-001']);
    expect(keys(r.briefs)).not.toContain('igris-ai/TD-312');
  });

  it('priority', () => {
    const r = listBriefs(db, { priority: 'P1-High' });
    expect(keys(r.briefs)).toEqual(['igris-ai/FR-240', 'igris-ai/BR-001']);
    expect(keys(r.briefs)).not.toContain('igris-ai/TD-312');
  });

  it('effort — the filter FR-240 ADDED (the column already existed)', () => {
    const r = listBriefs(db, { effort: 'S' });
    expect(keys(r.briefs)).toEqual(['igris-ai/TD-312', 'other/BR-001']);
    // Discriminating: the two XL/M rows must be gone. A no-op filter returns 4.
    expect(r.count).toBe(2);
    expect(r.total).toBe(2);
  });

  it('filters compose with AND, and `total` respects them', () => {
    const r = listBriefs(db, { project: 'igris-ai', priority: 'P1-High', effort: 'XL' });
    expect(keys(r.briefs)).toEqual(['igris-ai/FR-240']);
    expect(r.total).toBe(1);
  });

  it('a filter value that matches nothing yields an empty page, not a throw', () => {
    const r = listBriefs(db, { status: 'Nonexistent' });
    expect(r.briefs).toEqual([]);
    expect(r.total).toBe(0);
  });
});

describe('listBriefs — content projection (D7)', () => {
  it('omits body columns by default', () => {
    const row = listBriefs(db, { project: 'igris-ai', brief_type: 'feature' }).briefs[0];
    expect(Object.keys(row)).not.toContain('content');
    expect(Object.keys(row)).toEqual([
      'project', 'brief_id', 'brief_type', 'title', 'status',
      'priority', 'effort', 'phase', 'updated_at',
    ]);
  });

  it('include_content LEFT JOINs brief_files and keeps rows with no file', () => {
    const r = listBriefs(db, { include_content: true });
    expect(r.count).toBe(4);
    const withFile = r.briefs.find((b) => b.brief_id === 'FR-240');
    expect(withFile?.content).toBe('# body');
    expect(withFile?.filename).toBe('FR-240.md');
    // LEFT, not INNER: the three file-less briefs survive with null content.
    const withoutFile = r.briefs.find((b) => b.brief_id === 'TD-312');
    expect(withoutFile?.content).toBeNull();
  });
});

describe('getBrief', () => {
  it('JOIN path returns content plus status metadata', () => {
    const rec = getBrief(db, 'igris-ai', 'FR-240');
    expect(rec).not.toBeNull();
    expect(rec?.content).toBe('# body');
    expect(rec?.title).toBe('Layer views');
    expect(rec?.status).toBe('In Progress');
    // status_updated_at wins over file_updated_at when both exist.
    expect(rec?.updated_at).toBe('2026-07-30 09:00:00');
  });

  it('fallback path returns the SAME key set with null body fields', () => {
    const joined = getBrief(db, 'igris-ai', 'FR-240');
    const fallback = getBrief(db, 'igris-ai', 'TD-312');
    expect(fallback).not.toBeNull();
    expect(fallback?.content).toBeNull();
    expect(fallback?.filename).toBeNull();
    expect(fallback?.content_hash).toBeNull();
    // Key-set symmetry is the reason ONE interface covers both branches; a
    // divergence here would make the wire shape depend on the data.
    expect(Object.keys(fallback as object)).toEqual(Object.keys(joined as object));
  });

  it('BR-078 — the same brief_id in two projects returns two different records', () => {
    const a = getBrief(db, 'igris-ai', 'BR-001');
    const b = getBrief(db, 'other', 'BR-001');
    expect(a?.title).toBe('Igris bug');
    expect(b?.title).toBe('Other-project bug');
    expect(a?.title).not.toBe(b?.title);
  });

  it('returns null (not a message) when absent — the string is the wrapper’s', () => {
    expect(getBrief(db, 'igris-ai', 'NOPE-9')).toBeNull();
    expect(getBrief(db, 'no-such-project', 'FR-240')).toBeNull();
  });
});

describe('the reader never writes (AC #7, structurally)', () => {
  it('every function works on a query_only handle', () => {
    // The `query_only` pragma is exactly the posture the CLI bridge installs
    // (D2). Running the readers under it here proves — on the brain side,
    // before any CLI code exists — that none of them needs write access.
    db.pragma('query_only = ON');
    expect(() => listBriefs(db, { project: 'igris-ai' })).not.toThrow();
    expect(() => getBrief(db, 'igris-ai', 'FR-240')).not.toThrow();

    // Self-negative-control: prove `query_only = ON` is actually armed on this
    // handle. Without this line, the two assertions above would also pass on a
    // handle where the pragma silently did nothing.
    expect(() =>
      db.prepare("UPDATE brief_status SET status = 'x' WHERE brief_id = 'FR-240'").run(),
    ).toThrow();
  });
});
