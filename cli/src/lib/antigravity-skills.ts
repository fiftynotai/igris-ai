/**
 * FR-179 Phase C (R2): create-or-repair the Antigravity skills PARENT symlink.
 *
 * R2 RESOLVED (2026-06-11, live `agy` test): antigravity natively loads skills
 * from `~/.gemini/antigravity-cli/skills/` (it listed awaken/hunt/scan citing
 * that exact path), but it does NOT self-create the
 * `antigravity-cli/skills → ~/.agents/skills` symlink — removing it and
 * relaunching `agy` did not recreate it. So `igris install` must create it.
 *
 * We DELIBERATELY symlink the PARENT dir (not per-item links INTO
 * `antigravity-cli/skills`) so ONE link covers every current + future skill —
 * the future `igris add skill` loop lands items in `~/.agents/skills` (via the
 * existing `agents/symlink` surface target) and they appear through this link
 * with zero antigravity-specific work, and there is no per-add compile/drift
 * branch to maintain.
 *
 * `linkAntigravitySkills()` is idempotent-repair and NEVER throws — it folds
 * every failure into a `{ outcome: "failed", error }` result the caller
 * warn-and-continues on (mirrors `registerBrainAcrossHarnesses`). The repair
 * is also the `igris doctor --fix` for the `antigravity-skills-link` drift
 * class.
 *
 * Atomicity: a create/repoint stages the new symlink at a `.tmp-<pid>` sibling
 * then `renameSync(tmp, link)` — `node:fs.renameSync` calls `rename(2)`
 * directly, which on BSD/Linux correctly REPLACES an existing symlink (unlike
 * the shell `mv`, which follows a symlink target on macOS — see the bash
 * `atomic_symlink` note in compile_harnesses.sh).
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { antigravitySkillsLinkPath, agentsSkillsDirPath } from "./paths.js";

/**
 * Outcome of a `linkAntigravitySkills()` run.
 *  - "created"   : the link was absent and is now in place (+ parent dirs).
 *  - "unchanged" : the link already pointed at the target (idempotent no-op).
 *  - "repointed" : a symlink pointed elsewhere / a real EMPTY dir was here and
 *                  has been atomically replaced with the correct link.
 *  - "refused"   : a real NON-EMPTY dir is in the way — never clobbered;
 *                  `error` carries an actionable message.
 *  - "failed"    : an unexpected fs error; `error` carries the message.
 */
export interface AntigravitySkillsLinkResult {
  outcome: "created" | "unchanged" | "repointed" | "refused" | "failed";
  /** The link path operated on (`~/.gemini/antigravity-cli/skills`). */
  linkPath: string;
  /** The intended symlink target (`~/.agents/skills`). */
  target: string;
  /** Set for "refused"/"failed" — never references file CONTENT, just paths. */
  error?: string;
}

/**
 * Create-or-repair `~/.gemini/antigravity-cli/skills → ~/.agents/skills`.
 *
 * Test seam: `opts.linkPath` / `opts.target` override the real-HOME paths so
 * tests drive every case in a sandbox HOME without touching the dev machine's
 * real symlink (which is already correct → a real-HOME run is "unchanged").
 *
 * NEVER throws. The five cases (FR-179 plan §C2):
 *   1. target dir missing            → mkdir -p the target first.
 *   2. link absent                   → create (+ mkdir -p the link's parent).
 *   3. correct symlink already there → "unchanged" (idempotent).
 *   4. symlink pointing elsewhere    → atomic repoint → "repointed".
 *   5a. real EMPTY dir               → remove + symlink → "repointed".
 *   5b. real NON-EMPTY dir           → "refused" (never delete user content).
 */
