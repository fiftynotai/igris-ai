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
  BRIEF_WRITE_ACTIONS,
  CANONICAL_PRIORITIES,
  CREATE_ACTIONS,
  EMPTY_KEY_SELECTION,
  EMPTY_SELECTION,
  MAX_BULK,
  PRIORITY_CLEAR,
  TAB_ACTIONS,
  TRIAGE_ACTIONS,
  briefWriteCopy,
  buildBriefWriteRequest,
  buildCreateGoalRequest,
  buildTriageRequest,
  chunkIds,
  confineToKeys,
  confineToVisible,
  confirmCopy,
  destructiveness,
  mergeResults,
  outcomeLabel,
  plural,
  priorityChoices,
  refKey,
  reasonRequired,
  selectAll,
  selectAllKeys,
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

// ---------------------------------------------------------------------------
// FR-247 — the priority vocabulary MIRROR, and the key-type generalisation
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MIRROR ASSERTION. READ THIS BEFORE EDITING `CANONICAL_PRIORITIES`.
 * ═══════════════════════════════════════════════════════════════════════════
 * `model.ts#CANONICAL_PRIORITIES` is a MIRROR of
 * `brain-mcp-server/src/tools/brief-normalize.ts#CANONICAL_PRIORITIES`. The Vite
 * chunk cannot import the brain bundle, so the two cannot be the same array —
 * which makes this the dashboard's FIRST out-of-brain consumer of a vocabulary
 * that had exactly one source. MAINTAINING carries the contract row.
 *
 * THE CHANGE PROCEDURE, in this order: edit the brain source, mirror here,
 * re-run this test.
 *
 * WHAT THIS TEST PROVES: the mirror holds the four values, in the brain's
 * order, and the picker offers exactly them plus CLEAR.
 * WHAT IT DOES NOT PROVE: that the BRAIN's array still says the same thing —
 * a vitest suite in `cli/dashboard` cannot import `brain-mcp-server`. The
 * cross-package half is the MAINTAINING row plus
 * `scripts/check_contract_consumers.sh`; do not weaken either on the
 * assumption this test has it covered.
 */
describe("FR-247 — the priority picker prescribes, it does not report", () => {
  it("the mirror is the four canonical values, in the brain's order", () => {
    expect([...CANONICAL_PRIORITIES]).toEqual([
      "P0-Critical",
      "P1-High",
      "P2-Medium",
      "P3-Low",
    ]);
  });

  it("with a canonical current value, the picker offers exactly 4 + CLEAR", () => {
    const choices = priorityChoices("P2-Medium");
    expect(choices.map((c) => c.value)).toEqual([
      ...CANONICAL_PRIORITIES,
      PRIORITY_CLEAR,
    ]);
    expect(choices.every((c) => c.offerable)).toBe(true);
  });

  it("a NON-CANONICAL current value is shown, FIRST, and is NOT offerable", () => {
    // D2's stated requirement: `P4-Trivial` (1 row on the operator brain) and
    // the 7 bare `P1`/`P2` rows must not silently look UNSET. They are visible
    // and disabled — TD-338 owns folding them; this control owns not minting a
    // ninth value.
    const choices = priorityChoices("P4-Trivial");
    expect(choices[0]).toEqual({
      value: "P4-Trivial",
      label: "P4-Trivial — not offerable",
      offerable: false,
    });
    expect(choices.filter((c) => c.offerable).map((c) => c.value)).toEqual([
      ...CANONICAL_PRIORITIES,
      PRIORITY_CLEAR,
    ]);
  });

  it("a MIXED or absent current value shows no disabled entry", () => {
    // A mixed selection has no single current value, and inventing one would
    // be a claim about rows the operator can see are different.
    for (const current of [null, ""]) {
      expect(priorityChoices(current).every((c) => c.offerable)).toBe(true);
    }
  });

  it("SELF-NEGATIVE-CONTROL — the non-canonical branch really can fire", () => {
    // Without this, "every choice is offerable" above is also what you observe
    // from a `priorityChoices` that ignores its argument.
    expect(priorityChoices("P4-Trivial").some((c) => !c.offerable)).toBe(true);
    expect(priorityChoices("P2-Medium").some((c) => !c.offerable)).toBe(false);
  });
});

