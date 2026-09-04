/**
 * TD-439 — the arbiter `evolved_merge` guard: hash-checked, carry-forward,
 * refusal-observable.
 *
 * THE TWO DEFECTS (measured on the live brain, 2026-09-01 applies):
 *   1. The synthesis the arbiter writes over the winner is prose generalised
 *      from a 200-char snippet per side (`candidates.ts` `SNIPPET_MAX`), so it
 *      structurally cannot carry the inputs' executable specifics — 941 <- 907
 *      lost 26 identifiers, 258 <- 27 lost 4, 257 <- 131 lost 10. The operator
 *      restored them by hand under TD-437.
 *   2. `synthesized_content` is a snapshot computed at generation and applied
 *      later with no check that the winner still matches the read it was
 *      computed from. Suggestion 1374 (258 <- 218) would have overwritten 258's
 *      later merge AND its hand repair — a lost update.
 *
 * THE FIX UNDER TEST (kinds.ts `applyResolveContradiction`, arbiter.ts
 * `persistArbiterProposal`, actions/index.ts `applyAction`):
 *   - the producer stamps `synthesized_from_hash = sha256(winner.content)` into
 *     the action at generation; the executor refuses when the key is absent or
 *     differs from `sha256` of the winner's EXACT current bytes (fail-closed —
 *     a hash-less row is indistinguishable from the 1374 shape);
 *   - the executor extracts the executable specifics of BOTH inputs (the
 *     winner's prior text and the loser) with a deterministic grammar and
 *     carries every LINE (or fenced block) whose specific the synthesis
 *     dropped into a trailing `Preserved specifics` section; a carry above
 *     `CARRY_CAP` chars is a refusal, not a truncation;
 *   - a refusal leaves the suggestion `pending`, names its reason in the tool
 *     text (`apply_action (…) refused: …`) AND persists it under
 *     `evidence.apply_refused`; the auto-resolve fork falls through to the
 *     review INSERT instead of reporting `'deduped'`.
 *
 * WHY BOTH INPUTS. The synthesis REPLACES the winner, so the winner's own
 * specifics are as exposed as the loser's — and after the TD-437 repair the
 * restored specifics live in the WINNER. A loser-only extractor keeps every
 * brief-named identifier green (they are all loser-borne) and fails only on
 * the `*_winner_only` sets the fixture measured; mutation M4 relies on that.
 *
 * WORLDS. `fixtures/td439-pairs.ts` (read-only harvest, 2026-09-04) — see its
 * docblock for the modelling choice (losers `approved` = the pre-apply world,
 * because an already-superseded loser is a no-op before any content write).
 *
 * RED-FIRST (run at HEAD 2275c17 before the guard existed): T1 wrote the stale
 * synthesis over the repaired 258 and superseded 218; T2 left 941 at the
 * 595-char synthesis with `527b9983` gone; T4 replaced the repaired winners;
 * T3 applied the over-cap pair; T6 found no hash key; T6b got `'deduped'`;
 * T7/T7b failed on the missing exports. The red counts are quoted in the
 * brief's Agent Log.
 *
 * PINS THAT MOVED WITH A REASON (2026-09-04): the 1081 <- 343 control the
 * brief calls "merged cleanly" is NOT carry-free under this grammar — the
 * synthesis dropped the manifest snippet, the merger-report path and
 * `TD-002`/`TD-007`. The measured counts are pinned as the honest number
 * (T2d), not tuned to the plan's expected 0.
 *
 * @module engine/components/arbiter/__tests__/td439-merge-guard.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAction } from '../../subconscious/actions/index.js';
import {
  applyResolveContradiction,
  carryForward,
  contentHash,
  extractSpecifics,
  CARRY_CAP,
  PRESERVED_MARKER,
} from '../../subconscious/actions/kinds.js';
import {
  persistArbiterProposal,
  type ArbiterContext,
} from '../../cognition/extractors/arbiter.js';
import type { ContradictionProposal } from '../types.js';
import { performUndo } from '../../janitor/undo.js';
import { subconsciousMigrations } from '../../subconscious/schema.js';
import { edgeMigrations } from '../../edges/schema.js';
import { janitorMigrations } from '../../janitor/schema.js';
import { handleEdgeCreate } from '../../edges/handlers.js';
import { getDb } from '../../../../db.js';
import { WORLD_2026_09_04, type Td439Pair } from './fixtures/td439-pairs.js';

vi.mock('../../../../db.js', () => ({ getDb: vi.fn() }));
vi.mock('../../edges/handlers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../edges/handlers.js')>();
  return { ...actual, handleEdgeCreate: vi.fn(actual.handleEdgeCreate) };
});

// ---------------------------------------------------------------------------
// World helpers
// ---------------------------------------------------------------------------

/** Independent of `contentHash` so deleting the production comparison reds. */
function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function makeBrain(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_name TEXT NOT NULL,
      component TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      machine_hostname TEXT,
      project_slug TEXT,
      instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL DEFAULT 'p',
      category TEXT NOT NULL DEFAULT 'pattern',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
      review_status TEXT NOT NULL DEFAULT 'approved',
      seen_again_count INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT,
      embedding BLOB,
      embedding_model TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  for (const m of subconsciousMigrations) db.exec(m.sql);
  for (const m of edgeMigrations) db.exec(m.sql);
  for (const m of janitorMigrations) db.exec(m.sql);
  return db;
}

