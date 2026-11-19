/** FR-276: managed startup exercised against real isolated child processes. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fenceHome, type HomeFence } from "./home-fence.js";
import { dashboardSessionUrl, ensureDashboard, startupOwnerAlive, stopDashboard } from "../lib/dashboard/managed.js";
import { dashboardLockPath } from "../lib/paths.js";
import { getProcessStartTime, isProcessAlive } from "../lib/process-liveness.js";
import { readLock } from "../lib/dashboard/lock.js";

let fence: HomeFence;
let children: number[] = [];
beforeEach(() => { fence = fenceHome("igris-managed-"); fence.assertArmed(); });
afterEach(async () => {
  const pidFile = join(fence.home, "spawned.pid");
  if (existsSync(pidFile)) children.push(Number(readFileSync(pidFile, "utf8")));
  for (const pid of children) { try { process.kill(pid, "SIGTERM"); } catch { /* already stopped */ } }
  for (let i = 0; i < 30 && children.some(isProcessAlive); i++) await delay(25);
  children = []; fence.release();
});

/** The fixture publishes the same documented readiness fields and lock shape. */
function entrypoint(bundlePresent = true): string {
  const path = join(fence.home, "dashboard-fixture.mjs");
  writeFileSync(path, `
import { createServer } from 'node:http';
import { writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const root=process.env.IGRIS_BRAIN_DIR;
const pidFile=join(process.env.HOME,'spawned.pid');
writeFileSync(pidFile,String(process.pid));
const server=createServer((req,res)=>{
 const u=new URL(req.url,'http://127.0.0.1');
 const body=u.pathname==='/api/health'
  ? {attention_protocol:1,cli_version:'attention-test',server_pid:process.pid,dashboard_bundle_present:${bundlePresent},brain:{path:join(root,'memory','knowledge.db')}}
  : {session:{id:u.searchParams.get('session')}};
 res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(body));
});
server.listen(0,'127.0.0.1',()=>{
 const port=server.address().port;
 const started=execFileSync('ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8',timeout:2000}).trim();
 writeFileSync(join(root,'dashboard.lock'),JSON.stringify({pid:process.pid,port,url:'http://127.0.0.1:'+port,started_at:new Date().toISOString(),process_start_time:started}));
});
process.on('SIGTERM',()=>{rmSync(join(root,'dashboard.lock'),{force:true}); server.close(()=>process.exit(0));});
`);
  return path;
}

describe("FR-276 managed dashboard", () => {
  it("creates one process under concurrent ensure and returns each exact session URL", async () => {
    const entry = entrypoint(), first = randomUUID(), second = randomUUID();
    const [a, b] = await Promise.all([
      ensureDashboard({ cliVersion: "attention-test", session: first, entrypoint: entry }),
      ensureDashboard({ cliVersion: "attention-test", session: second, entrypoint: entry }),
    ]);
    expect(a.available, a.reason ?? "not ready").toBe(true);
    expect(b.available, b.reason ?? "not ready").toBe(true);
    expect(new URL(a.url!).origin).toBe(new URL(b.url!).origin);
    expect(new URL(a.url!).hash).toBe(`#/graph?session=${first}`);
    expect(new URL(b.url!).hash).toBe(`#/graph?session=${second}`);
    children.push(readLock()!.pid);
    const again = await ensureDashboard({ cliVersion: "attention-test", session: first, entrypoint: entry });
    expect(again.url).toBe(a.url);
    expect((await stopDashboard("attention-test")).available).toBe(true);
    expect(readLock()).toBeNull();
  });

  it("allows another starter to finish writing a newly created guard", async () => {
    const entry = entrypoint();
    writeFileSync(`${dashboardLockPath()}.starting`, "");
    const writer = setTimeout(() => {
      writeFileSync(`${dashboardLockPath()}.starting`, JSON.stringify({ pid: process.pid, process_start_time: getProcessStartTime(process.pid) }));
      const child = spawn(process.execPath, [entry], { stdio: "ignore", env: process.env });
      if (child.pid) children.push(child.pid);
    }, 30);
    try {
      const result = await ensureDashboard({ cliVersion: "attention-test", session: randomUUID(), entrypoint: entry });
      expect(result.available, result.reason ?? "not ready").toBe(true);
    } finally { clearTimeout(writer); }
  });

  it("terminates its child after failed readiness and removes its startup guard", async () => {
    const result = await ensureDashboard({ cliVersion: "attention-test", session: randomUUID(), entrypoint: entrypoint(false) });
    expect(result.available).toBe(false); expect(result.reason).toContain("bundle");
    expect(existsSync(`${dashboardLockPath()}.starting`)).toBe(false);
    const pid = Number(readFileSync(join(fence.home, "spawned.pid"), "utf8"));
    children.push(pid);
    for (let i = 0; i < 40 && isProcessAlive(pid); i++) await delay(25);
    expect(isProcessAlive(pid)).toBe(false);
    expect(readLock()).toBeNull();
  });

  it("recognizes a recycled startup PID and allows explicit stale-guard recovery", async () => {
    const owner = { pid: process.pid, process_start_time: "definitely not this process start time" };
    expect(getProcessStartTime(process.pid)).not.toBeNull();
    expect(startupOwnerAlive(owner)).toBe(false);
    writeFileSync(`${dashboardLockPath()}.starting`, JSON.stringify(owner));
    const result = await ensureDashboard({ cliVersion: "attention-test", entrypoint: entrypoint() });
    expect(result.available).toBe(false); expect(result.reason).toContain("interrupted");
    expect((await stopDashboard("attention-test")).available).toBe(true);
    expect(existsSync(`${dashboardLockPath()}.starting`)).toBe(false);
  });

  it("reports malformed guard recovery and rejects non-loopback dashboard URLs", async () => {
    writeFileSync(`${dashboardLockPath()}.starting`, "bad-json");
    const result = await stopDashboard("attention-test");
    expect(result.available).toBe(false); expect(result.reason).toContain("malformed");
    expect(existsSync(`${dashboardLockPath()}.starting`)).toBe(true);
    expect(() => dashboardSessionUrl("https://example.com", randomUUID())).toThrow();
    expect(() => dashboardSessionUrl("http://user@127.0.0.1:7317", randomUUID())).toThrow();
  });
});
