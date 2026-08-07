/**
 * Cognition roster projection tests (TD-327).
 *
 * The brief's finding, restated as a test contract: *"a hand-listed health
 * check over an open registry cannot report on the members nobody remembered to
 * list."* So the roster is asserted to be DERIVED — the headline case registers
 * a throwaway 8th instance into a fresh registry and requires it to appear with
 * NO other edit. That case fails against any implementation that enumerates ids.
 *
 * Also pinned here:
 *   - the contract-completeness gate (every registered instance declares a
 *     usable `health` block);
 *   - perception's LEGACY literals — `component`/`event_prefix` are the bare
 *     `perception`, NOT `cognition.perception`. MAINTAINING's L-857 row: assert
 *     the literal, do not derive it. A surface that derives `cognition.${id}`
 *     silently omits the single healthiest instance;
 *   - the projector's idempotence, its stale-row reconcile, and its fail-soft
 *     contract (TD-074 — observability never gates the subsystem).
 *
 * @module engine/components/cognition/__tests__/roster.test
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createCognitionRegistry, discoverInstances } from '../registry.js';
import { EXTRACTOR_INSTANCES } from '../extractors/index.js';
import { buildRoster, projectRoster, type RosterRow } from '../roster.js';
import { cognitionMigrations } from '../schema.js';
import type { CognitionInstance, CognitionDriver } from '../types.js';

const ALLOWED_DRIVERS: CognitionDriver[] = [
  'schedule',
  'co_driven',
  'session_hook',
  'manual',
];

/** A fresh registry populated from the production extractors barrel. */
function productionRegistry() {
  return discoverInstances(createCognitionRegistry());
}

/** A throwaway instance — the "8th extractor nobody remembered to list". */
function throwaway(id: string): CognitionInstance {
  return {
    id,
    health: {
      component: `cognition.${id}`,
      event_prefix: `cognition.${id}`,
      gate_keys: [`cognition.${id}.enabled`],
      gate_default: false,
      driver: 'manual',
      driver_ref: null,
      output: `suggestions[source_module='${id}']`,
    },
    buildContext: async () => ({}),
    promptBuilder: () => ({ system: 's', user: 'u' }),
    parseResponse: () => [],
    persistCandidate: async () => {},
    config: {
      timeout_ms: 1000,
      daily_budget: 8,
      min_input_bytes: 0,
      enabled: true,
      harness: null,
    },
  };
}

/** An in-memory brain carrying only the cognition schema. */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  for (const m of cognitionMigrations) db.exec(m.sql);
  return db;
}

function readProjected(db: Database.Database): Array<Record<string, unknown>> {
  return db
    .prepare('SELECT * FROM cognition_instances ORDER BY id')
    .all() as Array<Record<string, unknown>>;
}

describe('buildRoster — DERIVED from the registry, never hand-listed (TD-327 AC #4)', () => {
  it('projects exactly the registry membership, sized by the barrel not by a literal', () => {
    const rows = buildRoster(productionRegistry());
    // NOT `toHaveLength(7)`. The count is read from the barrel, so adding an
    // instance does not make this assertion a lie that has to be edited.
    expect(rows).toHaveLength(EXTRACTOR_INSTANCES.length);
    expect(rows.map((r) => r.id).sort()).toEqual(
      EXTRACTOR_INSTANCES.map((i) => i.id).sort(),
    );
  });

  it('a throwaway 8th instance appears with NO other edit — the derivation proof', () => {
    // THE HEADLINE CASE. Register an instance the roster code has never heard
    // of. Any implementation that enumerates known ids fails here; only a
    // mapper over `registry.all()` passes.
    const registry = productionRegistry();
    const before = buildRoster(registry).length;

    registry.register(throwaway('roadmap_drift'));

    const after = buildRoster(registry);
    expect(after).toHaveLength(before + 1);

    const row = after.find((r) => r.id === 'roadmap_drift');
    expect(row).toBeDefined();
    // Not merely PRESENT — its declaration is carried through intact, which is
    // what makes it renderable by a surface that never heard of it either.
    expect(row).toMatchObject<Partial<RosterRow>>({
      id: 'roadmap_drift',
      component: 'cognition.roadmap_drift',
      event_prefix: 'cognition.roadmap_drift',
      gate_keys: ['cognition.roadmap_drift.enabled'],
      driver: 'manual',
      driver_ref: null,
      output: "suggestions[source_module='roadmap_drift']",
    });
  });

  it('is PURE — it does not mutate the instance’s own gate_keys through the row', () => {
    const registry = createCognitionRegistry();
    const inst = throwaway('alpha');
    registry.register(inst);

    const rows = buildRoster(registry);
    rows[0].gate_keys.push('cognition.injected.enabled');

    expect(inst.health.gate_keys).toEqual(['cognition.alpha.enabled']);
  });
});

