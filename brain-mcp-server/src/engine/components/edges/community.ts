/**
 * Brain Engine v7.1 — Edges Component: deterministic community detection (FR-116 M4).
 *
 * A DETERMINISTIC, ENTITY-AGNOSTIC graph-community-detection primitive (Louvain
 * modularity optimization) over an `entity_edges` adjacency projection. It is the
 * shared building block Decision #6 mandates: BOTH FR-112 (brief clustering) and
 * FR-116 (learning clustering) consume it, so it is parameterized by a node-type
 * filter + an edge-type filter and NEVER hard-codes `'learning'`.
 *
 * WHY IT LIVES IN THE EDGES COMPONENT (learning #206): the edges component owns
 * the graph algorithms; `entity_edges` is its table. This module is a PURE READ
 * over `entity_edges` — it NEVER mutates edges (no INSERT / UPDATE / DELETE).
 *
 * DETERMINISM (Decision #8 / §8 risk — THE #1 correctness requirement): the same
 * graph in produces the same clusters out on EVERY run. Louvain is inherently
 * order-sensitive, so determinism is engineered, not assumed:
 *   - node ids are mapped to indices in a FIXED total order (numeric-aware,
 *     lexical tie-break) — the local-moving pass iterates nodes in ascending
 *     index order;
 *   - candidate-community evaluation iterates in ascending community-id order and
 *     the tie-break on equal modularity gain prefers the LOWEST community id;
 *   - there is NO randomness anywhere. The `seed` option is accepted (so callers
 *     can request a stochastic variant later) but the default path is fully
 *     deterministic and ignores it.
 * An idempotency test (`community.test.ts`) locks this: repeated runs over the
 * same graph return byte-identical clusters.
 *
 * NO NEW RUNTIME DEPENDENCY: the Louvain optimizer is implemented in TypeScript
 * over adjacency maps — no external graph library (operator preference).
 *
 * @module engine/components/edges/community
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';

/** Options for `detectCommunities` — parameterized so FR-112 (briefs) can reuse it. */
export interface DetectCommunitiesOptions {
  /** The node type to project (both endpoints must be this type — a homogeneous subgraph). */
  nodeType: string;
  /** Restrict to these edge types. Undefined / empty = every edge type. */
  edgeTypes?: readonly string[];
  /** Minimum members a returned cluster must have (singletons + small clusters dropped). */
  minClusterSize: number;
  /** Modularity resolution γ (>1 = more, smaller communities). Default 1.0. */
  resolution?: number;
  /** Reserved for a future stochastic variant. The default path is deterministic and ignores it. */
  seed?: number;
  /** Include soft-deleted edges (metadata.deleted=true). Default false. */
  includeDeleted?: boolean;
  /** Hard ceiling on local-moving passes per level (safety bound). Default 50. */
  maxPasses?: number;
}

/** One adjacency row read from `entity_edges`. */
interface EdgeRow {
  from_id: string;
  to_id: string;
  confidence: number | null;
}

/**
 * A total order over node-id strings that is deterministic AND intuitive for the
 * common numeric-id case (learning ids are `String(id)`): compare numerically
 * when both parse as finite numbers, else fall back to a lexical compare. Any
 * total order gives determinism; this one also makes cluster output readable.
 */
function compareNodeIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  const aNum = a.trim() !== '' && Number.isFinite(na);
  const bNum = b.trim() !== '' && Number.isFinite(nb);
  if (aNum && bNum) {
    if (na !== nb) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (aNum) return -1; // numbers sort before non-numbers (stable, arbitrary but total)
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The internal undirected weighted graph. Nodes are 0..n-1 (mapped from the
 * sorted node-id strings). `adj[i]` maps neighbour index → edge weight;
 * self-loops carry the intra-community weight across aggregation levels.
 * `m2 = 2m = Σ_i k[i]` — the modularity normalizer.
 */
interface Graph {
  n: number;
  adj: Array<Map<number, number>>;
  /** Weighted degree k[i] (a self-loop of weight w contributes 2w). */
  k: number[];
  /** m2 = Σ_i k[i] = twice the total edge weight. */
  m2: number;
}

/** Add an undirected edge (i,j,w) into the graph builder maps (i≠j). */
function addUndirected(adj: Array<Map<number, number>>, k: number[], i: number, j: number, w: number): void {
  adj[i].set(j, (adj[i].get(j) ?? 0) + w);
  adj[j].set(i, (adj[j].get(i) ?? 0) + w);
  k[i] += w;
  k[j] += w;
}

/**
 * One level of Louvain local moving to convergence (the standard Blondel et al.
 * "one level" — each node either STAYS in its community or MOVES to the adjacent
 * community with the greatest modularity gain). Mutates `comm` (node→community
 * index) in place and returns true if ANY node changed community.
 *
 * DETERMINISM: nodes iterate in ascending index order; candidate communities are
 * evaluated in ascending community-id order; a move replaces the current best
 * ONLY on a STRICT improvement (> bestGain + ε), so on equal gain the lowest
 * community id already visited wins (stable tie-break). No randomness.
 */
function localMoving(graph: Graph, comm: number[], resolution: number, maxPasses: number): boolean {
  const { n, adj, k, m2 } = graph;
  if (m2 === 0) return false;
  // tot[c] = Σ_{j in c} k[j]
  const tot: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) tot[comm[i]] += k[i];

  let improvedOverall = false;
  let pass = 0;
  let moved = true;
  while (moved && pass < maxPasses) {
    moved = false;
    pass++;
    for (let i = 0; i < n; i++) {
      const ci = comm[i];
      // Sum of weights from i into each neighbouring community (excludes self-loop).
      const weightToComm = new Map<number, number>();
      for (const [j, w] of adj[i]) {
        if (j === i) continue;
        const cj = comm[j];
        weightToComm.set(cj, (weightToComm.get(cj) ?? 0) + w);
      }
      // Remove i from its own community (so the "stay" gain is measured fairly).
      tot[ci] -= k[i];

      // Baseline = rejoining i's own community. Candidate communities are the
      // neighbour communities, evaluated in ASCENDING id order; a strict-gain
      // improvement is required to switch, so ties keep the lowest id seen.
      let bestComm = ci;
      let bestGain = (weightToComm.get(ci) ?? 0) - (resolution * tot[ci] * k[i]) / m2;
      const candidates = Array.from(weightToComm.keys()).sort((x, y) => x - y);
      for (const c of candidates) {
        if (c === ci) continue;
        const kIn = weightToComm.get(c) ?? 0;
        const gain = kIn - (resolution * tot[c] * k[i]) / m2;
        if (gain > bestGain + 1e-12) {
          bestGain = gain;
          bestComm = c;
        }
      }

      comm[i] = bestComm;
      tot[bestComm] += k[i];
      if (bestComm !== ci) {
        moved = true;
        improvedOverall = true;
      }
    }
  }
  return improvedOverall;
}

/**
 * Relabel a community assignment to dense 0..c-1 ids in ascending order of the
 * smallest member index (deterministic). Returns the relabelled array + the count.
 */
function densify(comm: number[]): { labels: number[]; count: number } {
  const remap = new Map<number, number>();
  const labels = new Array(comm.length);
  let next = 0;
  for (let i = 0; i < comm.length; i++) {
    const c = comm[i];
    let mapped = remap.get(c);
    if (mapped === undefined) {
      mapped = next++;
      remap.set(c, mapped);
    }
    labels[i] = mapped;
  }
  return { labels, count: next };
}

/**
 * Aggregate the graph: each community becomes a super-node. Inter-community edge
 * weights are summed; intra-community weight becomes the super-node's self-loop
 * (preserving m2 across levels). `labels` must be dense 0..count-1.
 */
function aggregate(graph: Graph, labels: number[], count: number): Graph {
  const adj: Array<Map<number, number>> = Array.from({ length: count }, () => new Map<number, number>());
  const k: number[] = new Array(count).fill(0);
  for (let i = 0; i < graph.n; i++) {
    const ci = labels[i];
    for (const [j, w] of graph.adj[i]) {
      const cj = labels[j];
      // Each undirected edge is seen twice (i→j and j→i); accumulate directly.
      adj[ci].set(cj, (adj[ci].get(cj) ?? 0) + w);
    }
    k[ci] += graph.k[i];
  }
  return { n: count, adj, k, m2: graph.m2 };
}

/**
 * Detect communities over the `entity_edges` projection for `nodeType` +
 * `edgeTypes`. Returns clusters (each a list of the ORIGINAL node-id strings,
 * sorted ascending within the cluster), only those with `>= minClusterSize`
 * members, and the clusters themselves sorted deterministically by their smallest
 * member id. An empty / edgeless graph returns `[]` (no-op). PURE READ — never
 * mutates `entity_edges`. Fail-soft: a read error yields `[]`.
 */
