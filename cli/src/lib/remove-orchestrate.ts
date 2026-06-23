/**
 * FR-203: the shared "un-project + verify-ABSENT" engine for
 * `igris remove <surface>` — the SYMMETRIC INVERSE of `lib/add-orchestrate.ts`.
 *
 * This is the TD-235 chokepoint, INVERTED. Every surface arm of `remove`
 * (skill/agent/mcp/hook), after de-materializing from the registry/overlay
 * (personal) or `core/` (core), funnels its un-projection through
 * `unprojectAndVerify`. That function:
 *
 *   1. UN-PROJECTS the surface from each (or one `--harness`) target — deleting
 *      the registry-anchored symlink (skill/agent) / un-merging the named native
 *      config block (mcp/hook) — collecting a `deprojected[]` of the targets it
 *      actually removed; then
 *   2. VERIFIES ABSENT: runs `harness check --surface <s> --filter <name>` via
 *      `runHarnessStructured` and asserts the surface is GONE.
 *
 * ── THE ONE PLACE THE ADD/REMOVE SYMMETRY FLIPS (empty-match inversion) ──
 * For `add`, `noTargetsMatched` (a 0-projected compile) is the silent-no-op BUG
 * (`add-orchestrate.ts:151`). For `remove`, after a successful removal the
 * store no longer declares the surface, so `harness check --filter <name>`
 * LEGITIMATELY matches nothing → `noTargetsMatched: true` is the ABSENT verdict =
 * SUCCESS. A FAIL/DRIFTED row meaning the surface is still PRESENT in some
 * harness means un-projection MISSED a target → LOUD FAIL.
 *
 * The no-phantom-success gate therefore keys NOT on the check's empty-match (a
 * post-removal empty check is success) but on `deprojected.length === 0 &&
 * nothingDeletedFromStore` — surfaced to the dispatcher (`verbs/remove.ts`),
 * which owns the "nothing to remove → already absent?" loud fail. This file
 * owns the un-projection + ABSENT-verify; the dispatcher owns the
 * nothing-to-remove verdict (it knows whether the store changed).
 *
 * This file owns NO surface-specific knowledge beyond the per-harness un-project
 * dispatch table — it takes the surface name + the target list + an
 * un-projector callback and drives the §18.1 drift contract in reverse. The
 * de-materialize half lives in `registry.ts` (personal) / `remove-core.ts`
 * (core); the dispatch lives in `verbs/remove.ts`.
 */

import {
  runHarnessStructured,
  type HarnessStructuredResult,
  type AdapterCaptureFn,
} from "../verbs/harness.js";
import type { ProjectionSurface } from "./add-orchestrate.js";

/**
 * FR-203: a single un-projection target the dispatcher wants removed. `harness`
 * is the target type; `label` is the `<harness>:<path|name>` identifier echoed
 * into `deprojected[]` for the operator's audit. `run` performs the actual
 * removal (delete-symlink / un-merge-config) and returns true iff something was
 * removed (idempotent: an already-absent target returns false, NOT an error).
 */
export interface UnprojectTarget {
  harness: string;
  label: string;
  /** Returns true iff a target actually existed and was removed. */
  run: () => boolean;
}

/** Structured outcome of a one-surface un-project + verify-ABSENT run. */
export interface UnprojectAndVerifyResult {
  /** True iff every un-project ran AND the ABSENT-verify saw the surface gone. */
  ok: boolean;
  /** `<harness>:<path|name>` targets actually removed (for the operator audit). */
  deprojected: string[];
  /** FAIL/DRIFTED rows from the ABSENT-verify (surface still PRESENT). */
  stillPresent: string[];
  /** Human-readable reason when `ok` is false. Empty on success. */
  reason: string;
  /** Raw check result, or undefined when the check could not run. */
  check?: HarnessStructuredResult;
}

