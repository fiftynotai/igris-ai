/**
 * Brain Engine v7.1 — Subconscious FINDING KEY (TD-440).
 *
 * The single owner of "are these two suggestions the same finding?". Built from
 * identifiers the validator has already cross-checked against the digest, never
 * from LLM-authored free text: `source_module`, `title` casing and
 * `evidence.note` are all re-authored every run — TD-437's audit denominator,
 * 2026-09-01: 195 distinct labels over 358 rows, 147 of them used exactly once
 * — so any key derived from them cannot match. That figure is a SNAPSHOT of a
 * moving population and the query that re-derives it is in
 * `docs/architecture/subconscious_engine.md`; do not read it as a constant.
 *
 * Two stages, deliberately: {@link entityKey} BLOCKS (which findings could be
 * the same) and {@link claimsMatch} DISCRIMINATES (whether they are). An
 * entity-only key would merge `BR-128 carries a malformed status string` with
 * `BR-128 has been In Progress 189 days` — both true, both about the same
 * brief, different findings. Over-merge destroys signal and is worse than the
 * repetition it fixes.
 *
 * EVERY PARAMETER HERE WAS MEASURED, not chosen. The corpus, the rejected
 * alternatives (Szymkiewicz–Simpson overlap, the full-identifier-set blocking
 * key, cosine) and the threshold sweep are in
 * `docs/architecture/subconscious_engine.md` §Finding key; the machine-checkable
 * half is `__tests__/finding-key.test.ts`'s labelled boundary corpus, which reds
 * if any of them is moved.
 *
 * @module engine/components/subconscious/finding-key
 * @author fifty.dev
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { normalizeForDedup } from '../perception/dedup.js';
import type { SuggestionCandidate } from './types.js';

/** Tokens shorter than this are dropped from a claim (articles, prepositions). */
const MIN_TOKEN_CHARS = 3;

/** Entity key for a candidate that cites no identifier at all. */
export const GLOBAL_ENTITY_KEY = 'global';

/**
 * Identifier shapes a TITLE can name (`BR-128`, `TD-005`, `AC-001`, `FR-54`).
 * Deliberately narrow: 2-6 letters, a hyphen, 1-6 digits.
 */
const SUBJECT_ID_RE = /\b([A-Za-z]{2,6})-(\d{1,6})\b/g;

/**
 * Id-shaped `suggested_action` params, in the precedence the anchor uses.
 * Derived by counting the params `actions/kinds.ts` actually READS from an
 * inbound suggestion (`from_id`/`to_id` are OUTPUT arguments it passes to
 * `handleEdgeCreate`, never inbound, so they are not here).
 */
const ACTION_ID_PARAMS: Array<[string, string]> = [
  ['brief_id', 'brief'],
  ['learning_id', 'learning'],
  ['target_learning_id', 'learning'],
  ['survivor_id', 'learning'],
  ['duplicate_id', 'learning'],
  ['winner_id', 'learning'],
  ['loser_id', 'learning'],
  ['learning_a_id', 'learning'],
  ['learning_b_id', 'learning'],
  ['suggestion_id', 'suggestion'],
];

function idPart(prefix: string, raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const value = String(raw).trim().toLowerCase();
  return value.length === 0 ? null : `${prefix}:${value}`;
}

function firstIdPart(prefix: string, ...raw: unknown[]): string | null {
  for (const r of raw) {
    if (Array.isArray(r)) {
      for (const item of r) {
        const part = idPart(prefix, item);
        if (part) return part;
      }
      continue;
    }
    const part = idPart(prefix, r);
    if (part) return part;
  }
  return null;
}

/**
 * The BLOCKING key — ONE anchor per candidate, by a stated precedence:
 * the project, else the primary cited brief, else the primary cited learning,
 * else the cited suggestion, else {@link GLOBAL_ENTITY_KEY}.
 *
 * WHY ONE ANCHOR AND NOT THE WHOLE IDENTIFIER SET. Measured on the 38 real
 * `fifty_eco_system`-is-abandoned rows: `project_slug` is constant across all
 * of them, while `evidence.brief_id` takes FIVE distinct values plus null —
 * the model attaches an ILLUSTRATIVE brief to a project-level finding and
 * varies which one. A key built from the whole set therefore splits one
 * finding across five blocks and can never match it (73 corpus rows collapse
 * to 37 under the set, to 10 under the anchor). The project is the stable
 * anchor; the ids the model picked as examples are not.
 *
 * An anchor is not paraphrasable: `fifty_eco_system` is `fifty_eco_system`
 * under `abandoned_project`, `portfolio_abandonment` or `stalled_epidemic`.
 */
