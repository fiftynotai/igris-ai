import { describe, expect, it } from "vitest";
import type { GraphEdge } from "../../lib/api";
import { attentionLens, edgeVisible, lensTypes, nodeVisible, visibilitySignature } from "../lens";
import { partitionEvidence } from "../model";
import { resource, state } from "./fixture";

const a = resource;
const b = { ...a, key: "b", id: "b" };
const c = { ...a, key: "c", id: "c" };
const isolated = { ...a, key: "isolated", id: "isolated" };
const nodes = [a, b, c, isolated];
const edge = (from: string, to: string): GraphEdge => ({ id: `${from}-${to}`, from, to, source_edge_id: 1, type: "derived_from", confidence: 1, provenance: "observed", resolution: "unique" });
const edges = [edge(a.key, b.key), edge(b.key, c.key)];
const recorded = new Map([[a.key, state()]]);

describe("This chat visibility lens", () => {
  it("shows recorded nodes only and truly excludes unrelated edges and hit targets", () => {
    const lens = attentionLens(nodes, edges, recorded, "chat", false);
    expect(lens.nodeCount).toBe(1); expect(lens.edgeCount).toBe(0);
    expect(nodeVisible(lens.visible, a.key)).toBe(true);
    expect(nodeVisible(lens.visible, b.key)).toBe(false);
    expect(edgeVisible(lens.visible, edges[0])).toBe(false);
  });
  it("adds only one hop, retains the actual semantic relations, and never invents evidence", () => {
    const lens = attentionLens(nodes, edges, recorded, "chat", true);
    expect([...lens.visible!]).toEqual([a.key, b.key]);
    expect(lens.edgeCount).toBe(1);
    expect(lens.neighbours.get(b.key)).toEqual({ node: b, relations: [edges[0]] });
    expect(lens.neighbours.has(c.key)).toBe(false);
    expect(recorded.has(b.key)).toBe(false);
    expect(nodes[0]).toBe(a); expect(edges[0].from).toBe(a.key);
  });
  it("keeps missing and identity-conflicting references outside the map, but inspectable", () => {
    const evidence = partitionEvidence(nodes, [state({ node: { ...a, project: "different" } }), state({ key: "missing" })]);
    expect(evidence.offMap).toHaveLength(2);
    const lens = attentionLens(nodes, edges, evidence.onMap, "chat", true);
    expect(lens.nodeCount).toBe(0); expect(lens.edgeCount).toBe(0);
    expect(nodeVisible(lens.visible, a.key)).toBe(false);
  });
  it("handles isolated activity, empty recordings, whole brain, and session replacement", () => {
    const other = new Map([[isolated.key, state({ key: isolated.key, node: isolated })]]);
    const lens = attentionLens(nodes, edges, other, "chat", true);
    expect([...lens.visible!]).toEqual([isolated.key]); expect(lens.neighbours.size).toBe(0);
    expect(attentionLens(nodes, edges, new Map(), "chat", true).nodeCount).toBe(0);
    const whole = attentionLens(nodes, edges, other, "brain", true);
    expect(whole.visible).toBeNull(); expect(whole.nodeCount).toBe(4); expect(whole.edgeCount).toBe(2);
    expect(whole.neighbours.size).toBe(0);
  });
  it("retains a reachable active filter when its type disappears from the chat", () => {
    const brief = { ...b, type: "brief" };
    const active = new Set(["brief"]);
    expect(lensTypes([a, brief], null, active)).toContainEqual({ type: "brief", count: 1 });
    const types = lensTypes([a, brief], new Set([a.key]), active);
    expect(types).toEqual([{ type: "os_module", count: 1 }, { type: "brief", count: 0 }]);
    const cleared = new Set(active); cleared.delete("brief");
    expect(lensTypes([a, brief], new Set([a.key]), cleared)).toEqual([{ type: "os_module", count: 1 }]);
  });
  it("uses a stable visibility signature across polls, independent of receipt state", () => {
    const before = attentionLens(nodes, edges, recorded, "chat", true);
    const after = attentionLens(nodes, edges, new Map([[a.key, state({ state: "preview" })]]), "chat", true);
    expect(visibilitySignature(before.visible)).toBe(visibilitySignature(after.visible));
    expect(visibilitySignature(new Set(["b", "a"]))).toBe(visibilitySignature(new Set(["a", "b"])));
    expect(visibilitySignature(new Set())).not.toBe(visibilitySignature(null));
  });
});
