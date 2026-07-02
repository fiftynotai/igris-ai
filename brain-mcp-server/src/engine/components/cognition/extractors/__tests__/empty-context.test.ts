/**
 * Empty-context short-circuit — per-extractor `isEmptyContext` unit tests (TD-292).
 *
 * The janitor-family + graph instances (near-dupe MERGE / arbiter / curator /
 * cartographer / synapse) each self-report an empty candidate set so the engine
 * can skip cleanly (`skipped reason=no_candidates`) BEFORE spawning the isolated
 * LLM — the fix for the `parse_error`-on-empty bug (TD-292, extended to
 * cartographer + synapse by TD-293). These assert the pure length check per
 * instance: true when the candidate collection is empty, false when non-empty.
 *
 * @module engine/components/cognition/extractors/__tests__/empty-context.test
 */

import { describe, it, expect } from 'vitest';
import { createJanitorInstance, type JanitorContext } from '../janitor.js';
import { createArbiterInstance, type ArbiterContext } from '../arbiter.js';
import { createCuratorInstance, type CuratorContext } from '../curator.js';
import { createCartographerInstance, type CartographerContext } from '../cartographer.js';
import { createSynapseInstance, type SynapseContext } from '../synapse.js';
import { createSubconsciousInstance } from '../subconscious.js';
import { createPerceptionInstance } from '../perception.js';
import type { DuplicatePair } from '../../../janitor/types.js';
import type { ContradictionPair } from '../../../arbiter/types.js';
import type { StaleCandidate } from '../../../curator/types.js';
import type { LearningCluster } from '../../../cartographer/types.js';
import type { CandidatePair } from '../../../synapse/types.js';

describe('isEmptyContext (TD-292) — janitor near-dupe MERGE', () => {
  const inst = createJanitorInstance();

  it('returns true when the candidate pair set is empty', () => {
    const ctx: JanitorContext = {
      pairs: [],
      project: 'all',
      autoMerge: false,
      autoMergeThreshold: 0.98,
      pairs_bytes: 2,
      persistedPairs: new Set<string>(),
    };
    expect(inst.isEmptyContext?.(ctx)).toBe(true);
  });

  it('returns false when there is at least one candidate pair', () => {
    const ctx: JanitorContext = {
      pairs: [{} as DuplicatePair],
      project: 'all',
      autoMerge: false,
      autoMergeThreshold: 0.98,
      pairs_bytes: 64,
      persistedPairs: new Set<string>(),
    };
    expect(inst.isEmptyContext?.(ctx)).toBe(false);
  });
});

describe('isEmptyContext (TD-292) — arbiter contradiction', () => {
  const inst = createArbiterInstance();

  it('returns true when the opposition pair set is empty', () => {
    const ctx: ArbiterContext = {
      pairs: [],
      project: 'all',
      autoResolve: false,
      autoResolveThreshold: 0.98,
      pairs_bytes: 2,
      persistedPairs: new Set<string>(),
    };
    expect(inst.isEmptyContext?.(ctx)).toBe(true);
  });

  it('returns false when there is at least one opposition pair', () => {
    const ctx: ArbiterContext = {
      pairs: [{} as ContradictionPair],
      project: 'all',
      autoResolve: false,
      autoResolveThreshold: 0.98,
      pairs_bytes: 64,
      persistedPairs: new Set<string>(),
    };
    expect(inst.isEmptyContext?.(ctx)).toBe(false);
  });
});

describe('isEmptyContext (TD-293) — cartographer cluster-summary', () => {
  const inst = createCartographerInstance();

  it('returns true when the detected-cluster set is empty', () => {
    const ctx: CartographerContext = {
      clusters: [],
      project: 'all',
      autoFork: false,
      clusters_bytes: 2,
      persistedKeys: new Set<string>(),
      runId: null,
    };
    expect(inst.isEmptyContext?.(ctx)).toBe(true);
  });

  it('returns false when there is at least one detected cluster', () => {
    const ctx: CartographerContext = {
      clusters: [{} as LearningCluster],
      project: 'all',
      autoFork: false,
      clusters_bytes: 64,
      persistedKeys: new Set<string>(),
      runId: null,
    };
    expect(inst.isEmptyContext?.(ctx)).toBe(false);
  });
});

