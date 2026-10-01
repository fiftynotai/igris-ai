/**
 * TS-002 — the brain vitest tier's HOME belt is real, wired, and ordered.
 *
 * `vitest.setup.ts` is the BR-106 belt ported to this tier (see its header for
 * why each step exists). This file is the gate that fails if it is removed,
 * mis-ordered, or stops covering the DB resolver:
 *
 *   B1  a planted `getDb()` with NO path lands in the per-file belt, never in
 *       the operator's `~/.igris/memory` (the TS-002 AC1 witness, in-suite);
 *   B2  STATIC: `vitest.config.ts` names `./vitest.setup.ts` in `setupFiles`;
 *   B3  RUNTIME: inside a worker, `HOME` is a belt (not `IGRIS_REAL_HOME`) and
 *       the three seams that beat or bypass `HOME` are unset;
 *   B4  STATIC ORDER: `IGRIS_REAL_HOME` is published before `HOME` is
 *       repointed (BR-106 obligation (a));
 *   B5  STATIC: the publish is guarded by `HOME !== undefined` and keep-if-set,
 *       the same two conditions as `cli/vitest.setup.ts`;
 *   V1–V3  vacuity controls: the B2/B4 checkers REPORT a planted defect, so a
 *       green B2/B4 is not a checker that cannot fail.
 *
 * RED-first (recorded 2026-10-01, TS-002 Phase 1.1): with `setupFiles` absent
 * and `HOME=IGRIS_REAL_HOME=<scratch stand-in>`, B1 resolved
 * `getDb().name` to `<stand-in>/.igris/memory/knowledge.db` and its
 * "not under IGRIS_REAL_HOME" and "basename is a belt" assertions failed. The
 * RED arm is never run against the real HOME.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../db.js';

const PKG = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const BELT_PREFIX = 'igris-brain-vitest-belt-';

/** Drop `//` line and block comments, so a commented-out key does not count. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** B2's checker: `OK` iff the config's `setupFiles` array names `./vitest.setup.ts`. */
export function checkBeltConfig(configSrc: string): 'OK' | 'MISSING' {
  const m = /setupFiles\s*:\s*\[([^\]]*)\]/.exec(stripComments(configSrc));
  if (m === null) return 'MISSING';
  return /['"]\.\/vitest\.setup\.ts['"]/.test(m[1]) ? 'OK' : 'MISSING';
}

/** B4's checker: `OK` iff IGRIS_REAL_HOME is assigned BEFORE HOME is repointed. */
export function checkBeltOrder(setupSrc: string): 'OK' | 'ORDER' | 'MISSING' {
  const src = stripComments(setupSrc);
  const publish = src.search(/process\s*\.\s*env\s*\.\s*IGRIS_REAL_HOME\s*(\?\?)?=[^=]/);
  const repoint = src.search(/process\s*\.\s*env\s*\.\s*HOME\s*=\s*belt\b/);
  if (publish < 0 || repoint < 0) return 'MISSING';
  return publish < repoint ? 'OK' : 'ORDER';
}

