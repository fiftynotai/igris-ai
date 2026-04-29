/**
 * TD-057 — backfill_brief_edges unit + integration tests
 *
 * Covers:
 *   - extractSignals() against every label pattern + negative cases
 *   - parseCliArgs() flag handling
 *   - runBackfill() end-to-end on an in-memory DB:
 *     * idempotency (run twice, second pass inserts 0)
 *     * --dry-run leaves the DB untouched
 *     * --project filter scopes the scan
 *     * unknown target ids -> warnings, not errors
 *     * brief-vs-goal target routing
 *
 * Mirrors the in-memory DB pattern used in
 * `src/engine/components/edges/__tests__/handlers.test.ts`.
 *
 * @module scripts/__tests__/backfill_brief_edges.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

// Mock the db module so handlers in handleEdgeCreate resolve getDb() to
// the in-memory DB we control. Path is two dirs up from __tests__ to
// reach src/db.js.
vi.mock('../../src/db.js', () => ({ getDb: vi.fn() }));

import { getDb } from '../../src/db.js';
import {
  extractSignals,
  runBackfill,
  writeSignal,
  parseCliArgs,
  type EdgeSignal,
} from '../backfill_brief_edges.js';
import { edgeMigrations } from '../../src/engine/components/edges/schema.js';

// ---------------------------------------------------------------------------
// Test DB setup
// ---------------------------------------------------------------------------

/**
 * Build an in-memory SQLite DB with the minimal schema this script needs:
 * brief_files (source of markdown), brief_status (target existence checks),
 * and entity_edges (the table we're populating).
 */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE brief_files (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL DEFAULT 'x',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project, brief_id)
    );
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
  `);
  for (const migration of edgeMigrations) {
    db.exec(migration.sql);
  }
  return db;
}

/** Insert a brief_files row for the given (project, brief_id, content). */
function seedBriefFile(db: Database.Database, project: string, briefId: string, content: string): void {
  db.prepare(
    `INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`${project}:${briefId}`, project, briefId, `${briefId}.md`, content, 'h');
}

/** Insert a brief_status row so target existence checks pass. */
function seedBriefStatus(db: Database.Database, project: string, briefId: string): void {
  db.prepare(
    `INSERT INTO brief_status (project, brief_id, title, status)
     VALUES (?, ?, ?, ?)`,
  ).run(project, briefId, `Brief ${briefId}`, 'Ready');
}

/** Load the bundled fixture as a string. */
function loadSampleBrief(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.join(here, 'fixtures', 'sample_brief.md'), 'utf8');
}

// ---------------------------------------------------------------------------
// extractSignals — unit tests
// ---------------------------------------------------------------------------

