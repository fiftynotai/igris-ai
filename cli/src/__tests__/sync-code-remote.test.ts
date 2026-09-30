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
import { execFileSync } from "node:child_process";
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
