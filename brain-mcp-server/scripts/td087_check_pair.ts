/**
 * TD-087 — Phase 1 calibration helper (THROWAWAY DIAGNOSTIC).
 *
 * Computes cosine_full / cosine_title_only / cosine_normalized for the
 * canonical L-143 / L-152 reformulation pair from the live brain DB.
 * Used during Phase 1 to confirm the normalisation rule places the pair
 * above the new 0.80 default threshold. Kept in the repo for
 * reproducibility — see `docs/operations/perception-dedup-tuning.md`.
 *
 * Usage:
 *   cd brain-mcp-server && npx tsx scripts/td087_check_pair.ts
 */
import Database from 'better-sqlite3';
import { bufferToEmbedding, generateEmbedding, disposeEmbeddingPipeline } from '../src/utils/embeddings.js';
import { normalizeForDedup } from '../src/engine/components/perception/dedup.js';
import * as os from 'node:os';
import * as path from 'node:path';

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const dbPath = path.join(os.homedir(), '.igris/memory/knowledge.db');
const db = new Database(dbPath, { readonly: true });
const rows = db.prepare("SELECT id, title, content, embedding FROM learnings WHERE id IN (143, 152)").all() as Array<{id: number, title: string, content: string, embedding: Buffer}>;
db.close();

if (rows.length !== 2) {
  console.error('expected 2 rows, got', rows.length);
  process.exit(1);
}

const r143 = rows.find(r => r.id === 143)!;
const r152 = rows.find(r => r.id === 152)!;

const e143 = bufferToEmbedding(r143.embedding);
const e152 = bufferToEmbedding(r152.embedding);
console.log('cosine_full (stored)        =', cosine(e143, e152).toFixed(4));

const t143 = await generateEmbedding(r143.title);
const t152 = await generateEmbedding(r152.title);
console.log('cosine_title_only           =', cosine(t143, t152).toFixed(4));

const n143 = await generateEmbedding(`${normalizeForDedup(r143.title)} ${normalizeForDedup(r143.content)}`.trim());
const n152 = await generateEmbedding(`${normalizeForDedup(r152.title)} ${normalizeForDedup(r152.content)}`.trim());
console.log('cosine_normalized           =', cosine(n143, n152).toFixed(4));

console.log('\n--- L-143 ---');
console.log('title:  ', r143.title);
console.log('norm:   ', `${normalizeForDedup(r143.title)} ${normalizeForDedup(r143.content)}`.slice(0, 200), '...');
console.log('\n--- L-152 ---');
console.log('title:  ', r152.title);
console.log('norm:   ', `${normalizeForDedup(r152.title)} ${normalizeForDedup(r152.content)}`.slice(0, 200), '...');

await disposeEmbeddingPipeline();
