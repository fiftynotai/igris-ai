/**
 * Brain Engine v7.1 — Cognition subsystem: the instance CONTRACT (FR-118 M0).
 *
 * Cognition is ONE expandable LLM-extraction host. Perception and subconscious
 * are not two components — they are two self-describing INSTANCES of the same
 * flow: observe brain state → isolated LLM call → parse candidates → persist →
 * queue for review. They differ in only three slots:
 *   - the INPUT       (`buildContext`):  perception = transcript, subconscious = digest
 *   - the OUTPUT TABLE (`persistCandidate`): learnings vs suggestions
 *   - the PROMPT      (`promptBuilder`)
 *
 * Everything else — cold-start gate, daily-budget gate, timeout, prompt-injection
 * wrap, lifecycle events, auto-push, and the harness backend — is the agnostic
 * host (`engine/index.ts:runExtractor`). The engine reads ONLY the
 * `CognitionInstance` interface below; it knows nothing about perception vs
 * subconscious. A new extractor is a new instance FILE discovered by the OPEN
 * registry (`registry.ts`) — ZERO engine change (the FR-202 extensibility test).
 *
 * @module engine/components/cognition/types
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Harness backend types (the FR-201 port)
// ---------------------------------------------------------------------------

/**
 * The CLI harnesses the backend can run the isolated extraction call on. Open
 * to the five first-class Igris harnesses; the spawn-map (`backend/spawn-map.ts`)
 * maps each to its headless flags. Ported from FR-201's `HarnessName`, extended
 * with `gemini`/`opencode`/`antigravity` per the FR-201→cognition port table.
 */
export type ExtractorHarness =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'antigravity';

/** All harnesses, in the default fallback-probe order. */
export const ALL_EXTRACTOR_HARNESSES: readonly ExtractorHarness[] = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'antigravity',
] as const;

/**
 * The resolved backend for one run: which harness CLI will be invoked plus the
 * order tried while resolving availability. `harness === null` means NO usable
 * CLI was found (every candidate in `fallback_order` was absent) — the engine
 * emits `run_skipped reason=cli_missing` and persists nothing.
 */
export interface ResolvedBackend {
  /** The chosen harness CLI, or null when none in the fallback order is present. */
  harness: ExtractorHarness | null;
  /** The harnesses tried (in order) while resolving availability — for observability. */
  fallback_order: ExtractorHarness[];
}

// ---------------------------------------------------------------------------
// Instance config
// ---------------------------------------------------------------------------

/**
 * The per-instance config envelope the engine reads. Resolved by the component
 * factory via the same layered chain perception/subconscious already use
 * (defaults → config.json → env), with the harness resolved by the 4-layer
 * chain in `backend/env.ts:resolveHarness`.
 */
export interface CognitionInstanceConfig {
  /** Hard wall-clock budget for the LLM subprocess (ms). */
  timeout_ms: number;
  /** Max `{component}.run_started` rows allowed in `event_log` per UTC day. */
  daily_budget: number;
  /** Minimum input size (UTF-8 bytes) below which the run is skipped (cost gate). */
  min_input_bytes: number;
  /** Master switch — when false the engine emits `run_skipped reason=disabled`. */
  enabled: boolean;
  /**
   * Per-instance harness override. `null` = inherit the global
   * `llm_extractor.harness` default. Resolved by `resolveHarness`.
   */
  harness: ExtractorHarness | null;
}

// ---------------------------------------------------------------------------
// Engine I/O
// ---------------------------------------------------------------------------

/**
 * Arguments handed to one `runExtractor` invocation. Carried opaquely to the
 * instance's `buildContext`; the engine reads only the framing fields it owns
 * (project for event tagging, trigger for observability, force to bypass gates).
 */
export interface ExtractorArgs {
  /** Project slug — tagged onto every lifecycle event for the read surface. */
  project?: string;
  /** What triggered this run ('cron' | 'manual' | a test tag) — observability. */
  trigger?: string;
  /**
   * Bypass the cold-start + bytes cost gate (NOT the budget or disabled gate).
   * Used by manual `*_run` MCP tools that want to force a run regardless of size.
   */
  force?: boolean;
  /**
   * Optional brief id surfaced to the instance's `buildContext`/`promptBuilder`
   * (perception threads this through for the per-brief context line).
   */
  brief_id?: string;
  /** Any instance-specific extra args — opaque to the engine. */
  [key: string]: unknown;
}

/** The terminal disposition of one run. */
export type ExtractorOutcome =
  | 'succeeded'
  | 'failed'
  | 'skipped';

