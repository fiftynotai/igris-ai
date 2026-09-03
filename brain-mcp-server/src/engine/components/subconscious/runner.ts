/**
 * Brain Engine v7.1 — Subconscious Runner
 *
 * Post-FR-118 (M4b) this file carries TWO things:
 *   1. The LIVE run entry point `runSubconscious` — the LLM subconscious
 *      instance driven through the agnostic cognition engine. This is the
 *      sole `suggestions` writer (the `subconscious_engine` cron schedule
 *      hits it via `igris_subconscious_run`).
 *   2. The dismiss-reason learning loop helpers — `computeEvidenceSignature`
 *      and `recordDismissPattern` — still active. The dismiss handler and the
 *      subconscious instance's dedupe key both depend on them.
 *
 * The FR-106 rule-detector pipeline (`runAllDetectors`, the `stalled`/`gap`/
 * `conflict`/`pattern` detectors, the FR-108 LLM verifier, `pattern_observations`
 * smoothing, the `ReadOnlyDb` wrapper) was DELETED in FR-118 M4b — the LLM
 * subconscious instance replaced it as the live path. Nothing imports the rule
 * engine any more.
 *
 * Dismiss-reason learning loop (Q3=B in the FR-106 answers):
 *   - Dismissing a suggestion UPSERTS its finding key into `dismissed_patterns`
 *     (see `recordDismissPattern`), from BOTH dismiss writers — the MCP handler
 *     and `actions/kinds.ts#applyDismissExisting`.
 *   - The subconscious persist path consults `isSuppressedByDismissal` before
 *     inserting, so a re-emission of a dismissed finding is suppressed.
 *
 *   UNTIL TD-440 THE SECOND HALF DID NOT EXIST. The loop was write-only: the
 *   only `SELECT` on `dismissed_patterns` was inside `recordDismissPattern`,
 *   and `dismiss_suppress_count` / `dismiss_cooldown_days` were read by no
 *   code at all. This docblock, `docs/architecture/subconscious_engine.md` and
 *   `cli/src/types.ts` all asserted the policy was live, and all three were
 *   wrong for the whole of FR-106 through FR-118. `computeEvidenceSignature` is
 *   retained for pre-TD-440 rows only; the live key is
 *   `finding-key.ts#findingKey`.
 *
 * @module engine/components/subconscious/runner
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import {
  type DetectorConfig,
  DEFAULT_DETECTOR_CONFIG,
  DEFAULT_SUBCONSCIOUS_CONFIG,
  type SubconsciousConfig,
  type SuggestionSourceModule,
} from './types.js';
import { runExtractor, type LlmExtractorGlobalConfig } from '../cognition/engine/index.js';
import type { ExtractorResult } from '../cognition/types.js';
import { createSubconsciousInstance } from '../cognition/extractors/subconscious.js';
import { backfillFindingKeys } from './finding-key.js';

// ---------------------------------------------------------------------------
// The LIVE runner (FR-118 M2) — the LLM subconscious instance on the engine
// ---------------------------------------------------------------------------

/** Options for `runSubconscious`. */
export interface RunSubconsciousOptions {
  /** The resolved subconscious instance config (timeout/budget/min-bytes/enabled/harness). */
  config?: SubconsciousConfig;
  /** The global `llm_extractor` config (harness default + fallback order). */
  globalConfig?: LlmExtractorGlobalConfig;
  /** Bypass the cold-start + bytes cost gate (manual `*_run` forces a run). */
  force?: boolean;
  /** What triggered this run ('cron' | 'manual' | a test tag) — observability. */
  trigger?: string;
  /**
   * Injectable engine seams (for tests: a mocked backend, a stubbed
   * cold-start probe, a fixed digest). Forwarded verbatim to `runExtractor`'s
   * `deps`. The default (omitted) runs the real brain-isolated backend.
   */
  deps?: Parameters<typeof runExtractor>[3];
}

