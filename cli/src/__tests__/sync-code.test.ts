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

type ExecFileBehavior = {
  exitCode: number;
  stdout: string;
  stderr: string;
};
type ExecFileBehaviorByBin = Record<string, ExecFileBehavior>;

let execFileBehaviors: ExecFileBehaviorByBin = {};
const execFileCalls: Array<{ bin: string; args: string[]; cwd?: string }> = [];

function setExec(bin: string, behavior: ExecFileBehavior): void {
  execFileBehaviors[bin] = behavior;
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

    const behavior =
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
      // src ends with "/" so contents copy into dst.
      const src = rsyncCall?.args[rsyncCall.args.length - 2] ?? "";
      expect(src.endsWith("/")).toBe(true);
      const dst = rsyncCall?.args[rsyncCall.args.length - 1] ?? "";
      expect(dst).toBe("deploy@vps.example.com:/srv/igris/");

      // ssh invocation shape.
      const sshCall = execFileCalls.find((c) => c.bin === "ssh");
      expect(sshCall).toBeDefined();
      expect(sshCall?.args).toContain("deploy@vps.example.com");
      expect(sshCall?.args).toContain("--");
      expect(sshCall?.args).toContain("pm2 restart igris-brain");
      expect(sshCall?.args).toContain("-o");
      expect(sshCall?.args.some((a) => a.startsWith("ConnectTimeout="))).toBe(
        true,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
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

  it("--dry-run: no execFile invoked; plan printed", async () => {
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
      expect(out).toContain("ssh");
      expect(out).toContain("pm2 restart igris-brain");
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
