/**
 * BR-100 — the parity pin for the machine-identity twin.
 *
 * `brain-mcp-server/src/machine-identity.ts` and `cli/src/lib/machine-identity.ts`
 * are two hand-written files sharing ONE marker-delimited PURE REGION. The two
 * packages have zero cross-imports, so this test reads the CLI file BY FS PATH
 * and asserts the region byte-identical (the `identity-shape.ts` / `_common.sh`
 * and `brief-normalize-mirror-parity` precedents). The behavioural half — both
 * suites replaying `fixtures/machine-identity-fixtures.json` — closes the
 * "logic edit not mirrored" gap TD-338 named; this closes the byte half.
 *
 * Edit the pure region in BOTH files, or this reds. Package-specific I/O shells
 * outside the markers may diverge freely (the surviving-control mutation C1 in
 * the BR-100 battery edits a comment there and must stay green).
 *
 * @module __tests__/machine-identity-parity.test
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAIN_COPY = join(HERE, '..', 'machine-identity.ts');
const CLI_COPY = join(HERE, '..', '..', '..', 'cli', 'src', 'lib', 'machine-identity.ts');

const OPEN = '// --- BR-100 PURE REGION (parity-pinned) ---';
const CLOSE = '// --- END PURE REGION ---';

function pureRegion(file: string): string {
  const src = readFileSync(file, 'utf-8');
  const open = src.indexOf(OPEN);
  const close = src.indexOf(CLOSE);
  if (open < 0 || close < 0 || close < open) throw new Error(`no pure region in ${file}`);
  // Exactly one marker pair per file — a second region would be silently unpinned.
  expect(src.indexOf(OPEN, open + 1)).toBe(-1);
  expect(src.indexOf(CLOSE, close + 1)).toBe(-1);
  return src.slice(open, close + CLOSE.length);
}

describe('BR-100 — machine-identity pure region parity (brain ⇔ cli)', () => {
  it('the marker-delimited region is byte-identical in both copies', () => {
    const brain = pureRegion(BRAIN_COPY);
    const cli = pureRegion(CLI_COPY);
    expect(cli).toBe(brain);
  });

  it('the region is non-trivial: it carries every pinned symbol', () => {
    const region = pureRegion(BRAIN_COPY);
    for (const sym of [
      'export interface MachineIdentity',
      'export function resolveIdentity',
      'export function withMintedId',
      'export function withObservedHostname',
      'export function isSameMachine',
    ]) {
      expect(region).toContain(sym);
    }
    // The region is PURE: no I/O import or env read may live inside it.
    expect(region).not.toMatch(/\bfs\.|process\.env|readFileSync|homedir\(\)/);
  });

  it('the shells OUTSIDE the region are allowed to differ (the parity pin is region-scoped)', () => {
    const brain = readFileSync(BRAIN_COPY, 'utf-8');
    const cli = readFileSync(CLI_COPY, 'utf-8');
    expect(brain).not.toBe(cli);
    // Each shell honours its own seam: the brain reads IGRIS_BRAIN_DIR directly,
    // the CLI goes through paths.ts#configJsonPath (which reads the same seam).
    expect(brain).toContain('IGRIS_BRAIN_DIR');
    expect(cli).toContain('configJsonPath');
  });
});
