/**
 * TD-286 — renormalize-backfill focused invariant tests.
 *
 * These cover ONLY the invariants whose violation would cause silent
 * production damage (a full harness is disproportionate for a one-time
 * migration):
 *   (a) idempotency  — a second `--apply` over already-normalized rows = 0
 *                      rewrites.
 *   (b) lockstep     — after apply, every `learnings.embedding` id has a
 *                      matching `learnings_vec` rowid and vice versa.
 *   (c) reclassify   — a RAW-stored fixture row is detected RAW before apply
 *                      and `norm` (skipped) after.
 *   (d) blast radius — apply touches ONLY embedding / embedding_model /
 *                      learnings_vec; every other column (incl. updated_at) is
 *                      left byte-identical.
 *   (e) #213 guard   — runBackfill hard-fails BEFORE any write when sqlite-vec
 *                      is not available.
 *
 * Embedding is injected via a DETERMINISTIC fake embedder (seam), so the
 * classifier's RAW/norm verdict is stable and the test needs no HF model
 * download. The fake maps identical text → identical unit vector (cosine 1.0)
 * and different text → a near-orthogonal vector, which is exactly the signal
 * the TD-285 `svr > svn` classifier keys on.
 *
 * The DB is seeded from the shipped schema shape + a real sqlite-vec load, and
 * rows are written with the SHIPPED `embeddingToBuffer` / `insertEmbedding`
 * helpers so the fixture geometry matches production exactly.
 *
 * @module scripts/__tests__/td286_renormalize_backfill.test
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import { runBackfill, type Embedder } from '../td286_renormalize_backfill.js';
import { embeddingToBuffer, EMBEDDING_MODEL } from '../../src/utils/embeddings.js';
import { insertEmbedding } from '../../src/utils/vector-search.js';
import { normalizeForDedup } from '../../src/engine/components/perception/dedup.js';

// --- deterministic fake embedder -------------------------------------------
// FNV-1a seed → xorshift32 fill → L2-normalise. Same text ⇒ same unit vector.
function fakeVector(text: string): Float32Array {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let state = h || 1;
  const v = new Float32Array(384);
  let norm = 0;
  for (let i = 0; i < 384; i++) {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    const x = state / 0xffffffff - 0.5;
    v[i] = x;
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 384; i++) v[i] /= norm;
  return v;
}
const fakeEmbed: Embedder = async (text: string) => fakeVector(text);

function normFingerprint(title: string, content: string): string {
  return `${normalizeForDedup(title)} ${normalizeForDedup(content)}`.trim();
}

// --- schema seed (shipped shape, minimal) ----------------------------------
function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT DEFAULT '',
      tech_stack TEXT DEFAULT '',
      scope TEXT DEFAULT 'local',
      review_status TEXT NOT NULL DEFAULT 'approved',
      source_extractor TEXT DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      embedding BLOB,
      embedding_model TEXT DEFAULT ''
    );
    CREATE VIRTUAL TABLE learnings_vec USING vec0(embedding float[384]);
    CREATE TRIGGER learnings_vec_ad AFTER DELETE ON learnings BEGIN
      DELETE FROM learnings_vec WHERE rowid = old.id;
    END;
  `);
}

/** Insert a learning and store its embedding in BOTH stores (lockstep). */
function seedRow(
  db: Database.Database,
  args: {
    title: string;
    content: string;
    review_status: string;
    source_extractor: string;
    embedding: Float32Array;
    embedding_model?: string;
  },
): number {
  const result = db.prepare(
    `INSERT INTO learnings
       (project, category, title, content, review_status, source_extractor, embedding, embedding_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'test-proj',
    'pattern',
    args.title,
    args.content,
    args.review_status,
    args.source_extractor,
    embeddingToBuffer(args.embedding),
    args.embedding_model ?? EMBEDDING_MODEL,
  );
  const id = Number(result.lastInsertRowid);
  insertEmbedding(db, id, args.embedding);
  return id;
}

const requireCjs = createRequire(import.meta.url);
let tmpDir: string;
let dbPath: string;
let db: Database.Database;

function openWithVec(): Database.Database {
  const conn = new Database(dbPath);
  (requireCjs('sqlite-vec') as { load: (d: Database.Database) => void }).load(conn);
  return conn;
}

// A manual/raw row stores embed(`${title} ${content}`); a perception/norm row
// stores embed(normFingerprint). These land in different geometry — exactly
// the split the backfill detects.
const RAW = { title: 'Raw Manual Title', content: 'Some UPPER Body Text' };
const NORM = { title: 'Perception Title', content: 'Already Normalized Body' };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td286-'));
  dbPath = path.join(tmpDir, `test-${randomBytes(4).toString('hex')}.db`);
  db = openWithVec();
  createSchema(db);
  // RAW-stored row (mimics memory.ts:283 raw embed).
  seedRow(db, {
    ...RAW,
    review_status: 'approved',
    source_extractor: 'manual',
    embedding: fakeVector(`${RAW.title} ${RAW.content}`),
  });
  // norm-stored row (mimics perception.ts:265 normalized embed).
  seedRow(db, {
    ...NORM,
    review_status: 'pending_review',
    source_extractor: 'perception',
    embedding: fakeVector(normFingerprint(NORM.title, NORM.content)),
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('td286 renormalize backfill', () => {
  it('(c) detects the RAW row and skips the norm row on a dry-run', async () => {
    const s = await runBackfill(db, { apply: false }, { embed: fakeEmbed });
    expect(s.scanned).toBe(2);
    expect(s.rawDetected).toBe(1);
    expect(s.rawApproved).toBe(1);
    expect(s.rawPending).toBe(0);
    expect(s.skippedNorm).toBe(1);
    expect(s.rewritten).toBe(0); // dry-run writes nothing
    expect(s.failures).toBe(0);
  });

  it('(c) reclassifies the RAW row to norm after --apply', async () => {
    const before = await runBackfill(db, { apply: true }, { embed: fakeEmbed });
    expect(before.rawDetected).toBe(1);
    expect(before.rewritten).toBe(1);

    const after = await runBackfill(db, { apply: false }, { embed: fakeEmbed });
    expect(after.rawDetected).toBe(0);
    expect(after.skippedNorm).toBe(2); // both rows now read as norm-stored
  });

  it('(a) is idempotent — a second --apply rewrites nothing', async () => {
    await runBackfill(db, { apply: true }, { embed: fakeEmbed });
    const second = await runBackfill(db, { apply: true }, { embed: fakeEmbed });
    expect(second.rawDetected).toBe(0);
    expect(second.rewritten).toBe(0);
    expect(second.skippedNorm).toBe(2);
  });

  it('(b) preserves learnings.embedding <-> learnings_vec lockstep after apply', async () => {
    await runBackfill(db, { apply: true }, { embed: fakeEmbed });
    const blobIds = (db.prepare('SELECT id FROM learnings WHERE embedding IS NOT NULL').all() as { id: number }[])
      .map((r) => r.id).sort((a, b) => a - b);
    const vecIds = (db.prepare('SELECT rowid FROM learnings_vec').all() as { rowid: number }[])
      .map((r) => Number(r.rowid)).sort((a, b) => a - b);
    expect(vecIds).toEqual(blobIds);
    expect(blobIds.length).toBe(2);
  });

  it('(d) touches only embedding/embedding_model — every other column is unchanged', async () => {
    const cols = 'id, project, category, title, content, tags, tech_stack, scope, review_status, source_extractor, created_at, updated_at';
    const before = db.prepare(`SELECT ${cols} FROM learnings ORDER BY id`).all();
    const embBefore = (db.prepare('SELECT id, embedding FROM learnings ORDER BY id').all() as { id: number; embedding: Buffer }[]);

    await runBackfill(db, { apply: true }, { embed: fakeEmbed });

    const after = db.prepare(`SELECT ${cols} FROM learnings ORDER BY id`).all();
    expect(after).toEqual(before); // no non-embedding column moved (incl. updated_at)

    // The RAW row's embedding BLOB DID change; the norm row's did not.
    const embAfter = (db.prepare('SELECT id, embedding FROM learnings ORDER BY id').all() as { id: number; embedding: Buffer }[]);
    const rawId = (db.prepare("SELECT id FROM learnings WHERE source_extractor='manual'").get() as { id: number }).id;
    const normId = (db.prepare("SELECT id FROM learnings WHERE source_extractor='perception'").get() as { id: number }).id;
    const bufOf = (rows: { id: number; embedding: Buffer }[], id: number) => rows.find((r) => r.id === id)!.embedding;
    expect(bufOf(embAfter, rawId).equals(bufOf(embBefore, rawId))).toBe(false); // rewritten
    expect(bufOf(embAfter, normId).equals(bufOf(embBefore, normId))).toBe(true); // untouched

    // The rewritten RAW row's embedding_model is the current model.
    const model = (db.prepare('SELECT embedding_model FROM learnings WHERE id = ?').get(rawId) as { embedding_model: string }).embedding_model;
    expect(model).toBe(EMBEDDING_MODEL);
  });

  it('(e) hard-fails before any write when sqlite-vec is unavailable (#213)', async () => {
    // A fresh connection WITHOUT loading the extension → vec unavailable.
    const noVec = new Database(dbPath);
    try {
      await expect(runBackfill(noVec, { apply: true }, { embed: fakeEmbed }))
        .rejects.toThrow(/sqlite-vec is NOT available/);
    } finally {
      noVec.close();
    }
  });
});
