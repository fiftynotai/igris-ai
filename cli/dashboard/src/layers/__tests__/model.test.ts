/**
 * FR-240 — the layer model: **the deep-link codec (D5 / BR-078), the filter
 * query construction, and the AC-#6 empty-state selection.**
 *
 * WHAT THIS FILE PROVES
 *   - A record address round-trips, and `BR-001` in two projects round-trips to
 *     TWO DISTINCT addresses. This is the plan's named mitigation for the
 *     highest-impact risk in the brief ("deep links key on `id` alone somewhere
 *     in the chain and fuse briefs across projects — the exact BR-078 defect").
 *   - The four empty-state kinds are selected by the right conditions, in the
 *     right precedence — a degraded brain never renders as an empty one.
 *   - A filter is only "active" when it narrows, so an untouched learnings view
 *     (which always sends `review_status=approved`) does not claim to be filtered.
 *
 * WHAT IT DOES **NOT** PROVE
 *   That the ROUTER calls this codec, or that the views call `emptyStateFor`.
 *   A perfect codec nothing uses is worth nothing.
 *   **Siblings:** `cli/src/__tests__/dashboard-layers-source.test.ts` (asserts
 *   `router.tsx` imports the codec and that no browser file reimplements the
 *   composite key) and the Phase-4 view render tests in
 *   `pages/layers/__tests__/`.
 *   It also does not prove the SERVER honours the address — that is
 *   `dashboard-layers-endpoint.test.ts`'s G-EP-2.
 */

import { describe, expect, it } from "vitest";
import type { ContextDocsPayload, GoalListRowPayload, GraphNode } from "../../lib/api.js";
import {
  DEFAULT_REVIEW_STATUS,
  FILTERS,
  briefsSearchQuery,
  LAYERS,
  LAYER_IDS,
  daysUntil,
  deadlineLabel,
  emptyStateFor,
  findNode,
  graphFocusHash,
  graphHrefForRecord,
  hasActiveFilters,
  hasNext,
  hasPrev,
  layerById,
  layerForNodeType,
  layerHash,
  listQuery,
  muteRows,
  nextOffset,
  orderInventory,
  pageLabel,
  parseGraphFocus,
  parseLayersHash,
  prevOffset,
  recordHash,
  recordHrefForNode,
  searchQuery,
  splitTags,
  type RecordAddress,
} from "../model.js";

// ===========================================================================
// 1 — D5 / BR-078: the address codec
// ===========================================================================

