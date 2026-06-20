/**
 * `igris detect` — the L0 capability-detection verb (FR-195 M1).
 *
 * Thin wrapper over `detectCapabilities()`: prints the digest as a single
 * JSON object to STDOUT (logs/notices go to stderr via lib/log.ts, so stdout
 * stays a clean parseable digest the awaken skill reads). Exit 0 always — a
 * missing brain DB is a degraded mode, not an error.
 */

import { detectCapabilities } from "../lib/detect.js";

export interface DetectOptions {
  /**
   * Emit the digest as JSON to stdout. Default ON for the awaken path; the
   * flag exists so a future `--human` can pretty-print. M1 only emits JSON.
   */
  json?: boolean;
}

/**
 * Run the detect verb. Returns the process exit code (always 0 — detection
 * never fails; it reports degradation via `mode`).
 */
export function runDetect(_opts: DetectOptions = {}): number {
  const result = detectCapabilities();
  process.stdout.write(JSON.stringify(result) + "\n");
  return 0;
}
