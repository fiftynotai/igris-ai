/**
 * Pre-flight checks for state-changing verbs.
 *
 * What we verify:
 *
 *   1. Node version 20+. Older Node misses APIs (fs.cpSync, AbortController).
 *      `engines.node` in package.json is advisory; this is the fail-fast guard.
 *   2. Network reachability. HEAD `https://api.github.com/`. 5s timeout.
 *      Suppressed when `--from-source` or `--skip-remote` is set.
 *   3. Existing `~/.igris/` shape. Distinguishes:
 *        - "absent"      — no `~/.igris/` at all (fresh init).
 *        - "v6"          — has `core/` but no `.install-source.json` (legacy).
 *        - "v7"          — has `core/` AND `.install-source.json`.
 *        - "interrupted" — has orphaned `core.new.<pid>` or `core.bak.<ts>` siblings.
 *
 * The verb layer reads the result and decides whether to error
 * ("--upgrade required for v6 to v7") or proceed ("fresh init OK").
 */

import { existsSync, readdirSync } from "node:fs";
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
  | { kind: "v6"; corePath: string }
  | { kind: "v7"; corePath: string; installSourcePath: string }
  | { kind: "interrupted"; orphans: string[] };

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
 * Inspect ~/.igris/ (or IGRIS_BRAIN_DIR override). Returns one of:
 *   - absent       — no brain dir at all
 *   - v6           — legacy install (no .install-source.json)
 *   - v7           — current install (has .install-source.json)
 *   - interrupted  — has orphaned `core.new.<pid>` or `core.bak.<ts>` entries
 */
export function detectInstallShape(): IgrisInstallShape {
  const root = brainDir();
  if (!existsSync(root)) {
    return { kind: "absent" };
  }

  // First detect interrupted orphans — they take precedence over
  // v6/v7 because the staging dirs indicate an in-progress operation.
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return { kind: "absent" };
  }
  const orphans = entries.filter(
    (e) => e.startsWith("core.new.") || e.startsWith("core.bak."),
  );
  if (orphans.length > 0) {
    return {
      kind: "interrupted",
      orphans: orphans.map((e) => join(root, e)),
    };
  }

  const corePath = join(root, "core");
  const isPath = installSourcePath();
  const hasCore = existsSync(corePath);
  const hasInstallSource = existsSync(isPath);

  if (!hasCore) {
    return { kind: "absent" };
  }
  if (hasInstallSource) {
    return { kind: "v7", corePath, installSourcePath: isPath };
  }
  return { kind: "v6", corePath };
}
