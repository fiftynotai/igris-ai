/**
 * `igris sync <code|data|all|status|push> [--dry-run] [--if-changed]` — verb dispatcher.
 *
 * Single entry point that routes the sub-verb argument to the appropriate
 * lib/sync/* implementation. The dispatch is intentionally thin so the
 * sub-verb modules can be tested in isolation.
 *
 * `all` runs `code` then `data` sequentially. If `code` exits non-zero,
 * `all` aborts before invoking `data`. The `--dry-run` flag passes through
 * to both sub-verbs so the user gets a complete preview.
 *
 * `--if-changed` only applies to `code` (and `all` when it invokes code).
 * It's silently ignored for `data`, `status` and `push`. `push` (TD-350) is
 * explicit only — `all` stays `code` then `data`.
 */

import { runSyncCode } from "../lib/sync/code.js";
import { runSyncData } from "../lib/sync/data.js";
import { runSyncStatus } from "../lib/sync/status.js";
import { runSyncPush } from "../lib/sync/push.js";
import { error as logError, info } from "../lib/log.js";

export type SyncSubVerb = "code" | "data" | "all" | "status" | "push";

export interface SyncOptions {
  /** Sub-verb selector. */
  subVerb: SyncSubVerb;
  /** Plan-only mode; no writes / no network calls. */
  dryRun?: boolean;
  /**
   * Cron-parity: skip the entire push when local HEAD == origin/<branch>.
   * Only meaningful for `code` and `all`.
   */
  ifChanged?: boolean;
}

const VALID_SUB_VERBS: ReadonlySet<string> = new Set([
  "code",
  "data",
  "all",
  "status",
  "push",
]);

export async function runSync(opts: SyncOptions): Promise<number> {
  if (!VALID_SUB_VERBS.has(opts.subVerb)) {
    logError(
      `unknown sub-verb '${opts.subVerb}'. Valid: code, data, all, status, push.`,
    );
    return 2;
  }

  if (opts.subVerb === "status") {
    return await runSyncStatus({ dryRun: opts.dryRun });
  }
  if (opts.subVerb === "push") {
    return await runSyncPush({ dryRun: opts.dryRun });
  }
  if (opts.subVerb === "code") {
    return await runSyncCode({
      dryRun: opts.dryRun,
      ifChanged: opts.ifChanged,
    });
  }
  if (opts.subVerb === "data") {
    if (opts.ifChanged === true) {
      // Silently no-op rather than reject — `--if-changed` on data is
      // meaningless but harmless. Log a debug-tier hint via info().
      info("sync data: --if-changed has no effect (data sync has no change gate).");
    }
    return await runSyncData({ dryRun: opts.dryRun });
  }
  // "all": code then data, sequentially. Abort on non-zero from code.
  const codeExit = await runSyncCode({
    dryRun: opts.dryRun,
    ifChanged: opts.ifChanged,
  });
  if (codeExit !== 0) {
    logError(`sync all: code sync exited ${codeExit}; skipping data sync.`);
    return codeExit;
  }
  const dataExit = await runSyncData({ dryRun: opts.dryRun });
  return dataExit;
}
