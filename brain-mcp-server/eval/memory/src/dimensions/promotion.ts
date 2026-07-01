/**
 * FR-188 — Dimension 6: cross-project promotion precision / recall (tractable slice).
 *
 * Promotion pairs are seeded LAST (see seed.ts). `promoteToGlobal` runs as a
 * side effect of the last approved store; we verify the outcome two ways:
 *   1. the `Auto-promoted` note captured from the store envelope (behavioural), and
 *   2. the authoritative `scope` column read back from the fixture DB (state).
 *
 * A true-dup pair (title shared, first-200-char word-Jaccard >= 0.80) MUST flip
 * every row to `global`; a same-title-distinct pair (< 0.80) MUST stay `local`.
 * TP = true-dup promoted; FP = distinct pair promoted; FN = true-dup not promoted.
 *
 * @module eval/memory/dimensions/promotion
 */

import { getDb } from '../../../../src/db.js';

export interface PromotionCase {
  id: string;
  keys: string[];
  title: string;
  expect: 'promote' | 'no_promote';
  notes?: string;
}

export interface PromotionCasesFile {
  description?: string;
  cases: PromotionCase[];
}

export interface PromotionCaseResult {
  id: string;
  expect: 'promote' | 'no_promote';
  scopes: Record<string, string>; // key -> scope read from DB
  promoted: boolean; // all rows now global
  note_fired: boolean; // Auto-promoted note observed during seed
  correct: boolean;
}

export interface PromotionDimResult {
  n: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  per_case: PromotionCaseResult[];
}

export function runPromotionDimension(
  cases: PromotionCase[],
  keyToId: Map<string, number>,
  promotionNoteFired: Map<string, boolean>,
): PromotionDimResult {
  const db = getDb();
  const per: PromotionCaseResult[] = [];

  for (const c of cases) {
    const scopes: Record<string, string> = {};
    let noteFired = false;
    for (const key of c.keys) {
      const id = keyToId.get(key);
      if (id === undefined) throw new Error(`[eval:promotion] unknown corpus key: ${key}`);
      const row = db.prepare('SELECT scope FROM learnings WHERE id = ?').get(id) as { scope: string } | undefined;
      scopes[key] = row?.scope ?? '(missing)';
      if (promotionNoteFired.get(key)) noteFired = true;
    }
    const promoted = c.keys.every((key) => scopes[key] === 'global');
    const correct = c.expect === 'promote' ? promoted : !promoted;
    per.push({ id: c.id, expect: c.expect, scopes, promoted, note_fired: noteFired, correct });
  }

  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const p of per) {
    if (p.expect === 'promote') {
      if (p.promoted) tp++; else fn++;
    } else {
      if (p.promoted) fp++; else tn++;
    }
  }
  const precision = tp + fp > 0 ? +(tp / (tp + fp)).toFixed(4) : null;
  const recall = tp + fn > 0 ? +(tp / (tp + fn)).toFixed(4) : null;

  return { n: per.length, tp, fp, fn, tn, precision, recall, per_case: per };
}
