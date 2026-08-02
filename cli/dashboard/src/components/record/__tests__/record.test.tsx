/**
 * FR-240 — **the shared record components, rendered.**
 *
 * WHY THIS FILE CAN EXIST. The plan assumed the node vitest env could not
 * render components, and therefore that only `layers/model.ts` could be gated
 * before the browser suite. That was wrong on contact with the code:
 * `react-dom/server` needs no DOM, `react-dom` is already a devDependency, and
 * vitest picks up `dashboard/tsconfig.json` for JSX. So the claims below are
 * asserted now instead of being deferred to Phase 5's CDP run.
 *
 * WHAT THIS FILE PROVES
 *   - AC #6: the four empty states render as FOUR DIFFERENT things, each
 *     stamped with its kind, from the ONE list component.
 *   - AC #3: both cross-link directions emit anchors carrying the
 *     `(type, project, id)` triple, and the "no detail view" / "not in the
 *     graph" cases render an explicit statement rather than a blank or a dead
 *     control.
 *   - AC #5: all four layers go through this one list and this one detail — the
 *     row descriptor is data, so a layer cannot fork the markup without
 *     changing this file.
 *   - AC #2's operator-facing half: a `bm25_only` retrieval renders a BANNER.
 *   - AC #7: nothing rendered here is a write control.
 *
 * WHAT IT DOES **NOT** PROVE
 *   Anything about EFFECTS, fetches or layout. `renderToStaticMarkup` runs no
 *   `useEffect`, applies no stylesheet, and dispatches no events — so a control
 *   that renders correctly and is wired to nothing still passes here.
 *   **Siblings:** the CDP browser gates in `docs/dashboard.md` (G-BR-1 clicks
 *   the links; G-BR-2 applies the filters and compares the rendered row count
 *   with the endpoint's `total`; G-BR-4 reads the computed palette values).
 *   Those own everything this file cannot see.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RecordList, type RecordListRow } from "../RecordList";
import { RecordBoard, type RecordBoardColumn } from "../RecordBoard";
import { CARD_CAP, columnLabel } from "../../../layers/board";
import { RecordDetail, RecordNeighbours } from "../RecordDetail";
import { FilterBar } from "../FilterBar";
import { NodeInspector } from "../../graph/NodeInspector";
import { RetrievalBanner } from "../../../pages/layers/Learnings";
import {
  LAYER_IDS,
  emptyStateFor,
  layerHash,
  recordHash,
  type EmptyCopy,
} from "../../../layers/model";
import type { GraphNode, RetrievalReport } from "../../../lib/api";

function html(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

const EMPTY: EmptyCopy = {
  kind: "empty",
  headline: "nothing here yet.",
  message: "No briefs filed.",
  meta: "0 rows",
};

const ROW: RecordListRow = {
  key: "igris-ai|BR-001",
  eye: "// BR-001 · pattern",
  title: "A brief title",
  href: recordHash({ layer: "briefs", project: "igris-ai", id: "BR-001" }),
  meta: [
    { k: "project", v: "igris-ai" },
    { k: "updated", v: "2026-07-30" },
  ],
};

// ===========================================================================
// AC #6 — four empty states, from one component
// ===========================================================================

describe("AC #6 · the empty states are four visibly different things", () => {
  const kinds = ["degraded", "filtered", "empty", "no-project"] as const;

  it.each(kinds)("renders the %s state, stamped with its kind", (kind) => {
    const empty = emptyStateFor({
      layer: "briefs",
      total: 0,
      degraded: kind === "degraded" ? "brain database not found at /x/brain.db" : null,
      filtersActive: kind === "filtered",
      searchActive: false,
      project: kind === "no-project" ? null : "igris-ai",
      projectRequired: kind === "no-project",
    });
    expect(empty.kind).toBe(kind);

    const out = html(
      <RecordList eye="// BRIEFS" heading="BRIEFS" rows={[]} empty={empty} />,
    );
    // The kind reaches the DOM, so the browser gate can assert WHICH state is
    // showing rather than merely that something is.
    expect(out).toContain(`data-empty-kind="${kind}"`);
    expect(out).toContain(empty.headline);
    expect(out).toContain(empty.meta);
  });

  it("the four render four DIFFERENT documents", () => {
    // The AC's actual requirement. One shared "nothing here" for all four is
    // the failure, and it would pass every individual assertion above.
    const rendered = kinds.map((kind) =>
      html(
        <RecordList
          eye="// BRIEFS"
          heading="BRIEFS"
          rows={[]}
          empty={emptyStateFor({
            layer: "briefs",
            total: 0,
            degraded: kind === "degraded" ? "a reason" : null,
            filtersActive: kind === "filtered",
            searchActive: false,
            project: kind === "no-project" ? null : "igris-ai",
            projectRequired: kind === "no-project",
          })}
        />,
      ),
    );
    expect(new Set(rendered).size).toBe(4);
  });

  it("a degraded brain shows the REASON, not a friendly nothing", () => {
    const out = html(
      <RecordList
        eye="// BRIEFS"
        heading="BRIEFS"
        rows={[]}
        empty={emptyStateFor({
          layer: "briefs",
          total: 0,
          degraded: "brain read layer could not be loaded from the vendored bundle",
          filtersActive: false,
          searchActive: false,
          project: "igris-ai",
        })}
      />,
    );
    expect(out).toContain("vendored bundle");
    expect(out).not.toContain("nothing here yet");
  });

  it("shows a SKELETON while loading, never an empty state", () => {
    // A 40 ms flash of "nothing here yet" followed by a list reads as a bug.
    const out = html(
      <RecordList eye="// X" heading="X" rows={[]} empty={EMPTY} loading />,
    );
    expect(out).toContain("shell-skel");
    expect(out).not.toContain("nothing here yet");
  });
});

// ===========================================================================
// AC #5 — one list, one detail, for all four layers
// ===========================================================================

describe("AC #5 · the ONE list renders every layer's rows", () => {
  it("renders a row as an anchor carrying the (project, id) address", () => {
    const out = html(
      <RecordList eye="// BRIEFS" heading="BRIEFS" rows={[ROW]} empty={EMPTY} />,
    );
    expect(out).toContain('href="#/layers/briefs/igris-ai/BR-001"');
    expect(out).toContain("// BR-001 · pattern");
    expect(out).toContain("A brief title");
    expect(out).toContain("igris-ai");
  });

  it("renders a BUTTON for a row with no address, and neither for a disabled one", () => {
    const withHandler = html(
      <RecordList
        eye="// X"
        heading="X"
        rows={[{ ...ROW, href: null, onOpen: () => undefined }]}
        empty={EMPTY}
      />,
    );
    expect(withHandler).toContain("<button");
    expect(withHandler).not.toContain("<a class=\"record-row\"");

    const disabled = html(
      <RecordList
        eye="// X"
        heading="X"
        rows={[{ ...ROW, href: null, disabled: true }]}
        empty={EMPTY}
      />,
    );
    // A missing context doc is a row that states its own absence — rendered,
    // not hidden, and not clickable.
    expect(disabled).toContain('data-disabled="true"');
    expect(disabled).not.toContain("<button");
  });

  it("every layer's list route is a valid address the tabs can link to", () => {
    for (const id of LAYER_IDS) {
      expect(layerHash(id)).toBe(`#/layers/${id}`);
    }
  });

  it("disables PREV on the first page and NEXT on the last", () => {
    const first = html(
      <RecordList
        eye="// X"
        heading="X"
        rows={[ROW]}
        empty={EMPTY}
        page={{ limit: 50, offset: 0, total: 615, count: 50, onOffset: () => undefined }}
      />,
    );
    expect(first).toContain("1-50 OF 615");
    // Exactly one disabled button — PREV.
    expect(first.match(/disabled/g) ?? []).toHaveLength(1);

    const last = html(
      <RecordList
        eye="// X"
        heading="X"
        rows={[ROW]}
        empty={EMPTY}
        page={{ limit: 50, offset: 600, total: 615, count: 15, onOffset: () => undefined }}
      />,
    );
    expect(last).toContain("601-615 OF 615");
    expect(last.match(/disabled/g) ?? []).toHaveLength(1);
  });

  it("renders NO pagination for a layer that has none", () => {
    const out = html(
      <RecordList eye="// X" heading="X" rows={[ROW]} empty={EMPTY} />,
    );
    expect(out).not.toContain("NEXT");
    expect(out).not.toContain("PREV");
  });
});

// ===========================================================================
// FR-245 — the BOARD is an arrangement of the same rows
// ===========================================================================

describe("FR-245 · the briefs board", () => {
  const noop = (): void => undefined;

  function rows(n: number, prefix = "BR"): RecordListRow[] {
    return Array.from({ length: n }, (_, i) => ({
      ...ROW,
      key: `igris-ai|${prefix}-${i}`,
      eye: `// ${prefix}-${i}`,
      title: `${prefix} number ${i}`,
    }));
  }

  function column(
    status: string,
    over: Partial<RecordBoardColumn> = {},
  ): RecordBoardColumn {
    return {
      status,
      label: columnLabel(status),
      rows: [],
      total: 0,
      loading: false,
      ...over,
    };
  }

  function board(columns: RecordBoardColumn[], over = {}) {
    return html(
      <RecordBoard
        eye="// BRIEFS"
        heading="BRIEFS"
        columns={columns}
        cardCap={CARD_CAP}
        asOf="2026-08-02T10:00:00.000Z"
        onRefresh={noop}
        onOpenInList={noop}
        scopeTotal={null}
        filtered={false}
        {...over}
      />,
    );
  }

  it("R1 — one section per column, each stamped with the RAW status", () => {
    const out = board([
      column("In Progress", { total: 2, rows: rows(2) }),
      column("Done", { total: 5, rows: rows(5, "FR") }),
      column("Done(Resolvedbydec8d1f)", { total: 1, rows: rows(1, "TD") }),
    ]);
    expect(out.match(/class="record-board-col"/g) ?? []).toHaveLength(3);
    expect(out).toContain('data-status="In Progress"');
    expect(out).toContain('data-status="Done"');
    // The commit-hash status reaches the DOM byte for byte — the browser gate
    // and the source suite both read this attribute, so an abbreviation here
    // would make every downstream assertion about the wrong string.
    expect(out).toContain('data-status="Done(Resolvedbydec8d1f)"');
    // THREE columns for three spellings of finished. Nothing is folded; see
    // `layers/__tests__/board.test.ts` B6 for the derivation half.
    const donish = board([
      column("Done", { total: 1195 }),
      column("Completed", { total: 24 }),
      column("Complete", { total: 1 }),
    ]);
    expect(donish.match(/class="record-board-col"/g) ?? []).toHaveLength(3);
    expect(donish).toContain('data-total="1195"');
    expect(donish).toContain('data-total="24"');
    expect(donish).toContain('data-total="1"');
    // ...and NO column reports the merged total. The strip's own readout does
    // sum them — that is AC-2's arithmetic, over three columns that stayed
    // three — but no column claims to be all three.
    expect(donish).not.toContain('data-total="1220"');
    expect(donish).toContain('data-column-sum="1220"');
  });

  it("R2 — a sentence status is truncated in the header and FULL in the data", () => {
    const SENTENCE =
      "Split (see FR-161, FR-162, FR-163, FR-164, FR-165, FR-166, FR-167)";
    const out = board([column(SENTENCE, { total: 1, rows: rows(1) })]);
    // The header carries the truncation — 22 characters plus an ellipsis...
    expect(out).toContain(">Split (see FR-161, FR-…<");
    expect(out).not.toContain(`>${SENTENCE}<`);
    // ...and both the tooltip and the stamped attribute carry the whole thing,
    // so nothing about which status this is has been lost.
    expect(out).toContain(`title="${SENTENCE}"`);
    expect(out).toContain(`data-status="${SENTENCE}"`);
  });

  it("R3 — the SAME rows emit the SAME markup through the list and the board", () => {
    /*
     * D8's mechanical form. Both views call `RecordRow`, so this cannot drift
     * without someone deleting the shared function — which is the point of
     * exporting it rather than writing card markup in `RecordBoard`.
     */
    const same = rows(3);
    const listOut = html(
      <RecordList eye="// BRIEFS" heading="BRIEFS" rows={same} empty={EMPTY} />,
    );
    const boardOut = board([column("Ready", { total: 3, rows: same })]);

    const items = (s: string): string[] => s.match(/<li[\s\S]*?<\/li>/g) ?? [];
    expect(items(listOut)).toHaveLength(3);
    expect(items(boardOut)).toEqual(items(listOut));
  });

  it("R4 — a column past the cap shows CARD_CAP cards and hands over to the list", () => {
    const out = board([column("Done", { total: 493, rows: rows(CARD_CAP + 6) })]);
    expect(out.match(/class="record-row"/g) ?? []).toHaveLength(CARD_CAP);
    // D2: the volume is a NUMBER IN THE HEADER, not a wall of cards...
    expect(out).toContain(`${CARD_CAP} OF 493`);
    // ...and the column carries its own total for the AC-2 sum.
    expect(out).toContain('data-total="493"');
    // ...and the operator is handed to the surface that IS for 493 rows,
    // carrying this column's raw status.
    expect(out).toContain('data-open-in-list="Done"');
    expect(out).toContain("OPEN IN LIST");
    expect(out).toContain(`+${493 - CARD_CAP} MORE`);
  });

  it("R5 — a column filtered to zero still renders, showing 0", () => {
    const out = board([
      column("Blocked", { total: 0 }),
      column("Done", { total: 4, rows: rows(4) }),
    ]);
    expect(out.match(/class="record-board-col"/g) ?? []).toHaveLength(2);
    expect(out).toContain('data-status="Blocked"');
    expect(out).toContain('data-total="0"');
    // D9: an empty COLUMN is not an empty STATE. Rendering one inside the
    // column would say "there is nothing to show" about the whole board, and
    // would make the column set flicker as an operator clicks filter chips.
    expect(out).not.toContain("data-empty-kind");
    expect(out).not.toContain("nothing here yet");
    // Nothing to open, so no handoff control on this column — exactly one,
    // belonging to `Done`.
    expect(out.match(/data-open-in-list/g) ?? []).toHaveLength(1);
  });

  it("renders the board-level empty state INSTEAD of columns when there is one", () => {
    const out = board([column("Ready", { total: 3, rows: rows(3) })], {
      empty: emptyStateFor({
        layer: "briefs",
        total: 0,
        degraded: "brain database not found at /x/brain.db",
        filtersActive: false,
        searchActive: false,
        project: "igris-ai",
      }),
    });
    expect(out).toContain('data-empty-kind="degraded"');
    expect(out).toContain("brain database not found");
    // D9 — and NOT the six vocabulary columns. A degraded read that fell back
    // to a hand-listed column set is this brief's named failure wearing a
    // disguise, so the fallback must not exist to be reached.
    expect(out).not.toContain("record-board-col");
  });

  it("states its staleness, because it does NOT follow the live beat (D5)", () => {
    const out = board([column("Ready", { total: 1, rows: rows(1) })], {
      scopeTotal: 1,
    });
    expect(out).toContain("AS OF 2026-08-02T10:00:00.000Z");
    expect(out).toContain("REFRESH");
    // The AC-2 readout: the column sum against the scope's own total, both
    // stamped so the browser gate reads numbers rather than parsing prose.
    expect(out).toContain('data-column-sum="1"');
    expect(out).toContain('data-scope-total="1"');
    expect(out).toContain("1 OF 1 BRIEFS");
  });

  it("is READ-ONLY: no drag affordance, no form, no method", () => {
    const out = board([
      column("Ready", { total: 3, rows: rows(3) }),
      column("Done", { total: 40, rows: rows(CARD_CAP) }),
    ]);
    // The rendered half of AC-6. The FILE half — which is the one that can see
    // a handler added next month — is the vocabulary scan in
    // `cli/src/__tests__/dashboard-layers-source.test.ts`, and the BEHAVIOURAL
    // half is G-BR-12f, which drags a card with real mouse events.
    expect(out).not.toContain("draggable");
    expect(out.toLowerCase()).not.toContain("ondrag");
    expect(out).not.toMatch(/\saction=/);
    expect(out).not.toMatch(/\smethod=/);
    expect(out.toLowerCase()).not.toContain("approve");
  });

  it("the board and the list carry the SAME control slot beside the heading", () => {
    const marker = "<b>VIEW TOGGLE</b>";
    const listOut = html(
      <RecordList
        eye="// BRIEFS"
        heading="BRIEFS"
        rows={rows(1)}
        empty={EMPTY}
        actions={<b>VIEW TOGGLE</b>}
      />,
    );
    const boardOut = board([column("Ready", { total: 1, rows: rows(1) })], {
      actions: <b>VIEW TOGGLE</b>,
    });
    expect(listOut).toContain(marker);
    expect(boardOut).toContain(marker);
    expect(listOut).toContain("record-head-actions");
    expect(boardOut).toContain("record-head-actions");
  });

  it("emits the bare heading when there are no actions — the extraction changed nothing", () => {
    // `RecordHeading` wraps only when it has something to put beside the h1, so
    // the four layer views that pass no actions emit exactly what they always
    // did. This is the guard on "the diff must be reviewable as an extraction".
    const out = html(
      <RecordList eye="// X" heading="X" rows={rows(1)} empty={EMPTY} />,
    );
    expect(out).toContain('<span class="shell-eye">// X</span><h1 class="shell-h1 glitch">X</h1>');
    expect(out).not.toContain("record-head");
  });
});

