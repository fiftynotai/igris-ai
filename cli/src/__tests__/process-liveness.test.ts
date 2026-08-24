/**
 * TD-411 — owner-identity resolution (`process-liveness.ts`).
 *
 * `resolveOwnerProcess` had NO test at all, which is exactly where the bug
 * lived: it recorded `process.ppid` — the transient per-tool-call shell — as
 * the session owner, so every instance re-derived `dead` on the next read.
 *
 * THE TRAP this suite is written around. A `register → gather` round-trip is
 * GREEN ON THE BROKEN CODE under vitest: the pool parent is long-lived, so
 * `isProcessAlive(process.ppid)` is true and the defect does not reproduce.
 * The discriminating vitest assertion is therefore on the RESOLVER's return
 * value (`null`, never a pid), not on downstream liveness. The end-to-end red
 * — an instance landing in `crashed[]` — lives in
 * `cli/tests/integration/awaken-verbs.bats`, where a `bash -c` parent really
 * does exit.
 *
 * Hermeticity: `resolveOwnerProcess` takes its environment as a parameter, so
 * every tier-selection test passes a LITERAL env and touches `process.env`
 * not at all — an ambient `CLAUDE_CODE_ENTRYPOINT` from the harness the suite
 * runs inside cannot leak in (TD-299).
 *
 * ENV-hermetic is not TREE-hermetic, and the difference is deliberate. A
 * tier-selection test that carries a literal `CLAUDECODE` marker DOES reach
 * the real process tree, because that is the only way to give tier 2 an
 * answer distinguishable from tier 3's `null`. Without one, a test asserting
 * `null` cannot say WHICH tier produced it — which is how the malformed-
 * override test passed for a round while proving nothing about
 * malformedness. Any such test that would go vacuous off-harness skips
 * LOUDLY rather than passing.
 *
 * `classifyInstanceLiveness` is NOT re-litigated here: it was already correct
 * and is already pinned end-to-end by `session-gather.test.ts` tests 2b / 2c /
 * 2d. Its cases below are the same guarantees restated at the unit layer — the
 * AC-3 and AC-4 statuses plus the `unknown_no_metadata` degrade target and the
 * `alive` baseline that bracket them — so a future edit to the classifier reds
 * here first.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { HARNESS_PROCESS_TABLE } from "../lib/detect.js";
import {
  classifyInstanceLiveness,
  findHarnessAncestor,
  getProcessStartTime,
  parseProcessTable,
  readProcessTable,
  resolveOwnerProcess,
  type ProcessTableEntry,
} from "../lib/process-liveness.js";

/** Build a fabricated process table from [pid, ppid, comm] triples. */
function table(
  ...rows: ReadonlyArray<readonly [number, number, string]>
): Map<number, ProcessTableEntry> {
  const m = new Map<number, ProcessTableEntry>();
  for (const [pid, ppid, comm] of rows) m.set(pid, { ppid, comm });
  return m;
}

const CLAUDE = /(?:^|\/)claude$/;