/**
 * Run the subconscious LLM extractor ONCE through the agnostic cognition engine
 * (FR-118 M2 — REPLACES the rule-detector pipeline as the live path). Builds a
 * fresh subconscious instance from the resolved config and drives it through
 * `runExtractor`, which owns the cold-start / budget / timeout / brain-isolated
 * LLM call / one-terminal-event-per-run lifecycle. The schedule
 * (`subconscious_engine`, every 6h) now hits THIS via `igris_subconscious_run`.
 *
 * The lifecycle events are written by the engine under the per-instance
 * `cognition.subconscious.*` namespace (event_log directly — observable via
 * `igris_event_log component='cognition.subconscious'`). The legacy
 * `subconscious.*` bus events are no longer emitted by the live path.
 *
 * NOTE: the FR-106 rule detectors + the FR-108 verifier were DELETED in M4b.
 * The helpers retained alongside this runner are the dismiss loop's
 * `recordDismissPattern` + `isSuppressedByDismissal` (its write and read sides)
 * and `computeEvidenceSignature`, which now serves ONLY pre-TD-440 rows — the
 * instance's key is `finding-key.ts#findingKey`.
 *
 * TD-440: this function backfills the v5 finding keys once per run before
 * driving the engine. It is the right slot precisely because it is a WRITE
 * path; `buildContext` is a read slot and must not be given a write.
 *
 * @param db      the brain DB
 * @param project the project scope ('all' = whole brain)
 * @param options config + global config + force/trigger + injectable engine deps
 */
export async function runSubconscious(
  db: Database.Database,
  project = 'all',
  options: RunSubconsciousOptions = {},
): Promise<ExtractorResult> {
  const config = options.config ?? DEFAULT_SUBCONSCIOUS_CONFIG;
  // Bounded (NULL-key rows only) and idempotent; the live queue is keyed before
  // the first candidate of this run is matched against it.
  backfillFindingKeys(db);
  const instance = createSubconsciousInstance(config);
  const deps = {
    ...(options.globalConfig ? { globalConfig: options.globalConfig } : {}),
    ...(options.deps ?? {}),
  };
  return runExtractor(
    db,
    instance,
    {
      project,
      trigger: options.trigger ?? 'manual',
      ...(options.force ? { force: true } : {}),
    },
    deps,
  );
}

// ---------------------------------------------------------------------------
// Dismiss-loop helpers
// ---------------------------------------------------------------------------

/**
 * Compute a stable string key for a suggestion's evidence. The key must
 * be deterministic across runs so the dismiss-loop UPSERT lands on the
 * same row each time.
 *
 * Per-module contract:
 *   - stalled : `evidence.brief_id` (e.g. "TD-005")
 *   - gap     : `gap_kind=project_quiet` -> `evidence.project_slug`;
 *               `gap_kind=done_with_unchecked` -> `evidence.brief_id`
 *   - conflict (Phase 2): sorted pair `"<lower>:<higher>"` of learning ids
 *   - pattern  (Phase 2): `evidence.pattern_key`
 *
 * Falls back to a JSON-stable hash if the per-module key is missing —
 * never throws, never produces an empty signature (empty signatures
 * would collide across all modules and corrupt the dismissed_patterns
 * table).
 */
export function computeEvidenceSignature(
  module: SuggestionSourceModule,
  evidence: Record<string, unknown>,
): string {
  switch (module) {
    case 'stalled':
      if (typeof evidence.brief_id === 'string' && evidence.brief_id.length > 0) {
        return `brief:${evidence.brief_id}`;
      }
      break;
    case 'gap': {
      const kind = typeof evidence.gap_kind === 'string' ? evidence.gap_kind : '';
      if (kind === 'project_quiet') {
        const slug = typeof evidence.project_slug === 'string' ? evidence.project_slug : '';
        return `gap:project_quiet:${slug}`;
      }
      if (kind === 'done_with_unchecked') {
        const id = typeof evidence.brief_id === 'string' ? evidence.brief_id : '';
        return `gap:done_unchecked:${id}`;
      }
      break;
    }
    case 'conflict': {
      const ids = evidence.learning_ids;
      if (Array.isArray(ids) && ids.length === 2) {
        // Numeric sort — `learning_ids` are stored as numbers (see
        // `conflict.ts` evidence shape), so we compare numerically.
        // Without this, ids `[2, 10]` produce signature `conflict:10:2`
        // (lex order) while the evidence array stores them `[2, 10]`
        // (numeric order). Stable today but visually inconsistent.
        const sorted = (ids as Array<number | string>)
          .slice()
          .map((v) => Number(v))
          .sort((a, b) => a - b);
        return `conflict:${sorted[0]}:${sorted[1]}`;
      }
      break;
    }
    case 'pattern':
      if (typeof evidence.pattern_key === 'string' && evidence.pattern_key.length > 0) {
        return `pattern:${evidence.pattern_key}`;
      }
      break;
  }
  // Fallback: serialize sorted JSON to keep collisions confined to identical
  // evidence shapes. Keeping the module prefix avoids cross-module collisions.
  return `${module}:fallback:${stableStringify(evidence)}`;
}