describe('TS-002 — the brain vitest HOME belt', () => {
  it('B1: a planted getDb() with no path lands in the belt, never in ~/.igris/memory', () => {
    const home = process.env.HOME ?? '';
    const real = process.env.IGRIS_REAL_HOME ?? '';
    // The belt pre-creates this; without the belt a stand-in launch needs it too
    // (better-sqlite3 throws on a missing parent dir, which would hide the RED).
    mkdirSync(join(home, '.igris', 'memory'), { recursive: true });
    try {
      const name = getDb().name;
      expect(name).toBe(join(home, '.igris', 'memory', 'knowledge.db'));
      expect(basename(home).startsWith(BELT_PREFIX), `HOME is not a belt: ${home}`).toBe(true);
      expect(real.length).toBeGreaterThan(0);
      expect(
        name.startsWith(join(real, '.igris') + '/'),
        `getDb() resolved under IGRIS_REAL_HOME: ${name}`,
      ).toBe(false);
      // The OS resolver agrees with the env var (POSIX homedir() reads $HOME).
      expect(homedir()).toBe(home);
      expect(existsSync(name)).toBe(true);
    } finally {
      closeDb();
    }
  });

  it('B2: vitest.config.ts wires ./vitest.setup.ts in setupFiles (static)', () => {
    const config = readFileSync(join(PKG, 'vitest.config.ts'), 'utf-8');
    expect(checkBeltConfig(config)).toBe('OK');
    expect(existsSync(join(PKG, 'vitest.setup.ts'))).toBe(true);
  });

  it('B3: inside a worker HOME is a belt and the DB seams are unset (runtime)', () => {
    const home = process.env.HOME ?? '';
    expect(process.env.IGRIS_REAL_HOME, 'IGRIS_REAL_HOME is not published').toBeDefined();
    expect(home).not.toBe(process.env.IGRIS_REAL_HOME);
    expect(basename(home).startsWith(BELT_PREFIX), `HOME is not a belt: ${home}`).toBe(true);
    // Tier 2 and tier 3 of resolveDbPath beat HOME; IGRIS_PIDS_DIR moves pidfiles.
    expect(process.env.IGRIS_DB_PATH).toBeUndefined();
    expect(process.env.IGRIS_BRAIN_DIR).toBeUndefined();
    expect(process.env.IGRIS_PIDS_DIR).toBeUndefined();
    // Pre-created so a would-be-live-DB test lands on a belt DB, not a throw.
    expect(existsSync(join(home, '.igris', 'memory'))).toBe(true);
  });

  it('B4: IGRIS_REAL_HOME is published BEFORE HOME is repointed (static order pin)', () => {
    const setup = readFileSync(join(PKG, 'vitest.setup.ts'), 'utf-8');
    expect(checkBeltOrder(setup)).toBe('OK');
  });

  it('B5: the publish only runs when HOME exists and IGRIS_REAL_HOME is unset (static)', () => {
    const src = stripComments(readFileSync(join(PKG, 'vitest.setup.ts'), 'utf-8'));
    const guard = src.search(
      /if\s*\(\s*process\.env\.IGRIS_REAL_HOME\s*===\s*undefined\s*&&\s*process\.env\.HOME\s*!==\s*undefined\s*\)/,
    );
    const publish = src.search(/process\s*\.\s*env\s*\.\s*IGRIS_REAL_HOME\s*=[^=]/);
    expect(guard, 'the IGRIS_REAL_HOME publish is not guarded by HOME !== undefined').toBeGreaterThan(-1);
    expect(guard).toBeLessThan(publish);
  });

  describe('vacuity controls — the checkers report a planted defect', () => {
    it('V1: a config with no setupFiles is MISSING', () => {
      expect(checkBeltConfig("export default defineConfig({ test: { environment: 'node' } });")).toBe(
        'MISSING',
      );
      // A commented-out key does not count either.
      expect(checkBeltConfig("test: { // setupFiles: ['./vitest.setup.ts'],\n }")).toBe('MISSING');
    });

    it('V2: a setupFiles naming another file is MISSING', () => {
      expect(checkBeltConfig("test: { setupFiles: ['./other.setup.ts'] }")).toBe('MISSING');
      expect(checkBeltConfig("test: { setupFiles: ['./vitest.setup.ts'] }")).toBe('OK');
    });

    it('V3: a swapped order is ORDER, and a missing publish is MISSING', () => {
      expect(
        checkBeltOrder(
          'const belt = x();\nprocess.env.HOME = belt;\nprocess.env.IGRIS_REAL_HOME ??= process.env.HOME;\n',
        ),
      ).toBe('ORDER');
      expect(checkBeltOrder('const belt = x();\nprocess.env.HOME = belt;\n')).toBe('MISSING');
      expect(
        checkBeltOrder(
          '// process.env.IGRIS_REAL_HOME ??= process.env.HOME;\nprocess.env.HOME = belt;\n',
        ),
      ).toBe('MISSING');
    });
  });
});
