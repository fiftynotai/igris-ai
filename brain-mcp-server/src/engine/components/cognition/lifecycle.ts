/**
 * Brain Engine v7.1 — Cognition lifecycle events (FR-118 M0; generalizes TD-074).
 *
 * The single source of truth for cognition observability. Generalized from
 * `perception/events.ts:writePerceptionEvent`: the row shape is identical
 * (`monitoring.onEventReceived`'s columns) — only the `component` column now
 * VARIES per instance (`cognition.<instance>` instead of the literal
 * `'perception'`). The detached extract CLI runs without an in-process
 * EventEmitter (no `bootEngine()`), so any `bus.emit()` would silently no-op;
 * this module writes `event_log` directly so a single read path
 * (`igris_event_log` filtered by `component='cognition.<instance>'`) covers all
 * runs regardless of which process produced them.
 *
 * Defensive contract (unchanged from TD-074): emission failure must NEVER abort
 * the pipeline — the INSERT is wrapped in try/catch and falls back to a single
 * stderr line.
 *
 * THE ONE-TERMINAL-EVENT-PER-RUN INVARIANT (TD-074) lives here, in
 * `makeRunEmitter`: exactly one of `run_succeeded` / `run_failed` /
 * `run_skipped` is written per `run_started`. The engine drives all writes
 * through the returned emitter so a pre-emitted terminal event (e.g. a backend
 * EPIPE) suppresses any trailing terminal event.
 *
 * @module engine/components/cognition/lifecycle
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Event names
// ---------------------------------------------------------------------------

/**
 * The lifecycle stage suffixes appended to `cognition.<instance>.`. Stored
 * verbatim in `event_log.event_name`. The terminal set is
 * {run_succeeded, run_failed, run_skipped} — exactly one fires per run_started.
 */
export type CognitionStage =
  | 'run_started'
  | 'run_succeeded'
  | 'run_failed'
  | 'run_skipped';

/** The three terminal stages — used by the one-terminal-event invariant. */
const TERMINAL_STAGES: ReadonlySet<CognitionStage> = new Set<CognitionStage>([
  'run_succeeded',
  'run_failed',
  'run_skipped',
]);

/**
 * Build the fully-qualified event name for a stage of an instance.
 * e.g. componentName('perception') === 'cognition.perception';
 * eventName('perception','run_started') === 'cognition.perception.run_started'.
 */
export function componentName(instanceId: string): string {
  return `cognition.${instanceId}`;
}

/** The fully-qualified `event_log.event_name` for a stage. */
export function eventName(instanceId: string, stage: CognitionStage): string {
  return `${componentName(instanceId)}.${stage}`;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Insert a single cognition lifecycle row into `event_log`. Mirrors the column
 * shape `monitoring.onEventReceived` writes for bus-driven events.
 *
 * `component` = `cognition.<instanceId>` (the per-instance namespace — what
 * varies from the perception-specific writer). `payload.project` is hoisted
 * into the dedicated `project_slug` column so the `igris_event_log` MCP filter
 * and the `/scan` query path both work without parsing the JSON blob.
 *
 * Failure mode (TD-074 defensive contract): any thrown error is caught and
 * surfaced as a single stderr line — the pipeline continues; observability must
 * never gate the actual extraction work.
 *
 * @param db         the brain DB
 * @param instanceId the instance id (the `component` column becomes `cognition.<id>`)
 * @param stage      the lifecycle stage
 * @param payload    arbitrary JSON payload (a `project` field is hoisted)
 */
export function writeExtractorEvent(
  db: Database.Database,
  instanceId: string,
  stage: CognitionStage,
  payload: Record<string, unknown>,
): void {
  try {
    const projectSlug =
      typeof payload.project === 'string' ? payload.project : null;
    db.prepare(
      `INSERT INTO event_log
         (event_name, component, payload, machine_hostname, project_slug, instance_id, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, datetime('now'))`,
    ).run(
      eventName(instanceId, stage),
      componentName(instanceId),
      JSON.stringify(payload),
      os.hostname(),
      projectSlug,
    );
  } catch (err) {
    // Defensive fallback. Grep-able even though the structured event was lost.
    process.stderr.write(
      `[cognition.lifecycle] write failed for ${eventName(instanceId, stage)}: ${
        err instanceof Error ? err.message : String(err)
      } payload=${JSON.stringify(payload)}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// One-terminal-event-per-run emitter (the TD-074 invariant)
// ---------------------------------------------------------------------------

/** A run-scoped emitter that enforces the one-terminal-event invariant. */
export interface RunEmitter {
  /** Write a lifecycle row; terminal events after the first are suppressed. */
  emit(stage: CognitionStage, payload?: Record<string, unknown>): void;
  /** Whether a terminal event (succeeded/failed/skipped) has already fired. */
  readonly terminalEmitted: boolean;
}

/**
 * Create a run-scoped emitter for one `runExtractor` invocation. EVERY
 * lifecycle write for a run goes through this emitter so the
 * one-terminal-event-per-run invariant (TD-074) is enforced in ONE place:
 *
 *  - `run_started` may always be written (it is non-terminal).
 *  - the FIRST terminal stage (succeeded | failed | skipped) is written and
 *    flips `terminalEmitted`.
 *  - any SUBSEQUENT terminal write is silently dropped — so a backend that
 *    pre-emits `run_failed` (EPIPE/timeout) suppresses the engine's trailing
 *    `run_succeeded`, and no run can ever surface as "stuck RUNNING" (a
 *    run_started with no terminal) NOR double-report.
 *
 * Each event is auto-tagged with the run's project + trigger + a
 * `duration_ms` measured from emitter creation, mirroring the perception
 * runner's envelope.
 *
 * @param db         the brain DB
 * @param instanceId the instance id
 * @param base       fields stamped onto every event (project, trigger)
 */
export function makeRunEmitter(
  db: Database.Database,
  instanceId: string,
  base: { project?: string; trigger?: string } = {},
): RunEmitter {
  const startedAt = Date.now();
  let terminalEmitted = false;

  return {
    get terminalEmitted(): boolean {
      return terminalEmitted;
    },
    emit(stage: CognitionStage, payload: Record<string, unknown> = {}): void {
      // Suppress any terminal event after the first (the TD-074 invariant).
      if (terminalEmitted && TERMINAL_STAGES.has(stage)) return;
      if (TERMINAL_STAGES.has(stage)) terminalEmitted = true;
      writeExtractorEvent(db, instanceId, stage, {
        ...(base.project ? { project: base.project } : {}),
        ...(base.trigger ? { trigger: base.trigger } : {}),
        duration_ms: Date.now() - startedAt,
        ...payload,
      });
    },
  };
}
