/**
 * FR-180: the shared "project + verify" engine for `igris add <surface>`.
 *
 * This is the TD-235 chokepoint. Every surface arm of `add` (skill/agent/mcp/
 * hook/identity), after materializing into the registry/overlay (personal) or
 * `core/` (core), funnels its projection through `projectAndVerify`. That
 * function:
 *
 *   1. runs `harness compile --surface <s>` (the deliver half), then
 *   2. runs `harness check   --surface <s>` (the drift-verify half),
 *
 * both via `runHarnessStructured` so the adapter's per-row OK/FAIL + the
 * "0 targets matched" empty-match condition are machine-readable, NOT just an
 * exit code. A no-op (0 projected) OR a FAIL row OR a non-zero adapter exit is
 * converted into a LOUD failure — so the one-step `add` path can never silently
 * no-op (the core defect TD-235 closes). See FR-180-plan §Phase 0 + D5.
 *
 * This file owns NO surface-specific knowledge — it takes a surface name + the
 * resolved project root and drives the §18.1 deliver+drift contract. The
 * materialize half lives in `registry.ts` (personal) / `add-core.ts` (core);
 * the dispatch lives in `verbs/add.ts`.
 */

import {
  runHarnessStructured,
  type HarnessStructuredResult,
  type AdapterCaptureFn,
} from "../verbs/harness.js";

/**
 * The `--surface` values the harness adapters project. NOTE for the Phase-2
 * implementer: these are the COMPILE/CHECK surface names, which differ from the
 * `AddSurface` arm names in `verbs/add.ts` — the skill arm maps `skill →
 * "skills"`, the agent arm maps `agent → "agents"`; `mcp` and `identity` are
 * 1:1. The add arm is responsible for that singular→adapter mapping before
 * calling `projectAndVerify`.
 *
 * FR-180 Phase 5 (D7 — Option B): `"hook"` is now a real `--surface` projection
 * target — hooks ride the same flatten→compile→drift scaffold as the other four
 * surfaces. The hook arm maps `hook → "hook"` (1:1, like mcp/identity).
 */
export type ProjectionSurface = "skills" | "agents" | "mcp" | "identity" | "hook";

/** Structured outcome of a one-surface project+verify run. */
export interface ProjectAndVerifyResult {
  /** True iff compile projected ≥1 target AND check found no drift AND no FAIL rows. */
  ok: boolean;
  /** OK summary rows the compile pass emitted (verbatim). */
  projected: string[];
  /** FAIL summary rows from compile or check (verbatim). */
  failed: string[];
  /**
   * The visible `SKIPPED core surfaces (personal-project compile)` line, if
   * the adapter emitted it (D5 incidental-skip path). Present here so the
   * caller can surface it; its presence alone is NOT a failure.
   */
  coreSkipped: string[];
  /**
   * Human-readable reason when `ok` is false. Always set on failure so the
   * caller (add.ts) can print one actionable line. Empty on success.
   */
  reason: string;
  /** Raw compile result (for advanced callers / tests). */
  compile: HarnessStructuredResult;
  /** Raw check result, or undefined when compile failed before check ran. */
  check?: HarnessStructuredResult;
}

/** Options for one project+verify run. */
export interface ProjectAndVerifyOptions {
  /** The surface to compile + check. */
  surface: ProjectionSurface;
  /** Project root the adapters resolve target paths against. */
  projectRoot: string;
  /**
   * D5: assert the run EXPECTS core surfaces (core mode, or routed from an
   * explicit add). Makes an ownership-gate core-skip a LOUD failure. Personal
   * adds leave this false (their surfaces project from the overlay, which the
   * gate never skips).
   */
  expectCore?: boolean;
  /** Restrict to one target type (claude|codex|gemini|opencode). Default: all. */
  target?: string;
  /**
   * Name glob scoping BOTH the compile and the check passes (S1). The add arm
   * passes the just-added surface NAME here so the VERIFY half (`harness check`,
   * which has no `--surface` flag) re-checks ONLY the added surface — not the
   * whole project. Without this, any pre-existing unrelated drift would make a
   * clean `add` false-fail. Default: all.
   */
  filter?: string;
  /** Explicit overlay-manifest override (personal path). */
  overlay?: string;
  /** Explicit base-manifest override (core path / repo root). */
  manifest?: string;
  /** Test seam: brain root override (defaults to brainDir()). */
  brainRoot?: string;
  /**
   * Test seam: capturing adapter runner. Forwarded to both the compile and
   * check calls so a test can mock the whole project+verify chain without
   * spawning a shell. When set, the SAME fn handles both calls — tests
   * dispatch on the script path / args to vary compile-vs-check output.
   */
  captureAdapter?: AdapterCaptureFn;
}

