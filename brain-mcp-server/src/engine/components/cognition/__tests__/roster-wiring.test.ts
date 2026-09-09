/**
 * Cognition roster WIRING test (TD-327).
 *
 * `roster.test.ts` proves the derivation and the projector in isolation. This
 * file proves the one thing that cannot be proven in isolation: that
 * `createCognitionComponent().init()` actually RUNS them, against the real
 * `createSqliteAdapter` migration runner rather than a hand-applied `db.exec`.
 *
 * Without this, the whole chain could be green while the health surface stayed
 * permanently `degraded` on every real brain — the projector correct, the
 * derivation correct, and nobody calling either. `discoverInstances()` had in
 * fact never had a production caller before TD-327; it only ever ran in tests.
 *
 * Hermetic: `:memory:` storage, a stub bus and logger. The inner factories
 * resolve their config from the ambient `~/.igris/config.json`, so nothing here
 * asserts anything config-dependent — the roster is projected from the REGISTRY,
 * which is a property of the build, not of the operator's flags.
 *
 * @module engine/components/cognition/__tests__/roster-wiring.test
 */

import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../../../storage/sqlite.js';
import { createCognitionComponent } from '../index.js';
import { EXTRACTOR_INSTANCES } from '../extractors/index.js';
import { cognitionMigrations } from '../schema.js';
import type { ComponentContext, StorageAdapter } from '../../../types.js';

/**
 * The base tables the perception/janitor migrations ALTER. The memory component
 * owns them in production; seeded here so this test exercises the cognition
 * component's OWN init rather than the whole engine's boot order.
 */
const BASE_DDL = `
  CREATE TABLE learnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL DEFAULT 'p',
    category TEXT NOT NULL DEFAULT 'pattern', title TEXT NOT NULL, content TEXT NOT NULL,
    confidence REAL DEFAULT 0.8, review_status TEXT NOT NULL DEFAULT 'approved',
    embedding BLOB, embedding_model TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_name TEXT NOT NULL, component TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}', machine_hostname TEXT, project_slug TEXT,
    instance_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

interface Harness {
  storage: StorageAdapter;
  logs: string[];
  ctx: ComponentContext;
}

function harness(): Harness {
  const storage = createSqliteAdapter(':memory:');
  storage.exec(BASE_DDL);
  const logs: string[] = [];
  const ctx = {
    storage,
    bus: { on: () => {}, off: () => {}, emit: () => {} },
    log: {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(`WARN ${m}`),
      error: (m: string) => logs.push(`ERROR ${m}`),
    },
    config: {},
  } as unknown as ComponentContext;
  return { storage, logs, ctx };
}

function rosterIds(storage: StorageAdapter): string[] {
  return (
    storage.rawConnection
      .prepare('SELECT id FROM cognition_instances ORDER BY rowid')
      .all() as Array<{ id: string }>
  ).map((r) => r.id);
}

describe('createCognitionComponent().init() projects the roster (TD-327)', () => {
  it('creates the table and writes every registered instance, in barrel order', () => {
    const { storage, ctx } = harness();
    const component = createCognitionComponent();
    component.init(ctx);

    // Sized by the barrel, not by a literal — the same rule as roster.test.ts.
    expect(rosterIds(storage)).toEqual(EXTRACTOR_INSTANCES.map((i) => i.id));

    // The migration ran under the 'cognition' key specifically. That key was
    // free (the merged factory's schema() returns [] and the inherited
    // perception/subconscious/janitor migrations run under their ORIGINAL keys),
    // so claiming it collides with nothing.
    //
    // PIN MOVED 2026-09-01 (TD-423): [1] → [1, 2]. `cognitionMigrations` gained
    // v2 (`ALTER TABLE cognition_instances ADD COLUMN produced`), so a fresh
    // brain now applies BOTH versions under this key. Derived from the
    // declaration rather than restated as a second literal, so the next version
    // does not have to edit this line again — but the LENGTH is still asserted
    // against a literal, because "every declared migration ran" is vacuous if
    // the declaration list is what is broken.
    const applied = storage.rawConnection
      .prepare(
        `SELECT version FROM engine_migrations WHERE component = 'cognition' ORDER BY version`,
      )
      .all() as Array<{ version: number }>;
    expect(applied.map((r) => r.version)).toEqual(
      cognitionMigrations.map((m) => m.version).sort((a, b) => a - b),
    );
    expect(applied).toHaveLength(2);

    component.destroy();
    storage.close();
  });

  it('is idempotent across a re-init — the same seven rows, no duplicates', () => {
    const { storage, ctx } = harness();
    const first = createCognitionComponent();
    first.init(ctx);
    const afterFirst = rosterIds(storage);
    first.destroy();

    const second = createCognitionComponent();
    second.init(ctx);
    expect(rosterIds(storage)).toEqual(afterFirst);
    second.destroy();
    storage.close();
  });

  it('reports the projection in the init log line (the operator-visible receipt)', () => {
    const { storage, logs, ctx } = harness();
    const component = createCognitionComponent();
    component.init(ctx);

    const line = logs.find((l) => l.includes('roster projected'));
    expect(line).toBeDefined();
    expect(line).toContain(`${EXTRACTOR_INSTANCES.length} instances`);
    // No WARN — a warning here would mean the projector failed soft and the
    // health surface is silently degraded, which is exactly the state that must
    // never pass unnoticed.
    expect(logs.filter((l) => l.startsWith('WARN'))).toEqual([]);

    component.destroy();
    storage.close();
  });

  it('FAILS SOFT — a projector error warns and degrades, it never fails the init', () => {
    const { storage, logs, ctx } = harness();
    const component = createCognitionComponent();
    component.init(ctx);

    // Simulate the failure mode the TD-074 contract exists for: the table is
    // gone at projection time (a migration that did not apply, a brain opened
    // read-only, a corrupted schema).
    storage.exec('DROP TABLE cognition_instances');
    logs.length = 0;

    const second = createCognitionComponent();
    // The assertion is that this does NOT throw. Observability must never gate
    // the subsystem it observes; a brain that refuses to boot because a
    // REPORTING table would not write has traded a visible problem for an
    // invisible one.
    expect(() => second.init(ctx)).not.toThrow();

    // ...and the failure is LOUD in the log rather than swallowed. Note the
    // re-init re-runs the migration under a version already recorded in
    // engine_migrations, so the table is NOT recreated — which is precisely the
    // state a fail-soft path has to survive.
    const warned = logs.filter((l) => l.startsWith('WARN'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('Cognition roster projection failed');

    second.destroy();
    component.destroy();
    storage.close();
  });
});
