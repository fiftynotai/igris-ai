/**
 * FR-248 — the fused search surface's pure model.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE CLIENT'S HALF OF AC-4 NEEDS A TABLE AND NOT A BROWSER
 * ─────────────────────────────────────────────────────────────────────────────
 * The endpoint suite (`cli/src/__tests__/dashboard-search-fused.test.ts`) proves
 * the PAYLOAD always carries all five layers. That is half of "a layer whose
 * retrieval is unavailable is REPORTED, never silently absent" — the other half
 * is that all five reach the SCREEN, with the operator's own `?layers=` choice
 * distinguishable from a fault. Both are pure functions of the payload, so they
 * are asserted here in microseconds rather than through a rendered DOM.
 *
 * WHAT THIS FILE PROVES
 *   - `layerStandings` maps 1:1 and filters NOTHING, including on a payload
 *     where three of five layers are `available: false` for three different
 *     reasons.
 *   - `requested: false` resolves to `excluded`, NOT `unavailable` — the wire
 *     sets `available: false` for both, so a renderer keying on `available`
 *     alone would paint the operator's own choice as a broken layer.
 *   - `recencyReadout` is MANDATORY: it returns a sentence for every payload,
 *     including the one where nothing ranked by recency at all (D1).
 *   - its denominator is read off `layers.length`, so a sixth layer counts.
 *   - `toggleLayer` cannot empty the selection, and `fusedSearchQuery` cannot
 *     emit an empty `?layers=` — both because `parseLayers` reads an empty one
 *     as ALL FIVE, i.e. a narrowing that silently un-narrows.
 *   - every row carries its layer AND its rank basis, and the wire word
 *     (`substring`) is rendered as well as the gloss (`RECENCY`).
 *   - `TRAIL_MAX` is pinned by a LITERAL expected string (the way
 *     `record/__tests__/record.test.tsx` R2 pins the board's `LABEL_MAX`), so
 *     re-cutting every row on the page reds a test.
 *   - the empty-state ladder puts "no results while a layer is dead" in
 *     `degraded` and not in `empty`.
 *
 * WHAT IT DOES **NOT** PROVE
 *   - that `pages/Search.tsx` renders any of it. Siblings: the FR-248 browser
 *     gate world (phase 6) for the DOM, and `dashboard-layers-source.test.ts`
 *     for the structural claims about the file.
 *   - that the SERVER fills these fields correctly. Sibling:
 *     `cli/src/__tests__/dashboard-search-fused.test.ts`, which drives the real
 *     endpoint against a real brain.
 */

import { describe, expect, it } from "vitest";
import type {
  FusedLayerReport,
  FusedRow,
  FusedSearchPayload,
  SearchLayerId,
  SearchRankBasis,
} from "../../lib/api";
import {
  FUSED_LIMIT,
  SEARCH_LAYERS,
  TRAIL_MAX,
  basisWord,
  displayRow,
  excluded,
  faults,
  fusedEmpty,
  fusedSearchQuery,
  layerLabel,
  layerState,
  layerStandings,
  recencyReadout,
  recordLayerFor,
  rowHref,
  toggleLayer,
  truncate,
} from "../model";

// ---------------------------------------------------------------------------
// Fixtures — shaped like the wire, not like the assertions
// ---------------------------------------------------------------------------

const BASIS: Record<SearchLayerId, SearchRankBasis> = {
  briefs: "rrf",
  learnings: "rrf",
  goals: "substring",
  suggestions: "substring",
  "context-docs": "substring",
};

function report(
  layer: SearchLayerId,
  over: Partial<FusedLayerReport> = {},
): FusedLayerReport {
  const rank_basis = BASIS[layer];
  return {
    layer,
    requested: true,
    available: true,
    reason: null,
    rank_basis,
    hits: 3,
    contributed: 2,
    retrieval:
      rank_basis === "rrf"
        ? {
            mode: "hybrid",
            vector_available: true,
            embedding_available: true,
            bm25_hits: 3,
            vector_hits: 3,
            rrf_k: 60,
            weights: { bm25: 0.5, vector: 0.5 },
            reason: null,
          }
        : null,
    search: rank_basis === "substring" ? { mode: "substring", fields: ["title"] } : null,
    applied: ["limit", "project", "q"],
    ...over,
  };
}

