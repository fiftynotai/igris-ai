/**
 * FR-239 — the git-tracked graph fixture, as a DETERMINISTIC GENERATOR.
 *
 * WHY A GENERATOR AND NOT A DUMP OF THE REAL BRAIN
 * ------------------------------------------------
 * The plan called for a git-tracked 2,422/1,003 fixture. A verbatim dump would
 * be ~980 KB of my actual brain — real project slugs, real brief titles, real
 * learning titles — committed to a PUBLIC repository. That is an operator's
 * private working context, not test data, and no assertion in this suite needs
 * the strings to be real.
 *
 * What the assertions DO need is the real SHAPE: the same cardinality, the same
 * type distribution, the same edge-type and provenance mix. All of those are
 * measured numbers, recorded below with their provenance, and reproduced here
 * exactly. A bench over 2,422 synthetic nodes with the real distribution costs
 * the accessors precisely what the real payload costs them.
 *
 * MEASURED 2026-07-29 against the live brain, via `buildBrainGraph(db, {})`:
 *
 *   nodes 2,422 · edges 1,003 · projects 37 · boundary 0 · truncated false
 *   by_node_type  brief 1739 · learning 676 · goal 5 · error 2
 *                 concept 0 · decision 0 · session 0
 *   by_edge_type  parent_of 627 · blocks 108 · related_to 95 · depends_on 66
 *                 derived_from 69 · cluster_member_of 18 · serves_goal 16
 *                 supersedes 4 · duplicates 0 · recurs_with 0
 *   provenance    backfill · observed · user · inferred
 *   payload       ~980 KB
 *
 * THESE COUNTS ARE A SNAPSHOT AND THEY DRIFT. The brain is written to
 * continuously; three measurements hours apart on the same day read 2,422 /
 * 2,429 / 2,433 nodes and 1,001 / 1,003 / 1,008 edges. That is fine for this
 * file's purpose — the fixture reproduces the SHAPE (cardinality within a
 * rounding error, and the real type / edge-type / provenance distribution),
 * which is what the accessors and the tier predicate cost. Nothing asserts
 * these digits against a live read, and nothing should.
 *
 * Timing is deliberately NOT recorded here. An earlier revision carried
 * "builder latency 143 ms", which was a single cold sample and did not
 * reproduce (warm: ~12 ms). Latency belongs in `docs/dashboard.md`, measured
 * best-of-N with the cold case reported separately.
 *
 * The file is `_`-prefixed so vitest's `*.test.ts` glob does not collect it.
 */

import type { GraphEdge, GraphNode } from "../../lib/api.js";

/** Live node-type distribution, measured. Sums to 2,422. */
export const LIVE_NODE_MIX: ReadonlyArray<readonly [string, number]> = [
  ["brief", 1739],
  ["learning", 676],
  ["goal", 5],
  ["error", 2],
];

/** Live edge-type distribution, measured. Sums to 1,003. */
export const LIVE_EDGE_MIX: ReadonlyArray<readonly [string, number]> = [
  ["parent_of", 627],
  ["blocks", 108],
  ["related_to", 95],
  ["derived_from", 69],
  ["depends_on", 66],
  ["cluster_member_of", 18],
  ["serves_goal", 16],
  ["supersedes", 4],
];

export const LIVE_PROVENANCES = ["backfill", "observed", "user", "inferred"];

export const LIVE_NODE_COUNT = 2422;
export const LIVE_EDGE_COUNT = 1003;
export const LIVE_PROJECT_COUNT = 37;

/** mulberry32 — a tiny seeded PRNG. Determinism is the point of the fixture. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Fixture {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Build a fixture with the live distribution, scaled to `nodeCount`.
 *
 * At the default it reproduces the measured brain exactly (2,422 / 1,003). The
 * 20,000-node variant is what the rung-6 aggregation predicate is tested
 * against — a density today's brain does not reach.
 */
export function graphFixture(
  nodeCount: number = LIVE_NODE_COUNT,
  edgeCount: number = LIVE_EDGE_COUNT,
  seed = 239,
): Fixture {
  const rand = rng(seed);
  const scale = nodeCount / LIVE_NODE_COUNT;

  const nodes: GraphNode[] = [];
  let i = 0;
  for (const [type, count] of LIVE_NODE_MIX) {
    const n = Math.max(1, Math.round(count * scale));
    for (let k = 0; k < n && nodes.length < nodeCount; k++) {
      const project = `project-${i % LIVE_PROJECT_COUNT}`;
      nodes.push({
        key: `${type}|${project}|${type.toUpperCase()}-${k}`,
        type,
        id: `${type.toUpperCase()}-${k}`,
        project,
        label: `${type} fixture entity ${k}`,
        attrs: { status: k % 3 === 0 ? "pending" : "in_progress", priority: null },
        degree: 0,
      });
      i += 1;
    }
  }
  // Top up with briefs if rounding left us short of the target.
  while (nodes.length < nodeCount) {
    const k = nodes.length;
    const project = `project-${k % LIVE_PROJECT_COUNT}`;
    nodes.push({
      key: `brief|${project}|FR-${k}`,
      type: "brief",
      id: `FR-${k}`,
      project,
      label: `brief fixture entity ${k}`,
      attrs: {},
      degree: 0,
    });
  }

  const edges: GraphEdge[] = [];
  const edgeScale = edgeCount / LIVE_EDGE_COUNT;
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  let id = 0;
  for (const [type, count] of LIVE_EDGE_MIX) {
    const n = Math.max(1, Math.round(count * edgeScale));
    for (let k = 0; k < n && edges.length < edgeCount; k++) {
      const from = nodes[Math.floor(rand() * nodes.length)];
      const to = nodes[Math.floor(rand() * nodes.length)];
      if (from.key === to.key) continue;
      id += 1;
      edges.push({
        id: String(id),
        source_edge_id: id,
        from: from.key,
        to: to.key,
        type,
        confidence: 0.5 + rand() * 0.5,
        provenance: LIVE_PROVENANCES[id % LIVE_PROVENANCES.length],
        resolution: id % 7 === 0 ? "replicated" : "unique",
      });
    }
  }

  // Degrees, so the label-ranking and entry-point orderings are meaningful.
  for (const e of edges) {
    const a = byKey.get(e.from);
    const b = byKey.get(e.to);
    if (a !== undefined) a.degree += 1;
    if (b !== undefined) b.degree += 1;
  }

  return { nodes, edges };
}
