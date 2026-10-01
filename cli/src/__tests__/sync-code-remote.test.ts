/**
 * sync-code-remote.test.ts — BR-116 hermetic fake-ssh tier. NO `vi.mock`.
 *
 * PATH stubs stand in for the remote side and run it LOCALLY; real bash, real
 * node, real rsync. Nothing here resolves a real host.
 *   - `ssh`   runs its last argv as `bash -c` in its own process group, tees
 *             stdout to `wire.log` (what crossed the wire) and, on SIGTERM
 *             (the client's execFile timeout), SIGHUPs that group and exits
 *             255 — sshd tearing the session down. A child that keeps the
 *             stdout pipe open keeps the call open, as with sshd.
 *   - `rsync` strips the `user@host:` prefix and execs the real rsync.
 *   - `npm`   `ci` wipes + writes a stub `better-sqlite3` (a class with
 *             `close()`), honouring SLEEP / EXIT / PARTIAL / SELF_KILL /
 *             THROW_IN_CTOR / LIVE_THROW / EBAD from `$BR116_CTL/npm.env`, and
 *             touches `done-<pid>` only on a natural finish; `run build`
 *             writes `dist/index.js`.
 *   - `pm2`   `restart` logs to `restarts.log` and loads the next line of
 *             `pm2-script` (comma-separated statuses, one per `jlist`, the
 *             last sticks); `jlist` prints a banner + JSON whose `pm2_env`
 *             carries a planted secret.
 * A loopback server answers /health 200 `{"status":"ok"}` iff the last
 * status `jlist` reported is `online` (and `health-force` is absent).
 *
 * "Intact" (AC-2) = a recursive {path → sha256 | link target} manifest of the
 * live SWAP_SET is EQUAL before and after, AND no pm2 restart happened.
 * Fence: HOME repointed + `homedir()` asserted, IGRIS_BRAIN_DIR = $HOME/.igris,
 * both restored individually (the BR-099 shape).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { NPM_EBADENGINE_ONLY } from "./fixtures/br116-npm-output.js";

const CANARY = "sk-br116-canary";
const RUN_ID = "20260930T120000Z-b116";
const SWAP = ["node_modules", "brain-mcp-server/node_modules", "cli/node_modules", "brain-mcp-server/dist"];

let BIN: string;
let T: string;
let CTL: string;
let LOCAL: string;
let VPS: string;
let server: Server;
let port: number;
const saved: Record<string, string | undefined> = {};

function sh(file: string, body: string): void {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

function writeStubs(bin: string, realRsync: string): void {
  sh(
    join(bin, "ssh"),
    `#!/bin/bash
for a in "$@"; do cmd=$a; done
printf '%s\\n----\\n' "$cmd" >> "$BR116_CTL/ssh.log"
trap 'kill -HUP %1 2>/dev/null; exit 255' TERM INT
set -m
set -o pipefail
bash -c "$cmd" | tee -a "$BR116_CTL/wire.log" &
wait $!
`,
  );
  sh(
    join(bin, "rsync"),
    `#!/bin/bash
args=()
for a in "$@"; do case "$a" in *@*:*) a="\${a#*:}";; esac; args+=("$a"); done
exec ${realRsync} "\${args[@]}"
`,
  );
  sh(
    join(bin, "npm"),
    `#!/bin/bash
[ -f "$BR116_CTL/npm.env" ] && . "$BR116_CTL/npm.env"
case "$1" in
  --version) echo 10.9.8 ;;
  ci)
    [ -e .igris-deploy ] && touch "$BR116_CTL/ci-saw-deploy-dir"
    rm -rf node_modules brain-mcp-server/node_modules
    [ -n "\${EBAD:-}" ] && cat "$BR116_CTL/ebad.txt" >&2
    mkdir -p node_modules/better-sqlite3 brain-mcp-server/node_modules/tsx
    if [ -n "\${PARTIAL:-}" ]; then
      touch node_modules/better-sqlite3/LICENSE; mkdir -p node_modules/better-sqlite3/deps
      touch "$BR116_CTL/done-$$"; exit "\${EXIT:-1}"
    fi
    [ -n "\${SELF_KILL:-}" ] && kill -"$SELF_KILL" $$
    sleep "\${SLEEP:-0}"
    body=
    [ -n "\${THROW_IN_CTOR:-}" ] && body='throw new Error("stub: native binding failed to load")'
    [ -n "\${LIVE_THROW:-}" ] && body='if(!__dirname.includes("/.igris-deploy/"))throw new Error("stub: live load failed")'
    echo '{"name":"better-sqlite3","main":"index.js"}' > node_modules/better-sqlite3/package.json
    printf 'module.exports=class D{constructor(){%s}close(){}};// NEW-STUB\\n' "$body" > node_modules/better-sqlite3/index.js
    echo NEW > brain-mcp-server/node_modules/tsx/NEW-MARKER
    [ -n "\${NEW_ONLY:-}" ] && mkdir -p cli/node_modules/new-only && echo NEW > cli/node_modules/new-only/x
    [ -n "\${BLOCK_FAILED:-}" ] && touch ../failed
    touch "$BR116_CTL/done-$$"
    exit "\${EXIT:-0}" ;;
  run)
    mkdir -p dist && echo "// NEW-DIST" > dist/index.js ;;
esac
`,
  );
  sh(
    join(bin, "pm2"),
    `#!/bin/bash
C="$BR116_CTL"
case "$1" in
  restart)
    echo "restart $2" >> "$C/restart-attempts.log"
    [ -f "$C/restart-fail" ] && { echo "[PM2][ERROR] Process $2 not found" >&2; exit 1; }
    echo "restart $2" >> "$C/restarts.log"
    n=$(wc -l < "$C/restarts.log" | tr -d ' ')
    line=$(sed -n "\${n}p" "$C/pm2-script"); [ -z "$line" ] && line=$(tail -n 1 "$C/pm2-script")
    echo "$line" > "$C/pm2-seq"; echo 0 > "$C/pm2-seq-i"
    echo "[PM2] Applying action restartProcessId on app [$2]" ;;
  jlist)
    seq=$(cat "$C/pm2-seq" 2>/dev/null || echo online)
    i=$(cat "$C/pm2-seq-i" 2>/dev/null || echo 0)
    st=$(echo "$seq" | awk -F, -v i=$((i + 1)) '{ if (i > NF) i = NF; print $i }')
    echo $((i + 1)) > "$C/pm2-seq-i"
    echo "$st" > "$C/pm2-state"
    rt=$(wc -l < "$C/restarts.log" | tr -d ' ')
    echo "[PM2] Spawning PM2 daemon with pm2_home=/fake"
    printf '[{"name":"igris-brain","pid":4242,"pm2_env":{"status":"%s","restart_time":%s,"unstable_restarts":0,"node_version":"20.20.0","pm_uptime":1,"BRAIN_API_KEY":"${CANARY}","env":{"BRAIN_API_KEY":"${CANARY}"}}}]\\n' "$st" "$rt" ;;
esac
`,
  );
}

/** {rel path → sha256 | "-> target" | "dir"} over the live SWAP_SET. */
function manifest(repo: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string, rel: string): void => {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) out[rel] = `-> ${readlinkSync(abs)}`;
    else if (st.isDirectory()) {
      out[rel] = "dir";
      for (const e of readdirSync(abs).sort()) walk(join(abs, e), `${rel}/${e}`);
    } else out[rel] = createHash("sha256").update(readFileSync(abs)).digest("hex");
  };
  for (const rel of SWAP) if (existsSync(join(repo, rel))) walk(join(repo, rel), rel);
  return out;
}