describe("AC #3 · the detail's two navigation actions", () => {
  it("emits LOCATE IN GRAPH carrying the triple", () => {
    const out = html(
      <RecordDetail
        eye="// BR-001"
        title="A brief"
        meta={[{ k: "project", v: "igris-ai" }]}
        backHref="#/layers/briefs"
        locateHref="#/graph?focus=brief/igris-ai/BR-001"
      />,
    );
    expect(out).toContain('href="#/graph?focus=brief/igris-ai/BR-001"');
    expect(out).toContain("LOCATE IN GRAPH");
    expect(out).toContain('href="#/layers/briefs"');
  });

  it("STATES why there is no graph link rather than omitting the row", () => {
    const out = html(
      <RecordDetail
        eye="// coding_guidelines"
        title="coding_guidelines.md"
        meta={[]}
        backHref="#/layers/context-docs"
        locateHref={null}
        locateNote="NOT IN THE GRAPH — CONTEXT DOCS ARE FILES"
      />,
    );
    expect(out).toContain("NOT IN THE GRAPH");
    expect(out).not.toContain("LOCATE IN GRAPH");
  });

  it("shows the AS OF stamp, because the detail does not follow the beat", () => {
    const out = html(
      <RecordDetail
        eye="// X"
        title="X"
        meta={[]}
        backHref="#/layers/briefs"
        locateHref={null}
        asOf="2026-07-30T12:00:00.000Z"
      />,
    );
    expect(out).toContain("AS OF 2026-07-30T12:00:00.000Z");
  });
});

