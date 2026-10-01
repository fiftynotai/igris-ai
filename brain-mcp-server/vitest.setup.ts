/**
 * TS-002 — the tier-wide `HOME` belt for the BRAIN vitest suite (the BR-106
 * analogue of `cli/vitest.setup.ts`).
 *
 * WHY. `src/db.ts#resolveDbPath` resolves at CALL time: an explicit path, then
 * `IGRIS_DB_PATH`, then `IGRIS_BRAIN_DIR`, then
 * `os.homedir()/.igris/memory/knowledge.db`. `getDb()`'s legacy branch opens
 * AND `migrateSchema`s that path. So a brain test that reached `getDb()` with
 * no explicit path opened and migrated the operator's LIVE brain unless the
 * invocation carried `env -u IGRIS_DB_PATH HOME=… IGRIS_BRAIN_DIR=…` — a
 * discipline, not a fence. A second hazard rides the same `HOME`: the `sync`
 * component reads `homedir()/.igris/config.json`, and with `auto_push: true`
 * there a fixture `brief.created` in a booted engine would egress to the real
 * remote. Under the belt that config is absent, so auto-push stays off.
 *
 * ORDER — each step is load-bearing:
 *  1. Publish `IGRIS_REAL_HOME` FIRST, keep-if-set (`??=`), the same name and
 *     semantics as the CLI belt and the bats tier (MAINTAINING's BR-106 row).
 *     Setup files run before the test file's modules load, so publishing after
 *     the repoint would capture the BELT as the real home.
 *  2. UNSET the seams that beat or bypass `HOME`: `IGRIS_DB_PATH` (tier 2) and
 *     `IGRIS_BRAIN_DIR` (tier 3) both outrank tier 4, and `IGRIS_PIDS_DIR` moves
 *     the pidfiles. An inherited value from the operator's shell would point
 *     outside the belt. UNSET, never set: a file that needs a sandbox sets its
 *     own, and files that assert a seam is unset keep passing.
 *  3. A per-FILE `mkdtemp` (setup files run once per test file, so two files
 *     never share a belt even when a worker is reused).
 *  4. Seed a git identity (TD-456: git under an empty HOME has none).
 *  5. Pre-create `<belt>/.igris/memory`, so a would-be-live-DB test lands on a
 *     harmless belt DB instead of throwing on a missing parent dir (harm
 *     reduction, the BR-106 posture).
 *  6. Repoint `HOME`.
 *
 * The gate is `src/__tests__/vitest-home-belt.test.ts` (setupFiles wired, the
 * order pinned, a planted `getDb()` proven to land here).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

// 1. Publish the real home BEFORE repointing HOME — order is load-bearing.
//    Keep-if-set, and only when HOME exists (as cli/vitest.setup.ts does): an
//    unset HOME must not publish an empty "real home".
if (process.env.IGRIS_REAL_HOME === undefined && process.env.HOME !== undefined) {
  process.env.IGRIS_REAL_HOME = process.env.HOME;
}

// 2. Unset every seam that would resolve outside the belt.
delete process.env.IGRIS_DB_PATH;
delete process.env.IGRIS_BRAIN_DIR;
delete process.env.IGRIS_PIDS_DIR;

// 3. A fresh belt for this test file.
const belt = mkdtempSync(join(tmpdir(), 'igris-brain-vitest-belt-'));

// 4. Git identity.
writeFileSync(
  join(belt, '.gitconfig'),
  '[user]\n\tname = igris-brain-vitest\n\temail = brain-vitest@igris.invalid\n',
);

// 5. The default DB tier's parent, so getDb() lands on a belt DB.
mkdirSync(join(belt, '.igris', 'memory'), { recursive: true });

// 6. Repoint HOME.
process.env.HOME = belt;

afterAll(() => {
  try {
    rmSync(belt, { recursive: true, force: true });
  } catch {
    // A leaked temp dir is not worth failing a green run over.
  }
});
