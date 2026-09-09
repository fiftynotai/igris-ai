/**
 * FR-245 — the briefs board's pure decisions: **which columns exist, in what
 * order, what each one asks for, and how a sentence becomes a header.**
 *
 * WHAT THIS FILE PROVES
 *   - Every status value present in scope gets a column, and so does every
 *     value in the documented lifecycle vocabulary. Neither source alone.
 *   - **NOTHING IS FOLDED.** `Done`, `Completed` and `Complete` are THREE
 *     columns with three counts; `In Progress` and `InProgress` are TWO. B5 and
 *     B6 exist so a future "helpful" merge fails a test rather than silently
 *     rewriting the operator's read of their own backlog. TD-333 owns the data.
 *   - A status the vocabulary has never heard of still gets a column — the
 *     anti-allowlist property, which is the whole reason `params.ts` leaves the
 *     brief filters `allowed: null`.
 *   - The per-column query carries the column's OWN status exactly once and
 *     keeps every other filter, so the user's `status` value never reaches the
 *     wire in board mode (D6).
 *
 * WHAT IT DOES **NOT** PROVE
 *   That the board FETCHES those queries, renders those columns or agrees with
 *   the endpoint. **Siblings:** `components/record/__tests__/record.test.tsx`
 *   (the arrangement, rendered) and `G-BR-12` in `cli/scripts/browser-gate.mjs`
 *   (the column set against a live `/api/summary`, the column sum against
 *   `briefs.total`, and the filters driven through real clicks).
 */

import { describe, expect, it } from "vitest";
import {
  CARD_CAP,
  KNOWN_BRIEF_STATUSES,
  LABEL_MAX,
  MANY_COLUMNS,
  boardQuery,
  columnLabel,
  deriveStatusColumns,
  hasNonStatusFilters,
  listHandoffFor,
  normaliseForOrder,
  statusRank,
} from "../board.js";

/**
 * The operator's real distribution, read READ-ONLY on 2026-08-02:
 *   sqlite3 "file:$HOME/.igris/memory/knowledge.db?mode=ro" \
 *     "SELECT status, COUNT(*) FROM brief_status GROUP BY 1 ORDER BY 2 DESC"
 *
 * Reproduced as a literal because that is what makes it an assertion: the
 * suite must never open the operator's brain. Fifteen values, three spellings
 * of finished, two of in-flight, one with a commit hash welded in, and two
 * whole sentences. This is the fixture the board has to render honestly.
 */
const REAL_BY_STATUS: Record<string, number> = {
  Done: 1195,
  Archived: 256,
  Ready: 242,
  "In Progress": 26,
  Completed: 24,
  Cancelled: 23,
  Superseded: 17,
  Draft: 7,
  Deferred: 7,
  InProgress: 4,
  Blocked: 4,
  "Split (see FR-161, FR-162, FR-163, FR-164, FR-165, FR-166, FR-167)": 1,
  "Split (see FR-061, FR-062, FR-063)": 1,
  "Done(Resolvedbydec8d1f)": 1,
  Complete: 1,
};

const statuses = (input: Parameters<typeof deriveStatusColumns>[0]): string[] =>
  deriveStatusColumns(input).map((c) => c.status);

describe("B1 · every status in the data gets a column, exactly once", () => {
  it("renders all fifteen real values, including the hostile ones", () => {
    const got = statuses({ byStatus: REAL_BY_STATUS });
    for (const raw of Object.keys(REAL_BY_STATUS)) {
      expect(got, `${raw} has no column`).toContain(raw);
      expect(
        got.filter((s) => s === raw),
        `${raw} has more than one column`,
      ).toHaveLength(1);
    }
    // The vocabulary adds nothing here beyond what the data already has, so the
    // set is exactly the fifteen. A sixteenth column would mean the union
    // introduced a value neither source holds.
    expect(got).toHaveLength(15);
  });

  it("carries the sentence statuses and the commit-hash one VERBATIM", () => {
    const got = statuses({ byStatus: REAL_BY_STATUS });
    expect(got).toContain("Done(Resolvedbydec8d1f)");
    expect(got).toContain(
      "Split (see FR-161, FR-162, FR-163, FR-164, FR-165, FR-166, FR-167)",
    );
  });
});