describe("BR-078 · the (type, project, id) triple survives the URL", () => {
  const CASES: RecordAddress[] = [
    { layer: "briefs", project: "igris-ai", id: "BR-001" },
    { layer: "learnings", project: "igris-ai", id: "1092" },
    { layer: "context-docs", project: "igris-ai", id: "coding_guidelines" },
    { layer: "goals", project: null, id: "GL-012" },
    // Hostile-ish but legal inputs: a slug with a dash, an id with a slash, a
    // project with a space, and a value containing the segment separator. Each
    // must survive, because each would silently break a naive `split("/")`.
    { layer: "briefs", project: "fifty-flutter-kit", id: "TD-096" },
    { layer: "briefs", project: "a b", id: "BR-1/2" },
    { layer: "briefs", project: "with#hash", id: "with?query" },
    { layer: "briefs", project: "with%percent", id: "with&amp" },
  ];

  it.each(CASES)("round-trips %j", (addr) => {
    const hash = recordHash(addr);
    const parsed = parseLayersHash(hash);
    expect(parsed.layer).toBe(addr.layer);
    expect(parsed.address).toEqual(addr);
  });

  /**
   * THE CASE THE PLAN NAMES BY NAME.
   *
   * `BR-001` names a different brief in 25 projects. If the address were the id
   * alone — or if the project segment were dropped anywhere in the chain — these
   * two would collapse into one, and the operator would read the wrong brief
   * while the URL looked right. 75% of briefs were fusing this way before
   * BR-078 fixed it in the graph; this test is what stops FR-240 from
   * reintroducing it one layer up.
   */
  it("the SAME id in two projects makes two DISTINCT addresses", () => {
    const alpha: RecordAddress = { layer: "briefs", project: "igris-ai", id: "BR-001" };
    const beta: RecordAddress = { layer: "briefs", project: "cosmic-lab", id: "BR-001" };

    const alphaHash = recordHash(alpha);
    const betaHash = recordHash(beta);

    expect(alphaHash).not.toBe(betaHash);
    expect(parseLayersHash(alphaHash).address).toEqual(alpha);
    expect(parseLayersHash(betaHash).address).toEqual(beta);
    // And the parsed projects are not merely different strings — they are the
    // right ones round the right way.
    expect(parseLayersHash(alphaHash).address?.project).toBe("igris-ai");
    expect(parseLayersHash(betaHash).address?.project).toBe("cosmic-lab");
  });

  it("a global record uses an EMPTY middle segment, not a sentinel", () => {
    // Matching the brain's own key convention ("empty middle segment =
    // global"). A `-` sentinel could one day collide with a real slug.
    expect(recordHash({ layer: "goals", project: null, id: "GL-9" })).toBe(
      "#/layers/goals//GL-9",
    );
    expect(parseLayersHash("#/layers/goals//GL-9").address).toEqual({
      layer: "goals",
      project: null,
      id: "GL-9",
    });
  });

  it("a list route parses to no address", () => {
    for (const id of LAYER_IDS) {
      const parsed = parseLayersHash(layerHash(id));
      expect(parsed.layer).toBe(id);
      expect(parsed.address).toBeNull();
    }
  });

  it("an unknown layer falls back to the first, never to a guess", () => {
    expect(parseLayersHash("#/layers/nonsense").layer).toBe("briefs");
    expect(parseLayersHash("#/layers").layer).toBe("briefs");
    expect(parseLayersHash("#/layers/").layer).toBe("briefs");
  });

  it("a malformed tail yields NO address rather than a partial one", () => {
    // An ambiguous identity must refuse, not first-match. Every one of these
    // is missing a segment or carries an invalid escape.
    for (const hash of [
      "#/layers/briefs/igris-ai",
      "#/layers/briefs/igris-ai/",
      "#/layers/briefs/%zz/BR-1",
      "#/layers/briefs/igris-ai/%",
    ]) {
      expect(parseLayersHash(hash).address, hash).toBeNull();
    }
  });

  it("ignores a query string on a layers route", () => {
    expect(parseLayersHash("#/layers/briefs/igris-ai/BR-1?x=1").address).toEqual({
      layer: "briefs",
      project: "igris-ai",
      id: "BR-1",
    });
  });
});

describe("the graph focus codec is the same triple, the other way", () => {
  it("round-trips a project-scoped and a global node", () => {
    for (const triple of [
      { type: "brief", project: "igris-ai", id: "BR-001" },
      { type: "goal", project: null, id: "GL-012" },
      { type: "learning", project: "a b/c", id: "1092" },
    ]) {
      expect(parseGraphFocus(graphFocusHash(triple))).toEqual(triple);
    }
  });

  it("the same id in two projects focuses two different nodes", () => {
    const a = graphFocusHash({ type: "brief", project: "alpha", id: "BR-001" });
    const b = graphFocusHash({ type: "brief", project: "beta", id: "BR-001" });
    expect(a).not.toBe(b);
    expect(parseGraphFocus(a)?.project).toBe("alpha");
    expect(parseGraphFocus(b)?.project).toBe("beta");
  });

  it("returns null for an absent or malformed focus", () => {
    for (const hash of [
      "#/graph",
      "#/graph?other=1",
      "#/graph?focus=brief/only-two",
      "#/graph?focus=brief/a/b/c",
      "#/graph?focus=%zz/a/b",
      "#/graph?focus=/a/b",
      "#/graph?focus=brief/a/",
    ]) {
      expect(parseGraphFocus(hash), hash).toBeNull();
    }
  });
});

