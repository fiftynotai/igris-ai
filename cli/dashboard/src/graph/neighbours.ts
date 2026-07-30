/**
 * FR-240 (D6) — the 1-hop neighbourhood, as **ONE definition**.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS AN EXTRACTION AND NOT A NEW FUNCTION
 * ─────────────────────────────────────────────────────────────────────────
 * The brief detail view needs a record's graph neighbours. The obvious way to
 * get them is `igris_graph_neighbors` — but `traversal.ts` imports `getDb()`
 * (`:125`, called at `:630`/`:811`/`:1022`), which opens the brain READ-WRITE
 * and migrates it, so it is unusable under D2's read-only handle without a
 * second contract-heavy extraction (MAINTAINING row 106, the BR-078 seed
 * ladder).
 *
 * It is also unnecessary. The computation already existed client-side, inline
 * in `useGraph.ts`, over a payload the graph had already fetched. So FR-240
 * MOVED it here and `useGraph` now calls it. The consequence is the one that
 * matters: **the graph canvas and the brief detail cannot disagree about what a
 * node's neighbours are**, because there is no second implementation to
 * disagree with. Zero new brain surface, zero new endpoint.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * BEHAVIOUR IS PRESERVED EXACTLY, INCLUDING ITS ODDITY
 * ─────────────────────────────────────────────────────────────────────────
 * The adjacency map is built by adding BOTH directions of every edge, so:
 *
 *  - a **self-loop** puts the node in its own hop set. That was true before the
 *    extraction and it is true now. It is preserved rather than "fixed"
 *    because the same set drives the canvas's `active` highlight, where the
 *    selected node being in its own active set is correct.
 *  - direction is **discarded**. A 1-hop neighbourhood here is undirected;
 *    `trace` is the directed operation and it reads `edges` itself.
 *  - an edge endpoint with no node row contributes a KEY to the hop set that
 *    hydrates to nothing, and is dropped. `whole-graph.ts` emits `phantom`
 *    nodes for those endpoints, so in practice they hydrate — but the drop is
 *    what stops a `boundary`-trimmed drill-down payload from producing holes.
 *
 * The ordering — degree descending, then key ascending — is the same
 * deterministic ordering `whole-graph.ts` uses for truncation and `useGraph`
 * uses for its entry point, so the same payload always presents the same
 * neighbour list in the same order.
 */

import type { GraphEdge, GraphNode } from "../lib/api";

/** Key → node, for hydrating a hop set. */
export type NodeIndex = Map<string, GraphNode>;

/** Key → the keys one edge away, in both directions. */
export type Adjacency = Map<string, Set<string>>;

/** Build the key→node index. */
export function buildNodeIndex(nodes: readonly GraphNode[]): NodeIndex {
  const m: NodeIndex = new Map();
  for (const n of nodes) m.set(n.key, n);
  return m;
}

/** Build the undirected adjacency map. Moved VERBATIM from `useGraph.ts`. */
export function buildAdjacency(edges: readonly GraphEdge[]): Adjacency {
  const m: Adjacency = new Map();
  const add = (a: string, b: string): void => {
    const s = m.get(a);
    if (s === undefined) m.set(a, new Set([b]));
    else s.add(b);
  };
  for (const e of edges) {
    add(e.from, e.to);
    add(e.to, e.from);
  }
  return m;
}

/** The keys one hop away, and the nodes they resolve to. */
export interface Neighbourhood {
  /** Raw keys, including any that hydrate to nothing. */
  hop: ReadonlySet<string>;
  /** Hydrated nodes, degree DESC then key ASC. */
  neighbours: GraphNode[];
}

/**
 * The hop set and its hydrated, ordered nodes — from pre-built indexes.
 *
 * This is the form `useGraph` calls: it already memoises both indexes per
 * payload, and rebuilding them on every selection would turn a click into two
 * full passes over ~3,400 elements.
 */
export function neighboursFrom(
  index: NodeIndex,
  adjacency: Adjacency,
  key: string,
): Neighbourhood {
  const hop = adjacency.get(key) ?? new Set<string>();
  return {
    hop,
    neighbours: [...hop]
      .map((k) => index.get(k))
      .filter((n): n is GraphNode => n !== undefined)
      .sort((a, b) => b.degree - a.degree || (a.key < b.key ? -1 : 1)),
  };
}

/**
 * The hop set and its nodes, straight from a payload.
 *
 * This is the form the record detail calls: it holds a `/api/graph` payload
 * from the shared `lib/graphCache.ts` and asks one question of it. Building the
 * indexes per call is the right trade there — one question, not one per click.
 */
export function neighboursOf(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  key: string,
): Neighbourhood {
  return neighboursFrom(buildNodeIndex(nodes), buildAdjacency(edges), key);
}

/**
 * Edge ids incident to `key`, in either direction.
 *
 * Part of the same extracted block: `useGraph` sets its `activeEdges` from this
 * on every selection, and the record detail uses the COUNT to say how many
 * relationships a record has without re-deriving what "incident" means.
 */
export function incidentEdgeIds(
  edges: readonly GraphEdge[],
  key: string,
): Set<string> {
  return new Set(
    edges.filter((e) => e.from === key || e.to === key).map((e) => e.id),
  );
}