describe("B2/B3 · the vocabulary fills in what the data is silent about", () => {
  it("gives In Progress a column on a scope with nothing in flight", () => {
    // The `igris-ai` snapshot shape: work exists, none of it is in flight.
    const got = statuses({ byStatus: { Ready: 12, Done: 40 } });
    expect(got).toContain("In Progress");
    expect(got).toContain("Blocked");
    expect(got).toContain("Draft");
  });

  it("renders the six vocabulary columns and nothing else for an empty scope", () => {
    expect(statuses({ byStatus: {} })).toEqual([...KNOWN_BRIEF_STATUSES]);
    expect(statuses({ byStatus: null })).toEqual([...KNOWN_BRIEF_STATUSES]);
    expect(statuses({ byStatus: undefined })).toEqual([...KNOWN_BRIEF_STATUSES]);
  });

  it("the vocabulary is the documented lifecycle, in lifecycle order", () => {
    // Mirrored from `docs/architecture/brief-state-source-of-truth.md:13`.
    // MAINTAINING row 95 sweeps this constant when that vocabulary changes.
    expect([...KNOWN_BRIEF_STATUSES]).toEqual([
      "Draft",
      "Ready",
      "In Progress",
      "Blocked",
      "Done",
      "Archived",
    ]);
  });
});

describe("B4 · a status nobody has ever seen still gets a column", () => {
  it("ranks an unknown value into the tail rather than dropping it", () => {
    const got = deriveStatusColumns({ byStatus: { Frobnicated: 3, Done: 9 } });
    const frob = got.find((c) => c.status === "Frobnicated");
    expect(frob, "Frobnicated was dropped — this board has an allowlist").toBeDefined();
    expect(frob?.rank).toBeNull();
    expect(frob?.seen).toBe(3);
    // ...and it sits after every documented status, not among them.
    const names = got.map((c) => c.status);
    expect(names.indexOf("Frobnicated")).toBeGreaterThan(names.indexOf("Archived"));
  });
});

describe("B5/B6 · spellings sort together and NOTHING merges", () => {
  it("B5 — In Progress and InProgress are TWO adjacent columns, counts unsummed", () => {
    const got = deriveStatusColumns({ byStatus: REAL_BY_STATUS });
    const names = got.map((c) => c.status);
    const a = names.indexOf("In Progress");
    const b = names.indexOf("InProgress");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(Math.abs(a - b), "the two spellings are not adjacent").toBe(1);
    // The exact documented spelling leads its own slot.
    expect(b - a).toBe(1);
    // Two columns, two counts. 26 and 4, never 30.
    expect(got[a]?.seen).toBe(26);
    expect(got[b]?.seen).toBe(4);
    // They share a family, which is WHY they are adjacent — and a family is a
    // sort key, not a merge.
    expect(got[a]?.family).toBe(got[b]?.family);
    expect(got[a]?.rank).toBe(got[b]?.rank);
  });

  it("B6 — Done, Completed and Complete are THREE columns", () => {
    const got = deriveStatusColumns({
      byStatus: { Done: 1195, Completed: 24, Complete: 1 },
    });
    const finished = got.filter((c) =>
      ["Done", "Completed", "Complete"].includes(c.status),
    );
    // THE PIN. If a future edit merges the three spellings of "finished", this
    // line fails. That is deliberate: the duplication is the brain's real
    // state (TD-333 owns it), and a UI that folds it hides a data defect behind
    // a tidy column.
    expect(finished).toHaveLength(3);
    expect(finished.map((c) => c.seen)).toEqual(
      expect.arrayContaining([1195, 24, 1]),
    );
    // ...and no column anywhere reports the merged total.
    expect(got.map((c) => c.seen)).not.toContain(1220);
  });

  it("normalisation is for SORT only — it never becomes a synonym table", () => {
    expect(normaliseForOrder("In Progress")).toBe("inprogress");
    expect(normaliseForOrder("InProgress")).toBe("inprogress");
    expect(statusRank("InProgress")).toBe(statusRank("In Progress"));
    // `Completed` is a SYNONYM of `Done`, not a spelling of it, and nothing
    // here knows that. This is the boundary D7 fixes so it cannot creep.
    expect(normaliseForOrder("Completed")).not.toBe(normaliseForOrder("Done"));
    expect(statusRank("Completed")).toBeNull();
    expect(statusRank("Complete")).toBeNull();
    expect(statusRank("Done(Resolvedbydec8d1f)")).toBeNull();
  });
});