/**
 * What `runExtractor` returns. `outcome` is the terminal disposition (mirrors
 * the one-terminal-event-per-run invariant — exactly one of
 * succeeded/failed/skipped). `skip_reason`/`fail_reason` carry the matching
 * detail string written into the lifecycle payload.
 */
export interface ExtractorResult {
  /** The instance that ran. */
  instance_id: string;
  /** Terminal disposition (matches the single terminal lifecycle event). */
  outcome: ExtractorOutcome;
  /** Count of candidates the instance persisted (0 on skip/fail). */
  persisted: number;
  /** Set when outcome==='skipped' — e.g. 'disabled' | 'budget' | 'cold_start' | 'gate_bytes' | 'cli_missing' | 'no_candidates'. */
  skip_reason?: string;
  /** Set when outcome==='failed' — e.g. 'timeout' | 'parse_error' | 'non_zero_exit' | 'spawn_error'. */
  fail_reason?: string;
  /** The resolved backend (which harness, the fallback order) — for observability. */
  backend?: ResolvedBackend;
  /** Raw count of candidates the instance parsed before persistence (for tests). */
  parsed?: number;
}

// ---------------------------------------------------------------------------
// The instance CONTRACT — what makes a part a cognition instance
// ---------------------------------------------------------------------------

/**
 * The prompt an instance hands the backend. `system` is delivered on a separate
 * channel (e.g. `--system-prompt`) from `user` (untrusted brain content), and
 * the engine wraps `user` in a prompt-injection envelope before the LLM call.
 */
export interface ExtractorPrompt {
  system: string;
  user: string;
}

/**
 * The cognition instance contract. The engine (`runExtractor`) reads ONLY this
 * interface. `TContext` is the instance's private input shape (perception =
 * transcript events, subconscious = a brain digest); `TCandidate` is its private
 * candidate shape (learnings vs suggestions). Both are opaque to the engine.
 *
 * A part is a cognition instance IFF it can fill this contract — observe →
 * isolated LLM → candidates → review. The contract gates membership: anything
 * that can't fill it belongs elsewhere (a verb, a hook, the brain). This is the
 * SAME plugin-host split as FR-202 surfaces: agnostic host, self-describing
 * parts, the contract decides membership.
 */
export interface CognitionInstance<TContext = unknown, TCandidate = unknown> {
  /** OPEN id — 'perception' | 'subconscious' | any future extractor. The `event_log.component` is `cognition.<id>`. */
  readonly id: string;

  /**
   * Slot 1 — INPUT. Read brain state into the instance's private context shape.
   * Pure read; the engine owns mutation. May return a context whose size the
   * engine's bytes gate measures via `inputBytes` below.
   */
  buildContext(db: Database.Database, args: ExtractorArgs): Promise<TContext>;

  /**
   * Slot 3 — PROMPT. Build the system + user prompt from the context. The user
   * half is treated as untrusted; the engine wraps it before the LLM call.
   */
  promptBuilder(ctx: TContext): ExtractorPrompt;

  /**
   * Validate / coerce / cite-check the raw LLM response text into typed
   * candidates. Never throws on malformed input — returns `[]` (the engine maps
   * an empty parse of a NON-empty response to `fail_reason=parse_error`).
   */
  parseResponse(raw: string, ctx: TContext): TCandidate[];

  /**
   * Slot 2 — OUTPUT TABLE. Persist one candidate into the instance's OWN table
   * (learnings vs suggestions). The instance owns its table, dedup, embedding —
   * the engine only counts how many were persisted.
   */
  persistCandidate(db: Database.Database, candidate: TCandidate): Promise<void>;

  /** The per-instance config envelope (timeout/budget/min-bytes/enabled/harness). */
  config: CognitionInstanceConfig;

  /**
   * Optional — measure the context's input size in UTF-8 bytes for the cost
   * gate. Defaults to 0 (always passes the bytes floor) when omitted, which
   * keeps an instance that has no meaningful "input size" (e.g. a future
   * always-run watcher) from being gated out. Perception/subconscious supply it.
   */
  inputBytes?(ctx: TContext): number;

  /**
   * Optional — report that the built context has NO work to do (e.g. an empty
   * candidate set). When present and true, the engine short-circuits to
   * `skipped reason=no_candidates` BEFORE resolving/spawning the backend — even
   * under `force` (force bypasses cost gates, not "nothing to extract"). Omitted
   * → the instance never self-reports empty (unchanged behavior).
   */
  isEmptyContext?(ctx: TContext): boolean;
}
