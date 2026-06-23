/**
 * Brain Engine v7.1 — Cognition instance registry (OPEN, self-describing) — FR-118 M0.
 *
 * THE EXPANDABILITY CONTRACT (the FR-202 plugin-host precedent). This registry
 * is an OPEN map of self-describing instances — NOT a closed
 * `'perception' | 'subconscious'` enum. Membership is gated by the
 * `CognitionInstance` contract (types.ts): if a part can fill it, it is an
 * instance; the registry discovers it and the engine runs it with ZERO engine
 * or backend edit.
 *
 * Discovery (the "globs extractors/*" of the plan): the engine bundles to a
 * single dist file, so a literal source-FS glob is not the deploy shape. Instead
 * the OPEN registry is populated by the `extractors/` barrel
 * (`extractors/index.ts` re-exports every instance file; `discoverInstances`
 * collects them) — adding `extractors/<name>.ts` + one re-export line is the
 * whole cost of a new instance. The registry API (`register` / `get` / `all`)
 * is also directly callable, which is what the extensibility test exercises: it
 * registers a throwaway DUMMY instance and the engine runs it end-to-end with no
 * host change.
 *
 * M0 ships DORMANT — `extractors/` has no real instances yet (perception still
 * runs its inline path; subconscious still uses rules). The registry is built and
 * tested against a dummy instance only. M1/M2 drop the real instances in.
 *
 * @module engine/components/cognition/registry
 * @author fifty.dev
 */

import type { CognitionInstance } from './types.js';
import { EXTRACTOR_INSTANCES } from './extractors/index.js';

/**
 * An OPEN registry of cognition instances. Instances self-describe and register;
 * the engine + the (future) per-instance MCP tools iterate `all()`. There is no
 * closed enum — a new instance is discovered, never branched-on.
 */
export interface CognitionRegistry {
  /**
   * Register a self-describing instance. Idempotent by id: re-registering the
   * same id REPLACES the prior entry (so a hot-reload / test re-run is clean).
   * Rejects an empty id (an instance must name itself — that name becomes its
   * `event_log.component` namespace `cognition.<id>`).
   */
  register(instance: CognitionInstance): void;
  /** Look up an instance by id, or `undefined` if not registered. */
  get(id: string): CognitionInstance | undefined;
  /** Every registered instance (insertion order). */
  all(): CognitionInstance[];
  /** Every registered instance id. */
  ids(): string[];
  /** Whether an instance with this id is registered. */
  has(id: string): boolean;
  /** Remove all registrations (test isolation). */
  clear(): void;
}

/**
 * Create a fresh, empty OPEN registry. Tests create their own so registrations
 * don't leak across files; production uses the shared `cognitionRegistry`.
 */
export function createCognitionRegistry(): CognitionRegistry {
  const byId = new Map<string, CognitionInstance>();

  return {
    register(instance: CognitionInstance): void {
      const id = instance?.id;
      if (typeof id !== 'string' || id.trim().length === 0) {
        throw new Error(
          'cognition/registry: an instance must declare a non-empty `id` ' +
            '(it becomes the cognition.<id> event_log namespace).',
        );
      }
      // Map preserves insertion order; delete-then-set so a replacement also
      // moves to the end (last writer wins, deterministic order).
      byId.delete(id);
      byId.set(id, instance);
    },
    get(id: string): CognitionInstance | undefined {
      return byId.get(id);
    },
    all(): CognitionInstance[] {
      return [...byId.values()];
    },
    ids(): string[] {
      return [...byId.keys()];
    },
    has(id: string): boolean {
      return byId.has(id);
    },
    clear(): void {
      byId.clear();
    },
  };
}

/**
 * The process-wide shared registry. The component factory + the engine read this
 * one. `discoverInstances` populates it from the `extractors/` barrel at boot.
 */
export const cognitionRegistry: CognitionRegistry = createCognitionRegistry();

/**
 * Discover and register every self-describing instance from the `extractors/`
 * barrel into a registry (defaults to the shared one). This is the "globs
 * extractors/*" step: the barrel re-exports each instance; we register them all.
 *
 * M0: the barrel is EMPTY (no real instances yet) — this is a no-op that proves
 * the wiring. M1/M2 add the perception/subconscious instances to the barrel and
 * they appear here automatically, with ZERO change to this function or the engine.
 *
 * @param registry the registry to populate (defaults to the shared one)
 * @param instances the discovered instances (defaults to the extractors barrel)
 */
export function discoverInstances(
  registry: CognitionRegistry = cognitionRegistry,
  instances: CognitionInstance[] = discoverFromBarrel(),
): CognitionRegistry {
  for (const instance of instances) {
    registry.register(instance);
  }
  return registry;
}

/**
 * Collect the instances re-exported by the `extractors/` barrel. The barrel is
 * the single place a new instance is listed (one re-export line) — discovery
 * reads it, the engine never branches on instance identity.
 *
 * Returns `[]` in M0 (the barrel exports no instances yet). Kept as a function
 * (not an inlined import list) so M1/M2 add instances by editing ONLY the barrel.
 */
function discoverFromBarrel(): CognitionInstance[] {
  // M0: the barrel is empty. Reading `EXTRACTOR_INSTANCES` from the barrel keeps
  // discovery single-sourced — M1/M2 extend ONLY the barrel and appear here
  // automatically, with no change to this file or the engine (the FR-202
  // zero-host-change extensibility property).
  return [...EXTRACTOR_INSTANCES];
}