describe("the graph → record direction (NodeInspector)", () => {
  function node(type: string, project: string | null, id: string): GraphNode {
    return {
      key: `${type}|${project ?? ""}|${id}`,
      type,
      id,
      project,
      label: `${type} ${id}`,
      attrs: { status: "open" },
      degree: 4,
    };
  }

  const noop = (): void => undefined;

  it("emits OPEN RECORD for a brief, built from the STRUCTURED triple", () => {
    const out = html(
      <NodeInspector
        node={node("brief", "igris-ai", "BR-001")}
        neighbours={[]}
        onSelect={noop}
        onTrace={noop}
        onClose={noop}
      />,
    );
    expect(out).toContain("OPEN RECORD");
    expect(out).toContain('href="#/layers/briefs/igris-ai/BR-001"');
  });

  it("the SAME id in two projects opens two different records (BR-078)", () => {
    const a = html(
      <NodeInspector node={node("brief", "alpha", "BR-001")} neighbours={[]} onSelect={noop} onTrace={noop} onClose={noop} />,
    );
    const b = html(
      <NodeInspector node={node("brief", "beta", "BR-001")} neighbours={[]} onSelect={noop} onTrace={noop} onClose={noop} />,
    );
    expect(a).toContain('href="#/layers/briefs/alpha/BR-001"');
    expect(b).toContain('href="#/layers/briefs/beta/BR-001"');
  });

  it("says NO DETAIL VIEW for a node type no layer renders", () => {
    // G-BR-1's "does NOT prove" clause requires this to be an explicit state
    // rather than a blank panel or a link to nowhere.
    for (const type of ["session", "concept", "decision"]) {
      const out = html(
        <NodeInspector node={node(type, "igris-ai", "x")} neighbours={[]} onSelect={noop} onTrace={noop} onClose={noop} />,
      );
      expect(out, type).toContain("NO DETAIL VIEW");
      expect(out, type).not.toContain("OPEN RECORD");
      expect(out, type).not.toContain("#/layers/");
    }
  });

  it("renders the attrs bag straight from the node it was handed", () => {
    // TITLED FOR WHAT IT ASSERTS. This used to claim "still issues no fetch",
    // which it cannot observe: no fetch spy is installed and
    // `renderToStaticMarkup` runs no effects, so a `useEffect` full of fetches
    // would render identically. The no-fetch property is a claim about the FILE,
    // and it is asserted as one — by the whole-tree `fetch(` scan in
    // `cli/src/__tests__/dashboard-layers-source.test.ts`, whose corpus was
    // widened to every shipped client file so that `NodeInspector.tsx` is
    // actually in it.
    const out = html(
      <NodeInspector node={node("brief", "igris-ai", "BR-001")} neighbours={[]} onSelect={noop} onTrace={noop} onClose={noop} />,
    );
    // The attrs bag is rendered from the payload the graph already has (R11).
    expect(out).toContain("status");
    expect(out).toContain("open");
  });
});

