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
// The instance OBSERVABILITY declaration (TD-327)
// ---------------------------------------------------------------------------

/**
 * How an instance is driven. Read by the health classifier to decide which
 * signal to cross-check when `event_log` has gone quiet:
 *   - `schedule`     — a `schedules` row fires it (`driver_ref` = the row NAME).
 *   - `co_driven`    — another INSTANCE runs it inside its own run
 *                      (`driver_ref` = that instance's `id`). It has no
 *                      schedule of its own, so a wedged driver takes it down.
 *   - `session_hook` — a harness/session hook spawns it out of band.
 *   - `manual`       — only an explicit MCP tool / operator call runs it.
 */
export type CognitionDriver =
  | 'schedule'
  | 'co_driven'
  | 'session_hook'
  | 'manual';

/**
 * TD-327 — the REQUIRED observability self-description.
 *
 * WHY REQUIRED. The registry is OPEN (`registry.ts`), so any health surface that
 * hand-lists its members cannot report on the ones nobody remembered to list.
 * That is exactly how five of seven instances went silent for four weeks
 * unnoticed. Making this block part of the CONTRACT means you cannot add an
 * instance without declaring how an operator sees it STOP: the roster
 * (`roster.ts`) projects `registry.all()` into `cognition_instances`, and the
 * `igris cognition health` verb renders that projection. A new instance appears
 * in `/boot` and `/scan` with ZERO edit to either surface.
 *
 * EVERY FIELD IS A LITERAL, NEVER A DERIVATION. `registry.ts:42` claims an id
 * "becomes its `event_log.component` namespace `cognition.<id>`" — perception
 * does NOT obey that (see `extractors/perception.ts`), so a surface that derives
 * `cognition.${id}` silently omits the single healthiest instance. MAINTAINING's
 * L-857 row states the rule: assert the literal, do not derive it.
 */