describe("the two cross-link directions agree about which layer owns a type", () => {
  it("maps every layer's node type back to that layer", () => {
    for (const layer of LAYERS) {
      if (layer.nodeType === null) continue;
      expect(layerForNodeType(layer.nodeType)?.id).toBe(layer.id);
    }
  });

  it("OPEN RECORD is null for a node type with no detail view", () => {
    // Session, concept, decision and cluster nodes are real graph nodes with no
    // FR-240 view. `null` is what makes the inspector render an explicit
    // "no detail view" state instead of a link to a blank page.
    for (const type of ["session", "concept", "decision", "cluster", "project"]) {
      expect(recordHrefForNode({ type, project: "igris-ai", id: "x" }), type).toBeNull();
    }
  });

  it("OPEN RECORD drops the project for a globally-addressed layer", () => {
    // A goal's id is a brain-allocated global sequence, so its address carries
    // no project even when the graph node reports one.
    expect(recordHrefForNode({ type: "goal", project: "igris-ai", id: "GL-1" })).toBe(
      "#/layers/goals//GL-1",
    );
  });

  it("LOCATE IN GRAPH is null for context docs — they have no node", () => {
    // D8: context docs are files on disk. The absence is a fact about the data
    // model, not a missing feature.
    expect(
      graphHrefForRecord({ layer: "context-docs", project: "igris-ai", id: "coding_guidelines" }),
    ).toBeNull();
  });

  it("a round trip through BOTH directions preserves the record", () => {
    const addr: RecordAddress = { layer: "briefs", project: "igris-ai", id: "BR-001" };
    const graphHref = graphHrefForRecord(addr);
    if (graphHref === null) throw new Error("expected a graph href");
    const focus = parseGraphFocus(graphHref);
    if (focus === null) throw new Error("expected a focus");
    expect(recordHrefForNode(focus)).toBe(recordHash(addr));
  });
});

describe("findNode matches on the structured triple, never on a key", () => {
  const nodes: GraphNode[] = [
    {
      key: "brief|igris-ai|BR-001",
      type: "brief",
      id: "BR-001",
      project: "igris-ai",
      label: "alpha",
      attrs: {},
      degree: 3,
    },
    {
      key: "brief|cosmic-lab|BR-001",
      type: "brief",
      id: "BR-001",
      project: "cosmic-lab",
      label: "beta",
      attrs: {},
      degree: 1,
    },
    {
      key: "goal||GL-1",
      type: "goal",
      id: "GL-1",
      project: null,
      label: "a goal",
      attrs: {},
      degree: 2,
    },
  ];

  it("distinguishes the same id in two projects", () => {
    expect(findNode(nodes, { type: "brief", project: "igris-ai", id: "BR-001" })?.label).toBe("alpha");
    expect(findNode(nodes, { type: "brief", project: "cosmic-lab", id: "BR-001" })?.label).toBe("beta");
  });

  it("matches a global node on a null project", () => {
    expect(findNode(nodes, { type: "goal", project: null, id: "GL-1" })?.key).toBe("goal||GL-1");
  });

  it("does NOT match a global node when a project is supplied", () => {
    expect(findNode(nodes, { type: "goal", project: "igris-ai", id: "GL-1" })).toBeNull();
  });

  it("returns null rather than a first match on a type mismatch", () => {
    expect(findNode(nodes, { type: "learning", project: "igris-ai", id: "BR-001" })).toBeNull();
  });
});

// ===========================================================================
// 2 — filters and the query they become
// ===========================================================================