describe("the 1-hop block tells its four states apart", () => {
  it("distinguishes loading, ready, absent and unavailable", () => {
    const rendered = (["loading", "ready", "absent", "unavailable"] as const).map(
      (state) =>
        html(
          <RecordNeighbours
            state={state}
            entries={
              state === "ready"
                ? [
                    {
                      key: "learning|igris-ai|7",
                      label: "a learning",
                      type: "learning",
                      href: "#/layers/learnings/igris-ai/7",
                    },
                  ]
                : []
            }
          />,
        ),
    );
    // `absent` (no node in the graph) and `unavailable` (the graph read failed)
    // have completely different remedies; rendering them the same way would tell
    // the operator a well-connected record is isolated.
    expect(new Set(rendered).size).toBe(4);
    expect(rendered[1]).toContain('href="#/layers/learnings/igris-ai/7"');
    expect(rendered[2]).toContain("no node in the brain graph");
    expect(rendered[3]).toContain("could not be read");
  });

  it("renders a neighbour with no layer as text, not as a hidden row", () => {
    const out = html(
      <RecordNeighbours
        state="ready"
        entries={[
          { key: "session||42", label: "a session", type: "session", href: null },
        ]}
      />,
    );
    // The edge exists; hiding it would understate the neighbourhood.
    expect(out).toContain("a session");
    expect(out).toContain('data-disabled="true"');
  });

  it("says so when a record genuinely has no edges", () => {
    const out = html(<RecordNeighbours state="ready" entries={[]} />);
    expect(out).toContain("No edges reach this record");
  });
});