type World = 'prior' | 'repaired';

function seedLearning(
  db: Database.Database,
  id: number,
  content: string,
  reviewStatus = 'approved',
  seen = 1,
): void {
  db.prepare(
    `INSERT INTO learnings (id, title, content, review_status, seen_again_count, embedding, embedding_model)
     VALUES (?, ?, ?, ?, ?, X'00', 'm')`,
  ).run(id, `L${id}`, content, reviewStatus, seen);
}

/** Seed one fixture pair; the winner at `world`, the loser at `loserStatus`. */
function seedPair(
  db: Database.Database,
  pair: Td439Pair,
  world: World,
  loserStatus = 'approved',
): string {
  const winnerText = world === 'prior' ? pair.winner.content_prior : pair.winner.content_repaired;
  seedLearning(db, pair.winner.id, winnerText, 'approved', 1);
  seedLearning(db, pair.loser.id, pair.loser.content, loserStatus, 0);
  return winnerText;
}

function mergeAction(pair: Td439Pair, hash: string | undefined): Record<string, unknown> {
  return {
    kind: 'resolve_contradiction',
    resolution: 'evolved_merge',
    winner_id: pair.winner.id,
    loser_id: pair.loser.id,
    synthesized_content: pair.synthesized_content,
    justification: 'fixture',
    ...(hash === undefined ? {} : { synthesized_from_hash: hash }),
  };
}

function queue(
  db: Database.Database,
  action: Record<string, unknown>,
  evidence: Record<string, unknown> = { verdict: 'evolved_merge', cosine: 0.84 },
): number {
  const res = db
    .prepare(
      `INSERT INTO suggestions (source_module, title, evidence, priority, status, suggested_action, type_inferred, source_instance)
       VALUES ('arbiter','resolve', ?, 'low','pending', ?, 1, 'arbiter')`,
    )
    .run(JSON.stringify(evidence), JSON.stringify(action));
  return Number(res.lastInsertRowid);
}

interface LearningRow {
  content: string;
  review_status: string;
  superseded_by: number | null;
  seen_again_count: number;
  embedding: Buffer | null;
}
function learning(db: Database.Database, id: number): LearningRow {
  return db
    .prepare(`SELECT content, review_status, superseded_by, seen_again_count, embedding FROM learnings WHERE id=?`)
    .get(id) as LearningRow;
}

interface SuggestionRow {
  status: string;
  acted_at: string | null;
  evidence: string;
}
function suggestion(db: Database.Database, id: number): SuggestionRow & { ev: Record<string, unknown> } {
  const row = db.prepare(`SELECT status, acted_at, evidence FROM suggestions WHERE id=?`).get(id) as SuggestionRow;
  return { ...row, ev: JSON.parse(row.evidence) as Record<string, unknown> };
}

