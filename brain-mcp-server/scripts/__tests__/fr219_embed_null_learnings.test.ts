/**
 * FR-219a — embed-NULL-learnings focused invariant tests.
 *
 * Covers ONLY the invariants whose violation would cause silent production
 * damage (a full harness is disproportionate for a one-time backfill core):
 *   (a) lockstep     — a NULL-embedding row is embedded into BOTH stores; every
 *                      learnings.embedding id has a matching learnings_vec rowid.
 *   (b) idempotency  — a second run over an already-embedded store embeds 0.
 *   (c) fingerprint  — the stored vector equals generateEmbedding(
 *                      normalizedFingerprint(title,content)), NOT the RAW
 *                      `${title} ${content}` concat. This is the FR-219a fix:
 *                      backfilled rows must land in the normalized geometry, not
 *                      a raw island.
 *   (d) #213 guard   — the SCRIPT runner (`runFr219Backfill`) hard-fails BEFORE
 *                      any write when sqlite-vec is unavailable. (The shared
 *                      core degrades-not-crashes; the mutating script does not.)
 *   (e) blast radius — a non-NULL row is left byte-identical (embedding + every
 *                      other column); only NULL rows are touched.
 *
 * Embedding is injected via a DETERMINISTIC fake embedder (seam), so the
 * fingerprint assertion is exact and the test needs no HF model download. The
 * fake maps identical text → identical unit vector.
 *
 * @module scripts/__tests__/fr219_embed_null_learnings.test
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  embedNullLearnings,
  normalizedFingerprint,
  type Embedder,
} from '../../src/utils/learning-embed.js';
import { runFr219Backfill } from '../fr219_embed_null_learnings.js';
import { embeddingToBuffer, bufferToEmbedding, EMBEDDING_MODEL } from '../../src/utils/embeddings.js';
import { insertEmbedding } from '../../src/utils/vector-search.js';

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

/** Insert a learning with a NULL embedding (a synced, not-yet-embedded row). */
function seedNullRow(db: Database.Database, title: string, content: string): number {
  const result = db.prepare(
    `INSERT INTO learnings (project, category, title, content) VALUES (?, ?, ?, ?)`,
  ).run('test-proj', 'pattern', title, content);
  return Number(result.lastInsertRowid);
}