function seedSource(dir: string): void {
  mkdirSync(join(dir, "brain-mcp-server"), { recursive: true });
  mkdirSync(join(dir, "cli", "scripts"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"name":"igris-ai","workspaces":["brain-mcp-server","cli"]}\n');
  writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(join(dir, "brain-mcp-server", "package.json"), '{"name":"igris-brain-mcp-server"}\n');
  writeFileSync(join(dir, "cli", "package.json"), '{"name":"igris-ai-cli"}\n');
  writeFileSync(join(dir, "cli", "scripts", "postinstall.mjs"), "// noop\n");
}

function npmEnv(vars: Record<string, string | number>): void {
  writeFileSync(
    join(CTL, "npm.env"),
    Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
  );
}

function capture(): { out: () => string; restore: () => void } {
  const buf: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown) => (buf.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => (buf.push(String(c)), true)) as typeof process.stderr.write;
  return {
    out: () => buf.join(""),
    restore: () => {
      process.stdout.write = o;
      process.stderr.write = e;
    },
  };
}

const FAST = {
  runId: RUN_ID,
  pollIntervalMs: 100,
  postRestartDelayMs: 0,
  restartPollMs: 50,
  restartVerifyMs: 3_000,
  restartRetryDelayMs: 0,
  sshCallTimeoutMs: 8_000,
};

async function deploy(extra: Record<string, unknown> = {}): Promise<{ code: number; out: string }> {
  const { runSyncCode } = await import("../lib/sync/code.js");
  const cap = capture();
  try {
    const code = await runSyncCode({ repoPath: LOCAL, ...FAST, ...extra });
    return { code, out: cap.out() };
  } finally {
    cap.restore();
  }
}

const restarts = (): number =>
  readFileSync(join(CTL, "restarts.log"), "utf-8").split("\n").filter((l) => l.length > 0).length;
const doneMarkers = (): string[] => readdirSync(CTL).filter((f) => f.startsWith("done-"));
const liveBs3 = (): string => join(VPS, "node_modules", "better-sqlite3", "index.js");

const RESTORE_MARK = "restore the previous tree by hand on the VPS (BEFORE re-running `igris sync code`): ";

/** Run the printed restore command VERBATIM (test_standards FR-265), under the stub PATH/CTL. */
function runPrintedRestore(out: string): void {
  const line = out.split("\n").find((l) => l.includes(RESTORE_MARK));
  expect(line, "no restore command printed").toBeDefined();
  const cmd = line!.slice(line!.indexOf(RESTORE_MARK) + RESTORE_MARK.length);
  execFileSync("bash", ["-c", cmd], { env: process.env, stdio: "ignore", timeout: 15_000 });
}

/** Kill every process group a runner of this test left behind (never our own). */
function reapRunners(): void {
  const runs = join(VPS, ".igris-deploy", "runs");
  if (!existsSync(runs)) return;
  const own = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf-8", timeout: 10_000 }).trim();
  for (const id of readdirSync(runs)) {
    const pidFile = join(runs, id, "pid");
    if (!existsSync(pidFile)) continue;
    try {
      const pid = readFileSync(pidFile, "utf-8").trim();
      // Only a live runner of THIS fixture — a reused pid is never touched.
      const args = execFileSync("ps", ["-o", "args=", "-p", pid], { encoding: "utf-8", timeout: 10_000 });
      if (!args.includes(join(runs, id, "run.sh"))) continue;
      const pgid = execFileSync("ps", ["-o", "pgid=", "-p", pid], { encoding: "utf-8", timeout: 10_000 }).trim();
      if (pgid !== "" && pgid !== own) process.kill(-parseInt(pgid, 10), "SIGKILL");
    } catch {
      // already gone
    }
  }
}

