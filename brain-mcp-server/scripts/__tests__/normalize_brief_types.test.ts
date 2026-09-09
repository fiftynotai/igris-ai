/**
 * Tests for scripts/normalize_brief_types.ts (TD-328).
 *
 * The script is the AC-2 dry-run surface: it must report EVERY proposed row
 * change before any write, and it must write NOTHING unless `--apply` is
 * explicitly passed.
 *
 * Fixture discipline: every test builds its own `:memory:` DB with a minimal
 * brief_status/brief_files shape. Nothing here touches
 * `~/.igris/memory/knowledge.db`.
 *
 * @module scripts/__tests__/normalize_brief_types
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseCliArgs,
  planNormalization,
  applyPlan,
  renderReport,
  runCli,
} from '../normalize_brief_types.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const FIXED_TS = '2026-01-01 00:00:00';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      brief_type TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT,
      phase TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE brief_files (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function seed(
  db: Database.Database,
  briefId: string,
  briefType: string | null,
  title = `T ${briefId}`,
  content?: string,
  project = 'p',
): void {
  db.prepare(
    `INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority, phase, updated_at)
     VALUES (?, ?, ?, ?, 'Ready', 'P2-Medium', 'INIT', ?)`,
  ).run(project, briefId, briefType, title, FIXED_TS);
  if (content !== undefined) {
    db.prepare(
      `INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, 'h', ?)`,
    ).run(`${project}:${briefId}`, project, briefId, `${briefId}.md`, content, FIXED_TS);
  }
}

// ---------------------------------------------------------------------------
// Arg parsing — the #208 default
// ---------------------------------------------------------------------------

describe('parseCliArgs — dry-run is the DEFAULT (#208)', () => {
  const argv = (...rest: string[]): string[] => ['node', 'normalize_brief_types.ts', ...rest];

  it('defaults to dryRun=true with no flags', () => {
    expect(parseCliArgs(argv()).dryRun).toBe(true);
  });

  it('only --apply flips it to a write', () => {
    expect(parseCliArgs(argv('--apply')).dryRun).toBe(false);
    // Near-misses must NOT enable writes.
    expect(parseCliArgs(argv('--dry-run')).dryRun).toBe(true);
    expect(parseCliArgs(argv('--applyy')).dryRun).toBe(true);
  });

  it('parses --project / --db / --json', () => {
    const a = parseCliArgs(
      argv('--project', 'igris-ai', '--db', '/tmp/x.db', '--json', '/tmp/p.json'),
    );
    expect(a.projectFilter).toBe('igris-ai');
    expect(a.dbPathOverride).toBe('/tmp/x.db');
    expect(a.jsonOut).toBe('/tmp/p.json');
    expect(a.dryRun).toBe(true);
  });

  it('throws when a value flag is missing its argument', () => {
    expect(() => parseCliArgs(argv('--db'))).toThrow(/--db requires an argument/);
    expect(() => parseCliArgs(argv('--project', '--apply'))).toThrow(
      /--project requires an argument/,
    );
  });
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

describe('planNormalization', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it('plans an alias fold with brief_id, old, new and a reason (AC-2)', () => {
    seed(db, 'TD-001', 'TechDebt');
    const plan = planNormalization(db);

    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({
      project: 'p',
      brief_id: 'TD-001',
      from: 'TechDebt',
      to: 'Technical Debt',
      reason: 'alias',
    });
    expect(plan.changes[0].detail).toBeTruthy();
  });

  it('does NOT plan a change for an already-canonical row', () => {
    seed(db, 'FR-001', 'Feature');
    expect(planNormalization(db).changes).toHaveLength(0);
  });

  it('plans a case-fold separately from an alias fold', () => {
    seed(db, 'FR-001', 'feature');
    const plan = planNormalization(db);
    expect(plan.changes[0]).toMatchObject({ to: 'Feature', reason: 'case' });
  });

  it('folds a compound only when the qualifier survives (D4), and reports the rest', () => {
    seed(db, 'BR-100', 'Bug Fix / Refactor', 'BGM Playlist Refactor');
    seed(db, 'BR-101', 'Bug Fix / Compliance', 'Forms Demo', 'must reach compliance');
    seed(db, 'BR-102', 'Feature / Infrastructure', 'Higgsfield MCP Server', 'ship the SDK');

    const plan = planNormalization(db);
    const folded = plan.changes.filter((c) => c.reason === 'compound-recoverable');
    expect(folded.map((c) => c.brief_id).sort()).toEqual(['BR-100', 'BR-101']);
    expect(folded.every((c) => c.detail.includes('survives'))).toBe(true);

    const left = plan.unfolded.find((u) => u.value === 'Feature / Infrastructure');
    expect(left).toBeDefined();
    expect(left?.brief_ids).toEqual(['BR-102']);
    expect(left?.reason).toMatch(/D4 gate/);
    expect(plan.compoundRows).toBe(3);
  });

  it('infers NULL types from unambiguous prefixes and explains the ones it will not', () => {
    seed(db, 'FR-900', null);
    seed(db, 'TD-900', null);
    seed(db, 'BR-900', null);
    seed(db, 'INT-900', null);

    const plan = planNormalization(db);
    const inferred = plan.changes.filter((c) => c.reason === 'prefix-inference');
    expect(inferred.map((c) => [c.brief_id, c.to])).toEqual([
      ['FR-900', 'Feature'],
      ['TD-900', 'Technical Debt'],
    ]);

    // AC-4: every non-inferred NULL row is EXPLAINED.
    const nullBuckets = plan.unfolded.filter((u) => u.value === null);
    const ids = nullBuckets.flatMap((u) => u.brief_ids).sort();
    expect(ids).toEqual(['BR-900', 'INT-900']);
    expect(nullBuckets.some((u) => /ambiguous/.test(u.reason))).toBe(true);
  });

  it('reports every unfolded value with a reason (nothing folds silently)', () => {
    seed(db, 'BR-030', 'BR');
    seed(db, 'BR-031', 'Spike');
    seed(db, 'BR-033', 'Bug/Feature');
    seed(db, 'BR-034', 'Frobnicate');

    const plan = planNormalization(db);
    expect(plan.changes).toHaveLength(0);
    expect(plan.unfolded.map((u) => u.value).sort()).toEqual([
      'BR',
      'Bug/Feature',
      'Frobnicate',
      'Spike',
    ]);
    for (const u of plan.unfolded) {
      expect(u.reason.length).toBeGreaterThan(0);
    }
  });

  it('honors the --project scope', () => {
    seed(db, 'TD-001', 'TechDebt', 'T', undefined, 'a');
    seed(db, 'TD-002', 'TechDebt', 'T', undefined, 'b');

    expect(planNormalization(db).changes).toHaveLength(2);
    const scoped = planNormalization(db, 'a');
    expect(scoped.changes).toHaveLength(1);
    expect(scoped.changes[0].project).toBe('a');
  });

  it('counts distinct values before and after', () => {
    seed(db, 'TD-001', 'TechDebt');
    seed(db, 'TD-002', 'Debt');
    seed(db, 'TD-003', 'Technical Debt');
    const plan = planNormalization(db);
    expect(plan.distinctBefore).toBe(3);
    expect(plan.distinctAfter).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The write guard
// ---------------------------------------------------------------------------

describe('dry-run writes NOTHING — at the CLI layer, where the DB is opened', () => {
  // These exercise `runCli`, NOT just `planNormalization`. The original defect
  // was ENTIRELY in the connection setup: the script called `getDb()`, which
  // opens read-write, sets `journal_mode = WAL`, and runs `migrateSchema()` —
  // so a "dry-run" against a v21 snapshot silently migrated and folded it
  // before planning. A test that only calls the planner cannot see that; the
  // guard has to sit at the same layer as the claim.
  let tmpDir: string;
  let dbPath: string;
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td328-cli-'));
    dbPath = path.join(tmpDir, 'knowledge.db');

    // A file DB seeded at v21 with the pre-fold spelling zoo — i.e. exactly the
    // snapshot an operator points `--db` at during the AC-2 review step.
    const seedDb = new Database(dbPath);
    seedDb.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      CREATE TABLE brief_status (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL, brief_id TEXT NOT NULL, brief_type TEXT,
        title TEXT NOT NULL, status TEXT NOT NULL, priority TEXT, phase TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE brief_files (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, brief_id TEXT NOT NULL,
        filename TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    for (let v = 1; v <= 21; v++) {
      seedDb.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(v);
    }
    seed(seedDb, 'TD-001', 'TechDebt');
    seed(seedDb, 'FR-002', 'Feature Request');
    seed(seedDb, 'BR-900', null);
    seedDb.close();

    logs = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const argv = (...rest: string[]): string[] => [
    'node',
    'normalize_brief_types.ts',
    '--db',
    dbPath,
    ...rest,
  ];

  const readAll = (): Array<{ brief_id: string; brief_type: string | null }> => {
    const d = new Database(dbPath, { readonly: true });
    try {
      return d
        .prepare('SELECT brief_id, brief_type FROM brief_status ORDER BY brief_id')
        .all() as Array<{ brief_id: string; brief_type: string | null }>;
    } finally {
      d.close();
    }
  };
  const version = (): number => {
    const d = new Database(dbPath, { readonly: true });
    try {
      return (d.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
    } finally {
      d.close();
    }
  };

  it('leaves a v21 snapshot at v21 with every spelling intact (the B1 regression)', async () => {
    const before = readAll();

    const code = await runCli(argv());

    expect(code).toBe(0);
    // The DB must NOT have been migrated by the act of reading it.
    expect(version()).toBe(21);
    expect(readAll()).toEqual(before);
    expect(readAll().find((r) => r.brief_id === 'TD-001')?.brief_type).toBe('TechDebt');
    expect(readAll().find((r) => r.brief_id === 'FR-002')?.brief_type).toBe('Feature Request');
    expect(readAll().find((r) => r.brief_id === 'BR-900')?.brief_type).toBeNull();
  });

  it('does not create a .pre-v22.bak beside the snapshot (no migration ran)', async () => {
    await runCli(argv());
    expect(fs.existsSync(`${dbPath}.pre-v22.bak`)).toBe(false);
  });

  it('still produces the full reviewable plan while writing nothing (AC-2)', async () => {
    await runCli(argv());
    const out = logs.join('\n');
    expect(out).toContain('DRY-RUN');
    expect(out).toContain('"TechDebt" -> "Technical Debt"');
    expect(out).toContain('"Feature Request" -> "Feature"');
    expect(out).toContain('nothing was written');
  });

  it('pointing --db at the UNDO FILE cannot damage it', async () => {
    // The reversibility story designates `<db>.pre-v22.bak` as the undo, and it
    // is only an undo while it still holds PRE-fold spellings. Reading it must
    // never migrate it.
    const bak = `${dbPath}.pre-v22.bak`;
    fs.copyFileSync(dbPath, bak);
    const bakBefore = fs.readFileSync(bak);

    const code = await runCli(['node', 'normalize_brief_types.ts', '--db', bak]);

    expect(code).toBe(0);
    expect(fs.readFileSync(bak).equals(bakBefore)).toBe(true);
    expect(fs.existsSync(`${bak}.pre-v22.bak`)).toBe(false);
  });

  it('the dry-run connection is READ-ONLY, so a write is refused by SQLite', async () => {
    // Belt-and-braces: the guarantee is enforced by the connection, not by a
    // branch. Prove the same open mode the CLI uses actually refuses a write.
    const ro = new Database(dbPath, { readonly: true });
    try {
      expect(() =>
        ro.prepare(`UPDATE brief_status SET brief_type = 'x'`).run(),
      ).toThrow(/readonly|read-only/i);
    } finally {
      ro.close();
    }
  });

  it('--apply DOES write, through the same entry point', async () => {
    const code = await runCli(argv('--apply'));
    expect(code).toBe(0);
    expect(readAll().find((r) => r.brief_id === 'TD-001')?.brief_type).toBe('Technical Debt');
    expect(readAll().find((r) => r.brief_id === 'FR-002')?.brief_type).toBe('Feature');
    // BR- stays NULL even on apply (D5 ambiguity).
    expect(readAll().find((r) => r.brief_id === 'BR-900')?.brief_type).toBeNull();
    // ...and it STILL does not migrate: the script is an alternative to v22,
    // not a trigger for it.
    expect(version()).toBe(21);
  });

  it('a missing DB path is a clean error, not a stack trace', async () => {
    const code = await runCli([
      'node',
      'normalize_brief_types.ts',
      '--db',
      path.join(tmpDir, 'nope.db'),
    ]);
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('brain DB not found');
  });
});

describe('planner-level dry-run purity (#208)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seed(db, 'TD-001', 'TechDebt');
    seed(db, 'FR-002', 'Feature Request');
  });
  afterEach(() => db.close());

  const snapshot = (): unknown[] =>
    db.prepare('SELECT * FROM brief_status ORDER BY brief_id').all();

  it('planNormalization + renderReport leave every row untouched', () => {
    const before = snapshot();
    const plan = planNormalization(db);
    const report = renderReport(plan, false);

    expect(snapshot()).toEqual(before);
    expect(report).toContain('DRY-RUN');
    expect(report).toContain('nothing was written');
    // The report names every proposed change.
    expect(report).toContain('TD-001');
    expect(report).toContain('"TechDebt" -> "Technical Debt"');
    expect(report).toContain('FR-002');
  });

  it('applyPlan writes brief_type and ONLY brief_type (updated_at untouched)', () => {
    const before = db
      .prepare('SELECT brief_id, title, status, priority, phase, updated_at FROM brief_status ORDER BY brief_id')
      .all();

    const changed = applyPlan(db, planNormalization(db));
    expect(changed).toBe(2);

    expect(
      db
        .prepare('SELECT brief_id, title, status, priority, phase, updated_at FROM brief_status ORDER BY brief_id')
        .all(),
    ).toEqual(before);
    expect(
      db.prepare(`SELECT brief_type FROM brief_status WHERE brief_id='TD-001'`).get(),
    ).toEqual({ brief_type: 'Technical Debt' });
  });

  it('applying twice is a no-op the second time', () => {
    applyPlan(db, planNormalization(db));
    const secondPlan = planNormalization(db);
    expect(secondPlan.changes).toHaveLength(0);
    expect(applyPlan(db, secondPlan)).toBe(0);
  });
});

describe('renderReport — the D4 escalation tripwire', () => {
  let db: Database.Database;
  beforeEach(() => (db = makeDb()));
  afterEach(() => db.close());

  it('stays quiet below the threshold', () => {
    seed(db, 'BR-100', 'Bug Fix / Refactor', 'a refactor');
    for (let i = 0; i < 60; i++) seed(db, `FR-${i}`, 'Feature');
    expect(renderReport(planNormalization(db), false)).not.toContain('ESCALATION TRIPWIRE');
  });

  it('fires above 5% of the corpus and names the brief to file', () => {
    for (let i = 0; i < 10; i++) seed(db, `BR-${100 + i}`, 'Bug/Feature');
    for (let i = 0; i < 20; i++) seed(db, `FR-${i}`, 'Feature');
    const report = renderReport(planNormalization(db), false);
    expect(report).toContain('D4 ESCALATION TRIPWIRE');
    expect(report).toContain('brief_subtype');
  });
});
