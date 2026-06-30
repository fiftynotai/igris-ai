/**
 * harness.ts verb tests (FR-136).
 *
 * Mocks ONLY at the adapter-runner boundary (via the `runAdapter` test seam);
 * we do NOT spawn real shells here — bats integration (test/harness_schema.
 * test.bash) covers the live adapter path. These tests assert the verb
 * resolves the correct script path + args and passes the exit code through.
 */

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  runHarness,
  runHarnessStructured,
  parseHarnessOutput,
} from "../verbs/harness.js";

const BRAIN = "/tmp/igris-test-brain";
const ADAPTERS = join(BRAIN, "core", "scripts", "cli-adapters");

describe("harness verb — script resolution", () => {
  it("compile shells out to compile_harnesses.sh", async () => {
    const calls: Array<{ script: string; args: string[] }> = [];
    const code = await runHarness({
      action: "compile",
      projectRoot: "/proj",
      brainRoot: BRAIN,
      runAdapter: (script, args) => {
        calls.push({ script, args });
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].script).toBe(join(ADAPTERS, "compile_harnesses.sh"));
    expect(calls[0].args).toEqual(["--project-root", "/proj"]);
  });

  it("check shells out to check_harness_drift.sh", async () => {
    const calls: Array<{ script: string; args: string[] }> = [];
    await runHarness({
      action: "check",
      projectRoot: "/proj",
      brainRoot: BRAIN,
      runAdapter: (script, args) => {
        calls.push({ script, args });
        return 0;
      },
    });
    expect(calls[0].script).toBe(join(ADAPTERS, "check_harness_drift.sh"));
  });
});

describe("harness verb — arg passthrough", () => {
  it("forwards manifest, overlay, target, and filter flags", async () => {
    let captured: string[] = [];
    await runHarness({
      action: "compile",
      projectRoot: "/proj",
      manifest: "/m.json",
      overlay: "/o.json",
      target: "claude",
      filter: "forge*",
      brainRoot: BRAIN,
      runAdapter: (_script, args) => {
        captured = args;
        return 0;
      },
    });
    expect(captured).toEqual([
      "--project-root",
      "/proj",
      "--manifest",
      "/m.json",
      "--overlay",
      "/o.json",
      "--target",
      "claude",
      "--filter",
      "forge*",
    ]);
  });

  it("defaults projectRoot to cwd when not provided", async () => {
    let captured: string[] = [];
    await runHarness({
      action: "check",
      brainRoot: BRAIN,
      runAdapter: (_script, args) => {
        captured = args;
        return 0;
      },
    });
    expect(captured).toEqual(["--project-root", process.cwd()]);
  });
});

describe("harness verb — exit-code passthrough", () => {
  it("returns the adapter's non-zero exit code unchanged", async () => {
    const code = await runHarness({
      action: "check",
      projectRoot: "/proj",
      brainRoot: BRAIN,
      runAdapter: () => 1,
    });
    expect(code).toBe(1);
  });

  it("propagates an arbitrary exit code (e.g. usage error 2)", async () => {
    const code = await runHarness({
      action: "compile",
      projectRoot: "/proj",
      brainRoot: BRAIN,
      runAdapter: () => 2,
    });
    expect(code).toBe(2);
  });
});

describe("harness verb — bad action", () => {
  it("returns 2 (usage error) and does not invoke the runner", async () => {
    let invoked = false;
    const code = await runHarness({
      // deliberately invalid action
      action: "bogus" as unknown as "compile",
      projectRoot: "/proj",
      brainRoot: BRAIN,
      runAdapter: () => {
        invoked = true;
        return 0;
      },
    });
    expect(code).toBe(2);
    expect(invoked).toBe(false);
  });
});

// --- FR-180: structured mode ----------------------------------------------

describe("parseHarnessOutput (FR-180)", () => {
  it("parses OK / FAIL rows, the empty-match line, and the FR-218 WARN line", () => {
    const warn =
      "WARN  core skills are (re)projected to the GLOBAL user store from " +
      "non-owner --project-root /proj (skills are global; no project-local " +
      "skills dir; FR-218)";
    const out =
      warn +
      "\n" +
      "  OK    skills/claude -> ~/.claude/skills/foo\n" +
      "  FAIL  skills/gemini — refuse to clobber\n" +
      "  No agent/skills/mcp/hook targets matched (filter='*').\n";
    const r = parseHarnessOutput(0, out);
    expect(r.code).toBe(0);
    expect(r.okRows).toEqual(["OK    skills/claude -> ~/.claude/skills/foo"]);
    expect(r.failRows).toEqual(["FAIL  skills/gemini — refuse to clobber"]);
    expect(r.noTargetsMatched).toBe(true);
    // FR-218: the non-owner core-(re)projection WARN is captured (formerly the
    // retired "SKIPPED core surfaces" line); the field name is kept stable.
    expect(r.skippedCoreLine).toBe(warn);
  });

  it("reports no targets matched only when the line is present", () => {
    const r = parseHarnessOutput(0, "  OK    skills/claude -> x\n");
    expect(r.noTargetsMatched).toBe(false);
    expect(r.skippedCoreLine).toBeUndefined();
  });
});

describe("runHarnessStructured (FR-180)", () => {
  it("appends --expect-core to the adapter args when expectCore is set", async () => {
    let captured: string[] = [];
    await runHarnessStructured({
      action: "compile",
      surface: "skills",
      projectRoot: "/proj",
      expectCore: true,
      brainRoot: BRAIN,
      captureAdapter: (_script, args) => {
        captured = args;
        return { code: 0, output: "  OK    skills/claude -> x\n" };
      },
    });
    expect(captured).toContain("--expect-core");
    expect(captured).toEqual([
      "--project-root",
      "/proj",
      "--surface",
      "skills",
      "--expect-core",
    ]);
  });

  it("does NOT append --expect-core when expectCore is false/omitted", async () => {
    let captured: string[] = [];
    await runHarnessStructured({
      action: "compile",
      surface: "skills",
      projectRoot: "/proj",
      brainRoot: BRAIN,
      captureAdapter: (_script, args) => {
        captured = args;
        return { code: 0, output: "  OK    skills/claude -> x\n" };
      },
    });
    expect(captured).not.toContain("--expect-core");
  });

  it("returns a parsed structured result from the captured output", async () => {
    const r = await runHarnessStructured({
      action: "compile",
      surface: "skills",
      projectRoot: "/proj",
      brainRoot: BRAIN,
      captureAdapter: () => ({
        code: 1,
        output: "  FAIL  skills (delegate) — loadout project-skills exited 1\n",
      }),
    });
    expect(r.code).toBe(1);
    expect(r.failRows).toEqual([
      "FAIL  skills (delegate) — loadout project-skills exited 1",
    ]);
  });

  it("returns code 2 on a bad action without invoking the runner", async () => {
    let invoked = false;
    const r = await runHarnessStructured({
      action: "bogus" as unknown as "compile",
      projectRoot: "/proj",
      brainRoot: BRAIN,
      captureAdapter: () => {
        invoked = true;
        return { code: 0, output: "" };
      },
    });
    expect(r.code).toBe(2);
    expect(invoked).toBe(false);
  });
});
