/**
 * FR-239 (T4) — the exemption-04 query-twin composer.
 *
 * `composeQueryTwin` is pure over its parameters, so every rendering it has to
 * get right — whole-brain, project-scoped, truncated, degraded — is reachable
 * without a brain, a server, or a clock. That is the whole reason it is a
 * separate module rather than an inline template in `routes.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  BUILDER_MAX_EDGES,
  BUILDER_MAX_NODES,
  GRAPH_SURFACE_ID,
  composeQueryTwin,
} from "../lib/dashboard/graph-query.js";
import { resolveWholeGraphModulePath } from "../lib/brain-bridge.js";
import { pathToFileURL } from "node:url";

const AT = "2026-07-29T09:15:00.000Z";

function base(over: Partial<Parameters<typeof composeQueryTwin>[0]> = {}) {
  return composeQueryTwin({
    project: null,
    nodeCount: 2422,
    edgeCount: 1003,
    truncated: false,
    truncationReason: null,
    degradedReason: null,
    generatedAt: AT,
    ...over,
  });
}

describe("T4 — whole-brain twin", () => {
  it("carries the three sanctioned fields and the stable surface id", () => {
    const t = base();
    expect(t.surface).toBe(GRAPH_SURFACE_ID);
    expect(t.as_of).toBe(AT);
    expect(t.scale).toBe("2,422 NODES · 1,003 EDGES");
    expect(t.query.length).toBeGreaterThan(0);
  });

  it("names every clause that can put a glyph on the canvas", () => {
    // dataviz §05 — "no node without provenance". The twin is the statement of
    // that, so every entity type the builder materialises must be named.
    const q = base().query.join("\n");
    for (const clause of [
      "briefs",
      "learnings",
      "goals",
      "errors",
      "concept",
      "decision",
      "sessions",
      "entity_edges",
    ]) {
      expect(q, `twin does not name ${clause}`).toContain(clause);
    }
  });

  it("states the builder's REAL predicates, not plausible-looking ones", () => {
    // A twin whose job is reproducibility fails completely if a predicate is
    // subtly wrong — a reader following it would not reproduce the node set.
    // Each of these was checked against `whole-graph.ts`.
    const q = base().query.join("\n");
    // FR-116 soft-delete parity: the same gate every recall/search reader uses.
    expect(q).toContain("review_status = approved");
    // Sessions are adjacency-only — never materialised in bulk.
    expect(q).toContain("sessions(adjacency-only)");
    // concept/decision live in `graph_nodes`, not tables of their own.
    expect(q).toContain("graph_nodes(concept, decision)");
    // Edge soft-delete is a metadata JSON flag, NOT a `deleted_at` column.
    expect(q).toContain("metadata.deleted");
    expect(q).not.toContain("deleted_at");
  });

  it("states the builder caps, so a capped answer is distinguishable", () => {
    const q = base().query.join("\n");
    expect(q).toContain("15,000");
    expect(q).toContain("20,000");
  });

  it("carries NO viewport field — D5 ships three fields, not four", () => {
    const t = base();
    expect(Object.keys(t).sort()).toEqual(["as_of", "query", "scale", "surface"]);
    expect(JSON.stringify(t).toLowerCase()).not.toContain("viewport");
  });
});

describe("T4 — project-scoped twin", () => {
  it("names the scope AND the depth-1 boundary the drill-down pulls in", () => {
    const t = base({ project: "igris-ai", nodeCount: 812, edgeCount: 400 });
    expect(t.surface).toBe(`${GRAPH_SURFACE_ID}/igris-ai`);
    expect(t.query.join("\n")).toContain("project = igris-ai");
    // D6: a drill-down is a real scope change that pulls boundary nodes. If the
    // twin did not say so, the reader could not re-derive the extra nodes.
    expect(t.query.join("\n")).toContain("boundary(depth 1)");
  });

  it("does not claim a boundary closure on the whole-brain scope", () => {
    expect(base().query.join("\n")).not.toContain("boundary(depth 1)");
  });
});

describe("T4 — truncated twin", () => {
  it("says TRUNCATED and carries the builder's own reason", () => {
    const t = base({
      nodeCount: 15000,
      edgeCount: 20000,
      truncated: true,
      truncationReason: "node cap 15000 reached",
    });
    expect(t.scale).toContain("TRUNCATED");
    expect(t.scale).toContain("node cap 15000 reached");
    expect(t.scale).toContain("15,000 NODES");
  });

  it("survives a truncation with no stated reason", () => {
    const t = base({ truncated: true, truncationReason: null });
    expect(t.scale).toContain("TRUNCATED");
    expect(t.scale).not.toContain("null");
  });
});

describe("T4 — degraded twin", () => {
  it("reports the failure rather than printing an honest-looking zero", () => {
    const t = base({
      nodeCount: 0,
      edgeCount: 0,
      degradedReason: "brain database not found at /nope/knowledge.db",
    });
    // "0 NODES" would read as an empty brain. It is a broken read, and the twin
    // is the only place on the surface that can tell those apart.
    expect(t.scale).toContain("DEGRADED");
    expect(t.scale).toContain("brain database not found");
    expect(t.scale).not.toMatch(/^0 NODES/);
  });

  it("still carries a surface id and an as-of stamp when degraded", () => {
    const t = base({ degradedReason: "engine unavailable" });
    expect(t.surface).toBe(GRAPH_SURFACE_ID);
    expect(t.as_of).toBe(AT);
  });

  it("degradation outranks truncation in the scale line", () => {
    const t = base({
      truncated: true,
      truncationReason: "capped",
      degradedReason: "engine unavailable",
    });
    expect(t.scale).toContain("DEGRADED");
    expect(t.scale).not.toContain("TRUNCATED");
  });
});

describe("T4 — the mirrored cap constants track FR-237", () => {
  it("matches the REAL DEFAULT_MAX_NODES / DEFAULT_MAX_EDGES in the engine", async () => {
    // The twin STATES the caps; it does not apply them (D3 — no second cap).
    // This is the anti-drift pin, and it is read from the vendored builder
    // rather than from a second hand-copied constant — a mirror checked against
    // another mirror proves nothing.
    const modulePath = resolveWholeGraphModulePath();
    expect(modulePath, "no built brain engine in this tree").not.toBeNull();
    const mod = (await import(pathToFileURL(modulePath as string).href)) as {
      DEFAULT_MAX_NODES: number;
      DEFAULT_MAX_EDGES: number;
    };
    expect(BUILDER_MAX_NODES).toBe(mod.DEFAULT_MAX_NODES);
    expect(BUILDER_MAX_EDGES).toBe(mod.DEFAULT_MAX_EDGES);
  });
});
