/**
 * core-runtime-extras — what a core swap does with files that live only in
 * the runtime copy (BR-103, AC-6): regenerate `harness-manifest.json` from
 * the staged ROOT, carry `docs/component-manifest.md` over, and REPORT (never
 * carry) anything else. Plus the two stagers that put the root manifest
 * beside the staged core: `copyFromSource` and the GitHub extractor's
 * allowlist (exact basename at depth 1 — a nested one is not it).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let work: string;
let stagedRoot: string;
let stagedCore: string;
let priorCore: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "igris-core-extras-"));
  stagedRoot = join(work, "core.new.1");
  stagedCore = join(stagedRoot, "core");
  priorCore = join(work, "core");
  mkdirSync(join(stagedCore, "hooks"), { recursive: true });
  writeFileSync(join(stagedCore, "hooks", "canonical-settings.json"), "{}\n");
  writeFileSync(join(stagedCore, "SOUL.md"), "# staged\n");
  mkdirSync(join(priorCore, "hooks"), { recursive: true });
  writeFileSync(join(priorCore, "hooks", "canonical-settings.json"), "{}\n");
  writeFileSync(join(priorCore, "SOUL.md"), "# prior\n");
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("applyCoreExtras (BR-103)", () => {
  it("regenerate: the staged ROOT's harness-manifest.json is moved under the staged core; the prior copy is never the source", async () => {
    const { applyCoreExtras } = await import("../lib/core-runtime-extras.js");
    writeFileSync(join(stagedRoot, "harness-manifest.json"), '{"v":2}\n');
    writeFileSync(join(priorCore, "harness-manifest.json"), '{"v":1}\n');
    const report = applyCoreExtras({ stagedRoot, stagedCore, priorCore });
    expect(report.regenerated).toEqual(["harness-manifest.json"]);
    expect(report.regenerateSourceMissing).toEqual([]);
    expect(readFileSync(join(stagedCore, "harness-manifest.json"), "utf-8")).toBe('{"v":2}\n');
  });

  it("regenerate with NO source in the staged root: reported, and the stale prior copy is NOT carried", async () => {
    const { applyCoreExtras } = await import("../lib/core-runtime-extras.js");
    writeFileSync(join(priorCore, "harness-manifest.json"), '{"v":1}\n');
    const report = applyCoreExtras({ stagedRoot, stagedCore, priorCore });
    expect(report.regenerateSourceMissing).toEqual(["harness-manifest.json"]);
    expect(report.regenerated).toEqual([]);
    expect(existsSync(join(stagedCore, "harness-manifest.json"))).toBe(false);
    // and it is not reported as unlisted either — it is a LISTED extra
    expect(report.unlisted).toEqual([]);
  });

  it("carry-over: docs/component-manifest.md from the prior core lands in the staged core when the staged core lacks it", async () => {
    const { applyCoreExtras } = await import("../lib/core-runtime-extras.js");
    mkdirSync(join(priorCore, "docs"), { recursive: true });
    writeFileSync(join(priorCore, "docs", "component-manifest.md"), "# runtime-only\n");
    const report = applyCoreExtras({ stagedRoot, stagedCore, priorCore });
    expect(report.carried).toEqual(["docs/component-manifest.md"]);
    expect(readFileSync(join(stagedCore, "docs", "component-manifest.md"), "utf-8")).toBe("# runtime-only\n");
  });

  it("carry-over: a SHIPPED docs/component-manifest.md wins over the prior copy", async () => {
    const { applyCoreExtras } = await import("../lib/core-runtime-extras.js");
    mkdirSync(join(priorCore, "docs"), { recursive: true });
    writeFileSync(join(priorCore, "docs", "component-manifest.md"), "# runtime-only\n");
    mkdirSync(join(stagedCore, "docs"), { recursive: true });
    writeFileSync(join(stagedCore, "docs", "component-manifest.md"), "# shipped\n");
    const report = applyCoreExtras({ stagedRoot, stagedCore, priorCore });
    expect(report.carried).toEqual([]);
    expect(readFileSync(join(stagedCore, "docs", "component-manifest.md"), "utf-8")).toBe("# shipped\n");
  });

  it("unlisted: a prior-core file the staged core lacks is REPORTED and NOT carried (an upgrade may mean to remove it)", async () => {
    const { applyCoreExtras } = await import("../lib/core-runtime-extras.js");
    mkdirSync(join(priorCore, "skills", "retired"), { recursive: true });
    writeFileSync(join(priorCore, "skills", "retired", "SKILL.md"), "# retired\n");
    writeFileSync(join(priorCore, "stray.md"), "stale\n");
    const report = applyCoreExtras({ stagedRoot, stagedCore, priorCore });
    expect(report.unlisted).toEqual(["skills/retired/SKILL.md", "stray.md"]);
    expect(existsSync(join(stagedCore, "stray.md"))).toBe(false);
    expect(existsSync(join(stagedCore, "skills", "retired", "SKILL.md"))).toBe(false);
  });

  it("fresh install (priorCore null): regenerate still runs, nothing is carried, nothing is unlisted", async () => {
    const { applyCoreExtras } = await import("../lib/core-runtime-extras.js");
    writeFileSync(join(stagedRoot, "harness-manifest.json"), '{"v":2}\n');
    const report = applyCoreExtras({ stagedRoot, stagedCore, priorCore: null });
    expect(report).toEqual({
      regenerated: ["harness-manifest.json"],
      regenerateSourceMissing: [],
      carried: [],
      unlisted: [],
    });
  });

  it("enumerateCoreExtras classifies every prior-only file by the allowlist", async () => {
    const { enumerateCoreExtras, CORE_RUNTIME_EXTRAS } = await import("../lib/core-runtime-extras.js");
    writeFileSync(join(priorCore, "harness-manifest.json"), "{}\n");
    mkdirSync(join(priorCore, "docs"), { recursive: true });
    writeFileSync(join(priorCore, "docs", "component-manifest.md"), "#\n");
    writeFileSync(join(priorCore, "stray.md"), "stale\n");
    expect(enumerateCoreExtras(priorCore, stagedCore)).toEqual([
      { rel: "docs/component-manifest.md", kind: "carry-over" },
      { rel: "harness-manifest.json", kind: "regenerate" },
      { rel: "stray.md", kind: "unlisted" },
    ]);
    // the allowlist is exactly the two files the plan enumerated (Finding 4)
    expect(CORE_RUNTIME_EXTRAS.map((e) => `${e.rel}:${e.policy}`)).toEqual([
      "harness-manifest.json:regenerate",
      "docs/component-manifest.md:carry-over",
    ]);
  });
});

describe("the two stagers put the root manifest beside the staged core (BR-103)", () => {
  it("copyFromSource stages <source>/harness-manifest.json at <dest>/harness-manifest.json (sha-verified) and reports it", async () => {
    const { copyFromSource } = await import("../lib/from-source.js");
    const source = join(work, "checkout");
    mkdirSync(join(source, "core"), { recursive: true });
    writeFileSync(join(source, "core", "SOUL.md"), "# soul\n");
    writeFileSync(join(source, "harness-manifest.json"), '{"harnesses":{}}\n');
    const dest = join(work, "staging-from-source");
    const r = copyFromSource({ sourcePath: source, destPath: dest });
    expect(r.fileCount).toBe(1);
    expect(r.manifestStaged).toBe(true);
    expect(readFileSync(join(dest, "harness-manifest.json"), "utf-8")).toBe('{"harnesses":{}}\n');
    // and NOT under core/ — that is applyCoreExtras's move, not the stager's
    expect(existsSync(join(dest, "core", "harness-manifest.json"))).toBe(false);
  });

  it("copyFromSource without a root manifest reports manifestStaged=false", async () => {
    const { copyFromSource } = await import("../lib/from-source.js");
    const source = join(work, "checkout-bare");
    mkdirSync(join(source, "core"), { recursive: true });
    writeFileSync(join(source, "core", "SOUL.md"), "# soul\n");
    const r = copyFromSource({ sourcePath: source, destPath: join(work, "staging-bare") });
    expect(r.manifestStaged).toBe(false);
  });

  it("the GitHub extractor admits the archive-ROOT harness-manifest.json and still skips every other non-core entry (README, cli/, a NESTED manifest)", async () => {
    const { fetchAndExtractFromFile } = await import("../lib/tarball.js");
    const stage = join(work, "tar-stage");
    const prefix = "igris-ai-fixturesha";
    const root = join(stage, prefix);
    mkdirSync(join(root, "core"), { recursive: true });
    writeFileSync(join(root, "core", "SOUL.md"), "soul\n");
    writeFileSync(join(root, "harness-manifest.json"), '{"harnesses":{}}\n');
    writeFileSync(join(root, "README.md"), "readme\n");
    mkdirSync(join(root, "cli", "src"), { recursive: true });
    writeFileSync(join(root, "cli", "src", "index.ts"), "// cli\n");
    mkdirSync(join(root, "nested"), { recursive: true });
    writeFileSync(join(root, "nested", "harness-manifest.json"), '{"decoy":true}\n');
    const tgz = join(work, "with-manifest.tar.gz");
    execFileSync("tar", ["-czf", tgz, "-C", stage, prefix]);

    const dest = join(work, "staging-github");
    mkdirSync(dest, { recursive: true });
    await fetchAndExtractFromFile(tgz, dest);
    expect(readFileSync(join(dest, "core", "SOUL.md"), "utf-8")).toBe("soul\n");
    expect(readFileSync(join(dest, "harness-manifest.json"), "utf-8")).toBe('{"harnesses":{}}\n');
    expect(existsSync(join(dest, "README.md"))).toBe(false);
    expect(existsSync(join(dest, "cli"))).toBe(false);
    expect(existsSync(join(dest, "nested"))).toBe(false);
  });
});
