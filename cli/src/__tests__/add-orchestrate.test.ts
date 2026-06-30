/**
 * FR-180: add-orchestrate (project + verify) tests.
 *
 * Exercises the shared TD-235 chokepoint `projectAndVerify` via the
 * `captureAdapter` test seam — a fake capturing runner that returns synthetic
 * adapter summaries keyed on the script path (compile vs check). No shell is
 * spawned. Asserts the loud-failure conversion: a 0-projected compile, a FAIL
 * row, a non-zero exit, and a drift on the check side all yield `ok:false` with
 * an actionable reason; a clean compile+check yields `ok:true`.
 */

import { describe, expect, it } from "vitest";
import { projectAndVerify } from "../lib/add-orchestrate.js";
import type { AdapterCaptureFn } from "../verbs/harness.js";

const BRAIN = "/tmp/igris-test-brain-orch";

/**
 * Build a capturing fake that returns `compileOut`/`checkOut` (and codes)
 * depending on which script the orchestrator invoked. The orchestrator runs
 * compile_harnesses.sh first, then check_harness_drift.sh.
 */
function fakeAdapter(spec: {
  compile: { code: number; output: string };
  check?: { code: number; output: string };
}): AdapterCaptureFn {
  return (scriptPath) => {
    if (scriptPath.includes("compile_harnesses.sh")) {
      return spec.compile;
    }
    if (scriptPath.includes("check_harness_drift.sh")) {
      return spec.check ?? { code: 0, output: "" };
    }
    throw new Error(`unexpected script: ${scriptPath}`);
  };
}

describe("projectAndVerify — happy path", () => {
  it("ok=true when compile projects ≥1 target and check is clean", async () => {
    const res = await projectAndVerify({
      surface: "skills",
      projectRoot: "/proj",
      brainRoot: BRAIN,
      captureAdapter: fakeAdapter({
        compile: {
          code: 0,
          output:
            "Harness compile summary (project root: /proj):\n" +
            "  OK    skills/claude -> ~/.claude/skills/foo\n" +
            "  ----\n  1 targets — 1 ok, 0 failed\n",
        },
        check: {
          code: 0,
          output: "  ----\n  1 targets — 1 in sync, 0 drifted/missing\n",
        },
      }),
    });
    expect(res.ok).toBe(true);
    expect(res.projected).toEqual(["OK    skills/claude -> ~/.claude/skills/foo"]);
    expect(res.failed).toEqual([]);
    expect(res.reason).toBe("");
  });
});

describe("projectAndVerify — TD-235 loud-failure conversion", () => {
  it("ok=false when compile projected 0 targets (silent no-op → loud)", async () => {
    const res = await projectAndVerify({
      surface: "skills",
      projectRoot: "/proj",
      brainRoot: BRAIN,
      captureAdapter: fakeAdapter({
        compile: {
          code: 0,
          output:
            "No agent/skills/mcp/hook targets matched (filter='*', target='all', surface='skills').\n",
        },
      }),
    });
    expect(res.ok).toBe(false);
    expect(res.projected).toEqual([]);
    expect(res.reason).toContain("projected 0 'skills' targets");
    expect(res.reason).toContain("/proj");
  });

  it("ok=false when compile exits non-zero with a FAIL row", async () => {
    const res = await projectAndVerify({
      surface: "skills",
      projectRoot: "/proj",
      expectCore: true,
      brainRoot: BRAIN,
      captureAdapter: fakeAdapter({
        compile: {
          code: 1,
          // FR-218: a genuine delegate failure (the gate no longer FAILs core
          // for skills — core is always global). The FAIL row + non-zero exit
          // must still flip ok:false with the row surfaced in the reason.
          output: "FAIL  skills (delegate) — loadout project-skills exited 1\n",
        },
      }),
    });
    expect(res.ok).toBe(false);
    expect(res.failed.length).toBeGreaterThan(0);
    expect(res.reason).toContain("compile failed");
    expect(res.reason).toContain("skills (delegate)");
  });

  it("ok=false when the verify (check) reports drift", async () => {
    const res = await projectAndVerify({
      surface: "skills",
      projectRoot: "/proj",
      brainRoot: BRAIN,
      captureAdapter: fakeAdapter({
        compile: {
          code: 0,
          output: "  OK    skills/claude -> x\n  1 targets — 1 ok, 0 failed\n",
        },
        check: {
          code: 1,
          output: "  FAIL  skills/claude — drifted\n  1 targets — 0 in sync, 1 drifted/missing\n",
        },
      }),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("verify (drift check) failed");
    expect(res.check).toBeDefined();
  });

  it("surfaces the FR-218 WARN-core line without failing on it alone", async () => {
    // FR-218: a non-owner compile (re)projected the GLOBAL core skills (the WARN
    // line) AND a target projected — coreSkipped carries the WARN but does NOT
    // flip ok to false.
    const warn =
      "WARN  core skills are (re)projected to the GLOBAL user store from " +
      "non-owner --project-root /proj (skills are global; FR-218)";
    const res = await projectAndVerify({
      surface: "skills",
      projectRoot: "/proj",
      brainRoot: BRAIN,
      captureAdapter: fakeAdapter({
        compile: {
          code: 0,
          output:
            warn +
            "\n  OK    skills/claude -> x\n  1 targets — 1 ok, 0 failed\n",
        },
        check: { code: 0, output: "  1 targets — 1 in sync, 0 drifted/missing\n" },
      }),
    });
    expect(res.ok).toBe(true);
    expect(res.coreSkipped).toEqual([warn]);
  });
});

describe("projectAndVerify — check is not run when compile fails", () => {
  it("leaves res.check undefined on a compile failure", async () => {
    let checkCalled = false;
    const res = await projectAndVerify({
      surface: "skills",
      projectRoot: "/proj",
      brainRoot: BRAIN,
      captureAdapter: (scriptPath) => {
        if (scriptPath.includes("check_harness_drift.sh")) {
          checkCalled = true;
          return { code: 0, output: "" };
        }
        return { code: 0, output: "No targets matched.\n" };
      },
    });
    expect(res.ok).toBe(false);
    expect(res.check).toBeUndefined();
    expect(checkCalled).toBe(false);
  });
});