describe("resolveOwnerProcess — tier selection", () => {
  it("no override and no harness marker → null, NEVER the parent shell", () => {
    // THE load-bearing assertion of TD-411. Before the fix this returned
    // `{ pid: process.ppid, … }` — a pid that is dead by the time any reader
    // checks it. `null` is a DEFINED unknown; a wrong pid is not.
    expect(resolveOwnerProcess({})).toBeNull();

    // Stated positively so the intent survives a refactor: whatever this
    // returns, it must never be the CLI's own parent.
    const resolved = resolveOwnerProcess({});
    expect(resolved === null || resolved.pid !== process.ppid).toBe(true);
  });

  it("an explicit IGRIS_INSTANCE_OWNER_PID still wins (tier 1 preserved)", () => {
    // process.pid is guaranteed live and has a readable start time.
    const owner = resolveOwnerProcess({
      IGRIS_INSTANCE_OWNER_PID: String(process.pid),
    });
    expect(owner).not.toBeNull();
    expect(owner?.pid).toBe(process.pid);
    expect(owner?.started_at).toBe(getProcessStartTime(process.pid));
  });

  it("tier 1 wins even when a harness marker is also present", () => {
    const owner = resolveOwnerProcess({
      IGRIS_INSTANCE_OWNER_PID: String(process.pid),
      CLAUDECODE: "1",
    });
    expect(owner?.pid).toBe(process.pid);
  });

  it("an explicit override naming a DEAD pid degrades to null, not to a walk", () => {
    // THE ONE EXCEPTION to "a tier's failure falls to the next tier". An
    // operator who named a real pid meant it, so substituting a walked pid is
    // the exact failure mode this brief exists for. It holds under a harness
    // marker too, which is the form that actually discriminates — see the
    // second assertion.
    expect(
      resolveOwnerProcess({ IGRIS_INSTANCE_OWNER_PID: "999999999" }),
    ).toBeNull();

    // With a harness marker present, tier 2 has a walked answer available to
    // fall through TO, so wherever this suite runs inside a claude harness
    // this form discriminates "returned null" from "never walked". The bare
    // form above never can: with no marker, tier 2 resolves to null anyway.
    // Not skip-gated, because null is the right answer either way — it is
    // simply weaker off-harness, and the sibling test below states when.
    expect(
      resolveOwnerProcess({
        CLAUDECODE: "1",
        IGRIS_INSTANCE_OWNER_PID: "999999999",
      }),
    ).toBeNull();
  });

  it("an UNPARSEABLE override falls through to TIER 2, not to tier 3", (ctx) => {
    // This test carries a harness marker ON PURPOSE. Its first version did
    // not, and so it asserted `null` for a reason that had nothing to do with
    // the override: with no marker, tier 2 has no reachable non-null answer,
    // so tier 2 and tier 3 are indistinguishable and the assertion stayed
    // green under EITHER routing. That is the exact defect class TD-411 is
    // about, wearing a test.
    //
    // ARM A, off-harness and never skipped — kept from this test's first
    // version because it is the arm a reintroduced `process.ppid` fallback
    // reddens. It proves the WEAK half (never the parent shell); it cannot
    // tell tier 2 from tier 3, which is what arm B is for.
    for (const bad of ["", "0", "-3", "abc"]) {
      const t3 = resolveOwnerProcess({ IGRIS_INSTANCE_OWNER_PID: bad });
      expect(t3).toBeNull();
      expect(t3 === null || t3.pid !== process.ppid).toBe(true);
    }

    // ARM B. The control is the same env WITHOUT the override. If tier 2
    // answers, then "the unparseable override produced the tier-2 answer" is
    // a claim only tier-2 routing can satisfy.
    const tier2 = resolveOwnerProcess({ CLAUDECODE: "1" });
    if (tier2 === null) {
      console.warn(
        "[TD-411] SKIPPED: tier 2 has no answer here (no `claude` ancestor " +
          "above pid " +
          String(process.pid) +
          "), so tier 2 and tier 3 are indistinguishable and this assertion " +
          "would be vacuous rather than green.",
      );
      ctx.skip();
      return;
    }

    for (const bad of ["", "0", "-3", "abc"]) {
      const got = resolveOwnerProcess({
        CLAUDECODE: "1",
        IGRIS_INSTANCE_OWNER_PID: bad,
      });
      expect(got).not.toBeNull();
      expect(got?.pid).toBe(tier2.pid);
    }
  });

  it("a TRAILING-GARBAGE override is an override, not an unparseable value", () => {
    // `Number.parseInt("123abc")` is 123, so "<pid>abc" is tier 1 — it does
    // NOT fall through. Recorded because the sibling test above listed
    // "12abc" among its unparseable values for a round: it passed only
    // because pid 12 happens to be invisible to `ps` on darwin, i.e. via the
    // DEAD-pid exception, not via the fall-through it claimed to prove.
    const owner = resolveOwnerProcess({
      CLAUDECODE: "1",
      IGRIS_INSTANCE_OWNER_PID: `${String(process.pid)}abc`,
    });
    expect(owner?.pid).toBe(process.pid);
    // Discriminating: had it fallen through, this would be the walked
    // ancestor instead, which is never this process.
    expect(owner?.pid).not.toBe(resolveOwnerProcess({ CLAUDECODE: "1" })?.pid);
  });

  it("a harness with NO HARNESS_PROCESS_TABLE entry resolves to null", () => {
    // AC-6 / D-411-b in code: the unmeasured harnesses do not get a guess.
    const measured = new Set<string>(HARNESS_PROCESS_TABLE.map(([id]) => id));
    const unmeasured: Array<[string, string]> = [
      ["CODEX_SESSION", "codex"],
      ["GEMINI_CLI", "gemini"],
      ["OPENCODE", "opencode"],
      ["ANTIGRAVITY", "antigravity"],
      ["CURSOR_AGENT", "cursor"],
    ];
    // Arm check: this test is vacuous if one of these ever IS measured.
    const stillUnmeasured = unmeasured.filter(([, id]) => !measured.has(id));
    expect(stillUnmeasured.length).toBeGreaterThan(0);

    for (const [marker] of stillUnmeasured) {
      expect(resolveOwnerProcess({ [marker]: "1" })).toBeNull();
    }
  });
});

