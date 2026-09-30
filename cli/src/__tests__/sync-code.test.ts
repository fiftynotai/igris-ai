/**
 * sync-code.test.ts — M4.2 (MG-014); orchestration tier since BR-116.
 *
 * Mocks `node:child_process` at the boundary (per L-159 / TD-098: the
 * lib/ssh wrapper is the module under test, so we mock its child_process
 * dependency, NOT lib/ssh itself). The post-restart `/health` probe lands on a
 * real loopback HTTP server.
 *
 * ssh calls are ROUTED by the `: igris-deploy:<step>` marker every remote
 * command starts with (the number of polls varies, so a FIFO cannot pin
 * them); rsync/git keep the per-bin default/FIFO seam. The end-to-end remote
 * behaviour (a real runner under a fake ssh) is `sync-code-remote.test.ts`.
 *
 * Coverage:
 *   - rsync command shape + the full exclude audit (incl. `.igris-deploy/`)
 *   - order: preflight → rsync → launch → poll → restart → pm2/health gate
 *   - the launched runner script (TD-135 / TD-141 intents, quoting)
 *   - refusals before rsync (busy, interrupted swap, disk), launch race,
 *     poll failures, the reported wait bound, remote failures, health gate
 *   - --dry-run: no execFile invoked; --if-changed skip
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// ----- child_process mock -----

type ExecFileBehavior = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Emulates execFile's timeout kill. */
  killed?: boolean;
};

let execFileBehaviors: Record<string, ExecFileBehavior> = {};
let execFileQueues: Record<string, ExecFileBehavior[]> = {};
/** Per ssh step: one behavior, or a queue whose LAST entry sticks. */
let sshRoutes: Record<string, ExecFileBehavior | ExecFileBehavior[]> = {};
const execFileCalls: Array<{ bin: string; args: string[]; cwd?: string }> = [];

const ok = (stdout = ""): ExecFileBehavior => ({ exitCode: 0, stdout, stderr: "" });

const DEFAULT_SSH: Record<string, ExecFileBehavior> = {
  preflight: ok("node=v22.12.0\nnpm=10.9.8\nps=1\nbusy=0\nswap_marker=0\navail_kb=50000000\nnm_kb=900000\nprev_kb=0\n"),
  launch: ok("state=launched\npid=4242\n"),
  poll: ok(
    "alive=0\nphase=done\nrc.code=0\nrc.phase=done\nrc.rolled_back=0\nrc.rollback_smoke=\nrc.node=v22.12.0\nrc.install_s=40\nrc.build_s=12\n",
  ),
  tail: ok(""),
  restart: ok("[PM2] Applying action restartProcessId on app [igris-brain]"),
};

/** Default pm2 probe: online, restart count = the `pm2 restart` calls issued so far. */
function pm2Default(): ExecFileBehavior {
  const n = execFileCalls.filter((c) => c.bin === "ssh" && stepOf(c.args[c.args.length - 1] ?? "") === "restart").length;
  return ok(`{"found":true,"status":"online","restarts":${n},"unstable":0,"node":"22.12.0","uptime_ms":10}\n`);
}

function setExec(bin: string, behavior: ExecFileBehavior): void {
  execFileBehaviors[bin] = behavior;
}

function stepOf(cmd: string): string {
  return /^: igris-deploy:([a-z0-9-]+)/.exec(cmd)?.[1] ?? "other";
}

function sshBehavior(cmd: string): ExecFileBehavior {
  const step = stepOf(cmd);
  const r = sshRoutes[step];
  if (Array.isArray(r)) return (r.length > 1 ? r.shift() : r[0]) ?? ok();
  return r ?? DEFAULT_SSH[step] ?? (step === "pm2" ? pm2Default() : ok());
}

