/**
 * TD-373 — the bundled brain-mcp-server artifact: current, and free of output
 * for sources that no longer exist.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT A COPY OF `dashboard-artifact.test.ts`
 * ─────────────────────────────────────────────────────────────────────────────
 * This repo shipped a freshness guard on the surface a USER sees
 * (`dist/dashboard`, TD-276's T7) and none on the surface an AGENT EXECUTES.
 * `~/.claude.json` registers `cli/dist/brain-mcp-server/dist/index.js` as the
 * `igris-brain` MCP server command, so that directory is not a publish
 * artifact that happens to sit in the tree — it is the running brain.
 *
 * On 2026-08-10 it was measured at SIX DAYS old: TD-327 had shipped the
 * cognition roster four days earlier and `roster.js` had never been compiled,
 * so the operator's live brain could not serve it. Nothing failed, because
 * nothing was asking.
 *
 * TWO DEFECTS, AND THEY NEED TWO DIFFERENT ASSERTIONS
 * ───────────────────────────────────────────────────
 * 1. STALENESS — a source is newer than the build. An mtime comparison catches
 *    this, and that is what T7 does for the dashboard. Mirrored below.
 *
 * 2. ORPHANS — a source was DELETED and its emitted `.js` / `.d.ts` / `.map`
 *    stayed. **An mtime comparison structurally cannot see this.** Deleting a
 *    file makes nothing newer, so every mtime guard reports fresh, forever.
 *    `tsc` emits; it does not prune.
 *
 * The second is not hypothetical. `c6777bc` ("delete the rule-detector engine")
 * removed `src/engine/components/subconscious/detectors/` and
 * `subconscious/{readonly-db,verifier}.ts`. Their 24 build artifacts kept
 * shipping in the npm tarball for months — until they pushed the packed size
 * **3 bytes** past TD-329's ceiling and a `tarball.test.ts` assertion finally
 * went red for a reason that had nothing to do with the commit that tripped it.
 *
 * That is the whole lesson, and it is the same one `NEVER_DEGRADES` taught in
 * TD-372: **a guard that only inspects the files PRESENT can never report one
 * that should not be.** Freshness is a property of what is there; orphaning is
 * a property of what is missing from the other side. Two questions, two checks.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ───────────────────────────────────────
 * It does not assert a file COUNT. A count is the same category error one level
 * up — it goes green on a delete-plus-add and it needs re-blessing on every
 * legitimate module. The orphan scan asserts the RELATION (every emitted file
 * traces to a source), which is what actually matters and never needs updating.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const CLI_ROOT = join(__dirname, "..", "..");
const MCP_SRC = join(CLI_ROOT, "..", "brain-mcp-server", "src");
const MCP_DIST = join(CLI_ROOT, "..", "brain-mcp-server", "dist");
/** The path `~/.claude.json` registers as the `igris-brain` server command. */
const BUNDLED = join(CLI_ROOT, "dist", "brain-mcp-server", "dist");
const BUNDLED_ENTRY = join(BUNDLED, "index.js");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/**
 * Newest mtime of files that can actually change the COMPILED output.
 *
 * `__tests__` is excluded for the same reason T7 excludes it: those files are
 * outside the emitted module graph, so an edit to one cannot make `dist/`
 * stale — and a guard that fires on an edit it knows is irrelevant is a guard
 * people start ignoring.
 */
function newestSourceMtime(dir: string): number {
  return walk(dir)
    .filter((f) => !f.includes(`${sep}__tests__${sep}`))
    .filter((f) => /\.tsx?$/.test(f))
    .reduce((max, f) => Math.max(max, statSync(f).mtimeMs), 0);
}

/**
 * Emitted files under `dist/` with no corresponding source under `src/`.
 *
 * Strips the longest known suffix first, so `foo.d.ts.map`, `foo.js.map`,
 * `foo.d.ts` and `foo.js` all resolve to the same stem `foo` — otherwise
 * `foo.d.ts` would be tested against a source named `foo.d.ts` and every
 * declaration file in the tree would read as an orphan.
 */
function orphanedArtifacts(distDir: string, srcDir: string): string[] {
  const out: string[] = [];
  for (const abs of walk(distDir)) {
    const rel = abs.slice(distDir.length + 1);
    let stem: string;
    if (rel.endsWith(".d.ts.map")) stem = rel.slice(0, -".d.ts.map".length);
    else if (rel.endsWith(".js.map")) stem = rel.slice(0, -".js.map".length);
    else if (rel.endsWith(".d.ts")) stem = rel.slice(0, -".d.ts".length);
    else if (rel.endsWith(".js")) stem = rel.slice(0, -".js".length);
    else continue;
    if (
      !existsSync(join(srcDir, `${stem}.ts`)) &&
      !existsSync(join(srcDir, `${stem}.tsx`))
    ) {
      out.push(rel);
    }
  }
  return out.sort();
}

const REBUILD = "run `npm run build` in cli/ (it cleans dist/ first — TD-373)";

describe("TD-373 — the bundled brain-mcp-server is present", () => {
  it("cli/dist/brain-mcp-server/dist/index.js exists", () => {
    expect(
      existsSync(BUNDLED_ENTRY),
      `no bundled MCP at ${BUNDLED} — ${REBUILD}`,
    ).toBe(true);
  });
});

