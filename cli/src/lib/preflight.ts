/**
 * Pre-flight checks for state-changing verbs.
 *
 * What we verify:
 *
 *   1. Node version 20+. Older Node misses APIs (fs.cpSync, AbortController).
 *      `engines.node` in package.json is advisory; this is the fail-fast guard.
 *   2. Network reachability. HEAD `https://api.github.com/`. 5s timeout.
 *      Suppressed when `--from-source` or `--skip-remote` is set, or when the
 *      recorded install source is a local checkout (BR-103).
 *   3. Existing `~/.igris/` shape. Distinguishes:
 *        - "absent"               — no `~/.igris/` or no `core/` (fresh init).
 *        - "v6"                   — has `core/` but no `.install-source.json`.
 *        - "v7"                   — has `core/` AND `.install-source.json`.
 *        - "interrupted-staging"  — a `core.new.<pid>` staging dir is present:
 *                                   a swap that never finished staging. The
 *                                   verb REFUSES (or removes it under
 *                                   `--wipe-orphans`).
 *        - "interrupted-swap"     — a `core.bak.<ts>` is present and `core/`
 *                                   is ABSENT: a swap that died between its two
 *                                   renames. The verb REFUSES with the restore
 *                                   command; it never auto-restores.
 *
 *      A `core.bak.<ts>` beside a HEALTHY `core/` is the normal post-upgrade
 *      state — `atomicSwap` keeps exactly one for recovery — so it is listed
 *      (`retainedBaks`) on the v6/v7 shapes, not flagged. Before BR-103 any
 *      bak read as "interrupted": every second upgrade printed a false error
 *      that `init` then ignored (2026-09-07 incident, defect c).
 *
 * The verb layer reads the result and decides whether to error
 * ("--upgrade required for v6 to v7") or proceed ("fresh init OK").
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { brainDir } from "./paths.js";
import { installSourcePath } from "./paths.js";

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

export type IgrisInstallShape =
  | { kind: "absent" }
  | { kind: "v6"; corePath: string; retainedBaks: string[] }
  | {
      kind: "v7";
      corePath: string;
      installSourcePath: string;
      retainedBaks: string[];
    }
  | { kind: "interrupted-staging"; residue: string[]; retainedBaks: string[] }
  | { kind: "interrupted-swap"; baks: string[] };

/**
 * Check Node major version. Throws if < 20.
 */
export function checkNodeVersion(): void {
  const v = process.versions.node;
  const major = parseInt(v.split(".")[0], 10);
  if (isNaN(major) || major < 20) {
    throw new PreflightError(
      `Node ${v} is too old; Igris requires Node 20 or newer. Install a newer Node (e.g. via nvm) and re-run.`,
    );
  }
}

export interface NetworkCheckOptions {
  /** Skip the check entirely (used by --from-source / --skip-remote / tests). */
  skip?: boolean;
  /** Override the URL probed (test seam). Default: api.github.com root. */
  url?: string;
  /** Override timeout (default 5s). */
  timeoutMs?: number;
}

/**
 * Issue a HEAD request to GitHub's API root. Returns the HTTP status
 * code. Throws PreflightError on transport failure (DNS, connection
 * refused, timeout). Skip flag short-circuits to a synthetic 200.
 */
export async function checkNetwork(
  opts: NetworkCheckOptions = {},
): Promise<number> {
  if (opts.skip === true) return 200;
  const url = opts.url ?? "https://api.github.com/";
  const timeoutMs = opts.timeoutMs ?? 5_000;
  return new Promise<number>((resolveP, rejectP) => {
    const req = httpsRequest(
      url,
      {
        method: "HEAD",
        headers: { "User-Agent": "igris-ai-cli" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        resolveP(status);
      },
    );
    req.on("error", (err) => {
      rejectP(
        new PreflightError(
          `network unreachable (${url}): ${err.message}. Pass --from-source or --skip-remote to bypass.`,
        ),
      );
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new PreflightError(
          `network check timed out after ${timeoutMs}ms (${url}). Pass --from-source or --skip-remote to bypass.`,
        ),
      );
    });
    req.end();
  });
}

