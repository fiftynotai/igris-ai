/**
 * FR-240 — **extraction equivalence for the 1-hop neighbourhood (D6).**
 *
 * WHAT THIS FILE PROVES
 *   1. `neighboursOf` / `neighboursFrom` return exactly what the code inline in
 *      `useGraph.ts:617-631` returned before FR-240 moved it — asserted against
 *      a VERBATIM COPY of that code, kept below, over fixtures chosen so a
 *      wrong answer differs (self-loops, duplicate edges, dangling endpoints,
 *      degree ties).
 *   2. `useGraph.ts` actually CALLS the extraction rather than keeping its own
 *      copy — a source assertion, because "one definition" is a property of the
 *      file, not of this function.
 *
 * WHY (1) NEEDS (2). An equivalence test alone passes forever in a tree where
 * `useGraph` was never re-pointed: two identical implementations agreeing is
 * exactly the vacuous gate FR-239's learning 1092 describes. The pair is the
 * gate; neither half is.
 *
 * WHAT THIS FILE DOES **NOT** PROVE
 *   That the canvas HIGHLIGHTS the right nodes — `s.active` and `s.activeEdges`
 *   are consumed by the paint layer, which this file never runs.
 *   **Sibling:** `docs/dashboard.md`'s browser checkpoint (G-BR-1), which
 *   clicks a node and reads the inspector's 1-HOP list out of the live DOM.
 *   It also does not prove the record detail RENDERS the neighbours — that is
 *   the Phase-4 view's own gate.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphEdge, GraphNode } from "../../lib/api.js";
import {
  buildAdjacency,
  buildNodeIndex,
  incidentEdgeIds,
  neighboursFrom,
  neighboursOf,
} from "../neighbours.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// THE REFERENCE — `useGraph.ts:617-631` as it stood BEFORE the extraction,
// copied character-for-character apart from being wrapped in a function and
// taking its inputs as parameters instead of reading closure state.
//
// Do not "tidy" this. Its whole value is that it is the OLD code. If the
// extraction's behaviour must change, this copy is what makes the change
// visible instead of silent.
// ---------------------------------------------------------------------------
function referenceNeighbourhood(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  key: string,
): { active: Set<string>; activeEdges: Set<string>; neighbours: GraphNode[] } {
  const nodesByKey = new Map<string, GraphNode>();
  for (const n of nodes) nodesByKey.set(n.key, n);

  const adjacency = new Map<string, Set<string>>();
  const add = (a: string, b: string): void => {
    const s = adjacency.get(a);
    if (s === undefined) adjacency.set(a, new Set([b]));
    else s.add(b);
  };
  for (const e of edges) {
    add(e.from, e.to);
    add(e.to, e.from);
  }

  const hop = adjacency.get(key) ?? new Set<string>();
  const active = new Set([key, ...hop]);
  const activeEdges = new Set(
    edges.filter((e) => e.from === key || e.to === key).map((e) => e.id),
  );
  const neighbours = [...hop]
    .map((k) => nodesByKey.get(k))
    .filter((n): n is GraphNode => n !== undefined)
    .sort((a, b) => b.degree - a.degree || (a.key < b.key ? -1 : 1));

  return { active, activeEdges, neighbours };
}

// ---------------------------------------------------------------------------
// Fixtures. Each one is built so a WRONG implementation gives a DIFFERENT
// answer — a fixture where every candidate implementation agrees proves
// nothing (learning 1092 / the plan's G-EP-1 rule, applied client-side).
// ---------------------------------------------------------------------------

function node(key: string, degree: number): GraphNode {
  const [type = "brief", project = "", id = key] = key.split("|");
  return {
    key,
    type,
    id,
    project: project.length > 0 ? project : null,
    label: key,
    attrs: {},
    degree,
  };
}

function edge(id: string, from: string, to: string): GraphEdge {
  return {
    id,
    source_edge_id: Number(id.replace(/\D/g, "")) || 1,
    from,
    to,
    type: "derived_from",
    confidence: 1,
    provenance: "observed",
    resolution: "unique",
  };
}

interface Fixture {
  name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Keys worth asking about, including ones with no edges at all. */
  probes: string[];
}

