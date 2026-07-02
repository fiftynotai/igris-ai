/**
 * Brain Engine v7.1 — Janitor validator (FR-119).
 *
 * The parse + validation slot (`parseResponse`) of the janitor near-dupe
 * cognition instance. Turns the raw LLM response text into typed
 * `MergeProposal[]`, enforcing:
 *
 *   1. CITE-CHECK (the hallucination guard): every proposal's `{from_id, to_id}`
 *      UNORDERED pair MUST be one of the candidate pairs supplied in the context.
 *      A proposal whose id pair is not a candidate is REJECTED (dropped).
 *
 *   2. VERDICT ALLOW-LIST: `verdict` MUST be one of `merge`/`keep_a`/`keep_b`.
 *      `keep_both` (false positive) and any other value are dropped (no action).
 *
 *   3. SURVIVOR RESOLUTION: the survivor/duplicate are derived from the verdict —
 *      `keep_a` → survivor = from_id, `keep_b` → survivor = to_id, `merge` →
 *      survivor = the cited `survivor_id` (which MUST equal from_id or to_id).
 *      A `merge` with a survivor_id outside the pair is REJECTED.
 *
 *   4. CONFIDENCE CAP [0, 0.85]: out-of-range confidences are clamped.
 *
 * REJECT-MALFORMED-CLEANLY: a response that is not a JSON array (or whose
 * elements are all unusable) yields `[]`. The engine disambiguates a zero parse
 * via the instance's `isMalformedResponse` hook (TD-294, backed by
 * `isJanitorResponseWellFormed` below): a MALFORMED / non-array response →
 * `run_failed reason=parse_error`; a WELL-FORMED (possibly empty) array whose
 * elements were all dropped → a SUCCESSFUL run with zero candidates. The function
 * NEVER throws (the `CognitionInstance.parseResponse` contract).
 *
 * @module engine/components/janitor/validator
 * @author fifty.dev
 */

import type { DuplicatePair, MergeProposal, MergeVerdict } from './types.js';

/** The hard confidence ceiling — values above are clamped to it. */
export const JANITOR_CONFIDENCE_CAP = 0.85;

/** Max chars of a justification retained (schema-safe). */
const MAX_JUSTIFICATION = 500;

/** Max chars of synthesized content retained (schema-safe). */
const MAX_SYNTHESIZED = 1_000_000;

/** The actionable verdicts — `keep_both` is intentionally excluded (no proposal). */
const ACTIONABLE_VERDICTS = new Set<MergeVerdict>(['merge', 'keep_a', 'keep_b']);

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

/**
 * TD-294 — was the raw a well-formed JSON array (possibly empty)? Reuses the SAME
 * lenient parse `validateJanitorResponse` used, so the verdict matches what was
 * accepted. true → valid (possibly empty); false → malformed (→ parse_error).
 */
export function isJanitorResponseWellFormed(raw: string): boolean {
  return parseJsonArray(raw) !== null;
}

/** Coerce + validate ONE raw element into a proposal, or null if unusable. */
function validateOne(
  raw: unknown,
  pairIndex: Map<string, DuplicatePair>,
): MergeProposal | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const fromId = Number(obj.from_id);
  const toId = Number(obj.to_id);
  if (!Number.isInteger(fromId) || !Number.isInteger(toId)) return null;
  if (fromId === toId) return null;

  // CITE-CHECK — the unordered pair must be a supplied candidate.
  const pair = pairIndex.get(sortedKey(fromId, toId));
  if (!pair) return null;

  // VERDICT ALLOW-LIST — drops keep_both + any invalid verdict.
  const verdict = typeof obj.verdict === 'string' ? (obj.verdict.trim() as MergeVerdict) : ('' as MergeVerdict);
  if (!ACTIONABLE_VERDICTS.has(verdict)) return null;

  // SURVIVOR RESOLUTION.
  let survivorId: number;
  let duplicateId: number;
  if (verdict === 'keep_a') {
    survivorId = fromId;
    duplicateId = toId;
  } else if (verdict === 'keep_b') {
    survivorId = toId;
    duplicateId = fromId;
  } else {
    // merge — survivor_id MUST be one of the pair.
    const cited = Number(obj.survivor_id);
    if (cited !== fromId && cited !== toId) return null;
    survivorId = cited;
    duplicateId = cited === fromId ? toId : fromId;
  }

  // CONFIDENCE CAP.
  let confidence =
    typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
      ? obj.confidence
      : 0.5;
  if (confidence < 0) confidence = 0;
  if (confidence > JANITOR_CONFIDENCE_CAP) confidence = JANITOR_CONFIDENCE_CAP;

  const justification =
    typeof obj.justification === 'string'
      ? obj.justification.trim().slice(0, MAX_JUSTIFICATION)
      : '';

  const proposal: MergeProposal = {
    survivor_id: survivorId,
    duplicate_id: duplicateId,
    verdict,
    justification,
    confidence,
    cosine: pair.cosine,
  };

  if (verdict === 'merge') {
    const synthesized =
      typeof obj.synthesized_content === 'string'
        ? obj.synthesized_content.trim().slice(0, MAX_SYNTHESIZED)
        : '';
    if (synthesized.length > 0) proposal.synthesized_content = synthesized;
  }

  return proposal;
}

/**
 * Parse + validate the raw LLM response against the candidate pairs. Returns the
 * valid merge proposals (hallucinated/cross-wired pairs dropped, keep_both +
 * invalid verdicts dropped, confidences capped). Returns `[]` when the response
 * is not a JSON array OR is a well-formed array whose elements were all dropped —
 * the engine tells these apart via `isJanitorResponseWellFormed` (malformed →
 * parse_error; well-formed empty → success with zero candidates, TD-294). Never
 * throws (the parseResponse contract).
 *
 * @param raw   the raw LLM response text
 * @param pairs the candidate pairs the response was generated from (cite whitelist)
 */
export function validateJanitorResponse(
  raw: string,
  pairs: DuplicatePair[],
): MergeProposal[] {
  const arr = parseJsonArray(raw);
  if (arr === null) return [];
  const pairIndex = new Map<string, DuplicatePair>();
  for (const p of pairs) pairIndex.set(sortedKey(p.from_id, p.to_id), p);
  const out: MergeProposal[] = [];
  for (const el of arr) {
    const proposal = validateOne(el, pairIndex);
    if (proposal) out.push(proposal);
  }
  return out;
}
