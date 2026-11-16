import type { AttentionNodeState, GraphEdge, GraphNode } from "../lib/api";

export type AttentionLens = "chat" | "brain";
export interface SemanticNeighbour { node: GraphNode; relations: GraphEdge[] }

/** The immutable topology is never sliced or mutated. These keys gate paint only. */
export function attentionLens(nodes: readonly GraphNode[], edges: readonly GraphEdge[], recorded: ReadonlyMap<string, AttentionNodeState>, lens: AttentionLens, includeNeighbours: boolean) {
  const index = new Map(nodes.map((node) => [node.key, node]));
  const visible = lens === "brain" ? null : new Set([...recorded.keys()].filter((key) => index.has(key)));
  const neighbours = new Map<string, SemanticNeighbour>();
  if (visible !== null && includeNeighbours) {
    // One hop from the recorded set only: newly included neighbours never seed another hop.
    for (const edge of edges) {
      for (const [source, target] of [[edge.from, edge.to], [edge.to, edge.from]]) {
        if (!recorded.has(source) || !index.has(source) || recorded.has(target)) continue;
        const node = index.get(target);
        if (node === undefined) continue;
        visible.add(target);
        const entry = neighbours.get(target) ?? { node, relations: [] };
        entry.relations.push(edge);
        neighbours.set(target, entry);
      }
    }
  }
  const nodeCount = visible?.size ?? nodes.length;
  const edgeCount = visible === null ? edges.length : edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to)).length;
  return { visible, neighbours, nodeCount, edgeCount };
}

export function nodeVisible(visible: ReadonlySet<string> | null, key: string): boolean {
  return visible === null || visible.has(key);
}
export function edgeVisible(visible: ReadonlySet<string> | null, edge: GraphEdge): boolean {
  return nodeVisible(visible, edge.from) && nodeVisible(visible, edge.to);
}
/** Used instead of response identity so unchanged polling causes no redraw. */
export function visibilitySignature(visible: ReadonlySet<string> | null): string {
  return visible === null ? "*" : JSON.stringify([...visible].sort());
}

/** Retain active zero-count chips so narrowing can never hide the way to clear a filter. */
export function lensTypes(nodes: readonly GraphNode[], visible: ReadonlySet<string> | null, active: ReadonlySet<string>) {
  const counts = new Map([...active].map((type) => [type, 0]));
  for (const node of nodes) if (nodeVisible(visible, node.key)) counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  return [...counts].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}