/** Insert a learning WITH an embedding in both stores (an already-embedded row). */
function seedEmbeddedRow(
  db: Database.Database,
  title: string,
  content: string,
  embedding: Float32Array,
): number {
  const result = db.prepare(
    `INSERT INTO learnings (project, category, title, content, embedding, embedding_model)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('test-proj', 'pattern', title, content, embeddingToBuffer(embedding), EMBEDDING_MODEL);
  const id = Number(result.lastInsertRowid);
  insertEmbedding(db, id, embedding);
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

const A = { title: 'Some Title', content: 'Some UPPER Body — with punctuation' };
const B = { title: 'Another Row', content: 'Second body text' };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr219-'));
  dbPath = path.join(tmpDir, `test-${randomBytes(4).toString('hex')}.db`);
  db = openWithVec();
  createSchema(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('fr219 embedNullLearnings', () => {
  it('(a) embeds a NULL row into BOTH stores in lockstep', async () => {
    seedNullRow(db, A.title, A.content);
    seedNullRow(db, B.title, B.content);

    const s = await embedNullLearnings(db, { dryRun: false }, { embed: fakeEmbed });
    expect(s.scanned).toBe(2);
    expect(s.embedded).toBe(2);
    expect(s.skipped).toBe(0);
    expect(s.failures).toBe(0);

    const blobIds = (db.prepare('SELECT id FROM learnings WHERE embedding IS NOT NULL').all() as { id: number }[])
      .map((r) => r.id).sort((a, b) => a - b);
    const vecIds = (db.prepare('SELECT rowid FROM learnings_vec').all() as { rowid: number }[])
      .map((r) => Number(r.rowid)).sort((a, b) => a - b);
    expect(vecIds).toEqual(blobIds);
    expect(blobIds.length).toBe(2);
    // embedding_model normalized to the current model.
    const model = (db.prepare('SELECT embedding_model FROM learnings WHERE id = ?').get(blobIds[0]) as { embedding_model: string }).embedding_model;
    expect(model).toBe(EMBEDDING_MODEL);
  });

  it('(b) is idempotent — a second run embeds 0', async () => {
    seedNullRow(db, A.title, A.content);
    const first = await embedNullLearnings(db, { dryRun: false }, { embed: fakeEmbed });
    expect(first.embedded).toBe(1);

    const second = await embedNullLearnings(db, { dryRun: false }, { embed: fakeEmbed });
    expect(second.scanned).toBe(0);
    expect(second.embedded).toBe(0);
  });

  it('(c) stores the NORMALIZED fingerprint, not the RAW concat', async () => {
    const id = seedNullRow(db, A.title, A.content);
    await embedNullLearnings(db, { dryRun: false }, { embed: fakeEmbed });

    const stored = bufferToEmbedding(
      (db.prepare('SELECT embedding FROM learnings WHERE id = ?').get(id) as { embedding: Buffer }).embedding,
    );
    const normVec = fakeVector(normalizedFingerprint(A.title, A.content));
    const rawVec = fakeVector(`${A.title} ${A.content}`);

    // The stored vector IS the normalized-fingerprint embedding …
    expect(embeddingToBuffer(stored).equals(embeddingToBuffer(normVec))).toBe(true);
    // … and is NOT the raw concat embedding (proves the FR-219a geometry fix).
    // (normalizeForDedup lowercases + collapses punctuation, so the two differ.)
    expect(embeddingToBuffer(stored).equals(embeddingToBuffer(rawVec))).toBe(false);
  });

  it('(c-dry-run) reports the would-embed count and writes nothing', async () => {
    seedNullRow(db, A.title, A.content);
    const s = await embedNullLearnings(db, { dryRun: true }, { embed: fakeEmbed });
    expect(s.scanned).toBe(1);
    expect(s.embedded).toBe(0);
    expect(s.skipped).toBe(1);
    const stillNull = (db.prepare('SELECT COUNT(*) AS n FROM learnings WHERE embedding IS NULL').get() as { n: number }).n;
    expect(stillNull).toBe(1);
  });

  it('(e) leaves a non-NULL row byte-identical', async () => {
    const embeddedId = seedEmbeddedRow(db, 'Pre Embedded', 'body', fakeVector('sentinel'));
    seedNullRow(db, A.title, A.content);

    const cols = 'id, project, category, title, content, review_status, source_extractor, created_at, updated_at, embedding_model';
    const before = db.prepare(`SELECT ${cols}, embedding FROM learnings WHERE id = ?`).get(embeddedId) as Record<string, unknown> & { embedding: Buffer };

    await embedNullLearnings(db, { dryRun: false }, { embed: fakeEmbed });

    const after = db.prepare(`SELECT ${cols}, embedding FROM learnings WHERE id = ?`).get(embeddedId) as Record<string, unknown> & { embedding: Buffer };
    // every non-embedding column identical
    for (const c of cols.split(',').map((s) => s.trim())) {
      expect(after[c]).toEqual(before[c]);
    }
    // the pre-existing embedding BLOB is untouched
    expect(after.embedding.equals(before.embedding)).toBe(true);
  });

  it('respects the LIMIT (batch) — only `limit` rows embedded per call', async () => {
    seedNullRow(db, A.title, A.content);
    seedNullRow(db, B.title, B.content);
    seedNullRow(db, 'Third', 'third body');

    const s = await embedNullLearnings(db, { dryRun: false, limit: 2 }, { embed: fakeEmbed });
    expect(s.scanned).toBe(2);
    expect(s.embedded).toBe(2);
    const remaining = (db.prepare('SELECT COUNT(*) AS n FROM learnings WHERE embedding IS NULL').get() as { n: number }).n;
    expect(remaining).toBe(1);
  });
});

describe('fr219 runFr219Backfill (#213 script guard)', () => {
  it('(d) hard-fails before any write when sqlite-vec is unavailable', async () => {
    // Seed via the vec-enabled connection, then reopen WITHOUT loading the extension.
    seedNullRow(db, A.title, A.content);
    const noVec = new Database(dbPath);
    try {
      await expect(runFr219Backfill(noVec, { apply: true }, { embed: fakeEmbed }))
        .rejects.toThrow(/sqlite-vec is NOT available/);
      // no write happened — the row is still NULL.
      const stillNull = (noVec.prepare('SELECT COUNT(*) AS n FROM learnings WHERE embedding IS NULL').get() as { n: number }).n;
      expect(stillNull).toBe(1);
    } finally {
      noVec.close();
    }
  });

  it('the shared core DEGRADES (no throw, no write) when vec is unavailable', async () => {
    seedNullRow(db, A.title, A.content);
    const noVec = new Database(dbPath);
    try {
      const s = await embedNullLearnings(noVec, { dryRun: false, log: () => {} }, { embed: fakeEmbed });
      expect(s.scanned).toBe(0);
      expect(s.embedded).toBe(0);
      const stillNull = (noVec.prepare('SELECT COUNT(*) AS n FROM learnings WHERE embedding IS NULL').get() as { n: number }).n;
      expect(stillNull).toBe(1);
    } finally {
      noVec.close();
    }
  });
});