describe('extractSignals', () => {
  it('returns no signals for empty content', () => {
    expect(extractSignals('FR-1', '')).toEqual([]);
  });

  it('extracts **Parent Brief:** -> parent_of (child -> parent)', () => {
    const signals = extractSignals('FR-999', '**Parent Brief:** FR-100');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      fromId: 'FR-999',
      toId: 'FR-100',
      toType: 'brief',
      edgeType: 'parent_of',
      confidence: 1.0,
    });
  });

  it('extracts **Hard:** FR-001 -> depends_on', () => {
    const signals = extractSignals('FR-2', '**Hard:** FR-001');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      fromId: 'FR-2',
      toId: 'FR-001',
      edgeType: 'depends_on',
    });
  });

  it('extracts **Soft:** -> related_to', () => {
    const signals = extractSignals('FR-2', '**Soft:** TD-050');
    expect(signals).toHaveLength(1);
    expect(signals[0].edgeType).toBe('related_to');
    expect(signals[0].toId).toBe('TD-050');
  });

  it('extracts **Blocks:** -> blocks (current -> target)', () => {
    const signals = extractSignals('FR-2', '**Blocks:** FR-200');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      fromId: 'FR-2',
      toId: 'FR-200',
      edgeType: 'blocks',
    });
  });

  it('extracts **Blocked by:** -> blocks REVERSED (target -> current)', () => {
    const signals = extractSignals('FR-2', '**Blocked by:** FR-201');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      fromId: 'FR-201',
      toId: 'FR-2',
      edgeType: 'blocks',
    });
  });

  it('extracts **Supersedes:** -> supersedes', () => {
    const signals = extractSignals('FR-2', '**Supersedes:** FR-099');
    expect(signals).toHaveLength(1);
    expect(signals[0].edgeType).toBe('supersedes');
    expect(signals[0].toId).toBe('FR-099');
  });

  it('extracts **Goal:** GL-001 with to_type=goal and conf=1.0', () => {
    const signals = extractSignals('FR-2', '**Goal:** GL-001');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      fromId: 'FR-2',
      toId: 'GL-001',
      toType: 'goal',
      edgeType: 'serves_goal',
      confidence: 1.0,
    });
  });

  it('handles comma-separated **Hard:** FR-001, FR-002', () => {
    const signals = extractSignals('FR-2', '**Hard:** FR-001, FR-002');
    expect(signals).toHaveLength(2);
    const targets = signals.map((s) => s.toId).sort();
    expect(targets).toEqual(['FR-001', 'FR-002']);
    for (const s of signals) expect(s.edgeType).toBe('depends_on');
  });

  it('handles space-only-separated id list (no comma)', () => {
    // Some authors write `**Hard:** FR-001 FR-002` without commas.
    const signals = extractSignals('FR-2', '**Hard:** FR-001 FR-002');
    expect(signals).toHaveLength(2);
    expect(signals.map((s) => s.toId).sort()).toEqual(['FR-001', 'FR-002']);
  });

  it('handles multi-target **Goal:** with comma list', () => {
    const signals = extractSignals('FR-2', '**Goal:** GL-001, GL-002');
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s.toType === 'goal')).toBe(true);
    expect(signals.map((s) => s.toId).sort()).toEqual(['GL-001', 'GL-002']);
  });

  it('does NOT match prose mentions of "hard" or "blocks"', () => {
    const content = `
      This brief depends on hard tradeoffs, but the word hard here is prose.
      We also reference Blocks in body text — must not match.
    `;
    expect(extractSignals('FR-2', content)).toEqual([]);
  });

  it('does NOT match prose mention of "serves goal GL-XXX"', () => {
    // Goal extractor is label-anchored, so the prose form is rejected.
    const content = 'This serves goal GL-001 in narrative form.';
    expect(extractSignals('FR-2', content)).toEqual([]);
  });

  it('filters self-loops (from_id == to_id)', () => {
    expect(extractSignals('FR-999', '**Hard:** FR-999')).toEqual([]);
    expect(extractSignals('FR-999', '**Parent Brief:** FR-999')).toEqual([]);
    expect(extractSignals('FR-999', '**Blocks:** FR-999')).toEqual([]);
  });

  it('skips GL- ids when they appear under **Hard:** (wrong namespace)', () => {
    // **Hard:** is reserved for brief targets. A GL-NNN here is misformatted.
    const signals = extractSignals('FR-2', '**Hard:** GL-001, FR-100');
    expect(signals).toHaveLength(1);
    expect(signals[0].toId).toBe('FR-100');
    expect(signals[0].toType).toBe('brief');
  });

  it('does not extract from misformatted **Goal:** that starts with a brief id', () => {
    // **Goal:** is reserved for goals. After the TD-057 regex tightening,
    // GOAL_LABEL_RE requires the id list to start with a GL- prefix. A
    // misformatted goal like `**Goal:** FR-100, GL-001` is silently
    // skipped — the regex never matches, so neither id is extracted.
    // This is stricter than the legacy loose grammar (which would have
    // skipped FR-100 but recovered GL-001) and matches the warden
    // directive: misformatted briefs are author errors, not something
    // we partially salvage at the risk of phantom-id injection.
    const signals = extractSignals('FR-2', '**Goal:** FR-100, GL-001');
    expect(signals).toEqual([]);
  });

  it('extracts only GL- ids when **Goal:** is well-formatted', () => {
    // The well-formatted form (GL- first) extracts cleanly. A trailing
    // brief id after a GL id is not in the GL-only grammar, so the
    // capture terminates at the first GL id and the FR is ignored.
    const signals = extractSignals('FR-2', '**Goal:** GL-001, FR-100');
    expect(signals).toHaveLength(1);
    expect(signals[0].toId).toBe('GL-001');
    expect(signals[0].toType).toBe('goal');
  });

  it('deduplicates identical signals from different labels', () => {
    // Hard and Soft both pointing at the same brief is unusual but possible
    // — only one edge should result because they map to different edge types.
    // What we test here is duplicate (label, label) producing one signal.
    const signals = extractSignals('FR-2', '**Hard:** FR-100\n**Hard:** FR-100');
    expect(signals).toHaveLength(1);
  });

  it('produces multiple distinct edges when same target appears under different labels', () => {
    // Hard and Soft to the same target are distinct edge_types -> 2 signals.
    const signals = extractSignals('FR-2', '**Hard:** FR-100\n**Soft:** FR-100');
    expect(signals).toHaveLength(2);
    const types = signals.map((s) => s.edgeType).sort();
    expect(types).toEqual(['depends_on', 'related_to']);
  });

  // -------------------------------------------------------------------------
  // Regression locks for the TD-057 phantom-id capture bug. Before tightening
  // `buildLabelRegex`, the open-ended capture grabbed everything after the
  // label up to a non-id character, then `idList.match(ID_RE)` fished out
  // every brief-id-shaped token from the prose. These four tests pin the
  // regex so trailing parens/prose can never inject phantom edges again.
  // -------------------------------------------------------------------------

  it('does NOT capture phantom ids inside parentheses after **Hard:**', () => {
    // `**Hard:** FR-001 (waiting for FR-200 redesign)`
    // Pre-fix bug: extracted BOTH FR-001 and FR-200.
    // Post-fix: parens terminate the capture, only FR-001 remains.
    const signals = extractSignals('FR-2', '**Hard:** FR-001 (waiting for FR-200 redesign)');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      fromId: 'FR-2',
      toId: 'FR-001',
      edgeType: 'depends_on',
    });
    // Belt-and-suspenders: no FR-200 anywhere in the signal set.
    expect(signals.find((s) => s.toId === 'FR-200')).toBeUndefined();
  });

  it('does NOT capture phantom ids in trailing prose after **Blocks:**', () => {
    // `**Blocks:** FR-200 since FR-300 is also blocked`
    // The word "since" is not part of the id grammar -> capture stops at FR-200.
    const signals = extractSignals('FR-2', '**Blocks:** FR-200 since FR-300 is also blocked');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      fromId: 'FR-2',
      toId: 'FR-200',
      edgeType: 'blocks',
    });
    expect(signals.find((s) => s.toId === 'FR-300')).toBeUndefined();
  });

  it('does NOT capture phantom ids after a comma + prose under **Blocked by:**', () => {
    // `**Blocked by:** FR-201, see FR-099 for context`
    // The comma is a legitimate separator BUT what follows ("see") is not an
    // id, so the capture must terminate after FR-201. This case also confirms
    // that the comma still works for legit multi-target lists (regression
    // double-check — see the next assertion).
    const signals = extractSignals('FR-2', '**Blocked by:** FR-201, see FR-099 for context');
    expect(signals).toHaveLength(1);
    // **Blocked by:** REVERSES direction: target -> self.
    expect(signals[0]).toMatchObject({
      fromId: 'FR-201',
      toId: 'FR-2',
      edgeType: 'blocks',
    });
    expect(signals.find((s) => s.toId === 'FR-099' || s.fromId === 'FR-099')).toBeUndefined();

    // Sanity: legitimate comma-separated still works (regression guard).
    const legit = extractSignals('FR-2', '**Blocked by:** FR-201, FR-202');
    expect(legit).toHaveLength(2);
    expect(legit.map((s) => s.fromId).sort()).toEqual(['FR-201', 'FR-202']);
  });

  it('does NOT capture phantom GL ids in trailing prose under **Goal:**', () => {
    // `**Goal:** GL-001 — relates to milestone GL-002`
    // The em dash + words are not id grammar; only GL-001 is captured.
    const signals = extractSignals('FR-2', '**Goal:** GL-001 — relates to milestone GL-002');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      fromId: 'FR-2',
      toId: 'GL-001',
      toType: 'goal',
      edgeType: 'serves_goal',
    });
    expect(signals.find((s) => s.toId === 'GL-002')).toBeUndefined();
  });

  it('extracts every label from the bundled fixture', () => {
    // End-to-end fixture sanity check: 5 brief targets + 1 goal + 1 reverse
    // Blocked by edge + 2 multi-target Hard = 7 brief edges + 1 goal = 8.
    const signals = extractSignals('FR-999', loadSampleBrief());

    // Verify each expected edge appears at least once.
    const findEdge = (toId: string, edgeType: string): EdgeSignal | undefined =>
      signals.find((s) => s.toId === toId && s.edgeType === edgeType);

    expect(findEdge('FR-100', 'parent_of')).toBeTruthy();          // **Parent Brief:**
    expect(findEdge('FR-101', 'depends_on')).toBeTruthy();         // **Hard:** #1
    expect(findEdge('FR-102', 'depends_on')).toBeTruthy();         // **Hard:** #2
    expect(findEdge('TD-050', 'related_to')).toBeTruthy();         // **Soft:**
    expect(findEdge('FR-200', 'blocks')).toBeTruthy();             // **Blocks:**
    expect(findEdge('FR-099', 'supersedes')).toBeTruthy();         // **Supersedes:**
    expect(findEdge('GL-001', 'serves_goal')).toBeTruthy();        // **Goal:**

    // Reverse case: **Blocked by:** FR-201 means FR-201 -> FR-999.
    const reverse = signals.find(
      (s) => s.fromId === 'FR-201' && s.toId === 'FR-999' && s.edgeType === 'blocks',
    );
    expect(reverse).toBeTruthy();

    // Self-loop on FR-999 must NOT be present.
    expect(signals.find((s) => s.fromId === 'FR-999' && s.toId === 'FR-999')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseCliArgs — unit tests
// ---------------------------------------------------------------------------

describe('parseCliArgs', () => {
  it('defaults: no flags', () => {
    const args = parseCliArgs(['node', 'script.ts']);
    expect(args.dryRun).toBe(false);
    expect(args.verbose).toBe(false);
    expect(args.projectFilter).toBeUndefined();
    expect(args.dbPathOverride).toBeUndefined();
  });

  it('--dry-run sets dryRun=true', () => {
    expect(parseCliArgs(['node', 'script.ts', '--dry-run']).dryRun).toBe(true);
  });

  it('--project <slug> sets projectFilter', () => {
    const args = parseCliArgs(['node', 'script.ts', '--project', 'igris-ai']);
    expect(args.projectFilter).toBe('igris-ai');
  });

  it('--verbose sets verbose=true', () => {
    expect(parseCliArgs(['node', 'script.ts', '--verbose']).verbose).toBe(true);
  });

  it('--db <path> sets dbPathOverride', () => {
    const args = parseCliArgs(['node', 'script.ts', '--db', '/tmp/test.db']);
    expect(args.dbPathOverride).toBe('/tmp/test.db');
  });

  it('throws when --project is missing its value', () => {
    expect(() => parseCliArgs(['node', 'script.ts', '--project'])).toThrow(/--project requires/);
  });

  it('throws when --project value is another flag', () => {
    expect(() => parseCliArgs(['node', 'script.ts', '--project', '--dry-run'])).toThrow(
      /--project requires/,
    );
  });

  it('throws when --db is missing its value', () => {
    expect(() => parseCliArgs(['node', 'script.ts', '--db'])).toThrow(/--db requires/);
  });

  it('combines flags', () => {
    const args = parseCliArgs([
      'node',
      'script.ts',
      '--dry-run',
      '--project',
      'igris-ai',
      '--verbose',
    ]);
    expect(args.dryRun).toBe(true);
    expect(args.verbose).toBe(true);
    expect(args.projectFilter).toBe('igris-ai');
  });
});

// ---------------------------------------------------------------------------
// runBackfill — integration tests
// ---------------------------------------------------------------------------

describe('runBackfill', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    // Wire handleEdgeCreate's getDb() to our test DB.
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('inserts edges on first run, zero new on second run (idempotent)', () => {
    seedBriefFile(db, 'p1', 'FR-999', loadSampleBrief());
    // Seed brief_status for every target so warnings don't fire.
    for (const id of ['FR-100', 'FR-101', 'FR-102', 'TD-050', 'FR-200', 'FR-201', 'FR-099']) {
      seedBriefStatus(db, 'p1', id);
    }

    const r1 = runBackfill(db, false, undefined, () => {});
    expect(r1.scanned).toBe(1);
    expect(r1.signalsFound).toBeGreaterThan(0);
    expect(r1.inserted).toBe(r1.signalsFound);
    expect(r1.alreadyPresent).toBe(0);

    const r2 = runBackfill(db, false, undefined, () => {});
    expect(r2.scanned).toBe(1);
    expect(r2.inserted).toBe(0);
    expect(r2.alreadyPresent).toBe(r1.inserted);
  });

  it('--dry-run does not write to entity_edges', () => {
    seedBriefFile(db, 'p1', 'FR-1', '**Hard:** FR-100');
    seedBriefStatus(db, 'p1', 'FR-100');

    const before = (db.prepare('SELECT COUNT(*) AS n FROM entity_edges').get() as { n: number }).n;
    const result = runBackfill(db, true, undefined, () => {});
    const after = (db.prepare('SELECT COUNT(*) AS n FROM entity_edges').get() as { n: number }).n;

    expect(result.signalsFound).toBe(1);
    expect(result.inserted).toBe(0);
    expect(after).toBe(before);
    expect(after).toBe(0);
  });

  it('--project filter scopes the scan', () => {
    seedBriefFile(db, 'p1', 'FR-1', '**Hard:** FR-100');
    seedBriefFile(db, 'p2', 'FR-2', '**Hard:** FR-200');
    seedBriefStatus(db, 'p1', 'FR-100');
    seedBriefStatus(db, 'p2', 'FR-200');

    const result = runBackfill(db, false, 'p1', () => {});
    expect(result.scanned).toBe(1);
    expect(result.inserted).toBe(1);

    const rows = db
      .prepare('SELECT from_id, to_id FROM entity_edges')
      .all() as Array<{ from_id: string; to_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].from_id).toBe('FR-1');
    expect(rows[0].to_id).toBe('FR-100');
  });

  it('emits a warning (not error) when target brief id is unknown', () => {
    // FR-99999 is a syntactically valid brief id (matches the canonical
    // [A-Z]{2,3}-\d+ pattern) but is intentionally absent from
    // brief_status so the lookup fails.
    seedBriefFile(db, 'p1', 'FR-1', '**Hard:** FR-99999');
    // Note: NOT seeding brief_status for FR-99999.

    const result = runBackfill(db, false, undefined, () => {});

    // Edge is still inserted (no FK to brief_status), but a warning fires.
    expect(result.inserted).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].briefId).toBe('FR-1');
    expect(result.warnings[0].message).toContain('FR-99999');
    expect(result.warnings[0].message).toContain('not found in brief_status');
  });

  it('does NOT warn for goal targets even when they are unknown', () => {
    // Goals don't live in brief_status, so absence is expected and not a warning.
    seedBriefFile(db, 'p1', 'FR-1', '**Goal:** GL-999');

    const result = runBackfill(db, false, undefined, () => {});
    expect(result.inserted).toBe(1);
    expect(result.warnings).toHaveLength(0);
  });

  it('routes GL-NNN to to_type=goal, others to to_type=brief', () => {
    seedBriefFile(db, 'p1', 'FR-1', '**Hard:** FR-100\n**Goal:** GL-001');
    seedBriefStatus(db, 'p1', 'FR-100');

    runBackfill(db, false, undefined, () => {});

    const rows = db
      .prepare('SELECT from_id, to_type, to_id, edge_type FROM entity_edges ORDER BY edge_type')
      .all() as Array<{ from_id: string; to_type: string; to_id: string; edge_type: string }>;

    expect(rows).toHaveLength(2);
    const dependsOn = rows.find((r) => r.edge_type === 'depends_on');
    const servesGoal = rows.find((r) => r.edge_type === 'serves_goal');
    expect(dependsOn?.to_type).toBe('brief');
    expect(dependsOn?.to_id).toBe('FR-100');
    expect(servesGoal?.to_type).toBe('goal');
    expect(servesGoal?.to_id).toBe('GL-001');
  });

  it('persists provenance=backfill on every inserted edge', () => {
    seedBriefFile(db, 'p1', 'FR-1', '**Hard:** FR-100');
    seedBriefStatus(db, 'p1', 'FR-100');

    runBackfill(db, false, undefined, () => {});

    const rows = db
      .prepare('SELECT provenance, metadata FROM entity_edges')
      .all() as Array<{ provenance: string; metadata: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].provenance).toBe('backfill');
    const meta = JSON.parse(rows[0].metadata) as Record<string, unknown>;
    expect(meta.source).toBe('backfill');
    expect(meta.label).toBe('**Hard:**');
  });

  it('handles empty brief_files gracefully', () => {
    const result = runBackfill(db, false, undefined, () => {});
    expect(result.scanned).toBe(0);
    expect(result.signalsFound).toBe(0);
    expect(result.inserted).toBe(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('continues scanning when one brief has no signals', () => {
    seedBriefFile(db, 'p1', 'FR-1', 'just some prose, nothing to extract');
    seedBriefFile(db, 'p1', 'FR-2', '**Hard:** FR-100');
    seedBriefStatus(db, 'p1', 'FR-100');

    const result = runBackfill(db, false, undefined, () => {});
    expect(result.scanned).toBe(2);
    expect(result.signalsFound).toBe(1);
    expect(result.inserted).toBe(1);
  });

  it('verbose log callback receives per-edge messages', () => {
    seedBriefFile(db, 'p1', 'FR-1', '**Hard:** FR-100');
    seedBriefStatus(db, 'p1', 'FR-100');
    const messages: string[] = [];

    runBackfill(db, false, undefined, (msg) => messages.push(msg));

    // At least one OK line for the inserted edge.
    expect(messages.some((m) => m.includes('FR-1') && m.includes('FR-100'))).toBe(true);
  });

  it('dry-run logs intended edges without DB mutation', () => {
    seedBriefFile(db, 'p1', 'FR-1', '**Hard:** FR-100\n**Goal:** GL-001');
    seedBriefStatus(db, 'p1', 'FR-100');
    const messages: string[] = [];

    runBackfill(db, true, undefined, (msg) => messages.push(msg));

    // Two [DRY] lines, one per signal.
    const dryLines = messages.filter((m) => m.includes('[DRY]'));
    expect(dryLines).toHaveLength(2);
    const after = (db.prepare('SELECT COUNT(*) AS n FROM entity_edges').get() as { n: number }).n;
    expect(after).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// writeSignal — focused write-path tests
// ---------------------------------------------------------------------------

describe('writeSignal', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('returns created=true on first write', () => {
    const result = writeSignal({
      fromId: 'FR-1',
      toId: 'FR-2',
      toType: 'brief',
      edgeType: 'depends_on',
      confidence: 1.0,
      label: '**Hard:**',
    });
    expect(result.created).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('returns created=false on duplicate write (idempotent)', () => {
    const sig: EdgeSignal = {
      fromId: 'FR-1',
      toId: 'FR-2',
      toType: 'brief',
      edgeType: 'depends_on',
      confidence: 1.0,
      label: '**Hard:**',
    };
    writeSignal(sig);
    const second = writeSignal(sig);
    expect(second.created).toBe(false);
    expect(second.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// IGRIS_DB_PATH override — proves --db flag actually sandboxes writes
//
// Critical regression lock for the warden review on TD-057. Before the fix,
// the CLI's `--db /tmp/sandbox.db` was a silent no-op: the script set
// `process.env.IGRIS_DB_PATH` but `getDb()` opened the hardcoded
// `~/.igris/memory/knowledge.db`. Operators thought they were sandboxed
// while writes hit production. This test ensures the env var is now read.
//
// We bypass the file-level vi.mock('../../src/db.js') by calling
// vi.importActual to get the real `getDb`. The real `getDb` is a singleton
// per process, and prior tests in this file may already have invoked it
// (they didn't, but defensively we treat it as "may have"). We test by
// asserting that opening getDb() with IGRIS_DB_PATH set creates the file
// at the override path — if the env var is ignored, the override file
// never gets created.
// ---------------------------------------------------------------------------

describe('IGRIS_DB_PATH env override (real getDb)', () => {
  let tmpDbPath: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    // Randomized filename to avoid CI parallel-mode collisions per
    // vitest.config.ts. The dir from os.tmpdir() is platform-correct
    // (e.g. /var/folders/... on macOS, /tmp on Linux).
    const slug = randomBytes(8).toString('hex');
    tmpDbPath = path.join(os.tmpdir(), `td057-override-${slug}.db`);
    prevEnv = process.env.IGRIS_DB_PATH;
  });

  afterEach(() => {
    // Restore the env to whatever it was before (often undefined).
    if (prevEnv === undefined) delete process.env.IGRIS_DB_PATH;
    else process.env.IGRIS_DB_PATH = prevEnv;

    // Remove the temp DB file plus the WAL/SHM siblings that
    // better-sqlite3 leaves behind when journal_mode=WAL is set.
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(tmpDbPath + suffix);
      } catch {
        // ignore — best-effort cleanup
      }
    }
  });

  it('getDb() honors IGRIS_DB_PATH and opens at the override location', async () => {
    // Pull the REAL db module, bypassing the file-level mock. The cast is
    // necessary because vi.importActual is typed as `unknown`.
    const real = (await vi.importActual('../../src/db.js')) as {
      getDb: () => Database.Database;
      closeDb: () => void;
    };

    // Singleton hazard: if any earlier test already invoked the real getDb
    // (none currently do, but be defensive), the connection is cached and
    // setting env now would not reopen. closeDb resets that cache.
    real.closeDb();

    process.env.IGRIS_DB_PATH = tmpDbPath;

    // Pre-condition: file does not exist.
    expect(fs.existsSync(tmpDbPath)).toBe(false);

    // Act: open the singleton; the override path must be honored.
    const db = real.getDb();
    try {
      // Prove writes land in the override DB by creating a marker table.
      db.exec('CREATE TABLE td057_marker (id INTEGER PRIMARY KEY)');
      db.prepare('INSERT INTO td057_marker (id) VALUES (1)').run();

      // Assert: file exists at the override path.
      expect(fs.existsSync(tmpDbPath)).toBe(true);

      // Cross-check: open a *separate* connection to that same path and
      // confirm the marker row is there. Anything else means we wrote to
      // the wrong file.
      const verifier = new Database(tmpDbPath, { readonly: true });
      try {
        const row = verifier.prepare('SELECT id FROM td057_marker WHERE id = 1').get();
        expect(row).toEqual({ id: 1 });
      } finally {
        verifier.close();
      }
    } finally {
      // Reset the singleton so subsequent tests in other files don't
      // inherit our override. closeDb only clears the cached _db; the
      // env-var restore in afterEach handles the rest.
      real.closeDb();
    }
  });
});
