/**
 * engines-parity.test.ts — BR-105 (2026-09-08). The ONE pin for the supported
 * Node range.
 *
 * Before BR-105 the range lived in SEVEN places on disk plus a hard-coded
 * fourth number in `preflight.ts` (`major < 20`), and they had already
 * drifted: `brain-mcp-server/package-lock.json` said `>=20.0.0` with no
 * ceiling while its own `package.json` said `>=20.0.0 <27.0.0`.
 * `scripts/validate_lockfile_in_sync.sh` cannot see that — it runs
 * `npm ci --dry-run`, which compares dependency RESOLUTION, not `engines` —
 * which is why the drift survived BR-089.
 *
 * Every assertion NAMES its file, so a failure says which copy drifted.
 * The counts here are hard-coded on purpose (test_standards convention 4):
 * three manifests, four of OUR lockfile entries, three CI pins. A member
 * added or moved reds this file rather than silently leaving the pin.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NODE_FLOOR_MAJOR,
  SUPPORTED_NODE_RANGE,
  checkNodeVersion,
  nodeMajorSupported,
  PreflightError,
} from "../lib/preflight.js";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const readJson = (rel: string) =>
  JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf-8")) as Record<
    string,
    unknown
  >;
const readText = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf-8");

/** The three package.json files whose `engines.node` IS the advertised range. */
const MANIFESTS = [
  "package.json",
  "cli/package.json",
  "brain-mcp-server/package.json",
];

/** OUR four lockfile `engines` entries: [lockfile, packages-key]. */
const LOCK_ENTRIES: Array<[string, string]> = [
  ["package-lock.json", ""],
  ["package-lock.json", "cli"],
  ["package-lock.json", "brain-mcp-server"],
  ["brain-mcp-server/package-lock.json", ""],
];

describe("BR-105 — the supported Node range has exactly one source of truth", () => {
  // E-1
  it("E-1: every package.json `engines.node` is byte-identical to SUPPORTED_NODE_RANGE", () => {
    expect(MANIFESTS).toHaveLength(3);
    for (const rel of MANIFESTS) {
      const pkg = readJson(rel) as { engines?: { node?: string } };
      expect(
        pkg.engines?.node,
        `${rel} engines.node drifted from SUPPORTED_NODE_RANGE`,
      ).toBe(SUPPORTED_NODE_RANGE);
    }
  });

  // E-2
  it("E-2: every one of OUR four lockfile `engines` entries matches too", () => {
    expect(LOCK_ENTRIES).toHaveLength(4);
    for (const [rel, key] of LOCK_ENTRIES) {
      const lock = readJson(rel) as {
        packages?: Record<string, { engines?: { node?: string } }>;
      };
      const entry = lock.packages?.[key];
      expect(entry, `${rel} has no packages[${JSON.stringify(key)}]`).toBeDefined();
      expect(
        entry!.engines?.node,
        `${rel} packages[${JSON.stringify(key)}].engines.node drifted`,
      ).toBe(SUPPORTED_NODE_RANGE);
    }
  });

  // E-3 — the derivation, not the value, is what is pinned.
  it("E-3: NODE_FLOOR_MAJOR is DERIVED from the range's lowest `>=` operand", () => {
    const operands = SUPPORTED_NODE_RANGE.split("||").map((set) => {
      const m = /(?:^|\s)>=\s*(\d+)\./.exec(set);
      expect(m, `comparator set has no '>=' operand: ${set}`).not.toBeNull();
      return parseInt(m![1], 10);
    });
    expect(NODE_FLOOR_MAJOR).toBe(Math.min(...operands));
    // and the floor is itself inside the range (a range whose own floor is
    // excluded would be incoherent)
    expect(nodeMajorSupported(NODE_FLOOR_MAJOR)).toBe(true);
  });

  // E-4 — the three CI pins, and the COUNT.
  it("E-4: the three workflow `node-version` pins equal String(NODE_FLOOR_MAJOR)", () => {
    const files = [
      ".github/workflows/test.yml",
      ".github/workflows/npm-publish.yml",
    ];
    const found: Array<{ file: string; value: string }> = [];
    for (const rel of files) {
      for (const line of readText(rel).split("\n")) {
        const m = /^\s*node-version:\s*"?([^"\s#]+)"?\s*$/.exec(line);
        if (m !== null) found.push({ file: rel, value: m[1] });
      }
    }
    // The count is load-bearing: a job that moves away must not silently drop
    // out of the pin (measured 2026-09-08: test.yml cli-bats, test.yml
    // brain-vitest, npm-publish.yml publish).
    expect(
      found.map((f) => `${f.file}:${f.value}`),
      "expected exactly 3 node-version pins across the two workflows",
    ).toHaveLength(3);
    for (const f of found) {
      expect(f.value, `${f.file} node-version pin drifted`).toBe(
        String(NODE_FLOOR_MAJOR),
      );
    }
  });

  // E-5 — the guard refuses, and its message carries the reason.
  it("E-5: checkNodeVersion refuses below the floor, naming the range and the reason", () => {
    expect(() => checkNodeVersion(`${NODE_FLOOR_MAJOR - 1}.0.0`)).toThrow(
      PreflightError,
    );
    let msg = "";
    try {
      checkNodeVersion(`${NODE_FLOOR_MAJOR - 1}.0.0`);
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toContain(SUPPORTED_NODE_RANGE);
    expect(msg).toContain("better-sqlite3");
    expect(msg).toContain("prebuild");
  });

  // E-6 — and it accepts every major the range admits, refusing every one it
  // does NOT. A verification word over a set is a claim about every member,
  // so this walks the whole 20..27 window rather than sampling two points.
  it("E-6: checkNodeVersion accepts exactly the majors the range admits, 20..27", () => {
    const verdicts: Record<number, boolean> = {};
    for (let major = 20; major <= 27; major += 1) {
      let threw = false;
      try {
        checkNodeVersion(`${major}.0.0`);
      } catch {
        threw = true;
      }
      verdicts[major] = !threw;
      expect(
        verdicts[major],
        `checkNodeVersion(${major}) disagrees with nodeMajorSupported(${major})`,
      ).toBe(nodeMajorSupported(major));
    }
    // The measured pass set (2026-09-08 prebuild-probe.sh; see the
    // SUPPORTED_NODE_RANGE docblock for the full table).
    expect(verdicts).toEqual({
      20: false,
      21: false,
      22: true,
      23: false,
      24: true,
      25: true,
      26: true,
      27: false,
    });
  });

  // E-7 — the sentence a new user reads.
  it("E-7: docs/SETUP_GUIDE.md states the range verbatim", () => {
    expect(readText("docs/SETUP_GUIDE.md")).toContain(SUPPORTED_NODE_RANGE);
  });
});
