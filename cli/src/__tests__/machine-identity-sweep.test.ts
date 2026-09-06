/**
 * BR-100 AC-1 — ONE machine identity function.
 *
 * A static scan of `cli/src/**` and `brain-mcp-server/src/**` (by fs path — the
 * event-bus integrity precedent), excluding `__tests__`, for the token
 * `hostname()` (`os.hostname()` or a bare named-import call). The ONLY hits may
 * be the two identity twins. Prose counts: the regex matches a docblock, so a
 * comment that says "`os.hostname()`" is a hit too — which is deliberate,
 * because a comment naming the retired mechanism is how the next reader
 * re-introduces it.
 *
 * Self-negative control: the scanner is run over a temp copy of `session.ts`
 * with the token planted, and must report it — otherwise "zero hits" would be
 * a statement about the scanner, not about the tree.
 */

import { describe, expect, it } from "vitest";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const ROOTS = [resolve(REPO, "cli", "src"), resolve(REPO, "brain-mcp-server", "src")];
const ALLOWED = new Set([
  resolve(REPO, "cli", "src", "lib", "machine-identity.ts"),
  resolve(REPO, "brain-mcp-server", "src", "machine-identity.ts"),
]);
const TOKEN = /\bhostname\(\)/;

/** Every `.ts` file under `root` (skipping `__tests__` dirs) whose text matches TOKEN; `scanned` counts the population. */
export function scanForHostnameCalls(root: string, scanned = { files: 0 }): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(join(dir, entry.name));
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        scanned.files++;
        const p = join(dir, entry.name);
        if (TOKEN.test(readFileSync(p, "utf-8"))) hits.push(p);
      }
    }
  };
  walk(root);
  return hits.sort();
}

describe("BR-100 AC-1 — `hostname()` is called in the two identity twins and NOWHERE else", () => {
  it("zero non-test hits outside the identity modules (both packages)", () => {
    const hits = ROOTS.flatMap((root) => scanForHostnameCalls(root));
    const outside = hits.filter((p) => !ALLOWED.has(p)).map((p) => relative(REPO, p));
    expect(outside).toEqual([]);
  });

  it("is NOT vacuous: both twins are scanned and both carry the call; each root is a populated tree", () => {
    for (const root of ROOTS) {
      const scanned = { files: 0 };
      const hits = new Set(scanForHostnameCalls(root, scanned));
      // A wrong path would scan nothing and report "clean" — the population is asserted.
      expect(scanned.files, relative(REPO, root)).toBeGreaterThan(100);
      const twin = [...ALLOWED].find((a) => a.startsWith(root + "/"))!;
      expect(hits.has(twin), relative(REPO, twin)).toBe(true);
    }
  });

  it("SELF-NEGATIVE CONTROL: a planted `os.hostname()` in a temp copy of session.ts is detected", () => {
    const tmp = mkdtempSync(join(tmpdir(), "br100-sweep-"));
    try {
      const copy = join(tmp, "session.ts");
      copyFileSync(resolve(REPO, "cli", "src", "verbs", "session.ts"), copy);
      expect(scanForHostnameCalls(tmp)).toEqual([]); // the real file is clean
      writeFileSync(copy, readFileSync(copy, "utf-8") + "\nconst planted = os.hostname();\n");
      expect(scanForHostnameCalls(tmp)).toEqual([copy]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
