/**
 * FR-238 (T5) — `~/.igris/dashboard.lock` lifecycle.
 *
 * Exercises the real lock module against a sandboxed `IGRIS_BRAIN_DIR`. No
 * mocking of `process-liveness.ts`: the whole point of the guard is that it
 * agrees with the OS about which pids are alive, and a mocked liveness check
 * would erase exactly that (L-159). Where a *dead* pid is needed we spawn a
 * real short-lived process and wait for it to exit, which is the only honest
 * way to produce one.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  inspectLock,
  readLock,
  releaseLock,
  writeLock,
} from "../lib/dashboard/lock.js";
import { dashboardLockPath } from "../lib/paths.js";

let sandbox: string;
const prevBrain = process.env.IGRIS_BRAIN_DIR;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "igris-dash-lock-"));
  process.env.IGRIS_BRAIN_DIR = sandbox;
});

afterEach(() => {
  if (prevBrain === undefined) delete process.env.IGRIS_BRAIN_DIR;
  else process.env.IGRIS_BRAIN_DIR = prevBrain;
  rmSync(sandbox, { recursive: true, force: true });
});

/** A pid that is guaranteed dead: spawn `true`, wait for it, reuse its pid. */
function deadPid(): number {
  const r = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf-8" });
  const pid = Number.parseInt(r.stdout.trim(), 10);
  expect(Number.isInteger(pid)).toBe(true);
  return pid;
}

describe("dashboard lock — write + read", () => {
  it("writes the lock under IGRIS_BRAIN_DIR and round-trips it", () => {
    const lock = writeLock({ pid: process.pid, port: 7317, url: "http://127.0.0.1:7317/" });
    expect(dashboardLockPath()).toBe(join(sandbox, "dashboard.lock"));
    expect(existsSync(dashboardLockPath())).toBe(true);

    const read = readLock();
    expect(read).not.toBeNull();
    expect(read?.pid).toBe(process.pid);
    expect(read?.port).toBe(7317);
    expect(read?.url).toBe("http://127.0.0.1:7317/");
    expect(read?.started_at).toBe(lock.started_at);
  });

  it("records the owning process start time (pid-reuse proof)", () => {
    writeLock({ pid: process.pid, port: 1234, url: "http://127.0.0.1:1234/" });
    const read = readLock();
    // `ps -o lstart=` is available on every platform this CLI supports; if it
    // ever is not, the field degrades to null rather than throwing.
    const expected = execFileSync("ps", ["-p", String(process.pid), "-o", "lstart="], {
      encoding: "utf-8",
    }).trim();
    expect(read?.process_start_time).toBe(expected);
  });

  it("writes atomically — no .tmp file survives", () => {
    writeLock({ pid: process.pid, port: 1, url: "http://127.0.0.1:1/" });
    expect(existsSync(`${dashboardLockPath()}.${process.pid}.tmp`)).toBe(false);
  });
});

