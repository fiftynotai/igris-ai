/**
 * FR-240 — `dashboard/params.ts` unit tests.
 *
 * WHAT THESE GATES PROVE
 * ----------------------
 * That the clamp/allowlist decisions are correct for every hostile input a URL
 * bar can produce, WITHOUT a server, a socket or a brain. That is the whole
 * reason the module is pure.
 *
 * WHAT THEY DO NOT PROVE
 * ----------------------
 *  - That `routes.ts` actually CALLS these functions with the right specs.
 *    **Sibling:** `dashboard-layers-endpoint.test.ts`, which drives real HTTP
 *    and asserts the narrowed row sets.
 *  - That the module holds no SQL / does no I/O. **Sibling:** the scope scan in
 *    `dashboard-server.test.ts`.
 *
 * @module __tests__/dashboard-params.test
 */

import { describe, expect, it } from "vitest";
import {
  BRIEF_FILTERS,
  DEFAULT_LIMIT,
  GOAL_FILTERS,
  LEARNING_FILTERS,
  MAX_LIMIT,
  MAX_QUERY_LENGTH,
  PROJECT_SCOPES,
  MAX_BULK,
  SUGGESTION_FILTERS,
  parseFilters,
  parseTriageBody,
  parsePageParams,
  parseQuery,
} from "../lib/dashboard/params.js";

const q = (s: string): URLSearchParams => new URLSearchParams(s);

describe("parsePageParams — limit", () => {
  it("defaults when absent", () => {
    const p = parsePageParams(q(""));
    expect(p.limit).toBe(DEFAULT_LIMIT);
    expect(p.offset).toBe(0);
    expect(p.rejected).toEqual([]);
  });

  it("honours the per-endpoint default override", () => {
    expect(parsePageParams(q(""), { limit: 10 }).limit).toBe(10);
  });

  it("accepts an in-range integer", () => {
    expect(parsePageParams(q("limit=25")).limit).toBe(25);
  });

  it("floors a fractional limit", () => {
    expect(parsePageParams(q("limit=25.9")).limit).toBe(25);
  });

  it("clamps DOWN to MAX_LIMIT and says so", () => {
    const p = parsePageParams(q("limit=1000000"));
    expect(p.limit).toBe(MAX_LIMIT);
    expect(p.rejected[0]).toContain(`clamped down to ${MAX_LIMIT}`);
  });

  it("clamps UP to 1 for zero and negatives — there is no '0 means all' here", () => {
    // Deliberately DIFFERENT from the brain's own `igris_brief_list`, where 0
    // means "no LIMIT clause". A browser endpoint that can be asked for the
    // whole table is the payload term D7 exists to remove.
    expect(parsePageParams(q("limit=0")).limit).toBe(1);
    expect(parsePageParams(q("limit=-5")).limit).toBe(1);
    expect(parsePageParams(q("limit=0")).rejected[0]).toContain("clamped up to 1");
  });

  it("falls back on garbage and names it", () => {
    const p = parsePageParams(q("limit=abc"));
    expect(p.limit).toBe(DEFAULT_LIMIT);
    expect(p.rejected[0]).toContain("not a number");
  });

  it("treats NaN-producing exotic inputs as garbage", () => {
    for (const raw of ["limit=Infinity", "limit=-Infinity", "limit=NaN", "limit=1,2"]) {
      const p = parsePageParams(q(raw));
      expect(p.limit, raw).toBe(DEFAULT_LIMIT);
    }
  });

  it("takes the FIRST value when a key repeats", () => {
    // `URLSearchParams#get` returns the first. Asserted rather than assumed:
    // `?limit=5&limit=999` must not silently become 999.
    expect(parsePageParams(q("limit=5&limit=999")).limit).toBe(5);
  });

  it("treats an EMPTY value as ABSENT, not as zero", () => {
    // `?limit=` is what a UI emits when the field is blanked, and `Number("")`
    // is 0 — so this used to clamp to 1 AND report the operator's own cleared
    // control as a rejected input. Same rule `parseFilters` applies to an empty
    // filter value.
    const p = parsePageParams(q("limit=&offset="));
    expect(p.limit).toBe(DEFAULT_LIMIT);
    expect(p.offset).toBe(0);
    expect(p.rejected).toEqual([]);
    // …and the caller's own default still wins, exactly as for an absent key.
    expect(parsePageParams(q("limit="), { limit: 10 }).limit).toBe(10);
    // NEGATIVE CONTROL: an explicit zero is still a real, reported clamp.
    expect(parsePageParams(q("limit=0")).limit).toBe(1);
    expect(parsePageParams(q("limit=0")).rejected).toHaveLength(1);
  });
});