vi.mock("node:child_process", () => ({
  execFile: (bin: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const opts =
      typeof optsOrCb === "object" && optsOrCb !== null ? (optsOrCb as { cwd?: string }) : undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cb = (maybeCb ?? optsOrCb) as any;
    execFileCalls.push({ bin, args, cwd: opts?.cwd });
    const behavior =
      bin === "ssh"
        ? sshBehavior(args[args.length - 1] ?? "")
        : (execFileQueues[bin]?.shift() ?? execFileBehaviors[bin] ?? ok());
    setImmediate(() => {
      if (behavior.exitCode === 0 && behavior.killed !== true) {
        cb(null, behavior.stdout, behavior.stderr);
      } else {
        const err = new Error(`${bin} exited ${behavior.exitCode}`) as Error & {
          code?: number | string | null;
          killed?: boolean;
          signal?: string | null;
        };
        err.code = behavior.killed === true ? null : behavior.exitCode;
        err.killed = behavior.killed === true;
        err.signal = behavior.killed === true ? "SIGTERM" : null;
        cb(err, behavior.stdout, behavior.stderr);
      }
    });
    return { mocked: true };
  },
}));

// ----- env / fixture helpers -----

let tmpBrain: string;
const envBackup: Record<string, string | undefined> = {};
let server: Server | null = null;

function writeConfig(content: Record<string, unknown>): void {
  writeFileSync(join(tmpBrain, "config.json"), JSON.stringify(content, null, 2) + "\n");
}

