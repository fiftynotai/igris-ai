/**
 * FR-238 (R2 / T4) — the CLI -> brain-bundle runtime bridge.
 *
 * Two things must be true and are asserted here:
 *   1. In a BUILT tree the bridge actually RESOLVES and the pure FR-237 builder
 *      really runs. Asserting only "failure degrades gracefully" would let the
 *      path literal rot silently — which is exactly R2.
 *   2. Every failure mode returns a DISCRIMINATED failure naming its cause
 *      rather than throwing (and never a collapsed generic string — see the
 *      build_failed regression guard below).
 *
 * The resolution assertions are conditional on `dist/brain-mcp-server/` being
 * staged, because a fresh clone has not run `copy-templates.sh` yet. They are
 * NOT skipped: the repo-checkout fallback (`brain-mcp-server/dist/engine/`) is
 * a second candidate, and at least one of the two is present in any tree where
 * `npm run build` has run in either package. If neither exists the suite
 * asserts the DEGRADED contract instead, which is the honest thing to check in
 * that tree.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  brainEngineCandidates,
  buildGraph,
  lastBridgeFailure,
  loadBuildBrainGraph,
  openBrainReadonly,
  probe,
  resetBrainBridge,
  resolveWholeGraphModulePath,
} from "../lib/brain-bridge.js";

let sandbox: string;
const prevBrain = process.env.IGRIS_BRAIN_DIR;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "igris-bridge-"));
  process.env.IGRIS_BRAIN_DIR = sandbox;
  resetBrainBridge();
});

afterEach(() => {
  resetBrainBridge();
  if (prevBrain === undefined) delete process.env.IGRIS_BRAIN_DIR;
  else process.env.IGRIS_BRAIN_DIR = prevBrain;
  rmSync(sandbox, { recursive: true, force: true });
});

const engineAvailable = resolveWholeGraphModulePath() !== null;

describe("bridge — path resolution (R2: the path literal must not rot)", () => {
  it("names the vendored bundle FIRST and the repo checkout as a fallback", () => {
    const candidates = brainEngineCandidates();
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toContain(
      join("dist", "brain-mcp-server", "dist", "engine"),
    );
    expect(candidates[1]).toContain(
      join("brain-mcp-server", "dist", "engine"),
    );
  });

  it("resolves whole-graph.js under components/edges/", () => {
    const resolved = resolveWholeGraphModulePath();
    if (!engineAvailable) {
      // No built brain in this tree — assert the degraded contract instead.
      expect(resolved).toBeNull();
      return;
    }
    expect(resolved).toContain(join("components", "edges", "whole-graph.js"));
    expect(existsSync(resolved as string)).toBe(true);
  });
});

describe("bridge — module load", () => {
  it("loads buildBrainGraph from the vendored bundle (or degrades to null)", async () => {
    const fn = await loadBuildBrainGraph();
    if (!engineAvailable) {
      expect(fn).toBeNull();
      expect(lastBridgeFailure()).toContain("not found");
      return;
    }
    expect(typeof fn).toBe("function");
  });

  it("probe() reports availability without throwing", async () => {
    const p = await probe();
    expect(typeof p.available).toBe("boolean");
    if (p.available) {
      expect(p.module_path).not.toBeNull();
      expect(p.reason).toBeNull();
    } else {
      expect(p.module_path).toBeNull();
      expect(typeof p.reason).toBe("string");
    }
  });

  it("memoises — a second load returns the same handle", async () => {
    const a = await loadBuildBrainGraph();
    const b = await loadBuildBrainGraph();
    expect(a).toBe(b);
  });
});

describe("bridge — read-only brain handle", () => {
  it("returns null when the brain DB does not exist", () => {
    expect(openBrainReadonly()).toBeNull();
  });

  it("opens an existing DB and closes cleanly", async () => {
    const Database = (await import("better-sqlite3")).default;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(sandbox, "memory"), { recursive: true });
    const path = join(sandbox, "memory", "knowledge.db");
    const seed = new Database(path);
    seed.exec("CREATE TABLE t (a INTEGER)");
    seed.close();

    const handle = openBrainReadonly();
    expect(handle).not.toBeNull();
    handle?.close();
  });
});

describe("bridge — degradation contract (never throws, and NAMES the cause)", () => {
  it("buildGraph reports brain_unavailable when the DB is absent", async () => {
    const r = await buildGraph();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // MUST be the exact discriminant, not a disjunction. An earlier version of
    // this test accepted `["brain_unavailable", "engine_unavailable"]`, which
    // would have passed even if buildGraph regressed to reporting a missing
    // ENGINE for a missing DATABASE — precisely the conflation the discriminated
    // result was introduced to remove. A test that cannot fail on its own
    // regression is not a guard.
    //
    // Guarded on `engineAvailable` because the engine check runs FIRST in
    // buildGraph: in a tree with no built engine, `engine_unavailable` is the
    // correct answer here and the assertion below would be wrong.
    if (engineAvailable) expect(r.kind).toBe("brain_unavailable");
    expect(r.reason).toContain("could not be opened read-only");
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it("buildGraph reports engine_unavailable when the vendored engine is absent", async () => {
    // The POSITIVE case for the third discriminant. It had no direct coverage:
    // the only paths that produced it were `if (!engineAvailable)` branches
    // that never fire in CI (where the tree IS built) plus the disjunction
    // removed above.
    //
    // Reaching it means making `resolveWholeGraphModulePath()` miss BOTH walk-up
    // candidates. The engine root derives from `import.meta.url`, so it is not
    // injectable — and renaming the real `dist/brain-mcp-server/` would mutate a
    // shared build artifact mid-run, racing `tarball.test.ts` (which asserts
    // that exact path is in the pack manifest) in a parallel file run.
    //
    // So: stand up a temp directory that LOOKS like an installed package root
    // (`<tmp>/dist/lib/`) holding a copy of the two compiled modules the bridge
    // needs, with no `dist/brain-mcp-server/` anywhere. Importing the bridge
    // from in there makes both candidates miss for real, with zero effect on
    // the repo tree.
    const {
      existsSync: exists,
      mkdirSync,
      readFileSync,
      symlinkSync,
      writeFileSync,
    } = await import("node:fs");

    /**
     * Copy a compiled module, dropping its `//# sourceMappingURL=` trailer.
     * The `.map` files are deliberately NOT copied (they point at `src/`, which
     * does not exist in the isolated root), and vite's SSR loader logs a noisy
     * ENOENT for every unresolvable map. Stripping the trailer keeps the run
     * quiet without changing a byte of executable code.
     */
    const copyStripped = (from: string, to: string): void => {
      writeFileSync(
        to,
        readFileSync(from, "utf-8").replace(
          /\n\/\/# sourceMappingURL=.*$/m,
          "\n",
        ),
      );
    };

    const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const compiledBridge = join(cliRoot, "dist", "lib", "brain-bridge.js");
    const compiledPaths = join(cliRoot, "dist", "lib", "paths.js");
    // Needs a built tree. `npm run build` runs before this suite in CI.
    if (!exists(compiledBridge) || !exists(compiledPaths)) return;

    const isolated = mkdtempSync(join(tmpdir(), "igris-bridge-noengine-"));
    try {
      const libDir = join(isolated, "dist", "lib");
      mkdirSync(libDir, { recursive: true });
      // The compiled bridge's entire import graph is `./paths.js` +
      // `better-sqlite3` + node builtins (verified against dist/lib/brain-bridge.js).
      copyStripped(compiledBridge, join(libDir, "brain-bridge.js"));
      copyStripped(compiledPaths, join(libDir, "paths.js"));
      // Resolve `better-sqlite3` from the repo's install. Workspaces hoist to
      // the monorepo root.
      for (const nm of [
        join(cliRoot, "..", "node_modules"),
        join(cliRoot, "node_modules"),
      ]) {
        if (exists(join(nm, "better-sqlite3"))) {
          symlinkSync(nm, join(isolated, "node_modules"), "dir");
          break;
        }
      }

      const iso = (await import(
        pathToFileURL(join(libDir, "brain-bridge.js")).href
      )) as typeof import("../lib/brain-bridge.js");

      // Self-verify the harness before trusting its verdict: if either candidate
      // somehow resolved, the assertion below would be measuring nothing.
      expect(iso.resolveWholeGraphModulePath()).toBeNull();

      const r = await iso.buildGraph({ project: "demo" });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.kind).toBe("engine_unavailable");
      expect(r.reason).toContain("not found");

      // And the probe must agree with the build — the /api/health vs
      // /api/graph/stats contradiction from the e2e run was exactly a
      // disagreement between these two.
      const p = await iso.probe();
      expect(p.available).toBe(false);
      expect(p.module_path).toBeNull();
      expect(p.reason).not.toBeNull();
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("buildGraph reports a cause when the brain file is not a database", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(sandbox, "memory"), { recursive: true });
    writeFileSync(join(sandbox, "memory", "knowledge.db"), "not sqlite");
    const r = await buildGraph();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it("a builder THROW is reported as build_failed with the verbatim message, NOT as engine_unavailable", async () => {
    // Regression guard for a real defect found in the FR-238 e2e run: a
    // schema-mismatch throw inside the builder was reported as "brain engine
    // unavailable" while /api/health simultaneously said the engine WAS
    // available. That contradiction sends an operator hunting for a packaging
    // problem when the real cause is the database.
    if (!engineAvailable) return;
    const Database = (await import("better-sqlite3")).default;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(sandbox, "memory"), { recursive: true });
    const seed = new Database(join(sandbox, "memory", "knowledge.db"));
    // A `brief_status` table missing the columns the builder projects: present
    // (so the missing-table degradation does NOT fire) but wrong.
    seed.exec("CREATE TABLE brief_status (brief_id TEXT PRIMARY KEY)");
    seed.close();

    const r = await buildGraph({ project: "demo" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("build_failed");
    expect(r.reason).toContain("brain graph build failed:");
    // The underlying sqlite diagnosis must survive to the caller.
    expect(r.reason).toContain("no such column");
  });

  it("buildGraph over a REAL seeded brain returns the FR-237 payload shape", async () => {
    if (!engineAvailable) return;
    const Database = (await import("better-sqlite3")).default;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(sandbox, "memory"), { recursive: true });
    const seed = new Database(join(sandbox, "memory", "knowledge.db"));
    // An empty-but-valid brain: the builder's own missing-table degradation
    // path is what runs, which is the contract we care about here.
    seed.exec("CREATE TABLE placeholder (a INTEGER)");
    seed.close();

    const result = await buildGraph({ project: "demo" });
    expect(result.ok, result.ok ? "" : result.reason).toBe(true);
    if (!result.ok) return;
    const graph = result.graph;
    // The facade's field set must match what the builder actually returns.
    expect(graph).toHaveProperty("stats.node_count");
    expect(graph).toHaveProperty("stats.edge_count");
    expect(graph).toHaveProperty("stats.by_edge_type");
    expect(graph).toHaveProperty("edge_resolution.rule");
    expect(graph.edge_resolution.rule).toBe("intra_project_projection");
    expect(graph).toHaveProperty("degraded.missing_tables");
    expect(Array.isArray(graph.degraded.missing_tables)).toBe(true);
    expect(typeof graph.truncated).toBe("boolean");
  });
});
