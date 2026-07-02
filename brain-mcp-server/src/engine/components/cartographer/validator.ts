/**
 * Brain Engine v7.1 — Cartographer validator (FR-116 M4).
 *
 * The parse + validation slot (`parseResponse`) of the cartographer cognition
 * instance. Turns the raw LLM response text into typed `ClusterMetaProposal[]`,
 * enforcing:
 *
 *   1. CITE-CHECK (the hallucination guard): every proposal's `cluster_index` MUST
 *      be the index of one of the clusters supplied in the context. A proposal
 *      citing an out-of-range index is REJECTED (dropped). The proposal's
 *      `cluster_member_ids` are resolved from the CITED cluster — never from the
 *      model — so the apply-action always wires the real members.
 *
 *   2. NON-EMPTY SUMMARY + TITLE: a proposal with a blank `summary` is dropped
 *      (there is nothing to store); a blank `title` falls back to a generated one.
 *
 *   3. CONFIDENCE CAP [0, 0.85]: out-of-range confidences are clamped.
 *
 * REJECT-MALFORMED-CLEANLY: a response that is not a JSON array (or whose elements
 * are all unusable) yields `[]`. The engine disambiguates a zero parse via the
 * instance's `isMalformedResponse` hook (TD-294, backed by
 * `isCartographerResponseWellFormed` below): a MALFORMED / non-array response →
 * `run_failed reason=parse_error`; a WELL-FORMED (possibly empty) array whose
 * elements were all dropped → a SUCCESSFUL run with zero candidates. Never throws
 * (the `CognitionInstance.parseResponse` contract).
 *
 * @module engine/components/cartographer/validator
 * @author fifty.dev
 */

import type { ClusterMetaProposal, LearningCluster } from './types.js';

/** The hard confidence ceiling — values above are clamped to it. */
export const CARTOGRAPHER_CONFIDENCE_CAP = 0.85;

/** Max chars of a title / summary retained (schema-safe). */
const MAX_TITLE = 200;
const MAX_SUMMARY = 4000;

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
 * lenient parse `validateCartographerResponse` used, so the verdict matches what
 * was accepted. true → valid (possibly empty); false → malformed (→ parse_error).
 */
export function isCartographerResponseWellFormed(raw: string): boolean {
  return parseJsonArray(raw) !== null;
}

/** Coerce + validate ONE raw element into a proposal, or null if unusable. */
function validateOne(
  raw: unknown,
  clustersByIndex: Map<number, LearningCluster>,
): ClusterMetaProposal | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const clusterIndex = Number(obj.cluster_index);
  if (!Number.isInteger(clusterIndex) || clusterIndex < 0) return null;

  // CITE-CHECK — the index must be a supplied cluster.
  const cluster = clustersByIndex.get(clusterIndex);
  if (!cluster) return null;

  const summary =
    typeof obj.summary === 'string' ? obj.summary.trim().slice(0, MAX_SUMMARY) : '';
  if (summary.length === 0) return null; // nothing to store — drop

  const rawTitle = typeof obj.title === 'string' ? obj.title.trim().slice(0, MAX_TITLE) : '';
  const title =
    rawTitle.length > 0 ? rawTitle : `Cluster summary of ${cluster.member_ids.length} learnings`;

  let confidence =
    typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
      ? obj.confidence
      : 0.5;
  if (confidence < 0) confidence = 0;
  if (confidence > CARTOGRAPHER_CONFIDENCE_CAP) confidence = CARTOGRAPHER_CONFIDENCE_CAP;

  return {
    // Resolve members from the CITED cluster (never trust the model for ids).
    cluster_member_ids: [...cluster.member_ids],
    title,
    synthesized_summary: summary,
    confidence,
  };
}

/**
 * Parse + validate the raw LLM response against the run's clusters. Returns the
 * valid cluster-meta proposals (out-of-range cluster_index dropped, blank summary
 * dropped, confidences capped). Returns `[]` when the response is not a JSON array
 * OR is a well-formed array whose elements were all dropped — the engine tells
 * these apart via `isCartographerResponseWellFormed` (malformed → parse_error;
 * well-formed empty → success with zero candidates, TD-294). Never throws (the
 * parseResponse contract).
 *
 * @param raw      the raw LLM response text
 * @param clusters the clusters the response was generated from (cite whitelist)
 */
export function validateCartographerResponse(
  raw: string,
  clusters: LearningCluster[],
): ClusterMetaProposal[] {
  const arr = parseJsonArray(raw);
  if (arr === null) return [];
  const byIndex = new Map<number, LearningCluster>();
  for (const c of clusters) byIndex.set(c.cluster_index, c);
  const out: ClusterMetaProposal[] = [];
  for (const el of arr) {
    const proposal = validateOne(el, byIndex);
    if (proposal) out.push(proposal);
  }
  return out;
}
