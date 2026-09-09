/**
 * Brain Engine v7.1 — Cognition roster projection (TD-327).
 *
 * THE DERIVATION SEAM. TD-327 exists because a hand-listed health check over an
 * OPEN registry cannot report on the members nobody remembered to list: seven
 * instances existed, `/boot` §4.10 named two of them in embedded SQL, and five
 * went silent for four weeks. The fix is not a longer list — it is to stop
 * writing lists. `buildRoster` is a PURE mapper over `registry.all()`; nothing
 * downstream ever enumerates instance ids again.
 *
 * The FR-237 pure-builder / wrapper split: `buildRoster` is pure and total (no
 * DB, no clock, no I/O) so the derivation property is testable by registering a
 * throwaway instance and reading the output; `projectRoster` is the thin writer.
 *
 * FAIL-SOFT (the TD-074 defensive contract). Observability must never gate the
 * subsystem it observes. `projectRoster` swallows every error and reports it in
 * its return value: a brain whose roster projection fails still boots, still
 * runs perception, and merely renders a degraded health digest. The inverse —
 * a boot that dies because a reporting table would not write — trades a visible
 * problem for an invisible one.
 *
 * @module engine/components/cognition/roster
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import type { CognitionRegistry } from './registry.js';
import type { CognitionDriver } from './types.js';

/**
 * One projected roster row — an instance's `health` declaration flattened for
 * storage. `gate_keys` stays an ARRAY here (it is serialised to JSON only at
 * the SQL boundary) so the pure builder's output is directly assertable.
 */
export interface RosterRow {
  /** The instance id, verbatim from `CognitionInstance.id`. */
  id: string;
  /** `event_log.component` LITERAL — see `types.ts:CognitionInstanceHealth`. */
  component: string;
  /** `event_log.event_name` prefix LITERAL. */
  event_prefix: string;
  /** The CONJUNCTION of `config.json` dotted keys gating this instance. */
  gate_keys: string[];
  /** What an ABSENT gate key resolves to — `true` only for perception. */
  gate_default: boolean;
  /** How the instance is driven. */
  driver: CognitionDriver;
  /** Schedule name / driving instance id / hook name / null. */
  driver_ref: string | null;
  /** Where this instance's output lands. */
  output: string;
  /**
   * TD-423 — the IDENTITY predicate: which rows THIS instance ever wrote,
   * regardless of review state. See `types.ts:CognitionInstanceHealth#produced`
   * for the grammar and the `OTHER` complement semantics.
   */
  produced: string;
}

/** What {@link projectRoster} reports back. Never throws — see module header. */
export interface RosterProjectionResult {
  /** Rows upserted this pass (equal to the registry size on success). */
  written: number;
  /** Stale rows deleted — instances that are no longer registered. */
  removed: number;
  /** The failure message when the projection could not complete; else null. */
  error: string | null;
}

/**
 * PURE — map every registered instance to a roster row.
 *
 * The whole derivation property lives in this one line of iteration: it reads
 * `registry.all()` and nothing else, so an instance added to the extractors
 * barrel appears in the roster (and therefore in `igris cognition health`, in
 * `/boot` and in `/scan`) with no edit anywhere. Any change that replaces this
 * with a literal list re-opens TD-327.
 *
 * `gate_keys` is copied into a fresh mutable array so a caller cannot mutate the
 * instance's own `readonly` declaration through the projection.
 */
export function buildRoster(registry: CognitionRegistry): RosterRow[] {
  return registry.all().map((instance) => ({
    id: instance.id,
    component: instance.health.component,
    event_prefix: instance.health.event_prefix,
    gate_keys: [...instance.health.gate_keys],
    gate_default: instance.health.gate_default,
    driver: instance.health.driver,
    driver_ref: instance.health.driver_ref,
    output: instance.health.output,
    produced: instance.health.produced,
  }));
}

/**
 * Write the roster into `cognition_instances`, idempotently.
 *
 * RECONCILING, not merely additive: rows whose id is absent from `rows` are
 * DELETED. A retired instance that left a row behind would render in the health
 * surface forever as an instance with no signal — an invented outage. The table
 * is a projection of the live registry, so it holds exactly what the registry
 * holds.
 *
 * `registered_at` is preserved across passes (the upsert does not touch it), so
 * the column answers "since when has this build known about this instance".
 *
 * Never throws (TD-074): a failure is reported in the result, not raised.
 */
export function projectRoster(
  db: Database.Database,
  rows: RosterRow[],
): RosterProjectionResult {
  try {
    const upsert = db.prepare(`
      INSERT INTO cognition_instances
        (id, component, event_prefix, gate_keys, gate_default, driver, driver_ref, output, produced)
      VALUES (@id, @component, @event_prefix, @gate_keys, @gate_default, @driver, @driver_ref, @output, @produced)
      ON CONFLICT(id) DO UPDATE SET
        component    = excluded.component,
        event_prefix = excluded.event_prefix,
        gate_keys    = excluded.gate_keys,
        gate_default = excluded.gate_default,
        driver       = excluded.driver,
        driver_ref   = excluded.driver_ref,
        output       = excluded.output,
        produced     = excluded.produced
    `);

    let removed = 0;
    const apply = db.transaction((batch: RosterRow[]) => {
      for (const row of batch) {
        upsert.run({
          id: row.id,
          component: row.component,
          event_prefix: row.event_prefix,
          gate_keys: JSON.stringify(row.gate_keys),
          gate_default: row.gate_default ? 1 : 0,
          driver: row.driver,
          driver_ref: row.driver_ref,
          output: row.output,
          produced: row.produced,
        });
      }
      // Reconcile: drop rows for instances this build no longer registers.
      const keep = new Set(batch.map((r) => r.id));
      const existing = db
        .prepare('SELECT id FROM cognition_instances')
        .all() as Array<{ id: string }>;
      const drop = db.prepare('DELETE FROM cognition_instances WHERE id = ?');
      for (const { id } of existing) {
        if (!keep.has(id)) {
          drop.run(id);
          removed += 1;
        }
      }
    });

    apply(rows);
    return { written: rows.length, removed, error: null };
  } catch (err) {
    return {
      written: 0,
      removed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
