/**
 * canonical-root.ts — TD-406: the containment seam for CANONICAL writes.
 *
 * `IGRIS_BRAIN_DIR` contains every RUNTIME write (`paths.ts#brainDir`), which is
 * why the suites can exercise the install verbs without touching `~/.igris/`.
 * Writes aimed at a repo CHECKOUT had no such seam: `applyPersona` resolved its
 * canonical target from a `process.cwd()` default and overwrote the tracked
 * `core/SOUL.md` of whatever checkout the process happened to be standing in.
 *
 * This module supplies the missing half. `IGRIS_REPO_DIR` declares the ONLY
 * directory subtree a canonical write may land in; under a detected test context
 * an undeclared target is REFUSED rather than allowed (fail closed), so a test
 * that never heard of this seam is contained anyway.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Why a canonical write was refused. */
export type CanonicalRootRefusal =
  /** Test context, and no `IGRIS_REPO_DIR` declared the permitted subtree. */
  | "test_context_undeclared"
  /** `IGRIS_REPO_DIR` is declared and the target resolves outside it. */
  | "outside_declared_root";

export type CanonicalRootDecision =
  | { allowed: true; root: string }
  | { allowed: false; reason: CanonicalRootRefusal; declaredRoot: string | null };

/**
 * The declared canonical-write subtree (`IGRIS_REPO_DIR`), or null when unset.
 * Resolved the same way `brainDir()` resolves `IGRIS_BRAIN_DIR`.
 */
export function declaredCanonicalRoot(): string | null {
  const env = process.env.IGRIS_REPO_DIR;
  return env !== undefined && env.length > 0 ? resolve(env) : null;
}

/**
 * True under a test runner. Vitest sets BOTH `VITEST=true` and `NODE_ENV=test`
 * in every worker (measured); either alone is enough, so a non-vitest runner
 * that only sets `NODE_ENV=test` is contained too.
 */
export function isTestContext(): boolean {
  const vitest = process.env.VITEST;
  if (vitest !== undefined && vitest !== "" && vitest !== "false") return true;
  return process.env.NODE_ENV === "test";
}

/**
 * Normalize `p` by realpath'ing its longest EXISTING prefix and re-appending the
 * rest verbatim.
 *
 * Realpath is load-bearing on darwin, where a root staged under `tmpdir()`
 * (`/var/folders/...`) and its real path (`/private/var/folders/...`) are one
 * directory under two names. Walking up to the existing prefix is what makes the
 * normalization SYMMETRIC: a plain `realpathSync`-or-`resolve` returns the
 * `/private` form for a declared root that exists and the `/var` form for a
 * target inside it that does not exist yet, and the comparison then rejects a
 * path that is plainly a descendant.
 */
function normalize(p: string): string {
  const abs = resolve(p);
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs; // hit the filesystem root; nothing exists
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/** True when `target` is `container` itself or a descendant of it. */
function isWithin(container: string, target: string): boolean {
  const c = normalize(container);
  const t = normalize(target);
  if (c === t) return true;
  const rel = relative(c, t);
  // A segment-aware test: `relative()` of a sibling whose path merely shares a
  // string prefix (`/a/root` vs `/a/root-evil`) starts with `..`.
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Decide whether a canonical write rooted at `repoRoot` may proceed.
 *
 * 1. `IGRIS_REPO_DIR` declared → allow only targets inside it.
 * 2. Otherwise, a test context → REFUSE (fail closed).
 * 3. Otherwise (production) → allow.
 */
export function resolveCanonicalRoot(repoRoot: string): CanonicalRootDecision {
  const declared = declaredCanonicalRoot();
  if (declared !== null) {
    return isWithin(declared, repoRoot)
      ? { allowed: true, root: repoRoot }
      : { allowed: false, reason: "outside_declared_root", declaredRoot: declared };
  }
  if (isTestContext()) {
    return {
      allowed: false,
      reason: "test_context_undeclared",
      declaredRoot: null,
    };
  }
  return { allowed: true, root: repoRoot };
}
