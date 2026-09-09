/**
 * FR-239 — the dataviz exemption-04 QUERY TWIN composer.
 *
 * `docs/brand/dataviz.md` §03 exemption 04: a live graph has no single static
 * state to twin, so **the query is the twin**. Every data-viz surface must
 * expose the query that produced the current node set, in mono, beside the
 * canvas. "Unreproducible canvases are forbidden."
 *
 * WHY THIS RUNS SERVER-SIDE (D3). The obligation is that a reader can
 * **re-derive what they are looking at**. A twin the browser assembles from a
 * payload it already has is a caption the client invented — it describes the
 * bytes that arrived, not the question that produced them. Only the server
 * knows the scope it passed to `buildBrainGraph`, which caps applied, and
 * whether the builder degraded. So the server states it, and the browser
 * renders the string verbatim without composing anything.
 *
 * PURE BY CONSTRUCTION — no I/O, no clock, no `db`. Every input is a parameter,
 * which is what makes the truncated and degraded renderings unit-testable
 * without a brain (T4).
 */

import type { GraphQueryTwin } from "../../types.js";

/** The stable surface ID. The `FIG. N` equivalent — never derived, never dated. */
export const GRAPH_SURFACE_ID = "igris-brain-graph";

/**
 * FR-237's scale tripwires, MIRRORED from `whole-graph.ts:90` / `:93`.
 *
 * These are stated in the twin so a reader can tell a complete answer from a
 * capped one. They are NOT a second cap — nothing here applies them; the
 * builder does. If FR-237 changes its defaults these must be re-pointed
 * (MAINTAINING row 105).
 */
export const BUILDER_MAX_NODES = 15_000;
export const BUILDER_MAX_EDGES = 20_000;

export interface ComposeTwinInput {
  /** The scope the builder was called with. `null` = the whole brain. */
  project: string | null;
  nodeCount: number;
  edgeCount: number;
  /** The builder's own truncation flag. */
  truncated: boolean;
  truncationReason: string | null;
  /** Present when the graph could not be built at all. */
  degradedReason: string | null;
  /** ISO stamp — the builder's `generated_at`, passed in rather than read. */
  generatedAt: string;
}

/** `2422` -> `"2,422"`. Grouping is display-only; the twin is read by humans. */
function group(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Compose the twin.
 *
 * The QUERY block names every clause that put a glyph on the canvas — dataviz
 * §05's *no node without provenance*, stated as text. It is written against the
 * builder's actual behaviour, not against a wish: `buildBrainGraph` reads the
 * active entity tables and the full `entity_edges` catalog, then projects edges
 * onto the project axis.
 */
export function composeQueryTwin(input: ComposeTwinInput): GraphQueryTwin {
  const {
    project,
    nodeCount,
    edgeCount,
    truncated,
    truncationReason,
    degradedReason,
    generatedAt,
  } = input;

  const scope =
    project === null
      ? "entities(all projects)"
      : `entities(project = ${project}) ⊕ boundary(depth 1)`;

  // Each clause names a real predicate the builder applies. Getting one of
  // these subtly wrong is worse than omitting it: the twin's whole job is that
  // a reader can RE-DERIVE the node set, and a plausible-but-false predicate is
  // a reproduction step that silently does not reproduce.
  //
  // Verified against `whole-graph.ts` (FR-237):
  //   - learnings are gated on `review_status = 'approved'` (FR-116 soft-delete
  //     parity — the same gate every recall/search/sync reader uses);
  //   - `session` is ADJACENCY-ONLY: it materialises as a node only when it is
  //     an endpoint of a surviving edge, never in bulk;
  //   - concept/decision come from `graph_nodes`, not a table of their own;
  //   - edges are soft-deleted through `metadata.$.deleted`, NOT a `deleted_at`
  //     column.
  const query = [
    `nodes  ${scope}`,
    "       briefs ∪ learnings(review_status = approved)",
    "       ∪ goals ∪ errors ∪ graph_nodes(concept, decision)",
    "       ∪ sessions(adjacency-only)",
    "edges  entity_edges(metadata.deleted is unset or 0)",
    "       ⊳ intra_project_projection",
    `caps   maxNodes = ${group(BUILDER_MAX_NODES)} · maxEdges = ${group(BUILDER_MAX_EDGES)}`,
  ];

  // The scale line carries the honest state, in precedence order: a graph that
  // could not be built says so instead of printing "0 NODES", which would read
  // as an empty brain rather than as a broken read.
  let scale: string;
  if (degradedReason !== null) {
    scale = `DEGRADED · ${degradedReason}`;
  } else if (truncated) {
    scale =
      `${group(nodeCount)} NODES · ${group(edgeCount)} EDGES · TRUNCATED` +
      (truncationReason !== null ? ` · ${truncationReason}` : "");
  } else {
    scale = `${group(nodeCount)} NODES · ${group(edgeCount)} EDGES`;
  }

  return {
    surface: project === null ? GRAPH_SURFACE_ID : `${GRAPH_SURFACE_ID}/${project}`,
    query,
    as_of: generatedAt,
    scale,
  };
}