export function detectCommunities(
  db: Database.Database,
  opts: DetectCommunitiesOptions,
): string[][] {
  const resolution = opts.resolution !== undefined && opts.resolution > 0 ? opts.resolution : 1.0;
  const minClusterSize = Math.max(1, Math.floor(opts.minClusterSize));
  const includeDeleted = opts.includeDeleted === true;
  const maxPasses = opts.maxPasses !== undefined && opts.maxPasses > 0 ? Math.floor(opts.maxPasses) : 50;

  // 1. Read the homogeneous subgraph (both endpoints === nodeType). PURE READ.
  let rows: EdgeRow[];
  try {
    const params: unknown[] = [opts.nodeType, opts.nodeType];
    let sql =
      `SELECT from_id, to_id, confidence FROM entity_edges
        WHERE from_type = ? AND to_type = ?`;
    if (opts.edgeTypes && opts.edgeTypes.length > 0) {
      sql += ` AND edge_type IN (${opts.edgeTypes.map(() => '?').join(', ')})`;
      params.push(...opts.edgeTypes);
    }
    if (!includeDeleted) {
      sql += ` AND COALESCE(json_extract(metadata, '$.deleted'), 0) = 0`;
    }
    rows = db.prepare(sql).all(...params) as EdgeRow[];
  } catch {
    return [];
  }

  // 2. Build the node index (fixed total order) + the undirected weighted graph.
  //    Self-loops are skipped (from_id === to_id) so the modularity math stays in
  //    the no-self-loop regime; cluster edges are between distinct nodes.
  const idSet = new Set<string>();
  for (const r of rows) {
    if (r.from_id === r.to_id) continue;
    idSet.add(r.from_id);
    idSet.add(r.to_id);
  }
  if (idSet.size === 0) return [];
  const nodeIds = Array.from(idSet).sort(compareNodeIds);
  const n = nodeIds.length;
  const indexOf = new Map<string, number>();
  for (let i = 0; i < n; i++) indexOf.set(nodeIds[i], i);

  const adj: Array<Map<number, number>> = Array.from({ length: n }, () => new Map<number, number>());
  const k: number[] = new Array(n).fill(0);
  let m2 = 0;
  for (const r of rows) {
    if (r.from_id === r.to_id) continue;
    const i = indexOf.get(r.from_id);
    const j = indexOf.get(r.to_id);
    if (i === undefined || j === undefined) continue;
    const w = typeof r.confidence === 'number' && Number.isFinite(r.confidence) && r.confidence > 0
      ? r.confidence
      : 1;
    addUndirected(adj, k, i, j, w);
    m2 += 2 * w;
  }
  if (m2 === 0) return [];

  // 3. Multi-level Louvain. Track the mapping from ORIGINAL node index → its
  //    current community across aggregation levels.
  let graph: Graph = { n, adj, k, m2 };
  // origToCurrent[originalNodeIndex] = current super-node index at this level.
  let origToCurrent: number[] = Array.from({ length: n }, (_, i) => i);

  for (let level = 0; level < 100; level++) {
    const comm: number[] = Array.from({ length: graph.n }, (_, i) => i);
    const improved = localMoving(graph, comm, resolution, maxPasses);
    const { labels, count } = densify(comm);
    // Fold this level's community assignment into the original-node mapping.
    origToCurrent = origToCurrent.map((c) => labels[c]);
    if (!improved || count === graph.n) break; // converged (no merges this level)
    graph = aggregate(graph, labels, count);
  }

  // 4. Group original nodes by final community, apply minClusterSize, sort
  //    deterministically (members ascending; clusters by smallest member).
  const groups = new Map<number, string[]>();
  for (let i = 0; i < n; i++) {
    const c = origToCurrent[i];
    const arr = groups.get(c);
    if (arr) arr.push(nodeIds[i]);
    else groups.set(c, [nodeIds[i]]);
  }
  const clusters: string[][] = [];
  for (const members of groups.values()) {
    if (members.length < minClusterSize) continue;
    members.sort(compareNodeIds);
    clusters.push(members);
  }
  clusters.sort((a, b) => compareNodeIds(a[0], b[0]));
  return clusters;
}