describe("filters narrow only when they narrow", () => {
  it("an untouched learnings view is NOT 'filtered' despite sending a default", () => {
    // The view always sends `review_status=approved` (D9). If that counted as a
    // filter, an empty project would report "nothing matches this filter",
    // which is a lie that sends the operator hunting for a filter to clear.
    expect(hasActiveFilters("learnings", { review_status: DEFAULT_REVIEW_STATUS })).toBe(false);
    expect(hasActiveFilters("learnings", { review_status: "pending_review" })).toBe(true);
  });

  it("an empty-string value is not a filter", () => {
    expect(hasActiveFilters("briefs", { status: "" })).toBe(false);
    expect(hasActiveFilters("briefs", { status: "open" })).toBe(true);
  });

  it("an unknown key is ignored — it is not one of the layer's filters", () => {
    expect(hasActiveFilters("briefs", { nonsense: "x" })).toBe(false);
  });

  it("context docs declare ONLY the FR-246 text filter — no chips", () => {
    // Was `toEqual([])` before FR-246. The chip half of that claim is still
    // true and is the part worth keeping: the inventory is a complete
    // per-project list from one digest call, so a client-side chip over 12 rows
    // would look like the other layers' filters and mean something else. What
    // changed is that the doc BODIES are prose on disk, and `?q=` greps them
    // SERVER-side — which no chip and no client-side filter could do.
    expect(FILTERS["context-docs"].map((d) => d.name)).toEqual(["q"]);
    expect(hasActiveFilters("context-docs", { status: "x" })).toBe(false);
    expect(hasActiveFilters("context-docs", { q: "kiln" })).toBe(true);
  });

  it("emits only known filter names, encoded", () => {
    const q = listQuery({
      layer: "briefs",
      project: "igris ai/1",
      values: { status: "open", nonsense: "drop me", priority: "" },
      limit: 50,
      offset: 100,
    });
    expect(q.get("project")).toBe("igris ai/1");
    expect(q.get("status")).toBe("open");
    expect(q.get("limit")).toBe("50");
    expect(q.get("offset")).toBe("100");
    expect(q.has("nonsense")).toBe(false);
    // An empty value is omitted entirely rather than sent as `priority=`.
    expect(q.has("priority")).toBe(false);
    // And the encoding is real — a raw slash in a query value would split a path.
    expect(q.toString()).toContain("igris+ai%2F1");
  });

  it("omits the project entirely when none is selected", () => {
    const q = listQuery({ layer: "goals", project: null, values: {}, limit: 10, offset: 0 });
    expect(q.has("project")).toBe(false);
  });

  it("the search query sends q, the project and review_status — and no more", () => {
    const q = searchQuery({
      query: "vector recall",
      project: "igris-ai",
      values: { review_status: "pending_review", category: "pattern" },
      limit: 20,
    });
    expect(q.get("q")).toBe("vector recall");
    expect(q.get("project")).toBe("igris-ai");
    expect(q.get("review_status")).toBe("pending_review");
    // `category` is NOT a search filter; sending it would come back in the
    // endpoint's `params` array as an unknown filter — the UI reporting its
    // own bug to the operator.
    expect(q.has("category")).toBe(false);
  });
});

describe("pagination arithmetic", () => {
  it("labels the window the operator is looking at", () => {
    expect(pageLabel({ limit: 50, offset: 0, total: 615, count: 50 })).toBe("1-50 OF 615");
    expect(pageLabel({ limit: 50, offset: 600, total: 615, count: 15 })).toBe("601-615 OF 615");
    expect(pageLabel({ limit: 50, offset: 0, total: 0, count: 0 })).toBe("0 OF 0");
  });

  it("knows when there is a previous and a next page", () => {
    const first = { limit: 50, offset: 0, total: 615, count: 50 };
    const last = { limit: 50, offset: 600, total: 615, count: 15 };
    expect(hasPrev(first)).toBe(false);
    expect(hasNext(first)).toBe(true);
    expect(hasPrev(last)).toBe(true);
    expect(hasNext(last)).toBe(false);
  });

  it("a full LAST page is not followed by an empty one", () => {
    // 100 of 100 shown: `offset + count === total`, so NEXT is off. Getting
    // this wrong produces a page that says "0 OF 100" and looks like data loss.
    expect(hasNext({ limit: 50, offset: 50, total: 100, count: 50 })).toBe(false);
  });

  it("clamps both directions", () => {
    expect(prevOffset({ limit: 50, offset: 20, total: 615, count: 50 })).toBe(0);
    expect(nextOffset({ limit: 50, offset: 600, total: 615, count: 15 })).toBe(614);
    expect(nextOffset({ limit: 50, offset: 0, total: 0, count: 0 })).toBe(0);
  });
});

// ===========================================================================
// 3 — AC #6: four empty states, and the precedence between them
// ===========================================================================

