/**
 * Brain Engine v7.1 — Cognition component schema (TD-327).
 *
 * ONE table: `cognition_instances`, the per-machine PROJECTION of the OPEN
 * instance registry. It exists for exactly one reason — to let a strictly
 * read-only reader outside this package (the `igris cognition health` CLI verb)
 * enumerate the registry WITHOUT hand-listing its members. `cli/` and
 * `brain-mcp-server/` are separate npm packages with zero cross-imports, and the
 * vendored bundle's only export is `bootEngine`, which boots a WRITE-capable
 * engine and runs migrations (including `monitoring`'s 30-day `event_log`
 * purge). Asking a health question must not mutate the brain, so the projection
 * is the door: the registry writes it at boot, the verb reads it read-only.
 *
 * MIGRATION IDENTITY. `createCognitionComponent().schema()` returns `[]` and no
 * migration has ever run under the `'cognition'` component key — the perception
 * / subconscious / janitor migrations are deliberately run under their ORIGINAL
 * keys inside `init()` (see `index.ts`). So `'cognition'` is a free key and
 * `cognitionMigrations` v1 is the first thing to claim it. There is no
 * migration-identity collision.
 *
 * NOT A SYNC TABLE. `cognition_instances` describes what THIS machine's build
 * registered, so replicating it would assert one machine's roster onto another
 * — the same class of mistake that put two `subconscious_engine` rows in
 * `schedules` (`syncKey: ['id']` over a per-machine random id). It is
 * regenerated from `registry.all()` at every engine boot and is therefore wrong
 * to merge. Its ROWS are cheap to lose; the TABLE is not — `runMigrations`
 * skips `version <= currentVersion` and `('cognition', 1)` is already recorded,
 * so a DROPped table is not recreated by re-init and the surface stays
 * permanently degraded. (`roster-wiring.test.ts` documents that.) The
 * not-a-sync-table argument does not depend on the adjective. `sync/__tests__/auto-push.test.ts` pins the
 * exclusion.
 *
 * @module engine/components/cognition/schema
 * @author fifty.dev
 */

import type { Migration } from '../../types.js';

/**
 * Cognition schema migrations (TD-327).
 *
 * Version 1: `cognition_instances` — one row per registered instance, carrying
 *   the instance's own `health` declaration verbatim. `gate_keys` is stored as
 *   a JSON array TEXT because it is a CONJUNCTION of arbitrary length (the
 *   cartographer declares two); a delimiter-joined string would make a key
 *   containing the delimiter unrepresentable. `gate_default` is stored as 0/1
 *   rather than assumed by the reader, because the "an absent key means off"
 *   convention has exactly ONE exception — perception's RESOLVER default is ON
 *   for a truly ABSENT key (not its shipped posture; install writes it false,
 *   FR-191) — and a reader that hard-codes the convention reports a config the
 *   installer never touched as `disabled` while it is extracting.
 *
 * Version 2 (TD-423): `produced` — the IDENTITY predicate. A SECOND column
 *   rather than a repurposing of `output`, because the two answer different
 *   questions and perception proves they diverge: its `output`
 *   (`learnings[review_status='pending_review']`) is an inbox that reads 0 the
 *   moment the queue is drained, while it has authored 569 rows. Repurposing
 *   `output` would also silently change `/scan`'s rendered "Output rows" column
 *   for perception from 0 to ~569 with no brief saying so.
 */
export const cognitionMigrations: Migration[] = [
  {
    version: 1,
    description:
      'TD-327: cognition_instances — the per-machine projection of the OPEN instance registry (roster derived, never hand-listed)',
    sql: `
      CREATE TABLE IF NOT EXISTS cognition_instances (
        id TEXT PRIMARY KEY,
        component TEXT NOT NULL,
        event_prefix TEXT NOT NULL,
        gate_keys TEXT NOT NULL,
        gate_default INTEGER NOT NULL DEFAULT 0,
        driver TEXT NOT NULL,
        driver_ref TEXT,
        output TEXT NOT NULL,
        registered_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 2,
    description:
      'TD-423: cognition_instances.produced — the IDENTITY predicate (which rows an instance ever wrote), distinct from `output` (where an operator looks for actionable results)',
    // O(1): `ADD COLUMN` with a CONSTANT default rewrites the table header, not
    // the rows. `DEFAULT ''` makes NOT NULL legal on an existing table AND is
    // the value the CLI reads as "no declaration" -> `unmeasured`, never zero.
    sql: `
      ALTER TABLE cognition_instances
        ADD COLUMN produced TEXT NOT NULL DEFAULT '';
    `,
  },
];
