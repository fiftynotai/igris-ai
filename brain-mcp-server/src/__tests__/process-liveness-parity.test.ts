/**
 * TD-361 — the parity pin for the process start-time twin.
 *
 * `brain-mcp-server/src/process-liveness.ts` and `cli/src/lib/process-liveness.ts`
 * share ONE marker-delimited region holding `getProcessStartTime`. The brain
 * STAMPS `schedule_runs.owner_started_at` with it; the CLI's
 * `classifyInstanceLiveness` compares a live `ps` reading against a stored one
 * by string EQUALITY. So the two must produce byte-identical strings, and the
 * only way to guarantee that across two packages with zero cross-imports is
 * byte-identical code (the BR-100 template 1 shape). This test reads the CLI
 * file BY FS PATH.
 *
 * The region is NOT pure — it spawns `ps` — so it is a PARITY region, not a
 * pure one, and this file does not assert the BR-100 no-I/O rule.
 *
 * @module __tests__/process-liveness-parity.test
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAIN_COPY = join(HERE, '..', 'process-liveness.ts');
const CLI_COPY = join(HERE, '..', '..', '..', 'cli', 'src', 'lib', 'process-liveness.ts');

const OPEN = '// --- TD-361 PARITY REGION (start-time format) ---';
const CLOSE = '// --- END TD-361 PARITY REGION ---';

function region(file: string): string {
  const src = readFileSync(file, 'utf-8');
  const open = src.indexOf(OPEN);
  const close = src.indexOf(CLOSE);
  if (open < 0 || close < 0 || close < open) throw new Error(`no TD-361 parity region in ${file}`);
  // Exactly one marker pair per file — a second region would be silently unpinned.
  expect(src.indexOf(OPEN, open + 1)).toBe(-1);
  expect(src.indexOf(CLOSE, close + 1)).toBe(-1);
  return src.slice(open, close + CLOSE.length);
}

describe('TD-361 — process start-time region parity (brain ⇔ cli)', () => {
  it('the marker-delimited region is byte-identical in both copies', () => {
    expect(region(CLI_COPY)).toBe(region(BRAIN_COPY));
  });

  it('the region is non-trivial: it carries getProcessStartTime and the `lstart=` format', () => {
    const r = region(BRAIN_COPY);
    expect(r).toContain('export function getProcessStartTime(pid: number): string | null');
    expect(r).toContain('"lstart="');
  });

  it('the shells OUTSIDE the region are allowed to differ (the pin is region-scoped)', () => {
    expect(readFileSync(BRAIN_COPY, 'utf-8')).not.toBe(readFileSync(CLI_COPY, 'utf-8'));
  });
});