describe("AC #6 · the empty states are distinct, and degraded wins", () => {
  const base = {
    layer: "briefs" as const,
    total: 0,
    degraded: null as string | null,
    filtersActive: false,
    searchActive: false,
    project: "igris-ai" as string | null,
  };

  it("a degraded brain is NEVER reported as an empty one", () => {
    const got = emptyStateFor({ ...base, degraded: "brain database not found at /x/brain.db" });
    expect(got.kind).toBe("degraded");
    // The reason is carried VERBATIM — a paraphrase costs the operator the
    // path they need.
    expect(got.meta).toBe("brain database not found at /x/brain.db");
  });

  it("degraded outranks filtered AND empty, together", () => {
    const got = emptyStateFor({
      ...base,
      degraded: "readers unavailable",
      filtersActive: true,
      searchActive: true,
    });
    expect(got.kind).toBe("degraded");
  });

  it("a set filter reports FILTERED, not empty", () => {
    expect(emptyStateFor({ ...base, filtersActive: true }).kind).toBe("filtered");
  });

  it("the client-side text mute reports FILTERED, and says so", () => {
    const got = emptyStateFor({ ...base, searchActive: true });
    expect(got.kind).toBe("filtered");
    // It must be clear this was the TEXT mute over one page, not a query.
    expect(got.meta).toContain("text mute");
    expect(got.message).toContain("page");
  });

  it("nothing set at all reports EMPTY, naming what fills it", () => {
    const got = emptyStateFor(base);
    expect(got.kind).toBe("empty");
    expect(got.message).toContain("/hunt");
    expect(got.meta).toContain("igris-ai");
  });

  it("names a DIFFERENT command per layer", () => {
    const messages = LAYER_IDS.map(
      (layer) => emptyStateFor({ ...base, layer }).message,
    );
    // Four layers, four distinct next actions. A shared "nothing here" for all
    // four is the AC #6 failure this asserts against.
    expect(new Set(messages).size).toBe(LAYER_IDS.length);
    expect(messages.some((m) => m.includes("/harvest"))).toBe(true);
    expect(messages.some((m) => m.includes("/ground"))).toBe(true);
  });

  it("context docs with no project selected report NO-PROJECT", () => {
    const got = emptyStateFor({
      ...base,
      layer: "context-docs",
      project: null,
      projectRequired: true,
    });
    expect(got.kind).toBe("no-project");
  });

  it("all four kinds are reachable, with four distinct headlines", () => {
    // The self-negative-control for this block: a selector that returned one
    // constant would pass every individual assertion above that only checks
    // `kind`. Four distinct headlines cannot come from one constant.
    const kinds = new Set<string>();
    const headlines = new Set<string>();
    for (const input of [
      { ...base, degraded: "x" },
      { ...base, layer: "context-docs" as const, project: null, projectRequired: true },
      { ...base, filtersActive: true },
      base,
    ]) {
      const got = emptyStateFor(input);
      kinds.add(got.kind);
      headlines.add(got.headline);
    }
    expect(kinds).toEqual(new Set(["degraded", "no-project", "filtered", "empty"]));
    expect(headlines.size).toBe(4);
  });
});

// ===========================================================================
// 4 — the small per-layer readers
// ===========================================================================

describe("the client-side text mute", () => {
  const rows = [{ title: "Vector recall", id: 1 }, { title: "BM25 only", id: 2 }];
  const fields = (r: (typeof rows)[number]) => [r.title, r.id];

  it("returns everything for an empty query", () => {
    expect(muteRows(rows, "", fields)).toHaveLength(2);
    expect(muteRows(rows, "   ", fields)).toHaveLength(2);
  });

  it("matches case-insensitively, on any listed field", () => {
    expect(muteRows(rows, "VECTOR", fields)).toHaveLength(1);
    // A NUMERIC field is matched as its string form — so an operator can paste
    // a learning id into the box and find the row.
    expect(muteRows(rows, "2", fields)).toEqual([{ title: "BM25 only", id: 2 }]);
    expect(muteRows(rows, "1", fields)).toEqual([{ title: "Vector recall", id: 1 }]);
  });

  it("returns an EMPTY array rather than everything on no match", () => {
    // The distinction that makes "nothing matches this filter" reachable.
    expect(muteRows(rows, "zzz", fields)).toEqual([]);
  });

  it("does not mutate or alias the input", () => {
    const out = muteRows(rows, "", fields);
    expect(out).not.toBe(rows);
  });
});

describe("splitTags survives both shapes the column has held", () => {
  it("parses a JSON array", () => {
    expect(splitTags('["vector","recall"]')).toEqual(["vector", "recall"]);
  });

  it("parses a comma-separated list", () => {
    expect(splitTags("vector, recall ,rrf")).toEqual(["vector", "recall", "rrf"]);
  });

  it("falls back to the comma split on malformed JSON", () => {
    // Rendering `["a` as one chip is worse than rendering two odd ones.
    expect(splitTags('["a", "b"')).toEqual(['["a"', '"b"']);
  });

  it("is empty for null, empty and whitespace", () => {
    expect(splitTags(null)).toEqual([]);
    expect(splitTags("")).toEqual([]);
    expect(splitTags("   ")).toEqual([]);
    expect(splitTags("[]")).toEqual([]);
  });
});

