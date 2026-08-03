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
 * starts, probes `/` and every `/api/*` path over real HTTP, prints a JSON
 * digest and exits. `dashboard.bats` drives it from an extracted tarball (T8).
 */

import { get as httpGet, request as httpRequest } from "node:http";
import { brainDbPath } from "../lib/paths.js";
import { existsSync } from "node:fs";
import * as bridge from "../lib/brain-bridge.js";
import { shutdownWriteEngine } from "../lib/brain-write-bridge.js";
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

/**
 * Every path `--smoke` probes. MAINTAINING row 108's `--smoke` obligation.
 *
 * WHAT A 200 HERE PROVES, EXACTLY: the path is ROUTED and the handler returned
 * without throwing. Nothing more — and the understatement is deliberate, because
 * every `/api/*` endpoint answers **200 with a `degraded` field** on a missing,
 * empty or unreadable brain (that IS the FR-238 contract), so a 200 is not
 * evidence that data arrived.
 *
 * WHAT IT DOES CATCH, which is why the list must stay complete: a path that was
 * added to `routes.ts`/`types.ts`/`lib/api.ts` and never wired into
 * `server.ts` falls through to the `/api/` catch-all and answers **404**. That
 * is a whole-endpoint outage a unit test can miss (it calls the handler
 * directly) and it is exactly the drift row 108 warns about, since FR-239 and
 * FR-240 both extended this surface. It is also the only check that runs against
 * a PACKED-AND-EXTRACTED tarball (T8 in `dashboard.bats`), where a missing
 * bundled artifact shows up as a degraded read rather than a crash.
 *
 * Detail endpoints are probed WITHOUT their identifiers on purpose: `/api/brief`
 * with no `project`/`id` is a stated refusal that still answers 200, so the
 * probe stays free of fixture data and works against any brain, including none.
 *
 * `/api/graph` is the one expensive probe (~1 MB on a real brain, ~22 ms warm).
 * It is in the list because FR-239 added the path and never added the probe —
 * the exact gap this constant now closes.
 */
const SMOKE_PROBE_PATHS: readonly string[] = [
  "/",
  // FR-238
  "/api/health",
  "/api/projects",
  "/api/summary",
  "/api/graph/stats",
  // FR-239
  "/api/graph",
  // FR-240 — the four layers, nine paths
  "/api/briefs",
  // FR-246 — the tenth, and the only path this brief adds.
  "/api/briefs/search",
  "/api/brief",
  "/api/learnings",
  "/api/learnings/search",
  "/api/learning",
  "/api/context-docs",
  "/api/context-doc",
  "/api/goals",
  "/api/goal",
  // FR-241 — the triage READ half. The WRITE half is probed separately below,
  // because a 200 is the WRONG expectation for it.
  "/api/suggestions",
];

/**
 * FR-241 — the write path's smoke probe.
 *
 * It POSTs a DELIBERATELY INVALID action and expects **400 with a stated
 * reason**. That shape is the point:
 *
 *  - a 400 proves the POST was ROUTED, passed the Host/Origin/Content-Type
 *    fences, was read, and reached `parseTriageBody` — i.e. the whole write
 *    pipeline is wired;
 *  - and it mutates NOTHING, so `--smoke` stays safe to run against the
 *    operator's real brain. A probe that dismissed a real suggestion to prove
 *    the endpoint works would be a probe nobody could run.
 *
 * A 200 here would mean `__invalid__` resolved to a tool, which is the one
 * outcome that must fail the gate — so `ok` is `status === 400`, NOT
 * `status === 200` like every other check. That asymmetry is why this is a
 * separate constant rather than a row in the table above.
 */
const WRITE_PROBE = {
  path: "/api/triage",
  body: JSON.stringify({ action: "__invalid__", ids: [1] }),
  expect: 400,
} as const;

/** POST a loopback URL and resolve its status code. Never rejects. */
function probePostStatus(url: string, body: string): Promise<number> {
  return new Promise((resolve) => {
    const req = httpRequest(
      url,
      {
        method: "POST",
        timeout: 5_000,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        resolve(status);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(0);
    });
    req.on("error", () => resolve(0));
    req.end(body);
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
    for (const path of SMOKE_PROBE_PATHS) {
      const status = await probeStatus(`${srv.url.replace(/\/$/, "")}${path}`);
      checks.push({ path, status, ok: status === 200 });
    }
    // The write path, probed with the INVERTED expectation — see WRITE_PROBE.
    const writeStatus = await probePostStatus(
      `${srv.url.replace(/\/$/, "")}${WRITE_PROBE.path}`,
      WRITE_PROBE.body,
    );
    checks.push({
      path: `POST ${WRITE_PROBE.path}`,
      status: writeStatus,
      ok: writeStatus === WRITE_PROBE.expect,
    });
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
    // The invalid-action probe is rejected before any boot, so there should be
    // no engine here — but `--smoke` must leave nothing behind whether or not
    // that stays true, and this call is a no-op when nothing booted.
    shutdownWriteEngine();
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
        // FR-241 — close the write engine's read-WRITE connection if a triage
        // POST ever booted one. A no-op on a pure-read session, which is the
        // overwhelmingly common case (lazy boot). Phase-0 step 8b established
        // this is hygiene rather than a hang-fix: the only timer a
        // minus-schedules boot arms is `sync`'s, and that one is unref'd. What
        // it DOES do is close the connection so a WAL brain can checkpoint.
        shutdownWriteEngine();
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
