/**
 * FR-195 (M1) — detect.ts capability-detection tests.
 *
 * Each `mode` is produced from a sandboxed brain dir (IGRIS_BRAIN_DIR) by
 * toggling the four real signals: the brain DB file's existence, config.json's
 * remote_brain block, sqlite3 on PATH, and the harness env markers. No mocks —
 * we manipulate the actual filesystem + env the detector reads.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { HARNESS_ENV_MARKERS } from "../lib/detect.js";

let tmpRoot: string;
let savedEnv: NodeJS.ProcessEnv;

/** Write a knowledge.db file so existsSync(brainDbPath()) is true. */
function makeBrainDb(): void {
  mkdirSync(join(tmpRoot, "memory"), { recursive: true });
  writeFileSync(join(tmpRoot, "memory", "knowledge.db"), "");
}

/** Write config.json with a configured remote_brain block. */
function makeRemoteConfig(): void {
  writeFileSync(
    join(tmpRoot, "config.json"),
    JSON.stringify({ remote_brain: { url: "http://h:1", api_key: "k" } }),
  );
}

/** Put a fake `sqlite3` binary on PATH (a tmp bin dir prepended). */
function makeSqlite3OnPath(): string {
  const binDir = join(tmpRoot, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "sqlite3"), "#!/bin/sh\n");
  return binDir;
}

async function getModule(): Promise<typeof import("../lib/detect.js")> {
  return await import("../lib/detect.js");
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-detect-"));
  // Snapshot env so per-test mutations (PATH, harness markers) are reverted.
  savedEnv = { ...process.env };
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
  // Neutralize harness markers + PATH so a test starts from a known floor.
  // Use the shared marker list so a live harness's ambient marker (incl. the
  // Cursor markers this list previously omitted) cannot leak in (TD-299).
  for (const k of HARNESS_ENV_MARKERS) {
    delete process.env[k];
  }
  // Empty PATH so sqlite3 is absent unless a test adds it.
  process.env.PATH = "";
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  process.env = savedEnv;
});

describe("detect — mode", () => {
  it("full: brain DB present + remote_brain configured", async () => {
    makeBrainDb();
    makeRemoteConfig();
    const m = await getModule();
    const r = m.detectCapabilities();
    expect(r.brain_root).toBe(tmpRoot);
    expect(r.project_path).toBe(process.cwd());
    expect(r.project_slug).toBe(basename(process.cwd()));
    expect(r.brain_db).toBe(true);
    expect(r.remote_brain).toBe(true);
    expect(r.mode).toBe("full");
  });

  it("degraded-no-db: brain DB absent (dominates even if remote configured)", async () => {
    // remote config present, but no DB file → no-db dominates.
    makeRemoteConfig();
    const m = await getModule();
    const r = m.detectCapabilities();
    expect(r.brain_db).toBe(false);
    expect(r.mode).toBe("degraded-no-db");
  });

  it("degraded-no-remote: brain DB present but remote_brain unconfigured", async () => {
    makeBrainDb();
    // no config.json at all → readRemoteBrainConfig() === null
    const m = await getModule();
    const r = m.detectCapabilities();
    expect(r.brain_db).toBe(true);
    expect(r.remote_brain).toBe(false);
    expect(r.mode).toBe("degraded-no-remote");
  });

  it("sqlite3 flag reflects PATH presence, independent of mode", async () => {
    makeBrainDb();
    makeRemoteConfig();
    const binDir = makeSqlite3OnPath();
    process.env.PATH = binDir;
    const m = await getModule();
    const r = m.detectCapabilities();
    expect(r.sqlite3).toBe(true);
    expect(r.mode).toBe("full");
  });

  it("sqlite3 false when absent from PATH", async () => {
    makeBrainDb();
    makeRemoteConfig();
    // PATH already "" from beforeEach
    const m = await getModule();
    const r = m.detectCapabilities();
    expect(r.sqlite3).toBe(false);
  });
});

describe("detect — harness inference", () => {
  it("claude from CLAUDECODE", async () => {
    process.env.CLAUDECODE = "1";
    const m = await getModule();
    expect(m.detectCapabilities().harness).toBe("claude");
  });

  it("antigravity marker wins over gemini-family", async () => {
    process.env.ANTIGRAVITY = "1";
    process.env.GEMINI_CLI = "1";
    const m = await getModule();
    expect(m.detectCapabilities().harness).toBe("antigravity");
  });

  it("gemini from GEMINI_CLI", async () => {
    process.env.GEMINI_CLI = "1";
    const m = await getModule();
    expect(m.detectCapabilities().harness).toBe("gemini");
  });

  it("codex from CODEX_SESSION", async () => {
    process.env.CODEX_SESSION = "1";
    const m = await getModule();
    expect(m.detectCapabilities().harness).toBe("codex");
  });

  it("opencode from OPENCODE", async () => {
    process.env.OPENCODE = "1";
    const m = await getModule();
    expect(m.detectCapabilities().harness).toBe("opencode");
  });

  it("unknown when no marker is present", async () => {
    const m = await getModule();
    expect(m.detectCapabilities().harness).toBe("unknown");
  });
});