export interface CognitionInstanceHealth {
  /**
   * The `event_log.component` value this instance's lifecycle rows carry,
   * VERBATIM. `cognition.<id>` for every instance except perception, whose
   * production path (`perception/runner.ts` → `writePerceptionEvent`) writes the
   * LEGACY bare `perception`.
   */
  readonly component: string;
  /**
   * The `event_log.event_name` prefix, VERBATIM — rows are named
   * `<event_prefix>.run_started` / `.run_succeeded` / `.run_failed` /
   * `.run_skipped`. Differs from `component` for no instance today, but it is
   * declared separately because perception proved the two CAN diverge and a
   * single field would force the next divergence to be derived.
   */
  readonly event_prefix: string;
  /**
   * The `~/.igris/config.json` dotted key(s) that gate this instance, as a
   * CONJUNCTION — the instance runs only when EVERY key resolves truthy. Most
   * instances declare one key. `arbiter`/`curator` declare the JANITOR's key
   * (they have no switch of their own); `cartographer` declares that key AND
   * `cognition.janitor.cluster.enabled`, its second gate.
   *
   * Declared as a list rather than a single key precisely so the double gate is
   * DERIVED from the instance rather than special-cased in the reader — a
   * `if (id === 'cartographer')` branch in the CLI would be the hand-list this
   * contract exists to abolish.
   */
  readonly gate_keys: readonly string[];
  /**
   * What an ABSENT `gate_keys` entry resolves to — applied per key.
   *
   * THE CONVENTION HAS AN EXCEPTION, WHICH IS WHY THIS IS DECLARED RATHER THAN
   * ASSUMED. `/boot` and `/scan` have long documented "if the key is absent,
   * treat as false", and that is right for six of the seven: subconscious,
   * synapse and janitor all default `enabled: false`, and arbiter, curator and
   * cartographer derive from the janitor's key. Perception does NOT —
   * `DEFAULT_PERCEPTION_CONFIG.extractor_llm_enabled` is `true`.
   *
   * DISTINGUISH THE RESOLVER DEFAULT FROM THE SHIPPED POSTURE — they are not
   * the same and conflating them puts a false claim in a consumer doc.
   * The resolver treats a truly ABSENT key as ON. But a stock fresh install
   * never has an absent key: `igris install` calls `applyPerceptionDefault()`
   * and `config.json.tmpl` ships `"perception": { "enabled": false }` — FR-191's
   * zero-config door, pinned by `cli/src/__tests__/init.test.ts` and mapped at
   * MAINTAINING row 73. **So a stock fresh install has perception OFF.**
   *
   * This declaration exists for the configs where the key was never written:
   * pre-FR-191 installs, hand-edited configs, and an `IGRIS_BRAIN_DIR` with no
   * `config.json`. Hard-coding "absent means off" would misreport exactly those
   * as `disabled` while they are extracting — the same silent-omission class as
   * deriving its event namespace, in a second place.
   */
  readonly gate_default: boolean;
  /** How this instance is driven — see {@link CognitionDriver}. */
  readonly driver: CognitionDriver;
  /**
   * What `driver` points at: the `schedules.name` for `schedule`, the DRIVING
   * INSTANCE's `id` for `co_driven`, the hook name for `session_hook`, `null`
   * for `manual`.
   */
  readonly driver_ref: string | null;
  /**
   * Where this instance's output LANDS, as a human-readable table+filter
   * expression (e.g. `suggestions[source_module='arbiter']`). This is the
   * answer to the brief's "where does its output go?" and is what an operator
   * queries when they want to see whether a run produced anything.
   */
  readonly output: string;
  /**
   * TD-423 — the IDENTITY predicate: which rows are attributable to THIS
   * instance, regardless of review state.
   *
   * DISTINCT FROM `output`, DELIBERATELY. `output` is "where an operator looks
   * for actionable results" and is legitimately a STATE predicate — perception
   * declares its INBOX, which selects ZERO rows once the queue is drained even
   * though it has authored 569. `produced` is "which rows did this instance ever
   * write". Do NOT collapse the two.
   *
   * GRAMMAR — `table[col='literal']` or `table[col=literal, col2=OTHER]`, where
   * `OTHER` is the complement of every literal ANY OTHER roster row declares for
   * the same table+column. The reader resolves it FROM THE ROSTER, so an eighth
   * literal instance shrinks the complement with no code edit; that is what
   * makes the subconscious ONE entry rather than one per LLM-minted label.
   *
   * REQUIRED, so `tsc` enumerates every declaration site. An optional field with
   * a fallback to `output` would hand an instance that forgot one a silently
   * WRONG number presented as a population count.
   *
   * Full account, including the surviving-vs-lifetime bound on `learnings`:
   * `docs/COGNITION.md` (this docblock is emitted into a `.d.ts` that SHIPS in
   * the npm tarball, so prose here is charged against the packed-size ceiling —
   * unlike `cli/src`, which compiles with `declaration: false`).
   */
  readonly produced: string;
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
  /**
   * OPEN id — 'perception' | 'subconscious' | any future extractor. The
   * `event_log.component` is CONVENTIONALLY `cognition.<id>`, but the
   * convention is not load-bearing and perception breaks it — read the LITERAL
   * out of `health.component` instead of deriving it from this id (TD-327).
   */
  readonly id: string;

  /**
   * TD-327 — the REQUIRED observability self-description: which `event_log`
   * namespace this instance writes, which config keys gate it, what drives it,
   * and where its output lands. REQUIRED, not optional: the registry is OPEN,
   * so an instance that does not declare how an operator sees it stop can ship
   * invisible — the exact regression TD-327 closes.
   */
  readonly health: CognitionInstanceHealth;

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
   * candidates. Never throws on malformed input — returns `[]`. When the parse
   * yields zero candidates the engine consults the OPTIONAL `isMalformedResponse`
   * hook (TD-294) to disambiguate: a MALFORMED / non-array response maps to
   * `fail_reason=parse_error`, whereas a WELL-FORMED (possibly empty) array — a
   * legitimate "nothing to act on" judgment — settles to a SUCCESSFUL run with
   * zero candidates. When the hook is absent the legacy rule applies (any zero
   * parse → `parse_error`).
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

  /**
   * Optional (TD-294) — consulted by the engine ONLY when `parseResponse`
   * returned zero candidates, to distinguish a MALFORMED response from a VALID
   * EMPTY judgment. Returns true when `raw` is NOT a well-formed response for
   * this instance (→ `fail_reason=parse_error`); false when `raw` is well-formed
   * but simply yielded nothing to act on (→ a SUCCESSFUL run with zero
   * candidates). The instance owns this verdict because parse leniency (fenced
   * code / envelopes) is instance-specific — it must use the SAME grammar its
   * `parseResponse` accepts. Omitted → legacy behavior (zero parse →
   * `parse_error`, unchanged).
   */
  isMalformedResponse?(raw: string): boolean;
}
