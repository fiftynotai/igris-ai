/**
 * Process liveness probes (TD-361): the brain twin of `cli/src/lib/process-liveness.ts`'s
 * start-time reader, parity-pinned so `schedule_runs.owner_started_at` is
 * byte-comparable with a CLI reading. Rationale: docs/COGNITION.md.
 * @module process-liveness
 */

import { execFileSync } from 'node:child_process';

export { isProcessAlive } from './stdio-lifecycle.js';

// --- TD-361 PARITY REGION (start-time format) ---
export function getProcessStartTime(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
// --- END TD-361 PARITY REGION ---

/** `ps -o etime=` text (`[[dd-]hh:]mm:ss`, locale-independent) → elapsed ms, or null. */
export function parseEtime(text: string): number | null {
  const m = /^\s*(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s*$/.exec(text);
  if (m === null) return null;
  const [d, h, mi, s] = [m[1], m[2], m[3], m[4]].map((v) => (v === undefined ? 0 : Number(v)));
  return (((d * 24 + h) * 60 + mi) * 60 + s) * 1000;
}

/** Elapsed run time of `pid` in ms (floored to the second by `ps`), or null on any failure. */
export function getProcessElapsedMs(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'etime='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    });
    return parseEtime(out);
  } catch {
    return null;
  }
}
