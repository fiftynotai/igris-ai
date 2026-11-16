import type { AttentionEvent, AttentionNodeRef, AttentionNodeState, AttentionState, GraphNode } from "../lib/api";

export const EVIDENCE: Record<AttentionState, { mark: string; label: string; meaning: string }> = {
  available: { mark: "A", label: "Available", meaning: "Discovered; delivery or invocation is not established." },
  preview: { mark: "P", label: "Preview delivered", meaning: "A snippet, summary or partial resource was delivered." },
  full: { mark: "F", label: "Full delivered", meaning: "The complete declared resource was delivered; retention is not established." },
  invoked: { mark: "I", label: "Invoked", meaning: "A capability call was observed. Inspect its outcome." },
  failed: { mark: "!", label: "Failed", meaning: "An attempt failed; it does not establish successful delivery." },
  unknown: { mark: "?", label: "Unknown", meaning: "Observation cannot establish a stronger statement." },
  historical: { mark: "H", label: "Historical", meaning: "Evidence belongs to an earlier observed context epoch." },
};

export function parseAttentionSession(hash: string): string | null {
  if (!/^#\/?graph(?:\?|$)/.test(hash)) return null;
  // Preserve malformed IDs so the UI can state the error instead of silently
  // showing a different session. Validation precedes the request.
  return new URLSearchParams(hash.split("?")[1] ?? "").get("session");
}

export function validSessionId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

export function attentionHash(id: string | null, hash = "#/graph"): string {
  // Copy every other pair verbatim: re-encoding would turn the '/' separators
  // of a LOCATE IN GRAPH focus into %2F, which parseGraphFocus cannot split.
  const pairs = (hash.split("?")[1] ?? "").split("&").filter((pair) => pair && pair.split("=")[0] !== "session");
  if (id !== null) pairs.push(`session=${encodeURIComponent(id)}`);
  return `#/graph${pairs.length ? `?${pairs.join("&")}` : ""}`;
}

export function sameNode(a: AttentionNodeRef, b: AttentionNodeRef): boolean {
  return a.type === b.type && a.project === b.project && a.id === b.id;
}

/** Keys are opaque backend identities; never derive or parse a composite key. */
export function mergeInventory(base: readonly GraphNode[], inventory: readonly GraphNode[]): { nodes: GraphNode[]; conflicts: string[] } {
  const index = new Map(base.map((node) => [node.key, node]));
  const conflicts: string[] = [];
  for (const node of inventory) {
    const existing = index.get(node.key);
    if (existing === undefined) index.set(node.key, node);
    else if (!sameNode(existing, node)) conflicts.push(node.key);
  }
  return { nodes: [...index.values()], conflicts };
}

export function partitionEvidence(nodes: readonly GraphNode[], states: readonly AttentionNodeState[]) {
  const index = new Map(nodes.map((node) => [node.key, node]));
  const onMap = new Map<string, AttentionNodeState>();
  const offMap: AttentionNodeState[] = [];
  for (const state of states) {
    const node = index.get(state.key);
    if (node !== undefined && sameNode(node, state.node)) onMap.set(state.key, state);
    else offMap.push(state);
  }
  return { onMap, offMap };
}

export function eventLabel(event: AttentionEvent): string {
  if (event.kind === "epoch") return "Context epoch boundary";
  if (event.kind === "end") return "Recording ended";
  if (event.outcome === "failed") return `${event.kind} failed`;
  if (event.kind === "availability") return "Available";
  if (event.kind === "invocation") return `Invocation ${event.outcome}`;
  if (event.outcome !== "succeeded") return `Delivery ${event.outcome}`;
  return event.extent === "full" ? "Full delivered" : event.extent === "preview" ? "Preview delivered" : "Delivery extent unknown";
}

/** Stable repaint key: generated_at changes on a poll even without new facts. */
export function evidenceSignature(states: ReadonlyMap<string, AttentionNodeState>): string {
  return JSON.stringify([...states].map(([key, value]) => [key, value.state, value.self_reported, value.historical, value.last_event.sequence]));
}