describe("parsePageParams — offset", () => {
  it("defaults to 0", () => {
    expect(parsePageParams(q("")).offset).toBe(0);
  });

  it("accepts and floors", () => {
    expect(parsePageParams(q("offset=40")).offset).toBe(40);
    expect(parsePageParams(q("offset=1.7")).offset).toBe(1);
  });

  it("clamps negatives to 0 and names it", () => {
    const p = parsePageParams(q("offset=-9"));
    expect(p.offset).toBe(0);
    expect(p.rejected[0]).toContain("clamped up to 0");
  });

  it("falls back on garbage", () => {
    const p = parsePageParams(q("offset=later"));
    expect(p.offset).toBe(0);
    expect(p.rejected[0]).toContain("not a number");
  });

  it("accumulates BOTH rejections when both params are bad", () => {
    const p = parsePageParams(q("limit=nope&offset=-1"));
    expect(p.rejected).toHaveLength(2);
  });
});

describe("parseFilters — allowlisting", () => {
  it("accepts an allowlisted value", () => {
    const r = parseFilters(q("category=pattern"), LEARNING_FILTERS);
    expect(r.values).toEqual({ category: "pattern" });
    expect(r.rejected).toEqual([]);
  });

  it("DROPS a non-allowlisted value and names the vocabulary", () => {
    const r = parseFilters(q("category=poem"), LEARNING_FILTERS);
    // Dropped, not passed through. This is the property that lets the brain
    // readers bind the value directly.
    expect(r.values).toEqual({});
    expect(r.rejected[0]).toContain('category: "poem" is not one of');
    expect(r.rejected[0]).toContain("pattern");
  });

  it("accepts anything non-empty for an open filter (allowed: null)", () => {
    const r = parseFilters(q("project=some-new-project&status=Blocked"), BRIEF_FILTERS);
    expect(r.values).toEqual({ project: "some-new-project", status: "Blocked" });
    expect(r.rejected).toEqual([]);
  });

  it("treats an EMPTY value as 'no filter', not as matching the empty string", () => {
    // A cleared UI control emits `?category=`. Binding '' would return zero
    // rows and look like a broken filter.
    const r = parseFilters(q("category=&project="), LEARNING_FILTERS);
    expect(r.values).toEqual({});
    expect(r.rejected).toEqual([]);
  });

  it("reports an UNKNOWN param instead of ignoring it", () => {
    const r = parseFilters(q("catgory=pattern"), LEARNING_FILTERS);
    expect(r.values).toEqual({});
    expect(r.rejected).toEqual(["unknown filter: catgory"]);
  });

  it("does not report params the caller declared it handles", () => {
    // `q` is NO LONGER a valid example here: FR-246 made it a real member of
    // `LEARNING_FILTERS`, so it now lands in `values` rather than being merely
    // tolerated. `upcoming_days` is the surviving case of a param a ROUTE parses
    // itself (`routes.ts#goals`) and hands to `parseFilters` only so it is not
    // reported as unknown.
    const r = parseFilters(
      q("limit=10&offset=5&upcoming_days=7&project=igris-ai"),
      LEARNING_FILTERS,
      ["limit", "offset", "upcoming_days"],
    );
    expect(r.values).toEqual({ project: "igris-ai" });
    expect(r.rejected).toEqual([]);
  });

  it("FR-246 — `q` is a FILTER on the list specs, so it is parsed into values", () => {
    const r = parseFilters(q("q=hello&project=igris-ai"), LEARNING_FILTERS);
    expect(r.values).toEqual({ project: "igris-ai", q: "hello" });
    expect(r.rejected).toEqual([]);
    // ...and an EMPTY `q` means "no filter", not "match the empty string" —
    // which is exactly how a cleared text input behaves, and the reason a list
    // uses `parseFilters` while `/api/briefs/search` uses `parseQuery` (where
    // an empty value is a refusal).
    expect(parseFilters(q("q=&project=igris-ai"), LEARNING_FILTERS).values).toEqual({
      project: "igris-ai",
    });
  });

  it("composes multiple accepted filters", () => {
    const r = parseFilters(
      q("project=igris-ai&category=mistake&scope=local&provenance=inferred&review_status=approved"),
      LEARNING_FILTERS,
    );
    expect(r.values).toEqual({
      project: "igris-ai",
      category: "mistake",
      scope: "local",
      provenance: "inferred",
      review_status: "approved",
    });
  });

  it("keeps the good filters when a sibling is refused", () => {
    const r = parseFilters(q("project=igris-ai&scope=galactic"), LEARNING_FILTERS);
    expect(r.values).toEqual({ project: "igris-ai" });
    expect(r.rejected).toHaveLength(1);
  });

  it("goal status is a CLOSED vocabulary", () => {
    expect(parseFilters(q("status=active"), GOAL_FILTERS).values).toEqual({
      status: "active",
    });
    expect(parseFilters(q("status=in_progress"), GOAL_FILTERS).values).toEqual({});
  });

  it("every FR-240 review_status value round-trips (D9 exposes both)", () => {
    for (const v of ["approved", "pending_review"]) {
      expect(parseFilters(q(`review_status=${v}`), LEARNING_FILTERS).values).toEqual({
        review_status: v,
      });
    }
  });

  // -------------------------------------------------------------------------
  // TD-326 — `project_scope`
  // -------------------------------------------------------------------------

  it("project_scope is a CLOSED vocabulary — exactly `brain-level`", () => {
    // Closed on purpose, unlike `project`. The whole reason this is a separate
    // param is that a value is either a scope the endpoint IMPLEMENTS or a
    // typo, and `project`'s open spec cannot tell those apart.
    expect(PROJECT_SCOPES).toEqual(["brain-level"]);
    expect(parseFilters(q("project_scope=brain-level"), SUGGESTION_FILTERS)).toEqual({
      values: { project_scope: "brain-level" },
      rejected: [],
    });
  });

  it("a NEAR-MISS value is dropped and named, never bound", () => {
    // `everything` is the OTHER scope name in this product's vocabulary
    // (BR-082's Overview) and means a different set — dropping it silently
    // would answer an `everything` question with a `brain-level` label.
    const r = parseFilters(q("project_scope=everything"), SUGGESTION_FILTERS);
    expect(r.values).toEqual({});
    expect(r.rejected).toEqual([
      'project_scope: "everything" is not one of brain-level',
    ]);
  });

  it("NO OTHER FILTER SET declares it — so a parseFilters endpoint reports it", () => {
    // The property that makes a separate param safer than a magic `project`
    // value: an undeclared param is reported. Asserted over the filter sets
    // rather than described, so adding `project_scope` to one of them without
    // implementing it fails here.
    for (const [name, specs] of [
      ["BRIEF_FILTERS", BRIEF_FILTERS],
      ["LEARNING_FILTERS", LEARNING_FILTERS],
      ["GOAL_FILTERS", GOAL_FILTERS],
    ] as const) {
      expect(specs.map((s) => s.name), name).not.toContain("project_scope");
      expect(
        parseFilters(q("project_scope=brain-level"), specs).rejected,
        name,
      ).toEqual(["unknown filter: project_scope"]);
    }
    // SELF-NEGATIVE-CONTROL: the one set that DOES declare it does not report it.
    expect(
      parseFilters(q("project_scope=brain-level"), SUGGESTION_FILTERS).rejected,
    ).toEqual([]);
  });

  it("a magic `project` VALUE would not have worked — the rejected design", () => {
    // Recorded as an executable statement rather than a comment: `project` is
    // `allowed: null`, so any string is accepted verbatim by every endpoint. A
    // sentinel there is indistinguishable from a project that does not exist.
    for (const specs of [BRIEF_FILTERS, LEARNING_FILTERS, GOAL_FILTERS, SUGGESTION_FILTERS]) {
      expect(parseFilters(q("project=(brain-level)"), specs).values.project).toBe(
        "(brain-level)",
      );
      expect(parseFilters(q("project=(brain-level)"), specs).rejected).toEqual([]);
    }
  });
});

