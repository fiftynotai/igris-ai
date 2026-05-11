/**
 * self-update tests — Phase 3 (M3).
 *
 * Per architect's prior-mistake guidance (L-159 / TD-098): mock
 * `node:child_process` at the boundary, NOT the module under test. The
 * module under test (`../lib/self-update`) is imported and exercised
 * directly; only `execFile` is replaced via vi.mock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Per-test mutable state for the mocked execFile callback.
type MockExecFileBehavior =
  | { kind: "success" }
  | { kind: "exit"; code: number; message?: string }
  | { kind: "enoent" }
  | { kind: "spawnError"; message: string };

let execFileBehavior: MockExecFileBehavior = { kind: "success" };
const execFileCalls: Array<{ bin: string; args: string[] }> = [];

vi.mock("node:child_process", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execFile: (bin: string, args: string[], _opts: any, cb: any) => {
    execFileCalls.push({ bin, args });
    // Simulate async invocation — defer the callback to next tick so the
    // promise machinery in runSelfUpdate has a chance to attach.
    setImmediate(() => {
      const behavior = execFileBehavior;
      if (behavior.kind === "success") {
        cb(null);
        return;
      }
      if (behavior.kind === "exit") {
        const err = new Error(behavior.message ?? "npm exit") as Error & {
          code?: number | string;
        };
        err.code = behavior.code;
        cb(err);
        return;
      }
      if (behavior.kind === "enoent") {
        const err = new Error("spawn npm ENOENT") as Error & {
          code?: number | string;
        };
        err.code = "ENOENT";
        cb(err);
        return;
      }
      // spawnError
      const err = new Error(behavior.message) as Error;
      cb(err);
    });
    // The real execFile returns a ChildProcess — the verb only stores the
    // handle as `void child`, so a sentinel value is fine.
    return { mocked: true };
  },
}));

beforeEach(() => {
  execFileCalls.length = 0;
  execFileBehavior = { kind: "success" };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runSelfUpdate", () => {
  it("happy path: invokes 'npm install -g igris-ai@latest' and resolves 0", async () => {
    const { runSelfUpdate } = await import("../lib/self-update.js");
    execFileBehavior = { kind: "success" };
    const code = await runSelfUpdate();
    expect(code).toBe(0);
    expect(execFileCalls.length).toBe(1);
    expect(execFileCalls[0].bin).toBe("npm");
    expect(execFileCalls[0].args).toEqual([
      "install",
      "-g",
      "igris-ai@latest",
    ]);
  });

  it("npm failure: surfaces npm's exit code verbatim", async () => {
    const { runSelfUpdate } = await import("../lib/self-update.js");
    execFileBehavior = {
      kind: "exit",
      code: 1,
      message: "npm ERR! 403 Forbidden",
    };
    const code = await runSelfUpdate();
    expect(code).toBe(1);
    expect(execFileCalls.length).toBe(1);
  });

  it("npm not on PATH (ENOENT): returns 127 with actionable error", async () => {
    const { runSelfUpdate } = await import("../lib/self-update.js");
    execFileBehavior = { kind: "enoent" };
    // Capture stderr — the verb should emit an actionable error message.
    const stderrBuf: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation((chunk: any) => {
        stderrBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });
    try {
      const code = await runSelfUpdate();
      expect(code).toBe(127);
      const stderr = stderrBuf.join("");
      expect(stderr).toContain("npm is not on PATH");
      expect(stderr).toContain("Install Node.js");
    } finally {
      spy.mockRestore();
    }
  });
});