describe("FR-247 — the brief-write request body", () => {
  const refs = [
    { project: "demo", brief_id: "FR-001" },
    { project: "other", brief_id: "FR-002" },
  ];

  it("set_priority emits refs + priority, and NEVER `ids`", () => {
    expect(buildBriefWriteRequest("set_priority", refs, { priority: "P0-Critical" })).toEqual(
      { action: "set_priority", refs, priority: "P0-Critical" },
    );
  });

  it("CLEAR becomes the EMPTY STRING on the wire, never the sentinel", () => {
    // A literal `__clear__` reaching the brain would be stored verbatim as a
    // ninth non-canonical value — precisely the drift D2 refuses to add to.
    const body = buildBriefWriteRequest("set_priority", refs, {
      priority: PRIORITY_CLEAR,
    });
    expect(body.priority).toBe("");
    expect(JSON.stringify(body)).not.toContain(PRIORITY_CLEAR);
  });

  it("attach_goal emits goal_id and drops a blank one", () => {
    expect(
      buildBriefWriteRequest("attach_goal", refs, { goalId: " GL-100 " }),
    ).toEqual({ action: "attach_goal", refs, goal_id: "GL-100" });
    expect(
      Object.keys(buildBriefWriteRequest("attach_goal", refs, { goalId: "  " })),
    ).toEqual(["action", "refs"]);
  });

  it("each action ignores the OTHER's extra", () => {
    // The server would 400 an unknown field, but the two actions share one
    // control surface — so a stale `goalId` in component state must not ride
    // along on a priority write.
    expect(
      buildBriefWriteRequest("set_priority", refs, {
        priority: "P1-High",
        goalId: "GL-100",
      }),
    ).toEqual({ action: "set_priority", refs, priority: "P1-High" });
  });

  it("the refs are COPIED, so a later mutation of the selection cannot rewrite an in-flight body", () => {
    const live = [{ project: "demo", brief_id: "FR-001" }];
    const body = buildBriefWriteRequest("set_priority", live, { priority: "P1-High" });
    live[0]!.brief_id = "FR-999";
    expect(body.refs[0]?.brief_id).toBe("FR-001");
  });

  it("the two brief actions are exactly the map's two brief-ref rows", () => {
    expect([...BRIEF_WRITE_ACTIONS]).toEqual(["set_priority", "attach_goal"]);
    // ...and they are DISJOINT from the triage tabs' vocabulary. One list would
    // need every consumer to filter it by target, which is the map's job.
    for (const a of BRIEF_WRITE_ACTIONS) {
      expect(TRIAGE_ACTIONS as readonly string[]).not.toContain(a);
    }
  });
});

describe("FR-247 — briefWriteCopy warns in the RIGHT register", () => {
  it("says what changes, says what does not, and demands nothing typed", () => {
    const copy = briefWriteCopy("set_priority", 12, "P0-Critical");
    expect(copy.title).toBe("Set priority on 12 briefs?");
    expect(copy.lines[0]).toContain("P0-Critical");
    expect(copy.lines.join(" ")).toContain("not status, not phase, not the body");
    expect(copy.confirmLabel).toBe("SET PRIORITY ON 12");
  });

  it("never borrows the permanent-deletion register", () => {
    // The safety property: `confirmCopy`'s tier-3 vocabulary is reserved for
    // the one action that cannot be undone. A reversible write that shouted
    // PERMANENTLY DELETED would train the operator to click through the case
    // where the shouting was true.
    for (const action of BRIEF_WRITE_ACTIONS) {
      const copy = briefWriteCopy(action, 3, "GL-100");
      const text = `${copy.title} ${copy.lines.join(" ")} ${copy.confirmLabel}`;
      for (const banned of ["PERMANENT", "cannot be undone", "hand-editing", "DELETE"]) {
        expect(text, `${action} used the delete register: ${banned}`).not.toContain(banned);
      }
      expect(text).toContain("Reversible");
    }
  });

  it("SELF-NEGATIVE-CONTROL — confirmCopy's tier-3 path DOES use that register", () => {
    // Without this, "the banned words are absent" is also what you observe from
    // a matcher that never matches anything.
    const hard = confirmCopy("reject", {
      tier1: 0,
      tier2: 0,
      tier3: 3,
      unknownTier3: 0,
      total: 3,
    });
    expect(`${hard.lines.join(" ")} ${hard.confirmLabel}`).toContain("PERMANENT");
  });

  it("CLEAR gets its own sentence — 'set to __clear__' would be gibberish", () => {
    const copy = briefWriteCopy("set_priority", 1, PRIORITY_CLEAR);
    expect(copy.lines[0]).toContain("UNSET");
    expect(copy.lines[0]).not.toContain(PRIORITY_CLEAR);
  });
});

