/**
 * Brain Engine v7.1 — Curator validator (FR-116 M3).
 *
 * The parse + validation slot (`parseResponse`) of the curator cognition
 * instance. Turns the raw LLM response text into typed `PruneProposal[]`,
 * enforcing:
 *
 *   1. CITE-CHECK (the hallucination guard): every proposal's `learning_id` MUST
 *      be one of the candidate ids supplied in the context. A proposal citing an
 *      id not in the candidate set is REJECTED (dropped).
 *
 *   2. VERDICT ALLOW-LIST: `verdict` MUST be one of `keep`/`lower_confidence`/
 *      `prune`. Any other value is dropped (no action).
 *
 *   3. LOWER_CONFIDENCE DELTA: `lower_confidence` REQUIRES a `confidence_delta`
 *      in (0, 1]; a missing/zero/out-of-range delta drops the proposal (there is
 *      nothing to lower). The delta is clamped to (0, 1].
 *
 *   4. CONFIDENCE CAP [0, 0.85]: out-of-range confidences are clamped.
 *
 * REJECT-MALFORMED-CLEANLY: a response that is not a JSON array (or whose
 * elements are all unusable) yields `[]`. The engine maps an empty parse of a
 * NON-empty response to `run_failed reason=parse_error` and persists nothing.
 * The function NEVER throws (the `CognitionInstance.parseResponse` contract).
 *
 * @module engine/components/curator/validator
 * @author fifty.dev
 */

import type { PruneProposal, PruneVerdict, StaleCandidate } from './types.js';

/** The hard confidence ceiling — values above are clamped to it. */
export const CURATOR_CONFIDENCE_CAP = 0.85;

/** Max chars of a justification retained (schema-safe). */
const MAX_JUSTIFICATION = 500;

/** The actionable verdicts (all three are actionable — `keep` marks reviewed). */
const ACTIONABLE_VERDICTS = new Set<PruneVerdict>(['keep', 'lower_confidence', 'prune']);

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
  candidateIds: Set<number>,
): PruneProposal | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const learningId = Number(obj.learning_id);
  if (!Number.isInteger(learningId) || learningId <= 0) return null;

  // CITE-CHECK — the id must be a supplied candidate.
  if (!candidateIds.has(learningId)) return null;

  // VERDICT ALLOW-LIST.
  const verdict =
    typeof obj.verdict === 'string'
      ? (obj.verdict.trim() as PruneVerdict)
      : ('' as PruneVerdict);
  if (!ACTIONABLE_VERDICTS.has(verdict)) return null;

  // CONFIDENCE CAP.
  let confidence =
    typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
      ? obj.confidence
      : 0.5;
  if (confidence < 0) confidence = 0;
  if (confidence > CURATOR_CONFIDENCE_CAP) confidence = CURATOR_CONFIDENCE_CAP;

  const justification =
    typeof obj.justification === 'string'
      ? obj.justification.trim().slice(0, MAX_JUSTIFICATION)
      : '';

  if (verdict === 'lower_confidence') {
    let delta =
      typeof obj.confidence_delta === 'number' && Number.isFinite(obj.confidence_delta)
        ? obj.confidence_delta
        : 0;
    if (delta <= 0) return null; // nothing to lower — drop
    if (delta > 1) delta = 1;
    return { learning_id: learningId, verdict, confidence_delta: delta, justification, confidence };
  }

  return { learning_id: learningId, verdict, justification, confidence };
}

/**
 * Parse + validate the raw LLM response against the candidate learnings. Returns
 * the valid prune proposals (hallucinated ids dropped, invalid verdicts dropped,
 * lower_confidence-without-delta dropped, confidences capped). Returns `[]` when
 * the response is not a JSON array. Never throws (the parseResponse contract).
 *
 * @param raw        the raw LLM response text
 * @param candidates the candidate learnings the response was generated from (cite whitelist)
 */
export function validateCuratorResponse(
  raw: string,
  candidates: StaleCandidate[],
): PruneProposal[] {
  const arr = parseJsonArray(raw);
  if (arr === null) return [];
  const candidateIds = new Set<number>();
  for (const c of candidates) candidateIds.add(c.id);
  const out: PruneProposal[] = [];
  for (const el of arr) {
    const proposal = validateOne(el, candidateIds);
    if (proposal) out.push(proposal);
  }
  return out;
}