describe("TD-373 — the `igris` bin is EXECUTABLE", () => {
  /**
   * Found the hard way. `package.json`'s `bin` maps `igris` to
   * `dist/index.js`, and `node_modules/.bin/igris` is a symlink to it — but
   * `tsc` emits 0644 and nothing in the build ever set the bit. It worked
   * anyway because a past `npm install` chmod'd the file that existed AT THAT
   * MOMENT; the bit was a property of one install, not of the build.
   *
   * The first `rm -rf dist` in this brief's own work therefore produced a
   * `dist/index.js` that could not run, and 3 harness-registry assertions
   * failed with `Permission denied` from a shell two layers down — a failure
   * that reads as a compiler bug and is a file mode.
   *
   * Same shape as the orphan check above: the artifact was correct only by
   * historical accident, and nothing asked. `chmod +x` now runs in the build;
   * this asserts it did.
   *
   * ONLY `cli` GOT THE CHMOD, DELIBERATELY. `brain-mcp-server/package.json`
   * declares a bin too (`igris-brain-mcp-server` -> `./dist/index.js`, with the
   * same shebang), and its build was changed by the same brief — so leaving it
   * un-chmod'd is exactly the asymmetry this docblock warns about, and it is a
   * disposition rather than an oversight: **nothing invokes it as a bare
   * command.** Every caller in the tree spawns it through `node <path>` —
   * `copy-templates.sh`'s smoke check, `npm-publish.yml`, its own `start`
   * script, and `~/.claude.json`'s MCP registration, which is
   * `node .../dist/index.js`. A bin declared but never executed as one does not
   * need the bit. If a caller ever drops the `node` prefix, add the chmod and
   * an assertion here in the same change.
   */
  it("dist/index.js has the owner-execute bit", () => {
    const entry = join(CLI_ROOT, "dist", "index.js");
    if (!existsSync(entry)) return; // a bundle-absent tree is T7's problem
    const mode = statSync(entry).mode;
    expect(
      (mode & 0o100) !== 0,
      `cli/dist/index.js is not executable (mode ${(mode & 0o777).toString(8)}). ` +
        `package.json maps the \`igris\` bin to it, so every shell-out to the ` +
        `CLI fails with "Permission denied". ${REBUILD}`,
    ).toBe(true);
  });

  it("it starts with the node shebang the bin mapping assumes", () => {
    const entry = join(CLI_ROOT, "dist", "index.js");
    if (!existsSync(entry)) return;
    expect(readFileSync(entry, "utf-8").split("\n", 1)[0]).toBe(
      "#!/usr/bin/env node",
    );
  });
});

describe("TD-373 — the bundled brain-mcp-server is CURRENT", () => {
  it("no brain-mcp-server source is newer than the bundled index.js", () => {
    if (!existsSync(BUNDLED_ENTRY)) return; // covered by the presence test
    const built = statSync(BUNDLED_ENTRY).mtimeMs;
    const newestSrc = newestSourceMtime(MCP_SRC);
    expect(
      newestSrc,
      `cli/dist/brain-mcp-server is STALE — this is the path ~/.claude.json ` +
        `runs as the igris-brain MCP server, so a stale build means the live ` +
        `brain is serving old code. ${REBUILD}`,
    ).toBeLessThanOrEqual(built + 1000);
  });
});

describe("TD-373 — no output survives its deleted source", () => {
  /**
   * Checked on BOTH copies deliberately, and the reason is NOT that the stage
   * is additive — `copy-templates.sh` does `rm -rf "$MCP_DEST"` before every
   * copy, so the shipped tree is a fresh mirror each time it runs.
   *
   * The reason is that the two are cleaned by DIFFERENT commands with
   * DIFFERENT triggers. `brain-mcp-server/dist` is pruned by its own build;
   * `cli/dist/brain-mcp-server/dist` is only refreshed when
   * `copy-templates.sh` runs, which happens as step 2 of `cli`'s build. So
   * `cd brain-mcp-server && npm run build` — a thing developers, CI
   * (`test.yml`), the VPS deploy script and `igris sync code` all do on its
   * own — prunes upstream and leaves the SHIPPED copy holding the orphan it
   * just deleted. The shipped copy is what `npm pack` reads and what the
   * packed ceiling charges for, so it is the one that actually matters.
   *
   * Asserting only upstream would therefore go green on the exact state that
   * ships the bytes.
   */
  it("brain-mcp-server/dist holds no artifact for a deleted source", () => {
    if (!existsSync(MCP_DIST)) return;
    expect(
      orphanedArtifacts(MCP_DIST, MCP_SRC),
      `orphaned build artifacts in brain-mcp-server/dist — their sources are ` +
        `gone but tsc never prunes. ${REBUILD}`,
    ).toEqual([]);
  });

  it("the SHIPPED copy holds no artifact for a deleted source", () => {
    if (!existsSync(BUNDLED)) return;
    expect(
      orphanedArtifacts(BUNDLED, MCP_SRC),
      `orphaned build artifacts in cli/dist/brain-mcp-server/dist — these ` +
        `SHIP in the npm tarball and count against the packed ceiling. ` +
        `${REBUILD}`,
    ).toEqual([]);
  });
});
