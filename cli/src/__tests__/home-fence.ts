/**
 * BR-106 — the shared `HOME` fence for the CLI vitest tier.
 *
 * The vitest twin of bats' `fence_home` / `assert_home_fenced`
 * (`cli/tests/integration/_helpers.bash:26-56`), and the reusable form of the
 * `install-mcp-keep.test.ts:98-127` idiom that `test_standards.md` names as
 * the vitest fence template.
 *
 * THE RULE (TD-456, restated for this tier). `IGRIS_BRAIN_DIR` alone is NOT a
 * fence. `brainDir()` honours it, but eleven builders in `cli/src/lib/paths.ts`
 * are `homedir()`-only and no env var reaches them — `claudeJsonPath`,
 * `geminiSettingsPath`, `geminiMcpConfigPath`, `geminiHooksPath`,
 * `antigravitySkillsDir`, `agentsSkillsDir`, `codexConfigPath`,
 * `opencodeConfigPath`, `claudeSettingsPath`, `antigravitySettingsPath`,
 * `geminiTrustedFoldersPath` — plus `expandTilde`. A test that drives a verb
 * reaching any of them must move `HOME`.
 *
 * ARMED, NOT ASSUMED. `assertArmed()` reads back from `os.homedir()` — the
 * resolver the production code actually calls — rather than trusting the env
 * var it just wrote, and refuses when the fence IS the operator's real home.
 * That second check is what makes a witness safe rather than merely
 * intended-to-be-safe: without it a fixture that accidentally points at the
 * real home reads as a fence.
 *
 * RESTORE BY KEY. `release()` restores `HOME` / `IGRIS_BRAIN_DIR` individually.
 * Never `process.env = saved` — that swaps in a plain object and later `HOME`
 * assignments stop reaching libuv's getenv, so `os.homedir()` silently keeps
 * the old value (test_standards; `http.test.ts:122`,
 * `machine-identity.test.ts:95-96`).
 *
 * This file is NOT a `*.test.ts`, so vitest never collects it as a suite —
 * same shape as `cli/src/__tests__/auto-push-fence.ts`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface HomeFence {
  /** The fenced `HOME`. */
  home: string;
  /** `<home>/.igris` — the value `IGRIS_BRAIN_DIR` was set to. */
  brainDir: string;
  /** Re-check the fence mid-test (after any code that might touch env). */
  assertArmed(): void;
  /** Restore `HOME` / `IGRIS_BRAIN_DIR` by key and remove the directory. */
  release(): void;
}

/**
 * The operator's real home, as published by `cli/vitest.setup.ts` (or by a
 * stand-in launch, or by bats' `_helpers.bash`). `undefined` when the belt is
 * not loaded — a single-file `npx vitest run <file>` still works, it just has
 * one fewer check available.
 */
export function realHome(): string | undefined {
  return process.env.IGRIS_REAL_HOME;
}

/**
 * Repoint `HOME` (and `IGRIS_BRAIN_DIR`) at a fresh throwaway directory and
 * prove the fence before returning.
 *
 * @param prefix `mkdtemp` prefix, so a failure names the suite that leaked.
 */
export function fenceHome(prefix = "igris-fence-"): HomeFence {
  const savedHome = process.env.HOME;
  const savedBrainDir = process.env.IGRIS_BRAIN_DIR;

  const home = mkdtempSync(join(tmpdir(), prefix));
  const brain = join(home, ".igris");
  mkdirSync(brain, { recursive: true });
  // Seed a git identity, exactly as bats' `fence_home` does. TD-456's lesson:
  // git under an empty HOME has no identity, so a fenced test that commits
  // would fail for the wrong reason and read as a fence regression.
  writeFileSync(
    join(home, ".gitconfig"),
    "[user]\n\tname = igris-vitest\n\temail = vitest@igris.invalid\n",
  );

  process.env.HOME = home;
  process.env.IGRIS_BRAIN_DIR = brain;

  const fence: HomeFence = {
    home,
    brainDir: brain,
    assertArmed(): void {
      assertHomeFenced(home);
    },
    release(): void {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedBrainDir === undefined) delete process.env.IGRIS_BRAIN_DIR;
      else process.env.IGRIS_BRAIN_DIR = savedBrainDir;
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // A leaked temp dir is not worth failing a green run over.
      }
    },
  };

  fence.assertArmed();
  return fence;
}

/**
 * Restore a whole-env snapshot WITHOUT replacing `process.env`.
 *
 * `process.env = saved` is the idiom this replaces, and it is a trap: it swaps
 * libuv's live environment for a PLAIN OBJECT, after which every
 * `process.env.HOME = x` writes to that object and never reaches `getenv`, so
 * `os.homedir()` silently keeps whatever value it had at the swap. In a file
 * with a per-test HOME fence that means test 2 onwards run under TEST 1's
 * fence — the fence reads as armed and is not. BR-106 hit exactly this in the
 * three `boot-sync*` suites.
 *
 * The semantics are identical to the assignment: keys added since the snapshot
 * are deleted, keys in the snapshot are restored.
 */
export function restoreEnv(saved: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(saved)) {
    if (value !== undefined) process.env[key] = value;
  }
}

/**
 * The four refusals, one `throw` each with its reason — the bats
 * `assert_home_fenced` contract (TD-341: one check per line, each naming why).
 * Exported so a fixture that builds its own stand-in home (the RED witness's
 * `H_real`) can prove the same property without going through `fenceHome`.
 */
export function assertHomeFenced(expected: string): void {
  if (!expected) {
    throw new Error("home fence NOT ARMED: the fence path is empty");
  }
  const resolved = homedir();
  if (resolved !== expected) {
    throw new Error(
      `home fence NOT ARMED: homedir() is ${resolved}, expected the fence ${expected}`,
    );
  }
  const real = realHome();
  if (real !== undefined && expected === real) {
    throw new Error(
      `home fence NOT ARMED: the fence IS the operator's real home (${expected})`,
    );
  }
}