beforeAll(() => {
  const realRsync = execFileSync("/bin/sh", ["-c", "command -v rsync"], { encoding: "utf-8", timeout: 10_000 }).trim();
  expect(realRsync.length).toBeGreaterThan(0);
  BIN = mkdtempSync(join(tmpdir(), "br116-bin-"));
  writeStubs(BIN, realRsync);
  // Warm the fresh stubs: first exec of a new script is slow on macOS
  // (test_standards BR-109 trap 2).
  const warm = mkdtempSync(join(tmpdir(), "br116-warm-"));
  const env = { ...process.env, BR116_CTL: warm, PATH: `${BIN}:${process.env.PATH}` };
  writeFileSync(join(warm, "restarts.log"), "");
  for (const [b, a] of [["ssh", ["h", "--", "true"]], ["npm", ["--version"]], ["pm2", ["jlist"]], ["rsync", ["--version"]]] as const) {
    execFileSync(join(BIN, b), [...a], { env, stdio: "ignore", timeout: 15_000 });
  }
  rmSync(warm, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(BIN, { recursive: true, force: true });
});

beforeEach(async () => {
  T = mkdtempSync(join(tmpdir(), "br116-remote-"));
  CTL = join(T, "ctl");
  LOCAL = join(T, "local");
  VPS = join(T, "vps", "repo");
  mkdirSync(CTL, { recursive: true });
  writeFileSync(join(CTL, "restarts.log"), "");
  writeFileSync(join(CTL, "pm2-script"), "online\n");
  writeFileSync(join(CTL, "pm2-state"), "online\n");
  writeFileSync(
    join(CTL, "ebad.txt"),
    NPM_EBADENGINE_ONLY.split("\n").filter((l) => l.startsWith("npm warn")).join("\n") + "\n",
  );
  seedSource(LOCAL);
  seedSource(VPS);
  // The live tree a working brain runs on.
  mkdirSync(join(VPS, "node_modules", "better-sqlite3"), { recursive: true });
  writeFileSync(join(VPS, "node_modules", "better-sqlite3", "package.json"), '{"name":"better-sqlite3","main":"index.js"}\n');
  writeFileSync(liveBs3(), "module.exports=class D{constructor(){}close(){}};// LIVE-MARKER\n");
  mkdirSync(join(VPS, "brain-mcp-server", "node_modules", "tsx"), { recursive: true });
  writeFileSync(join(VPS, "brain-mcp-server", "node_modules", "tsx", "LIVE-MARKER"), "live\n");
  mkdirSync(join(VPS, "brain-mcp-server", "dist"), { recursive: true });
  writeFileSync(join(VPS, "brain-mcp-server", "dist", "index.js"), "// LIVE-DIST\n");

  saved.HOME = process.env.HOME;
  saved.IGRIS_BRAIN_DIR = process.env.IGRIS_BRAIN_DIR;
  saved.PATH = process.env.PATH;
  saved.BR116_CTL = process.env.BR116_CTL;
  const home = join(T, "home");
  mkdirSync(join(home, ".igris"), { recursive: true });
  process.env.HOME = home;
  expect(homedir()).toBe(home); // the fence is ARMED
  process.env.IGRIS_BRAIN_DIR = join(home, ".igris");
  process.env.PATH = `${BIN}:${saved.PATH}`;
  process.env.BR116_CTL = CTL;

  server = createServer((_req, res) => {
    const state = readFileSync(join(CTL, "pm2-state"), "utf-8").trim();
    const forced = existsSync(join(CTL, "health-force"));
    if (state === "online" && !forced) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"ok"}');
    } else {
      res.writeHead(502);
      res.end("bad gateway");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  writeFileSync(
    join(home, ".igris", "config.json"),
    JSON.stringify({
      vps: { host: "vps.test", user: "deploy", repo_path: VPS },
      remote_brain: { url: `http://127.0.0.1:${port}`, api_key: "k" },
    }),
  );
});

afterEach(async () => {
  reapRunners();
  await new Promise<void>((r) => server.close(() => r()));
  for (const k of ["HOME", "IGRIS_BRAIN_DIR", "PATH", "BR116_CTL"] as const) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(T, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("BR-116 AC-1 — a remote npm ci outlives the client's ssh calls", () => {
  it("A1-RED (control): the OLD foreground `cd <repo> && npm ci` is HUP-killed with the session and leaves node_modules wiped", async () => {
    npmEnv({ SLEEP: 3 });
    const { sshExec } = await import("../lib/ssh.js");
    const r = await sshExec("deploy", "vps.test", `cd '${VPS}' && npm ci`, { timeoutMs: 1_000 });
    expect(r.exitCode).not.toBe(0);
    expect(r.timedOut).toBe(true);
    await sleep(3_500);
    expect(doneMarkers()).toEqual([]); // npm never finished
    expect(existsSync(liveBs3())).toBe(false); // the incident: a wiped tree
  }, 20_000);

  it("A1a: npm ci longer than EVERY client ssh call completes on its own; the tree is swapped; one restart", async () => {
    // A prior run's dir must survive the client rsync's --delete (M14).
    mkdirSync(join(VPS, ".igris-deploy", "runs", "20260101T000000Z-0000"), { recursive: true });
    writeFileSync(join(VPS, ".igris-deploy", "runs", "20260101T000000Z-0000", "rc"), "code=0\n");
    npmEnv({ SLEEP: 4, EXIT: 0 });
    const { code, out } = await deploy({ sshCallTimeoutMs: 1_500, pollIntervalMs: 200 });
    expect(code, out).toBe(0);
    expect(doneMarkers()).toHaveLength(1);
    expect(out).toContain(RUN_ID);
    expect(out).toContain("install");
    expect(readFileSync(liveBs3(), "utf-8")).toContain("NEW-STUB");
    expect(readFileSync(join(VPS, "brain-mcp-server", "dist", "index.js"), "utf-8")).toContain("NEW-DIST");
    expect(
      readFileSync(join(VPS, ".igris-deploy", "prev", "node_modules", "better-sqlite3", "index.js"), "utf-8"),
    ).toContain("LIVE-MARKER");
    expect(restarts()).toBe(1);
    expect(existsSync(join(VPS, ".igris-deploy", "runs", "20260101T000000Z-0000", "rc"))).toBe(true);
    expect(existsSync(join(CTL, "ci-saw-deploy-dir"))).toBe(false); // the stage is a clean source copy
    expect(existsSync(join(VPS, ".igris-deploy", "lock"))).toBe(false);
    expect(existsSync(join(VPS, ".igris-deploy", "stage"))).toBe(false);
  }, 40_000);

  it("A1b + A4: a failing install reports npm's real exit code, not its EBADENGINE warnings", async () => {
    npmEnv({ SLEEP: 3, EXIT: 42, EBAD: 1 });
    const before = manifest(VPS);
    const { code, out } = await deploy({ sshCallTimeoutMs: 1_500, pollIntervalMs: 200 });
    expect(code).toBe(1);
    expect(doneMarkers()).toHaveLength(1); // it ran to completion on its own
    expect(out).toContain("install failed — npm ci exited 42");
    const lines = out.split("\n");
    const head = lines.findIndex((l) => l.includes("install failed — npm ci exited 42"));
    const firstNpm = lines.findIndex((l) => /npm (warn|error)/i.test(l));
    expect(firstNpm === -1 || head < firstNpm).toBe(true);
    const ebad = lines.filter((l) => l.includes("EBADENGINE"));
    expect(ebad).toHaveLength(1);
    expect(ebad[0]).toContain("warning lines suppressed");
    expect(manifest(VPS)).toEqual(before);
    expect(restarts()).toBe(0);
  }, 40_000);
});

describe("BR-116 AC-2 — a killed or failed install leaves the live tree intact", () => {
  it("A2a: a PARTIAL install (the incident's LICENSE + deps/) fails in the stage; live untouched", async () => {
    npmEnv({ PARTIAL: 1, EXIT: 1 });
    const before = manifest(VPS);
    const { code, out } = await deploy();
    expect(code).toBe(1);
    expect(out).toContain("install failed");
    expect(out).toContain("live tree untouched");
    expect(manifest(VPS)).toEqual(before);
    expect(restarts()).toBe(0);
    expect(readFileSync(join(CTL, "pm2-state"), "utf-8").trim()).toBe("online");
  }, 30_000);

  it("A2b: npm killed by SIGKILL mid-install → named as SIGKILL (rc 137); live untouched", async () => {
    npmEnv({ SELF_KILL: "KILL" });
    const before = manifest(VPS);
    const { code, out } = await deploy();
    expect(code).toBe(1);
    expect(out).toContain("SIGKILL (rc 137)");
    expect(manifest(VPS)).toEqual(before);
    expect(restarts()).toBe(0);
  }, 30_000);

  it("A2c: the runner killed externally → 'runner died during install'; live untouched; the stale lock does not block the next deploy", async () => {
    npmEnv({ SLEEP: 30 });
    const before = manifest(VPS);
    const { runSyncCode } = await import("../lib/sync/code.js");
    const cap = capture();
    let code: number;
    let out: string;
    try {
      const p = runSyncCode({ repoPath: LOCAL, ...FAST });
      const run = join(VPS, ".igris-deploy", "runs", RUN_ID);
      for (let i = 0; i < 200; i += 1) {
        if (existsSync(join(run, "phase")) && readFileSync(join(run, "phase"), "utf-8").trim() === "install") break;
        await sleep(50);
      }
      expect(readFileSync(join(run, "phase"), "utf-8").trim()).toBe("install");
      reapRunners(); // SIGKILL the runner's process group
      code = await p;
      out = cap.out();
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
    expect(out).toContain("runner died during install");
    expect(manifest(VPS)).toEqual(before);
    expect(restarts()).toBe(0);
    expect(existsSync(join(VPS, ".igris-deploy", "lock"))).toBe(true); // the trap never ran
    npmEnv({});
    const again = await deploy({ runId: "20260930T120500Z-b117" });
    expect(again.out).not.toContain("another deploy is running");
    expect(again.code, again.out).toBe(0);
  }, 40_000);

  it("A2d: the stage smoke INSTANTIATES the binding — a constructor that throws fails smoke-stage; live untouched", async () => {
    npmEnv({ THROW_IN_CTOR: 1 });
    const before = manifest(VPS);
    const { code, out } = await deploy();
    expect(code).toBe(1);
    expect(out).toContain("smoke-stage failed");
    expect(out).toContain("live tree untouched");
    expect(manifest(VPS)).toEqual(before);
    expect(restarts()).toBe(0);
  }, 30_000);

  it("A2e: a live smoke failure after the swap auto-rolls back to the previous tree", async () => {
    npmEnv({ LIVE_THROW: 1 });
    const before = manifest(VPS);
    const { code, out } = await deploy();
    expect(code).toBe(1);
    expect(out).toContain("smoke-live failed");
    expect(out).toContain("auto-rolled back to the previous tree (rollback smoke: ok)");
    expect(manifest(VPS)).toEqual(before);
    expect(
      readFileSync(join(VPS, ".igris-deploy", "failed", "node_modules", "better-sqlite3", "index.js"), "utf-8"),
    ).toContain("NEW-STUB");
    expect(existsSync(join(VPS, ".igris-deploy", "swap.inprogress"))).toBe(false);
    expect(restarts()).toBe(0);
  }, 30_000);
});

describe("BR-116 B1 — the printed restore command, RUN verbatim, restores the previous tree", () => {
  it("after [errored, errored]: restores the pre-deploy tree, NEW-only rels go to failed/, pm2 restarted; idempotent", async () => {
    npmEnv({ NEW_ONLY: 1 });
    writeFileSync(join(CTL, "pm2-script"), "errored\nerrored\n");
    const before = manifest(VPS);
    const { code, out } = await deploy();
    expect(code).toBe(1);
    expect(readFileSync(liveBs3(), "utf-8")).toContain("NEW-STUB"); // the new tree is live
    expect(existsSync(join(VPS, "cli", "node_modules"))).toBe(true);
    runPrintedRestore(out);
    expect(manifest(VPS)).toEqual(before);
    // DECISION: a rel only the NEW tree has is removed from live (moved to failed/).
    expect(existsSync(join(VPS, "cli", "node_modules"))).toBe(false);
    expect(readFileSync(join(VPS, ".igris-deploy", "failed", "cli", "node_modules", "new-only", "x"), "utf-8")).toBe("NEW\n");
    expect(
      readFileSync(join(VPS, ".igris-deploy", "failed", "node_modules", "better-sqlite3", "index.js"), "utf-8"),
    ).toContain("NEW-STUB");
    expect(restarts()).toBe(3);
    runPrintedRestore(out); // a second run changes nothing but restarts pm2
    expect(manifest(VPS)).toEqual(before);
    expect(restarts()).toBe(4);
  }, 30_000);

  it("interrupted swap (hand-seeded mid-swap layout): refused, then the printed restore brings back the original tree and the next deploy succeeds", async () => {
    const before = manifest(VPS);
    const D = join(VPS, ".igris-deploy");
    mkdirSync(join(D, "prev", "brain-mcp-server"), { recursive: true });
    // node_modules: swapped (OLD in prev/, NEW live, journaled).
    execFileSync("mv", [join(VPS, "node_modules"), join(D, "prev", "node_modules")], { timeout: 10_000 });
    mkdirSync(join(VPS, "node_modules", "better-sqlite3"), { recursive: true });
    writeFileSync(liveBs3(), "module.exports=class D{constructor(){}close(){}};// NEW-STUB\n");
    // brain-mcp-server/node_modules: moved to prev/, killed before its stage->live.
    execFileSync("mv", [join(VPS, "brain-mcp-server", "node_modules"), join(D, "prev", "brain-mcp-server", "node_modules")], {
      timeout: 10_000,
    });
    mkdirSync(join(D, "stage", "brain-mcp-server", "node_modules", "tsx"), { recursive: true });
    // cli/node_modules: a NEW-only rel, swapped and journaled.
    mkdirSync(join(VPS, "cli", "node_modules", "new-only"), { recursive: true });
    writeFileSync(join(D, "journal"), "stage->live node_modules\nstage->live cli/node_modules\n");
    writeFileSync(join(D, "swap.inprogress"), "swap 20260930T110000Z-cccc\n");
    expect(manifest(VPS)).not.toEqual(before);

    const { code, out } = await deploy();
    expect(code).toBe(1);
    expect(out).toContain("an interrupted swap was found");
    expect(out).toContain("journal: stage->live cli/node_modules");
    runPrintedRestore(out);
    expect(manifest(VPS)).toEqual(before);
    expect(existsSync(join(D, "swap.inprogress"))).toBe(false);
    expect(restarts()).toBe(1);
    const again = await deploy({ runId: "20260930T120500Z-b117" });
    expect(again.code, again.out).toBe(0);
  }, 30_000);
});

describe("BR-116 N2 / N6 — lock and rollback edges", () => {
  it("N2: a fresh lock with no pid yet counts as HELD — the deploy is refused, nothing launched", async () => {
    mkdirSync(join(VPS, ".igris-deploy", "lock"), { recursive: true });
    writeFileSync(join(VPS, ".igris-deploy", "lock", "run_id"), "20260930T115900Z-aaaa\n");
    const { code, out } = await deploy();
    expect(code).toBe(1);
    expect(out).toContain("another deploy is running on the VPS — run 20260930T115900Z-aaaa");
    expect(existsSync(join(VPS, ".igris-deploy", "runs", RUN_ID))).toBe(false);
  }, 30_000);

  it("N6: a rollback whose moves fail is NOT reported as rolled back; the marker stays and the next deploy refuses", async () => {
    npmEnv({ LIVE_THROW: 1, BLOCK_FAILED: 1 });
    const { code, out } = await deploy();
    expect(code).toBe(1);
    expect(out).not.toContain("auto-rolled back");
    expect(out).toContain("mid-rollback");
    expect(existsSync(join(VPS, ".igris-deploy", "swap.inprogress"))).toBe(true);
    const again = await deploy({ runId: "20260930T120500Z-b117" });
    expect(again.code).toBe(1);
    expect(again.out).toContain("an interrupted swap was found");
  }, 30_000);
});

describe("BR-116 AC-3 — the post-restart state gates the exit code; one retry", () => {
  const noCanary = (out: string): void => {
    expect(out).not.toContain(CANARY);
    const wire = existsSync(join(CTL, "wire.log")) ? readFileSync(join(CTL, "wire.log"), "utf-8") : "";
    expect(wire).not.toContain(CANARY); // S-SEC: never crossed the wire
    expect(wire).toContain('"found":true'); // …and the probe did run
  };

  it("A3a: [errored, online] → exit 0, 2 restarts, the retry reported", async () => {
    writeFileSync(join(CTL, "pm2-script"), "errored\nonline\n");
    const { code, out } = await deploy();
    expect(code, out).toBe(0);
    expect(restarts()).toBe(2);
    expect(out).toContain("pm2=errored");
    expect(out).toContain("recovered on retry 1/1");
    noCanary(out);
  }, 30_000);

  it("A3b: [errored, errored] → exit 1 naming the state; exactly 2 restarts (never 3)", async () => {
    writeFileSync(join(CTL, "pm2-script"), "errored\nerrored\n");
    const { code, out } = await deploy();
    expect(code).toBe(1);
    expect(restarts()).toBe(2);
    expect(out).toContain("pm2 status=errored");
    expect(out).toContain("health=502");
    noCanary(out);
  }, 30_000);

  it("A3c: pm2 online but /health 502 → exit 1 naming both", async () => {
    writeFileSync(join(CTL, "health-force"), "502");
    const { code, out } = await deploy();
    expect(code).toBe(1);
    expect(out).toContain("pm2 status=online");
    expect(out).toContain("health=502");
    expect(restarts()).toBe(2);
    noCanary(out);
  }, 30_000);

  it("A3d: online then errored on the next read is NOT accepted (2-consecutive rule) → retry", async () => {
    writeFileSync(join(CTL, "pm2-script"), "online,errored\nonline\n");
    const { code, out } = await deploy();
    expect(code, out).toBe(0);
    expect(restarts()).toBe(2);
    expect(out).toContain("recovered on retry 1/1");
    noCanary(out);
  }, 30_000);

  it("B4: `pm2 restart` exits 1 while the OLD process stays online → exit 1 naming it; the retry fires", async () => {
    writeFileSync(join(CTL, "restart-fail"), "");
    const { code, out } = await deploy();
    expect(code, out).toBe(1);
    expect(restarts()).toBe(0);
    expect(readFileSync(join(CTL, "restart-attempts.log"), "utf-8").trim().split("\n")).toHaveLength(2);
    expect(out).toContain("pm2 restart exit 1");
    expect(out).not.toContain("deployed run");
  }, 30_000);

  it("A3e (control): [online] → exit 0, exactly 1 restart, no retry", async () => {
    const { code, out } = await deploy();
    expect(code, out).toBe(0);
    expect(restarts()).toBe(1);
    expect(out).not.toMatch(/retry/i);
    expect(out).toContain(`deployed run ${RUN_ID}`);
    expect(out).toContain("health ok");
    noCanary(out);
  }, 30_000);
});

/*
 * BR-117 — the BUILT CLI as a real process. vitest's worker keeps the event
 * loop alive, so every in-process case above passes even when the poll wait is
 * an unref'd timer — the defect that made a standalone `igris sync code` drain
 * its loop right after "launched" and exit 0 with the deploy abandoned
 * (L-1826). These cases spawn `cli/dist/index.js` with no vitest in the child:
 *   - ASYNC `spawn`, never `execFileSync`: the loopback /health server lives in
 *     THIS process's loop, and a sync spawn would starve it.
 *   - The child env drops the keys the CLI's test-runner detection reads (`VITEST`,
 *     `NODE_ENV`) plus `VITEST_*`, `TEST`, `NODE_OPTIONS` (unless a case sets it) and
 *     `IGRIS_REAL_HOME`; vitest's DEV/PROD/MODE/BASE_URL/SSR stay (no cli/src reader,
 *     grep 2026-10-01). HOME, IGRIS_BRAIN_DIR, PATH (stubs first), BR116_CTL: re-asserted.
 *   - `cli/dist` older than the sources it is built from FAILS (never skips).
 *   - `br117-unref-all-timers.cjs` (`--require`) unrefs every user-land timer,
 *     so a FIXED binary reproduces the incident's drained loop (AC-2).
 */
const CLI_DIR = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const CLI_ENTRY = join(CLI_DIR, "dist", "index.js");
const DIST_FROM_SRC = ["index", "verbs/sync", "lib/sync/code", "lib/sync/vps-deploy", "lib/ssh", "lib/mcp-client"];
const PRELOAD_NAME = "br117-unref-all-timers.cjs";
const PRELOAD_ARMED = "br117-preload: every user-land timer is unref'd";
const STRIP_FROM_CHILD = /^(VITEST(_.*)?|TEST|NODE_ENV|NODE_OPTIONS|IGRIS_REAL_HOME)$/;

const PRELOAD_SRC = `"use strict";
// BR-117 test preload: unref every user-land timer, so a standalone CLI
// whose only pending work is a wait drains its loop exactly as the incident did.
const timers = require("node:timers");
const timersP = require("node:timers/promises");
const unref = (t) => { if (t && typeof t.unref === "function") t.unref(); return t; };
for (const [o, k] of [[globalThis, "setTimeout"], [globalThis, "setInterval"], [timers, "setTimeout"], [timers, "setInterval"]]) {
  const orig = o[k];
  o[k] = function (...a) { return unref(orig.apply(this, a)); };
}
const pst = timersP.setTimeout;
timersP.setTimeout = (ms, v, opts) => pst(ms, v, { ...opts, ref: false });
require("node:module").syncBuiltinESMExports();
process.stderr.write(${JSON.stringify(PRELOAD_ARMED + "\n")});
`;

interface CliRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  out: string;
}

/** Fail (never skip) when `cli/dist` predates a source the cases exercise. */
function assertDistFresh(): void {
  expect(
    existsSync(CLI_ENTRY),
    "cli/dist/index.js is absent — run `npm run build` in cli/ (the BR-117 cases spawn the BUILT CLI)",
  ).toBe(true);
  for (const m of DIST_FROM_SRC) {
    const src = lstatSync(join(CLI_DIR, "src", `${m}.ts`)).mtimeMs;
    const dist = lstatSync(join(CLI_DIR, "dist", `${m}.js`)).mtimeMs;
    expect(
      dist >= src,
      `cli/dist is older than src/${m}.ts — run \`npm run build\` in cli/ (the BR-117 cases spawn the BUILT CLI)`,
    ).toBe(true);
  }
}

/** Spawn the BUILT CLI as a real child (async; TD-336 timeout). stdout + stderr in one string. */
function runBuiltCli(args: string[], extraEnv: Record<string, string>, timeoutMs: number): Promise<CliRun> {
  assertDistFresh();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !STRIP_FROM_CHILD.test(k)) env[k] = v;
  }
  Object.assign(env, extraEnv);
  // The fence, re-asserted for the CHILD: it reads $HOME/.igris/config.json, and
  // the stub PATH is what keeps its ssh/rsync/pm2 local.
  expect(env.HOME).toBe(homedir());
  expect(env.HOME.startsWith(T)).toBe(true);
  expect(env.IGRIS_BRAIN_DIR).toBe(join(env.HOME, ".igris"));
  expect(env.PATH.startsWith(`${BIN}:`)).toBe(true);
  expect(JSON.parse(readFileSync(join(env.HOME, ".igris", "config.json"), "utf-8")).vps.host).toBe("vps.test");
  expect(Object.keys(env).filter((k) => /^VITEST|^TEST$|^NODE_ENV$/.test(k))).toEqual([]);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: LOCAL,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, out }));
  });
}