describe('the health contract is COMPLETE for every registered instance (TD-327 AC #1)', () => {
  const rows = buildRoster(productionRegistry());

  for (const row of rows) {
    it(`${row.id}: declares a usable health block`, () => {
      expect(row.component.length).toBeGreaterThan(0);
      expect(row.event_prefix.length).toBeGreaterThan(0);
      expect(ALLOWED_DRIVERS).toContain(row.driver);
      // Every instance must say where its output lands — the brief's question 3.
      expect(row.output.length).toBeGreaterThan(0);
      // Every instance must name at least one gate; an instance with no gate
      // cannot be reported as `disabled` and would render permanently green.
      expect(row.gate_keys.length).toBeGreaterThan(0);
      expect(typeof row.gate_default).toBe('boolean');
      for (const key of row.gate_keys) {
        expect(key).toMatch(/^cognition\.[a-z_.]+\.enabled$/);
      }
    });
  }

  it('a co_driven instance names a driver_ref that is itself registered', () => {
    const ids = new Set(rows.map((r) => r.id));
    const coDriven = rows.filter((r) => r.driver === 'co_driven');
    // Negative control: if this ever becomes empty the assertion below is
    // vacuous, so assert the population is non-empty first.
    expect(coDriven.length).toBeGreaterThan(0);
    for (const row of coDriven) {
      expect(row.driver_ref).not.toBeNull();
      expect(ids.has(row.driver_ref as string)).toBe(true);
    }
  });

  it('a schedule-driven instance names a driver_ref (the schedules row NAME)', () => {
    const scheduled = rows.filter((r) => r.driver === 'schedule');
    expect(scheduled.length).toBeGreaterThan(0);
    for (const row of scheduled) {
      expect(row.driver_ref).toMatch(/_engine$/);
    }
  });
});

describe('namespace literals — assert them, never derive them (MAINTAINING L-857)', () => {
  const byId = new Map(buildRoster(productionRegistry()).map((r) => [r.id, r]));

  it('perception is the ONE instance whose ABSENT key means ENABLED', () => {
    // `DEFAULT_PERCEPTION_CONFIG.extractor_llm_enabled` is true, so a config
    // with no `cognition.perception` block still extracts. Every other instance
    // defaults off. NOTE this is the RESOLVER default, not the shipped posture:
    // `igris install` WRITES `enabled: false` (FR-191), so a stock fresh install
    // has perception OFF. The declaration exists for configs the installer never
    // touched — a reader that hard-codes "absent means false" reports those as
    // `disabled` while they run, the same silent-omission class as deriving its
    // event namespace.
    expect(byId.get('perception')!.gate_default).toBe(true);
    for (const [id, row] of byId) {
      if (id === 'perception') continue;
      expect(row.gate_default).toBe(false);
    }
  });

  it('perception declares the LEGACY bare `perception`, NOT `cognition.perception`', () => {
    const row = byId.get('perception');
    expect(row).toBeDefined();
    // `perception/runner.ts` calls writePerceptionEvent(db,
    // 'perception.run_started', …) — component AND event prefix are legacy.
    expect(row!.component).toBe('perception');
    expect(row!.event_prefix).toBe('perception');
    // Stated as an inequality too, because the failure this pins is a reader
    // that derives `cognition.${id}` and finds zero rows for the HEALTHIEST
    // instance while reporting it as never having run.
    expect(row!.component).not.toBe('cognition.perception');
  });

  it('every OTHER instance follows the cognition.<id> convention', () => {
    for (const [id, row] of byId) {
      if (id === 'perception') continue;
      expect(row.component).toBe(`cognition.${id}`);
      expect(row.event_prefix).toBe(`cognition.${id}`);
    }
  });

  it('arbiter/curator/cartographer are gated by the JANITOR key, not by one of their own', () => {
    // AC #2: the "absent cognition.<id> key" is not a gate that defaulted to
    // false. These three have no switch of their own by design.
    for (const id of ['arbiter', 'curator']) {
      expect(byId.get(id)!.gate_keys).toEqual(['cognition.janitor.enabled']);
    }
    // The cartographer carries the DOUBLE gate as a declared conjunction, so
    // the reader ANDs it without a per-id branch.
    expect(byId.get('cartographer')!.gate_keys).toEqual([
      'cognition.janitor.enabled',
      'cognition.janitor.cluster.enabled',
    ]);
    for (const id of ['arbiter', 'curator', 'cartographer']) {
      expect(byId.get(id)!.driver).toBe('co_driven');
      expect(byId.get(id)!.driver_ref).toBe('janitor');
    }
  });
});