describe("resolveOwnerProcess — tier 2 against the REAL process tree", () => {
  /**
   * The only test that exercises the walk end-to-end against a live tree.
   * It is environment-conditional by construction, so it SKIPS LOUDLY with a
   * named reason rather than passing vacuously off-harness (e.g. in CI).
   *
   * The expectation is derived INDEPENDENTLY — by walking `ps` here — so the
   * assertion is "the resolver agrees with a hand walk", not "the resolver
   * agrees with itself".
   */
  it("under claude, resolves the claude ancestor (not the tool shell)", (ctx) => {
    const raw = execFileSync("ps", ["-Ao", "pid=,ppid=,comm="], {
      encoding: "utf-8",
      maxBuffer: 8 * 1024 * 1024,
    });
    const tree = new Map<number, ProcessTableEntry>();
    for (const line of raw.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (m === null) continue;
      tree.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3].trim() });
    }

    let expected: number | null = null;
    let pid = process.pid;
    for (let hop = 0; hop < 12 && pid > 1; hop++) {
      const entry = tree.get(pid);
      if (entry === undefined) break;
      if (CLAUDE.test(entry.comm)) {
        expected = pid;
        break;
      }
      pid = entry.ppid;
    }

    if (expected === null) {
      console.warn(
        "[TD-411] SKIPPED: no `claude` ancestor above pid " +
          String(process.pid) +
          " — this suite is not running inside a claude harness, so tier 2 " +
          "cannot be exercised against a real tree here.",
      );
      ctx.skip();
      return;
    }

    const owner = resolveOwnerProcess({ CLAUDECODE: "1" });
    expect(owner).not.toBeNull();
    expect(owner?.pid).toBe(expected);
    // The whole point: the owner is NOT the transient shell that ran us.
    expect(owner?.pid).not.toBe(process.ppid);
    expect(owner?.started_at).toBe(getProcessStartTime(expected));
  });
});