/**
 * Project one surface to all (or one) harness then verify it drifted-clean.
 * Returns a structured verdict; NEVER throws on an adapter failure (the failure
 * is encoded in `ok` + `reason`). The caller maps `ok:false` to a non-zero
 * exit + the actionable `reason`.
 */
export async function projectAndVerify(
  opts: ProjectAndVerifyOptions,
): Promise<ProjectAndVerifyResult> {
  // --- 1. Deliver: compile the single surface. -----------------------------
  const compile = await runHarnessStructured({
    action: "compile",
    surface: opts.surface,
    projectRoot: opts.projectRoot,
    expectCore: opts.expectCore,
    target: opts.target,
    filter: opts.filter,
    overlay: opts.overlay,
    manifest: opts.manifest,
    brainRoot: opts.brainRoot,
    captureAdapter: opts.captureAdapter,
  });

  const coreSkipped =
    compile.skippedCoreLine !== undefined ? [compile.skippedCoreLine] : [];

  // A non-zero compile exit is always a failure. Under --expect-core the
  // adapter turns an ownership-gate skip into exit-1 + a FAIL row; that lands
  // here with an actionable message already in `output`.
  if (compile.code !== 0) {
    return {
      ok: false,
      projected: compile.okRows,
      failed: compile.failRows,
      coreSkipped,
      reason:
        compile.failRows.length > 0
          ? `compile failed: ${compile.failRows.join("; ")}`
          : `compile exited ${compile.code} for surface '${opts.surface}'`,
      compile,
    };
  }

  // Exit-0 but ZERO projected targets is the TD-235 silent-no-op. Convert to a
  // LOUD failure — the add path requested a projection and got nothing.
  if (compile.noTargetsMatched || compile.okRows.length === 0) {
    return {
      ok: false,
      projected: [],
      failed: compile.failRows,
      coreSkipped,
      reason:
        `compile projected 0 '${opts.surface}' targets for project-root ` +
        `'${opts.projectRoot}'. Nothing was added. ` +
        (coreSkipped.length > 0
          ? coreSkipped.join(" ")
          : "Check the surface name and that the materialize step wrote the overlay/core file."),
      compile,
    };
  }

  // --- 2. Verify: drift-check the same surface. ----------------------------
  // S1: scope BOTH the SURFACE and the NAME of the verify.
  //   - `--surface opts.surface` (FR-180 cross-phase) restricts the drift check
  //     to the ONE surface we just projected. Without it, the check re-checks
  //     EVERY surface — and a core `add` projects against the runtime BRAIN ROOT
  //     (so the ownership gate passes), under which the os_identity surface
  //     drifts (its {{IGRIS_VERSION}} resolves from `cli/package.json`, absent
  //     there). That unrelated drift would false-fail a clean skill/agent/mcp
  //     add. The compile half already projects only `opts.surface`; the check
  //     now matches.
  //   - `--filter opts.filter` (the just-added surface NAME) scopes WITHIN the
  //     surface so a pre-existing unrelated drift in the SAME surface can't
  //     false-fail either.
  const check = await runHarnessStructured({
    action: "check",
    surface: opts.surface,
    projectRoot: opts.projectRoot,
    expectCore: opts.expectCore,
    filter: opts.filter,
    overlay: opts.overlay,
    manifest: opts.manifest,
    brainRoot: opts.brainRoot,
    captureAdapter: opts.captureAdapter,
  });

  // Identify the added surface for the (now-scoped) failure message.
  const scopedLabel =
    opts.filter !== undefined && opts.filter.length > 0
      ? `${opts.surface} '${opts.filter}'`
      : opts.surface;

  if (check.code !== 0) {
    return {
      ok: false,
      projected: compile.okRows,
      failed: check.failRows,
      coreSkipped,
      reason:
        check.failRows.length > 0
          ? `verify (drift check) failed for ${scopedLabel}: ${check.failRows.join("; ")}`
          : `verify (drift check) exited ${check.code} for ${scopedLabel}`,
      compile,
      check,
    };
  }

  return {
    ok: true,
    projected: compile.okRows,
    failed: [],
    coreSkipped,
    reason: "",
    compile,
    check,
  };
}