describe('projectRoster — the registry→CLI bridge', () => {
  it('round-trips every row, serialising gate_keys as JSON', () => {
    const db = makeDb();
    const rows = buildRoster(productionRegistry());
    const result = projectRoster(db, rows);

    expect(result.error).toBeNull();
    expect(result.written).toBe(rows.length);

    const projected = readProjected(db);
    expect(projected).toHaveLength(rows.length);

    const carto = projected.find((r) => r.id === 'cartographer')!;
    expect(JSON.parse(carto.gate_keys as string)).toEqual([
      'cognition.janitor.enabled',
      'cognition.janitor.cluster.enabled',
    ]);
    const perception = projected.find((r) => r.id === 'perception')!;
    expect(perception.component).toBe('perception');
    // Stored 0/1, and perception is the 1.
    expect(perception.gate_default).toBe(1);
    expect(projected.find((r) => r.id === 'janitor')!.gate_default).toBe(0);
    db.close();
  });

  it('is idempotent and preserves registered_at across passes', () => {
    const db = makeDb();
    const rows = buildRoster(productionRegistry());
    projectRoster(db, rows);
    const first = readProjected(db);

    // Mutate a declaration and re-project: the row updates, the stamp does not.
    const mutated = rows.map((r) =>
      r.id === 'janitor' ? { ...r, output: 'somewhere else' } : r,
    );
    const second = projectRoster(db, mutated);
    expect(second.error).toBeNull();
    expect(second.removed).toBe(0);

    const after = readProjected(db);
    expect(after).toHaveLength(first.length);
    expect(after.find((r) => r.id === 'janitor')!.output).toBe('somewhere else');
    expect(after.map((r) => r.registered_at)).toEqual(
      first.map((r) => r.registered_at),
    );
    db.close();
  });

  it('RECONCILES — a row for an instance that is no longer registered is deleted', () => {
    const db = makeDb();
    const rows = buildRoster(productionRegistry());
    projectRoster(db, [...rows, ...buildRoster(seeded('retired_thing'))]);
    expect(readProjected(db).some((r) => r.id === 'retired_thing')).toBe(true);

    const result = projectRoster(db, rows);
    expect(result.removed).toBe(1);
    // A stale row would render as an instance with no signal — an invented
    // outage. The projection holds exactly what the registry holds.
    expect(readProjected(db).some((r) => r.id === 'retired_thing')).toBe(false);
    db.close();
  });

  it('FAILS SOFT — a missing table reports an error instead of throwing (TD-074)', () => {
    const db = new Database(':memory:'); // no migration run
    const result = projectRoster(db, buildRoster(productionRegistry()));
    expect(result.error).toMatch(/cognition_instances/);
    expect(result.written).toBe(0);
    db.close();
  });
});

/** A registry holding exactly one throwaway instance, for the reconcile case. */
function seeded(id: string) {
  const r = createCognitionRegistry();
  r.register(throwaway(id));
  return r;
}