function row(layer: SearchLayerId, over: Partial<FusedRow> = {}): FusedRow {
  const rank = over.layer_rank ?? 1;
  return {
    layer,
    rank_basis: BASIS[layer],
    layer_rank: rank,
    fused_score: 1 / (60 + rank),
    key: `${layer}:igris-ai:X-1`,
    ref: { project: "igris-ai", id: "X-1" },
    title: "a title",
    subtitle: "a subtitle",
    updated_at: "2026-08-11T00:00:00Z",
    rrf_score: BASIS[layer] === "rrf" ? 0.0328 : null,
    ...over,
  };
}

function payload(over: Partial<FusedSearchPayload> = {}): FusedSearchPayload {
  const layers = over.layers ?? SEARCH_LAYERS.map((l) => report(l.id));
  return {
    query: "brain",
    items: over.items ?? [],
    count: (over.items ?? []).length,
    layers,
    fusion: {
      rrf_k: 60,
      weights: {
        briefs: 1,
        learnings: 1,
        goals: 1,
        suggestions: 1,
        "context-docs": 1,
      },
      substring_layers: ["goals", "suggestions"],
    },
    params: [],
    generated_at: "2026-08-11T00:00:00Z",
    degraded: null,
    ...over,
  };
}

const ALL: SearchLayerId[] = SEARCH_LAYERS.map((l) => l.id);

// ---------------------------------------------------------------------------
// S0 — the corpus. Every assertion below is meaningless over the wrong shape.
// ---------------------------------------------------------------------------

describe("S0 · the fixture is the wire's shape", () => {
  it("declares five layers, three of them substring-only", () => {
    expect(ALL).toEqual([
      "briefs",
      "learnings",
      "goals",
      "suggestions",
      "context-docs",
    ]);
    const substring = ALL.filter((l) => BASIS[l] === "substring");
    // AC-5's measured fact, restated as a fixture invariant: if this ever
    // becomes two or four, every readout assertion below is about a different
    // surface and should be re-read rather than re-fitted.
    expect(substring).toEqual(["goals", "suggestions", "context-docs"]);
  });

  it("labels every layer, and falls back rather than throwing on an unknown one", () => {
    for (const l of ALL) expect(layerLabel(l)).not.toBe("");
    expect(layerLabel("goals")).toBe("GOALS");
    expect(layerLabel("sessions")).toBe("SESSIONS");
  });
});

// ---------------------------------------------------------------------------
// S1 — the request
// ---------------------------------------------------------------------------

describe("S1 · fusedSearchQuery binds q + project + limit + layers, and nothing else", () => {
  it("binds the four, in the four names the endpoint accepts", () => {
    const q = fusedSearchQuery({
      query: "rank fusion",
      project: "igris-ai",
      layers: ALL,
      limit: FUSED_LIMIT,
    });
    expect([...q.keys()].sort()).toEqual(["limit", "project", "q"]);
    expect(q.get("q")).toBe("rank fusion");
    expect(q.get("project")).toBe("igris-ai");
    expect(q.get("limit")).toBe("20");
  });

  it("omits `layers` when every layer is selected — a narrowing that narrows nothing is not one", () => {
    const q = fusedSearchQuery({
      query: "x",
      project: null,
      layers: ALL,
      limit: 20,
    });
    expect(q.has("layers")).toBe(false);
    expect(q.has("project")).toBe(false);
  });

  it("emits `layers` as a CSV for a proper subset", () => {
    const q = fusedSearchQuery({
      query: "x",
      project: null,
      layers: ["briefs", "goals"],
      limit: 20,
    });
    expect(q.get("layers")).toBe("briefs,goals");
  });

  it("NEVER emits an empty `layers` — the server reads one as ALL FIVE", () => {
    /*
     * `params.ts#parseLayers`: an absent, blank or all-unknown `?layers=`
     * returns every declared layer with `narrowed: false`. So an empty one is
     * not "search nothing", it is "search everything" — a request whose payload
     * would report `requested: true` on all five while the operator had turned
     * them all off. The client must be structurally incapable of sending it.
     */
    const q = fusedSearchQuery({ query: "x", project: null, layers: [], limit: 20 });
    expect(q.has("layers")).toBe(false);
  });

  it("encodes rather than concatenates — a `&` in the query does not split it", () => {
    const q = fusedSearchQuery({
      query: "rank & fusion #2",
      project: "a/b",
      layers: ALL,
      limit: 20,
    });
    expect(q.toString()).toContain("q=rank+%26+fusion+%232");
    expect(q.toString()).toContain("project=a%2Fb");
    // Round-trips: the server reads the decoded value, not the escaped one.
    expect(new URLSearchParams(q.toString()).get("q")).toBe("rank & fusion #2");
  });
});