export function entityKey(candidate: SuggestionCandidate): string {
  const evidence = candidate.evidence ?? {};
  const action =
    candidate.suggested_action &&
    typeof candidate.suggested_action === 'object' &&
    !Array.isArray(candidate.suggested_action)
      ? candidate.suggested_action
      : {};

  const slug =
    candidate.project_slug ??
    (typeof evidence.project_slug === 'string' ? evidence.project_slug : null);

  const actionOf = (param: string): unknown => action[param];
  const byPrefix = (prefix: string): unknown[] =>
    ACTION_ID_PARAMS.filter(([, p]) => p === prefix).map(([param]) => actionOf(param));

  return (
    idPart('project', slug) ??
    firstIdPart('brief', evidence.brief_id, evidence.brief_ids, ...byPrefix('brief')) ??
    firstIdPart(
      'learning',
      evidence.learning_id,
      evidence.learning_ids,
      ...byPrefix('learning'),
      action.cluster_member_ids,
    ) ??
    firstIdPart('suggestion', evidence.suggestion_id, ...byPrefix('suggestion')) ??
    GLOBAL_ENTITY_KEY
  );
}

/**
 * The identifiers the TITLE names — the claim's SUBJECT, as distinct from the
 * supporting ids in `evidence`.
 *
 * This exists because `normalizeForDedup` destroys them: `BR-128` becomes
 * `br 128`, `br` is two characters (dropped) and `128` is pure-numeric
 * (dropped), so a cited brief is INVISIBLE to {@link claimTokens}. Measured
 * consequence without this set: `BR-128 is the only P0-Critical brief …` and
 * `BR-023 is the only P0-Critical brief …` score Jaccard **1.000** — a
 * guaranteed false merge of two different briefs' findings.
 */
export function subjectIds(title: string): Set<string> {
  const out = new Set<string>();
  for (const m of String(title ?? '').matchAll(SUBJECT_ID_RE)) {
    out.add(`${m[1].toLowerCase()}-${m[2]}`);
  }
  return out;
}

/**
 * The claim's content tokens. `normalizeForDedup` is imported from the
 * perception channel rather than re-implemented — L-138's fix is the source of
 * truth for text normalisation and it is tuned against a 201-pair labelled
 * corpus. Pure-numeric tokens are dropped: day counts and row counts move
 * between re-emissions of one finding ("189 days" → "190 days").
 *
 * Stop-word removal was measured and REJECTED: over the 113-row labelled
 * corpus it changed neither the collapse nor the false-merge count, so it is
 * vocabulary this module does not need to own.
 */
export function claimTokens(title: string): Set<string> {
  const out = new Set<string>();
  for (const token of normalizeForDedup(title ?? '').split(' ')) {
    if (token.length < MIN_TOKEN_CHARS) continue;
    if (/^\d+$/.test(token)) continue;
    out.add(token);
  }
  return out;
}

/**
 * Jaccard similarity, `|A ∩ B| / |A ∪ B|`.
 *
 * Chosen over the Szymkiewicz–Simpson overlap coefficient by MEASUREMENT, and
 * the measurement inverted the expectation. Overlap divides by `min(|A|,|B|)`,
 * so it is length-robust — but on the real corpus it is length-robust in the
 * wrong direction: it scored a 4-token title 0.750 against a 16-token one and
 * produced false merges on BOTH labelled projects at every threshold with
 * usable recall. Jaccard produced ZERO false merges on 2,628 + 780 adversarial
 * same-entity pairs at the shipped threshold. Since a false merge destroys a
 * true finding (TD-437 measured ~23 of ~25 distinct findings as actionable) and
 * a missed merge only leaves the row count where it already was, precision is
 * the axis that matters.
 *
 * Returns 0 when either side is empty — an empty claim discriminates nothing
 * and must never score 1.0 against everything.
 */