describe('isEmptyContext (TD-293) — synapse edge inference', () => {
  const inst = createSynapseInstance();

  it('returns true when the candidate pair set is empty', () => {
    const ctx: SynapseContext = {
      pairs: [],
      project: 'all',
      autoApprove: false,
      pairs_bytes: 2,
      persistedPairs: new Set<string>(),
    };
    expect(inst.isEmptyContext?.(ctx)).toBe(true);
  });

  it('returns false when there is at least one candidate pair', () => {
    const ctx: SynapseContext = {
      pairs: [{} as CandidatePair],
      project: 'all',
      autoApprove: false,
      pairs_bytes: 64,
      persistedPairs: new Set<string>(),
    };
    expect(inst.isEmptyContext?.(ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TD-294 — the 6 janitor-family instances opt into isMalformedResponse: a
// well-formed (possibly empty) array is a VALID EMPTY judgment (→ false), while
// garbage is malformed (→ true). Asserts the real factories expose the hook and
// wire it to their validator's own parse leniency.
// ---------------------------------------------------------------------------

describe('isMalformedResponse (TD-294) — the 6 janitor-family instances opt in', () => {
  const instances = [
    ['janitor', createJanitorInstance()],
    ['arbiter', createArbiterInstance()],
    ['curator', createCuratorInstance()],
    ['cartographer', createCartographerInstance()],
    ['synapse', createSynapseInstance()],
    ['subconscious', createSubconsciousInstance()],
  ] as const;

  for (const [id, inst] of instances) {
    it(`${id}: a well-formed empty array [] is NOT malformed (valid-empty judgment)`, () => {
      expect(inst.isMalformedResponse?.('[]')).toBe(false);
    });

    it(`${id}: garbage IS malformed`, () => {
      expect(inst.isMalformedResponse?.('garbage')).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// TD-295 — perception (the fast-follow deferred by TD-294) opts into the SAME
// hook, but backed by its OWN parse grammar (`isPerceptionReplyWellFormed`,
// which accepts the `{result}` envelope + fences perception's parseResponse
// accepts — NOT the janitor-family `parseJsonArray`). A well-formed empty array
// (bare or envelope-wrapped) is a valid "nothing worth learning" judgment
// (→ false); garbage is malformed (→ true).
// ---------------------------------------------------------------------------

describe('isMalformedResponse (TD-295) — perception opts in with its own grammar', () => {
  const inst = createPerceptionInstance().instance;

  it('a well-formed empty array [] is NOT malformed (valid-empty judgment)', () => {
    expect(inst.isMalformedResponse?.('[]')).toBe(false);
  });

  it('an envelope-wrapped empty array is NOT malformed (perception grammar)', () => {
    expect(
      inst.isMalformedResponse?.(JSON.stringify({ type: 'result', result: '[]' })),
    ).toBe(false);
  });

  it('garbage IS malformed', () => {
    expect(inst.isMalformedResponse?.('garbage')).toBe(true);
  });
});

describe('isEmptyContext (TD-292) — curator prune', () => {
  const inst = createCuratorInstance();

  it('returns true when the stale-candidate set is empty', () => {
    const ctx: CuratorContext = {
      candidates: [],
      project: 'all',
      autoPrune: false,
      anomalyThreshold: 50,
      candidates_bytes: 2,
      persistedIds: new Set<number>(),
      runId: null,
    };
    expect(inst.isEmptyContext?.(ctx)).toBe(true);
  });

  it('returns false when there is at least one stale candidate', () => {
    const ctx: CuratorContext = {
      candidates: [{} as StaleCandidate],
      project: 'all',
      autoPrune: false,
      anomalyThreshold: 50,
      candidates_bytes: 64,
      persistedIds: new Set<number>(),
      runId: null,
    };
    expect(inst.isEmptyContext?.(ctx)).toBe(false);
  });
});
