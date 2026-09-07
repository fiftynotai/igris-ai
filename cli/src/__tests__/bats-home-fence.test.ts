/**
 * TD-456 — every bats file that drives `igris install` / `igris init` runs
 * under a FENCED `HOME`.
 *
 * `igris install` step 11 and `igris init` write `~/.claude.json` (and the
 * other harness configs) from `os.homedir()`; `IGRIS_BRAIN_DIR` alone is not a
 * fence. Before this guard, four bats files ran those verbs under the
 * operator's real `$HOME`, and a full `npm run test:bats` against ANY dist
 * rewrote the real `mcpServers.igris-brain` entry to that dist's bundle path
 * (BR-103's forger run, 2026-09-07; the rolling `.igris.bak` proved the
 * chain). The RED for that class is taken against a stand-in HOME
 * (test_standards, the TD-390 bats-twin rule), never the real file.
 *
 * THE RULE, textual so a reviewer can check it by reading: a `.bats` file
 * with a line matching `$CLI_BIN install` / `$CLI_BIN init` that is NOT a
 * `--help` invocation (commander prints help and exits before `runInstall`,
 * so `version.bats`'s `install --help` cannot write) must contain
 * `fence_home` or `stage_brain` — and `stage_brain` in `_helpers.bash` must
 * itself call `fence_home`, or the second token is a fence in name only.
 * Both `fence_home` and `stage_brain` run `assert_home_fenced`, so the fence
 * is proved before the body runs rather than assumed.
 *
 * Shape: BR-100's `machine-identity-sweep.test.ts` — walk by fs path, assert
 * the population (a wrong directory scans nothing and reads "clean"), and
 * prove the scanner with a planted negative AND the exemption with a planted
 * `--help`-only copy.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const INTEGRATION = resolve(HERE, "..", "..", "tests", "integration");
const HELPERS = join(INTEGRATION, "_helpers.bash");

/** A line that runs the CLI's install or init verb (`$CLI_BIN install …`, `$CLI_BIN init …`). */
const INVOCATION = /\$CLI_BIN\s+(install|init)(?![\w-])/;

/** True when the line invokes install/init AND is not a `--help` call. */
export function isRealInvocation(line: string): boolean {
  return INVOCATION.test(line) && !line.includes("--help");
}

export interface FenceScan {
  /** Every `.bats` file scanned. */
  scanned: string[];
  /** Files with at least one real install/init invocation. */
  invoking: string[];
  /** Invoking files that carry neither `fence_home` nor `stage_brain`. */
  unfenced: string[];
}

/** Scan every `.bats` file directly under `dir`. */
export function scanBatsHomeFence(dir: string): FenceScan {
  const scanned: string[] = [];
  const invoking: string[] = [];
  const unfenced: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".bats")) continue;
    const p = join(dir, name);
    scanned.push(p);
    const text = readFileSync(p, "utf-8");
    if (!text.split("\n").some(isRealInvocation)) continue;
    invoking.push(p);
    if (!callsFn(text, "fence_home") && !callsFn(text, "stage_brain")) unfenced.push(p);
  }
  return { scanned, invoking, unfenced };
}

/**
 * `text` CALLS shell function `fn`: the name opens a command line (after
 * optional whitespace or `run `), with comment lines stripped first — a
 * mention inside a `#` comment or a string is not a call. The sentinel's
 * first TD-456 mutation kept the literal `fence_home` in a comment and the
 * substring form of this check stayed green (vacuous); this form reds.
 */
export function callsFn(text: string, fn: string): boolean {
  const code = text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  // The name must END the command word: `fence_home=1` (an assignment) and
  // `fence_home_x` are not calls. Known evasion left open on purpose: a
  // heredoc body is not a comment, so a fixture blob that starts a line with
  // the bare name would read as a call — none exists in the tier (grep,
  // 2026-09-08); a stricter parse would need a shell tokenizer.
  return new RegExp(`^\\s*(?:run\\s+)?${fn}(?:[\\s;&|]|$)`, "m").test(code);
}

/** The body of `stage_brain()` in a helpers file calls `fence_home`. */
export function stageBrainFences(helpersText: string): boolean {
  const m = /^stage_brain\(\)\s*\{\n([\s\S]*?)^\}/m.exec(helpersText);
  return m !== null && callsFn(m[1]!, "fence_home");
}