describe("dashboard lock — liveness classification", () => {
  it("absent lock is stale/absent", () => {
    const state = inspectLock();
    expect(state.kind).toBe("stale");
    expect(state.kind === "stale" && state.reason).toBe("absent");
  });

  it("a lock owned by THIS live process classifies live", () => {
    writeLock({ pid: process.pid, port: 7317, url: "http://127.0.0.1:7317/" });
    const state = inspectLock();
    expect(state.kind).toBe("live");
    expect(state.kind === "live" && state.lock.pid).toBe(process.pid);
  });

  it("a dead pid classifies stale/dead_pid", () => {
    const pid = deadPid();
    writeFileSync(
      dashboardLockPath(),
      JSON.stringify({
        pid,
        port: 7317,
        url: "http://127.0.0.1:7317/",
        started_at: new Date().toISOString(),
        process_start_time: "Mon Jan  1 00:00:00 2001",
      }),
    );
    const state = inspectLock();
    expect(state.kind).toBe("stale");
    // A recycled pid could theoretically be alive again; either verdict is a
    // reclaim, which is the behaviour under test.
    expect(
      state.kind === "stale" && ["dead_pid", "pid_reused"].includes(state.reason),
    ).toBe(true);
  });

  it("a LIVE pid with a MISMATCHED start time classifies stale/pid_reused", () => {
    // This is the case a pid-only guard gets wrong: our own pid, but the lock
    // claims it was started at a different time, so it belongs to a process
    // that no longer exists.
    writeFileSync(
      dashboardLockPath(),
      JSON.stringify({
        pid: process.pid,
        port: 7317,
        url: "http://127.0.0.1:7317/",
        started_at: new Date().toISOString(),
        process_start_time: "Mon Jan  1 00:00:00 2001",
      }),
    );
    const state = inspectLock();
    expect(state.kind).toBe("stale");
    expect(state.kind === "stale" && state.reason).toBe("pid_reused");
  });

  it("a malformed lock classifies stale/malformed and is reclaimable", () => {
    writeFileSync(dashboardLockPath(), "{ not json");
    const state = inspectLock();
    expect(state.kind).toBe("stale");
    expect(state.kind === "stale" && state.reason).toBe("malformed");
  });

  it("a structurally invalid lock (missing pid) classifies malformed", () => {
    writeFileSync(dashboardLockPath(), JSON.stringify({ port: 1, url: "x" }));
    expect(inspectLock().kind).toBe("stale");
    expect(readLock()).toBeNull();
  });
});

describe("dashboard lock — release", () => {
  it("releases a lock this pid owns", () => {
    writeLock({ pid: process.pid, port: 1, url: "http://127.0.0.1:1/" });
    expect(releaseLock()).toBe(true);
    expect(existsSync(dashboardLockPath())).toBe(false);
  });

  it("refuses to release a lock owned by another pid", () => {
    writeLock({ pid: process.pid + 1, port: 1, url: "http://127.0.0.1:1/" });
    expect(releaseLock(process.pid)).toBe(false);
    expect(existsSync(dashboardLockPath())).toBe(true);
  });

  it("is idempotent — releasing twice never throws", () => {
    writeLock({ pid: process.pid, port: 1, url: "http://127.0.0.1:1/" });
    expect(releaseLock()).toBe(true);
    expect(releaseLock()).toBe(false);
  });

  it("lock file is written 0600 (it names a live local port)", () => {
    // Assert the MODE, which is what the title claims. A previous version of
    // this test asserted a trailing newline under this name — a test that could
    // not fail on the regression it appeared to guard, and which was reported
    // upward as evidence that 0600 was verified. Mask with 0o777: statSync
    // returns the file type bits too (0o100600 for a regular file).
    writeLock({ pid: process.pid, port: 1, url: "http://127.0.0.1:1/" });
    expect(statSync(dashboardLockPath()).mode & 0o777).toBe(0o600);
  });

  it("re-applies 0600 when a stale same-pid tmp file already exists", () => {
    // `writeFileSync`'s `mode` option is honoured ONLY when the file is
    // CREATED (it is the open(2) mode argument, ignored without O_CREAT). The
    // tmp name is `<lock>.<pid>.tmp`, so a crash between write and rename
    // leaves a file that THIS pid will reuse on a later run — and a permissive
    // mode on that leftover would survive the rewrite and be carried onto the
    // real lock by the rename.
    const tmp = `${dashboardLockPath()}.${process.pid}.tmp`;
    mkdirSync(dirname(tmp), { recursive: true });
    writeFileSync(tmp, "stale\n", { mode: 0o644 });
    expect(statSync(tmp).mode & 0o777).toBe(0o644);

    writeLock({ pid: process.pid, port: 1, url: "http://127.0.0.1:1/" });

    expect(statSync(dashboardLockPath()).mode & 0o777).toBe(0o600);
    expect(existsSync(tmp)).toBe(false);
  });

  it("the lock is valid JSON with a trailing newline", () => {
    // The assertion the mislabelled test above was actually making. Kept, on
    // its own honest name, because the trailing newline is a real (if minor)
    // property — the file is read by humans and by `cat` in the bats suite.
    writeLock({ pid: process.pid, port: 7317, url: "http://127.0.0.1:7317/" });
    const raw = readFileSync(dashboardLockPath(), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
