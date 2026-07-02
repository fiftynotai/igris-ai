/**
 * Brain Engine v7.1 — Arbiter validator (FR-116 M2).
 *
 * The parse + validation slot (`parseResponse`) of the arbiter contradiction
 * cognition instance. Turns the raw LLM response text into typed
 * `ContradictionProposal[]`, enforcing:
 *
 *   1. CITE-CHECK (the hallucination guard): every proposal's `{from_id, to_id}`
 *      UNORDERED pair MUST be one of the candidate pairs supplied in the context.
 *      A proposal whose id pair is not a candidate is REJECTED (dropped).
 *
 *   2. VERDICT ALLOW-LIST: `verdict` MUST be one of `newer_wins`/
 *      `both_valid_scope`/`evolved_merge`. `not_a_contradiction` (false positive)
 *      and any other value are dropped (no action).
 *
 *   3. WINNER/LOSER RESOLUTION: for `newer_wins`/`evolved_merge`, `winner_id` +
 *      `loser_id` MUST be exactly {from_id, to_id} (in some order). A mismatch is
 *      REJECTED. `evolved_merge` additionally REQUIRES a non-empty
 *      `synthesized_content`. For `both_valid_scope` the two learnings are the
 *      cited pair (a = from_id, b = to_id); a non-empty scope_a/scope_b is kept.
 *
 *   4. CONFIDENCE CAP [0, 0.85]: out-of-range confidences are clamped.
 *
 * REJECT-MALFORMED-CLEANLY: a response that is not a JSON array (or whose
 * elements are all unusable) yields `[]`. The engine maps an empty parse of a
 * NON-empty response to `run_failed reason=parse_error` and persists nothing.
 * The function NEVER throws (the `CognitionInstance.parseResponse` contract).
 *
 * @module engine/components/arbiter/validator
 * @author fifty.dev
 */

import type {
  ContradictionPair,
  ContradictionProposal,
  ContradictionVerdict,
} from './types.js';

/** The hard confidence ceiling — values above are clamped to it. */
export const ARBITER_CONFIDENCE_CAP = 0.85;

/** Max chars of a justification retained (schema-safe). */
const MAX_JUSTIFICATION = 500;

/** Max chars of a scope annotation retained (schema-safe). */
const MAX_SCOPE = 300;

/** Max chars of synthesized content retained (schema-safe). */
const MAX_SYNTHESIZED = 1_000_000;

/** The actionable verdicts — `not_a_contradiction` is intentionally excluded. */
const ACTIONABLE_VERDICTS = new Set<ContradictionVerdict>([
  'newer_wins',
  'both_valid_scope',
  'evolved_merge',
]);

/** Unordered pair key — matches the candidate generator's `${min}:${max}`. */
function sortedKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Try to parse the raw text into a JSON array. Returns null on anything else. */
function parseJsonArray(raw: string): unknown[] | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* fall through */
  }

  // Fenced ```json … ``` — strip a single leading/trailing fence and retry.
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  if (stripped !== trimmed) {
    try {
      const parsed: unknown = JSON.parse(stripped);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through */
    }
  }

  return null;
}

/** Coerce + validate ONE raw element into a proposal, or null if unusable. */
function validateOne(
  raw: unknown,
  pairIndex: Map<string, ContradictionPair>,
): ContradictionProposal | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const fromId = Number(obj.from_id);
  const toId = Number(obj.to_id);
  if (!Number.isInteger(fromId) || !Number.isInteger(toId)) return null;
  if (fromId === toId) return null;

  // CITE-CHECK — the unordered pair must be a supplied candidate.
  const pair = pairIndex.get(sortedKey(fromId, toId));
  if (!pair) return null;

  // VERDICT ALLOW-LIST — drops not_a_contradiction + any invalid verdict.
  const verdict =
    typeof obj.verdict === 'string'
      ? (obj.verdict.trim() as ContradictionVerdict)
      : ('' as ContradictionVerdict);
  if (!ACTIONABLE_VERDICTS.has(verdict)) return null;

  // CONFIDENCE CAP.
  let confidence =
    typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
      ? obj.confidence
      : 0.5;
  if (confidence < 0) confidence = 0;
  if (confidence > ARBITER_CONFIDENCE_CAP) confidence = ARBITER_CONFIDENCE_CAP;

  const justification =
    typeof obj.justification === 'string'
      ? obj.justification.trim().slice(0, MAX_JUSTIFICATION)
      : '';

  const base = {
    justification,
    confidence,
    cosine: pair.cosine,
  };

  if (verdict === 'both_valid_scope') {
    const scopeA =
      typeof obj.scope_a === 'string' ? obj.scope_a.trim().slice(0, MAX_SCOPE) : '';
    const scopeB =
      typeof obj.scope_b === 'string' ? obj.scope_b.trim().slice(0, MAX_SCOPE) : '';
    // Need at least one non-empty scope to be actionable (otherwise nothing to annotate).
    if (scopeA.length === 0 && scopeB.length === 0) return null;
    return {
      verdict,
      learning_a_id: fromId,
      learning_b_id: toId,
      ...(scopeA.length > 0 ? { scope_a: scopeA } : {}),
      ...(scopeB.length > 0 ? { scope_b: scopeB } : {}),
      ...base,
    };
  }

  // newer_wins / evolved_merge — winner_id + loser_id MUST be {from_id, to_id}.
  const winnerId = Number(obj.winner_id);
  const loserId = Number(obj.loser_id);
  const pairSet = new Set([fromId, toId]);
  if (!pairSet.has(winnerId) || !pairSet.has(loserId) || winnerId === loserId) {
    return null;
  }

  if (verdict === 'evolved_merge') {
    const synthesized =
      typeof obj.synthesized_content === 'string'
        ? obj.synthesized_content.trim().slice(0, MAX_SYNTHESIZED)
        : '';
    // evolved_merge without an evolved statement is meaningless → reject.
    if (synthesized.length === 0) return null;
    return {
      verdict,
      winner_id: winnerId,
      loser_id: loserId,
      synthesized_content: synthesized,
      ...base,
    };
  }

  // newer_wins (the only remaining actionable verdict after the guards above).
  return {
    verdict: 'newer_wins',
    winner_id: winnerId,
    loser_id: loserId,
    ...base,
  };
}

/**
 * Parse + validate the raw LLM response against the candidate pairs. Returns the
 * valid contradiction resolutions (hallucinated/cross-wired pairs dropped,
 * not_a_contradiction + invalid verdicts dropped, confidences capped). Returns
 * `[]` when the response is not a JSON array. Never throws (the parseResponse
 * contract).
 *
 * @param raw   the raw LLM response text
 * @param pairs the candidate pairs the response was generated from (cite whitelist)
 */
export function validateArbiterResponse(
  raw: string,
  pairs: ContradictionPair[],
): ContradictionProposal[] {
  const arr = parseJsonArray(raw);
  if (arr === null) return [];
  const pairIndex = new Map<string, ContradictionPair>();
  for (const p of pairs) pairIndex.set(sortedKey(p.from_id, p.to_id), p);
  const out: ContradictionProposal[] = [];
  for (const el of arr) {
    const proposal = validateOne(el, pairIndex);
    if (proposal) out.push(proposal);
  }
  return out;
}
