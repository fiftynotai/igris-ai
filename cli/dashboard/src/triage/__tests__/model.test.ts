/**
 * FR-241 G-UI-1 — the destructiveness tiering, proved WITHOUT a browser.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE IS THE SAFETY GATE AND THE BROWSER GATE IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * `igris_perception_reject` HARD-DELETES a first-time candidate — `DELETE FROM
 * learnings` plus its vector row, with no undo tool anywhere in the brain. The
 * only thing standing between a mis-click and that is the confirmation copy,
 * and the copy is only trustworthy if it counts the two branches correctly on a
 * MIXED selection. A browser gate can show that A dialog opened; only a table
 * can show that it opened with the right NUMBER in it, across every partition.
 *
 * WHAT THIS FILE PROVES
 *   - `destructiveness()` partitions a selection into the three tiers by the
 *     real `seen_again_count` fork (`perception/handlers.ts:661-717`).
 *   - a mixed 3-recurring + 2-first-time reject names **2** as permanently
 *     deleted — not 5, not 0.
 *   - the tier-3 sentence is its OWN entry in `lines` and is always last.
 *   - a tier-3 BULK demands a typed count; a tier-1 bulk of any size does not.
 *   - selection algebra: `confineToVisible` drops off-page ids, so a bulk can
 *     never fire at a row the operator cannot see.
 *   - `chunkIds` yields ZERO chunks for an empty selection, so the client can
 *     never issue the empty-`ids` request the server 400s.
 *
 * WHAT IT DOES **NOT** PROVE
 *   - that the dialog RENDERS these strings, or that the confirm button is
 *     wired to the request. Sibling: `triage-render.test.tsx` (static render of
 *     the real components) and the CDP gate `G-BR-8` (a real click through a
 *     real dialog against a real brain).
 *   - that the SERVER agrees about which branch a row takes. Sibling:
 *     `cli/src/__tests__/dashboard-triage-endpoint.test.ts` G-TR-1, which
 *     rejects one row of each kind and reads the table back.
 *   - anything about `seen_again_count` being CORRECT on the wire. Sibling:
 *     `brain-mcp-server/src/tools/__tests__/memory-read.test.ts`, where the
 *     column joined `listLearnings`'s projection.
 */

import { describe, expect, it } from "vitest";
import {
  EMPTY_SELECTION,
  MAX_BULK,
  TAB_ACTIONS,
  TRIAGE_ACTIONS,
  buildTriageRequest,
  chunkIds,
  confineToVisible,
  confirmCopy,
  destructiveness,
  mergeResults,
  plural,
  reasonRequired,
  selectAll,
  selectedRows,
  summaryLine,
  toggleSelected,
  type TriageAction,
  type TriageRow,
} from "../model";

/** A candidate row with a known recurrence count. */
const cand = (id: number, seen: number | null | undefined): TriageRow => ({
  id,
  seen_again_count: seen,
});
/** A suggestion row — no `seen_again_count` field at all. */
const sugg = (id: number): TriageRow => ({ id });

// ---------------------------------------------------------------------------
// destructiveness
// ---------------------------------------------------------------------------