function toolText(r: { content: Array<{ text?: string }> }): string {
  return r.content[0]?.text ?? '';
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const pairByName = (name: string): Td439Pair => {
  const p = WORLD_2026_09_04.pairs.find((x) => x.name === name);
  if (!p) throw new Error(`no fixture pair ${name}`);
  return p;
};
const P258 = pairByName('258<-27');
const P941 = pairByName('941<-907');
const P257 = pairByName('257<-131');
const P1081 = pairByName('1081<-343');
const LOSSY = [P258, P941, P257];

/** Synthetic texts whose every line carries a distinct specific — total > CARRY_CAP. */
function overCapTexts(): { winner: string; loser: string } {
  const line = (i: number) => `Step ${i}: run \`tool-${i} --flag=${i}\` then verify TD-${100 + (i % 900)} closed.`;
  const winner = Array.from({ length: 90 }, (_, i) => line(i)).join('\n');
  const loser = Array.from({ length: 90 }, (_, i) => line(1000 + i)).join('\n');
  return { winner, loser };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('TD-439 evolved_merge guard', () => {
  let db: Database.Database;
  let brainDir: string;
  let savedBrainDir: string | undefined;
  let savedDbPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeBrain();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    // Belt (TD-426): nothing under test resolves a DB path, but the seam is
    // fenced anyway and ARMED — a real `getDb` here would be the live brain.
    expect(vi.isMockFunction(getDb)).toBe(true);
    savedBrainDir = process.env.IGRIS_BRAIN_DIR;
    savedDbPath = process.env.IGRIS_DB_PATH;
    brainDir = mkdtempSync(join(tmpdir(), 'td439-'));
    process.env.IGRIS_BRAIN_DIR = brainDir;
    process.env.IGRIS_DB_PATH = join(brainDir, 'knowledge.db');
  });
  afterEach(() => {
    db.close();
    if (savedBrainDir === undefined) delete process.env.IGRIS_BRAIN_DIR;
    else process.env.IGRIS_BRAIN_DIR = savedBrainDir;
    if (savedDbPath === undefined) delete process.env.IGRIS_DB_PATH;
    else process.env.IGRIS_DB_PATH = savedDbPath;
    rmSync(brainDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // T0 — provenance: the brief's own table validates the harvest
  // -------------------------------------------------------------------------
  describe('T0 provenance', () => {
    it('every embedded text matches the brief byte table (sqlite length() = chars)', () => {
      expect(WORLD_2026_09_04.pairs).toHaveLength(4);
      for (const p of WORLD_2026_09_04.pairs) {
        expect([p.name, p.loser.content.length]).toEqual([p.name, p.brief_lengths.loser]);
        expect([p.name, p.synthesized_content.length]).toEqual([p.name, p.brief_lengths.synthesized]);
        expect([p.name, p.winner.content_prior.length]).toEqual([p.name, p.winner_lengths.prior]);
        expect([p.name, p.winner.content_repaired.length]).toEqual([p.name, p.winner_lengths.repaired]);
      }
      // The brief's table, literally: losers 554 / 2347 / 1144 / 1155, after 447 / 595 / 457 / 513.
      expect(WORLD_2026_09_04.pairs.map((p) => p.brief_lengths.loser)).toEqual([554, 2347, 1144, 1155]);
      expect(WORLD_2026_09_04.pairs.map((p) => p.brief_lengths.synthesized)).toEqual([447, 595, 457, 513]);
      // 1081 is the pair that was NOT hand-repaired: its live text IS the synthesis.
      expect(P1081.winner.content_repaired).toBe(P1081.synthesized_content);
      const s = WORLD_2026_09_04.scenario_1374;
      expect(s.winner_content_at_generation.length).toBe(s.lengths.at_generation);
      expect(s.winner_content_now.length).toBe(s.lengths.now);
      expect(s.loser_content.length).toBe(s.lengths.loser);
      expect((s.action.synthesized_content as string).length).toBe(s.lengths.synthesized);
      expect(s.action).not.toHaveProperty('synthesized_from_hash');
    });

    it('the named identifiers are really in the loser, and the winner-only sets really are winner-only', () => {
      for (const p of WORLD_2026_09_04.pairs) {
        for (const id of p.named_identifiers) expect([p.name, id, p.loser.content.includes(id)]).toEqual([p.name, id, true]);
        for (const id of p.prior_winner_only) {
          expect([p.name, id, p.winner.content_prior.includes(id)]).toEqual([p.name, id, true]);
          expect([p.name, id, p.loser.content.includes(id)]).toEqual([p.name, id, false]);
          expect([p.name, id, p.synthesized_content.includes(id)]).toEqual([p.name, id, false]);
        }
        for (const id of p.repaired_winner_only) {
          expect([p.name, id, p.winner.content_repaired.includes(id)]).toEqual([p.name, id, true]);
          expect([p.name, id, p.loser.content.includes(id)]).toEqual([p.name, id, false]);
          expect([p.name, id, p.synthesized_content.includes(id)]).toEqual([p.name, id, false]);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // T1 — AC-2: the 1374 scenario (stale synthesis) is refused
  // -------------------------------------------------------------------------
  describe('T1 AC-2 stale synthesis', () => {
    const S = WORLD_2026_09_04.scenario_1374;

    function seed1374(): void {
      seedLearning(db, 258, S.winner_content_now, 'approved', 1);
      seedLearning(db, 218, S.loser_content, 'approved', 0);
    }

    it('T1: hash of the AT-GENERATION text vs the repaired winner → refused, nothing written, pending, reason persisted', () => {
      seed1374();
      const id = queue(db, { ...S.action, synthesized_from_hash: sha256(S.winner_content_at_generation) });
      const r = applyAction(db, id);
      expect(r.isError).toBe(true);
      expect(toolText(r)).toMatch(/apply_action \(resolve_contradiction\) refused: .*content hash mismatch/);
      expect(learning(db, 258).content).toBe(S.winner_content_now);
      expect(learning(db, 218).review_status).toBe('approved');
      expect(learning(db, 218).superseded_by).toBeNull();
      const sg = suggestion(db, id);
      expect(sg.status).toBe('pending');
      expect(sg.acted_at).toBeNull();
      const refused = sg.ev.apply_refused as { at: string; reason: string };
      expect(refused.reason).toMatch(/content hash mismatch/);
      expect(refused.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // No top-level id key was added — the finding key (entityKey) is unaffected.
      expect(Object.keys(sg.ev).sort()).toEqual(['apply_refused', 'cosine', 'verdict']);
      // Zero undo entries: the guard fires before the transaction opens.
      expect((db.prepare(`SELECT COUNT(*) AS n FROM brain_maintenance_undo`).get() as { n: number }).n).toBe(0);
    });

    it('T1b: the live 1374 action (no hash key) is refused fail-closed with the pre-TD-439 remedy', () => {
      seed1374();
      const id = queue(db, S.action);
      const r = applyAction(db, id);
      expect(r.isError).toBe(true);
      expect(toolText(r)).toMatch(/refused: .*no synthesis provenance/);
      expect(learning(db, 258).content).toBe(S.winner_content_now);
      expect(learning(db, 218).review_status).toBe('approved');
      expect(suggestion(db, id).status).toBe('pending');
      expect((suggestion(db, id).ev.apply_refused as { reason: string }).reason).toMatch(/no synthesis provenance/);
    });

    it('T1d (TD-438 class): the comparison is on the EXACT bytes — one appended byte or a whitespace-normalised hash refuses', () => {
      seed1374();
      for (const variant of [S.winner_content_now + '\n', S.winner_content_now.replace(/\s+/g, ' ')]) {
        expect(variant).not.toBe(S.winner_content_now);
        const id = queue(db, { ...S.action, synthesized_from_hash: sha256(variant) });
        expect(toolText(applyAction(db, id))).toMatch(/content hash mismatch/);
        expect(learning(db, 258).content).toBe(S.winner_content_now);
        expect(suggestion(db, id).status).toBe('pending');
      }
    });

    it('T1c (control): the hash of the CURRENT winner applies, marks acted, persists no refusal', () => {
      seed1374();
      const id = queue(db, { ...S.action, synthesized_from_hash: sha256(S.winner_content_now) });
      const r = applyAction(db, id);
      expect(r.isError).toBeFalsy();
      expect(learning(db, 258).content.startsWith(S.action.synthesized_content as string)).toBe(true);
      expect(learning(db, 218).review_status).toBe('superseded');
      const sg = suggestion(db, id);
      expect(sg.status).toBe('acted');
      expect(sg.acted_at).not.toBeNull();
      expect(sg.ev).not.toHaveProperty('apply_refused');
      expect(contentHash(S.winner_content_now)).toBe(sha256(S.winner_content_now));
    });
  });

  // -------------------------------------------------------------------------
  // T2 — AC-1: the three lossy pairs keep their specifics (pre-apply world)
  // -------------------------------------------------------------------------
  describe('T2 AC-1 carry-forward (winner at PRIOR text)', () => {
    for (const pair of LOSSY) {
      it(`${pair.name}: every named identifier AND every winner-only specific survives the merge`, () => {
        const winnerPrior = seedPair(db, pair, 'prior');
        const id = queue(db, mergeAction(pair, sha256(winnerPrior)));
        const r = applyAction(db, id);
        expect(toolText(r)).not.toMatch(/refused|failed/);
        expect(r.isError).toBeFalsy();
        const w = learning(db, pair.winner.id);
        for (const ident of pair.named_identifiers) {
          expect([pair.name, ident, w.content.includes(ident)]).toEqual([pair.name, ident, true]);
        }
        for (const ident of pair.prior_winner_only) {
          expect([pair.name, ident, w.content.includes(ident)]).toEqual([pair.name, ident, true]);
        }
        expect(w.content.startsWith(pair.synthesized_content)).toBe(true);
        expect(w.embedding).toBeNull();
        // Both sources carried something the synthesis dropped → one section per source.
        expect(count(w.content, PRESERVED_MARKER)).toBe(2);
        expect(w.content).toContain(`${PRESERVED_MARKER}${pair.winner.id}`);
        expect(w.content).toContain(`${PRESERVED_MARKER}${pair.loser.id}`);
        const l = learning(db, pair.loser.id);
        expect(l.review_status).toBe('superseded');
        expect(l.superseded_by).toBe(pair.winner.id);
        expect(suggestion(db, id).status).toBe('acted');
        const payload = JSON.parse(toolText(r)) as { result: { specifics_carried: number } };
        expect(payload.result.specifics_carried).toBeGreaterThan(0);
      });
    }

    it('T2d precision control — 1081<-343: the measured carry is pinned (NOT 0 — see docblock) and growth is bounded', () => {
      // Pins measured 2026-09-04 with the shipped grammar. If a grammar change
      // moves them, re-measure and record the reason here.
      const prior = carryForward(
        [
          { id: P1081.winner.id, label: 'pre-merge', text: P1081.winner.content_prior },
          { id: P1081.loser.id, label: 'superseded', text: P1081.loser.content },
        ],
        P1081.synthesized_content,
      );
      expect({ carried: prior.carried, chars: prior.chars }).toEqual({ carried: 10, chars: 2353 });
      const repaired = carryForward(
        [
          { id: P1081.winner.id, label: 'pre-merge', text: P1081.winner.content_repaired },
          { id: P1081.loser.id, label: 'superseded', text: P1081.loser.content },
        ],
        P1081.synthesized_content,
      );
      // The live 1081 IS the synthesis, so only the loser contributes: 4 lines.
      expect({ carried: repaired.carried, chars: repaired.chars }).toEqual({ carried: 4, chars: 1146 });
      expect(count(repaired.text, PRESERVED_MARKER)).toBe(1);
      for (const r of [prior, repaired]) {
        expect(r.text.startsWith(P1081.synthesized_content)).toBe(true);
        expect(r.chars).toBeLessThanOrEqual(CARRY_CAP);
        // Growth = synthesis + carried chars + section headers/newlines — never more.
        expect(r.text.length).toBeLessThanOrEqual(P1081.synthesized_content.length + r.chars + 2 * 80);
        // The manifest snippet the synthesis dropped is what came back.
        expect(r.text).toContain('tools:node="remove" />');
      }
      // End to end, the same pair through applyAction lands the same growth.
      const winnerPrior = seedPair(db, P1081, 'prior');
      const id = queue(db, mergeAction(P1081, sha256(winnerPrior)));
      expect(applyAction(db, id).isError).toBeFalsy();
      expect(learning(db, 1081).content).toBe(prior.text);
      expect(learning(db, 1081).content.length).toBe(2982);
    });
  });

  // -------------------------------------------------------------------------
  // T3 — AC-3: cap overflow is a refusal; a transient failure is NOT persisted
  // -------------------------------------------------------------------------
  describe('T3 AC-3 refusal path', () => {
    it('T3: carry above CARRY_CAP → refused with the char count, pending, evidence.apply_refused set', () => {
      const { winner, loser } = overCapTexts();
      seedLearning(db, 10, winner);
      seedLearning(db, 11, loser);
      const id = queue(db, {
        kind: 'resolve_contradiction',
        resolution: 'evolved_merge',
        winner_id: 10,
        loser_id: 11,
        synthesized_content: 'Follow the runbook steps in order.',
        synthesized_from_hash: sha256(winner),
      });
      const r = applyAction(db, id);
      expect(r.isError).toBe(true);
      const text = toolText(r);
      expect(text).toMatch(/refused: .*exceeds/);
      expect(text).toMatch(new RegExp(`\\b\\d{4,} chars?\\b`));
      expect(text).toContain(String(CARRY_CAP));
      expect(learning(db, 10).content).toBe(winner);
      expect(learning(db, 11).review_status).toBe('approved');
      const sg = suggestion(db, id);
      expect(sg.status).toBe('pending');
      expect(sg.acted_at).toBeNull();
      expect((sg.ev.apply_refused as { reason: string }).reason).toMatch(/exceeds/);
      expect(Object.keys(sg.ev).sort()).toEqual(['apply_refused', 'cosine', 'verdict']);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM brain_maintenance_undo`).get() as { n: number }).n).toBe(0);
    });

    it('T3 (unit): CARRY_CAP is 8_000 and the over-cap fixture exceeds it (the exact boundary is not constructed here)', () => {
      expect(CARRY_CAP).toBe(8_000);
      const { winner, loser } = overCapTexts();
      const cf = carryForward([{ id: 10, label: 'a', text: winner }, { id: 11, label: 'b', text: loser }], 'prose');
      expect(cf.chars).toBeGreaterThan(CARRY_CAP);
      const r = applyResolveContradiction(db, {
        resolution: 'evolved_merge', winner_id: 10, loser_id: 11, synthesized_content: 'prose',
      });
      // 10/11 do not exist in this db yet → the existence check fires first (not a refusal).
      expect(r.ok).toBe(false);
      expect(r.refused).toBeUndefined();
    });

    it('T3b (control): a transient failure (edge write throws) leaves pending WITHOUT a persisted refusal', () => {
      const winnerPrior = seedPair(db, P258, 'prior');
      const id = queue(db, mergeAction(P258, sha256(winnerPrior)));
      vi.mocked(handleEdgeCreate).mockReturnValueOnce({
        isError: true,
        content: [{ type: 'text', text: 'simulated edge failure' }],
      });
      const r = applyAction(db, id);
      expect(r.isError).toBe(true);
      expect(toolText(r)).toMatch(/failed: resolve failed: supersedes edge creation failed/);
      expect(toolText(r)).not.toMatch(/refused/);
      const sg = suggestion(db, id);
      expect(sg.status).toBe('pending');
      expect(sg.ev).not.toHaveProperty('apply_refused');
      // The transaction rolled back: winner untouched, loser still approved.
      expect(learning(db, 258).content).toBe(winnerPrior);
      expect(learning(db, 27).review_status).toBe('approved');
    });
  });

  // -------------------------------------------------------------------------
  // T4 — AC-4: the hand-repaired winners are not re-lost
  // -------------------------------------------------------------------------
  describe('T4 AC-4 repaired winners (winner at REPAIRED text, loser approved)', () => {
    for (const pair of LOSSY) {
      it(`${pair.name}: re-running the merge keeps the restored specifics (winner-side carry)`, () => {
        const repaired = seedPair(db, pair, 'repaired');
        expect(repaired).toBe(pair.winner.content_repaired);
        // "A fresh regeneration that still produced the same prose": hash of the REPAIRED winner.
        const id = queue(db, mergeAction(pair, sha256(repaired)));
        const r = applyAction(db, id);
        expect(r.isError).toBeFalsy();
        const w = learning(db, pair.winner.id);
        for (const ident of [...pair.named_identifiers, ...pair.repaired_winner_only]) {
          expect([pair.name, ident, w.content.includes(ident)]).toEqual([pair.name, ident, true]);
        }
        expect(pair.repaired_winner_only.length).toBeGreaterThan(0); // the gate is not vacuous
        const payload = JSON.parse(toolText(r)) as { result: { specifics_carried: number } };
        expect(payload.result.specifics_carried).toBeGreaterThan(0);
        expect(learning(db, pair.loser.id).review_status).toBe('superseded');
      });
    }

    it('T4b (control): against the LIVE shape (loser already superseded) the apply is a no-op — the exposure is the pre-apply world', () => {
      seedPair(db, P941, 'repaired', 'superseded');
      const r = applyResolveContradiction(db, mergeAction(P941, sha256(P941.winner.content_repaired)));
      expect(r.ok).toBe(true);
      expect(r.message).toMatch(/already superseded/);
      expect(learning(db, 941).content).toBe(P941.winner.content_repaired);
    });
  });

  // -------------------------------------------------------------------------
  // T5 — undo reverses a carried-forward merge with ZERO undo change
  // -------------------------------------------------------------------------
  it('T5: performUndo of both entries restores the EXACT prior winner and un-supersedes the loser', () => {
    const winnerPrior = seedPair(db, P941, 'prior');
    const r = applyResolveContradiction(db, mergeAction(P941, sha256(winnerPrior)));
    expect(r.ok).toBe(true);
    expect(learning(db, 941).content).not.toBe(winnerPrior);
    expect(learning(db, 941).content).toContain(PRESERVED_MARKER);
    const entries = db.prepare(`SELECT id FROM brain_maintenance_undo ORDER BY id`).all() as Array<{ id: number }>;
    expect(entries).toHaveLength(2);
    for (const e of entries) expect(performUndo(db, { entry_id: e.id }).reversed).toBe(1);
    const w = learning(db, 941);
    expect(w.content).toBe(winnerPrior);
    expect(w.seen_again_count).toBe(1);
    expect(w.embedding).toBeNull();
    const l = learning(db, 907);
    expect(l.review_status).toBe('approved');
    expect(l.superseded_by).toBeNull();
    expect((db.prepare(`SELECT COUNT(*) AS n FROM entity_edges WHERE edge_type='supersedes'`).get() as { n: number }).n).toBe(0);
  });

  // -------------------------------------------------------------------------
  // T6 — producer: the hash is stamped at generation; the fork does not swallow
  // -------------------------------------------------------------------------
  describe('T6 producer (persistArbiterProposal)', () => {
    function ctx(autoResolve = false): ArbiterContext {
      return {
        pairs: [],
        project: 'all',
        autoResolve,
        autoResolveThreshold: 0.95,
        pairs_bytes: 0,
        persistedPairs: new Set<string>(),
      };
    }
    function proposal(over: Partial<ContradictionProposal>): ContradictionProposal {
      return { verdict: 'evolved_merge', winner_id: 2, loser_id: 1, synthesized_content: 'evolved prose', justification: 'j', confidence: 0.7, cosine: 0.97, ...over };
    }
    function storedAction(): Record<string, unknown> {
      const row = db.prepare(`SELECT suggested_action FROM suggestions WHERE source_module='arbiter' ORDER BY id DESC LIMIT 1`).get() as { suggested_action: string };
      return JSON.parse(row.suggested_action) as Record<string, unknown>;
    }

    it('T6: evolved_merge stamps synthesized_from_hash = sha256(winner.content); the other verdicts carry no key', () => {
      seedLearning(db, 1, 'use retry backoff');
      seedLearning(db, 2, 'never use retry backoff; use a circuit-breaker with `timeout=30`');
      expect(persistArbiterProposal(db, proposal({}), ctx())).toBe('proposed');
      const a = storedAction();
      expect(a.synthesized_from_hash).toBe(sha256('never use retry backoff; use a circuit-breaker with `timeout=30`'));
      expect(a.synthesized_content).toBe('evolved prose');

      expect(persistArbiterProposal(db, proposal({ verdict: 'newer_wins', winner_id: 2, loser_id: 1, synthesized_content: undefined }), { ...ctx(), persistedPairs: new Set() })).toBe('proposed');
      expect(storedAction()).not.toHaveProperty('synthesized_from_hash');

      expect(persistArbiterProposal(db, { verdict: 'both_valid_scope', learning_a_id: 1, learning_b_id: 2, scope_a: 's', justification: 'j', confidence: 0.6, cosine: 0.9 }, { ...ctx(), persistedPairs: new Set() })).toBe('proposed');
      expect(storedAction()).not.toHaveProperty('synthesized_from_hash');
    });

    it('T6b: the auto-resolve fork falls through to a PENDING row on a refusal (never `deduped`)', () => {
      const { winner, loser } = overCapTexts();
      seedLearning(db, 2, winner);
      seedLearning(db, 1, loser);
      const outcome = persistArbiterProposal(db, proposal({ synthesized_content: 'Follow the runbook.' }), ctx(true));
      expect(outcome).toBe('proposed');
      const row = db.prepare(`SELECT status, suggested_action FROM suggestions WHERE source_module='arbiter'`).get() as { status: string; suggested_action: string } | undefined;
      expect(row?.status).toBe('pending');
      expect(JSON.parse(row!.suggested_action)).toMatchObject({ resolution: 'evolved_merge', synthesized_from_hash: sha256(winner) });
      expect(learning(db, 2).content).toBe(winner);
      expect(learning(db, 1).review_status).toBe('approved');
    });

    it('T6c: the auto-resolve happy path resolves directly — the in-run hash passes the guard', () => {
      seedLearning(db, 1, 'use retry backoff (see BR-001)');
      seedLearning(db, 2, 'never use retry backoff');
      expect(persistArbiterProposal(db, proposal({}), ctx(true))).toBe('resolved');
      expect((db.prepare(`SELECT COUNT(*) AS n FROM suggestions`).get() as { n: number }).n).toBe(0);
      expect(learning(db, 1).review_status).toBe('superseded');
      const w = learning(db, 2);
      expect(w.content.startsWith('evolved prose')).toBe(true);
      expect(w.content).toContain('BR-001'); // the loser's specific carried
    });
  });

  // -------------------------------------------------------------------------
  // T7 — the grammar and the carry, as units
  // -------------------------------------------------------------------------
  describe('T7 grammar', () => {
    it('positives: one per rule (the inline-JSON rule was cut for packed bytes 2026-09-04 — its fixture identifier is backticked)', () => {
      const cases: Array<[string, string]> = [
        ['run `wc -c file` first', '`wc -c file`'],
        ['tracked in TD-016 and L-1250', 'TD-016'],
        ['tracked in TD-016 and L-1250', 'L-1250'],
        ['see https://example.com/docs?x=1) now', 'https://example.com/docs?x=1'],
        ['edit brain_push_cli.ts:289-326 today', 'brain_push_cli.ts:289-326'],
        ['under scripts/worker_healthcheck.py there', 'scripts/worker_healthcheck.py'],
        ['POST /sync/file-push works', '/sync/file-push'],
        ['worker 527b9983 wedged', '527b9983'],
        ['limit is 50MB or 50 MB', '50MB'],
        ['limit is 50MB or 50 MB', '50 MB'],
      ];
      for (const [text, want] of cases) {
        expect([text, extractSpecifics(text)]).toEqual([text, expect.arrayContaining([want])]);
      }
    });

    it('negatives: dates, encodings, priorities, hex-looking words, decimals and plain prose yield nothing', () => {
      const prose =
        'On 2026-09-01 the UTF-8 file was ISO-8601 dated; P0-Critical and SHA-256 aside, effaced text, ' +
        'confidence 0.85 over 3.2 seconds on Android 13+, e.g. this sentence, i.e. plain words only.';
      expect(extractSpecifics(prose)).toEqual([]);
    });

    it('T7b carry: only the line whose specific the synthesis dropped is carried; repeats dedupe; a fence is one unit', () => {
      const src = [
        'Use `igris_file_push` for small files.',
        'Above the threshold shell out to `/sync/file-push`.',
        'Above the threshold shell out to `/sync/file-push`.',
        '```bash',
        'curl -sS -X POST "$URL/sync/file-push"',
        '```',
        'Nothing specific here.',
      ].join('\n');
      const synthesis = 'Small files go through igris_file_push; big ones bypass it.';
      const r = carryForward([{ id: 7, label: 'superseded', text: src }], synthesis);
      expect(r.carried).toBe(2); // the /sync/file-push line once + the fenced block
      expect(r.text.startsWith(synthesis)).toBe(true);
      expect(count(r.text, 'Above the threshold')).toBe(1);
      expect(r.text).toContain('```bash\ncurl -sS -X POST "$URL/sync/file-push"\n```');
      expect(r.text).not.toContain('Nothing specific here.');
      expect(r.text).not.toContain('Use `igris_file_push`');
      expect(count(r.text, PRESERVED_MARKER)).toBe(1);
      expect(r.text).toContain(`${PRESERVED_MARKER}7 (superseded; TD-439):`);
      // Nothing to carry → the synthesis alone, no section.
      const none = carryForward([{ id: 7, label: 'superseded', text: 'plain prose' }], synthesis);
      expect(none).toEqual({ text: synthesis, carried: 0, chars: 0 });
      // A specific already present in the synthesis (backticks stripped) is not a reason to carry.
      const present = carryForward([{ id: 7, label: 's', text: 'Use `igris_file_push` here.' }], synthesis);
      expect(present.carried).toBe(0);
    });
  });
});
