/**
 * Brain Engine v5.0 — Perception Component Types (FR-109)
 *
 * Shared types for the perception channel: LLM extractor + runner + handlers.
 *
 * The pipeline is LLM-only (TD-066): the runner reads the transcript, applies
 * a bytes-floor cost gate, and invokes the single LLM extractor. Extractors
 * are pure async functions over `TranscriptEvent[]` returning candidates;
 * they never throw on malformed input.
 *
 * @module engine/components/perception/types
 * @author Fifty.ai
 */

// ---------------------------------------------------------------------------
// Transcript wire shape
// ---------------------------------------------------------------------------

/**
 * One parsed transcript event. The hook delivers a JSONL stream over stdin;
 * each line is an object with at least `role` and `content`. The remaining
 * fields are optional and tolerated when missing — extractors never throw
 * on malformed events, they just skip.
 *
 * Production transcripts may contain additional fields (token usage, tool
 * results, etc.) — we only persist the keys we use to keep the shape forward
 * compatible across CLI versions.
 */
export interface TranscriptEvent {
  /** Wall-clock timestamp (ISO-8601). May be empty if the source omits it. */
  timestamp: string;
  /** Sender. Common values: 'user', 'assistant', 'tool', 'system'. */
  role: string;
  /** Message body (may be plain text or stringified tool arguments). */
  content: string;
  /** Tool name when role === 'tool'. */
  tool_name?: string;
  /** Brief id when explicitly referenced by the session metadata. */
  brief_id?: string;
}

// ---------------------------------------------------------------------------
// Candidate shape
// ---------------------------------------------------------------------------

/**
 * Identifier for the extractor that produced a candidate (TD-066).
 *
 * Narrowed after rule extractors removed — only LLM-driven and direct
 * memory_store / distill flows remain. Legacy `rule:*` values may still
 * exist on historical DB rows and are read-compatible (TS-only narrowing).
 */
export type SourceExtractor = 'llm' | 'manual' | 'distill';

/**
 * Categories aligned with `learnings.category`. Perception currently emits
 * the same 5 categories the conscious channel uses — keeps approval a pure
 * status flip with no schema drift.
 */
export type PerceptionCategory =
  | 'discovery'
  | 'pattern'
  | 'mistake'
  | 'decision'
  | 'optimization';

/**
 * Pre-persistence shape returned by extractors. The runner adds dedupe,
 * suppression, embedding, and INSERT — extractors are pure.
 */
export interface PerceptionCandidate {
  category: PerceptionCategory;
  title: string;
  content: string;
  /** 0-5 tags. The runner stringifies before INSERT. */
  tags: string[];
  /** Per-extractor confidence. LLM is capped at 0.85 post-parse. */
  confidence: number;
  /** Which extractor produced this candidate. */
  source_extractor: SourceExtractor;
  /**
   * Free-form evidence carried into `learnings.evidence` JSON for forensics
   * and the `/awaken` review surface. Always includes a transcript excerpt
   * when produced by the LLM extractor.
   */
  evidence: Record<string, unknown>;
  /** Optional tech stack hint — survives approval into `learnings.tech_stack`. */
  tech_stack?: string;
}

// ---------------------------------------------------------------------------
// Extractor configuration
// ---------------------------------------------------------------------------

/**
 * All knobs for the perception runner. Resolved at component init via the
 * 3-layer chain (defaults → `~/.igris/config.json` → env vars). Tests inject
 * the struct directly.
 */
export interface PerceptionExtractorConfig {
  // LLM knobs
  /** Master switch for the headless `claude -p` extractor. Default true (TD-066). */
  extractor_llm_enabled: boolean;
  /** Hard wall-clock budget for the LLM subprocess. Default 300s. */
  llm_timeout_ms: number;
  /** Hard cap on candidates the LLM may emit per call. Default 10. */
  llm_max_candidates: number;
  /** Minimum transcript size (UTF-8 bytes) to bother invoking the LLM. */
  llm_min_transcript_bytes: number;

  // Persistence knobs
  /** Days a pending_review row remains visible before lazy-on-read filter excludes it. */
  pending_review_ttl_days: number;
  /** Cap on title length surviving from extractors → INSERT. */
  max_title_length: number;
  /** Cap on content length surviving from extractors → INSERT. */
  max_content_length: number;
  /**
   * If true, runner inserts approved rows directly (review_status='approved').
   * Default false — operator opts in once they trust the LLM extractor.
   * TD-066.
   */
  auto_approve_enabled: boolean;
}

/** Defaults — all kept here so tests can shrink/widen individual gates. */
export const DEFAULT_PERCEPTION_CONFIG: PerceptionExtractorConfig = {
  extractor_llm_enabled: true,
  llm_timeout_ms: 300_000,
  llm_max_candidates: 10,
  llm_min_transcript_bytes: 1024,
  pending_review_ttl_days: 14,
  max_title_length: 500,
  max_content_length: 4000,
  auto_approve_enabled: false,
};

// ---------------------------------------------------------------------------
// Watermark row
// ---------------------------------------------------------------------------

/** Per-project watermark recording the last extracted-up-to timestamp. */
export interface PerceptionWatermark {
  project: string;
  last_extracted_at: string;
  updated_at: string;
}