describe("S1b · toggleLayer cannot empty the selection", () => {
  it("adds a layer that is off", () => {
    expect(toggleLayer(["briefs"], "goals")).toEqual(["briefs", "goals"]);
  });

  it("removes a layer that is on, while another remains", () => {
    expect(toggleLayer(["briefs", "goals"], "briefs")).toEqual(["goals"]);
  });

  it("REFUSES to remove the last one — the chip stays visibly on", () => {
    expect(toggleLayer(["goals"], "goals")).toEqual(["goals"]);
  });

  it("is pure — the input array is never mutated", () => {
    const before: SearchLayerId[] = ["briefs", "goals"];
    toggleLayer(before, "briefs");
    toggleLayer(before, "learnings");
    expect(before).toEqual(["briefs", "goals"]);
  });
});

// ---------------------------------------------------------------------------
// S2 — the rows
// ---------------------------------------------------------------------------

describe("S2 · a row states its layer AND what its rank means", () => {
  it("the eye line carries layer, rank and the GLOSS", () => {
    expect(displayRow(row("goals", { layer_rank: 1 })).eye).toBe(
      "// GOALS · RANK 1 BY RECENCY",
    );
    expect(displayRow(row("briefs", { layer_rank: 4 })).eye).toBe(
      "// BRIEFS · RANK 4 BY RELEVANCE",
    );
  });

  it("the metadata carries the WIRE word too, so the payload's own term is on screen", () => {
    const meta = displayRow(row("goals")).meta;
    expect(meta).toContainEqual({ k: "rank basis", v: "substring" });
    expect(meta).toContainEqual({ k: "layer", v: "goals" });
    expect(displayRow(row("briefs")).meta).toContainEqual({
      k: "rank basis",
      v: "rrf",
    });
  });

  it("basisWord glosses both, and only both", () => {
    expect(basisWord("rrf")).toBe("RELEVANCE");
    expect(basisWord("substring")).toBe("RECENCY");
  });

  it("the layer's own rrf score is DISPLAYED and is an em dash when absent", () => {
    // Displayed for diagnosis; never an ordering input. Three layers have none,
    // and a BM25-only arm on the other two also has none.
    expect(displayRow(row("briefs")).meta).toContainEqual({
      k: "layer rrf",
      v: "0.0328",
    });
    expect(displayRow(row("goals")).meta).toContainEqual({
      k: "layer rrf",
      v: "—",
    });
  });

  it("R2-style pin — the trail is cut at TRAIL_MAX characters, then marked", () => {
    /*
     * Pinned by a LITERAL, not symbolically against `TRAIL_MAX`. A symbolic
     * assertion follows the constant wherever it goes; this one goes red, which
     * is the whole difference (`record.test.tsx` R2's argument, applied here).
     */
    expect(TRAIL_MAX).toBe(96);
    const long = `${"a".repeat(95)}BCDEFG`;
    const out = displayRow(row("context-docs", { subtitle: long }));
    expect(out.trail).toBe(`${"a".repeat(95)}B…`);
    expect(out.trail).toHaveLength(97);
  });

  it("a short trail is untouched, and a null subtitle stays null", () => {
    expect(truncate("short", TRAIL_MAX)).toBe("short");
    expect(displayRow(row("goals", { subtitle: null })).trail).toBeNull();
  });
});

