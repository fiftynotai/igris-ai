/**
 * Brain Engine v5.0 — Perception Runner (FR-109)
 *
 * Orchestrates the perception pipeline:
 *   1. Run rule extractors over the parsed transcript window.
 *   2. Apply heuristic-first cost gate; if it passes, run the LLM extractor
 *      (Mode B per the FR-109 plan).
 *   3. Merge rule + LLM candidates and dedupe by (project, normalized title)
 *      with rule-source preferred on ties.
 *   4. Persist surviving candidates as `learnings(review_status='pending_review',
 *      provenance='inferred', source_extractor=<...>)`.
 *
 * The runner is deliberately a pure function over a `Database` handle and a
 * config struct. The handlers wire it to the gateway and the bus; it does
 * not know about MCP.
 *
 * @module engine/components/perception/runner
 * @author Fifty.ai
 */

import type Database from 'better-sqlite3';
import type {
  PerceptionCandidate,
  PerceptionExtractorConfig,
  TranscriptEvent,
  SourceExtractor,
} from './types.js';
import { extractLearnedMarkers } from './extractors/learned_marker.js';
import { extractRetryChains } from './extractors/retry_chain.js';
import { extractBlockerResolutions } from './extractors/blocker_resolution.js';
import { extractErrorFingerprints } from './extractors/error_fingerprint.js';
import type { LlmExtractor, LlmExtractorContext } from './extractors/llm_via_claude_code.js';
import { noopLlmExtractor } from './extractors/llm_via_claude_code.js';
import { generateEmbedding, embeddingToBuffer, EMBEDDING_MODEL } from '../../../utils/embeddings.js';
import { isVectorSearchAvailable, insertEmbedding } from '../../../utils/vector-search.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Possible LLM-status values returned by `runPerception`. Used by
 * `igris_perception_extract_now` so operators can see which gate fired.
 */
export type LlmStatus = 'ran' | 'skipped:disabled' | 'skipped:cost' | 'skipped:cli_missing' | 'skipped:bytes' | 'skipped:rules_sufficient';

export interface RunPerceptionOptions {
  /** Parsed transcript events to scan. */
  events: TranscriptEvent[];
  /** Project slug. Required — used for INSERT and dedupe scoping. */
  project: string;
  /** Optional brief id for evidence and prompt context. */
  brief_id?: string;
  /** Source label written into evidence for forensics (e.g. 'session_end', 'pre_compact'). */
  source: string;
  /** When true, bypass cost gates (transcript size + rules-sufficient threshold). */
  force_llm?: boolean;
}

export interface RunPerceptionResult {
  /** Candidates emitted by rule extractors (pre-dedupe). */
  rule_extracted: number;
  /** Candidates emitted by the LLM extractor (pre-dedupe). */
  llm_extracted: number;
  /** Candidates suppressed by intra-run dedupe. */
  suppressed: number;
  /** Candidates inserted as `pending_review` rows. */
  inserted: number;
  /** New learning ids inserted by this run. */
  inserted_ids: number[];
  /** Status of the LLM gate. */
  llm_status: LlmStatus;
  /** Per-source breakdown of inserted candidates. */
  by_source: Record<SourceExtractor, number>;
}

// ---------------------------------------------------------------------------
// Rule extractor orchestration
// ---------------------------------------------------------------------------

/**
 * Run all rule extractors and return the merged candidate list. Each
 * extractor is a pure function — failures are localized and never crash
 * the runner.
 */
