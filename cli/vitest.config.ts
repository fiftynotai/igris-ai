/**
 * BR-106 — the FIRST vitest config for `cli/`. Before this file the suite ran
 * on vitest's built-in defaults (`cli/package.json` -> `"test": "vitest run"`).
 *
 * `setupFiles` is the ONLY key set. `include` / `exclude` are deliberately
 * left at the defaults: a hand-written `include` is how a new config silently
 * drops test files, and the default set spans BOTH `src/__tests__/` (118
 * files) and `dashboard/src/**\/__tests__/` (22 files) — 140 files, 3151 tests
 * measured at e908493 before this file existed. BR-106 itself adds 2 files /
 * 32 tests (the guard and the witness), so the post-BR-106 figure is 142 /
 * 3183. That is the abort check: BELOW it means this config narrowed the
 * suite and must be reverted. Above it is ordinary growth.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
  },
});