describe("S2b · the record address is the layer's own, and suggestions have none", () => {
  it("maps the four browsable layers and refuses the fifth", () => {
    expect(recordLayerFor("briefs")).toBe("briefs");
    expect(recordLayerFor("learnings")).toBe("learnings");
    expect(recordLayerFor("goals")).toBe("goals");
    expect(recordLayerFor("context-docs")).toBe("context-docs");
    // The triage queue has no per-row address, so the row renders unlinked
    // rather than linked to somewhere approximate.
    expect(recordLayerFor("suggestions")).toBeNull();
  });

  it("builds the BR-078 three-segment address through the shared codec", () => {
    expect(rowHref(row("briefs", { ref: { project: "igris-ai", id: "BR-001" } }))).toBe(
      "#/layers/briefs/igris-ai/BR-001",
    );
  });

  it("a globally-addressed row gets the EMPTY middle segment, not a sentinel", () => {
    expect(rowHref(row("goals", { ref: { project: null, id: "GL-007" } }))).toBe(
      "#/layers/goals//GL-007",
    );
  });

  it("a suggestion row has no href at all", () => {
    expect(rowHref(row("suggestions"))).toBeNull();
    expect(displayRow(row("suggestions")).href).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// S3 — AC-4, the client half
// ---------------------------------------------------------------------------

describe("S3 · every layer reaches the screen, and excluded is not broken", () => {
  it("maps 1:1 and filters NOTHING, even when three of five are unavailable", () => {
    const p = payload({
      layers: [
        report("briefs"),
        report("learnings", {
          available: false,
          reason:
            "no retrieval arm available — lexical: briefs_fts missing; vector: sqlite-vec not loaded",
        }),
        report("goals", { available: false, reason: "goals search failed: no such table: goals" }),
        report("suggestions", {
          requested: false,
          available: false,
          reason: "not requested — ?layers= narrowed this search to briefs, learnings, goals, context-docs",
        }),
        report("context-docs", {
          available: false,
          reason: "context docs are addressed per project — supply ?project=<slug>",
        }),
      ],
    });
    const standings = layerStandings(p.layers);
    expect(standings).toHaveLength(5);
    expect(standings.map((s) => s.layer)).toEqual(ALL);
  });

  it("`requested: false` is EXCLUDED, never a fault — both are available:false on the wire", () => {
    const off = report("suggestions", {
      requested: false,
      available: false,
      reason: "not requested — ?layers= narrowed this search to briefs",
    });
    const broken = report("goals", {
      available: false,
      reason: "goals search failed: no such table: goals",
    });
    expect(layerState(off)).toBe("excluded");
    expect(layerState(broken)).toBe("unavailable");
    // The property that makes the distinction necessary: the wire cannot tell
    // them apart on `available` alone.
    expect(off.available).toBe(broken.available);
  });

  it("a layer that ran and matched NOTHING is ok — zero hits is not a fault", () => {
    expect(layerState(report("briefs", { hits: 0, contributed: 0 }))).toBe("ok");
  });

  it("faults() and excluded() partition the not-ok layers with no overlap", () => {
    const standings = layerStandings([
      report("briefs"),
      report("learnings", { available: false, reason: "dead" }),
      report("goals", { requested: false, available: false, reason: "not requested" }),
    ]);
    expect(faults(standings).map((s) => s.layer)).toEqual(["learnings"]);
    expect(excluded(standings).map((s) => s.layer)).toEqual(["goals"]);
  });

  it("carries the server's reason VERBATIM — the client never rewrites it", () => {
    const REASON =
      "no retrieval arm available — lexical: briefs_fts is missing (schema v23 adds it); vector: sqlite-vec not loaded on the read handle";
    const [standing] = layerStandings([
      report("briefs", { available: false, reason: REASON }),
    ]);
    expect(standing?.reason).toBe(REASON);
  });

  it("carries the rendered WORDS, and 'excluded' names who did it", () => {
    /*
     * The vocabulary lives here rather than in `SearchReadout.tsx` so it can be
     * asserted without a render — and so the component in the SHARED chunk needs
     * no runtime import from this module. "EXCLUDED BY YOU" rather than a third
     * synonym for "off": the distinction only pays off if the copy makes it.
     */
    const standings = layerStandings([
      report("briefs"),
      report("goals", { requested: false, available: false, reason: "not requested" }),
      report("learnings", { available: false, reason: "dead" }),
    ]);
    expect(standings.map((s) => s.state_label)).toEqual([
      "SEARCHED",
      "EXCLUDED BY YOU",
      "UNAVAILABLE",
    ]);
    expect(standings.map((s) => s.basis_label)).toEqual([
      "RANKS BY RELEVANCE",
      "RANKS BY RECENCY",
      "RANKS BY RELEVANCE",
    ]);
  });

  it("carries the per-layer BR-085 `applied` list, which is per LAYER and not per response", () => {
    const standings = layerStandings([
      report("briefs", { applied: ["limit", "project", "q"] }),
      report("context-docs", { applied: ["limit", "q"] }),
    ]);
    expect(standings[0]?.applied).toEqual(["limit", "project", "q"]);
    expect(standings[1]?.applied).toEqual(["limit", "q"]);
  });
});

// ---------------------------------------------------------------------------
// S4 — D1, the mandatory readout
// ---------------------------------------------------------------------------

describe("S4 · the rank-basis readout is MANDATORY, not conditional", () => {
  it("names the contributing substring layers and the count out of the total", () => {
    const out = recencyReadout(payload());
    expect(out.contributing).toEqual(["goals", "suggestions"]);
    expect(out.total).toBe(5);
    expect(out.text).toContain("2 OF 5 LAYERS CONTRIBUTED BY RECENCY, NOT RELEVANCE");
    expect(out.text).toContain("GOALS, SUGGESTIONS");
    // The clause that makes it useful rather than merely present.
    expect(out.text).toContain("RANK 1 IS NOT THE BEST ANSWER");
  });

  it("still returns a sentence when NO substring layer contributed", () => {
    const out = recencyReadout(
      payload({
        fusion: {
          rrf_k: 60,
          weights: {
            briefs: 1,
            learnings: 1,
            goals: 1,
            suggestions: 1,
            "context-docs": 1,
          },
          substring_layers: [],
        },
      }),
    );
    expect(out.contributing).toEqual([]);
    expect(out.text).not.toBe("");
    expect(out.text).toContain("0 OF 5 LAYERS CONTRIBUTED BY RECENCY");
    // It still NAMES the three, because "they contributed nothing" is the fact
    // the operator needs and it is different from "they do not exist".
    expect(out.text).toContain("GOALS, SUGGESTIONS, CONTEXT DOCS");
  });

  it("says so plainly when every layer in the response ranks by relevance", () => {
    const out = recencyReadout(
      payload({
        layers: [report("briefs"), report("learnings")],
        fusion: {
          rrf_k: 60,
          weights: {
            briefs: 1,
            learnings: 1,
            goals: 1,
            suggestions: 1,
            "context-docs": 1,
          },
          substring_layers: [],
        },
      }),
    );
    expect(out.declared).toEqual([]);
    expect(out.text).toBe("RANK BASIS — ALL 2 LAYERS IN THIS RESPONSE RANK BY RELEVANCE.");
  });

  it("the denominator is READ OFF the payload — a sixth layer counts as six", () => {
    /*
     * The whole reason `total` is `layers.length` and not the literal 5: the day
     * a sixth layer ships, this readout is correct with no client edit. A
     * hard-coded 5 would go quietly wrong — the worst kind of wrong for a
     * sentence whose only job is to be trusted.
     */
    const sixth = { ...report("goals"), layer: "sessions" as SearchLayerId };
    const out = recencyReadout(
      payload({ layers: [...SEARCH_LAYERS.map((l) => report(l.id)), sixth] }),
    );
    expect(out.total).toBe(6);
    expect(out.text).toContain("2 OF 6 LAYERS");
    expect(out.declared).toEqual(["goals", "suggestions", "context-docs", "sessions"]);
  });

  it("takes `contributing` from the SERVER's own field, not from a client list", () => {
    // The server says only `context-docs` contributed. The client must agree
    // even though its own table calls three layers substring-only.
    const out = recencyReadout(
      payload({
        fusion: {
          rrf_k: 60,
          weights: {
            briefs: 1,
            learnings: 1,
            goals: 1,
            suggestions: 1,
            "context-docs": 1,
          },
          substring_layers: ["context-docs"],
        },
      }),
    );
    expect(out.contributing).toEqual(["context-docs"]);
    expect(out.text).toContain("1 OF 5 LAYERS");
  });
});

// ---------------------------------------------------------------------------
// S5 — the empty ladder
// ---------------------------------------------------------------------------

describe("S5 · 'nothing to show' is five different facts", () => {
  const standings = (over: FusedLayerReport[] = []): ReturnType<typeof layerStandings> =>
    layerStandings(over.length > 0 ? over : SEARCH_LAYERS.map((l) => report(l.id)));

  it("a whole-response degrade wins over everything", () => {
    const copy = fusedEmpty({
      query: "x",
      rows: 0,
      degraded: "no layer could be searched — see layers[] for each cause",
      standings: standings(),
      project: "igris-ai",
    });
    expect(copy.kind).toBe("degraded");
    expect(copy.meta).toBe("no layer could be searched — see layers[] for each cause");
  });

  it("no query yet is the RESTING state, not an outcome", () => {
    const copy = fusedEmpty({
      query: null,
      rows: 0,
      degraded: null,
      standings: standings(),
      project: null,
    });
    expect(copy.kind).toBe("empty");
    expect(copy.headline).toBe("nothing searched yet.");
  });

  it("AC-4 — zero rows with a DEAD layer is DEGRADED, never 'no results'", () => {
    /*
     * The case a naive ladder gets wrong, and the one that costs the most: an
     * operator who reads "no results" over a broken retrieval arm concludes the
     * brain knows nothing about the subject, and acts on it. The copy has to say
     * the search was INCOMPLETE.
     */
    const copy = fusedEmpty({
      query: "x",
      rows: 0,
      degraded: null,
      standings: standings([
        report("briefs", { available: false, reason: "briefs_fts is missing" }),
        report("learnings"),
        report("goals"),
        report("suggestions"),
        report("context-docs"),
      ]),
      project: null,
    });
    expect(copy.kind).toBe("degraded");
    expect(copy.headline).toContain("incomplete");
    expect(copy.meta).toBe("unavailable: briefs");
  });

  it("an EXCLUDED layer is narrowing, not a fault — that one is 'filtered'", () => {
    const copy = fusedEmpty({
      query: "x",
      rows: 0,
      degraded: null,
      standings: standings([
        report("briefs"),
        report("learnings"),
        report("goals"),
        report("suggestions", {
          requested: false,
          available: false,
          reason: "not requested",
        }),
        report("context-docs"),
      ]),
      project: null,
    });
    expect(copy.kind).toBe("filtered");
    expect(copy.meta).toBe("excluded: suggestions");
  });

  it("a project scope alone is also narrowing", () => {
    const copy = fusedEmpty({
      query: "x",
      rows: 0,
      degraded: null,
      standings: standings(),
      project: "igris-ai",
    });
    expect(copy.kind).toBe("filtered");
    expect(copy.meta).toBe("project: igris-ai");
  });

  it("five live layers, no narrowing, no rows — genuinely empty, and it says why a synonym missed", () => {
    const copy = fusedEmpty({
      query: "xyzzy",
      rows: 0,
      degraded: null,
      standings: standings(),
      project: null,
    });
    expect(copy.kind).toBe("empty");
    expect(copy.meta).toBe('no match for "xyzzy"');
    expect(copy.message).toContain("synonym");
  });
});
