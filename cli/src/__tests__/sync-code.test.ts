/**
 * sync-code.test.ts — M4.2 (MG-014).
 *
 * Mocks `node:child_process` at the boundary (per L-159 / TD-098: the
 * lib/ssh wrapper is the module under test, so we mock its child_process
 * dependency, NOT lib/ssh itself).
 *
 * Mocks `node:http` healthCheck via real loopback HTTP server so the post-
 * restart health probe lands on a controllable surface.
 *
 * Coverage:
 *   - rsync command shape (-az --delete, src/dst formatting)
 *   - ssh restart command shape (pm2 restart <appName>)
 *   - health check: pass + fail (warn-only, exit 0 either way as long as rsync+ssh ok)
 *   - --dry-run: no execFile invoked
 *   - --if-changed (architect-added): skip when nothing changed
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// ----- child_process mock -----
//
// Per-test mutable behavior. We capture every execFile call and let the
// test decide what each binary returns.
//
// Two layered mechanisms:
//   - `execFileBehaviors[bin]` — DEFAULT behavior per bin (legacy seam).
//   - `execFileQueues[bin]`    — per-call FIFO queue (TD-135). Each ssh
//     call shifts the next element off the queue; falls back to the
//     default if the queue is empty. Lets a test simulate "npm ci OK,
//     build OK, pm2 OK, smoke FAIL" with stage-specific behavior.

type ExecFileBehavior = {
  exitCode: number;
  stdout: string;
  stderr: string;
};
type ExecFileBehaviorByBin = Record<string, ExecFileBehavior>;

let execFileBehaviors: ExecFileBehaviorByBin = {};
let execFileQueues: Record<string, ExecFileBehavior[]> = {};
const execFileCalls: Array<{ bin: string; args: string[]; cwd?: string }> = [];

function setExec(bin: string, behavior: ExecFileBehavior): void {
  execFileBehaviors[bin] = behavior;
}

function queueExec(bin: string, behaviors: ExecFileBehavior[]): void {
  execFileQueues[bin] = [...behaviors];
}

vi.mock("node:child_process", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execFile: (
    bin: string,
    args: string[],
    optsOrCb: unknown,
    maybeCb?: unknown,
  ) => {
    // node:child_process.execFile has overloads: (bin, args, cb) and
    // (bin, args, opts, cb). We need to handle both.
    const opts = typeof optsOrCb === "object" && optsOrCb !== null
      ? (optsOrCb as { cwd?: string })
      : undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cb = (maybeCb ?? optsOrCb) as any;
    execFileCalls.push({ bin, args, cwd: opts?.cwd });

    // Prefer queued behavior; fall back to per-bin default; final fallback
    // is a generic success.
    const queued = execFileQueues[bin]?.shift();
    const behavior =
      queued ??
      execFileBehaviors[bin] ?? {
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    setImmediate(() => {
      if (behavior.exitCode === 0) {
        cb(null, behavior.stdout, behavior.stderr);
      } else {
        const err = new Error(`${bin} exited ${behavior.exitCode}`) as Error & {
          code?: number | string;
        };
        err.code = behavior.exitCode;
        cb(err, behavior.stdout, behavior.stderr);
      }
    });
    return { mocked: true };
  },
}));

// ----- env / fixture helpers -----

let tmpBrain: string;
const envBackup: Record<string, string | undefined> = {};

function writeConfig(content: Record<string, unknown>): void {
  writeFileSync(
    join(tmpBrain, "config.json"),
    JSON.stringify(content, null, 2) + "\n",
  );
}

beforeEach(() => {
  tmpBrain = mkdtempSync(join(tmpdir(), "igris-cli-sync-code-"));
  envBackup.IGRIS_BRAIN_DIR = process.env.IGRIS_BRAIN_DIR;
  process.env.IGRIS_BRAIN_DIR = tmpBrain;
  execFileBehaviors = {};
  execFileQueues = {};
  execFileCalls.length = 0;
});

afterEach(() => {
  rmSync(tmpBrain, { recursive: true, force: true });
  process.env.IGRIS_BRAIN_DIR = envBackup.IGRIS_BRAIN_DIR;
  vi.restoreAllMocks();
});

describe("sync code — runSyncCode", () => {
  it("vps not configured → exit 1", async () => {
    writeConfig({
      remote_brain: { url: "http://127.0.0.1:1", api_key: "k" },
    });
    const { runSyncCode } = await import("../lib/sync/code.js");
    const code = await runSyncCode({ repoPath: tmpBrain });
    expect(code).toBe(1);
  });

  it("remote_brain not configured → exit 1", async () => {
    writeConfig({
      vps: { host: "h", user: "u", repo_path: "/repo" },
    });
    const { runSyncCode } = await import("../lib/sync/code.js");
    const code = await runSyncCode({ repoPath: tmpBrain });
    expect(code).toBe(1);
  });

  it("happy path: rsync + ssh shapes correct, health passes, exit 0", async () => {
    const server = createServer(
      (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", version: "7.0.0" }));
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    writeConfig({
      vps: { host: "vps.example.com", user: "deploy", repo_path: "/srv/igris" },
      remote_brain: { url: `http://127.0.0.1:${port}`, api_key: "k" },
    });
    setExec("rsync", { exitCode: 0, stdout: "", stderr: "" });
    setExec("ssh", { exitCode: 0, stdout: "[PM2] OK", stderr: "" });

    try {
      const { runSyncCode } = await import("../lib/sync/code.js");
      const code = await runSyncCode({ repoPath: tmpBrain, postRestartDelayMs: 0 });
      expect(code).toBe(0);

      // rsync invocation shape.
      const rsyncCall = execFileCalls.find((c) => c.bin === "rsync");
      expect(rsyncCall).toBeDefined();
      expect(rsyncCall?.args).toContain("-a");
      expect(rsyncCall?.args).toContain("-z");
      expect(rsyncCall?.args).toContain("--delete");
      // TD-135: exclusion list — load-bearing + representative coverage.
      expect(rsyncCall?.args).toContain("--exclude=node_modules/");
      expect(rsyncCall?.args).toContain("--exclude=.git/");
      expect(rsyncCall?.args).toContain("--exclude=dist/");
      expect(rsyncCall?.args).toContain("--exclude=.env");
      expect(rsyncCall?.args).toContain("--exclude=.DS_Store");
      // src ends with "/" so contents copy into dst.
      const src = rsyncCall?.args[rsyncCall.args.length - 2] ?? "";
      expect(src.endsWith("/")).toBe(true);
      const dst = rsyncCall?.args[rsyncCall.args.length - 1] ?? "";
      expect(dst).toBe("deploy@vps.example.com:/srv/igris/");

      // TD-135: SSH sequence is ordered [npm ci, npm run build,
      // pm2 restart, smoke check]. Length AND order both verified.
      const sshCalls = execFileCalls.filter((c) => c.bin === "ssh");
      expect(sshCalls.length).toBe(4);
      const remoteCmd = (call: { args: string[] } | undefined): string =>
        call?.args[call.args.length - 1] ?? "";
      expect(remoteCmd(sshCalls[0])).toContain("npm ci");
      expect(remoteCmd(sshCalls[0])).toContain("/srv/igris");
      expect(remoteCmd(sshCalls[1])).toContain("npm run build");
      expect(remoteCmd(sshCalls[1])).toContain("brain-mcp-server");
      expect(remoteCmd(sshCalls[2])).toContain("pm2 restart igris-brain");
      expect(remoteCmd(sshCalls[3])).toContain('require("better-sqlite3")');

      // First SSH call should also have the standard transport flags.
      expect(sshCalls[0]?.args).toContain("deploy@vps.example.com");
      expect(sshCalls[0]?.args).toContain("--");
      expect(sshCalls[0]?.args).toContain("-o");
      expect(
        sshCalls[0]?.args.some((a) => a.startsWith("ConnectTimeout=")),
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("TD-135: npm ci runs at workspace root (NOT inside brain-mcp-server); brain build runs in brain-mcp-server", async () => {
    // npm ci must run at the WORKSPACE ROOT so that both cli/ and
    // brain-mcp-server/ workspaces resolve from a single install. If we
    // accidentally cd into brain-mcp-server before npm ci, we'd get a
    // partial install that breaks cli-side dependencies.
    writeConfig({
      vps: { host: "h", user: "u", repo_path: "/srv/igris" },
      remote_brain: { url: "http://127.0.0.1:1", api_key: "k" },
    });
    setExec("rsync", { exitCode: 0, stdout: "", stderr: "" });
    setExec("ssh", { exitCode: 0, stdout: "", stderr: "" });

    const { runSyncCode } = await import("../lib/sync/code.js");
    await runSyncCode({ repoPath: tmpBrain, postRestartDelayMs: 0 });
    const sshCalls = execFileCalls.filter((c) => c.bin === "ssh");
    expect(sshCalls.length).toBe(4);

    // First ssh call: `cd '/srv/igris' && npm ci` — NO brain-mcp-server.
    const npmCiCmd = sshCalls[0]?.args[sshCalls[0].args.length - 1] ?? "";
    expect(npmCiCmd).toMatch(/cd '\/srv\/igris' && npm ci$/);
    expect(npmCiCmd).not.toContain("brain-mcp-server");

    // Second ssh call: build at /srv/igris/brain-mcp-server.
    const buildCmd = sshCalls[1]?.args[sshCalls[1].args.length - 1] ?? "";
    expect(buildCmd).toContain("'/srv/igris'/brain-mcp-server");
    expect(buildCmd).toContain("npm run build");
  });

  it("TD-135: rsync exclusion list mirrors .gitignore essentials (full audit)", async () => {
    writeConfig({
      vps: { host: "h", user: "u", repo_path: "/r" },
      remote_brain: { url: "http://127.0.0.1:1", api_key: "k" },
    });
    setExec("rsync", { exitCode: 0, stdout: "", stderr: "" });
    setExec("ssh", { exitCode: 0, stdout: "", stderr: "" });

    const { runSyncCode } = await import("../lib/sync/code.js");
    await runSyncCode({ repoPath: tmpBrain, postRestartDelayMs: 0 });
    const rsyncCall = execFileCalls.find((c) => c.bin === "rsync");
    expect(rsyncCall).toBeDefined();
    const args = rsyncCall?.args ?? [];

    // Every pattern documented in RSYNC_EXCLUDES (cli/src/lib/sync/code.ts)
    // must appear as a --exclude= flag. If you remove one from the source,
    // remove it here; if you add one, add it here. This test is the
    // canary that guards against silent regressions to the exclusion set.
    const expectedExcludes = [
      "node_modules/",
      ".git/",
      "dist/",
      "build/",
      ".claude/agent-memory/",
      ".claude/agents/",
      ".claude/rules/",
      ".claude/skills/",
      "CLAUDE.local.md",
      ".env",
      ".env.local",
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
      "*.pyc",
      ".test/",
      "test-output/",
      "*.zip",
      "*.tar.gz",
    ];
    for (const pattern of expectedExcludes) {
      expect(args).toContain(`--exclude=${pattern}`);
    }
  });

  it("TD-135: shellQuote-style protection: repo_path with embedded special chars doesn't break SSH command", async () => {
    // Operator-controlled config; this guards the shellQuote helper's
    // single-quote-wrapping behavior for paths embedded in the remote
    // command string.
    writeConfig({
      vps: { host: "h", user: "u", repo_path: "/srv/my app" },
      remote_brain: { url: "http://127.0.0.1:1", api_key: "k" },
    });
    setExec("rsync", { exitCode: 0, stdout: "", stderr: "" });
    setExec("ssh", { exitCode: 0, stdout: "", stderr: "" });

    const { runSyncCode } = await import("../lib/sync/code.js");
    const code = await runSyncCode({
      repoPath: tmpBrain,
      postRestartDelayMs: 0,
    });
    // Health probe will fail (port 1) but rsync+ssh succeed → exit 0.
    expect(code).toBe(0);

    const sshCalls = execFileCalls.filter((c) => c.bin === "ssh");
    expect(sshCalls.length).toBe(4);
    // npm ci command wraps the path in single quotes.
    const npmCiCmd = sshCalls[0]?.args[sshCalls[0].args.length - 1] ?? "";
    expect(npmCiCmd).toContain("'/srv/my app'");
    expect(npmCiCmd).toContain("npm ci");
    // Build + smoke check both navigate into brain-mcp-server under the quoted path.
    const buildCmd = sshCalls[1]?.args[sshCalls[1].args.length - 1] ?? "";
    expect(buildCmd).toContain("'/srv/my app'/brain-mcp-server");
    const smokeCmd = sshCalls[3]?.args[sshCalls[3].args.length - 1] ?? "";
    expect(smokeCmd).toContain("'/srv/my app'/brain-mcp-server");
  });

  it("TD-135: npm ci failure → exit 1, no build/restart/smoke invoked", async () => {
    writeConfig({
      vps: { host: "h", user: "u", repo_path: "/r" },
      remote_brain: { url: "http://127.0.0.1:1", api_key: "k" },
    });
    setExec("rsync", { exitCode: 0, stdout: "", stderr: "" });
    queueExec("ssh", [
      { exitCode: 1, stdout: "", stderr: "npm ERR! lockfile drift" },
    ]);

    const { runSyncCode } = await import("../lib/sync/code.js");
    const code = await runSyncCode({ repoPath: tmpBrain, postRestartDelayMs: 0 });
    expect(code).toBe(1);
    // Only ONE ssh call (npm ci) should have happened.
    const sshCalls = execFileCalls.filter((c) => c.bin === "ssh");
    expect(sshCalls.length).toBe(1);
    expect(sshCalls[0]?.args[sshCalls[0].args.length - 1]).toContain("npm ci");
  });

  it("TD-135: brain-mcp-server build failure → exit 1, no restart/smoke invoked", async () => {
    writeConfig({
      vps: { host: "h", user: "u", repo_path: "/r" },
      remote_brain: { url: "http://127.0.0.1:1", api_key: "k" },
    });
    setExec("rsync", { exitCode: 0, stdout: "", stderr: "" });
    queueExec("ssh", [
      { exitCode: 0, stdout: "", stderr: "" }, // npm ci OK
      { exitCode: 2, stdout: "", stderr: "tsc error TS1005" }, // build FAIL
    ]);

    const { runSyncCode } = await import("../lib/sync/code.js");
    const code = await runSyncCode({ repoPath: tmpBrain, postRestartDelayMs: 0 });
    expect(code).toBe(1);
    const sshCalls = execFileCalls.filter((c) => c.bin === "ssh");
    expect(sshCalls.length).toBe(2);
    expect(sshCalls[1]?.args[sshCalls[1].args.length - 1]).toContain(
      "npm run build",
    );
    // pm2 restart MUST NOT have been issued — the build failed.
    expect(
      sshCalls.some((c) =>
        c.args[c.args.length - 1].includes("pm2 restart"),
      ),
    ).toBe(false);
  });

  it("TD-135: native-module smoke check failure → exit 1, error mentions better-sqlite3", async () => {
    writeConfig({
      vps: { host: "h", user: "u", repo_path: "/r" },
      remote_brain: { url: "http://127.0.0.1:1", api_key: "k" },
    });
    setExec("rsync", { exitCode: 0, stdout: "", stderr: "" });
    queueExec("ssh", [
      { exitCode: 0, stdout: "", stderr: "" }, // npm ci OK
      { exitCode: 0, stdout: "", stderr: "" }, // build OK
      { exitCode: 0, stdout: "[PM2] OK", stderr: "" }, // pm2 restart OK
      {
        exitCode: 1,
        stdout: "",
        stderr:
          "Error: Cannot find module 'better-sqlite3'\nNODE_MODULE_VERSION mismatch",
      }, // smoke FAIL
    ]);

    const stderrBuf: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });

    try {
      const { runSyncCode } = await import("../lib/sync/code.js");
      const code = await runSyncCode({
        repoPath: tmpBrain,
        postRestartDelayMs: 0,
      });
      expect(code).toBe(1);
      // All 4 ssh calls happened (including the failing smoke check).
      const sshCalls = execFileCalls.filter((c) => c.bin === "ssh");
      expect(sshCalls.length).toBe(4);
      // Error output names the failing module — load-bearing for diagnosis.
      const stderr = stderrBuf.join("");
      expect(stderr).toContain("native-module smoke check failed");
      expect(stderr).toContain("better-sqlite3");
    } finally {
      spy.mockRestore();
    }
  });

  it("health check failure: returns 0 with warning (rsync+ssh succeeded)", async () => {
    // Health server rejects. rsync+ssh still pass.
    writeConfig({
      vps: { host: "h", user: "u", repo_path: "/r" },
      // Port 1 = nothing listening locally.
      remote_brain: { url: "http://127.0.0.1:1", api_key: "k" },
    });
    setExec("rsync", { exitCode: 0, stdout: "", stderr: "" });
    setExec("ssh", { exitCode: 0, stdout: "", stderr: "" });

    const stderrBuf: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });

    try {
      const { runSyncCode } = await import("../lib/sync/code.js");
      const code = await runSyncCode({ repoPath: tmpBrain, postRestartDelayMs: 0 });
      expect(code).toBe(0);
      const stderr = stderrBuf.join("");
      expect(stderr).toContain("health check did not return 200");
    } finally {
      spy.mockRestore();
    }
  });

  it("rsync failure: exit 1, ssh not invoked", async () => {
    writeConfig({
      vps: { host: "h", user: "u", repo_path: "/r" },
      remote_brain: { url: "http://127.0.0.1:1", api_key: "k" },
    });
    setExec("rsync", { exitCode: 23, stdout: "", stderr: "rsync: failed" });

    const { runSyncCode } = await import("../lib/sync/code.js");
    const code = await runSyncCode({ repoPath: tmpBrain });
    expect(code).toBe(1);
    expect(execFileCalls.find((c) => c.bin === "ssh")).toBeUndefined();
  });

  it("--dry-run: no execFile invoked; plan printed; TD-135 pipeline enumerated", async () => {
    writeConfig({
      vps: { host: "vps.example.com", user: "deploy", repo_path: "/srv/igris" },
      remote_brain: { url: "http://127.0.0.1:1", api_key: "k" },
    });
    const stdoutBuf: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });

    try {
      const { runSyncCode } = await import("../lib/sync/code.js");
      const code = await runSyncCode({ dryRun: true, repoPath: tmpBrain });
      expect(code).toBe(0);
      // No actual binaries invoked — only the in-memory dry-run collector.
      expect(execFileCalls.length).toBe(0);
      const out = stdoutBuf.join("");
      expect(out).toContain("Dry-run plan:");
      expect(out).toContain("rsync");
      expect(out).toContain("--delete");
      // TD-135: full exclusion list visible in dry-run output.
      expect(out).toContain("--exclude=node_modules/");
      expect(out).toContain("--exclude=.git/");
      expect(out).toContain("--exclude=dist/");
      expect(out).toContain("--exclude=.env");
      // TD-135: all four ssh stages enumerated.
      expect(out).toContain("ssh");
      expect(out).toContain("npm ci");
      expect(out).toContain("npm run build");
      expect(out).toContain("pm2 restart igris-brain");
      expect(out).toContain('require("better-sqlite3")');
    } finally {
      spy.mockRestore();
    }
  });

  it("--if-changed: when local HEAD matches origin → exit 0, no rsync invoked (architect-added Risk #9)", async () => {
    writeConfig({
      vps: { host: "h", user: "u", repo_path: "/r" },
      remote_brain: { url: "http://127.0.0.1:1", api_key: "k" },
    });
    // git rev-parse → "main"; git fetch → 0; git diff --quiet → 0 (no diff).
    setExec("git", { exitCode: 0, stdout: "main\n", stderr: "" });

    const { runSyncCode } = await import("../lib/sync/code.js");
    const code = await runSyncCode({
      ifChanged: true,
      repoPath: tmpBrain,
    });
    expect(code).toBe(0);
    // git is invoked (rev-parse, fetch, diff) but rsync/ssh are NOT.
    expect(execFileCalls.some((c) => c.bin === "git")).toBe(true);
    expect(execFileCalls.find((c) => c.bin === "rsync")).toBeUndefined();
    expect(execFileCalls.find((c) => c.bin === "ssh")).toBeUndefined();
  });
});
