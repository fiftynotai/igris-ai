/**
 * door-defaults.test.ts — FR-191 "the door" regression guard (AC #5).
 *
 * Pins the zero-config / all-OFF / local-only / identity-fileless posture of a
 * fresh `igris install`. A real from-source `runInit` materializes config.json
 * from the bundled `config.json.tmpl`, then `runInstall` runs against a staged
 * tmp project under a sandboxed HOME + IGRIS_BRAIN_DIR. No mocks (L-159) — the
 * real init + install handlers run.
 *
 * Asserts:
 *   (a) NO `<project>/CLAUDE.md` is written.
 *   (b) NO global `~/.claude/CLAUDE.md` is written by `igris init`.
 *   (c) `config.json.remote_brain` is absent/null (no VPS).
 *   (d) `cognition.perception.enabled === false` AND
 *       `cognition.subconscious.enabled === false`, with NO top-level
 *       `perception` / `subconscious` blocks remaining.
 *   (e) NO worker artifact is materialized.
 *
 * Written to be GREEN after the FR-191 render-machinery + template deletions:
 * the staged runtime core deliberately carries NO `CLAUDE.md.tmpl`, mirroring
 * the post-deletion world.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir: string;
let brainRoot: string;
let homeOverride: string;
let pathOverride: string;
let sourceRepo: string;
let projectDir: string;
const envBackup: Record<string, string | undefined> = {};

function stageSourceRepo(root: string): void {
  const core = join(root, "core");
  mkdirSync(core, { recursive: true });
  writeFileSync(join(core, "SOUL.md"), "# soul (from-source)\n");
  mkdirSync(join(core, "agents"), { recursive: true });
  writeFileSync(join(core, "agents", "manifest.yaml"), "agents: []\n");
  writeFileSync(join(core, "agents", "architect.md"), "# architect\n");
  // FR-187 layered core/os/ set.
  mkdirSync(join(core, "os"), { recursive: true });
  writeFileSync(join(core, "os", "INDEX.md"), "# Igris OS — Module Index\n");
  writeFileSync(join(core, "os", "standards.md"), "# Universal Standards\n");
  mkdirSync(join(core, "skills", "demo"), { recursive: true });
  writeFileSync(join(core, "skills", "demo", "SKILL.md"), "# demo\n");
  mkdirSync(join(core, "hooks"), { recursive: true });
  writeFileSync(
    join(core, "hooks", "canonical-settings.json"),
    JSON.stringify({ hooks: {} }, null, 2) + "\n",
  );
  mkdirSync(join(core, "scripts"), { recursive: true });
  writeFileSync(join(core, "scripts", "verify_mirror.sh"), "#!/bin/sh\necho noop\n");
  chmodSync(join(core, "scripts", "verify_mirror.sh"), 0o755);
  // FR-191: NO core/templates/CLAUDE.md.tmpl — the render machinery + template
  // were deleted. The door must close without an identity render path.
  mkdirSync(join(core, "templates"), { recursive: true });
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "igris-door-test-"));
  brainRoot = join(workDir, "brain");
  homeOverride = join(workDir, "home");
  pathOverride = join(workDir, "bin");
  sourceRepo = join(workDir, "source-repo");
  projectDir = join(workDir, "project");
  mkdirSync(homeOverride, { recursive: true });
  mkdirSync(pathOverride, { recursive: true });
  mkdirSync(join(projectDir, ".claude"), { recursive: true });

  envBackup.IGRIS_BRAIN_DIR = process.env.IGRIS_BRAIN_DIR;
  envBackup.HOME = process.env.HOME;
  envBackup.PATH = process.env.PATH;
  envBackup.IGRIS_ALLOW_INSECURE_SYNC = process.env.IGRIS_ALLOW_INSECURE_SYNC;
  process.env.IGRIS_BRAIN_DIR = brainRoot;
  process.env.HOME = homeOverride;
  delete process.env.IGRIS_ALLOW_INSECURE_SYNC;
  // Empty PATH so cli-detect finds nothing (no bridges to materialize).
  process.env.PATH = pathOverride;

  stageSourceRepo(sourceRepo);
  const reg = await import("../lib/registry.js");
  reg.closeDb();
});

afterEach(async () => {
  const reg = await import("../lib/registry.js");
  reg.closeDb();
  rmSync(workDir, { recursive: true, force: true });
  process.env.IGRIS_BRAIN_DIR = envBackup.IGRIS_BRAIN_DIR;
  process.env.HOME = envBackup.HOME;
  process.env.PATH = envBackup.PATH;
  if (envBackup.IGRIS_ALLOW_INSECURE_SYNC === undefined) {
    delete process.env.IGRIS_ALLOW_INSECURE_SYNC;
  } else {
    process.env.IGRIS_ALLOW_INSECURE_SYNC = envBackup.IGRIS_ALLOW_INSECURE_SYNC;
  }
});

describe("FR-191 door — fresh install posture", () => {
  it("install writes NO project CLAUDE.md, NO global CLAUDE.md, all cognition OFF, no VPS, no worker", async () => {
    const { runInit } = await import("../verbs/init.js");
    const { runInstall } = await import("../verbs/install.js");

    // Fresh init materializes config.json from the bundled template.
    expect(
      await runInit({ fromSource: sourceRepo, cliVersion: "7.0.0", yes: true }),
    ).toBe(0);

    // (b) init writes NO global ~/.claude/CLAUDE.md (HOME sandboxed).
    expect(existsSync(join(homeOverride, ".claude", "CLAUDE.md"))).toBe(false);

    // Install against a fresh project.
    const code = await runInstall({
      path: projectDir,
      installHooks: true,
      cliVersion: "7.0.0",
    });
    expect(code).toBe(0);

    // (a) NO project CLAUDE.md.
    expect(existsSync(join(projectDir, "CLAUDE.md"))).toBe(false);

    // Read the resulting runtime config.json.
    const cfg = JSON.parse(
      readFileSync(join(brainRoot, "config.json"), "utf-8"),
    ) as {
      remote_brain?: unknown;
      perception?: unknown;
      subconscious?: unknown;
      cognition?: {
        perception?: { enabled?: boolean };
        subconscious?: { enabled?: boolean };
      };
      worker?: unknown;
    };

    // (c) remote_brain absent/null (no VPS).
    expect(cfg.remote_brain == null).toBe(true);

    // (d) both cognition instances OFF under the nested namespace; no top-level
    //     perception/subconscious blocks remain.
    expect(cfg.cognition?.perception?.enabled).toBe(false);
    expect(cfg.cognition?.subconscious?.enabled).toBe(false);
    expect(cfg.perception).toBeUndefined();
    expect(cfg.subconscious).toBeUndefined();

    // (e) NO worker artifact: install never materializes a worker file/dir, and
    //     the template carries no worker block.
    expect(cfg.worker).toBeUndefined();
    // No worker file/dir anywhere under the brain root.
    const brainEntries = readdirSync(brainRoot);
    expect(brainEntries.some((e) => /worker/i.test(e))).toBe(false);
    // No worker registration file in the project's .claude/.
    const claudeEntries = existsSync(join(projectDir, ".claude"))
      ? readdirSync(join(projectDir, ".claude"))
      : [];
    expect(claudeEntries.some((e) => /worker|daemon/i.test(e))).toBe(false);
  });
});
