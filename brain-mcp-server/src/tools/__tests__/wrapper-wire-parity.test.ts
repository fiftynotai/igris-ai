/**
 * FR-240 Phase 1 — MCP wrapper WIRE-OUTPUT parity golden.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * FR-240 extracts the SQL out of six MCP handlers into pure `db`-param readers
 * (`briefs-read.ts`, `memory-read.ts`, `goals/read.ts`) and turns the handlers
 * into thin wrappers. SKILLS PARSE the text these handlers emit, so a whitespace
 * change, a reordered JSON key or a dropped field is a silent skill breakage.
 *
 * The consumer set, established by grep at FR-240 rather than taken on trust:
 *   igris_brief_get            -> hunt (SKILL.md + workflow-template.md), archive, team
 *   igris_brief_list           -> register, audit, team
 *   igris_memory_get           -> harvest, promote, search
 *   igris_memory_hybrid_search -> search
 *   igris_goal_list            -> scan
 *   igris_goal_get             -> no skill caller found
 * The FR-240 plan named this set as "/hunt, /awaken and /distill"; two of those
 * three are wrong (`/awaken` calls none of the six, and `/distill` is the
 * retired name of `/harvest`), and seven real consumers were missing. Re-derive
 * with `grep -rl <tool> ~/.igris/core/skills/` rather than trusting this block.
 *
 * The FR-240 plan §4 names this drift as the brief's #1 risk and prescribes
 * exactly this mitigation: golden strings captured BEFORE the refactor and
 * re-asserted after.
 *
 * The snapshots below were filled by `vitest run -u` against the code as it
 * stood BEFORE the extraction (git HEAD at capture time). They are therefore a
 * record of the pre-refactor wire format, not a description of the post-refactor
 * one. Re-recording them (`-u`) as a way to make this file pass is the one thing
 * that would defeat its purpose.
 *
 * WHAT THIS GATE PROVES
 * ---------------------
 * That the six wrappers emit byte-identical text for these fixtures across the
 * extraction.
 *
 * WHAT IT DOES NOT PROVE
 * ----------------------
 *  - That the readers themselves are correct on inputs these fixtures do not
 *    cover (filters, pagination edges, the new `listLearnings` query).
 *    **Siblings:** `briefs-read.test.ts`, `memory-read.test.ts`,
 *    `goals/__tests__/read.test.ts`.
 *  - That the readers are pure (no `db.js`, no writes).
 *    **Sibling:** `pure-read-purity.test.ts`.
 *  - That `handleMemoryGet`'s `access_count` UPDATE still runs — a golden of the
 *    RENDERED text would pass even if the write were dropped, because the text
 *    prints `access_count + 1` arithmetically. That is asserted separately below
 *    by re-reading the row (§ "the wrapper-side write survives").
 *
 * @module tools/__tests__/wrapper-wire-parity.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Module mocks — must precede the imports that consume them.
// ---------------------------------------------------------------------------

const { fakeEmbedding } = vi.hoisted(() => {
  function fakeEmbedding(text: string): Float32Array {
    const arr = new Float32Array(384);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    for (let i = 0; i < 384; i++) {
      hash = ((hash << 5) - hash + i) | 0;
      arr[i] = (hash & 0xffff) / 0xffff;
    }
    let norm = 0;
    for (let i = 0; i < 384; i++) norm += arr[i] * arr[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < 384; i++) arr[i] /= norm;
    return arr;
  }
  return { fakeEmbedding };
});

vi.mock('../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

vi.mock('../../utils/embeddings.js', () => ({
  generateEmbedding: vi.fn(async (text: string) => fakeEmbedding(text)),
  embeddingToBuffer: vi.fn((embedding: Float32Array) =>
    Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
  ),
  bufferToEmbedding: vi.fn(),
  isEmbeddingAvailable: vi.fn(() => true),
  processInBatches: vi.fn(),
  EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
  EMBEDDING_DIMENSIONS: 384,
}));

/**
 * Vector availability is a per-test switch so the SAME fixtures exercise the
 * hybrid arm and the BM25-only arm. Both wire formats are goldens: the
 * degradation string ("BM25 only") is as much a parsed contract as the hybrid
 * one.
 */
const vecState = { available: false, store: [] as number[] };