/** Options for one un-project + verify-ABSENT run. */
export interface UnprojectAndVerifyOptions {
  /** The surface to un-project + ABSENT-verify. */
  surface: ProjectionSurface;
  /** The just-removed surface name (the `--filter` scoping the ABSENT-verify). */
  name: string;
  /** Per-harness un-projection targets the dispatcher resolved. */
  targets: UnprojectTarget[];
  /** Project root the ABSENT-verify resolves against (drift `--project-root`). */
  projectRoot: string;
  /**
   * D5 parity: assert the run EXPECTS core surfaces (core mode). Forwarded to
   * the ABSENT-verify so a core check resolves the core manifest. Personal
   * removes leave this false.
   */
  expectCore?: boolean;
  /** Restrict to one target type (claude|codex|gemini|opencode|antigravity). */
  target?: string;
  /** Explicit overlay-manifest override (personal path). */
  overlay?: string;
  /** Explicit base-manifest override (core path / repo root). */
  manifest?: string;
  /** Test seam: brain root override (defaults to brainDir()). */
  brainRoot?: string;
  /** Test seam: capturing adapter runner forwarded to the ABSENT-verify check. */
  captureAdapter?: AdapterCaptureFn;
}

/**
 * Un-project one surface from all (or one) harness then verify it is ABSENT
 * (drift sees the surface GONE). Returns a structured verdict; NEVER throws on a
 * harness failure (the failure is encoded in `ok` + `reason`). The dispatcher
 * maps `ok:false` to a non-zero exit + the actionable `reason`.
 */
export async function unprojectAndVerify(
  opts: UnprojectAndVerifyOptions,
): Promise<UnprojectAndVerifyResult> {
  // --- 1. Un-project each target (idempotent). -----------------------------
  // A `--harness` scope filters the target list to the one harness; otherwise
  // every resolved target is un-projected.
  const scoped =
    opts.target !== undefined && opts.target.length > 0
      ? opts.targets.filter((t) => t.harness === opts.target)
      : opts.targets;

  const deprojected: string[] = [];
  for (const t of scoped) {
    let removed = false;
    try {
      removed = t.run();
    } catch (err) {
      return {
        ok: false,
        deprojected,
        stillPresent: [],
        reason:
          `un-projection of ${opts.surface} '${opts.name}' from ${t.label} ` +
          `failed: ${(err as Error).message}`,
      };
    }
    if (removed) {
      deprojected.push(t.label);
    }
  }

  // --- 2. Verify ABSENT: drift-check the same surface, scoped by name. ------
  // After a successful removal the store no longer declares the surface, so the
  // check legitimately matches NOTHING for that name (noTargetsMatched) — that
  // is the ABSENT verdict for remove (the empty-match inversion vs `add`).
  const check = await runHarnessStructured({
    action: "check",
    surface: opts.surface,
    projectRoot: opts.projectRoot,
    expectCore: opts.expectCore,
    filter: opts.name,
    overlay: opts.overlay,
    manifest: opts.manifest,
    brainRoot: opts.brainRoot,
    captureAdapter: opts.captureAdapter,
  });

  const scopedLabel = `${opts.surface} '${opts.name}'`;

  // A non-zero check exit OR a FAIL row means the drift pass found the surface
  // still declared/present somewhere — un-projection missed a target → LOUD.
  if (check.code !== 0) {
    return {
      ok: false,
      deprojected,
      stillPresent: check.failRows,
      reason:
        check.failRows.length > 0
          ? `verify-ABSENT failed for ${scopedLabel} (surface still present): ${check.failRows.join("; ")}`
          : `verify-ABSENT (drift check) exited ${check.code} for ${scopedLabel}`,
      check,
    };
  }
  if (check.failRows.length > 0) {
    return {
      ok: false,
      deprojected,
      stillPresent: check.failRows,
      reason: `verify-ABSENT failed for ${scopedLabel} (surface still present): ${check.failRows.join("; ")}`,
      check,
    };
  }

  // Exit-0, no FAIL rows → the surface is GONE (noTargetsMatched OR all-in-sync
  // with nothing left to reconcile). For remove this is SUCCESS, NOT the bug.
  return {
    ok: true,
    deprojected,
    stillPresent: [],
    reason: "",
    check,
  };
}