/**
 * Inspect ~/.igris/ (or IGRIS_BRAIN_DIR override). See the header for the
 * five shapes. Sibling lists are sorted, so the LAST `core.bak.*` is the
 * newest (the timestamp is ISO-8601, which sorts lexically).
 */
export function detectInstallShape(): IgrisInstallShape {
  const root = brainDir();
  if (!existsSync(root)) {
    return { kind: "absent" };
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return { kind: "absent" };
  }
  const residue = entries
    .filter((e) => e.startsWith("core.new."))
    .sort()
    .map((e) => join(root, e));
  const baks = entries
    .filter((e) => e.startsWith("core.bak."))
    .sort()
    .map((e) => join(root, e));

  // Staging residue is the one actionable fact whatever else is present.
  if (residue.length > 0) {
    return { kind: "interrupted-staging", residue, retainedBaks: baks };
  }

  const corePath = join(root, "core");
  const isPath = installSourcePath();
  const hasCore = existsSync(corePath);
  const hasInstallSource = existsSync(isPath);

  if (!hasCore) {
    // A bak with no core/ is a swap that died between its two renames.
    if (baks.length > 0) return { kind: "interrupted-swap", baks };
    return { kind: "absent" };
  }
  if (hasInstallSource) {
    return { kind: "v7", corePath, installSourcePath: isPath, retainedBaks: baks };
  }
  return { kind: "v6", corePath, retainedBaks: baks };
}

export type InterruptedShapeVerdict =
  | { verdict: "proceed"; retainedBaks: string[] }
  | { verdict: "wiped"; removed: string[] }
  | { verdict: "refuse"; message: string };

/**
 * The ONE interrupted-shape policy `init --upgrade` and `refresh` share
 * (BR-103): `interrupted-swap` always refuses with the restore command
 * (the bak IS the recovery — a verb must never delete or auto-promote it);
 * `interrupted-staging` refuses unless `wipeOrphans`, which removes ONLY the
 * `core.new.*` residue and never a `core.bak.*`. Every other shape proceeds
 * with its retained baks listed for the caller's debug line.
 */
export function resolveInterruptedShape(
  shape: IgrisInstallShape,
  opts: { wipeOrphans: boolean },
): InterruptedShapeVerdict {
  const root = brainDir();
  if (shape.kind === "interrupted-swap") {
    const newest = shape.baks[shape.baks.length - 1];
    return {
      verdict: "refuse",
      message:
        `Detected interrupted state at ${root}: core/ is ABSENT and a backup is present ` +
        `(${shape.baks.map((b) => `'${b}'`).join(", ")}) — a swap died between its two renames. ` +
        `Restore it yourself, then re-run: mv ${newest} ${join(root, "core")}. Nothing was written.`,
    };
  }
  if (shape.kind === "interrupted-staging") {
    if (!opts.wipeOrphans) {
      return {
        verdict: "refuse",
        message:
          `Detected interrupted state at ${root}: staging residue ` +
          `${shape.residue.map((r) => `'${r}'`).join(", ")} from a run that did not finish. ` +
          `Re-run with --wipe-orphans to remove the residue (a core.bak.* backup is never touched), ` +
          `or remove it yourself. Nothing was written.`,
      };
    }
    for (const r of shape.residue) {
      rmSync(r, { recursive: true, force: true });
    }
    // Residue is reported ahead of everything else, so it can MASK a swap
    // that also died (core/ absent, core.bak.* present). Re-read the tree the
    // wipe uncovered and apply the swap rule to it — the bak is still the
    // recovery, and a verb must not proceed to atomicSwap past it (warden,
    // BR-103 round 1).
    const uncovered = resolveInterruptedShape(detectInstallShape(), { wipeOrphans: false });
    if (uncovered.verdict === "refuse") {
      return {
        verdict: "refuse",
        message:
          `Removed staging residue ${shape.residue.map((r) => `'${r}'`).join(", ")} (--wipe-orphans). ` +
          uncovered.message.replace(/Nothing was written\.$/, "Nothing else was written."),
      };
    }
    return { verdict: "wiped", removed: shape.residue };
  }
  return {
    verdict: "proceed",
    retainedBaks: shape.kind === "absent" ? [] : shape.retainedBaks,
  };
}
