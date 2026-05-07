/**
 * `igris update --self` — global self-upgrade primitive.
 *
 * Invokes `npm install -g igris-ai@latest` via `child_process.execFile`, with
 * stdio inherited so the user sees npm's progress live. Returns the npm exit
 * code so the caller in `verbs/update.ts` can propagate it as the CLI exit
 * code.
 *
 * Design notes:
 *   - We use `execFile` (not `exec`) so npm's args are passed as an array; no
 *     shell quoting drama for the package spec.
 *   - stdio: "inherit" so npm's progress bar / fetch logs render live to the
 *     user's terminal. This also means npm's stderr surfaces verbatim on
 *     failure (the AC requirement: "actionable message").
 *   - npm-not-on-PATH manifests as ENOENT from execFile; we surface that as
 *     a distinct, actionable error rather than a cryptic exit code.
 *   - We do NOT attempt to detect whether the current install is from a
 *     tarball / linked / source — that's the user's problem. `--self` is
 *     intentionally a thin wrapper around `npm install -g` and inherits all
 *     of npm's normal failure modes.
 *
 * Tests mock `child_process.execFile` at the boundary (per L-159 / TD-098).
 */

import { execFile, type ExecFileException } from "node:child_process";
import { error as logError, info } from "./log.js";

/**
 * Run `npm install -g igris-ai@latest`.
 *
 * Resolves to the npm process's exit code. On ENOENT (npm not on PATH),
 * resolves to exit code 127 (POSIX "command not found") and emits an
 * actionable error to stderr. On any other spawn failure, resolves to 1
 * with the error message surfaced.
 */
export async function runSelfUpdate(): Promise<number> {
  info("Self-upgrading via 'npm install -g igris-ai@latest'...");
  return await new Promise<number>((resolve) => {
    const child = execFile(
      "npm",
      ["install", "-g", "igris-ai@latest"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { stdio: "inherit" } as any,
      (err: ExecFileException | null) => {
        if (err === null) {
          info("Self-upgrade complete.");
          resolve(0);
          return;
        }
        // ENOENT = npm not on PATH. Surface as 127 with actionable message.
        if (err.code === "ENOENT") {
          logError(
            "npm is not on PATH; cannot self-upgrade. Install Node.js (which bundles npm) and retry.",
          );
          resolve(127);
          return;
        }
        // npm exited non-zero. The exit code is on the error itself.
        // err.code can be a string (signal/spawn error) or number (process exit).
        if (typeof err.code === "number") {
          logError(
            `npm install -g igris-ai@latest failed with exit code ${err.code}.`,
          );
          resolve(err.code);
          return;
        }
        // Spawn or other error: surface message verbatim.
        logError(`npm install -g igris-ai@latest failed: ${err.message}`);
        resolve(1);
      },
    );
    // When stdio is "inherit", child has no stdout/stderr streams to drain.
    // Just ensure we don't keep the event loop alive on the child handle.
    void child;
  });
}