describe("parseQuery", () => {
  it("accepts a normal query", () => {
    expect(parseQuery(q("q=hybrid+recall"))).toEqual({
      ok: true,
      query: "hybrid recall",
    });
  });

  it("REFUSES an absent or empty q rather than defaulting", () => {
    // Degrading here would make "no query" indistinguishable from "matched
    // everything" — the opposite of what a search box should communicate.
    expect(parseQuery(q(""))).toEqual({
      ok: false,
      reason: "query parameter 'q' is required",
    });
    expect(parseQuery(q("q=")).ok).toBe(false);
  });

  it("refuses a query above the brain's own MAX_QUERY_LENGTH", () => {
    const long = "a".repeat(MAX_QUERY_LENGTH + 1);
    const r = parseQuery(new URLSearchParams({ q: long }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(`1-${MAX_QUERY_LENGTH}`);
  });

  it("accepts exactly MAX_QUERY_LENGTH (the boundary is inclusive)", () => {
    const exact = "a".repeat(MAX_QUERY_LENGTH);
    expect(parseQuery(new URLSearchParams({ q: exact })).ok).toBe(true);
  });

  it("passes FTS5-hostile punctuation through untouched — sanitising is the brain's job", () => {
    // `sanitizeFts5Query` (brain-mcp-server/src/utils/fts5.ts) owns this, and
    // TD-290 made it a whitelist. A second sanitiser here would be a second
    // definition of the query grammar.
    const r = parseQuery(new URLSearchParams({ q: 'what? "quoted" AND *' }));
    expect(r).toEqual({ ok: true, query: 'what? "quoted" AND *' });
  });
});

// ---------------------------------------------------------------------------
// FR-247 — `refs`, and the `ids` XOR `refs` rule
// ---------------------------------------------------------------------------

/**
 * `parseTriageBody` is PURE, so the whole `refs` grammar is unit-testable with
 * no socket, no brain and no engine. The endpoint suite exercises the same
 * rules over real HTTP; these are here because the EDGE cases (a ref carrying a
 * third key, an empty `brief_id`, a 250-ref clamp) are the ones a wire test
 * would only sample.
 *
 * The two injected callbacks are the map's, so this file still holds no copy of
 * the action vocabulary.
 */
describe("FR-247 — parseTriageBody over `refs`", () => {
  /** The map's answers, injected. `set_priority` is the brief-ref action. */
  const known = (a: string): boolean =>
    ["dismiss", "apply", "set_priority", "attach_goal"].includes(a);
  const targetOf = (a: string): "id" | "brief-ref" =>
    a === "set_priority" || a === "attach_goal" ? "brief-ref" : "id";
  const opts = { targetOf, bulkAllowed: (a: string) => a !== "apply" };

  const parse = (body: unknown) => parseTriageBody(body, known, opts);
  const ref = (brief_id: string, project = "demo") => ({ project, brief_id });

  it("accepts a well-formed refs body and reports both arrays", () => {
    const r = parse({
      action: "set_priority",
      refs: [ref("FR-001"), ref("FR-002")],
      priority: "P0-Critical",
    });
    expect(r).toEqual({
      ok: true,
      action: "set_priority",
      ids: [],
      refs: [ref("FR-001"), ref("FR-002")],
      priority: "P0-Critical",
      params: [],
    });
  });

  it("REFUSES an empty refs array — FR-247's named vacuous case", () => {
    // `params.ts` states this posture for `ids`; `refs` inherits it, and the
    // inheritance is pinned here rather than assumed from the comment.
    expect(parse({ action: "set_priority", refs: [], priority: "P0-Critical" })).toEqual({
      ok: false,
      reason: "'refs' must not be empty",
    });
  });

  it("refuses the WRONG address kind, by name, in both directions", () => {
    expect(parse({ action: "set_priority", ids: [1], priority: "P1-High" })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("'ids' is not accepted for it"),
    });
    expect(parse({ action: "dismiss", refs: [ref("FR-001")] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("'refs' is not accepted for it"),
    });
  });

  it("refuses a ref carrying a THIRD key", () => {
    // A ref that could carry `status` is a body whose shape nobody can state,
    // even though the map's allow-list would drop it downstream.
    expect(
      parse({
        action: "set_priority",
        refs: [{ project: "demo", brief_id: "FR-001", status: "Done" }],
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("accept only project and brief_id"),
    });
  });

  it("refuses an empty or non-string project / brief_id", () => {
    for (const bad of [
      { project: "", brief_id: "FR-001" },
      { project: "demo", brief_id: "" },
      { project: 1, brief_id: "FR-001" },
      { project: "demo", brief_id: null },
    ]) {
      expect(
        parse({ action: "set_priority", refs: [bad] }),
        JSON.stringify(bad),
      ).toMatchObject({ ok: false });
    }
    // ...and a non-object entry.
    expect(parse({ action: "set_priority", refs: ["FR-001"] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("{project, brief_id} objects"),
    });
  });

  it("dedupes on the PAIR, not on either half", () => {
    const r = parse({
      action: "set_priority",
      refs: [ref("FR-001"), ref("FR-001"), ref("FR-001", "other"), ref("FR-002")],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // `FR-001` in `other` is a DIFFERENT brief (BR-078 — the id alone names a
    // different brief in 25 projects), so it must survive.
    expect(r.refs).toEqual([ref("FR-001"), ref("FR-001", "other"), ref("FR-002")]);
    expect(r.params.join(" ")).toContain("duplicate ref (demo|FR-001)");
  });

  it("clamps at MAX_BULK and REPORTS it", () => {
    const refs = Array.from({ length: MAX_BULK + 50 }, (_, i) => ref(`FR-${i}`));
    const r = parse({ action: "set_priority", refs });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.refs).toHaveLength(MAX_BULK);
    expect(r.params.join(" ")).toContain(`refs: clamped to ${MAX_BULK}`);
  });

  it("`priority` and `goal_id` are accepted as strings and NOT vocabulary-checked", () => {
    // Deliberate: the server allow-lists the KEY, `normalizePriority` folds the
    // VALUE, and the picker prescribes the CHOICES. A fourth copy of the
    // vocabulary here would be a fourth thing to drift — so a nonsense value
    // must pass this layer and be the brain's problem.
    const r = parse({
      action: "set_priority",
      refs: [ref("FR-001")],
      priority: "P9-Nonsense",
    });
    expect(r).toMatchObject({ ok: true, priority: "P9-Nonsense" });
    expect(parse({ action: "set_priority", refs: [ref("FR-1")], priority: 3 })).toMatchObject(
      { ok: false, reason: "'priority' must be a string" },
    );
  });

  it("the empty-string priority (CLEAR) is a VALUE, not an absence", () => {
    // `""` is what the picker's CLEAR sends, and `normalizePriority` folds it
    // to SQL NULL. If this layer treated it as "not supplied" the control would
    // silently do nothing.
    const r = parse({ action: "set_priority", refs: [ref("FR-1")], priority: "" });
    expect(r).toMatchObject({ ok: true, priority: "" });
    if (r.ok) expect(Object.keys(r)).toContain("priority");
  });

  it("the forbidden build-state fields are unknown at the door, for EVERY action", () => {
    for (const field of ["status", "phase", "content", "title", "filename"]) {
      expect(
        parse({ action: "set_priority", refs: [ref("FR-1")], [field]: "x" }),
        field,
      ).toMatchObject({ ok: false, reason: `unknown field: ${field}. Accepted: action, ids, refs, reason, brief_id, priority, goal_id` });
      // ...and on an id-addressed action too, so the ban is not brief-specific.
      expect(parse({ action: "dismiss", ids: [1], [field]: "x" }), field).toMatchObject({
        ok: false,
      });
    }
  });

  it("single-item-only still bites on the refs path", () => {
    const single = { targetOf: () => "brief-ref" as const, bulkAllowed: () => false };
    expect(
      parseTriageBody(
        { action: "set_priority", refs: [ref("FR-1"), ref("FR-2")] },
        known,
        single,
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("single-item only") });
  });

  it("BACKWARD COMPATIBILITY — with no `targetOf`, every action is id-addressed", () => {
    // Four shipped call sites (and the whole FR-241 test surface) call this
    // with two arguments. The default has to be `id`, and it is asserted rather
    // than left to a comment.
    expect(parseTriageBody({ action: "dismiss", ids: [1] }, known)).toEqual({
      ok: true,
      action: "dismiss",
      ids: [1],
      refs: [],
      params: [],
    });
  });
});