vi.mock('../../utils/vector-search.js', () => ({
  isVectorSearchAvailable: vi.fn(() => vecState.available),
  insertEmbedding: vi.fn(),
  deleteEmbedding: vi.fn(),
  vectorSearch: vi.fn((_db: unknown, _q: Float32Array, limit: number) =>
    vecState.store.slice(0, limit).map((rowid, i) => ({ rowid, distance: (i + 1) * 0.1 })),
  ),
  insertEmbeddingInto: vi.fn(),
  deleteEmbeddingFrom: vi.fn(),
  vectorSearchFrom: vi.fn((_db: unknown, _table: string, _q: Float32Array, limit: number) =>
    vecState.store.slice(0, limit).map((rowid, i) => ({ rowid, distance: (i + 1) * 0.1 })),
  ),
}));

// Goals live under engine/components/goals and mock the same db module by a
// different relative specifier; vitest keys mocks by resolved path, so the one
// factory above covers both.
vi.mock('../../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { getDb } from '../../db.js';
import { handleBriefList, handleBriefGet, handleBriefSimilar } from '../briefs.js';
import { handleMemoryGet, handleMemoryHybridSearch } from '../memory.js';
import {
  handleGoalList,
  handleGoalGet,
} from '../../engine/components/goals/handlers.js';
import { goalMigrations } from '../../engine/components/goals/schema.js';
import { edgeMigrations } from '../../engine/components/edges/schema.js';

const mockedGetDb = vi.mocked(getDb);

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * One DB carrying every table the six handlers touch, seeded with FIXED
 * timestamps. Nothing here may derive from the clock — a golden over a
 * `datetime('now')` column is a golden that fails tomorrow.
 */
function makeFixtureDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');

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
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT DEFAULT '',
      tech_stack TEXT DEFAULT '',
      scope TEXT DEFAULT 'local',
      source_brief TEXT DEFAULT '',
      confidence REAL DEFAULT 0.8,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      access_count INTEGER DEFAULT 0,
      last_accessed_at TEXT,
      provenance TEXT NOT NULL DEFAULT 'observed',
      review_status TEXT NOT NULL DEFAULT 'approved',
      source_extractor TEXT NOT NULL DEFAULT 'manual',
      promoted_to_doc TEXT
    );
    CREATE VIRTUAL TABLE learnings_fts USING fts5(
      title, content, tags, tech_stack,
      content=learnings, content_rowid=id
    );
    CREATE TRIGGER learnings_ai AFTER INSERT ON learnings BEGIN
      INSERT INTO learnings_fts(rowid, title, content, tags, tech_stack)
      VALUES (new.id, new.title, new.content, new.tags, new.tech_stack);
    END;
  `);
  for (const m of goalMigrations) db.exec(m.sql);
  for (const m of edgeMigrations) db.exec(m.sql);

  // --- briefs ------------------------------------------------------------
  const insBrief = db.prepare(
    `INSERT INTO brief_status
       (project, brief_id, brief_type, title, status, priority, effort, phase, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insBrief.run('igris-ai', 'FR-240', 'feature', 'Dashboard layer views', 'In Progress', 'P1-High', 'XL', 'BUILDING', '2026-07-30 09:00:00');
  insBrief.run('igris-ai', 'TD-312', 'tech-debt', 'CI does not run brain vitest', 'Pending', 'P2-Medium', 'S', null, '2026-07-29 08:00:00');
  insBrief.run('other-proj', 'BR-001', 'bug', 'Duplicate id across projects', 'Pending', 'P3-Low', 'M', null, '2026-07-28 07:00:00');

  db.prepare(
    `INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('bf-1', 'igris-ai', 'FR-240', 'FR-240.md', '# FR-240\n\nMount four read-only views.', 'deadbeef', '2026-07-30 08:30:00');

  // --- learnings ---------------------------------------------------------
  const insLearning = db.prepare(
    `INSERT INTO learnings
       (project, category, title, content, tags, tech_stack, scope, source_brief,
        confidence, created_at, updated_at, access_count, provenance, review_status,
        source_extractor, promoted_to_doc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insLearning.run('igris-ai', 'pattern', 'Pure db-param readers', 'Extract a pure db-param reader; the MCP handler becomes its wrapper.', 'brain,pattern', 'typescript', 'global', 'FR-237', 0.9, '2026-07-01 10:00:00', '2026-07-01 10:00:00', 3, 'observed', 'approved', 'manual', null);
  insLearning.run('igris-ai', 'mistake', 'Stillness is not liveness', 'A negative control must exercise the same wake-up path as the thing under test.', 'testing', 'typescript', 'local', 'FR-239', 0.85, '2026-07-02 10:00:00', '2026-07-02 10:00:00', 0, 'observed', 'approved', 'manual', null);
  insLearning.run('other-proj', 'decision', 'Promoted example', 'This standard has moved into a context doc.', 'docs', '', 'local', '', 0.7, '2026-07-03 10:00:00', '2026-07-03 10:00:00', 1, 'inferred', 'approved', 'manual', 'coding_guidelines.md#12');
  insLearning.run('igris-ai', 'discovery', 'Pending candidate reader', 'A pending_review row must never reach the conscious channel.', 'perception', '', 'local', '', 0.5, '2026-07-04 10:00:00', '2026-07-04 10:00:00', 0, 'inferred', 'pending_review', 'llm', null);

  // --- goals -------------------------------------------------------------
  const insGoal = db.prepare(
    `INSERT INTO goals
       (goal_id, project_slug, title, description, outcome, deadline, status,
        priority, created_at, updated_at, achieved_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insGoal.run('GL-001', 'igris-ai', 'Ship the lens', 'Four read-only views', 'Operator can browse the brain', '2026-08-31', 'active', 'P1-High', '2026-06-01 10:00:00', '2026-06-02 10:00:00', null, '{}');
  insGoal.run('GL-002', 'igris-ai', 'No deadline goal', null, 'Sorts last', null, 'active', 'P2-Medium', '2026-06-03 10:00:00', '2026-06-03 10:00:00', null, '{}');
  insGoal.run('GL-003', 'other-proj', 'Achieved goal', null, 'Done already', '2026-07-01', 'achieved', 'P3-Low', '2026-05-01 10:00:00', '2026-05-02 10:00:00', '2026-07-01 12:00:00', '{}');

  db.prepare(
    `INSERT INTO entity_edges
       (from_type, from_id, to_type, to_id, edge_type, confidence, provenance, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('brief', 'FR-240', 'goal', 'GL-001', 'serves_goal', 1.0, 'observed', '{}');
  db.prepare(
    `INSERT INTO entity_edges
       (from_type, from_id, to_type, to_id, edge_type, confidence, provenance, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('learning', '1', 'goal', 'GL-001', 'serves_goal', 1.0, 'observed', '{}');

  return db;
}

let db: Database.Database;

beforeEach(() => {
  db = makeFixtureDb();
  mockedGetDb.mockReturnValue(db);
  vecState.available = false;
  vecState.store = [];
});

afterEach(() => {
  db.close();
  vi.clearAllMocks();
});

function text(result: { content: { text: string }[] }): string {
  return result.content[0].text;
}

// ---------------------------------------------------------------------------
// Goldens
// ---------------------------------------------------------------------------

describe('WIRE GOLDEN — handleBriefList', () => {
  it('unfiltered, default pagination', () => {
    expect(text(handleBriefList({}))).toMatchSnapshot();
  });

  it('project + status filters, include_content', () => {
    expect(
      text(handleBriefList({ project: 'igris-ai', status: 'In Progress', include_content: true })),
    ).toMatchSnapshot();
  });

  it('limit 0 returns all with limit echoed as 0', () => {
    expect(text(handleBriefList({ limit: 0 }))).toMatchSnapshot();
  });

  it('offset paginates', () => {
    expect(text(handleBriefList({ limit: 1, offset: 1 }))).toMatchSnapshot();
  });
});

describe('WIRE GOLDEN — handleBriefGet', () => {
  it('JOIN path (brief_files row exists)', () => {
    expect(text(handleBriefGet({ project: 'igris-ai', brief_id: 'FR-240' }))).toMatchSnapshot();
  });

  it('metadata-only fallback (no brief_files row)', () => {
    expect(text(handleBriefGet({ project: 'igris-ai', brief_id: 'TD-312' }))).toMatchSnapshot();
  });

  it('not found', () => {
    expect(text(handleBriefGet({ project: 'igris-ai', brief_id: 'NOPE-1' }))).toMatchSnapshot();
  });

  it('missing args', () => {
    expect(text(handleBriefGet({ project: '', brief_id: '' }))).toMatchSnapshot();
  });
});

/**
 * FR-246 — `igris_brief_similar`'s prose across the wrapper extraction.
 *
 * **These are LITERAL expectations, not `toMatchSnapshot()`, and that is the
 * point.** Every other golden in this file was recorded with `-u` against the
 * code as it stood BEFORE its refactor. `handleBriefSimilar` is being extracted
 * NOW, so a snapshot taken now would record the POST-extraction output and
 * assert only that the new code equals itself — the vacuous form of this whole
 * file. The strings below were instead transcribed from
 * `git show HEAD:…/briefs.ts` before the edit, so the assertion is genuinely
 * "the new wrapper reproduces the old bytes".
 *
 * `/register` parses this output to decide whether a brief is a duplicate, so
 * every one of these sentences is a contract.
 */
describe('WIRE GOLDEN — handleBriefSimilar (FR-246 extraction, literal not snapshot)', () => {
  it('sqlite-vec unavailable', async () => {
    vecState.available = false;
    expect(text(await handleBriefSimilar({ query: 'dashboard' }))).toBe(
      'Brief similarity search unavailable: sqlite-vec extension is not loaded.',
    );
  });

  it('no vector hits', async () => {
    vecState.available = true;
    vecState.store = [];
    expect(text(await handleBriefSimilar({ query: 'dashboard' }))).toBe(
      'No similar briefs found.',
    );
  });

  it('below threshold', async () => {
    vecState.available = true;
    vecState.store = [1];
    expect(text(await handleBriefSimilar({ query: 'dashboard', threshold: 0.999 }))).toBe(
      'No briefs found above similarity threshold (0.999).',
    );
  });

  it('project filter drops every candidate — the project-scoped empty sentence', async () => {
    vecState.available = true;
    vecState.store = [1];
    expect(
      text(await handleBriefSimilar({ query: 'dashboard', project: 'nope', threshold: 0.5 })),
    ).toBe('No similar briefs found in project "nope" above threshold (0.5).');
  });

  it('hits — the full block, field order and separators included', async () => {
    vecState.available = true;
    vecState.store = [1, 2];
    expect(text(await handleBriefSimilar({ query: 'dashboard', threshold: 0.5 }))).toBe(
      [
        'Found 2 similar brief(s) (threshold >= 0.5):',
        '',
        '--- Similarity: 0.9950 ---',
        'Brief: FR-240',
        'Project: igris-ai',
        'Title: Dashboard layer views',
        'Status: In Progress',
        'Priority: P1-High',
        'Type: feature',
        '',
        '--- Similarity: 0.9800 ---',
        'Brief: TD-312',
        'Project: igris-ai',
        'Title: CI does not run brain vitest',
        'Status: Pending',
        'Priority: P2-Medium',
        'Type: tech-debt',
      ].join('\n'),
    );
  });

  it('limit caps the rendered block', async () => {
    vecState.available = true;
    vecState.store = [1, 2, 3];
    const out = text(await handleBriefSimilar({ query: 'dashboard', threshold: 0.5, limit: 1 }));
    expect(out.startsWith('Found 1 similar brief(s) (threshold >= 0.5):')).toBe(true);
    expect(out).not.toContain('TD-312');
  });
});

describe('WIRE GOLDEN — handleMemoryGet', () => {
  it('found row renders the key: value block', () => {
    expect(text(handleMemoryGet({ id: 1 }))).toMatchSnapshot();
  });

  it('missing row', () => {
    expect(text(handleMemoryGet({ id: 999 }))).toMatchSnapshot();
  });
});

describe('WIRE GOLDEN — handleMemoryHybridSearch', () => {
  it('BM25-only arm (sqlite-vec unavailable)', async () => {
    expect(text(await handleMemoryHybridSearch({ query: 'reader' }))).toMatchSnapshot();
  });

  it('hybrid arm (vector results present)', async () => {
    vecState.available = true;
    vecState.store = [2, 1];
    expect(text(await handleMemoryHybridSearch({ query: 'reader' }))).toMatchSnapshot();
  });

  it('promoted row renders the pointer, not the content', async () => {
    expect(text(await handleMemoryHybridSearch({ query: 'standard' }))).toMatchSnapshot();
  });

  it('no matches', async () => {
    expect(text(await handleMemoryHybridSearch({ query: 'zzzznotpresent' }))).toMatchSnapshot();
  });

  it('validation error', async () => {
    expect(text(await handleMemoryHybridSearch({ query: '' }))).toMatchSnapshot();
  });

  it('pending_review rows never surface (FR-109 gate)', async () => {
    // Self-negative-control (FR-239 learning 1094). Without this, "the handler
    // returned nothing" is indistinguishable from "the query matched nothing",
    // and the gate would pass with the `review_status='approved'` clause
    // deleted AND with the fixture row absent. Prove the row IS reachable by
    // FTS first, then prove the gate is what removes it.
    const unGated = db
      .prepare(
        `SELECT l.id FROM learnings_fts fts JOIN learnings l ON l.id = fts.rowid
         WHERE learnings_fts MATCH 'conscious channel'`,
      )
      .all() as { id: number }[];
    expect(unGated.map((r) => r.id)).toEqual([4]);

    const out = text(await handleMemoryHybridSearch({ query: 'conscious channel' }));
    expect(out).not.toContain('Pending candidate reader');
    expect(out).toMatchSnapshot();
  });
});

describe('WIRE GOLDEN — handleGoalList', () => {
  it('unfiltered — deadline ASC nulls last', () => {
    expect(text(handleGoalList({}))).toMatchSnapshot();
  });

  it('project + status filters', () => {
    expect(text(handleGoalList({ project: 'igris-ai', status: 'active' }))).toMatchSnapshot();
  });

  it('invalid status is refused by the wrapper', () => {
    expect(text(handleGoalList({ status: 'bogus' }))).toMatchSnapshot();
  });

  it('upcoming_days narrows to deadlined active goals', () => {
    // Anchored on a wide window so the fixture deadline is always inside it —
    // otherwise this golden expires.
    expect(text(handleGoalList({ upcoming_days: 100000 }))).toMatchSnapshot();
  });
});

describe('WIRE GOLDEN — handleGoalGet', () => {
  it('goal with serving briefs and learnings', () => {
    expect(text(handleGoalGet({ goal_id: 'GL-001' }))).toMatchSnapshot();
  });

  it('goal with no edges', () => {
    expect(text(handleGoalGet({ goal_id: 'GL-002' }))).toMatchSnapshot();
  });

  it('not found', () => {
    expect(text(handleGoalGet({ goal_id: 'GL-999' }))).toMatchSnapshot();
  });

  it('missing goal_id', () => {
    expect(text(handleGoalGet({}))).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// The side effect the golden CANNOT see
// ---------------------------------------------------------------------------

describe('the wrapper-side write survives the extraction (G2 / TD-092)', () => {
  it('handleMemoryGet still bumps access_count and stamps last_accessed_at', () => {
    const before = db.prepare('SELECT access_count, last_accessed_at FROM learnings WHERE id = 1')
      .get() as { access_count: number; last_accessed_at: string | null };
    expect(before.access_count).toBe(3);
    expect(before.last_accessed_at).toBeNull();

    handleMemoryGet({ id: 1 });

    const after = db.prepare('SELECT access_count, last_accessed_at FROM learnings WHERE id = 1')
      .get() as { access_count: number; last_accessed_at: string | null };
    // Assert-then-diff (FR-239 learning 1093): the golden above prints
    // `access_count + 1` in JS, so it would still read "4" with the UPDATE
    // deleted. Only the re-read distinguishes the two.
    expect(after.access_count).toBe(4);
    expect(after.last_accessed_at).not.toBeNull();
  });

  it('hybrid search does NOT bump access_count (it never did)', async () => {
    await handleMemoryHybridSearch({ query: 'reader' });
    const row = db.prepare('SELECT access_count FROM learnings WHERE id = 1').get() as {
      access_count: number;
    };
    expect(row.access_count).toBe(3);
  });
});
