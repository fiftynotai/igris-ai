/**
 * FR-188 — Seed the sealed synthetic corpus into a fresh fixture DB.
 *
 * The seam: set `IGRIS_DB_PATH` to a fresh temp file BEFORE the first `getDb()`
 * call, then drive the REAL `handleMemoryStore` over the corpus. This exercises
 * the production write path — real embeddings, `learnings_fts` triggers, and the
 * sqlite-vec table — so the eval reflects production retrieval geometry, not a
 * re-implemented insert.
 *
 * Promotion pairs MUST come LAST in the corpus file (base titles are unique, so
 * base seeding never fires a premature `promoteToGlobal`). Each approved store
 * runs `promoteToGlobal` as a side effect; we capture whether its envelope
 * carried the `Auto-promoted` note for the promotion dimension.
 *
 * @module eval/memory/seed
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleMemoryStore } from '../../../src/tools/memory.js';
import { isVecAvailable } from '../../../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type Category = 'pattern' | 'decision' | 'discovery' | 'mistake' | 'optimization';

export interface CorpusEntry {
  key: string;
  project: string;
  category: Category;
  title: string;
  content: string;
  tags?: string;
  tech_stack?: string;
  scope?: 'local' | 'global';
  review_status?: 'pending_review' | 'approved';
  source_extractor?: 'manual' | 'llm' | 'distill';
}

export interface SeedResult {
  dbPath: string;
  tmpDir: string;
  keyToId: Map<string, number>;
  /** key -> true when the store envelope carried an `Auto-promoted` note. */
  promotionNoteFired: Map<string, boolean>;
  vectorChannel: boolean;
  count: number;
}

/** Default corpus path (this suite's sealed corpus). */
export function defaultCorpusPath(): string {
  return path.resolve(__dirname, '..', 'corpus', 'learnings.seed.json');
}

export function loadCorpus(corpusPath: string): CorpusEntry[] {
  const raw = fs.readFileSync(corpusPath, 'utf8');
  const arr = JSON.parse(raw) as CorpusEntry[];
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error(`[eval:seed] corpus at ${corpusPath} is empty or not an array`);
  }
  return arr;
}

/**
 * Seed the corpus into a fresh temp DB. Sets `IGRIS_DB_PATH` (must run before
 * any other `getDb()` consumer in this process). Returns the id map + metadata.
 */
export async function seedCorpus(entries: CorpusEntry[]): Promise<SeedResult> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igris_eval_memory_'));
  const dbPath = path.join(tmpDir, 'eval_memory.db');
  process.env.IGRIS_DB_PATH = dbPath;

  const keyToId = new Map<string, number>();
  const promotionNoteFired = new Map<string, boolean>();

  for (const e of entries) {
    const res = await handleMemoryStore({
      project: e.project,
      category: e.category,
      title: e.title,
      content: e.content,
      tags: e.tags,
      tech_stack: e.tech_stack,
      scope: e.scope ?? 'local',
      review_status: e.review_status ?? 'approved',
      source_extractor: e.source_extractor ?? 'manual',
    });
    const text = res.content.map((c) => c.text).join('\n');
    const idMatch = text.match(/\bID: (\d+)/);
    if (!idMatch) {
      throw new Error(`[eval:seed] store did not return an ID for key ${e.key}: ${text}`);
    }
    keyToId.set(e.key, parseInt(idMatch[1], 10));
    promotionNoteFired.set(e.key, /Auto-promoted:/.test(text));
  }

  // isVecAvailable() reflects whether getDb() loaded sqlite-vec on this fixture.
  const vectorChannel = isVecAvailable();

  return { dbPath, tmpDir, keyToId, promotionNoteFired, vectorChannel, count: entries.length };
}

/** Best-effort cleanup of the temp fixture directory. */
export function cleanupSeed(seed: SeedResult): void {
  try {
    fs.rmSync(seed.tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