describe("B7/B8 · the header truncation is a function, not a CSS accident", () => {
  const SENTENCE =
    "Split (see FR-161, FR-162, FR-163, FR-164, FR-165, FR-166, FR-167)";

  it("B7 — a 66-character status truncates and keeps the full value", () => {
    expect(SENTENCE.length).toBeGreaterThan(LABEL_MAX);
    const out = columnLabel(SENTENCE);
    expect(out.truncated).toBe(true);
    expect(out.label.length).toBeLessThanOrEqual(LABEL_MAX + 1);
    expect(out.label.endsWith("…")).toBe(true);
    // Byte-identical: the raw value is what `data-status` and the query carry.
    expect(out.full).toBe(SENTENCE);
  });

  it("B8 — a short status is untouched (the negative control)", () => {
    const out = columnLabel("Ready");
    expect(out.truncated).toBe(false);
    expect(out.label).toBe("Ready");
    expect(out.label).toBe(out.full);
  });

  it("a status of exactly LABEL_MAX characters is not truncated", () => {
    const exact = "x".repeat(LABEL_MAX);
    expect(columnLabel(exact).truncated).toBe(false);
    expect(columnLabel(`${exact}y`).truncated).toBe(true);
  });
});

describe("B9 · the per-column query (D6)", () => {
  it("emits the COLUMN's status once and never the user's", () => {
    const q = boardQuery({
      project: "igris-ai",
      values: { priority: "P1-High", status: "Done" },
      status: "Ready",
    });
    expect(q.getAll("status")).toEqual(["Ready"]);
    expect(q.get("priority")).toBe("P1-High");
    expect(q.get("project")).toBe("igris-ai");
    expect(q.get("limit")).toBe(String(CARD_CAP));
    expect(q.get("offset")).toBe("0");
    // The user's `Done` never reaches the wire for the `Ready` column.
    expect(q.toString()).not.toContain("Done");
  });

  it("passes the other three filters through untouched", () => {
    const q = boardQuery({
      project: null,
      values: { priority: "P2-Medium", effort: "S", brief_type: "tech-debt" },
      status: "Blocked",
    });
    expect(q.get("priority")).toBe("P2-Medium");
    expect(q.get("effort")).toBe("S");
    expect(q.get("brief_type")).toBe("tech-debt");
    // No project param at all when the scope is "every project" — the same
    // shape `listQuery` already produces, so the board and the list ask the
    // endpoint the same question about scope.
    expect(q.has("project")).toBe(false);
  });

  it("encodes a hostile status rather than concatenating it", () => {
    // A status containing `&`, `#`, `%` or a space would split the query or
    // corrupt the next parameter if it were ever pasted into a string.
    const hostile = "Split (see FR-161, FR-162) & 100% #done";
    const q = boardQuery({ project: "a b", values: {}, status: hostile });
    expect(q.get("status")).toBe(hostile);
    expect(q.get("project")).toBe("a b");
    // Round-trips through the wire form.
    expect(new URLSearchParams(q.toString()).get("status")).toBe(hostile);
  });

  it("the caller can widen the window without touching the default", () => {
    expect(boardQuery({ project: null, values: {}, status: "Done", limit: 50 }).get("limit")).toBe("50");
    expect(CARD_CAP).toBe(12);
  });
});

