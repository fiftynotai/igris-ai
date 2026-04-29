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
    };

export interface RunOptions {
  config?: DetectorConfig;
}

/**
 * Run the full detector pipeline once. Returns a summary including the
 * per-candidate events the handler will emit on the bus — the runner
 * itself never touches the bus, both to keep it testable and to keep
 * every literal `bus.emit('subconscious.*', ...)` call inside the
 * files the integrity scanner reads.
 *
 * Phase 1 invokes `stalled` + `gap`; Phase 2 will append `conflict` +
 * `pattern` here without changing the runner contract.
 */
export function runAllDetectors(
  db: Database.Database,
  options: RunOptions = {},
): RunSummary {
  const config = options.config ?? DEFAULT_DETECTOR_CONFIG;

  // 1. Auto-expire — DELETE on the raw db. Idempotent; uses the same
  //    config knobs as the detectors so a test can shrink the windows.
  const expired = expireStaleRows(db, config);

  // 2. Run detectors against a read-only view.
  const roDb = makeReadOnlyDb(db);
  const candidates: SuggestionCandidate[] = [
    ...detectStalled(roDb, config),
    ...detectGap(roDb, config),
  ];

  // 3. Persist with dismiss-loop suppression and within-run dedupe.
  const summary: RunSummary = {
    emitted: 0,
    suppressed: 0,
    by_module: { stalled: 0, conflict: 0, gap: 0, pattern: 0 },
    expired_pending: expired.pending,
    expired_dismissed: expired.dismissed,
    events: [],
  };

  // Snapshot existing pending suggestions once for fast dedupe.
  // Dedupe key uses evidence_signature (stable across days) rather than title
  // (which can drift — e.g. "stalled for N days" increments daily).
  const existingPending = getExistingPendingKeys(db);

  for (const candidate of candidates) {
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
  }

  return summary;
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
        const sorted = [...ids].map(String).sort((a, b) => a.localeCompare(b));
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
 * `pending_ttl_days` and dismissed ones older than `dismissed_ttl_days`
 * are deleted in two separate statements so the change counts can be
 * reported.
 */
function expireStaleRows(
  db: Database.Database,
  config: DetectorConfig,
): { pending: number; dismissed: number } {
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
  return {
    pending: pendingResult.changes ?? 0,
    dismissed: dismissedResult.changes ?? 0,
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
