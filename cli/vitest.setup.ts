/**
 * BR-106 — the tier-wide `HOME` belt for the CLI vitest suite.
 *
 * WHY. On 2026-09-08 a sentinel stripped the `HOME`/`IGRIS_BRAIN_DIR` fence
 * from `cli/src/__tests__/http.test.ts` to prove the fence was load-bearing.
 * All three cases still PASSED — and the run overwrote the operator's real
 * `~/.igris/.install-source.json`. The test succeeded BY reading and writing
 * real operator state, so the fence's absence was invisible to the suite.
 *
 * WHAT THIS IS. Harm reduction, not discipline. It repoints `HOME` to a
 * throwaway directory for EVERY test file, so a file nobody has triaged — and
 * every file written after today — cannot reach the operator's
 * `~/.claude.json`, `~/.igris/`, `~/.gemini/`, `~/.codex/` … by default.
 * `os.homedir()` reads `$HOME` first on POSIX and `os.userInfo()` (the one
 * home resolver that ignores `$HOME`) appears ZERO times in `cli/src`
 * (grep, 2026-09-10), so `$HOME` is a complete fence for this codebase.
 *
 * WHAT THIS IS NOT. It does not replace a per-file fence, and it does not make
 * `cli/src/__tests__/vitest-home-fence.test.ts` vacuous. That guard is a
 * STATIC scan over file text; a belt cannot change what a file SAYS. An
 * unfenced file still reds there, which is what keeps the same code safe when
 * it is run from bats, from `tsx`, or from a future runner with no belt.
 *
 * THE ESCAPE HATCH. FOUR vitest belts legitimately need the operator's real
 * home (the BR-099 `~/.claude.json` subtree belt, the two G-TR-0 `REAL_BRAIN`
 * assertions, the export home-path leak check). Because setup files run
 * BEFORE the test file's modules load, a module-level
 * `const REAL_HOME = process.env.HOME` would already see the belt and those
 * four belts would silently no-op. So `IGRIS_REAL_HOME` is published FIRST,
 * with the SAME keep-if-set semantics as the bats convention it reuses
 * (`cli/tests/integration/_helpers.bash:26` — `${IGRIS_REAL_HOME:-$HOME}`).
 * A stand-in launch (`HOME=<standin> IGRIS_REAL_HOME=$HOME npx vitest run`)
 * therefore behaves identically in both tiers. Do NOT invent a second name.
 *
 * NOT SET HERE: `IGRIS_BRAIN_DIR`. `brainDir()` falls back to
 * `<belt>/.igris`, which is already safe, and a global value would surprise
 * the files that assert it is unset.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// 1. Publish the real home BEFORE repointing HOME — order is load-bearing.
if (process.env.IGRIS_REAL_HOME === undefined && process.env.HOME !== undefined) {
  process.env.IGRIS_REAL_HOME = process.env.HOME;
}

// 2. Repoint HOME. `mkdtempSync` per invocation, and vitest runs setup files
//    once per test FILE, so two files never share a belt even when a worker
//    process is reused.
const belt = mkdtempSync(join(tmpdir(), "igris-vitest-belt-"));

// 3. Seed a git identity. TD-456's lesson: git under an empty HOME has no
//    identity, so a test that commits fails for the wrong reason.
writeFileSync(
  join(belt, ".gitconfig"),
  "[user]\n\tname = igris-vitest\n\temail = vitest@igris.invalid\n",
);

process.env.HOME = belt;

afterAll(() => {
  try {
    rmSync(belt, { recursive: true, force: true });
  } catch {
    // A leaked temp dir is not worth failing a green run over.
  }
});
