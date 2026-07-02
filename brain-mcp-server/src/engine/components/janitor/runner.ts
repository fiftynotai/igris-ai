/**
 * Brain Engine v7.1 — Janitor Runner (FR-119).
 *
 * The LIVE run entry point `runJanitor` — the orchestrator that combines the
 * deterministic hygiene sweep with the near-dupe LLM extractor and writes ONE
 * `brain_maintenance_runs` audit row per invocation (Decision E):
 *
 *   1. Compute `since` = the previous run's finish time (windows the confidence
 *      bump so a re-run does not double-bump — idempotency).
 *   2. INSERT a `brain_maintenance_runs` row (status='running').
 *   3. If enabled (or forced): run the deterministic sweep — confidence bumps,
 *      stale-pending rejection, dormant re-eval surfacing. When DISABLED the
 *      sweep is GATED too (nothing runs) — the engine still emits
 *      `run_skipped reason=disabled` for observability.
 *   4. Drive the near-dupe LLM instance through `runExtractor` (the engine owns
 *      the cold-start / budget / timeout / brain-isolated LLM call / one-terminal-
 *      event-per-run lifecycle, written under `cognition.janitor.*`).
 *   5. UPDATE the audit row with the aggregated counters + status + finish time.
 *
 * The engine stays agnostic — it only ever sees the near-dupe LLM extractor
 * instance; the deterministic duties + the audit row are the runner's concern.
 * The janitor rides the engine + backend UNCHANGED, inheriting brain-isolation
 * (isolated HOME, empty mcpServers, --strict-mcp-config) for free (AC #4).
 *
 * @module engine/components/janitor/runner
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import { DEFAULT_JANITOR_CONFIG, type JanitorConfig, type JanitorRunResult } from './types.js';
import { runExtractor, type LlmExtractorGlobalConfig } from '../cognition/engine/index.js';
import {
  createJanitorInstance,
  type JanitorRunStats,
} from '../cognition/extractors/janitor.js';
import {
  createArbiterInstance,
  type ArbiterRunStats,
} from '../cognition/extractors/arbiter.js';
import {
  createCuratorInstance,
  type CuratorRunStats,
} from '../cognition/extractors/curator.js';
import type { ArbiterConfig } from '../arbiter/types.js';
import type { CuratorConfig } from '../curator/types.js';
import type { Embedder } from './candidates.js';
import {
  applyConfidenceBumps,
  rejectStalePending,
  surfaceReEvalRejections,
} from './hygiene.js';

/** Options for `runJanitor`. */
export interface RunJanitorOptions {
  /** The resolved janitor instance config (envelope + candidate/hygiene knobs). */
  config?: JanitorConfig;
  /**
   * The resolved arbiter instance config (FR-116 M2, Decision #4A). When present,
   * the runner CO-DRIVES the arbiter contradiction extractor sequentially after
   * the near-dupe extractor, aggregating its counters into the SAME
   * `brain_maintenance_runs` audit row. Absent → the arbiter is not driven (the
   * near-dupe path is byte-for-byte unchanged — additive). Production always
   * passes it (gated by `cognition.janitor.enabled`); tests opt in.
   */
  arbiterConfig?: ArbiterConfig;
  /**
   * The resolved curator instance config (FR-116 M3, Decision #4A). When present,
   * the runner CO-DRIVES the curator outdated-pruning extractor sequentially after
   * the arbiter, aggregating its counters into the SAME `brain_maintenance_runs`
   * audit row + surfacing the anomaly warning. Absent → the curator is not driven
   * (the near-dupe + arbiter paths are byte-for-byte unchanged — additive).
   * Production always passes it (gated by `cognition.janitor.enabled`); tests opt in.
   */
  curatorConfig?: CuratorConfig;
  /** The global `llm_extractor` config (harness default + fallback order). */
  globalConfig?: LlmExtractorGlobalConfig;
  /** Bypass the cold-start + bytes cost gate (manual `*_run` forces a run). */
  force?: boolean;
  /** What triggered this run ('cron' | 'manual' | a test tag) — observability. */
  trigger?: string;
  /** Injectable embedder seam for the near-dupe extractor (tests: a deterministic embedder). */
  embed?: Embedder;
  /** Injectable embedder seam for the arbiter extractor (defaults to `embed`). */
  arbiterEmbed?: Embedder;
  /**
   * Injectable engine seams (for tests: a mocked backend, a stubbed cold-start
   * probe). Forwarded verbatim to `runExtractor`'s `deps`.
   */
  deps?: Parameters<typeof runExtractor>[3];
}

