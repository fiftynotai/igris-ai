/**
 * Brain Engine v5.0 — Subconscious Runner
 *
 * Orchestrates the detector pipeline (FR-106 Phase 1):
 *   1. Auto-expire stale rows (pending >30d, dismissed >90d).
 *   2. Wrap the raw `Database` in a `ReadOnlyDb` and invoke each enabled
 *      detector. Detectors return SuggestionCandidate[].
 *   3. For each candidate: compute its evidence_signature, look up the
 *      `dismissed_patterns` table, and either suppress (with event) or
 *      persist (with event).
 *   4. Within a single run, dedupe candidates by (source_module,
 *      project_slug, title) against existing pending rows.
 *   5. Optionally emit aggregate run_start/run_complete events.
 *
 * The detectors only see the read-only handle. The runner — and only the
 * runner — uses the raw `Database` for writes. This is the single
 * point where read-only intent crosses into write intent.
 *
 * Dismiss-reason learning loop (Q3=B in Phase 1 answers):
 *   - Suggestion `evidence` is canonicalized into a stable string per
 *     module (see `computeEvidenceSignature`).
 *   - Dismissing a suggestion UPSERTS the signature into
 *     `dismissed_patterns`. After `dismiss_suppress_count` dismisses,
 *     all future suggestions with that signature are suppressed.
 *     Single-dismiss signatures are silenced for `dismiss_cooldown_days`
 *     and then allowed to re-emit.
 *
 * @module engine/components/subconscious/runner
 * @author Fifty.ai
 */

import type Database from 'better-sqlite3';
import { makeReadOnlyDb } from './readonly-db.js';
import {
  type DetectorConfig,
  DEFAULT_DETECTOR_CONFIG,
  type SuggestionCandidate,
  type SuggestionSourceModule,
} from './types.js';
import { detectStalled } from './detectors/stalled.js';
import { detectGap } from './detectors/gap.js';
import { detectConflict } from './detectors/conflict.js';
import { detectPattern } from './detectors/pattern.js';
import {
  type ConflictVerifier,
  type VerifierLearning,
  noopVerifier,
} from './verifier.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Aggregate result returned by `runAllDetectors`. */
export interface RunSummary {
  emitted: number;
  suppressed: number;
  by_module: Record<SuggestionSourceModule, number>;
  expired_pending: number;
  expired_dismissed: number;
  /** Pattern observation rows pruned by `expireStaleRows` (Phase 2). */
  expired_observations: number;
  /** Per-suggestion events the caller should bus.emit; kept here so the
   *  runner remains pure and the event-bus integrity scanner (which only
   *  inspects index.ts / handlers.ts / daemon.ts) sees the literal
   *  bus.emit() calls in the handler layer. */
  events: RunEvent[];
}

export type RunEvent =
  | {
      kind: 'suggestion_emitted';
      source_module: SuggestionSourceModule;
      project_slug: string | null;
      title: string;
      priority: string;
    }
  | {
      kind: 'suggestion_suppressed';
      source_module: SuggestionSourceModule;
      project_slug: string | null;
      evidence_signature: string;
    }
  | {
      kind: 'suggestion_verified';
      source_module: SuggestionSourceModule;
      project_slug: string | null;
      title: string;
      verifier_status: string;
    }
  | {
      kind: 'suggestion_rejected_by_verifier';
      source_module: SuggestionSourceModule;
      project_slug: string | null;
      title: string;
      verifier_reason: string;
    };

export interface RunOptions {
  config?: DetectorConfig;
  /** Optional LLM verifier (FR-108). Defaults to `noopVerifier` (heuristic-only). */
  verifier?: ConflictVerifier;
}

/**
 * Run the full detector pipeline once. Returns a summary including the
 * per-candidate events the handler will emit on the bus — the runner
 * itself never touches the bus, both to keep it testable and to keep
 * every literal `bus.emit('subconscious.*', ...)` call inside the
 * files the integrity scanner reads.
 *
 * Phase 1 invoked `stalled` + `gap`. Phase 2 appends `conflict` +
 * `pattern`; pattern candidates pass through `smoothPatterns` (3-run
 * gate) before joining the dedupe + suppression pipeline.
 *
 * `runId` is generated once at the top and threaded through the
 * smoothing helper. A single `new Date().toISOString()` is unique enough
 * for a 6-hourly schedule plus manual fires (sub-second double-fires
 * still produce distinct ISO strings — different milliseconds).
 */
