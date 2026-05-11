/**
 * sqlite-vec Loader Tests — TD-048
 *
 * Verifies the createRequire-based loader path correctly handles:
 *   1. Successful load + smoke check on dev environments where the
 *      platform-specific sqlite-vec binary is installed.
 *   2. The IGRIS_DISABLE_VEC=1 kill switch (skips load entirely).
 *   3. The IGRIS_REQUIRE_VEC=1 loud-fail mode (throws when load fails).
 *
 * The first test only runs when the platform-specific optional
 * dependency (e.g. sqlite-vec-darwin-arm64) is actually resolvable.
 * On dev macOS arm64 it will run; on other CI runners it will skip
 * cleanly rather than crash.
 *
 * @module engine/storage/__tests__/sqlite-vec.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createSqliteAdapter } from '../sqlite.js';

/** Whether the sqlite-vec native binary is resolvable in this env. */
function vecBinaryAvailable(): boolean {
  try {
    const requireCjs = createRequire(import.meta.url);
    const sqliteVec = requireCjs('sqlite-vec') as {
      getLoadablePath?: () => string;
    };
    if (typeof sqliteVec.getLoadablePath === 'function') {
      const path = sqliteVec.getLoadablePath();
      return typeof path === 'string' && path.length > 0;
    }
    // If the package resolves at all but doesn't expose getLoadablePath,
    // fall back to optimistic true — the real load below will tell us.
    return true;
  } catch {
    return false;
  }
}

const HAS_VEC_BINARY = vecBinaryAvailable();

describe('sqlite-vec loader (TD-048)', () => {
  afterEach(() => {
    // Vitest's stubEnv is auto-reverted via unstubAllEnvs in vitest.config,
    // but we restore explicitly here too because we mutate process.env
    // directly in some tests where stubEnv would trigger config reactivity.
    vi.unstubAllEnvs();
    delete process.env.IGRIS_DISABLE_VEC;
    delete process.env.IGRIS_REQUIRE_VEC;
  });

  it.skipIf(!HAS_VEC_BINARY)(
    'loads the extension and exposes vec_version() (real binary)',
    () => {
      const adapter = createSqliteAdapter(':memory:');
      try {
        const row = adapter.prepare('SELECT vec_version() AS v').get() as {
          v: string;
        };
        expect(row).toBeDefined();
        expect(typeof row.v).toBe('string');
        expect(row.v.length).toBeGreaterThan(0);
      } finally {
        adapter.close();
      }
    },
  );

  it.skipIf(!HAS_VEC_BINARY)(
    'creates a vec0 virtual table after load (proves native binary is live)',
    () => {
      const adapter = createSqliteAdapter(':memory:');
      try {
        adapter.exec(
          'CREATE VIRTUAL TABLE smoke_vec USING vec0(embedding float[4])',
        );
        const row = adapter
          .prepare("SELECT name FROM sqlite_master WHERE name='smoke_vec'")
          .get();
        expect(row).toBeDefined();
      } finally {
        adapter.close();
      }
    },
  );

  it('skips the load entirely when IGRIS_DISABLE_VEC=1', () => {
    vi.stubEnv('IGRIS_DISABLE_VEC', '1');

    const adapter = createSqliteAdapter(':memory:');
    try {
      // Extension should NOT be loaded — vec_version() must throw.
      expect(() =>
        adapter.prepare('SELECT vec_version() AS v').get(),
      ).toThrow();
    } finally {
      adapter.close();
    }
  });

  it('does not throw on load failure in default (soft-fail) mode', () => {
    // Default mode: NODE_ENV is 'test' (set by vitest), no IGRIS_REQUIRE_VEC.
    // Force a real load() failure by swapping the cached module's load fn
    // to a thrower; createSqliteAdapter should log and continue.
    const requireCjs = createRequire(import.meta.url);
    let modulePath: string;
    try {
      modulePath = requireCjs.resolve('sqlite-vec');
    } catch {
      // sqlite-vec not resolvable at all — the loader's require throws,
      // which is itself the soft-fail path. Just confirm no throw.
      expect(() => {
        const a = createSqliteAdapter(':memory:');
        a.close();
      }).not.toThrow();
      return;
    }

    const cached = requireCjs.cache[modulePath];
    const original = cached?.exports;
    if (cached) {
      cached.exports = {
        load: () => {
          throw new Error('forced soft-fail for TD-048 test');
        },
      };
    }

    try {
      expect(() => {
        const a = createSqliteAdapter(':memory:');
        a.close();
      }).not.toThrow();
    } finally {
      if (cached && original !== undefined) {
        cached.exports = original;
      }
    }
  });

  it('throws when IGRIS_REQUIRE_VEC=1 and the load fails', async () => {
    // To force a load failure deterministically, we make the sqlite-vec
    // module's load() throw via vi.doMock. Because createSqliteAdapter
    // imports sqlite-vec via createRequire (CommonJS resolution), vi.mock
    // alone won't intercept it — we need to swap the require cache entry.
    vi.stubEnv('IGRIS_REQUIRE_VEC', '1');

    const requireCjs = createRequire(import.meta.url);
    let modulePath: string;
    try {
      modulePath = requireCjs.resolve('sqlite-vec');
    } catch {
      // If sqlite-vec can't even be resolved, the loader will throw on
      // require() itself in REQUIRE mode — which is exactly what we want
      // to assert. Run the adapter and confirm it throws.
      expect(() => createSqliteAdapter(':memory:')).toThrow(
        /sqlite-vec extension not available/,
      );
      return;
    }

    const cached = requireCjs.cache[modulePath];
    const original = cached?.exports;

    // Swap exports.load with a thrower so the smoke check / load fails.
    if (cached) {
      cached.exports = {
        load: () => {
          throw new Error('forced failure for TD-048 test');
        },
      };
    }

    try {
      expect(() => createSqliteAdapter(':memory:')).toThrow(
        /sqlite-vec extension not available/,
      );
    } finally {
      // Restore the real module so other tests aren't affected.
      if (cached && original !== undefined) {
        cached.exports = original;
      }
    }
  });
});