export function linkAntigravitySkills(opts?: {
  linkPath?: string;
  target?: string;
}): AntigravitySkillsLinkResult {
  const linkPath = opts?.linkPath ?? antigravitySkillsLinkPath();
  const target = opts?.target ?? agentsSkillsDirPath();

  try {
    // Case 1: ensure the symlink TARGET exists. antigravity resolves through
    // the link to this dir; skill items are projected here by the agents/
    // symlink surface target. A missing target would make the link dangling.
    if (!existsSync(target)) {
      mkdirSync(target, { recursive: true });
    }

    // Inspect the LINK itself (lstat — never follow).
    let lst;
    try {
      lst = lstatSync(linkPath);
    } catch {
      // Case 2: nothing at the link path → create it (+ parent dir).
      mkdirSync(dirname(linkPath), { recursive: true });
      atomicSymlink(target, linkPath);
      return { outcome: "created", linkPath, target };
    }

    if (lst.isSymbolicLink()) {
      let current: string;
      try {
        current = readlinkSync(linkPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          outcome: "failed",
          linkPath,
          target,
          error: `${linkPath} is a symlink but readlink failed: ${msg}`,
        };
      }
      // Case 3: already correct → idempotent no-op.
      if (current === target) {
        return { outcome: "unchanged", linkPath, target };
      }
      // Case 4: symlink to the wrong place → atomic repoint.
      atomicSymlink(target, linkPath);
      return { outcome: "repointed", linkPath, target };
    }

    if (lst.isDirectory()) {
      // A REAL dir (an `agy` refresh may recreate `antigravity-cli/skills` as a
      // real dir, shadowing our link). Replace ONLY if it is empty.
      let entries: string[];
      try {
        entries = readdirSync(linkPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          outcome: "failed",
          linkPath,
          target,
          error: `could not read real dir ${linkPath}: ${msg}`,
        };
      }
      if (entries.length === 0) {
        // Case 5a: empty real dir → remove + symlink. `recursive` is required
        // for rmSync on a directory (it would throw EISDIR otherwise); the dir
        // is verified EMPTY above, so recursive removal loses nothing.
        rmSync(linkPath, { recursive: true, force: true });
        atomicSymlink(target, linkPath);
        return { outcome: "repointed", linkPath, target };
      }
      // Case 5b: NON-empty real dir → refuse-to-clobber (never delete content).
      return {
        outcome: "refused",
        linkPath,
        target,
        error:
          `${linkPath} is a real non-empty directory — refusing to replace it ` +
          `with a symlink (would risk antigravity/user skill content). Move or ` +
          `merge its contents into ${target}, remove the empty dir, then re-run.`,
      };
    }

    // A real file (not a dir, not a symlink) — refuse.
    return {
      outcome: "refused",
      linkPath,
      target,
      error:
        `${linkPath} exists as a real file (not a directory or symlink) — ` +
        `refusing to overwrite. Remove it manually, then re-run.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { outcome: "failed", linkPath, target, error: msg };
  }
}

/**
 * Does the live link resolve to `target`? Used by the `antigravity-skills-link`
 * doctor drift detector (the read-only check; the repair is
 * `linkAntigravitySkills`). Returns false for absent / wrong-target / real-dir.
 */
export function antigravitySkillsLinkOk(opts?: {
  linkPath?: string;
  target?: string;
}): boolean {
  const linkPath = opts?.linkPath ?? antigravitySkillsLinkPath();
  const target = opts?.target ?? agentsSkillsDirPath();
  let lst;
  try {
    lst = lstatSync(linkPath);
  } catch {
    return false;
  }
  if (!lst.isSymbolicLink()) return false;
  try {
    return readlinkSync(linkPath) === target;
  } catch {
    return false;
  }
}

/**
 * Atomically create-or-replace the symlink at `link` pointing to `target`.
 * Stages at a `.tmp-<pid>` sibling then `renameSync` (rename(2) — replaces an
 * existing symlink correctly on BSD/Linux; never follows it like shell `mv`).
 * Discards any stale temp first so a prior-interrupted run cannot block this.
 */
function atomicSymlink(target: string, link: string): void {
  const tmp = `${link}.tmp-${process.pid}`;
  try {
    unlinkSync(tmp);
  } catch {
    // No stale temp — fine.
  }
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}
