/**
 * Brain Engine v7.1 — Subconscious validator (FR-118 M2).
 *
 * The parse + validation slot (`parseResponse`) of the subconscious cognition
 * instance. Turns the raw LLM response text into typed `SuggestionCandidate[]`,
 * enforcing three hard rules:
 *
 *   1. CITATION CROSS-CHECK (the hallucination guard, R-HALLUCINATED-EVIDENCE):
 *      every `evidence.brief_id` / `evidence.learning_id` a suggestion cites
 *      MUST be present in the digest. A suggestion citing an id not in the
 *      digest is REJECTED (dropped) — the model cannot invent briefs/learnings.
 *
 *   2. CONFIDENCE CAP [0, 0.85]: out-of-range confidences are clamped. The 0.85
 *      ceiling encodes "this is inference from a digest, not verification".
 *
 *   3. REJECT-MALFORMED-CLEANLY: a response that is not a JSON array (or whose
 *      elements are all unusable) yields `[]`. The engine disambiguates a zero
 *      parse via the instance's `isMalformedResponse` hook (TD-294, backed by
 *      `isSubconsciousResponseWellFormed` below): a MALFORMED / non-array
 *      response → `run_failed reason=parse_error`; a WELL-FORMED (possibly empty)
 *      array whose elements were all dropped → a SUCCESSFUL run with zero
 *      candidates. There is NO partial-parse rescue: a half-broken object is
 *      dropped, not patched.
 *
 * The function NEVER throws (the `CognitionInstance.parseResponse` contract).
 *
 * @module engine/components/subconscious/validator
 * @author fifty.dev
 */

import type { BrainDigest } from './digest.js';
import type {
  SuggestionCandidate,
  SuggestionPriority,
} from './types.js';

/** The hard confidence ceiling — values above are clamped to it. */
export const SUBCONSCIOUS_CONFIDENCE_CAP = 0.85;

/** Valid priority buckets (anything else coerces to 'medium'). */
const VALID_PRIORITIES: ReadonlySet<string> = new Set(['high', 'medium', 'low']);

/** Cap a suggestion title to a schema-safe length. */
const MAX_TITLE_BYTES = 500;

// ---------------------------------------------------------------------------
// Citation index — what the digest actually contains
// ---------------------------------------------------------------------------

/** The set of brief_ids + learning_ids present in a digest (the citation whitelist). */
export interface DigestCitationIndex {
  briefIds: Set<string>;
  learningIds: Set<number>;
}

/**
 * Build the citation whitelist from a digest: every brief_id and learning_id
 * the model is ALLOWED to cite. Includes ids appearing anywhere in the digest
 * — open briefs, recent learnings, and the open_suggestions/projects sections
 * (so a suggestion may reference an already-queued item's brief without being
 * flagged as a hallucination).
 */
export function buildCitationIndex(digest: BrainDigest): DigestCitationIndex {
  const briefIds = new Set<string>();
  const learningIds = new Set<number>();
  for (const b of digest.open_briefs) {
    if (typeof b.brief_id === 'string' && b.brief_id.length > 0) briefIds.add(b.brief_id);
  }
  for (const l of digest.recent_learnings) {
    if (typeof l.id === 'number') learningIds.add(l.id);
  }
  // open_suggestions reference briefs/learnings indirectly via title only; we do
  // not add their ids (those are suggestion ids, not brief/learning ids).
  return { briefIds, learningIds };
}

// ---------------------------------------------------------------------------
// Parse + validate
// ---------------------------------------------------------------------------

/** Try to parse the raw text into a JSON array. Returns null on anything else. */
function parseJsonArray(raw: string): unknown[] | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Direct array.
  try {
    const parsed = JSON.parse(trimmed);
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
      const parsed = JSON.parse(stripped);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through */
    }
  }

  // No partial-parse rescue beyond fence-stripping — anything else is malformed.
  return null;
}

/**
 * TD-294 — was the raw a well-formed JSON array (possibly empty)? Reuses the SAME
 * lenient parse `validateSubconsciousResponse` used, so the verdict matches what
 * was accepted. true → valid (possibly empty); false → malformed (→ parse_error).
 */
