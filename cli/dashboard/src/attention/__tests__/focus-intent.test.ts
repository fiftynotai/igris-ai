import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// React effect dependencies are the actual scheduling boundary. This source
// guard catches a live visibility dependency even when selection itself is gated.
describe("URL focus respects explicit intent", () => {
  it("cannot wake the focus camera when polling makes its target visible", () => {
    const source = readFileSync(new URL("../../pages/Graph.tsx", import.meta.url), "utf8");
    const block = source.slice(source.indexOf("// Select and centre it once"), source.indexOf("  const types ="));
    const dependencies = block.match(/}, \[([^\]]+)\]\);/)?.[1].split(",").map((item) => item.trim());
    expect(dependencies).toBeDefined();
    for (const liveInput of ["focusVisible", "map", "map.visible", "attention.snapshot", "graph.selection", "graph.select"]) expect(dependencies).not.toContain(liveInput);
    expect(dependencies).toEqual(expect.arrayContaining(["focusNode?.key", "graph.settled", "lens", "includeNeighbours", "attentionSession"]));
    expect(block).toContain("if (focusNode === null || !focusVisible) return;");
    // The explicit reveal action reaches one of those dependencies.
    expect(source).toContain('onClick={() => setLens("brain")}>Show in Whole brain');
  });
});