describe("findHarnessAncestor — the pure walk", () => {
  it("walks past two shells to the harness row", () => {
    const t = table(
      [500, 400, "/usr/local/bin/node"],
      [400, 300, "/bin/zsh"],
      [300, 200, "/bin/bash"],
      [200, 100, "claude"],
      [100, 1, "login"],
    );
    expect(findHarnessAncestor(t, 500, CLAUDE)).toBe(200);
  });

  it("matches a harness whose comm is an absolute path", () => {
    const t = table([50, 40, "node"], [40, 1, "/usr/local/bin/claude"]);
    expect(findHarnessAncestor(t, 50, CLAUDE)).toBe(40);
  });

  it("returns the start pid itself when it matches", () => {
    const t = table([7, 1, "claude"]);
    expect(findHarnessAncestor(t, 7, CLAUDE)).toBe(7);
  });

  it("no match anywhere in the chain → null", () => {
    const t = table(
      [500, 400, "node"],
      [400, 300, "/bin/zsh"],
      [300, 1, "login"],
    );
    expect(findHarnessAncestor(t, 500, CLAUDE)).toBeNull();
  });

  it("a near-miss comm does not match (anchored, not a substring)", () => {
    const t = table(
      [500, 400, "claude-wrapper"],
      [400, 300, "myclaude"],
      [300, 200, "/opt/claude/bin/runner"],
      [200, 1, "init"],
    );
    expect(findHarnessAncestor(t, 500, CLAUDE)).toBeNull();
  });

  it("a parent cycle → null (never loops forever)", () => {
    const t = table([10, 20, "a"], [20, 30, "b"], [30, 10, "c"]);
    expect(findHarnessAncestor(t, 10, CLAUDE)).toBeNull();
  });

  it("a chain longer than maxHops → null", () => {
    // 20 shells then the harness: reachable in principle, refused in practice.
    const rows: Array<readonly [number, number, string]> = [];
    for (let i = 0; i < 20; i++) rows.push([100 + i, 101 + i, "/bin/zsh"]);
    rows.push([120, 1, "claude"]);
    const t = table(...rows);
    expect(findHarnessAncestor(t, 100, CLAUDE)).toBeNull();
    // Arm check: the SAME chain resolves once the hop budget covers it, so the
    // null above is the budget biting and not a broken fixture.
    expect(findHarnessAncestor(t, 100, CLAUDE, 25)).toBe(120);
  });

  it("a pid missing from the table → null (the process exited mid-walk)", () => {
    const t = table([500, 999, "node"]);
    expect(findHarnessAncestor(t, 500, CLAUDE)).toBeNull();
  });

  it("reaching pid 1 or 0 stops the walk → null", () => {
    expect(findHarnessAncestor(table([1, 0, "claude"]), 1, CLAUDE)).toBeNull();
    expect(findHarnessAncestor(table([0, 0, "claude"]), 0, CLAUDE)).toBeNull();
  });
});

describe("readProcessTable", () => {
  it("snapshots the real tree, including this process and its parent", () => {
    const t = readProcessTable();
    expect(t).not.toBeNull();
    const self = t?.get(process.pid);
    expect(self).toBeDefined();
    expect(self?.ppid).toBe(process.ppid);
    expect(typeof self?.comm).toBe("string");
    expect(self?.comm.length).toBeGreaterThan(0);
  });

  it("no live row yields a bare-numeric comm (column misalignment guard)", () => {
    // A comm that is all digits means the pid/ppid columns were mis-split.
    // This is the only property of the LIVE snapshot worth asserting; the
    // space-comm contract is pinned against a literal fixture below, because
    // a host with no space-comm row would make a live-snapshot version of it
    // pass under a truncating parser.
    const t = readProcessTable();
    expect(t).not.toBeNull();
    for (const entry of t?.values() ?? []) {
      expect(entry.comm).not.toMatch(/^\d+$/);
    }
  });
});