describe("FR-247 — the selection algebra over STRING keys", () => {
  const key = refKey;
  const a = { project: "demo", brief_id: "FR-001" };
  const b = { project: "other", brief_id: "FR-001" };

  it("refKey distinguishes the SAME brief id in two projects (BR-078)", () => {
    // The whole reason a brief cannot be selected by an integer or by its id
    // alone: `BR-001` names a different brief in 25 projects.
    expect(key(a)).not.toBe(key(b));
    expect(key(a)).toBe("demo|FR-001");
  });

  it("toggleSelected / selectAllKeys / confineToKeys work over strings", () => {
    let sel = EMPTY_KEY_SELECTION;
    sel = toggleSelected(sel, key(a));
    sel = toggleSelected(sel, key(b));
    expect([...sel].sort()).toEqual(["demo|FR-001", "other|FR-001"]);
    sel = toggleSelected(sel, key(a));
    expect([...sel]).toEqual(["other|FR-001"]);

    sel = selectAllKeys(sel, [key(a), key(b)]);
    expect(sel.size).toBe(2);
  });

  it("confineToKeys DROPS a selection the operator can no longer see", () => {
    // The safety property, on the surface it was generalised for: a selection
    // made under one project must not survive a scope change and then be
    // written to.
    const sel = selectAllKeys(EMPTY_KEY_SELECTION, [key(a), key(b)]);
    expect([...confineToKeys(sel, [key(b)])]).toEqual(["other|FR-001"]);
    expect([...confineToKeys(sel, [])]).toEqual([]);
  });

  it("the NUMBER-keyed forms are unchanged — FR-241's callers still read the same", () => {
    // The generalisation is a widening, not a replacement. If this ever fails,
    // the triage page's selection has changed meaning.
    const rows: TriageRow[] = [{ id: 1 }, { id: 2 }];
    expect([...selectAll(EMPTY_SELECTION, rows)]).toEqual([1, 2]);
    expect([...confineToVisible(selectAll(EMPTY_SELECTION, rows), [{ id: 2 }])]).toEqual([2]);
  });

  it("chunkIds chunks REFS as well as ids, with the same empty-input rule", () => {
    const refs = Array.from({ length: MAX_BULK + 1 }, (_, i) => ({
      project: "demo",
      brief_id: `FR-${i}`,
    }));
    const chunks = chunkIds(refs);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(MAX_BULK);
    expect(chunks[1]).toHaveLength(1);
    // ZERO chunks for an empty batch — the client can never issue the empty
    // `refs` request the server 400s.
    expect(chunkIds([] as { project: string; brief_id: string }[])).toEqual([]);
  });
});