export function runRuleExtractors(events: TranscriptEvent[]): PerceptionCandidate[] {
  if (events.length === 0) return [];
  const candidates: PerceptionCandidate[] = [];
  for (const fn of [
    extractLearnedMarkers,
    extractRetryChains,
    extractBlockerResolutions,
    extractErrorFingerprints,
  ]) {
    try {
      candidates.push(...fn(events));
    } catch (err) {
      // Defensive: an extractor bug should not break the pipeline.
      console.error(
        '[perception] rule extractor threw — continuing with remaining extractors:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Cost gate (heuristic-first per L-065, plan §Phase B.5)
// ---------------------------------------------------------------------------

interface GateDecision {
  shouldRun: boolean;
  status: LlmStatus;
}

/**
 * Decide whether to run the LLM extractor given the rule output, transcript
 * size, and config. The gate ladder is:
 *
 *   1. `extractor_llm_enabled=false`  → skip:disabled
 *   2. transcript_bytes < threshold   → skip:bytes (UNLESS forceLlm)
 *   3. rules_count >= skip_threshold  → skip:rules_sufficient (UNLESS forceLlm)
 *   4. otherwise                       → ran
 *
 * `force_llm` only bypasses the cost gates (steps 2-3). The correctness
 * gate (`extractor_llm_enabled=false`) is never bypassed — that's an
 * operator decision, not a cost decision.
 */
export function evaluateLlmGate(
  ruleCount: number,
  transcriptBytes: number,
  config: PerceptionExtractorConfig,
  forceLlm: boolean,
): GateDecision {
  if (!config.extractor_llm_enabled) {
    return { shouldRun: false, status: 'skipped:disabled' };
  }
  if (!forceLlm && transcriptBytes < config.llm_min_transcript_bytes) {
    return { shouldRun: false, status: 'skipped:bytes' };
  }
  if (!forceLlm && ruleCount >= config.llm_skip_threshold) {
    return { shouldRun: false, status: 'skipped:rules_sufficient' };
  }
  return { shouldRun: true, status: 'ran' };
}

// ---------------------------------------------------------------------------
// Dedupe (intra-run, rule-source-preferred)
// ---------------------------------------------------------------------------

/** Normalize a title for dedupe equality: lowercase, collapse whitespace. */
function dedupeKey(c: PerceptionCandidate): string {
  return c.title.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Within-run dedupe with rule-source priority on ties.
 *
 * For each title bucket:
 *   - If only one candidate, keep it.
 *   - If multiple, pick the highest confidence; on ties, prefer
 *     `source_extractor` starting with `'rule:'` (deterministic) over `'llm'`.
 */
export function dedupeWithRulePriority(
  candidates: PerceptionCandidate[],
): { kept: PerceptionCandidate[]; suppressed: number } {
  const buckets = new Map<string, PerceptionCandidate[]>();
  for (const c of candidates) {
    const key = dedupeKey(c);
    const list = buckets.get(key);
    if (list) list.push(c);
    else buckets.set(key, [c]);
  }
  const kept: PerceptionCandidate[] = [];
  let suppressed = 0;
  for (const list of buckets.values()) {
    if (list.length === 1) {
      kept.push(list[0]);
      continue;
    }
    list.sort((a, b) => {
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      // Rule sources beat LLM on confidence tie — deterministic > non-deterministic.
      const aIsRule = a.source_extractor.startsWith('rule:');
      const bIsRule = b.source_extractor.startsWith('rule:');
      if (aIsRule && !bIsRule) return -1;
      if (!aIsRule && bIsRule) return 1;
      return 0;
    });
    kept.push(list[0]);
    suppressed += list.length - 1;
  }
  return { kept, suppressed };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Persist a candidate as a pending_review learnings row. Generates an
 * embedding (best-effort — failure does not block the INSERT) so approval
 * is a pure status flip without a re-embed.
 *
 * Tags are joined with comma to match the existing comma-separated convention
 * in `learnings.tags`.
 */
async function persistCandidate(
  db: Database.Database,
  candidate: PerceptionCandidate,
  project: string,
  briefId: string | undefined,
  source: string,
): Promise<number> {
  // `source` is the extraction trigger (e.g. 'session_end', 'pre_compact',
  // 'extract_now') — distinct from `candidate.source_extractor`, which names
  // the extractor that produced the row (rule:* | llm). Both are part of the
  // forensic story: source_extractor is persisted on the row (column added in
  // v15 migration), trigger source is currently bus-only.
  void source;

  // Truncate to schema-friendly bounds without risking ALTER TABLE collisions.
  const safeTitle = candidate.title.slice(0, 500);
  const safeContent = candidate.content.slice(0, 1_000_000);
  const tags = candidate.tags.join(',');

  // Persist the evidence in source_brief as JSON tagged with the brief id —
  // the existing recall path reads `source_brief` so the link surfaces in
  // the UI without a schema change.
  const sourceBrief = briefId ? briefId : '';

  const stmt = db.prepare(`
    INSERT INTO learnings
      (project, category, title, content, tags, tech_stack, source_brief,
       scope, confidence, provenance, review_status, source_extractor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    project,
    candidate.category,
    safeTitle,
    safeContent,
    tags,
    candidate.tech_stack ?? '',
    sourceBrief,
    'local',
    candidate.confidence,
    'inferred',
    'pending_review',
    candidate.source_extractor,
  );
  const id = result.lastInsertRowid as number;

  // Best-effort embedding — same shape as memory.handleMemoryStore.
  try {
    if (isVectorSearchAvailable(db)) {
      const embedding = await generateEmbedding(`${safeTitle} ${safeContent}`);
      db.prepare('UPDATE learnings SET embedding = ?, embedding_model = ? WHERE id = ?').run(
        embeddingToBuffer(embedding),
        EMBEDDING_MODEL,
        id,
      );
      insertEmbedding(db, id, embedding);
    }
  } catch (err) {
    console.error(
      '[perception] auto-embed failed for pending_review row',
      id,
      err instanceof Error ? err.message : String(err),
    );
  }
  return id;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the full perception pipeline: rule extractors + cost-gated LLM
 * extractor + dedupe + persist.
 *
 * The runner is the single point that mutates `learnings`. Extractors are
 * pure; persistence is sequenced so an embedding failure on one row does
 * not block the next.
 */
export async function runPerception(
  db: Database.Database,
  options: RunPerceptionOptions,
  config: PerceptionExtractorConfig,
  llmExtractor: LlmExtractor = noopLlmExtractor,
): Promise<RunPerceptionResult> {
  const { events, project, brief_id: briefId, source, force_llm: forceLlm = false } = options;

  const result: RunPerceptionResult = {
    rule_extracted: 0,
    llm_extracted: 0,
    suppressed: 0,
    inserted: 0,
    inserted_ids: [],
    llm_status: 'skipped:disabled',
    by_source: {
      'rule:learned_marker': 0,
      'rule:retry_chain': 0,
      'rule:blocker_resolution': 0,
      'rule:error_fingerprint': 0,
      llm: 0,
    },
  };

  if (events.length === 0) return result;

  // 1. Rule extractors.
  const ruleCandidates = config.rule_extractors_enabled ? runRuleExtractors(events) : [];
  result.rule_extracted = ruleCandidates.length;

  // 2. Cost gate + LLM extractor.
  const transcriptBytes = events.reduce((n, e) => n + (e.content?.length ?? 0), 0);
  const gate = evaluateLlmGate(ruleCandidates.length, transcriptBytes, config, forceLlm);
  result.llm_status = gate.status;
  let llmCandidates: PerceptionCandidate[] = [];
  if (gate.shouldRun) {
    const ctx: LlmExtractorContext = { project };
    if (briefId) ctx.brief_id = briefId;
    try {
      llmCandidates = await llmExtractor(events, ctx);
    } catch (err) {
      // Defensive: failed LLM call does not block rule pipeline.
      console.error(
        '[perception] LLM extractor threw — continuing without LLM candidates:',
        err instanceof Error ? err.message : String(err),
      );
      llmCandidates = [];
    }
  }
  result.llm_extracted = llmCandidates.length;

  // 3. Dedupe with rule priority.
  const merged = [...ruleCandidates, ...llmCandidates];
  const { kept, suppressed } = dedupeWithRulePriority(merged);
  result.suppressed = suppressed;

  // 4. Persist as pending_review.
  for (const c of kept) {
    try {
      const id = await persistCandidate(db, c, project, briefId, source);
      result.inserted_ids.push(id);
      result.inserted += 1;
      result.by_source[c.source_extractor] += 1;
    } catch (err) {
      console.error(
        '[perception] persist failed for candidate, skipping:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return result;
}
