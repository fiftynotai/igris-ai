/**
 * Operator script: manually sweep stale / orphaned brain-mcp-server instances
 * (BR-067).
 *
 * The stdio brain-mcp-server runs this sweep automatically on every boot
 * (`runStdio()` in `src/index.ts`). This script exposes the same sweep as a
 * standalone command so an operator can reap orphans on demand without
 * waiting for the next session start — useful after an incident like the
 * 2026-05-15 spawn-storm.
 *
 * It reaps ONLY provably-orphaned instances: a server process that is alive
 * but whose recorded parent is dead. It never SIGKILLs, never `pkill`s, and
 * never touches a server whose parent is still alive (a live session).
 *
 * Usage:
 *   npx tsx scripts/reap-stale-instances.ts          # sweep and report
 *   IGRIS_PIDS_DIR=/tmp/x npx tsx scripts/...         # sweep a sandboxed registry
 *
 * Exit codes:
 *   0 — sweep completed (orphans, if any, were reaped)
 *   1 — unexpected error
 *
 * @module scripts/reap-stale-instances
 * @author fifty.dev
 */

import { reapStaleInstances } from '../src/stdio-lifecycle.js';

function main(): void {
  try {
    const result = reapStaleInstances();
    console.log(
      `[reap] SIGTERM'd ${result.reaped.length} orphan(s), ` +
      `pruned ${result.prunedStale.length} stale pidfile(s), ` +
      `left ${result.skippedAlive.length} live instance(s) untouched`,
    );
    if (result.reaped.length > 0) {
      console.log(`[reap] reaped PIDs: ${result.reaped.join(', ')}`);
    }
    process.exit(0);
  } catch (err) {
    console.error(`[reap] error: ${String(err)}`);
    process.exit(1);
  }
}

main();