const launchedId = (out: string): string | undefined => /run (\S+) launched on the VPS/.exec(out)?.[1];

describe("BR-117 — the BUILT CLI as a real process (no vitest event loop in the child)", () => {
  beforeAll(() => {
    writeFileSync(join(BIN, PRELOAD_NAME), PRELOAD_SRC);
  });

  it("AC-1: a real `igris sync code` polls through restart + verify and exits with the verified result", async () => {
    // The restart-RETRY path: the only one through all four sleep sites (poll,
    // post-restart settle ×2, retry delay, the healthy-streak poll).
    writeFileSync(join(CTL, "pm2-script"), "errored\nonline\n");
    const { status, signal, out } = await runBuiltCli(["sync", "code"], {}, 80_000);
    const why = `child status=${status} signal=${signal}\n${out}`;
    const id = launchedId(out);
    expect(id, why).toBeDefined();
    expect(out, why).toContain(`deployed run ${id}`);
    expect(status, why).toBe(0);
    expect(signal).toBeNull();
    expect(out).toContain("recovered on retry 1/1");
    expect(out).toContain("health ok");
    expect(restarts()).toBe(2);
    expect(readFileSync(liveBs3(), "utf-8")).toContain("NEW-STUB"); // the swap happened
    expect(out).not.toContain(PRELOAD_ARMED);
    expect(out).not.toContain(CANARY);
    expect(readFileSync(join(CTL, "wire.log"), "utf-8")).not.toContain(CANARY);
  }, 90_000);

  it.each(["code", "all"])(
    "AC-2: a client whose event loop drains mid-run exits 1, never 0 — sync %s",
    async (sub) => {
      npmEnv({ SLEEP: 30 });
      const { status, signal, out } = await runBuiltCli(
        ["sync", sub],
        { NODE_OPTIONS: `--require "${join(BIN, PRELOAD_NAME)}"` },
        45_000,
      );
      const id = launchedId(out);
      // Read FIRST, right after the child closed: an absent rc proves the remote
      // run had not finished, i.e. the loop really drained mid-wait.
      const rcAtExit = id === undefined ? null : existsSync(join(VPS, ".igris-deploy", "runs", id, "rc"));
      const why = `child status=${status} signal=${signal}\n${out}`;
      expect(status, why).toBe(1);
      expect(signal).toBeNull();
      expect(out).toContain(PRELOAD_ARMED); // the harness is armed
      expect(id, why).toBeDefined();
      expect(rcAtExit, "the remote run had already finished — the loop never drained").toBe(false);
      expect(out).not.toContain("deployed run");
      expect(restarts()).toBe(0);
      if (sub === "all") {
        expect(out).not.toContain("sync data");
        expect(out).not.toContain("sync all:");
      }
    },
    60_000,
  );
});