describe("FR-247 — outcomeLabel names a failure's subject", () => {
  it("reads the ref when there is one, the id when there is not", () => {
    expect(
      outcomeLabel({ id: null, ref: { project: "demo", brief_id: "FR-1" }, ok: false, error: null }),
    ).toBe("demo/FR-1");
    expect(outcomeLabel({ id: 7, ref: null, ok: false, error: null })).toBe("#7");
    // The shape FR-241 shipped, with no `ref` key at all.
    expect(outcomeLabel({ id: 7, ok: false, error: null })).toBe("#7");
  });

  it("never renders `#null` or `undefined`", () => {
    // The failure banner is what an operator reads when something went wrong.
    // `#null: <brain message>` is a bug report nobody can act on.
    expect(outcomeLabel({ id: null, ref: null, ok: false, error: null })).toBe("?");
  });
});

// ---------------------------------------------------------------------------
// FR-249 — the subjectless create
// ---------------------------------------------------------------------------

describe("FR-249 — the create_goal request body", () => {
  it("carries the THREE prefixed keys and nothing else", () => {
    // THE PREFIX IS THE ASSERTION. The server's unknown-key set is GLOBAL, so a
    // body naming `title` is a 400 for EVERY action — which is the property
    // that keeps `title` refused by absence on `set_priority` too. A builder
    // that emitted `title` would take this whole surface down, not just its own.
    const body = buildCreateGoalRequest("Ship the write door", "Every mutation is a row", "demo");
    expect(body).toEqual({
      action: "create_goal",
      goal_title: "Ship the write door",
      goal_outcome: "Every mutation is a row",
      goal_project: "demo",
    });
    expect(Object.keys(body!).sort()).not.toContain("title");
  });

  it("omits `goal_project` for the all-projects scope — absence IS the scope", () => {
    // `null`, `undefined` and `""` are the three ways the shell says "all
    // projects", and all three must produce the SAME body: the brain reads a
    // missing project as `project_slug NULL`, which the goals layer renders as
    // "Cross-project". Sending `""` would reach the same row while saying
    // something the reader has to decode.
    for (const scope of [null, undefined, "", "   "]) {
      expect(buildCreateGoalRequest("t", "o", scope)).toEqual({
        action: "create_goal",
        goal_title: "t",
        goal_outcome: "o",
      });
    }
  });

  it("REFUSES a blank title or outcome rather than posting one", () => {
    // The button is disabled for the same condition, and this is the layer that
    // makes the disabling a property rather than a coincidence — a future caller
    // that forgets the guard cannot post a body the brain will certainly refuse.
    expect(buildCreateGoalRequest("", "o")).toBeNull();
    expect(buildCreateGoalRequest("   ", "o")).toBeNull();
    expect(buildCreateGoalRequest("t", "")).toBeNull();
    expect(buildCreateGoalRequest("t", "  \n ")).toBeNull();
  });

  it("TRIMS, because a trailing space is not part of a goal's title", () => {
    expect(buildCreateGoalRequest("  Ship it  ", "  done  ", " demo ")).toEqual({
      action: "create_goal",
      goal_title: "Ship it",
      goal_outcome: "done",
      goal_project: "demo",
    });
  });

  it("the create vocabulary is DISJOINT from the other two, and complete", () => {
    // Three lists, three questions — "what may a triage tab offer", "what may a
    // BRIEF row offer", "what has no subject at all". An action in two of them
    // would be an action whose enabling condition depends on which list a
    // consumer happened to read.
    expect([...CREATE_ACTIONS]).toEqual(["create_goal"]);
    for (const a of CREATE_ACTIONS) {
      expect(TRIAGE_ACTIONS as readonly string[]).not.toContain(a);
      expect(BRIEF_WRITE_ACTIONS as readonly string[]).not.toContain(a);
    }
  });

  it("outcomeLabel says `?` for a subjectless failure — there IS no subject", () => {
    // Not a degradation: a `target: "none"` row addresses nothing, so `?` is the
    // true answer. The readout that renders it carries the action name, so the
    // line reads "CREATE_GOAL — 0 of 1 applied" with the brain's own reason.
    expect(
      outcomeLabel({ id: null, ref: null, ok: false, error: "x", created_id: null }),
    ).toBe("?");
  });
});
