/**
 * Brain Engine — Perception lifecycle events (TD-074).
 *
 * Single source of truth for perception observability. The detached extract
 * CLI (`scripts/perception_extract_cli.ts`) runs without an in-process
 * EventEmitter — no `bootEngine()` is invoked in that process — so any
 * `bus.emit()` from the runner / extractor would silently no-op. Instead,
 * this module writes directly to `event_log` with the same row shape that
 * `monitoring.onEventReceived` produces (see `monitoring/index.ts:117-127`).
 *
 * Both the detached CLI and the MCP-context handler (`handlers.ts`) use
 * `writePerceptionEvent` so a single read path (`igris_event_log` filtered
 * by `component='perception'`) covers all perception runs regardless of
 * which process produced them.
 *
 * Defensive contract: emission failure must NEVER abort the pipeline. The
 * INSERT is wrapped in try/catch and falls back to a stderr line in the
 * format the wrapper script (`perception_extract_and_persist.sh`) captures
 * into `perception_extract.log`.
 *
 * @module engine/components/perception/events
 * @author Fifty.ai
 */

import type Database from 'better-sqlite3';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The lifecycle + dedup event names. Stored verbatim in `event_log.event_name`.
 * Adding a new lifecycle stage requires updating both this union and the
 * `EVENT_COMPONENT_MAP` / listens declarations in `monitoring/index.ts` so
 * MCP-context emissions (via `bus.emit`) are also persisted.
 *
 * TD-086 added `perception.rediscovery` (live) and
 * `perception.rejected_pattern_recurring` (forward-compat declaration —
 * declared in events() and emitted under a perpetually-false branch in
 * handlers.ts so the event-bus integrity test passes; activates when FR-116
 * ships soft-delete).
 */
export type PerceptionEventName =
  | 'perception.run_started'
  | 'perception.run_succeeded'
  | 'perception.run_failed'
  | 'perception.run_skipped'
  | 'perception.rediscovery'
  | 'perception.rejected_pattern_recurring';

/**
 * Closed enum of failure reasons embedded in a `perception.run_failed`
 * payload. Stored as a free-form string inside JSON so adding a new reason
 * is a writer-side TS update, NOT a schema migration. Readers (`/scan`,
 * `/awaken`) display the string verbatim with a fallback "(unknown reason)"
 * if the field is blank.
 */
export type RunFailedReason =
  | 'epipe_on_llm_stdin' // TD-073 — child closed stdin during write
  | 'cli_missing'        // claude binary not on PATH
  | 'spawn_error'        // synchronous spawn() throw
  | 'non_zero_exit'      // child exited with code !== 0
  | 'timeout'            // soft 60s SIGTERM fired
  | 'parse_error'        // extractJsonArrayReply returned [] from non-empty stdout
  | 'db_error'           // INSERT into learnings or learnings table missing
  | 'unknown';           // catch-all in the runner-level try/catch

/**
 * Closed enum of skip reasons embedded in a `perception.run_skipped`
 * payload.
 */
export type RunSkippedReason =
  | 'min_window_guard' // bash 60s elapsed-since-last-run guard
  | 'no_transcript'    // transcript path absent / empty
  | 'gate_disabled'    // extractor_llm_enabled=false
  | 'gate_bytes';      // transcript below llm_min_transcript_bytes floor

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Insert a single perception lifecycle row into `event_log`. Mirrors the
 * column shape `monitoring.onEventReceived` writes for bus-driven events.
 *
 * `payload.project` is hoisted into the dedicated `project_slug` column so
 * the existing `igris_event_log` MCP filter and the `/scan` query path
 * both work without parsing the JSON blob.
 *
 * Failure mode: any thrown error is caught and surfaced as a single stderr
 * line. The pipeline continues — perception observability must never gate
 * the actual extraction work.
 */
export function writePerceptionEvent(
  db: Database.Database,
  name: PerceptionEventName,
  payload: Record<string, unknown>,
): void {
  try {
    const projectSlug =
      typeof payload.project === 'string' ? payload.project : null;
    db.prepare(
      `INSERT INTO event_log
         (event_name, component, payload, machine_hostname, project_slug, instance_id, created_at)
       VALUES (?, 'perception', ?, ?, ?, NULL, datetime('now'))`,
    ).run(name, JSON.stringify(payload), os.hostname(), projectSlug);
  } catch (err) {
    // Defensive fallback. Format matches the `[perception_extract_cli]`
    // log lines the wrapper script captures, so the failure is grep-able
    // even though the structured event was lost.
    process.stderr.write(
      `[perception.events] write failed for ${name}: ${
        err instanceof Error ? err.message : String(err)
      } payload=${JSON.stringify(payload)}\n`,
    );
  }
}