describe("deadlines", () => {
  const NOW = new Date("2026-07-30T12:00:00Z");

  it("counts whole days in both directions", () => {
    expect(daysUntil("2026-08-09T12:00:00Z", NOW)).toBe(10);
    expect(daysUntil("2026-07-27T12:00:00Z", NOW)).toBe(-3);
    expect(daysUntil("2026-07-30T12:00:00Z", NOW)).toBe(0);
  });

  it("is null for a missing or unparseable deadline", () => {
    expect(daysUntil(null, NOW)).toBeNull();
    expect(daysUntil("", NOW)).toBeNull();
    expect(daysUntil("not a date", NOW)).toBeNull();
  });

  it("labels overdue, today, future and absent DIFFERENTLY", () => {
    const goal = (deadline: string | null): GoalListRowPayload => ({
      id: 1,
      goal_id: "GL-1",
      project_slug: "igris-ai",
      title: "t",
      description: null,
      outcome: "o",
      deadline,
      status: "active",
      priority: "high",
      created_at: "2026-07-01",
      updated_at: "2026-07-01",
      achieved_at: null,
      metadata: "{}",
      serving_briefs_count: 2,
    });
    const labels = [
      deadlineLabel(goal("2026-07-20T12:00:00Z"), NOW),
      deadlineLabel(goal("2026-07-30T12:00:00Z"), NOW),
      deadlineLabel(goal("2026-08-30T12:00:00Z"), NOW),
      deadlineLabel(goal(null), NOW),
    ];
    expect(labels).toEqual(["OVERDUE 10d", "DUE TODAY", "IN 31d", "NO DEADLINE"]);
  });
});

describe("orderInventory puts the actionable rows where they can be seen", () => {
  const row = (
    type: string,
    exists: boolean,
    missing_applicable: boolean,
  ): ContextDocsPayload["docs"][number] => ({
    type,
    target: `${type}.md`,
    applies_when: "always",
    applies: "yes" as ContextDocsPayload["docs"][number]["applies"],
    optional: false,
    summary: "",
    exists,
    missing_applicable,
  });

  it("orders existing, then applicable-but-missing, then the rest — type ASC", () => {
    const payload = {
      docs: [
        row("zeta", false, false),
        row("api_pattern", false, true),
        row("coding_guidelines", true, false),
        row("alpha", false, false),
        row("architecture_map", true, false),
      ],
    } as ContextDocsPayload;
    expect(orderInventory(payload).map((d) => d.type)).toEqual([
      "architecture_map",
      "coding_guidelines",
      "api_pattern",
      "alpha",
      "zeta",
    ]);
  });

  it("does not mutate the payload", () => {
    const docs = [row("b", false, false), row("a", true, false)];
    const payload = { docs } as ContextDocsPayload;
    orderInventory(payload);
    expect(payload.docs.map((d) => d.type)).toEqual(["b", "a"]);
  });
});

describe("the layer table is complete and self-consistent", () => {
  it("has one descriptor per id, in id order", () => {
    expect(LAYERS.map((l) => l.id)).toEqual([...LAYER_IDS]);
    for (const id of LAYER_IDS) expect(layerById(id)?.id).toBe(id);
    expect(layerById("nope")).toBeNull();
  });

  it("gives every layer distinct copy, so no view is a clone of another", () => {
    expect(new Set(LAYERS.map((l) => l.eye)).size).toBe(LAYERS.length);
    expect(new Set(LAYERS.map((l) => l.lede)).size).toBe(LAYERS.length);
    expect(new Set(LAYERS.map((l) => l.label)).size).toBe(LAYERS.length);
  });

  it("declares exactly one layer with no graph node type", () => {
    expect(LAYERS.filter((l) => l.nodeType === null).map((l) => l.id)).toEqual([
      "context-docs",
    ]);
  });

  it("declares exactly one globally-addressed layer", () => {
    expect(LAYERS.filter((l) => !l.projectScoped).map((l) => l.id)).toEqual(["goals"]);
  });
});

// ---------------------------------------------------------------------------
// FR-246 — `q` as a FILTER, and the briefs search query
// ---------------------------------------------------------------------------