/*
 * TD-487 — the runner skips `npm ci` when the install fingerprint (lockfile,
 * root + workspace manifests, .npmrc, node/npm versions, ABI, platform, arch)
 * equals the marker inside the LIVE `node_modules`, copying the live tree into
 * the stage instead. Oracle for "skipped": `npm ci` is POISONED (EXIT 97), and
 * `done-<pid>` markers count every natural `ci` finish — a missing log line is
 * not proof. Appended after BR-117 so the `:479`/`:501`/`:603` cites hold.
 */
describe("TD-487 — install fingerprint: reuse the live node_modules when nothing install-relevant changed", () => {
  const D = (): string => join(VPS, ".igris-deploy");
  const rcOf = (id: string): Record<string, string> =>
    Object.fromEntries(
      readFileSync(join(D(), "runs", id, "rc"), "utf-8")
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
  const logOf = (id: string): string => readFileSync(join(D(), "runs", id, "log"), "utf-8");
  const FP_FILE = (root: string): string => join(root, "node_modules", ".igris-install-fp");
  const fpLive = (): string | undefined =>
    existsSync(FP_FILE(VPS)) ? readFileSync(FP_FILE(VPS), "utf-8").trim() : undefined;
  const FP_RE = /^v1-[0-9a-f]{64}$/;
  const ids = ["20261001T120000Z-4870", "20261001T120100Z-4871", "20261001T120200Z-4872"];
  const at = (log: string, phase: string): number => log.indexOf(`=== igris-deploy phase=${phase} start`);
  const RECORDER =
    'module.exports=class D{constructor(){require("fs").appendFileSync(process.env.BR116_CTL+"/smoke.log",__dirname+"\\n")}close(){}};// RECORDER\n';

  it("T1 (AC-1): unchanged inputs → npm ci NEVER runs (poisoned), the reused copy passes the stage smoke BEFORE the swap and goes live", async () => {
    npmEnv({ NEW_ONLY: 1 });
    const first = await deploy({ runId: ids[0] });
    expect(first.code, first.out).toBe(0);
    // Mark the LIVE tree so "the copy went live" is observable.
    writeFileSync(liveBs3(), RECORDER);
    mkdirSync(join(VPS, "node_modules", ".bin"), { recursive: true });
    execFileSync("ln", ["-s", "../better-sqlite3/index.js", join(VPS, "node_modules", ".bin", "rel")], { timeout: 10_000 });
    writeFileSync(join(VPS, "brain-mcp-server", "dist", "index.js"), "// LIVE-DIST-2\n");
    npmEnv({ EXIT: 97 }); // a poisoned npm ci: if it runs, the deploy fails
    const second = await deploy({ runId: ids[1] });
    expect(second.code, second.out).toBe(0);
    expect(doneMarkers(), "npm ci ran on the unchanged-input deploy").toHaveLength(1);
    const rc1 = rcOf(ids[0]);
    expect([rc1.install, rc1.install_why]).toEqual(["ran", "first"]);
    const rc2 = rcOf(ids[1]);
    expect(rc2.install).toBe("skipped");
    expect(fpLive()).toMatch(FP_RE);
    const log = logOf(ids[1]);
    expect(at(log, "install"), "a skipped deploy entered the install phase").toBe(-1);
    for (const [a, b] of [["reuse", "build"], ["build", "smoke-stage"], ["smoke-stage", "swap"], ["swap", "smoke-live"]]) {
      expect(at(log, a), `${a} before ${b}`).toBeGreaterThanOrEqual(0);
      expect(at(log, a), `${a} before ${b}`).toBeLessThan(at(log, b));
    }
    const smokes = readFileSync(join(CTL, "smoke.log"), "utf-8").trim().split("\n");
    const firstLive = smokes.findIndex((l) => !l.includes("/.igris-deploy/"));
    expect(smokes.slice(0, firstLive).filter((l) => l.includes("/.igris-deploy/stage/")).length, smokes.join("\n")).toBeGreaterThanOrEqual(2);
    expect(firstLive, "the stage smoke ran on the reused copy before any live smoke").toBeGreaterThan(0);
    expect(readFileSync(liveBs3(), "utf-8")).toContain("RECORDER"); // the copied tree went live
    expect(readFileSync(join(VPS, "brain-mcp-server", "dist", "index.js"), "utf-8")).toContain("NEW-DIST"); // the build ran
    expect(readFileSync(join(VPS, "cli", "node_modules", "new-only", "x"), "utf-8"), "every NM rel copied").toBe("NEW\n");
    expect(readlinkSync(join(VPS, "node_modules", ".bin", "rel"))).toBe("../better-sqlite3/index.js");
    expect(readFileSync(FP_FILE(join(D(), "prev")), "utf-8").trim(), "prev/ holds deploy#1's tree").toBe(fpLive());
    expect(second.out).toContain("install skipped (node_modules reused in");
    expect(restarts()).toBe(2);
  }, 60_000);

  it("T1b (AC-1 fidelity): the transformers model cache is NOT carried into the reused tree (npm ci never makes it); prev/ keeps it", async () => {
    const first = await deploy({ runId: ids[0] });
    expect(first.code, first.out).toBe(0);
    const cache = join("node_modules", "@huggingface", "transformers", ".cache");
    mkdirSync(join(VPS, cache), { recursive: true });
    writeFileSync(join(VPS, cache, "m.onnx"), "partial-model");
    writeFileSync(join(VPS, "node_modules", "@huggingface", "transformers", "index.js"), "// pkg\n");
    npmEnv({ EXIT: 97 });
    const second = await deploy({ runId: ids[1] });
    expect(second.code, second.out).toBe(0);
    expect(rcOf(ids[1]).install).toBe("skipped");
    expect(existsSync(join(VPS, "node_modules", "@huggingface", "transformers", "index.js")), "the package itself is copied").toBe(true);
    expect(existsSync(join(VPS, cache, "m.onnx")), "the runtime model cache was copied forward").toBe(false);
    expect(readFileSync(join(D(), "prev", cache, "m.onnx"), "utf-8")).toBe("partial-model");
  }, 60_000);

  it("T2 (AC-2 lockfile): one changed lockfile byte → npm ci runs as today (changed)", async () => {
    const first = await deploy({ runId: ids[0] });
    expect(first.code, first.out).toBe(0);
    const f1 = fpLive();
    writeFileSync(join(LOCAL, "package-lock.json"), '{"lockfileVersion":3} \n');
    const second = await deploy({ runId: ids[1] });
    expect(second.code, second.out).toBe(0);
    expect(doneMarkers(), "npm ci did not run on a changed lockfile").toHaveLength(2);
    expect([rcOf(ids[1]).install, rcOf(ids[1]).install_why]).toEqual(["ran", "changed"]);
    expect(second.out).toContain("(npm ci: changed)");
    expect(fpLive()).toMatch(FP_RE);
    expect(fpLive()).not.toBe(f1);
  }, 60_000);

  it("T3 (AC-2 Node): a changed `node --version` → npm ci runs (changed); rc.node names it", async () => {
    const node = join(BIN, "node");
    sh(
      node,
      `#!/bin/bash
if [ "$1" = --version ] && [ -f "$BR116_CTL/node-version" ]; then cat "$BR116_CTL/node-version"; exit 0; fi
exec ${JSON.stringify(process.execPath)} "$@"
`,
    );
    try {
      execFileSync(node, ["--version"], { env: process.env, stdio: "ignore", timeout: 15_000 }); // warm
      const first = await deploy({ runId: ids[0] });
      expect(first.code, first.out).toBe(0);
      writeFileSync(join(CTL, "node-version"), "v22.99.0\n");
      const second = await deploy({ runId: ids[1] });
      expect(second.code, second.out).toBe(0);
      expect(rcOf(ids[1]).node).toBe("v22.99.0");
      expect([rcOf(ids[1]).install, rcOf(ids[1]).install_why], "a Node bump reused the old tree").toEqual(["ran", "changed"]);
      expect(doneMarkers()).toHaveLength(2);
    } finally {
      rmSync(node, { force: true });
    }
  }, 60_000);

  it("T4 (AC-2, L-965): a dependency added to a WORKSPACE manifest with the lockfile untouched → npm ci runs (changed)", async () => {
    const first = await deploy({ runId: ids[0] });
    expect(first.code, first.out).toBe(0);
    writeFileSync(join(LOCAL, "cli", "package.json"), '{"name":"igris-ai-cli","dependencies":{"left-pad":"1.3.0"}}\n');
    const second = await deploy({ runId: ids[1] });
    expect(second.code, second.out).toBe(0);
    expect([rcOf(ids[1]).install, rcOf(ids[1]).install_why], "a workspace manifest change reused the old tree").toEqual(["ran", "changed"]);
    expect(doneMarkers()).toHaveLength(2);
  }, 60_000);

  it("T5 (control — not over-broad): a docs + brain-source change still reuses (npm ci poisoned)", async () => {
    const first = await deploy({ runId: ids[0] });
    expect(first.code, first.out).toBe(0);
    writeFileSync(join(LOCAL, "README.md"), "# changed\n");
    mkdirSync(join(LOCAL, "brain-mcp-server", "src"), { recursive: true });
    writeFileSync(join(LOCAL, "brain-mcp-server", "src", "x.ts"), "export const x = 1;\n");
    npmEnv({ EXIT: 97 });
    const second = await deploy({ runId: ids[1] });
    expect(second.code, second.out).toBe(0);
    expect(rcOf(ids[1]).install).toBe("skipped");
    expect(doneMarkers()).toHaveLength(1);
  }, 60_000);

  it("T6 (fallback): a reused copy that fails the EARLY smoke falls back to npm ci in the same run; the bad copy never goes live", async () => {
    const first = await deploy({ runId: ids[0] });
    expect(first.code, first.out).toBe(0);
    // Throws only when loaded from the stage — so only the reuse smoke can see it.
    writeFileSync(
      liveBs3(),
      'module.exports=class D{constructor(){if(__dirname.includes("/.igris-deploy/"))throw new Error("stale copy")}close(){}};// STAGE-THROW\n',
    );
    npmEnv({});
    const second = await deploy({ runId: ids[1] });
    expect(second.code, second.out).toBe(0);
    expect([rcOf(ids[1]).install, rcOf(ids[1]).install_why]).toEqual(["ran", "reuse-failed"]);
    const log = logOf(ids[1]);
    expect(at(log, "reuse")).toBeGreaterThanOrEqual(0);
    expect(at(log, "reuse")).toBeLessThan(at(log, "install"));
    expect(at(log, "install")).toBeLessThan(at(log, "build"));
    expect(doneMarkers()).toHaveLength(2);
    expect(readFileSync(liveBs3(), "utf-8")).toContain("NEW-STUB");
    expect(second.out).toContain("node_modules reuse failed (see ");
    expect(second.out).toContain("(npm ci: reuse-failed)");
  }, 60_000);

  it("T7 (absolute-link guard): an absolute symlink in the live tree refuses the reuse → npm ci", async () => {
    const first = await deploy({ runId: ids[0] });
    expect(first.code, first.out).toBe(0);
    execFileSync("ln", ["-s", T, join(VPS, "node_modules", "abs")], { timeout: 10_000 });
    const second = await deploy({ runId: ids[1] });
    expect(second.code, second.out).toBe(0);
    expect([rcOf(ids[1]).install, rcOf(ids[1]).install_why]).toEqual(["ran", "reuse-failed"]);
    expect(logOf(ids[1])).toContain("reuse: absolute symlink under node_modules");
    expect(existsSync(join(VPS, "node_modules", "abs"))).toBe(false);
  }, 60_000);

  it("T7b (guard fails CLOSED): a `find` that cannot run `-lname` (BusyBox-like) refuses the reuse → npm ci", async () => {
    const find = join(BIN, "find");
    const real = execFileSync("/bin/sh", ["-c", "command -v find"], { encoding: "utf-8", timeout: 10_000 }).trim();
    sh(find, `#!/bin/bash\nfor a in "$@"; do [ "$a" = -lname ] && { echo "find: unknown primary -lname" >&2; exit 1; }; done\nexec ${real} "$@"\n`);
    try {
      execFileSync(find, ["/dev/null", "-maxdepth", "0"], { stdio: "ignore", timeout: 15_000 }); // warm
      const first = await deploy({ runId: ids[0] });
      expect(first.code, first.out).toBe(0);
      const second = await deploy({ runId: ids[1] });
      expect(second.code, second.out).toBe(0);
      expect([rcOf(ids[1]).install, rcOf(ids[1]).install_why], "an unrunnable guard let the copy through").toEqual(["ran", "reuse-failed"]);
    } finally {
      rmSync(find, { force: true });
    }
  }, 60_000);

  it("T8 (rollback keeps tree↔marker): a rolled-back npm ci tree goes to failed/ WITHOUT a marker; the restored tree keeps its own, and is reused next", async () => {
    const first = await deploy({ runId: ids[0] });
    expect(first.code, first.out).toBe(0);
    const f1 = fpLive();
    expect(f1).toMatch(FP_RE);
    const lock = readFileSync(join(LOCAL, "package-lock.json"), "utf-8");
    writeFileSync(join(LOCAL, "package-lock.json"), lock + " ");
    npmEnv({ LIVE_THROW: 1 });
    const second = await deploy({ runId: ids[1] });
    expect(second.code).toBe(1);
    expect(second.out).toContain("auto-rolled back to the previous tree (rollback smoke: ok)");
    expect(fpLive(), "the marker came back WITH its tree").toBe(f1);
    expect(existsSync(FP_FILE(join(D(), "failed"))), "an unacknowledged tree carries a marker").toBe(false);
    writeFileSync(join(LOCAL, "package-lock.json"), lock);
    npmEnv({ EXIT: 97 });
    const third = await deploy({ runId: ids[2] });
    expect(third.code, third.out).toBe(0);
    expect(rcOf(ids[2]).install).toBe("skipped");
  }, 90_000);

  it("T8b (rollback of a REUSED tree): the copy carries no marker into failed/ — the marker is never copied, only acknowledged", async () => {
    const first = await deploy({ runId: ids[0] });
    expect(first.code, first.out).toBe(0);
    const f1 = fpLive();
    // Loads in the stage, throws live: the reused copy passes both stage smokes, fails smoke-live.
    writeFileSync(
      liveBs3(),
      'module.exports=class D{constructor(){if(!__dirname.includes("/.igris-deploy/"))throw new Error("live")}close(){}};// LIVE-ONLY-THROW\n',
    );
    npmEnv({ EXIT: 97 });
    const second = await deploy({ runId: ids[1] });
    expect(second.code).toBe(1);
    expect(rcOf(ids[1]).install).toBe("skipped");
    expect(second.out).toContain("auto-rolled back to the previous tree");
    expect(existsSync(join(D(), "failed", "node_modules", "better-sqlite3", "index.js"))).toBe(true);
    expect(existsSync(FP_FILE(join(D(), "failed"))), "the reused copy carried a marker").toBe(false);
    expect(fpLive()).toBe(f1);
  }, 60_000);

  it("T9 (printed restore keeps tree↔marker): after a failed restart + the restore RUN verbatim, the live marker is the restored tree's; the next changed-input deploy reinstalls", async () => {
    writeFileSync(join(CTL, "pm2-script"), "online\nerrored\nerrored\nonline\nonline\n");
    const first = await deploy({ runId: ids[0] });
    expect(first.code, first.out).toBe(0);
    const f1 = fpLive();
    writeFileSync(join(LOCAL, "package-lock.json"), '{"lockfileVersion":3,"t9":1}\n');
    const second = await deploy({ runId: ids[1] });
    expect(second.code).toBe(1); // the runner succeeded (F2 written); the restart did not
    const f2 = fpLive();
    expect(f2).toMatch(FP_RE);
    expect(f2).not.toBe(f1);
    runPrintedRestore(second.out);
    expect(fpLive(), "the restored tree is described by its own marker").toBe(f1);
    expect(readFileSync(FP_FILE(join(D(), "failed")), "utf-8").trim()).toBe(f2);
    // The live tree is F1's, the inputs are F2's: a false skip here would put F1's deps live.
    const third = await deploy({ runId: ids[2] });
    expect(third.code, third.out).toBe(0);
    expect([rcOf(ids[2]).install, rcOf(ids[2]).install_why]).toEqual(["ran", "changed"]);
    expect(doneMarkers()).toHaveLength(3);
  }, 90_000);

  it("T10 (force, run verbatim): the printed hint deletes the marker; the next deploy runs npm ci (first)", async () => {
    const HINT = "sync code: force a clean npm ci on the next deploy: ";
    expect((await deploy({ runId: ids[0] })).code).toBe(0);
    const second = await deploy({ runId: ids[1] });
    expect(second.code, second.out).toBe(0);
    const line = second.out.split("\n").find((l) => l.includes(HINT));
    expect(line, "no force hint printed on a skipped deploy").toBeDefined();
    expect(fpLive()).toMatch(FP_RE);
    execFileSync("bash", ["-c", line!.slice(line!.indexOf(HINT) + HINT.length)], { env: process.env, stdio: "ignore", timeout: 15_000 });
    expect(existsSync(FP_FILE(VPS)), "the printed command left the marker").toBe(false);
    const third = await deploy({ runId: ids[2] });
    expect(third.code, third.out).toBe(0);
    expect([rcOf(ids[2]).install, rcOf(ids[2]).install_why]).toEqual(["ran", "first"]);
    expect(doneMarkers()).toHaveLength(2);
  }, 90_000);

  it("T11 (unfingerprinted): a stage the fingerprint cannot read runs npm ci and writes NO marker", async () => {
    const first = await deploy({ runId: ids[0] });
    expect(first.code, first.out).toBe(0);
    const f1 = fpLive();
    expect(f1).toMatch(FP_RE);
    rmSync(join(LOCAL, "package-lock.json")); // the client's rsync --delete removes it on the VPS too
    const second = await deploy({ runId: ids[1] });
    expect(second.code, second.out).toBe(0);
    expect([rcOf(ids[1]).install, rcOf(ids[1]).install_why]).toEqual(["ran", "unfingerprinted"]);
    expect(doneMarkers()).toHaveLength(2);
    expect(fpLive(), "an unfingerprinted install was given a marker").toBeUndefined();
    expect(readFileSync(FP_FILE(join(D(), "prev")), "utf-8").trim(), "the old tree keeps its own").toBe(f1);
  }, 60_000);
});
