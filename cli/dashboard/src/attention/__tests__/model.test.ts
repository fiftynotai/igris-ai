import { describe, expect, it } from "vitest";
import { attentionHash, EVIDENCE, eventLabel, evidenceSignature, mergeInventory, parseAttentionSession, partitionEvidence, validSessionId } from "../model";
import { graphFocusHash, parseGraphFocus } from "../../layers/model";
import { event, resource, SESSION_A, SESSION_B, state } from "./fixture";

describe("FR-276 graph session identity and evidence", () => {
  it("round-trips a session while preserving project-qualified focus", () => {
    const hash = attentionHash(SESSION_A, "#/graph?focus=brief%2Fproject%2FBR-1");
    expect(parseAttentionSession(hash)).toBe(SESSION_A);
    expect(new URLSearchParams(hash.split("?")[1]).get("focus")).toBe("brief/project/BR-1");
    expect(parseAttentionSession(attentionHash(null, hash))).toBeNull();
    expect(parseAttentionSession("#/layers?session=" + SESSION_A)).toBeNull();
    expect(validSessionId(SESSION_A)).toBe(true);
    expect(validSessionId("most-recent")).toBe(false);
    expect(validSessionId("00000000-0000-0000-8000-000000000000")).toBe(false);
    expect(validSessionId("00000000-0000-4000-0000-000000000000")).toBe(false);
    expect(validSessionId("00000000-0000-8000-B000-000000000000")).toBe(true);
    expect(parseAttentionSession("#/graph?session=broken")).toBe("broken");
  });
  it("keeps a LOCATE IN GRAPH focus parseable when a session is chosen, switched or cleared", () => {
    // The router reads focus with parseGraphFocus, which splits the raw value on
    // '/'. Re-encoding the query turns those separators into %2F and drops it.
    for (const triple of [{ type: "brief", project: "demo", id: "BR-001" }, { type: "learning", project: "org/repo", id: "a b" }, { type: "os_module", project: null, id: "igris-core:conduct" }]) {
      const focus = graphFocusHash(triple);
      const chosen = attentionHash(SESSION_A, focus);
      expect(parseGraphFocus(chosen)).toEqual(triple);
      expect(parseAttentionSession(chosen)).toBe(SESSION_A);
      const switched = attentionHash(SESSION_B, chosen);
      expect(parseGraphFocus(switched)).toEqual(triple);
      expect(parseAttentionSession(switched)).toBe(SESSION_B);
      expect(attentionHash(null, switched)).toBe(focus);
    }
    expect(attentionHash(null, `#/graph?session=${SESSION_A}`)).toBe("#/graph");
  });
  it("merges by opaque canonical identity, preserving base objects and rejecting collisions", () => {
    const other = { ...resource, key: "different-key", id: "other" };
    const result = mergeInventory([resource], [{ ...resource, label: "duplicate" }, other, { ...resource, project: "different" }]);
    expect(result.nodes).toEqual([resource, other]);
    expect(result.nodes[0]).toBe(resource);
    expect(result.conflicts).toEqual([resource.key]);
    const partitions = partitionEvidence([resource], [state(), state({ key: "missing" }), state({ key: "collision", node: other })]);
    expect([...partitions.onMap.keys()]).toEqual([resource.key]);
    expect(partitions.offMap.map((node) => node.key)).toEqual(["missing", "collision"]);
    expect(partitionEvidence([resource], [state({ node: { ...resource, project: "different" } })]).onMap.size).toBe(0);
  });
  it("keeps categorical marks distinct and failure separate from successful extent", () => {
    expect(new Set(Object.values(EVIDENCE).map((value) => value.mark)).size).toBe(7);
    expect(eventLabel(event())).toBe("Full delivered");
    expect(eventLabel(event({ extent: "preview" }))).toBe("Preview delivered");
    expect(eventLabel(event({ outcome: "failed", extent: "full" }))).toBe("delivery failed");
    expect(eventLabel(event({ kind: "invocation", outcome: "started" }))).toBe("Invocation started");
    expect(eventLabel(event({ kind: "epoch" }))).toBe("Context epoch boundary");
  });
  it("does not wake a canvas for freshly allocated but unchanged snapshots", () => {
    const first = evidenceSignature(new Map([[resource.key, state()]]));
    expect(evidenceSignature(new Map([[resource.key, state()]]))).toBe(first);
    expect(evidenceSignature(new Map([[resource.key, state({ state: "historical", historical: true })]]))).not.toBe(first);
    expect(evidenceSignature(new Map([[resource.key, state({ last_event: event({ sequence: 2 }) })]]))).not.toBe(first);
  });
});