export async function runAllDetectors(
  db: Database.Database,
  options: RunOptions = {},
): Promise<RunSummary> {
  const config = options.config ?? DEFAULT_DETECTOR_CONFIG;
  const verifier = options.verifier ?? noopVerifier;
  const runId = new Date().toISOString();

  // 1. Auto-expire — DELETE on the raw db. Idempotent; uses the same
  //    config knobs as the detectors so a test can shrink the windows.
  const expired = expireStaleRows(db, config);

  // 2. Run detectors against a read-only view.
  const roDb = makeReadOnlyDb(db);
  const rawCandidates: SuggestionCandidate[] = [
    ...detectStalled(roDb, config),
    ...detectGap(roDb, config),
    ...detectConflict(roDb, config),
    ...detectPattern(roDb, config),
  ];

  // 2a. LLM verifier gate (FR-108). Only conflict-class candidates are
  //     submitted; the verifier is heuristic-first (only ratifies what
  //     the cosine/Jaccard heuristic short-listed). Defensive default:
  //     anything that isn't an explicit, parsed `{is_conflict: false}`
  //     reply preserves the candidate — a missing CLI, parse failure, or
  //     timeout MUST NOT silently drop a heuristic signal. Rejection
  //     events are returned so handlers can emit them on the bus.
  //
  //     PERF: sequential `await` loop. Worst-case (5 conflict candidates
  //     per project × 10 projects × ~30s) ≈ 25 min, comfortably inside
  //     the 6h cron interval. Parallelize via `Promise.all` if profiling
  //     ever shows pipeline duration as a concern — future TD.
  const { kept: verifierKept, rejectionEvents } =
    await verifyConflictCandidates(db, rawCandidates, verifier);
  const candidates: SuggestionCandidate[] = verifierKept;

  // 3. Smooth pattern candidates against `pattern_observations`. Patterns
  //    that haven't appeared in `pattern_smoothing_runs` distinct runs
  //    within the recency window are dropped here BEFORE dedupe and
  //    suppression. This is a write step (records the current
  //    observations) but it only writes to `pattern_observations`,
  //    which is internal to this component.
  const smoothed = smoothPatterns(db, candidates, runId, config);

  // 4. Persist with dismiss-loop suppression and within-run dedupe.
  const summary: RunSummary = {
    emitted: 0,
    suppressed: 0,
    by_module: { stalled: 0, conflict: 0, gap: 0, pattern: 0 },
    expired_pending: expired.pending,
    expired_dismissed: expired.dismissed,
    expired_observations: expired.observations,
    events: [...rejectionEvents],
  };

  // Snapshot existing pending suggestions once for fast dedupe.
  // Dedupe key uses evidence_signature (stable across days) rather than title
  // (which can drift — e.g. "stalled for N days" increments daily).
  const existingPending = getExistingPendingKeys(db);

  for (const candidate of smoothed) {
    const signature = computeEvidenceSignature(
      candidate.source_module,
      candidate.evidence,
    );
    const dedupeKey = `${candidate.source_module}|${candidate.project_slug ?? ''}|${signature}`;
    if (existingPending.has(dedupeKey)) continue;

    if (shouldSuppress(db, candidate, signature, config)) {
      summary.suppressed += 1;
      summary.events.push({
        kind: 'suggestion_suppressed',
        source_module: candidate.source_module,
        project_slug: candidate.project_slug,
        evidence_signature: signature,
      });
      continue;
    }

    insertSuggestion(db, candidate, config);
    existingPending.add(dedupeKey);
    summary.emitted += 1;
    summary.by_module[candidate.source_module] += 1;
    summary.events.push({
      kind: 'suggestion_emitted',
      source_module: candidate.source_module,
      project_slug: candidate.project_slug,
      title: candidate.title,
      priority: candidate.priority,
    });

    // Companion `suggestion_verified` event for conflict-class candidates
    // that survived the verifier gate. Lets dashboards track verifier
    // yield (verified vs rejected_by_verifier) independently of the
    // dismiss-loop suppression signal.
    if (candidate.source_module === 'conflict') {
      const verifierStatus =
        ((candidate.evidence as Record<string, unknown>).verifier_status as string | undefined) ??
        'cli_missing';
      summary.events.push({
        kind: 'suggestion_verified',
        source_module: candidate.source_module,
        project_slug: candidate.project_slug,
        title: candidate.title,
        verifier_status: verifierStatus,
      });
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Verifier helper (FR-108)
// ---------------------------------------------------------------------------

/**
 * Run the LLM verifier over conflict-class candidates only. Non-conflict
 * candidates pass through unchanged.
 *
 * For each conflict candidate:
 *   - Look up the two learnings by id (content + created_at) in a single
 *     `WHERE id IN (?, ?)` query so the verifier prompt has the full
 *     content body, not just the heuristic numbers.
 *   - Call `await verifier(a, b)`.
 *   - If `is_conflict === false` AND `status === 'verified'` → drop the
 *     candidate; emit a `suggestion_rejected_by_verifier` event.
 *   - Otherwise → keep the candidate, enrich `evidence` with
 *     `verifier`, `verifier_status`, `verifier_reason`, `verified_at`.
 *
 * Returns `{ kept, rejectionEvents }`. The kept array preserves input
 * order across both conflict and non-conflict modules so downstream
 * dedupe / smoothing sees a stable iteration order.
 *
 * Failure path: if the learnings table is missing or the lookup throws,
 * we pass conflict candidates through UNCHANGED (defensive default —
 * surface heuristic signals rather than swallow them).
 */
async function verifyConflictCandidates(
  db: Database.Database,
  candidates: SuggestionCandidate[],
  verifier: ConflictVerifier,
): Promise<{ kept: SuggestionCandidate[]; rejectionEvents: RunEvent[] }> {
  const kept: SuggestionCandidate[] = [];
  const rejectionEvents: RunEvent[] = [];
  const verifiedAt = new Date().toISOString();

  // Cache learnings as we look them up — multiple candidate pairs may
  // overlap on the same learning id (one popular learning can collide
  // with several others within the same project sweep).
  const learningCache = new Map<number, VerifierLearning | null>();
  const fetchLearning = (id: number): VerifierLearning | null => {
    if (learningCache.has(id)) return learningCache.get(id) ?? null;
    let row: { id: number; content: string; created_at: string } | undefined;
    try {
      row = db
        .prepare(`SELECT id, content, created_at FROM learnings WHERE id = ?`)
        .get(id) as { id: number; content: string; created_at: string } | undefined;
    } catch {
      row = undefined;
    }
    const value = row ? { id: row.id, content: row.content, created_at: row.created_at } : null;
    learningCache.set(id, value);
    return value;
  };

  for (const c of candidates) {
    if (c.source_module !== 'conflict') {
      kept.push(c);
      continue;
    }

    const ids = (c.evidence as Record<string, unknown>).learning_ids;
    if (!Array.isArray(ids) || ids.length !== 2) {
      // Malformed evidence — keep the candidate (defensive default), tag
      // verifier_status so triage can see the verifier was bypassed.
      kept.push({
        ...c,
        evidence: {
          ...c.evidence,
          verifier: 'claude-headless',
          verifier_status: 'parse_failed',
          verifier_reason: 'malformed evidence.learning_ids',
          verified_at: verifiedAt,
        },
      });
      continue;
    }

    const aId = Number(ids[0]);
    const bId = Number(ids[1]);
    const a = fetchLearning(aId);
    const b = fetchLearning(bId);
    if (!a || !b) {
      // Lookup failure — defensive default, keep the candidate.
      kept.push({
        ...c,
        evidence: {
          ...c.evidence,
          verifier: 'claude-headless',
          verifier_status: 'parse_failed',
          verifier_reason: 'learning lookup failed',
          verified_at: verifiedAt,
        },
      });
      continue;
    }

    let result;
    try {
      result = await verifier(a, b);
    } catch (err) {
      // Verifier itself threw — defensive default, keep the candidate.
      kept.push({
        ...c,
        evidence: {
          ...c.evidence,
          verifier: 'claude-headless',
          verifier_status: 'spawn_failed',
          verifier_reason: err instanceof Error ? err.message : String(err),
          verified_at: verifiedAt,
        },
      });
      continue;
    }

    // Only an explicit, parse-clean rejection drops the candidate.
    if (result.is_conflict === false && result.status === 'verified') {
      rejectionEvents.push({
        kind: 'suggestion_rejected_by_verifier',
        source_module: c.source_module,
        project_slug: c.project_slug,
        title: c.title,
        verifier_reason: result.reason,
      });
      continue;
    }

    // Keep the candidate, enrich evidence with verifier metadata.
    kept.push({
      ...c,
      evidence: {
        ...c.evidence,
        verifier: 'claude-headless',
        verifier_status: result.status,
        verifier_reason: result.reason,
        verified_at: verifiedAt,
      },
    });
  }

  return { kept, rejectionEvents };
}

// ---------------------------------------------------------------------------
// Pattern smoothing helper (Phase 2)
// ---------------------------------------------------------------------------

/**
 * Pattern smoothing: record this run's pattern observations, then gate
 * each candidate on whether `pattern_observations` has at least
 * `pattern_smoothing_runs` distinct `run_id` values for the same
 * `pattern_key` within `pattern_smoothing_window_days`.
 *
 * Record-then-gate ordering: this run's observation IS counted toward
 * the threshold, so on the 3rd consecutive run the candidate emits in
 * the same run rather than waiting for a 4th. This matches the spirit
 * of "persists across last 3 runs" most naturally.
 *
 * Non-pattern candidates pass through unchanged. Returns a single merged
 * array preserving the original (stalled, gap, conflict, pattern) order.
 *
 * Fail-soft on missing `pattern_observations` table (mirrors
 * `expireStaleRows`): if the v2 migration hasn't applied (e.g. partial
 * Phase 1-only schema during a rollout), the INSERT will throw "no such
 * table". We catch it once for both the INSERT loop and the gating
 * SELECT (both depend on the same table), then let pattern candidates
 * pass through UNFILTERED — preferable to silently dropping them, since
 * the smoothing gate is a noise-reduction layer, not a correctness one.
 */
function smoothPatterns(
  db: Database.Database,
  candidates: SuggestionCandidate[],
  runId: string,
  config: DetectorConfig,
): SuggestionCandidate[] {
  const patternCandidates: SuggestionCandidate[] = [];
  const otherCandidates: SuggestionCandidate[] = [];
  for (const c of candidates) {
    if (c.source_module === 'pattern') patternCandidates.push(c);
    else otherCandidates.push(c);
  }
  if (patternCandidates.length === 0) return candidates;

  try {
    // Record observations FIRST so the gate sees the current run.
    const insertObservation = db.prepare(
      `INSERT INTO pattern_observations
         (pattern_key, run_id, effect_size, sample_size, metadata)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const c of patternCandidates) {
      const ev = c.evidence as Record<string, unknown>;
      const patternKey =
        typeof ev.pattern_key === 'string' && ev.pattern_key.length > 0
          ? ev.pattern_key
          : '';
      if (patternKey === '') continue; // defensive — should never happen
      const effectSize = typeof ev.effect === 'number' ? ev.effect : 0;
      const sampleSize = typeof ev.sample_size === 'number' ? ev.sample_size : 0;
      insertObservation.run(
        patternKey,
        runId,
        effectSize,
        sampleSize,
        JSON.stringify(ev),
      );
    }

    // THEN gate. Distinct-run count over the recency window.
    const distinctRunsStmt = db.prepare(
      `SELECT COUNT(DISTINCT run_id) AS n
       FROM pattern_observations
       WHERE pattern_key = ?
         AND julianday('now') - julianday(observed_at) <= ?`,
    );
    const eligible: SuggestionCandidate[] = [];
    for (const c of patternCandidates) {
      const ev = c.evidence as Record<string, unknown>;
      const patternKey =
        typeof ev.pattern_key === 'string' && ev.pattern_key.length > 0
          ? ev.pattern_key
          : '';
      if (patternKey === '') continue;
      const row = distinctRunsStmt.get(
        patternKey,
        config.pattern_smoothing_window_days,
      ) as { n: number };
      if (row.n >= config.pattern_smoothing_runs) eligible.push(c);
    }

    return [...otherCandidates, ...eligible];
  } catch (err) {
    // pattern_observations absent (Phase 1 schema only) — fail-soft.
    // Pass pattern candidates through unfiltered rather than drop them
    // silently; smoothing is a noise gate, not a correctness gate.
    console.warn(
      '[subconscious] pattern smoothing skipped (no such table: pattern_observations?); pattern candidates passing through unfiltered:',
      err instanceof Error ? err.message : String(err),
    );
    return [...otherCandidates, ...patternCandidates];
  }
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
 * Decide whether to suppress a candidate based on `dismissed_patterns`.
 *
 * Rules (FR-106 Phase 1, Q3=B):
 *   - dismiss_count >= dismiss_suppress_count : always suppress.
 *   - dismiss_count == 1 and dismissed within dismiss_cooldown_days days
 *     : suppress (let the cooldown elapse before re-emitting).
 *   - otherwise : allow (re-emit).
 */
function shouldSuppress(
  db: Database.Database,
  candidate: SuggestionCandidate,
  signature: string,
  config: DetectorConfig,
): boolean {
  const row = db
    .prepare(
      `SELECT dismiss_count, last_dismissed_at
       FROM dismissed_patterns
       WHERE source_module = ?
         AND project_slug = ?
         AND evidence_signature = ?`,
    )
    .get(
      candidate.source_module,
      candidate.project_slug ?? '',
      signature,
    ) as { dismiss_count: number; last_dismissed_at: string } | undefined;

  if (!row) return false;
  if (row.dismiss_count >= config.dismiss_suppress_count) return true;

  // Single-dismiss path: cooldown gate.
  const cooldownDays = config.dismiss_cooldown_days;
  const elapsed = db
    .prepare(
      `SELECT CAST(julianday('now') - julianday(?) AS REAL) AS days`,
    )
    .get(row.last_dismissed_at) as { days: number };
  return elapsed.days < cooldownDays;
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
// Persistence + expiry helpers
// ---------------------------------------------------------------------------

/**
 * Auto-expire stale rows. Pending suggestions older than
 * `pending_ttl_days`, dismissed ones older than `dismissed_ttl_days`,
 * and pattern_observations older than `pattern_observation_ttl_days`
 * (Phase 2) are deleted in three separate statements so the change
 * counts can be reported individually.
 *
 * pattern_observations is a working table — it can be missing if the v2
 * migration hasn't applied (e.g. tests using only Phase 1 schema). We
 * try/catch the DELETE so an absent table reports `observations: 0`
 * rather than aborting the whole run.
 */
function expireStaleRows(
  db: Database.Database,
  config: DetectorConfig,
): { pending: number; dismissed: number; observations: number } {
  const pendingResult = db
    .prepare(
      `DELETE FROM suggestions
       WHERE status = 'pending'
         AND julianday('now') - julianday(created_at) > ?`,
    )
    .run(config.pending_ttl_days);
  const dismissedResult = db
    .prepare(
      `DELETE FROM suggestions
       WHERE status = 'dismissed'
         AND dismissed_at IS NOT NULL
         AND julianday('now') - julianday(dismissed_at) > ?`,
    )
    .run(config.dismissed_ttl_days);
  let observations = 0;
  try {
    const obsResult = db
      .prepare(
        `DELETE FROM pattern_observations
         WHERE julianday('now') - julianday(observed_at) > ?`,
      )
      .run(config.pattern_observation_ttl_days);
    observations = obsResult.changes ?? 0;
  } catch {
    // pattern_observations table absent (Phase 1 schema only) — fail-soft.
    observations = 0;
  }
  return {
    pending: pendingResult.changes ?? 0,
    dismissed: dismissedResult.changes ?? 0,
    observations,
  };
}

/**
 * Snapshot existing pending suggestions to skip in-run duplicates.
 * Keys by evidence_signature (stable across days) so cron runs don't
 * accumulate near-identical rows when titles drift (e.g. "stalled for N days").
 */
function getExistingPendingKeys(db: Database.Database): Set<string> {
  const rows = db
    .prepare(
      `SELECT source_module, project_slug, evidence FROM suggestions WHERE status = 'pending'`,
    )
    .all() as { source_module: string; project_slug: string | null; evidence: string | null }[];
  const set = new Set<string>();
  for (const row of rows) {
    let evidence: Record<string, unknown> = {};
    if (row.evidence) {
      try {
        evidence = JSON.parse(row.evidence) as Record<string, unknown>;
      } catch {
        // Malformed evidence — fall back to empty object; produces a stable
        // signature distinct from well-formed candidates.
      }
    }
    const signature = computeEvidenceSignature(row.source_module as SuggestionCandidate['source_module'], evidence);
    set.add(`${row.source_module}|${row.project_slug ?? ''}|${signature}`);
  }
  return set;
}

function insertSuggestion(
  db: Database.Database,
  candidate: SuggestionCandidate,
  config: DetectorConfig,
): void {
  db.prepare(
    `INSERT INTO suggestions
       (source_module, project_slug, title, evidence, priority, status,
        created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'),
             datetime('now', ?))`,
  ).run(
    candidate.source_module,
    candidate.project_slug,
    candidate.title,
    JSON.stringify(candidate.evidence),
    candidate.priority,
    `+${config.pending_ttl_days} days`,
  );
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
