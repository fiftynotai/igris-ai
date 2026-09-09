/**
 * db-path-resolution.test.ts — TD-426 (re-lands TD-387, whose commit 8d66b44
 * was stranded on `feature/GL-012-composable-catalog` and never reached develop).
 *
 * In-process precedence matrix for `resolveDbPath()` — the ONE function every
 * `dist/index.js` boot resolves the brain DB through — and for the matching
 * middle tier of `stdio-lifecycle.ts#pidsDir()`. No DB is opened and no
 * subprocess is spawned: pure path resolution only.
 *
 * The documented precedence (db.ts#resolveDbPath):
 *
 *   1. explicit arg                              (CLI callers / scripts)
 *   2. IGRIS_DB_PATH                             (full-path override)
 *   3. IGRIS_BRAIN_DIR + /memory/knowledge.db    (sandbox-dir override)
 *   4. ~/.igris/memory/knowledge.db              (default, call-time homedir)
 *
 * Origin: the stdio entrypoint booted the engine with a STATIC `DB_PATH`
 * constant, so the BR-068 build spawn-smoke's `IGRIS_BRAIN_DIR=<tmpdir>` was
 * silently ignored and `cd cli && npm run build` opened + migrated the LIVE
 * operator brain (instances v3 on 2026-08-26, v4 on 2026-08-27). Tier 3 is the
 * tier that was missing; tiers are asserted individually AND pairwise so a
 * precedence inversion cannot pass.
 *
 * NOTE on tier 2 vs the CLI: `IGRIS_DB_PATH` is intentionally INERT for
 * explicit-path callers (tier 1). `cli/src/lib/paths.ts#brainDbPath` feeds
 * explicit paths into bootEngine and deliberately does NOT read
 * IGRIS_DB_PATH — cli/src/__tests__/dashboard-triage-endpoint.test.ts
 * ("a POISON IGRIS_DB_PATH does not move the writes") asserts that fence.
 * Do not "unify" the two.
 *
 * Red-first (2026-08-27, HEAD 812ae57): `resolveDbPath` was not exported, so
 * every call site threw `resolveDbPath is not a function` — 13 of 15 tests
 * failed; the 2 passes were the pidsDir cases that never call it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveDbPath } from '../db.js';
import { pidsDir } from '../stdio-lifecycle.js';

const ENV_KEYS = ['IGRIS_DB_PATH', 'IGRIS_BRAIN_DIR', 'IGRIS_PIDS_DIR'] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const val = savedEnv[key];
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
});

describe('resolveDbPath — 4-tier precedence (TD-426 / TD-387)', () => {
  it('tier 4: no overrides -> ~/.igris/memory/knowledge.db', () => {
    expect(resolveDbPath()).toBe(
      path.join(os.homedir(), '.igris', 'memory', 'knowledge.db'),
    );
  });

  it('tier 3: IGRIS_BRAIN_DIR alone -> <dir>/memory/knowledge.db (the build-smoke escape)', () => {
    process.env.IGRIS_BRAIN_DIR = '/x';
    expect(resolveDbPath()).toBe(path.join('/x', 'memory', 'knowledge.db'));
  });

  it('tier 2: IGRIS_DB_PATH alone -> the exact path given', () => {
    process.env.IGRIS_DB_PATH = '/tmp/sandbox.db';
    expect(resolveDbPath()).toBe('/tmp/sandbox.db');
  });

  it('tier 1: explicit arg alone -> the exact path given', () => {
    expect(resolveDbPath('/explicit/brain.db')).toBe('/explicit/brain.db');
  });

  it('tier 2 beats tier 3: IGRIS_DB_PATH wins over IGRIS_BRAIN_DIR', () => {
    process.env.IGRIS_DB_PATH = '/tmp/full-override.db';
    process.env.IGRIS_BRAIN_DIR = '/x';
    expect(resolveDbPath()).toBe('/tmp/full-override.db');
  });

  it('tier 1 beats tier 2: explicit arg wins over IGRIS_DB_PATH', () => {
    process.env.IGRIS_DB_PATH = '/tmp/poison.db';
    expect(resolveDbPath('/explicit/brain.db')).toBe('/explicit/brain.db');
  });

  it('tier 1 beats all: explicit arg wins with both env vars set', () => {
    process.env.IGRIS_DB_PATH = '/tmp/poison.db';
    process.env.IGRIS_BRAIN_DIR = '/x';
    expect(resolveDbPath('/explicit/brain.db')).toBe('/explicit/brain.db');
  });

  it('empty-string env vars are ignored (fall through to the next tier)', () => {
    process.env.IGRIS_DB_PATH = '';
    process.env.IGRIS_BRAIN_DIR = '';
    expect(resolveDbPath()).toBe(
      path.join(os.homedir(), '.igris', 'memory', 'knowledge.db'),
    );
  });

  it('empty explicit arg falls through to IGRIS_DB_PATH', () => {
    process.env.IGRIS_DB_PATH = '/tmp/next-tier.db';
    expect(resolveDbPath('')).toBe('/tmp/next-tier.db');
  });

  it('empty IGRIS_DB_PATH falls through to IGRIS_BRAIN_DIR', () => {
    process.env.IGRIS_DB_PATH = '';
    process.env.IGRIS_BRAIN_DIR = '/x';
    expect(resolveDbPath()).toBe(path.join('/x', 'memory', 'knowledge.db'));
  });

  it('tier 4 resolves at CALL time, not module load (the fake-HOME seam the spawn tests use)', () => {
    const savedHome = process.env.HOME;
    try {
      process.env.HOME = '/fake/home';
      expect(resolveDbPath()).toBe(
        path.join('/fake/home', '.igris', 'memory', 'knowledge.db'),
      );
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });
});

describe('pidsDir — mirrors the middle tier (TD-426 / TD-387)', () => {
  it('no overrides -> ~/.igris/brain-mcp-server.pids', () => {
    expect(pidsDir()).toBe(
      path.join(os.homedir(), '.igris', 'brain-mcp-server.pids'),
    );
  });

  it('IGRIS_BRAIN_DIR alone -> <dir>/brain-mcp-server.pids (a sandboxed boot writes no pidfile into the real ~/.igris)', () => {
    process.env.IGRIS_BRAIN_DIR = '/x';
    expect(pidsDir()).toBe(path.join('/x', 'brain-mcp-server.pids'));
  });

  it('IGRIS_PIDS_DIR beats IGRIS_BRAIN_DIR', () => {
    process.env.IGRIS_PIDS_DIR = '/pids';
    process.env.IGRIS_BRAIN_DIR = '/x';
    expect(pidsDir()).toBe('/pids');
  });

  it('empty IGRIS_PIDS_DIR falls through to IGRIS_BRAIN_DIR', () => {
    process.env.IGRIS_PIDS_DIR = '';
    process.env.IGRIS_BRAIN_DIR = '/x';
    expect(pidsDir()).toBe(path.join('/x', 'brain-mcp-server.pids'));
  });
});