const FIXTURES: Fixture[] = [
  {
    name: "a star — the selected node is the hub",
    nodes: [node("brief|a|BR-1", 3), node("learning|a|1", 1), node("learning|a|2", 1), node("goal||GL-1", 1)],
    edges: [
      edge("e1", "brief|a|BR-1", "learning|a|1"),
      edge("e2", "brief|a|BR-1", "learning|a|2"),
      edge("e3", "goal||GL-1", "brief|a|BR-1"),
    ],
    probes: ["brief|a|BR-1", "learning|a|1", "goal||GL-1", "missing|x|9"],
  },
  {
    name: "direction is discarded — an INCOMING edge is still a neighbour",
    nodes: [node("brief|a|BR-1", 1), node("brief|a|BR-2", 1)],
    edges: [edge("e1", "brief|a|BR-2", "brief|a|BR-1")],
    probes: ["brief|a|BR-1", "brief|a|BR-2"],
  },
  {
    name: "a self-loop puts the node in its OWN hop set (preserved oddity)",
    nodes: [node("brief|a|BR-1", 1)],
    edges: [edge("e1", "brief|a|BR-1", "brief|a|BR-1")],
    probes: ["brief|a|BR-1"],
  },
  {
    name: "duplicate edges between the same pair collapse to one neighbour",
    nodes: [node("brief|a|BR-1", 2), node("brief|a|BR-2", 2)],
    edges: [
      edge("e1", "brief|a|BR-1", "brief|a|BR-2"),
      edge("e2", "brief|a|BR-1", "brief|a|BR-2"),
    ],
    probes: ["brief|a|BR-1"],
  },
  {
    name: "a dangling endpoint contributes a key that hydrates to nothing",
    nodes: [node("brief|a|BR-1", 1)],
    edges: [edge("e1", "brief|a|BR-1", "brief|a|GONE")],
    probes: ["brief|a|BR-1", "brief|a|GONE"],
  },
  {
    name: "degree ties break on key ASC, not on insertion order",
    nodes: [
      node("brief|a|HUB", 3),
      node("brief|a|zzz", 2),
      node("brief|a|mmm", 2),
      node("brief|a|aaa", 2),
    ],
    edges: [
      edge("e1", "brief|a|HUB", "brief|a|zzz"),
      edge("e2", "brief|a|HUB", "brief|a|mmm"),
      edge("e3", "brief|a|HUB", "brief|a|aaa"),
    ],
    probes: ["brief|a|HUB"],
  },
  {
    name: "BR-078 — the same id in two projects is two distinct nodes",
    nodes: [
      node("brief|alpha|BR-001", 1),
      node("brief|beta|BR-001", 1),
      node("learning|alpha|7", 2),
    ],
    edges: [
      edge("e1", "brief|alpha|BR-001", "learning|alpha|7"),
      edge("e2", "brief|beta|BR-001", "learning|alpha|7"),
    ],
    probes: ["brief|alpha|BR-001", "brief|beta|BR-001", "learning|alpha|7"],
  },
  {
    name: "an empty graph",
    nodes: [],
    edges: [],
    probes: ["brief|a|BR-1"],
  },
];

describe("neighboursOf is equivalent to the pre-extraction inline code", () => {
  for (const fx of FIXTURES) {
    for (const key of fx.probes) {
      it(`${fx.name} — probe ${key}`, () => {
        const ref = referenceNeighbourhood(fx.nodes, fx.edges, key);
        const got = neighboursOf(fx.nodes, fx.edges, key);

        // Ordered comparison: the ORDER is part of the contract (the inspector
        // shows the first 12 of it), so `toEqual` on the arrays, not on sets.
        expect(got.neighbours).toEqual(ref.neighbours);
        // `s.active` is `key` plus the hop set — reconstructed the way
        // `useGraph` reconstructs it.
        expect(new Set([key, ...got.hop])).toEqual(ref.active);
        expect(incidentEdgeIds(fx.edges, key)).toEqual(ref.activeEdges);
      });
    }
  }

  it("the pre-built-index form agrees with the payload form", () => {
    // `useGraph` calls `neighboursFrom` with memoised indexes; the detail view
    // calls `neighboursOf` with a payload. They must be the same answer, or the
    // canvas and the detail can diverge for the same node.
    for (const fx of FIXTURES) {
      const index = buildNodeIndex(fx.nodes);
      const adjacency = buildAdjacency(fx.edges);
      for (const key of fx.probes) {
        expect(neighboursFrom(index, adjacency, key)).toEqual(
          neighboursOf(fx.nodes, fx.edges, key),
        );
      }
    }
  });
});