/** The previous run's finish time (windows the confidence-bump tally). */
function lastFinishedAt(db: Database.Database): string | null {
  try {
    const row = db
      .prepare(
        `SELECT MAX(finished_at) AS ts FROM brain_maintenance_runs WHERE finished_at IS NOT NULL`,
      )
      .get() as { ts: string | null } | undefined;
    return row?.ts ?? null;
  } catch {
    return null;
  }
}

/**
 * Run the janitor ONCE (FR-119): deterministic hygiene sweep + near-dupe LLM
 * extractor, aggregated into one `brain_maintenance_runs` audit row. The
 * schedule (`janitor_engine`, daily 04:00) hits THIS via `igris_janitor_run_now`.
 *
 * @param db      the brain DB
 * @param project the project scope ('all' = whole brain)
 * @param options config + global config + force/trigger + injectable seams
 */
export async function runJanitor(
  db: Database.Database,
  project = 'all',
  options: RunJanitorOptions = {},
): Promise<JanitorRunResult> {
  const config = options.config ?? DEFAULT_JANITOR_CONFIG;
  const force = options.force === true;
  const trigger = options.trigger ?? 'manual';
  const runId = `janitor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 1. Window the confidence-bump tally on the PREVIOUS run's finish time.
  const since = lastFinishedAt(db);

  // 2. Open the audit row (status='running').
  let runRowId: number | null = null;
  try {
    const res = db
      .prepare(
        `INSERT INTO brain_maintenance_runs (run_id, trigger, status)
         VALUES (?, ?, 'running')`,
      )
      .run(runId, trigger);
    runRowId = Number(res.lastInsertRowid);
  } catch {
    /* brain_maintenance_runs absent (schema not applied) — proceed without audit */
  }

  // 3. Deterministic sweep — GATED behind enabled (unless forced), mirroring the
  //    engine's disabled gate so the whole janitor is one on/off switch.
  let confidenceBumps = 0;
  let staleRejected = 0;
  let reEvalSurfaced = 0;
  if (config.enabled || force) {
    confidenceBumps = applyConfidenceBumps(db, config, since, runId);
    staleRejected = rejectStalePending(db, config);
    reEvalSurfaced = surfaceReEvalRejections(db, config, since);
  }

  // 4. Near-dupe LLM extractor through the agnostic engine.
  const stats: JanitorRunStats = { proposed: 0, applied: 0 };
  const instance = createJanitorInstance(config, { embed: options.embed, stats });
  const deps = {
    ...(options.globalConfig ? { globalConfig: options.globalConfig } : {}),
    ...(options.deps ?? {}),
  };
  const extractor = await runExtractor(
    db,
    instance,
    {
      project,
      trigger,
      ...(force ? { force: true } : {}),
    },
    deps,
  );

  // 4b. FR-116 M2 (Decision #4A/#9): CO-DRIVE the arbiter contradiction extractor
  //     sequentially, aggregating its counters into the SAME audit row. Only when
  //     an arbiterConfig is supplied — the near-dupe path above is unchanged.
  const arbiterStats: ArbiterRunStats = { proposed: 0, resolved: 0 };
  let arbiterOutcome: JanitorRunResult['arbiter_outcome'];
  if (options.arbiterConfig) {
    const arbiterInstance = createArbiterInstance(options.arbiterConfig, {
      embed: options.arbiterEmbed ?? options.embed,
      stats: arbiterStats,
    });
    const arbiterExtractor = await runExtractor(
      db,
      arbiterInstance,
      {
        project,
        trigger,
        ...(force ? { force: true } : {}),
      },
      deps,
    );
    arbiterOutcome = arbiterExtractor.outcome;
  }

  // 4c. FR-116 M3 (Decision #4A/#9): CO-DRIVE the curator outdated-pruning
  //     extractor sequentially, aggregating its counters into the SAME audit row.
  //     Only when a curatorConfig is supplied — the paths above are unchanged. The
  //     runId is threaded so auto-pruned rows are undoable by run (Decision #2).
  const curatorStats: CuratorRunStats = { proposed: 0, pruned: 0, prune_intent: 0, anomaly: false };
  let curatorOutcome: JanitorRunResult['curator_outcome'];
  if (options.curatorConfig) {
    const curatorInstance = createCuratorInstance(options.curatorConfig, {
      stats: curatorStats,
      runId,
    });
    const curatorExtractor = await runExtractor(
      db,
      curatorInstance,
      {
        project,
        trigger,
        ...(force ? { force: true } : {}),
      },
      deps,
    );
    curatorOutcome = curatorExtractor.outcome;
  }

  // FR-116 M3: the anomaly safety-valve warning (Section F) — surfaced in the run
  // result AND stamped on the audit row when a single run's prune intent exceeds
  // the configured threshold.
  const warning = curatorStats.anomaly
    ? `ANOMALY: this run's prune intent (${curatorStats.prune_intent}) exceeded the ` +
      `configured threshold (${options.curatorConfig?.anomaly_threshold ?? 50}); ` +
      `auto-prune was capped and excess prunes were queued for review.`
    : undefined;

  // 5. Close the audit row. When disabled (and not forced) the run is 'skipped'
  //    regardless of the extractor's own skip; otherwise mirror the extractor.
  const status = !config.enabled && !force ? 'skipped' : extractor.outcome;
  const reason = extractor.skip_reason ?? extractor.fail_reason;
  if (runRowId !== null) {
    try {
      db.prepare(
        `UPDATE brain_maintenance_runs
           SET finished_at = datetime('now'),
               status = ?,
               merges_proposed = ?,
               merges_applied = ?,
               confidence_bumps = ?,
               stale_rejected = ?,
               re_eval_surfaced = ?,
               contradictions_proposed = ?,
               contradictions_resolved = ?,
               outdated_proposed = ?,
               outdated_pruned = ?,
               error_message = ?
         WHERE id = ?`,
      ).run(
        status,
        stats.proposed,
        stats.applied,
        confidenceBumps,
        staleRejected,
        reEvalSurfaced,
        arbiterStats.proposed,
        arbiterStats.resolved,
        curatorStats.proposed,
        curatorStats.pruned,
        extractor.fail_reason ?? null,
        runRowId,
      );
    } catch {
      /* audit update best-effort — never fail a run on the audit write */
    }
  }

  return {
    run_id: runId,
    outcome: extractor.outcome,
    merges_proposed: stats.proposed,
    merges_applied: stats.applied,
    confidence_bumps: confidenceBumps,
    stale_rejected: staleRejected,
    re_eval_surfaced: reEvalSurfaced,
    contradictions_proposed: arbiterStats.proposed,
    contradictions_resolved: arbiterStats.resolved,
    outdated_proposed: curatorStats.proposed,
    outdated_pruned: curatorStats.pruned,
    undone: 0,
    prune_anomaly: curatorStats.anomaly,
    ...(arbiterOutcome ? { arbiter_outcome: arbiterOutcome } : {}),
    ...(curatorOutcome ? { curator_outcome: curatorOutcome } : {}),
    ...(warning ? { warning } : {}),
    ...(reason ? { reason } : {}),
  };
}