// ===========================================================================
// AC #2 — the retrieval banner
// ===========================================================================

describe("AC #2 · a degraded retrieval mode is a BANNER, not a shrug", () => {
  const base: RetrievalReport = {
    mode: "hybrid",
    vector_available: true,
    embedding_available: true,
    bm25_hits: 12,
    vector_hits: 9,
    rrf_k: 60,
    weights: { bm25: 0.5, vector: 0.5 },
    reason: null,
  };

  it("hybrid renders a quiet readout, NOT a banner", () => {
    const out = html(<RetrievalBanner retrieval={base} />);
    expect(out).toContain("HYBRID RECALL");
    expect(out).toContain("bm25 12");
    expect(out).toContain("vector 9");
    expect(out).not.toContain("shell-banner");
  });

  it.each(["bm25_only", "vector_only", "none"] as const)(
    "%s renders a shell-banner naming the mode",
    (mode) => {
      const out = html(
        <RetrievalBanner
          retrieval={{
            ...base,
            mode,
            vector_available: false,
            embedding_available: false,
            vector_hits: 0,
            reason: "sqlite-vec not loaded on this connection",
          }}
        />,
      );
      expect(out).toContain("shell-banner");
      expect(out).toContain(mode.toUpperCase().replace("_", " "));
      // The reason is carried VERBATIM — it is the difference between "search is
      // degraded" and "run postinstall".
      expect(out).toContain("sqlite-vec not loaded on this connection");
    },
  );

  it("names WHICH arm is missing, separately for the extension and the model", () => {
    const noVec = html(
      <RetrievalBanner
        retrieval={{ ...base, mode: "bm25_only", vector_available: false, reason: null }}
      />,
    );
    expect(noVec).toContain("sqlite-vec NOT loaded");

    const noModel = html(
      <RetrievalBanner
        retrieval={{
          ...base,
          mode: "bm25_only",
          vector_available: true,
          embedding_available: false,
          reason: null,
        }}
      />,
    );
    // Two different causes with two different fixes. `vector_available` and
    // `embedding_available` are strictly different facts (D3) and the banner
    // must not collapse them.
    expect(noModel).toContain("embedding model is unavailable");
    expect(noModel).toContain("sqlite-vec loaded");
    expect(noVec).not.toBe(noModel);
  });
});