describe("the fixtures DISAGREE — a wrong implementation would be caught", () => {
  /**
   * Learning 1094, applied to an equivalence test: if the fixtures were all
   * trivially symmetric, an implementation that ignored edge direction, or
   * order, or deduplication would still pass. These assert the fixtures
   * actually exercise each of those.
   */
  it("at least one fixture is sensitive to ORDER", () => {
    const fx = FIXTURES.find((f) => f.name.startsWith("degree ties"));
    if (fx === undefined) throw new Error("fixture missing");
    const got = neighboursOf(fx.nodes, fx.edges, "brief|a|HUB").neighbours;
    expect(got.map((n) => n.id)).toEqual(["aaa", "mmm", "zzz"]);
  });

  it("at least one fixture is sensitive to DEDUPLICATION", () => {
    const fx = FIXTURES.find((f) => f.name.startsWith("duplicate edges"));
    if (fx === undefined) throw new Error("fixture missing");
    expect(neighboursOf(fx.nodes, fx.edges, "brief|a|BR-1").neighbours).toHaveLength(1);
    // ...while the incident EDGE ids do not collapse: two edges, two ids.
    expect(incidentEdgeIds(fx.edges, "brief|a|BR-1").size).toBe(2);
  });

  it("at least one fixture is sensitive to DIRECTION being discarded", () => {
    const fx = FIXTURES.find((f) => f.name.startsWith("direction"));
    if (fx === undefined) throw new Error("fixture missing");
    // BR-1 is only ever a TARGET, and it still has a neighbour.
    expect(neighboursOf(fx.nodes, fx.edges, "brief|a|BR-1").neighbours).toHaveLength(1);
  });

  it("a dangling endpoint is dropped from `neighbours` but kept in `hop`", () => {
    const fx = FIXTURES.find((f) => f.name.startsWith("a dangling"));
    if (fx === undefined) throw new Error("fixture missing");
    const got = neighboursOf(fx.nodes, fx.edges, "brief|a|BR-1");
    expect(got.hop.has("brief|a|GONE")).toBe(true);
    expect(got.neighbours).toEqual([]);
  });
});

describe("useGraph really calls the extraction — there is ONE definition", () => {
  const source = readFileSync(join(HERE, "..", "useGraph.ts"), "utf-8");

  it("imports the extracted functions", () => {
    expect(source).toContain('from "./neighbours"');
    for (const fn of [
      "buildNodeIndex",
      "buildAdjacency",
      "neighboursFrom",
      "incidentEdgeIds",
    ]) {
      expect(source, `useGraph does not import ${fn}`).toContain(fn);
    }
  });

  it("keeps NO inline adjacency construction of its own", () => {
    // The pre-extraction shape was `add(e.from, e.to); add(e.to, e.from);`
    // inside a `useMemo`. If that string is back, so is the second definition.
    expect(source).not.toContain("add(e.from, e.to)");
    expect(source).not.toContain("new Map<string, Set<string>>()");
  });

  it("keeps NO inline hop hydration of its own", () => {
    expect(source).not.toContain("adjacency.get(key)");
    expect(source).not.toMatch(/\.sort\(\(a, b\) => b\.degree - a\.degree/);
  });

  it("the source assertion is not vacuous — the file was really read", () => {
    // A path typo would make every `not.toContain` above pass over an empty
    // string. This is the self-negative-control for those three.
    expect(source.length).toBeGreaterThan(10_000);
    expect(source).toContain("export function useGraph");
  });
});
