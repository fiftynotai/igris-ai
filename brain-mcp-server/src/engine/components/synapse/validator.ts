/**
 * Brain Engine v7.1 — Synapse validator (FR-211).
 *
 * The parse + validation slot (`parseResponse`) of the synapse cognition
 * instance. Turns the raw LLM response text into typed `EdgeProposal[]`,
 * enforcing three hard rules:
 *
 *   1. CITE-CHECK (the hallucination guard): every proposal's `{from_id, to_id}`
 *      UNORDERED pair MUST be one of the candidate pairs supplied in the context.
 *      A proposal whose id pair is not a candidate is REJECTED (dropped) — the
 *      model cannot invent pairs or cross-wire ids from different pairs. The
 *      LLM's stated from→to ORDER is preserved (it carries the direction of a
 *      `supersedes`/`derived_from` edge).
 *
 *   2. EDGE-TYPE ALLOW-LIST: `edge_type` MUST be one of `SYNAPSE_EDGE_TYPES`
 *      (supersedes / derived_from / duplicates / related_to). Any other value —
 *      including the literal "none" verdict — is dropped.
 *
 *   3. CONFIDENCE CAP [0, 0.85]: out-of-range confidences are clamped.
 *
 * REJECT-MALFORMED-CLEANLY: a response that is not a JSON array (or whose
 * elements are all unusable) yields `[]`. The engine disambiguates a zero parse
 * via the instance's `isMalformedResponse` hook (TD-294, backed by
 * `isSynapseResponseWellFormed` below): a MALFORMED / non-array response →
 * `run_failed reason=parse_error`; a WELL-FORMED (possibly empty) array whose
 * elements were all dropped → a SUCCESSFUL run with zero candidates. The function
 * NEVER throws (the `CognitionInstance.parseResponse` contract).
 *
 * @module engine/components/synapse/validator
 * @author fifty.dev
 */

import {
  SYNAPSE_EDGE_TYPES,
  type CandidatePair,
  type EdgeProposal,
  type SynapseEdgeType,
} from './types.js';

/** The hard confidence ceiling — values above are clamped to it. */
export const SYNAPSE_CONFIDENCE_CAP = 0.85;

/** Max chars of a justification retained (schema-safe). */
const MAX_JUSTIFICATION = 500;

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
 * lenient parse `validateSynapseResponse` used, so the verdict matches what was
 * accepted. true → valid (possibly empty); false → malformed (→ parse_error).
 */
export function isSynapseResponseWellFormed(raw: string): boolean {
  return parseJsonArray(raw) !== null;
}

/** Coerce + validate ONE raw element into a proposal, or null if unusable. */
function validateOne(
  raw: unknown,
  allowedPairs: Set<string>,
  edgeTypes: Set<string>,
): EdgeProposal | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const fromId = Number(obj.from_id);
  const toId = Number(obj.to_id);
  if (!Number.isInteger(fromId) || !Number.isInteger(toId)) return null;
  if (fromId === toId) return null;

  // EDGE-TYPE ALLOW-LIST — drops "none" and any invalid type.
  const edgeType = typeof obj.edge_type === 'string' ? obj.edge_type.trim() : '';
  if (!edgeTypes.has(edgeType)) return null;

  // CITE-CHECK — the unordered pair must be a supplied candidate.
  if (!allowedPairs.has(sortedKey(fromId, toId))) return null;

  // CONFIDENCE CAP.
  let confidence =
    typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
      ? obj.confidence
      : 0.5;
  if (confidence < 0) confidence = 0;
  if (confidence > SYNAPSE_CONFIDENCE_CAP) confidence = SYNAPSE_CONFIDENCE_CAP;

  const justification =
    typeof obj.justification === 'string'
      ? obj.justification.trim().slice(0, MAX_JUSTIFICATION)
      : '';

  return {
    from_id: fromId,
    to_id: toId,
    edge_type: edgeType as SynapseEdgeType,
    confidence,
    justification,
  };
}

/**
 * Parse + validate the raw LLM response against the candidate pairs. Returns the
 * valid proposals (hallucinated/cross-wired pairs dropped, invalid edge types
 * dropped, confidences capped). Returns `[]` when the response is not a JSON
 * array OR is a well-formed array whose elements were all dropped — the engine
 * tells these apart via `isSynapseResponseWellFormed` (malformed → parse_error;
 * well-formed empty → success with zero candidates, TD-294). Never throws (the
 * parseResponse contract).
 *
 * @param raw   the raw LLM response text
 * @param pairs the candidate pairs the response was generated from (cite whitelist)
 */
export function validateSynapseResponse(
  raw: string,
  pairs: CandidatePair[],
): EdgeProposal[] {
  const arr = parseJsonArray(raw);
  if (arr === null) return [];
  const allowedPairs = new Set(pairs.map((p) => sortedKey(p.from_id, p.to_id)));
  const edgeTypes = new Set<string>(SYNAPSE_EDGE_TYPES);
  const out: EdgeProposal[] = [];
  for (const el of arr) {
    const proposal = validateOne(el, allowedPairs, edgeTypes);
    if (proposal) out.push(proposal);
  }
  return out;
}
