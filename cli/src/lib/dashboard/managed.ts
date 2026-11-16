/** FR-276: one managed dashboard, explicit readiness, session-specific URL. */
import { spawn } from "node:child_process";
import { get } from "node:http";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { brainDbPath, dashboardLockPath } from "../paths.js";
import { getProcessStartTime, isProcessAlive } from "../process-liveness.js";
import { inspectLock } from "./lock.js";
import type { DashboardEnsureResult, DashboardLock } from "../../types.js";
export const ATTENTION_PROTOCOL = 1;
export function dashboardSessionUrl(base: string, session?: string): string {
  const url = new URL(base);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password)
    throw new Error("dashboard lock has an invalid loopback URL");
  if (session)
    url.hash = `/graph?session=${encodeURIComponent(session)}`;
  return url.href;
}
async function jsonGet(url: string): Promise<{
  status: number;
  body: Record<string, unknown>;
} | null> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (v: {
      status: number;
      body: Record<string, unknown>;
    } | null): void => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const req = get(url, { timeout: 1000 }, res => {
      let data = "";
      res.on("data", chunk => {
        data += String(chunk);
        if (data.length > 2 * 1024 * 1024) {
          req.destroy();
          finish(null);
        }
      });
      res.on("end", () => {
        try {
          const body: unknown = JSON.parse(data);
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            finish(null);
            return;
          }
          finish({ status: res.statusCode ?? 0, body: body as Record<string, unknown> });
        }
        catch {
          finish(null);
        }
      });
      res.on("error", () => finish(null));
    });
    req.on("timeout", () => { req.destroy(); finish(null); });
    req.on("error", () => finish(null));
  });
}
export async function dashboardReady(lock: DashboardLock, cliVersion: string, session?: string): Promise<DashboardEnsureResult> {
  let url: string;
  try {
    url = dashboardSessionUrl(lock.url, session);
  }
  catch {
    return { available: false, url: null, reason: "dashboard lock URL is not a trusted loopback URL" };
  }
  const health = await jsonGet(new URL("/api/health", url).href);
  const h = health?.body;
  if (health?.status !== 200 || h?.attention_protocol !== ATTENTION_PROTOCOL || h?.cli_version !== cliVersion || h?.server_pid !== lock.pid || (h?.brain as {
    path?: unknown;
  } | undefined)?.path !== brainDbPath())
    return { available: false, url: null, reason: "running dashboard is unavailable or incompatible; stop it and start this CLI's dashboard" };
  if (h.dashboard_bundle_present !== true)
    return { available: false, url: null, reason: "dashboard application bundle is unavailable; build this CLI before opening a session map" };
  if (session) {
    const response = await jsonGet(new URL(`/api/attention/session?session=${encodeURIComponent(session)}`, url).href);
    if (response?.status !== 200 || (response.body.session as {
      id?: unknown;
    } | undefined)?.id !== session)
      return { available: false, url: null, reason: "attention recording is unavailable on this dashboard" };
  }
  return { available: true, url, reason: null };
}
interface Starter {
  pid: number;
  process_start_time: string | null;
}
function starter(): Starter | null {
  try {
    const v = JSON.parse(readFileSync(`${dashboardLockPath()}.starting`, "utf8"));
    return Number.isInteger(v.pid) && v.pid > 0 &&
      (v.process_start_time === null || typeof v.process_start_time === "string")
      ? v as Starter : null;
  }
  catch {
    return null;
  }
}
export function startupOwnerAlive(owner: Starter): boolean {
  if (!isProcessAlive(owner.pid))
    return false;
  if (owner.process_start_time === null)
    return true;
  const current = getProcessStartTime(owner.pid);
  // Unobservable is not proof of death; a known mismatch proves PID reuse.
  return current === null || current === owner.process_start_time;
}
function compiledEntrypoint(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, import.meta.url.endsWith(".ts") ? "../../../dist/index.js" : "../../index.js");
}
export async function ensureDashboard(opts: {
  cliVersion: string;
  session?: string;
  port?: number;
  entrypoint?: string;
}): Promise<DashboardEnsureResult> {
  const initial = inspectLock();
  if (initial.kind === "live")
    return dashboardReady(initial.lock, opts.cliVersion, opts.session);
  const entry = opts.entrypoint ?? compiledEntrypoint();
  if (!existsSync(entry))
    return { available: false, url: null, reason: "compiled CLI is unavailable; build it before starting a managed dashboard" };
  const guard = `${dashboardLockPath()}.starting`;
  try {
    mkdirSync(dirname(guard), { recursive: true });
  }
  catch {
    return { available: false, url: null, reason: "dashboard directory is not writable" };
  }
  let fd: number | undefined;
  const deadline = Date.now() + 12000;
  let incompleteGuardSince: number | null = null;
  while (fd === undefined && Date.now() < deadline) {
    try {
      fd = openSync(guard, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, process_start_time: getProcessStartTime(process.pid) }));
    }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        if (fd !== undefined) {
          closeSync(fd);
          rmSync(guard, { force: true });
        }
        return { available: false, url: null, reason: "cannot acquire dashboard startup guard" };
      }
      const running = inspectLock();
      if (running.kind === "live")
        return dashboardReady(running.lock, opts.cliVersion, opts.session);
      const owner = starter();
      if (!owner) {
        // Another process may be between exclusive creation and its first write.
        incompleteGuardSince ??= Date.now();
        if (Date.now() - incompleteGuardSince < 500) {
          await delay(100);
          continue;
        }
        return { available: false, url: null, reason: "startup guard is malformed; inspect it before starting another dashboard" };
      }
      incompleteGuardSince = null;
      if (!startupOwnerAlive(owner))
        return { available: false, url: null, reason: "interrupted dashboard startup; run igris dashboard --stop to clear its guard" };
      await delay(100);
    }
  }
  if (fd === undefined)
    return { available: false, url: null, reason: "dashboard startup is still owned by another process" };
  let child: ReturnType<typeof spawn> | undefined;
  let readySucceeded = false;
  try {
    const running = inspectLock();
    if (running.kind === "live")
      return dashboardReady(running.lock, opts.cliVersion, opts.session);
    const args = [entry, "dashboard", "--no-open", ...(opts.port === undefined ? [] : ["--port", String(opts.port)])];
    child = spawn(process.execPath, args, { detached: true, stdio: "ignore", env: process.env, cwd: process.cwd() });
    let spawnError = false;
    child.on("error", () => { spawnError = true; });
    child.unref();
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null)
        return { available: false, url: null, reason: "managed dashboard exited before readiness" };
      const state = inspectLock();
      if (state.kind === "live") {
        const ready = await dashboardReady(state.lock, opts.cliVersion, opts.session);
        if (ready.available) {
          readySucceeded = true;
          return ready;
        }
        // Lock is published only after binding. A missing bundle/old version is final.
        return ready;
      }
      await delay(100);
    }
    return { available: false, url: null, reason: "managed dashboard did not become ready within 12 seconds" };
  }
  finally {
    // A failed start must not leave an unadvertised managed process behind.
    if (child?.pid && !readySucceeded)
      child.kill("SIGTERM");
    closeSync(fd);
    rmSync(guard, { force: true });
  }
}
export async function stopDashboard(cliVersion: string): Promise<DashboardEnsureResult> {
  const state = inspectLock();
  if (state.kind === "live") {
    // Kill only a positively identified dashboard process, never pid-only ownership.
    if (state.lock.process_start_time === null || getProcessStartTime(state.lock.pid) !== state.lock.process_start_time)
      return { available: false, url: null, reason: "dashboard process identity cannot be verified" };
    const health = await jsonGet(new URL("/api/health", dashboardSessionUrl(state.lock.url)).href);
    if (health?.body.server_pid !== state.lock.pid || health.body.cli_version !== cliVersion || health.body.attention_protocol !== ATTENTION_PROTOCOL)
      return { available: false, url: null, reason: "running process is not this compatible dashboard; stop it from its owning terminal" };
    process.kill(state.lock.pid, "SIGTERM");
    for (let i = 0; i < 50; i++) {
      if (inspectLock().kind !== "live")
        return { available: true, url: null, reason: "dashboard stopped" };
      await delay(100);
    }
    return { available: false, url: null, reason: "dashboard has not finished stopping" };
  }
  const owner = starter();
  if (existsSync(`${dashboardLockPath()}.starting`)) {
    if (!owner)
      return { available: false, url: null, reason: "startup guard is malformed; inspect and remove dashboard.lock.starting only after confirming no dashboard is starting" };
    if (startupOwnerAlive(owner))
      return { available: false, url: null, reason: "dashboard startup is still owned by a live process" };
    rmSync(`${dashboardLockPath()}.starting`, { force: true });
  }
  return { available: true, url: null, reason: "no running dashboard" };
}