describe("FR-246 — the `q` substring filter is a filter, not a second mode", () => {
  it("`q` is registered on every surface that has one, and NOT on briefs", () => {
    // Briefs is deliberately absent: it got REAL retrieval
    // (`/api/briefs/search`), which replaces the browse list rather than
    // narrowing it. A `q` chip there would be a second, weaker search box on
    // the one page that does not need one.
    for (const layer of ["learnings", "goals", "context-docs"] as const) {
      const q = FILTERS[layer].find((d) => d.name === "q");
      expect(q, `${layer} must offer a q filter`).toBeDefined();
      expect(q?.kind).toBe("text");
    }
    expect(FILTERS.briefs.find((d) => d.name === "q")).toBeUndefined();
  });

  it("a text filter is INVISIBLE to the chip strip by construction", () => {
    // `FilterBar` renders only controls whose options are non-empty, and a `q`
    // def has `options: null`. That is what lets one filter model drive two
    // controls without `FilterBar` learning about `kind` at all.
    for (const layer of ["learnings", "goals", "context-docs"] as const) {
      const q = FILTERS[layer].find((d) => d.name === "q");
      expect(q?.options).toBeNull();
    }
  });

  it("listQuery emits `q` on the wire like any other filter", () => {
    const params = listQuery({
      layer: "goals",
      project: "igris-ai",
      values: { q: "kiln schedule", status: "active" },
      limit: 25,
      offset: 0,
    });
    expect(params.get("q")).toBe("kiln schedule");
    expect(params.get("status")).toBe("active");
    // ...and it is ENCODED, which is why the builder exists: a hand-built query
    // string would break on the `&` and `#` that occur in operator prose.
    expect(params.toString()).toContain("q=kiln+schedule");
  });

  it("an empty `q` is omitted — a cleared box is not a filter on the empty string", () => {
    const params = listQuery({
      layer: "goals",
      project: null,
      values: { q: "" },
      limit: 25,
      offset: 0,
    });
    expect(params.has("q")).toBe(false);
  });

  it("a non-empty `q` COUNTS as a narrowing, so an empty result reads correctly", () => {
    // This is what stops "no rows match your filter" being rendered as "this
    // project has no goals" — AC-4's distinction, riding on `hasActiveFilters`.
    expect(hasActiveFilters("goals", {})).toBe(false);
    expect(hasActiveFilters("goals", { q: "" })).toBe(false);
    expect(hasActiveFilters("goals", { q: "kiln" })).toBe(true);
  });

  it("`q` is NOT sent to /api/learnings/search — that endpoint takes a QUERY", () => {
    // `searchQuery` forwards only what the recall endpoint binds. Sending `q`
    // as a filter there would collide with the query it already sets.
    const params = searchQuery({
      query: "wrapper",
      project: null,
      values: { q: "something else", review_status: "approved" },
      limit: 20,
    });
    expect(params.get("q")).toBe("wrapper");
    expect(params.get("review_status")).toBe("approved");
  });
});

describe("FR-246 — briefsSearchQuery", () => {
  it("sets q, project and limit, and nothing else", () => {
    const params = briefsSearchQuery({ query: "kiln", project: "igris-ai", limit: 20 });
    expect([...params.keys()].sort()).toEqual(["limit", "project", "q"]);
    expect(params.get("q")).toBe("kiln");
    expect(params.get("project")).toBe("igris-ai");
    expect(params.get("limit")).toBe("20");
  });

  it("omits an absent project rather than sending an empty one", () => {
    // An empty `project=` would be dropped server-side as "no filter" anyway,
    // but sending it makes the URL claim a scope the operator did not choose.
    const params = briefsSearchQuery({ query: "kiln", project: null, limit: 20 });
    expect(params.has("project")).toBe(false);
    expect(briefsSearchQuery({ query: "k", project: "", limit: 5 }).has("project")).toBe(
      false,
    );
  });

  it("does NOT forward review_status — briefs have no such column", () => {
    // The reason `briefsSearchQuery` exists rather than a layer parameter on
    // `searchQuery`: the two endpoints accept different filters, and a shared
    // builder would send one the server reports back as unknown.
    const params = briefsSearchQuery({ query: "kiln", project: null, limit: 20 });
    expect(params.has("review_status")).toBe(false);
  });
});