/**
 * Is this finding one the operator has already dismissed?
 *
 * TD-440 implements the read side of a policy three documents have described
 * since FR-106 and NO CODE HAS EVER HAD. `recordDismissPattern` was write-only:
 * the only `SELECT` on `dismissed_patterns` was inside the recorder itself,
 * deciding INSERT vs UPDATE, so `dismiss_suppress_count` and
 * `dismiss_cooldown_days` were read by nothing. Without this function a finding
 * the operator explicitly dismissed returns on the very next run, which is most
 * of the brief's "a check that reports success" rows.
 *
 * The policy, now live:
 *   - `dismiss_count >= dismiss_suppress_count` (default 2) → suppressed
 *     permanently. Said no twice; stop asking.
 *   - one dismissal → suppressed until `dismiss_cooldown_days` (default 7) have
 *     passed since `last_dismissed_at`, then allowed back.
 *
 * Keyed on `(source_instance, project_slug, dedupe_key)` — the same composite
 * the table has always had, with the two columns REPURPOSED: `source_module`
 * carries the producer id (SIX values, written by eight sites) instead of the
 * LLM's label (195 values — TD-437's audit, 2026-09-01), and
 * `evidence_signature` carries the stable finding key. The schema, the
 * UNIQUE constraint and the `syncKey` are byte-unchanged; only the values
 * written change. Old rows simply stop matching, which is correct — their
 * signatures were keyed on a label the model re-invents every run.
 *
 * Fail-soft: a missing table or column yields `false` (never suppress on an
 * error — a spurious suppression silently loses a finding).
 */
export function isSuppressedByDismissal(
  db: Database.Database,
  sourceInstance: string,
  projectSlug: string | null,
  dedupeKey: string,
  config: DetectorConfig = DEFAULT_DETECTOR_CONFIG,
): boolean {
  try {
    const row = db
      .prepare(
        `SELECT dismiss_count,
                CASE WHEN datetime(last_dismissed_at, ?) > datetime('now')
                     THEN 1 ELSE 0 END AS in_cooldown
           FROM dismissed_patterns
          WHERE source_module = ? AND project_slug = ? AND evidence_signature = ?`,
      )
      .get(
        `+${config.dismiss_cooldown_days} days`,
        sourceInstance,
        projectSlug ?? '',
        dedupeKey,
      ) as { dismiss_count: number; in_cooldown: number } | undefined;

    if (!row) return false;
    if (row.dismiss_count >= config.dismiss_suppress_count) return true;
    return row.in_cooldown === 1;
  } catch {
    return false;
  }
}

/**
 * UPSERT a dismiss event into `dismissed_patterns`. Called from the
 * `igris_suggestion_dismiss` handler — exposed here so the handler and
 * the runner share one canonical implementation.
 *
 * On insert: dismiss_count=1, reasons=[reason] (or []).
 * On update: dismiss_count += 1, last_dismissed_at = now(), reason
 *            appended to the JSON `reasons` array (capped at the last
 *            `dismiss_reasons_cap`).
 */
export function recordDismissPattern(
  db: Database.Database,
  module: SuggestionSourceModule,
  projectSlug: string | null,
  signature: string,
  reason: string | null,
  config: DetectorConfig = DEFAULT_DETECTOR_CONFIG,
): void {
  const slug = projectSlug ?? '';
  const existing = db
    .prepare(
      `SELECT id, dismiss_count, reasons
       FROM dismissed_patterns
       WHERE source_module = ? AND project_slug = ? AND evidence_signature = ?`,
    )
    .get(module, slug, signature) as
    | { id: number; dismiss_count: number; reasons: string }
    | undefined;

  if (!existing) {
    const reasons = reason && reason.length > 0 ? [reason] : [];
    db.prepare(
      `INSERT INTO dismissed_patterns
         (source_module, project_slug, evidence_signature, dismiss_count,
          last_dismissed_at, reasons)
       VALUES (?, ?, ?, 1, datetime('now'), ?)`,
    ).run(module, slug, signature, JSON.stringify(reasons));
    return;
  }

  let parsed: string[];
  try {
    const raw: unknown = JSON.parse(existing.reasons);
    parsed = Array.isArray(raw) ? raw.map(String) : [];
  } catch {
    parsed = [];
  }
  if (reason && reason.length > 0) {
    parsed.push(reason);
    if (parsed.length > config.dismiss_reasons_cap) {
      parsed = parsed.slice(parsed.length - config.dismiss_reasons_cap);
    }
  }

  db.prepare(
    `UPDATE dismissed_patterns
       SET dismiss_count = dismiss_count + 1,
           last_dismissed_at = datetime('now'),
           reasons = ?
     WHERE id = ?`,
  ).run(JSON.stringify(parsed), existing.id);
}

// ---------------------------------------------------------------------------
// Stable JSON stringify (sorted keys) — used only by the signature fallback.
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