describe("TD-456 — bats files that run `igris install` / `igris init` fence HOME", () => {
  it("every invoking file carries fence_home or stage_brain (whole tier)", () => {
    const scan = scanBatsHomeFence(INTEGRATION);
    expect(scan.unfenced.map((p) => p.slice(INTEGRATION.length + 1))).toEqual([]);
  });

  it("stage_brain itself calls fence_home (a fence in name only would satisfy the textual rule)", () => {
    const helpers = readFileSync(HELPERS, "utf-8");
    expect(stageBrainFences(helpers)).toBe(true);
    // And the helper carries the assertion the fence is proved with.
    expect(helpers).toMatch(/^assert_home_fenced\(\)/m);
  });

  it("is NOT vacuous: the population is asserted (>= 15 files scanned, >= 5 invoking)", () => {
    const scan = scanBatsHomeFence(INTEGRATION);
    expect(scan.scanned.length).toBeGreaterThanOrEqual(15);
    expect(scan.invoking.length).toBeGreaterThanOrEqual(5);
    // The four files the incident named are all in the invoking set or the
    // --help-only set — version.bats is the exemption, proved below.
    const names = scan.invoking.map((p) => p.slice(INTEGRATION.length + 1));
    for (const f of ["install.bats", "install-symlinks.bats", "default-install-installs-hooks.bats", "init.bats"]) {
      expect(names, f).toContain(f);
    }
  });

  it("VACUITY CONTROL: a comment that merely mentions fence_home is not a fence (helpers body and bats file)", () => {
    const helpers = "stage_brain() {\n  # fence_home is documented here but never called\n  export IGRIS_BRAIN_DIR=x\n}\n";
    expect(stageBrainFences(helpers)).toBe(false);
    expect(stageBrainFences("stage_brain() {\n  fence_home\n}\n")).toBe(true);
    expect(stageBrainFences("stage_brain() {\n  run fence_home\n}\n")).toBe(true);
    expect(stageBrainFences("stage_brain() {\n  fence_home=1\n}\n")).toBe(false);
    expect(stageBrainFences("stage_brain() {\n  fence_home_x\n}\n")).toBe(false);
    const tmp = mkdtempSync(join(tmpdir(), "td456-vacuity-"));
    try {
      writeFileSync(
        join(tmp, "comment-only.bats"),
        "# see fence_home and stage_brain in _helpers.bash\n@test \"planted\" {\n  run $CLI_BIN install \"$PROJ\"\n}\n",
      );
      const scan = scanBatsHomeFence(tmp);
      expect(scan.unfenced).toEqual([join(tmp, "comment-only.bats")]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("SELF-NEGATIVE CONTROL: a copy of install.bats with stage_brain removed and an unfenced install planted is reported", () => {
    const tmp = mkdtempSync(join(tmpdir(), "td456-fence-"));
    try {
      const real = readFileSync(join(INTEGRATION, "install.bats"), "utf-8");
      expect(real).toMatch(/\bstage_brain\b/); // the real file satisfies the rule
      const mutant = real.replace(/\bstage_brain\b/g, "stage_nothing");
      expect(mutant).not.toMatch(/\bstage_brain\b/);
      expect(mutant).not.toMatch(/\bfence_home\b/);
      writeFileSync(join(tmp, "planted.bats"), `${mutant}\n@test "planted" {\n  run $CLI_BIN install "$PROJ"\n}\n`);
      const scan = scanBatsHomeFence(tmp);
      expect(scan.scanned).toEqual([join(tmp, "planted.bats")]);
      expect(scan.unfenced).toEqual([join(tmp, "planted.bats")]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("EXEMPTION, proved: a copy carrying ONLY `run $CLI_BIN install --help` is NOT reported", () => {
    const tmp = mkdtempSync(join(tmpdir(), "td456-help-"));
    try {
      writeFileSync(
        join(tmp, "help-only.bats"),
        `#!/usr/bin/env bats\nload _helpers.bash\n@test "help" {\n  run $CLI_BIN install --help\n  [ "$status" -eq 0 ]\n}\n`,
      );
      const scan = scanBatsHomeFence(tmp);
      expect(scan.scanned).toEqual([join(tmp, "help-only.bats")]);
      expect(scan.invoking).toEqual([]);
      expect(scan.unfenced).toEqual([]);
      // The line itself is the exemption, not the file: the same line without
      // --help IS a real invocation.
      expect(isRealInvocation('  run $CLI_BIN install --help')).toBe(false);
      expect(isRealInvocation('  run $CLI_BIN install "$PROJ"')).toBe(true);
      expect(isRealInvocation('  run $CLI_BIN init --from-source "$SRC"')).toBe(true);
      expect(isRealInvocation('  run $CLI_BIN install-git-hooks "$PROJ"')).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