describe("parseProcessTable", () => {
  // Measured on darwin 2026-08-21: 41 of 610 live `ps -Ao pid=,ppid=,comm=`
  // rows carried an absolute path containing SPACES. The parser therefore
  // splits only the first two fields and takes the remainder of the line
  // verbatim. Fed here as LITERAL text — the round-1 version of this test
  // called `readProcessTable()` and iterated it, which stayed green under both
  // truncation defects it named (warden, TD-411 review 1).
  const SPACE_COMM =
    "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
  const SNAPSHOT = [
    `  501     1 ${SPACE_COMM}`,
    "  502   501 /bin/zsh",
    " 1701   502 claude",
    "",
  ].join("\n");

  it("keeps a comm that contains spaces intact", () => {
    const t = parseProcessTable(SNAPSHOT);
    expect(t).not.toBeNull();
    // The whole line after the second column, byte for byte. Reddens under
    // `line.trim().split(/\s+/)[2]` (truncates to "/Applications/Visual") and
    // under a `(\S+)$`-anchored third group (drops the row, leaving undefined).
    expect(t?.get(501)).toEqual({ ppid: 1, comm: SPACE_COMM });
  });

  it("still parses the ordinary space-free rows around it", () => {
    // Negative control: the fixture's OTHER rows must survive, so a red above
    // is attributable to the space-comm handling and not to a broken fixture.
    const t = parseProcessTable(SNAPSHOT);
    expect(t?.get(502)).toEqual({ ppid: 501, comm: "/bin/zsh" });
    expect(t?.get(1701)).toEqual({ ppid: 502, comm: "claude" });
    expect(t?.size).toBe(3);
  });

  it("an empty or wholly unparseable snapshot → null (one degrade path)", () => {
    expect(parseProcessTable("")).toBeNull();
    expect(parseProcessTable("\n\n")).toBeNull();
    expect(parseProcessTable("ps: illegal option -- Z\n")).toBeNull();
  });

  it("a walk over the parsed fixture finds the harness ancestor", () => {
    // The parse and the walk compose: 1701 (claude) is reachable from 502.
    const t = parseProcessTable(SNAPSHOT);
    expect(findHarnessAncestor(t as Map<number, ProcessTableEntry>, 502, CLAUDE))
      .toBeNull(); // claude is a CHILD of 502 here, never an ancestor
    expect(findHarnessAncestor(t as Map<number, ProcessTableEntry>, 1701, CLAUDE))
      .toBe(1701);
  });
});

describe("HARNESS_PROCESS_TABLE", () => {
  it("holds only MEASURED harnesses (D-411-b: no generic heuristic)", () => {
    expect(HARNESS_PROCESS_TABLE.map(([id]) => id)).toEqual(["claude"]);
  });

  it("no matcher carries the /g flag (a global RegExp matches intermittently)", () => {
    for (const [, matcher] of HARNESS_PROCESS_TABLE) {
      expect(matcher.global).toBe(false);
    }
  });

  it("the claude matcher accepts both observed comm spellings", () => {
    const [, matcher] = HARNESS_PROCESS_TABLE[0];
    expect(matcher.test("claude")).toBe(true); // observed on darwin
    expect(matcher.test("/Users/me/.local/bin/claude")).toBe(true);
    // And refuses the shapes that would make a false owner:
    expect(matcher.test("node")).toBe(false);
    expect(matcher.test("/bin/zsh")).toBe(false);
    expect(matcher.test("claude-code")).toBe(false);
  });
});

describe("classifyInstanceLiveness — regression guards (already green)", () => {
  it("AC-3: a genuinely dead pid still classifies dead", () => {
    const v = classifyInstanceLiveness(
      {
        machine_hostname: hostname(),
        owner_pid: 999_999_999,
        owner_started_at: "definitely not alive",
      },
      hostname(),
    );
    expect(v.status).toBe("dead");
  });

  it("AC-4: a live pid with a differing start time → dead_pid_reused", () => {
    const v = classifyInstanceLiveness(
      {
        machine_hostname: hostname(),
        owner_pid: process.pid,
        owner_started_at: "Mon Jan  1 00:00:00 1970",
      },
      hostname(),
    );
    expect(v.status).toBe("dead_pid_reused");
  });

  it("a null owner_pid → unknown_no_metadata (the TD-411 degrade target)", () => {
    const v = classifyInstanceLiveness(
      {
        machine_hostname: hostname(),
        owner_pid: null,
        owner_started_at: null,
      },
      hostname(),
    );
    expect(v.status).toBe("unknown_no_metadata");
    expect(v.method).toBe("none");
  });

  it("a live pid with its real start time → alive", () => {
    const v = classifyInstanceLiveness(
      {
        machine_hostname: hostname(),
        owner_pid: process.pid,
        owner_started_at: getProcessStartTime(process.pid),
      },
      hostname(),
    );
    expect(v.status).toBe("alive");
  });
});