describe("B10 · an active status filter narrows the COLUMN SET", () => {
  it("renders exactly one column", () => {
    const got = deriveStatusColumns({
      byStatus: REAL_BY_STATUS,
      statusFilter: "Done",
    });
    expect(got.map((c) => c.status)).toEqual(["Done"]);
    expect(got[0]?.seen).toBe(1195);
  });

  it("renders the asked-for column even when the scope has none of it", () => {
    const got = deriveStatusColumns({ byStatus: { Ready: 4 }, statusFilter: "Blocked" });
    expect(got.map((c) => c.status)).toEqual(["Blocked"]);
    expect(got[0]?.seen).toBe(0);
  });

  it("an empty filter string is not a filter", () => {
    expect(statuses({ byStatus: { Ready: 1 }, statusFilter: "" })).toHaveLength(
      KNOWN_BRIEF_STATUSES.length,
    );
  });
});

describe("B11 · the order over the full fifteen is deterministic", () => {
  it("puts the lifecycle first and the rest by count, then alphabetically", () => {
    expect(statuses({ byStatus: REAL_BY_STATUS })).toEqual([
      // Lifecycle head — including the spellings that normalise into it.
      "Draft",
      "Ready",
      "In Progress",
      "InProgress",
      "Blocked",
      "Done",
      "Archived",
      // Tail: by count descending...
      "Completed",
      "Cancelled",
      "Superseded",
      "Deferred",
      // ...then alphabetically among the four that tie at one row each.
      "Complete",
      "Done(Resolvedbydec8d1f)",
      "Split (see FR-061, FR-062, FR-063)",
      "Split (see FR-161, FR-162, FR-163, FR-164, FR-165, FR-166, FR-167)",
    ]);
  });

  it("is stable under a reordered input map", () => {
    const reversed: Record<string, number> = {};
    for (const k of Object.keys(REAL_BY_STATUS).reverse()) {
      reversed[k] = REAL_BY_STATUS[k] as number;
    }
    expect(statuses({ byStatus: reversed })).toEqual(statuses({ byStatus: REAL_BY_STATUS }));
  });

  it("STATES the residual: the three finished SYNONYMS are not adjacent", () => {
    /*
     * Read this before "fixing" the order. `Completed` (24 rows) sorts to the
     * head of the tail and `Complete` (1 row) sits four columns further on,
     * because the tail is ordered by COUNT and nothing mechanical knows the two
     * words mean the same thing. Making them adjacent needs a synonym table,
     * and a synonym table is one keystroke from the merge B6 pins against.
     *
     * The board's answer to the confusion is the note it renders naming
     * TD-333 — not a tidier sort.
     */
    const names = statuses({ byStatus: REAL_BY_STATUS });
    expect(Math.abs(names.indexOf("Completed") - names.indexOf("Complete"))).toBeGreaterThan(1);
    // The pair that IS adjacent is the pair that normalises equal.
    expect(
      Math.abs(names.indexOf("In Progress") - names.indexOf("InProgress")),
    ).toBe(1);
  });

  it("would banner a set this size only above MANY_COLUMNS", () => {
    expect(statuses({ byStatus: REAL_BY_STATUS }).length).toBeLessThan(MANY_COLUMNS);
    expect(MANY_COLUMNS).toBeGreaterThan(KNOWN_BRIEF_STATUSES.length);
  });
});

describe("the OPEN IN LIST handoff", () => {
  it("hands the list the column's raw status as a filter value", () => {
    expect(listHandoffFor("Done(Resolvedbydec8d1f)")).toEqual({
      status: "Done(Resolvedbydec8d1f)",
    });
  });

  it("hasNonStatusFilters ignores the axis and sees the other four", () => {
    expect(hasNonStatusFilters({})).toBe(false);
    expect(hasNonStatusFilters({ status: "Done" })).toBe(false);
    expect(hasNonStatusFilters({ priority: "P1-High" })).toBe(true);
    expect(hasNonStatusFilters({ effort: "S" })).toBe(true);
    expect(hasNonStatusFilters({ brief_type: "bug" })).toBe(true);
    // An empty value is not a narrowing.
    expect(hasNonStatusFilters({ priority: "" })).toBe(false);
  });
});