export function claimSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) if (large.has(token)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** One side of a {@link claimsMatch} comparison. */
export interface Claim {
  /** {@link claimTokens} of the title. */
  tokens: Set<string>;
  /** {@link subjectIds} of the title. */
  subject: Set<string>;
}

/** Build a {@link Claim} from a title. */
export function claimOf(title: string): Claim {
  return { tokens: claimTokens(title), subject: subjectIds(title) };
}

/**
 * Decide whether two claims are the same finding. Three gates, in order:
 *
 *  1. **SUBJECT GATE** — if both titles name identifiers and the two sets are
 *     DISJOINT, they are about different things and never match, whatever the
 *     prose similarity. One empty set is not disjoint: a project-level finding
 *     that names no brief still absorbs a re-emission that names an example.
 *  2. **SHORT-CLAIM GUARD** — below `minTokens` the similarity score is not
 *     used at all and the two token sets must be EQUAL. A three-word claim has
 *     no room to be similar-but-different.
 *  3. **SIMILARITY** — {@link claimSimilarity} at or above `threshold`.
 *
 * `threshold > 1` disables the paraphrase stage entirely (the kill switch),
 * mirroring perception's `dedup_enabled`.
 */
export function claimsMatch(
  a: Claim,
  b: Claim,
  threshold: number,
  minTokens: number,
): boolean {
  if (threshold > 1) return false;
  if (a.subject.size > 0 && b.subject.size > 0) {
    let shares = false;
    for (const id of a.subject) {
      if (b.subject.has(id)) {
        shares = true;
        break;
      }
    }
    if (!shares) return false;
  }
  if (Math.min(a.tokens.size, b.tokens.size) < minTokens) {
    if (a.tokens.size !== b.tokens.size) return false;
    for (const token of a.tokens) if (!b.tokens.has(token)) return false;
    return true;
  }
  return claimSimilarity(a.tokens, b.tokens) >= threshold;
}

/**
 * The STORED exact key: `sha1(entityKey + ' ' + subject ids + ' ' + claim
 * tokens)`, hex. Persisted to `suggestions.dedupe_key` and used verbatim as
 * `dismissed_patterns.evidence_signature`, so a dismissal and a re-emission of
 * the same finding land on one key.
 *
 * The subject ids are hashed in even though `claimTokens` cannot see them: two
 * titles that differ ONLY in which brief they name have identical claim tokens,
 * and without this the exact-key stage would merge them behind the subject
 * gate's back.
 *
 * WHY `sha1`, when this is the only one under `brain-mcp-server/src` and every
 * other content hash there is `sha256`. `git grep -n "createHash('sha256')" --
 * brain-mcp-server/src` returns eight — `tools/sync.ts` x3, `tools/briefs.ts`
 * x2, `tools/sessions.ts`, `context/index.ts`, and one migration test — and all
 * seven shipped ones hash CONTENT whose equality decides what replicates. This
 * one is a content-addressed IDENTITY for dedup instead: it authenticates
 * nothing, signs nothing and gates no privilege. The worst a collision can do
 * is merge two findings into one row — bounded, and legible afterwards because
 * `recurrence_titles` keeps the absorbed titles (the newest
 * `RECURRENCE_TITLE_CAP` of them, in `cognition/extractors/subconscious.ts`) —
 * or, where the key replicates as an `evidence_signature` on
 * `dismissed_patterns`, suppress one re-emission. Forcing one would mean
 * steering the model's own title tokens, a strictly harder problem than the
 * suppression it buys. Widening the digest later is a `dedupe_key` backfill,
 * not a security fix.
 */
export function findingKey(candidate: SuggestionCandidate): string {
  const claim = claimOf(candidate.title);
  const subject = [...claim.subject].sort().join(',');
  const tokens = [...claim.tokens].sort().join(' ');
  return createHash('sha1')
    .update(`${entityKey(candidate)} ${subject} ${tokens}`)
    .digest('hex');
}

/** One row `backfillFindingKeys` has to key. */
interface BackfillRow {
  id: number;
  project_slug: string | null;
  title: string;
  evidence: string | null;
  suggested_action: string | null;
}

/** Parse a stored JSON column into an object, degrading to `{}`. */
export function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* malformed JSON keys as an empty object rather than throwing */
  }
  return {};
}

/**
 * Rebuild the `SuggestionCandidate` shape the key functions read from a stored
 * row. `source_module`, `priority` and `confidence` are deliberately absent
 * from the key, so the placeholders here cannot change its value.
 */
export function candidateFromRow(row: {
  project_slug: string | null;
  title: string;
  evidence: string | null;
  suggested_action: string | null;
}): SuggestionCandidate {
  const action = parseJsonObject(row.suggested_action);
  return {
    source_module: '',
    project_slug: row.project_slug,
    title: row.title ?? '',
    evidence: parseJsonObject(row.evidence),
    priority: 'medium',
    ...(row.suggested_action ? { suggested_action: action } : {}),
  };
}

/**
 * Populate `dedupe_key` / `entity_key` on every row that has neither. The key
 * needs JS (normalisation + hashing), so v5 cannot backfill in SQL.
 *
 * Bounded (only NULL-key rows), idempotent (a keyed row is never revisited) and
 * fail-soft on a pre-v5 schema. Called once per run from `runSubconscious`, a
 * write path — never from `buildContext`, which is a read slot.
 *
 * @returns how many rows were keyed.
 */
export function backfillFindingKeys(db: Database.Database): number {
  let rows: BackfillRow[];
  try {
    rows = db
      .prepare(
        `SELECT id, project_slug, title, evidence, suggested_action
           FROM suggestions WHERE dedupe_key IS NULL`,
      )
      .all() as BackfillRow[];
  } catch {
    return 0; /* pre-v5 schema — the migration keys them on its next boot */
  }

  const update = db.prepare(
    'UPDATE suggestions SET dedupe_key = ?, entity_key = ? WHERE id = ?',
  );
  let keyed = 0;
  for (const row of rows) {
    const candidate = candidateFromRow(row);
    update.run(findingKey(candidate), entityKey(candidate), row.id);
    keyed += 1;
  }
  return keyed;
}