export function isSubconsciousResponseWellFormed(raw: string): boolean {
  return parseJsonArray(raw) !== null;
}

/** Coerce + validate ONE raw element into a candidate, or null if unusable. */
function validateOne(
  raw: unknown,
  index: DigestCitationIndex,
): SuggestionCandidate | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  // kind — the OPEN source_module. Required non-empty string.
  const kind = typeof obj.kind === 'string' ? obj.kind.trim() : '';
  if (kind.length === 0) return null;

  // title — required non-empty string.
  const titleRaw = typeof obj.title === 'string' ? obj.title.trim() : '';
  if (titleRaw.length === 0) return null;
  const title = titleRaw.slice(0, MAX_TITLE_BYTES);

  // priority — coerce to a valid bucket (default medium).
  const priority: SuggestionPriority = VALID_PRIORITIES.has(obj.priority as string)
    ? (obj.priority as SuggestionPriority)
    : 'medium';

  // project_slug — string or null.
  const projectSlug =
    typeof obj.project_slug === 'string' && obj.project_slug.length > 0
      ? obj.project_slug
      : null;

  // confidence — clamp to [0, cap]. A non-number defaults to the cap-respecting
  // mid value so a finding without an explicit confidence still surfaces.
  let confidence =
    typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
      ? obj.confidence
      : 0.5;
  if (confidence < 0) confidence = 0;
  if (confidence > SUBCONSCIOUS_CONFIDENCE_CAP) confidence = SUBCONSCIOUS_CONFIDENCE_CAP;

  // evidence — must be an object; cross-check any cited ids against the digest.
  const evidenceRaw =
    obj.evidence && typeof obj.evidence === 'object' && !Array.isArray(obj.evidence)
      ? (obj.evidence as Record<string, unknown>)
      : {};

  // CITATION CROSS-CHECK (the hallucination guard). If the suggestion cites a
  // brief_id or learning_id NOT in the digest, REJECT the whole suggestion.
  if (typeof evidenceRaw.brief_id === 'string' && evidenceRaw.brief_id.length > 0) {
    if (!index.briefIds.has(evidenceRaw.brief_id)) return null;
  }
  if (evidenceRaw.learning_id !== undefined && evidenceRaw.learning_id !== null) {
    const lid = Number(evidenceRaw.learning_id);
    if (!Number.isInteger(lid) || !index.learningIds.has(lid)) return null;
  }

  // suggested_action — optional structured object. Must carry a string `kind`
  // to be retained; otherwise dropped (advisory-only). M2 only records it.
  let suggestedAction: Record<string, unknown> | undefined;
  if (
    obj.suggested_action &&
    typeof obj.suggested_action === 'object' &&
    !Array.isArray(obj.suggested_action)
  ) {
    const action = obj.suggested_action as Record<string, unknown>;
    if (typeof action.kind === 'string' && action.kind.trim().length > 0) {
      suggestedAction = action;
    }
  }

  const candidate: SuggestionCandidate = {
    source_module: kind,
    project_slug: projectSlug,
    title,
    evidence: evidenceRaw,
    priority,
    confidence,
  };
  if (suggestedAction) candidate.suggested_action = suggestedAction;
  return candidate;
}

/**
 * Parse + validate the raw LLM response against the digest. Returns the valid
 * candidates (hallucinated citations dropped, confidences capped). Returns `[]`
 * when the response is not a JSON array OR is a well-formed array whose elements
 * were all dropped — the engine tells these apart via
 * `isSubconsciousResponseWellFormed` (malformed → parse_error; well-formed empty
 * → success with zero candidates, TD-294) and persists nothing in either case.
 *
 * Never throws (the parseResponse contract).
 *
 * @param raw    the raw LLM response text
 * @param digest the digest the response was generated from (the citation whitelist)
 */
export function validateSubconsciousResponse(
  raw: string,
  digest: BrainDigest,
): SuggestionCandidate[] {
  const arr = parseJsonArray(raw);
  if (arr === null) return [];
  const index = buildCitationIndex(digest);
  const out: SuggestionCandidate[] = [];
  for (const el of arr) {
    const candidate = validateOne(el, index);
    if (candidate) out.push(candidate);
  }
  return out;
}