describe("G-UI-1a · destructiveness partitions the selection by the REAL fork", () => {
  it.each<[TriageAction, number, number, number]>([
    // action     tier1 tier2 tier3   — over the SAME five rows
    ["dismiss", 5, 0, 0],
    ["acted", 5, 0, 0],
    ["apply", 5, 0, 0],
    ["approve", 5, 0, 0],
    ["reject", 0, 3, 2],
  ])(
    "%s over 3 recurring + 2 first-time -> tier1=%i tier2=%i tier3=%i",
    (action, tier1, tier2, tier3) => {
      const rows = [cand(1, 4), cand(2, 1), cand(3, 9), cand(4, 0), cand(5, 0)];
      const d = destructiveness(rows, action);
      expect({ tier1: d.tier1, tier2: d.tier2, tier3: d.tier3 }).toEqual({
        tier1,
        tier2,
        tier3,
      });
      expect(d.total).toBe(5);
      // Every row lands in exactly one tier — no row is counted twice or lost.
      expect(d.tier1 + d.tier2 + d.tier3).toBe(5);
    },
  );

  it("the ACTION is what forks it — the same rows are tier 1 under approve", () => {
    // This is the assertion that makes the parameterised table above more than
    // a shape check: an implementation that ignored `action` and always forked
    // on `seen_again_count` would pass a reject-only test.
    const rows = [cand(1, 0), cand(2, 0)];
    expect(destructiveness(rows, "approve").tier3).toBe(0);
    expect(destructiveness(rows, "reject").tier3).toBe(2);
  });

  it("an UNKNOWN seen_again_count counts as tier 3, and says so", () => {
    // Under-warning costs a row; over-warning costs a keystroke. The asymmetry
    // is why absence resolves to the worse tier — and why the count of
    // "unknown" is reported separately rather than folded in silently.
    for (const missing of [undefined, null, Number.NaN]) {
      const d = destructiveness([cand(1, missing as number | null)], "reject");
      expect(d.tier3, `seen_again_count=${String(missing)}`).toBe(1);
      expect(d.unknownTier3).toBe(1);
      expect(d.tier2).toBe(0);
    }
  });

  it("a suggestion row (no such field) is tier 1 under its own actions", () => {
    const d = destructiveness([sugg(1), sugg(2)], "dismiss");
    expect(d).toEqual({ tier1: 2, tier2: 0, tier3: 0, unknownTier3: 0, total: 2 });
  });

  it("the empty selection is all zeros for every action", () => {
    for (const action of TRIAGE_ACTIONS) {
      expect(destructiveness([], action)).toEqual({
        tier1: 0,
        tier2: 0,
        tier3: 0,
        unknownTier3: 0,
        total: 0,
      });
    }
  });

  it("the all-tier-3 case", () => {
    const rows = [cand(1, 0), cand(2, 0), cand(3, 0)];
    const d = destructiveness(rows, "reject");
    expect(d.tier3).toBe(3);
    expect(d.tier2).toBe(0);
    expect(d.unknownTier3).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// confirmCopy — the sentence the operator actually reads
// ---------------------------------------------------------------------------

describe("G-UI-1b · the mixed-selection copy names the RIGHT number", () => {
  const mixed = destructiveness(
    [cand(1, 4), cand(2, 1), cand(3, 9), cand(4, 0), cand(5, 0)],
    "reject",
  );

  it("names 2 as permanently deleted — not 5 and not 0", () => {
    const copy = confirmCopy("reject", mixed);
    expect(copy.hardDeleteLine).toContain("2 items will be PERMANENTLY DELETED");
    expect(copy.hardDeleteLine).toContain("cannot be undone");
    // The numbers that must NOT appear as the permanent count.
    expect(copy.hardDeleteLine).not.toContain("5 items will be PERMANENTLY");
    expect(copy.hardDeleteLine).not.toContain("3 items will be PERMANENTLY");
  });

  it("states the soft-delete count SEPARATELY and calls it recoverable", () => {
    const copy = confirmCopy("reject", mixed);
    const soft = copy.lines.find((l) => l.includes("SOFT-deleted"));
    expect(soft).toContain("3 items");
    expect(soft).toContain("recoverable");
  });

  it("the tier-3 sentence is its OWN line and is LAST", () => {
    // The plan's explicit requirement. A count buried in the middle of a
    // paragraph is a count the eye skips.
    const copy = confirmCopy("reject", mixed);
    expect(copy.lines).toHaveLength(2); // tier2 + tier3, no tier1 under reject
    expect(copy.lines[copy.lines.length - 1]).toBe(copy.hardDeleteLine);
    // ...and no OTHER line mentions permanent deletion.
    const others = copy.lines.slice(0, -1).join(" ");
    expect(others).not.toContain("PERMANENTLY");
  });

  it("an all-recoverable reject has NO hard-delete line at all", () => {
    // The negative control for the assertion above: a copy generator that
    // always appended the sentence would pass every test so far.
    const soft = destructiveness([cand(1, 2), cand(2, 5)], "reject");
    const copy = confirmCopy("reject", soft);
    expect(copy.hardDeleteLine).toBeNull();
    expect(copy.lines.join(" ")).not.toContain("PERMANENTLY");
    expect(copy.requireTyped).toBeNull();
  });

  it("a tier-1 action never claims anything is deleted", () => {
    for (const action of ["dismiss", "acted", "approve", "apply"] as const) {
      const copy = confirmCopy(action, destructiveness([sugg(1), sugg(2)], action));
      expect(copy.hardDeleteLine, action).toBeNull();
      expect(copy.lines.join(" "), action).not.toContain("DELET");
      expect(copy.lines.join(" "), action).toContain("no un-");
    }
  });

  it("reports how many tier-3 rows got there through UNKNOWN recurrence", () => {
    const d = destructiveness([cand(1, 0), cand(2, undefined)], "reject");
    const copy = confirmCopy("reject", d);
    expect(copy.hardDeleteLine).toContain("2 items will be PERMANENTLY DELETED");
    expect(copy.hardDeleteLine).toContain("1 of those could not be checked");
  });

  it("an empty selection says so rather than rendering an empty dialog", () => {
    const copy = confirmCopy("dismiss", destructiveness([], "dismiss"));
    expect(copy.lines).toEqual([
      "Nothing is selected. This action would do nothing.",
    ]);
    expect(copy.requireTyped).toBeNull();
  });
});

describe("G-UI-1c · the typed confirmation fires exactly when it should", () => {
  it("a tier-3 BULK demands the tier-3 count be typed", () => {
    const d = destructiveness([cand(1, 0), cand(2, 0), cand(3, 7)], "reject");
    // 2 hard, 1 soft — the operator types "2", the count of the IRREVERSIBLE
    // half, not the size of the selection. Typing "3" must not work.
    expect(confirmCopy("reject", d).requireTyped).toBe("2");
  });

  it("a SINGLE hard delete does not demand typing (but still says PERMANENT)", () => {
    const d = destructiveness([cand(9, 0)], "reject");
    const copy = confirmCopy("reject", d);
    expect(copy.requireTyped).toBeNull();
    expect(copy.hardDeleteLine).toContain("1 item will be PERMANENTLY DELETED");
  });

  it("a tier-1 bulk of 200 demands NO typing", () => {
    // The negative control: without it, "requireTyped is set" would be
    // satisfiable by a rule that keyed off batch size instead of tier.
    const rows = Array.from({ length: 200 }, (_, i) => sugg(i + 1));
    expect(confirmCopy("dismiss", destructiveness(rows, "dismiss")).requireTyped).toBeNull();
  });

  it("a tier-2-only bulk demands NO typing — soft deletes are recoverable", () => {
    const rows = [cand(1, 3), cand(2, 3), cand(3, 3)];
    expect(confirmCopy("reject", destructiveness(rows, "reject")).requireTyped).toBeNull();
  });

  it("the confirm button names the destructive count when there is one", () => {
    const hard = destructiveness([cand(1, 0), cand(2, 0)], "reject");
    expect(confirmCopy("reject", hard).confirmLabel).toBe("DELETE 2 PERMANENTLY");
    const soft = destructiveness([cand(1, 1), cand(2, 1)], "reject");
    expect(confirmCopy("reject", soft).confirmLabel).toBe("REJECT 2");
  });
});

// ---------------------------------------------------------------------------
// Selection algebra
// ---------------------------------------------------------------------------

describe("G-UI-1d · selection algebra", () => {
  it("toggle adds then removes, without mutating the input", () => {
    const a = toggleSelected(EMPTY_SELECTION, 5);
    expect([...a]).toEqual([5]);
    expect(EMPTY_SELECTION.size).toBe(0);
    expect([...toggleSelected(a, 5)]).toEqual([]);
  });

  it("selectAll ADDS to the existing selection", () => {
    const a = toggleSelected(EMPTY_SELECTION, 99);
    const b = selectAll(a, [sugg(1), sugg(2)]);
    expect([...b].sort((x, y) => x - y)).toEqual([1, 2, 99]);
  });

  it("confineToVisible drops ids that left the page — the safety rule", () => {
    // Selected on page 1, then the operator changed the filter. A bulk action
    // must not reach id 99 any more: you may only act on what is on screen.
    const selection = new Set([1, 2, 99]);
    const confined = confineToVisible(selection, [sugg(1), sugg(2), sugg(3)]);
    expect([...confined].sort((x, y) => x - y)).toEqual([1, 2]);
  });

  it("confineToVisible on an EMPTY page clears the selection entirely", () => {
    expect(confineToVisible(new Set([1, 2, 3]), []).size).toBe(0);
  });

  it("selectedRows returns rows in LIST order, not selection order", () => {
    const rows = [sugg(3), sugg(1), sugg(2)];
    expect(selectedRows(new Set([2, 3]), rows).map((r) => r.id)).toEqual([3, 2]);
  });
});

describe("G-UI-1e · chunking mirrors the server's MAX_BULK", () => {
  it("MAX_BULK matches the server constant", () => {
    // A drift here means the client sends 250 and the server silently clamps to
    // 200 — the exact "50 rows vanished" report nobody can reproduce.
    expect(MAX_BULK).toBe(200);
  });

  it("an EMPTY selection yields ZERO chunks, never one empty request", () => {
    // The server 400s an empty `ids`; more importantly, a bulk action on zero
    // items is this brief's named vacuous gate, and the client refuses to
    // produce one.
    expect(chunkIds([])).toEqual([]);
  });

  it("250 ids split 200 + 50, preserving order and losing nothing", () => {
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    const chunks = chunkIds(ids);
    expect(chunks.map((c) => c.length)).toEqual([200, 50]);
    expect(chunks.flat()).toEqual(ids);
  });

  it("exactly MAX_BULK is ONE chunk, not two", () => {
    expect(chunkIds(Array.from({ length: 200 }, (_, i) => i)).length).toBe(1);
  });

  it("refuses a nonsense chunk size rather than looping forever", () => {
    expect(() => chunkIds([1, 2], 0)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

describe("G-UI-1f · the request body only ever carries accepted keys", () => {
  it("dismiss carries the reason; acted carries the brief id", () => {
    expect(buildTriageRequest("dismiss", [1, 2], { reason: " stale " })).toEqual({
      action: "dismiss",
      ids: [1, 2],
      reason: "stale",
    });
    expect(buildTriageRequest("acted", [3], { briefId: "FR-241" })).toEqual({
      action: "acted",
      ids: [3],
      brief_id: "FR-241",
    });
  });

  it("a reason on `acted` is DROPPED — the server 400s an unknown field", () => {
    // `extra` in the frozen map allows `brief_id` for `acted` and nothing else.
    // Sending a stray key would be a client-authored 400, so the builder
    // filters by action rather than copying whatever it was handed.
    expect(buildTriageRequest("acted", [3], { reason: "x", briefId: "BR-1" })).toEqual({
      action: "acted",
      ids: [3],
      brief_id: "BR-1",
    });
    expect(buildTriageRequest("dismiss", [3], { briefId: "BR-1", reason: "r" })).toEqual({
      action: "dismiss",
      ids: [3],
      reason: "r",
    });
  });

  it("a blank or whitespace-only reason is OMITTED, not sent as empty", () => {
    for (const blank of ["", "   ", undefined]) {
      const body = buildTriageRequest("dismiss", [1], { reason: blank });
      expect(Object.hasOwn(body, "reason"), JSON.stringify(blank)).toBe(false);
    }
  });

  it("approve and reject never carry a brief id", () => {
    expect(buildTriageRequest("approve", [1], { briefId: "BR-1" })).toEqual({
      action: "approve",
      ids: [1],
    });
  });

  it("copies the ids rather than aliasing the caller's array", () => {
    const ids = [1, 2];
    const body = buildTriageRequest("dismiss", ids, { reason: "r" });
    ids.push(3);
    expect(body.ids).toEqual([1, 2]);
  });

  it("only dismiss REQUIRES a reason (the suppression-loop signal)", () => {
    expect(reasonRequired("dismiss")).toBe(true);
    for (const a of ["acted", "apply", "approve", "reject"] as const) {
      expect(reasonRequired(a), a).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Result merging
// ---------------------------------------------------------------------------

describe("G-UI-1g · merging a chunked bulk", () => {
  const chunk = (
    applied: number,
    failures: Array<[number, string]>,
    extra: Partial<{ params: string[]; degraded: { reason: string } | null }> = {},
  ) => ({
    applied,
    failed: failures.length,
    results: [
      ...Array.from({ length: applied }, (_, i) => ({
        id: 1000 + i,
        ok: true,
        error: null,
      })),
      ...failures.map(([id, error]) => ({ id, ok: false, error })),
    ],
    params: extra.params ?? [],
    degraded: extra.degraded ?? null,
  });

  it("sums applied/failed and keeps the BRAIN's verbatim failure messages", () => {
    const s = mergeResults(5, [
      chunk(2, [[7, "Suggestion 7 already acted; cannot dismiss"]]),
      chunk(1, [[9, "Suggestion not found: 9"]]),
    ]);
    expect(s.applied).toBe(3);
    expect(s.failed).toBe(2);
    expect(s.failures.map((f) => f.error)).toEqual([
      "Suggestion 7 already acted; cannot dismiss",
      "Suggestion not found: 9",
    ]);
  });

  it("`requested` is the CALLER's count, not the sum of the responses", () => {
    // A degraded chunk reports applied:0 with no results. Summing responses
    // would make "0 of 0" read as success on a request that mutated nothing.
    const s = mergeResults(40, [chunk(0, [], { degraded: { reason: "boot_failed" } })]);
    expect(s.requested).toBe(40);
    expect(s.applied).toBe(0);
    expect(s.degraded).toBe("boot_failed");
    expect(summaryLine("dismiss", s)).toBe("DISMISS — 0 of 40 applied · boot_failed");
  });

  it("dedupes the params notes across chunks", () => {
    const note = "ids: dropped a duplicate id (4)";
    const s = mergeResults(2, [chunk(1, [], { params: [note] }), chunk(1, [], { params: [note] })]);
    expect(s.params).toEqual([note]);
  });

  it("summaryLine reads as a sentence in each of the three shapes", () => {
    expect(summaryLine("dismiss", mergeResults(3, [chunk(3, [])]))).toBe(
      "DISMISS — 3 of 3 applied",
    );
    expect(summaryLine("reject", mergeResults(3, [chunk(2, [[1, "nope"]])]))).toBe(
      "REJECT — 2 of 3 applied, 1 failed",
    );
  });
});

describe("G-UI-1h · the vocabularies are complete and partitioned", () => {
  it("every tab action is a real action, and the union is the whole map", () => {
    const union = [...TAB_ACTIONS.suggestions, ...TAB_ACTIONS.candidates];
    for (const a of union) expect(TRIAGE_ACTIONS).toContain(a);
    // `apply` is the one action no tab offers in v1 — D4 makes it single-item
    // only, and a bulk bar is the wrong control for it. Named here so the
    // omission is a decision on the record rather than a gap.
    expect([...TRIAGE_ACTIONS].filter((a) => !union.includes(a))).toEqual(["apply"]);
  });

  it("no action appears on both tabs", () => {
    for (const a of TAB_ACTIONS.suggestions) {
      expect(TAB_ACTIONS.candidates).not.toContain(a);
    }
  });

  it("plural is used for the counts and gets 1 right", () => {
    expect(plural(1, "item")).toBe("1 item");
    expect(plural(0, "item")).toBe("0 items");
    expect(plural(12, "item")).toBe("12 items");
  });
});