// ===========================================================================
// AC #7 — read-only, and the filter bar's shape
// ===========================================================================

describe("AC #7 · nothing in the shared components is a write control", () => {
  it("the list, the detail and the filter bar emit no form action or method", () => {
    const out =
      html(<RecordList eye="// X" heading="X" rows={[ROW]} empty={EMPTY} />) +
      html(
        <RecordDetail
          eye="// X"
          title="X"
          meta={[]}
          backHref="#/layers/briefs"
          locateHref={null}
        />,
      ) +
      html(
        <FilterBar
          controls={[
            { name: "status", label: "status", options: ["open", "done"], value: "open" },
          ]}
          onChange={() => undefined}
        />,
      );
    expect(out).not.toMatch(/\saction=/);
    expect(out).not.toMatch(/\smethod=/);
    // No approve/reject/apply anywhere — D9 ships no triage control.
    expect(out.toLowerCase()).not.toContain("approve");
    expect(out.toLowerCase()).not.toContain("reject");
  });
});

describe("the filter bar", () => {
  it("marks the active value with aria-checked and the rest unchecked", () => {
    const out = html(
      <FilterBar
        controls={[
          {
            name: "review_status",
            label: "review",
            options: ["approved", "pending_review"],
            value: "pending_review",
          },
        ]}
        onChange={() => undefined}
      />,
    );
    expect(out).toContain('role="radiogroup"');
    // Exactly one checked chip.
    expect(out.match(/aria-checked="true"/g) ?? []).toHaveLength(1);
    expect(out.match(/aria-checked="false"/g) ?? []).toHaveLength(1);
  });

  it("renders nothing for a control with no options — not an empty row", () => {
    const out = html(
      <FilterBar
        controls={[{ name: "status", label: "status", options: [], value: "" }]}
        onChange={() => undefined}
      />,
    );
    expect(out).not.toContain("record-filter-label");
  });

  it("offers CLEAR FILTERS only when something is set", () => {
    const set = html(
      <FilterBar
        controls={[{ name: "status", label: "status", options: ["a"], value: "a" }]}
        onChange={() => undefined}
        onClearAll={() => undefined}
      />,
    );
    const unset = html(
      <FilterBar
        controls={[{ name: "status", label: "status", options: ["a"], value: "" }]}
        onChange={() => undefined}
        onClearAll={() => undefined}
      />,
    );
    expect(set).toContain("CLEAR FILTERS");
    expect(unset).not.toContain("CLEAR FILTERS");
  });

  it("renders a search box with a submit that is disabled while empty", () => {
    const empty = html(
      <FilterBar
        controls={[]}
        onChange={() => undefined}
        search={{
          label: "hybrid recall",
          value: "",
          onChange: () => undefined,
          onSubmit: () => undefined,
        }}
      />,
    );
    expect(empty).toContain("hybrid recall");
    expect(empty).toContain("disabled");

    const filled = html(
      <FilterBar
        controls={[]}
        onChange={() => undefined}
        search={{
          label: "hybrid recall",
          value: "vector",
          onChange: () => undefined,
          onSubmit: () => undefined,
        }}
      />,
    );
    expect(filled).not.toContain("disabled");
  });
});