/** A loopback /health; returns its URL. */
async function health(status: number, body: string): Promise<string> {
  server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function config(repoPath = "/srv/igris", url?: string): Promise<void> {
  writeConfig({
    vps: { host: "vps.example.com", user: "deploy", repo_path: repoPath },
    remote_brain: { url: url ?? (await health(200, '{"status":"ok"}')), api_key: "k" },
  });
}

const FAST = {
  runId: "20260930T120000Z-b116",
  pollIntervalMs: 1,
  postRestartDelayMs: 0,
  restartPollMs: 1,
  restartVerifyMs: 200,
  restartRetryDelayMs: 0,
};

async function run(extra: Record<string, unknown> = {}): Promise<{ code: number; out: string }> {
  const buf: string[] = [];
  const push = (chunk: unknown) => {
    buf.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
  const o = vi.spyOn(process.stdout, "write").mockImplementation(push);
  const e = vi.spyOn(process.stderr, "write").mockImplementation(push);
  try {
    const { runSyncCode } = await import("../lib/sync/code.js");
    const code = await runSyncCode({ repoPath: tmpBrain, ...FAST, ...extra });
    return { code, out: buf.join("") };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

const sshCmds = (): string[] =>
  execFileCalls.filter((c) => c.bin === "ssh").map((c) => c.args[c.args.length - 1] ?? "");
const steps = (): string[] => sshCmds().map(stepOf);
const binOrder = (): string[] =>
  execFileCalls.map((c) => (c.bin === "ssh" ? `ssh:${stepOf(c.args[c.args.length - 1] ?? "")}` : c.bin));

beforeEach(() => {
  tmpBrain = mkdtempSync(join(tmpdir(), "igris-cli-sync-code-"));
  envBackup.IGRIS_BRAIN_DIR = process.env.IGRIS_BRAIN_DIR;
  process.env.IGRIS_BRAIN_DIR = tmpBrain;
  execFileBehaviors = {};
  execFileQueues = {};
  sshRoutes = {};
  execFileCalls.length = 0;
});

afterEach(async () => {
  if (server !== null) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  rmSync(tmpBrain, { recursive: true, force: true });
  process.env.IGRIS_BRAIN_DIR = envBackup.IGRIS_BRAIN_DIR;
  vi.restoreAllMocks();
});

describe("sync code — runSyncCode", () => {
  it("vps not configured → exit 1", async () => {
    writeConfig({ remote_brain: { url: "http://127.0.0.1:1", api_key: "k" } });
    const { runSyncCode } = await import("../lib/sync/code.js");
    expect(await runSyncCode({ repoPath: tmpBrain })).toBe(1);
  });

  it("remote_brain not configured → exit 1", async () => {
    writeConfig({ vps: { host: "h", user: "u", repo_path: "/repo" } });
    const { runSyncCode } = await import("../lib/sync/code.js");
    expect(await runSyncCode({ repoPath: tmpBrain })).toBe(1);
  });

  it("happy path: preflight → rsync → launch → poll → restart → pm2 + health; exit 0", async () => {
    await config();
    const { code, out } = await run();
    expect(code, out).toBe(0);

    const rsyncCall = execFileCalls.find((c) => c.bin === "rsync");
    expect(rsyncCall?.args).toEqual(expect.arrayContaining(["-a", "-z", "--delete"]));
    // TD-135: exclusion list — load-bearing + representative coverage.
    for (const x of ["node_modules/", ".git/", "dist/", ".env", ".DS_Store", ".igris-deploy/"]) {
      expect(rsyncCall?.args).toContain(`--exclude=${x}`);
    }
    const src = rsyncCall?.args[rsyncCall.args.length - 2] ?? "";
    expect(src.endsWith("/")).toBe(true);
    expect(rsyncCall?.args[rsyncCall.args.length - 1]).toBe("deploy@vps.example.com:/srv/igris/");

    // Refusals happen BEFORE rsync; the restart only after rc code=0 phase=done.
    expect(binOrder()).toEqual([
      "ssh:preflight",
      "rsync",
      "ssh:launch",
      "ssh:poll",
      "ssh:pm2", // the restart-count baseline, read BEFORE the restart (B4)
      "ssh:restart",
      "ssh:pm2",
      "ssh:pm2",
    ]);
    const first = execFileCalls[0];
    expect(first?.args).toEqual(expect.arrayContaining(["deploy@vps.example.com", "--", "-o"]));
    expect(first?.args.some((a) => a.startsWith("ConnectTimeout="))).toBe(true);
    expect(sshCmds().find((c) => stepOf(c) === "restart")).toContain("pm2 restart igris-brain");
    expect(out).toContain("sync code: deployed run 20260930T120000Z-b116 — install 40s, build 12s; pm2 online (node 22.12.0); health ok");
    expect(out).toContain("VPS Node v22.12.0 — within engines range");
  });

  it("TD-135 / TD-141 re-expressed on the launched runner: root npm ci in the stage; build in stage/brain-mcp-server; smoke instantiates BEFORE the swap", async () => {
    await config();
    await run();
    const launch = sshCmds().find((c) => stepOf(c) === "launch") ?? "";
    expect(launch).toContain('(cd "$D/stage" && npm ci --no-audit --no-fund)');
    expect(launch).not.toMatch(/brain-mcp-server" && npm ci/);
    expect(launch).toContain('(cd "$D/stage/brain-mcp-server" && npm run build)');
    expect(launch).toContain('require("better-sqlite3")');
    expect(launch.indexOf("ph smoke-stage")).toBeLessThan(launch.indexOf("ph swap"));
    expect(launch.indexOf("ph build")).toBeLessThan(launch.indexOf("ph smoke-stage"));
    // Detached, every fd redirected, the pid recorded.
    expect(launch).toContain('$L bash "$RUN/run.sh" </dev/null >>"$RUN/log" 2>&1 &');
    expect(launch).toContain('if command -v setsid >/dev/null 2>&1; then L="setsid nohup"; else L=nohup; fi');
  });

  it("TD-135: rsync exclusion list mirrors .gitignore essentials (full audit)", async () => {
    await config("/r");
    await run();
    const args = execFileCalls.find((c) => c.bin === "rsync")?.args ?? [];
    // Every pattern in RSYNC_EXCLUDES (cli/src/lib/sync/code.ts) must appear
    // as a --exclude= flag. Remove one from the source → remove it here.
    const expectedExcludes = [
      "node_modules/",
      ".git/",
      "dist/",
      "build/",
      ".claude/agent-memory/",
      ".claude/agents/",
      ".claude/skills/",
      ".igris_version",
      "CLAUDE.local.md",
      ".env",
      ".env.local",
      "secrets.env",
      "config.json",
      "*.log",
      "logs/",
      ".DS_Store",
      "Thumbs.db",
      ".idea/",
      ".vscode/",
      "*.swp",
      "*.swo",
      "*~",
      "*.tmp",
      "*.temp",
      ".temp/",
      "temp/",
      "__pycache__/",
      ".pytest_cache/",
      "*.pyc",
      "*.pyo",
      "*.pyd",
      ".test/",
      "test-output/",
      "*.zip",
      "*.tar.gz",
      // BR-116: the VPS deploy workspace must survive `--delete`.
      ".igris-deploy/",
    ];
    for (const pattern of expectedExcludes) {
      expect(args).toContain(`--exclude=${pattern}`);
    }
  });

  it("TD-135: a repo_path with a space is single-quoted in every remote command", async () => {
    await config("/srv/my app");
    const { code } = await run();
    expect(code).toBe(0);
    for (const c of sshCmds().filter((x) => ["preflight", "launch", "poll"].includes(stepOf(x)))) {
      expect(c).toContain("R='/srv/my app'");
    }
  });

  it("U1: another deploy running → exit 1 BEFORE rsync, naming the run and phase", async () => {
    await config();
    sshRoutes.preflight = ok("node=v22.12.0\nbusy=1\nbusy_run=20260930T115500Z-aaaa\nbusy_phase=install\nswap_marker=0\navail_kb=9\n");
    const { code, out } = await run();
    expect(code).toBe(1);
    expect(out).toContain("another deploy is running on the VPS — run 20260930T115500Z-aaaa (phase install");
    expect(execFileCalls.find((c) => c.bin === "rsync")).toBeUndefined();
    expect(steps()).toEqual(["preflight"]);
  });

  it("A2f: an interrupted swap → exit 1 BEFORE rsync; journal + manual restore printed, never auto-restored", async () => {
    await config();
    sshRoutes.preflight = ok(
      "node=v22.12.0\nbusy=0\nswap_marker=1\njournal=swap 20260930T110000Z-cccc\njournal=stage->live node_modules\navail_kb=50000000\n",
    );
    const { code, out } = await run();
    expect(code).toBe(1);
    expect(out).toContain("an interrupted swap was found");
    expect(out).toContain("journal: stage->live node_modules");
    expect(out).toContain('mv "prev/$rel" "../$rel"');
    expect(out).toContain("BEFORE re-running `igris sync code`");
    expect(execFileCalls.find((c) => c.bin === "rsync")).toBeUndefined();
    expect(steps()).toEqual(["preflight"]);
  });

  it("N1: no `ps` on the VPS → exit 1 BEFORE rsync, naming the cause", async () => {
    await config();
    sshRoutes.preflight = ok("node=v22.12.0\nps=0\nbusy=0\nswap_marker=0\navail_kb=50000000\n");
    const { code, out } = await run();
    expect(code).toBe(1);
    expect(out).toContain("the VPS has no `ps`");
    expect(execFileCalls.find((c) => c.bin === "rsync")).toBeUndefined();
  });

  it("B4(b): a restart whose pm2 restart count never moves past the pre-restart baseline is NOT healthy", async () => {
    await config();
    sshRoutes.pm2 = ok('{"found":true,"status":"online","restarts":1,"node":"22.12.0"}\n');
    const { code, out } = await run();
    expect(code).toBe(1);
    expect(out).toContain("pm2 status=online (restart count unchanged from 1)");
    expect(steps().filter((s) => s === "restart")).toHaveLength(2);
  });

  it("B4(a): `pm2 restart` exiting non-zero fails the attempt without verifying; the error names it", async () => {
    await config();
    sshRoutes.restart = { exitCode: 1, stdout: "", stderr: "[PM2][ERROR] boom" };
    const { code, out } = await run();
    expect(code).toBe(1);
    expect(out).toContain("pm2 status=not restarted (pm2 restart exit 1)");
    expect(steps()).toEqual(["preflight", "launch", "poll", "pm2", "restart", "restart"]);
  });

  it("U2: projected free disk under 512 MiB → exit 1 BEFORE rsync, naming the numbers", async () => {
    await config();
    sshRoutes.preflight = ok("node=v22.12.0\nbusy=0\nswap_marker=0\navail_kb=1500000\nnm_kb=900000\nprev_kb=0\n");
    const { code, out } = await run();
    expect(code).toBe(1);
    expect(out).toContain("avail_kb=1500000, need=1310720 KB");
    expect(execFileCalls.find((c) => c.bin === "rsync")).toBeUndefined();
  });

  it("the VPS Node below the engines floor is REPORTED (warning), never a refusal", async () => {
    await config();
    sshRoutes.preflight = ok("node=v20.20.0\nbusy=0\nswap_marker=0\navail_kb=50000000\nnm_kb=1\nprev_kb=0\n");
    const { code, out } = await run();
    expect(code).toBe(0);
    expect(out).toContain("warn: sync code: VPS Node v20.20.0 — OUTSIDE engines range >=22.0.0 <23.0.0 || >=24.0.0 <27.0.0");
  });

  it("U3: the launch lost the race (state=busy) → exit 1, no poll issued", async () => {
    await config();
    sshRoutes.launch = ok("state=busy\nrun=20260930T115500Z-aaaa\n");
    const { code, out } = await run();
    expect(code).toBe(1);
    expect(out).toContain("VPS refused the launch (state=busy)");
    expect(steps()).not.toContain("poll");
  });

  it("a launch ssh that times out is 'remote state unknown', not a remote failure", async () => {
    await config();
    sshRoutes.launch = { exitCode: 0, stdout: "", stderr: "", killed: true };
    const { code, out } = await run();
    expect(code).toBe(1);
    expect(out).toContain("launch ssh failed (client-side timeout; remote state unknown)");
    expect(steps()).not.toContain("poll");
  });

  it("U4: three failed polls then success → ONE warning, polling continues, exit 0", async () => {
    await config();
    const fail = { exitCode: 255, stdout: "", stderr: "ssh: connect timed out" };
    sshRoutes.poll = [fail, fail, fail, DEFAULT_SSH.poll];
    const { code, out } = await run();
    expect(code, out).toBe(0);
    expect(out.split("poll failed").length - 1).toBe(1);
    expect(steps().filter((s) => s === "poll")).toHaveLength(4);
  });

  it("A1c: past the wait bound the run is REPORTED still running — nothing is killed, nothing restarted", async () => {
    await config();
    sshRoutes.poll = ok("alive=1\nphase=install\n");
    const { code, out } = await run({ deployWaitMs: 50, pollIntervalMs: 10 });
    expect(code).toBe(1);
    expect(out).toContain("still running (phase install)");
    expect(out).toContain("It was NOT killed and will finish on its own");
    const afterLaunch = sshCmds().slice(sshCmds().findIndex((c) => stepOf(c) === "launch") + 1);
    expect(afterLaunch.length).toBeGreaterThan(0);
    for (const c of afterLaunch) {
      expect(stepOf(c)).toBe("poll");
      expect(c).not.toMatch(/\bpkill\b|kill -(9|KILL|TERM|15|HUP)\b|\brm\b/);
    }
    expect(steps()).not.toContain("restart");
  });

  it("a failed install: the log is tailed and summarized; live untouched; no restart", async () => {
    await config();
    sshRoutes.poll = ok("alive=0\nphase=install\nrc.code=1\nrc.phase=install\nrc.rolled_back=0\nrc.node=v20.20.0\n");
    sshRoutes.tail = ok("=== igris-deploy phase=install start x ===\nnpm warn EBADENGINE Unsupported engine {\nnpm error code EUSAGE\n");
    const { code, out } = await run();
    expect(code).toBe(1);
    expect(out).toContain("error: install failed — npm ci exited 1");
    expect(out).toContain("npm error code EUSAGE");
    expect(out).toContain("live tree untouched; brain not restarted.");
    expect(steps()).toEqual(["preflight", "launch", "poll", "tail"]);
  });

  it("the restart is gated on `code=0 phase=done` exactly — code 0 in any other phase is not success", async () => {
    await config();
    sshRoutes.poll = ok("alive=0\nphase=swap\nrc.code=0\nrc.phase=swap\n");
    const { code } = await run();
    expect(code).toBe(1);
    expect(steps()).not.toContain("restart");
  });

  it("a runner that died (no rc, not alive) → exit 1 'runner died'; no restart", async () => {
    await config();
    sshRoutes.poll = ok("alive=0\nphase=build\n");
    const { code, out } = await run();
    expect(code).toBe(1);
    expect(out).toContain("runner died during build");
    expect(steps()).not.toContain("restart");
  });

  it("BR-116 (inverts the pre-BR-116 'health failure → exit 0 with a warning' pin): health never OK after restart + 1 retry → exit 1 naming the code", async () => {
    await config("/r", "http://127.0.0.1:1"); // nothing listens on port 1
    const { code, out } = await run();
    expect(code).toBe(1);
    expect(out).toContain("brain not healthy after pm2 restart + 1 retry — pm2 status=online restarts=2, health=unreachable");
    expect(steps().filter((s) => s === "restart")).toHaveLength(2);
    expect(out).toContain("pm2 logs igris-brain --lines 50");
  });

  it("/health 200 whose body is not status ok is NOT healthy", async () => {
    await config("/r", await health(200, '{"status":"degraded"}'));
    const { code, out } = await run();
    expect(code).toBe(1);
    expect(out).toContain("health=200 (status not ok)");
  });

  it("a crash-looping 'online' (restart count moves between reads) is not accepted", async () => {
    await config();
    let n = 0;
    sshRoutes.pm2 = Array.from({ length: 400 }, () =>
      ok(`{"found":true,"status":"online","restarts":${(n += 1)},"node":"22.12.0"}\n`),
    );
    const { code, out } = await run();
    expect(code).toBe(1);
    expect(out).toContain("pm2 status=online");
    expect(steps().filter((s) => s === "restart")).toHaveLength(2);
  });

  it("rsync failure: exit 1, the runner is never launched", async () => {
    await config("/r");
    setExec("rsync", { exitCode: 23, stdout: "", stderr: "rsync: failed" });
    const { code } = await run();
    expect(code).toBe(1);
    expect(steps()).toEqual(["preflight"]);
  });

  it("U8 --dry-run: no execFile invoked; the plan names every stage and pinned substring", async () => {
    writeConfig({
      vps: { host: "vps.example.com", user: "deploy", repo_path: "/srv/igris" },
      remote_brain: { url: "http://127.0.0.1:1", api_key: "k" },
    });
    const { code, out } = await run({ dryRun: true });
    expect(code).toBe(0);
    expect(execFileCalls.length).toBe(0);
    for (const s of [
      "Dry-run plan:",
      "rsync",
      "--delete",
      "--exclude=node_modules/",
      "--exclude=.git/",
      "--exclude=dist/",
      "--exclude=.env",
      "--exclude=.igris-deploy/",
      "igris-deploy:preflight",
      "/srv/igris/.igris-deploy",
      "npm ci",
      "npm run build",
      'require("better-sqlite3")',
      "pm2 restart igris-brain",
      "pm2 jlist",
      "/health",
    ]) {
      expect(out, s).toContain(s);
    }
  });

  it("--if-changed: when local HEAD matches origin → exit 0, no rsync invoked (architect-added Risk #9)", async () => {
    writeConfig({
      vps: { host: "h", user: "u", repo_path: "/r" },
      remote_brain: { url: "http://127.0.0.1:1", api_key: "k" },
    });
    // git rev-parse → "main"; git fetch → 0; git diff --quiet → 0 (no diff).
    setExec("git", { exitCode: 0, stdout: "main\n", stderr: "" });
    const { code } = await run({ ifChanged: true });
    expect(code).toBe(0);
    expect(execFileCalls.some((c) => c.bin === "git")).toBe(true);
    expect(execFileCalls.find((c) => c.bin === "rsync")).toBeUndefined();
    expect(execFileCalls.find((c) => c.bin === "ssh")).toBeUndefined();
  });
});

describe("TD-139: .claude/* non-symlink advisory", () => {
  it("warns when .claude/agents/ is a real dir (not symlink, not absent)", async () => {
    await config("/r");
    mkdirSync(join(tmpBrain, ".claude", "agents"), { recursive: true });
    const { code, out } = await run();
    // Advisory only — exit code unaffected.
    expect(code).toBe(0);
    expect(out).toContain(".claude/agents");
    expect(out).toContain("real directory");
  });

  it("does NOT warn when .claude/{agents,skills}/ are absent", async () => {
    await config("/r");
    const { out } = await run();
    expect(out).not.toContain("real directory");
  });
});
