/**
 * `igris dashboard` (FR-238) — the CLI's FIRST long-lived process.
 *
 * WHY THAT MATTERS (R5). Every one of the other 24 verbs runs and exits, and
 * the codebase's lifecycle pattern is "set `process.exitCode`, let async
 * flush". A server inverts that: nothing sets an exit code until a signal
 * arrives. So the shape here is deliberately narrow —
 *
 *   FOREGROUND (D4-A). The terminal is occupied while the lens is open, and
 *   the OS reaps the process with the terminal. No daemon, no `dashboard
 *   stop`, no log-file management, no orphan class. A crash can never
 *   permanently wedge the verb because a stale lock is always reclaimable.
 *
 *   SINGLE INSTANCE via `~/.igris/dashboard.lock` over the existing
 *   `process-liveness.ts` (pid + `ps -o lstart=`, so it is pid-reuse-proof). A
 *   second invocation re-opens the RUNNING url and exits 0 — it never binds a
 *   second port and never orphans the first.
 *
 *   SIGINT / SIGTERM close the server, release the lock, exit 0. Release is
 *   idempotent and ownership-checked.
 *
 * `--smoke` is the hidden self-check that makes the packaging AC testable: it
 * starts, probes `/` and `/api/health` over real HTTP, prints a JSON digest and
 * exits. `dashboard.bats` drives it from an extracted tarball (T8).
 */

import { get as httpGet } from "node:http";
import { brainDbPath } from "../lib/paths.js";
import { existsSync } from "node:fs";
import * as bridge from "../lib/brain-bridge.js";
import {
  inspectLock,
  releaseLock,
  writeLock,
} from "../lib/dashboard/lock.js";
import { startServer, type DashboardServer } from "../lib/dashboard/server.js";
import { bundlePresent, bundleRoot } from "../lib/dashboard/static.js";
import { describeOpenResult, openUrl } from "../lib/open-url.js";
import { error as logError, info, warn } from "../lib/log.js";
import type { DashboardDigest, DashboardOptions } from "../types.js";

/** GET a loopback URL and resolve its status code. Never rejects. */
function probeStatus(url: string): Promise<number> {
  return new Promise((resolve) => {
    const req = httpGet(url, { timeout: 5_000 }, (res) => {
      const status = res.statusCode ?? 0;
      res.resume(); // drain so the socket can close
      resolve(status);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(0);
    });
    req.on("error", () => resolve(0));
  });
}

function openBrowser(url: string): void {
  const result = openUrl(url);
  const line = describeOpenResult(result);
  if (line !== null) info(line);
}

/**
 * Run the verb. Resolves with the process exit code.
 *
 * In normal (non-smoke) mode the returned promise stays pending until a signal
 * arrives — that IS the foreground model.
 */
export async function runDashboard(
  opts: DashboardOptions & { cliVersion: string },
): Promise<number> {
  // --- 1. Single-instance guard ------------------------------------------
  const state = inspectLock();
  if (state.kind === "live") {
    info(`igris dashboard is already running at ${state.lock.url}`);
    info(`  pid ${state.lock.pid} · started ${state.lock.started_at}`);
    if (opts.smoke === true) {
      // A smoke run must never adopt someone else's server as its own result.
      logError(
        "dashboard: an instance is already running — --smoke needs an exclusive port",
      );
      return 1;
    }
    if (opts.noOpen !== true) openBrowser(state.lock.url);
    return 0;
  }
  if (state.lock !== null) {
    // Reclaimable: a dead pid, or a pid recycled onto an unrelated process.
    warn(
      `reclaiming stale dashboard lock (pid ${state.lock.pid}, ${state.reason})`,
    );
    releaseLock(state.lock.pid);
  }

  // --- 2. Bind ------------------------------------------------------------
  let srv: DashboardServer;
  try {
    srv = await startServer({
      port: opts.port,
      exactPort: opts.port !== undefined,
      cliVersion: opts.cliVersion,
    });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "EADDRINUSE" && opts.port !== undefined) {
      logError(
        `dashboard: port ${opts.port} is in use. Explicit --port is never silently reassigned; pick another port or drop the flag.`,
      );
      return 1;
    }
    logError(
      `dashboard: could not start server: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  // MUST be guarded, and the server MUST be closed on failure. The socket is
  // already bound at this point and no signal handlers are installed yet, so an
  // unguarded throw here reaches `main().catch`, which sets an exit code but
  // never closes the listener — the event loop never drains and the process
  // HANGS holding a port, with no lock and no way out but Ctrl-C. Reproduced
  // against an unwritable brain dir (read-only $HOME / full disk): the error
  // printed and the process sat there until killed.
  try {
    writeLock({ pid: process.pid, port: srv.port, url: srv.url });
  } catch (err) {
    logError(
      `dashboard: could not write the lockfile: ${err instanceof Error ? err.message : String(err)}`,
    );
    await srv.close();
    return 1;
  }

  if (!bundlePresent()) {
    warn(
      `dashboard bundle not found at ${bundleRoot()} — serving a placeholder. Run \`npm run build\` in cli/.`,
    );
  }

  // --- 3. Smoke mode: probe, report, exit --------------------------------
  if (opts.smoke === true) {
    const checks: DashboardDigest["checks"] = [];
    for (const path of ["/", "/api/health", "/api/projects", "/api/graph/stats"]) {
      const status = await probeStatus(`${srv.url.replace(/\/$/, "")}${path}`);
      checks.push({ path, status, ok: status === 200 });
    }
    const probeResult = await bridge.probe();
    const digest: DashboardDigest = {
      ok: checks.every((c) => c.ok),
      url: srv.url,
      port: srv.port,
      bundle_dir: bundleRoot(),
      bundle_present: bundlePresent(),
      checks,
      brain_present: existsSync(brainDbPath()),
      bridge_available: probeResult.available,
    };
    process.stdout.write(`${JSON.stringify(digest, null, 2)}\n`);
    await srv.close();
    releaseLock();
    return digest.ok ? 0 : 1;
  }

  // --- 4. Foreground -----------------------------------------------------
  info(`IGRIS dashboard — ${srv.url}`);
  info("Press Ctrl-C to stop.");
  if (opts.noOpen !== true) openBrowser(srv.url);

  return new Promise<number>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      info(`\nstopping dashboard (${signal})`);
      void srv.close().then(() => {
        releaseLock();
        resolve(0);
      });
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    // Belt for an unexpected loop drain: release the lock rather than leaving
    // a stale file behind for the next run to have to reclaim.
    process.once("beforeExit", () => {
      if (!shuttingDown) releaseLock();
    });
  });
}
