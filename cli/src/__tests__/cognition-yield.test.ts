/**
 * TD-423 — `igris cognition yield`: known-answer arithmetic, expiry-vs-judgment
 * discrimination, registry derivation, unmeasured-is-not-zero, and no-writes.
 *
 * Real seeded brain DB under `mkdtemp` + `IGRIS_BRAIN_DIR` (never a mock, #159),
 * exactly as `cognition-health.test.ts` does. Every case below names the failure
 * it pins, and several reproduce on a fixture the precise mistakes TD-423 was
 * filed about:
 *
 *   - counting a BULK EXPIRY as a human rejection, which scores perception at
 *     33% when the only review that ever happened scored it 79% (Defect 1);
 *   - grouping on `source_module`, which reports the subconscious as 168 tiny
 *     detectors instead of one instance (Defect 3);
 *   - rendering a rate with no denominator, so "50%" and "1 of 2" look alike;
 *   - reporting an instance nobody has reviewed as scoring ZERO rather than as
 *     unmeasured — absence of verdicts is not a verdict.
 *
 * @module __tests__/cognition-yield.test
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CognitionInstanceYield,
  CognitionRate,
  CognitionYieldDigest,
} from "../types.js";
import {
  EXPECTED_2026_08_26,
  EXPECTED_2026_09_01,
  PRODUCTION_ROSTER,
  dbFileIn,
  seedLearnings,
  seedRoster,
  seedSuggestions,
  seedWorld_2026_08_26,
  seedWorld_2026_09_01,
  seedYieldSchema,
  type RosterSeed,
} from "./cognition-yield-fixture.js";

let tmpRoot: string;
let savedEnv: NodeJS.ProcessEnv;

const HOST = "test-host";

function dbFile(): string {
  return dbFileIn(tmpRoot);
}

/** `memory/` for the cases that hand-write a DB instead of using the fixture. */
function makeBrainDir(): void {
  mkdirSync(join(tmpRoot, "memory"), { recursive: true });
}

async function digest(): Promise<CognitionYieldDigest> {
  const { buildCognitionYieldDigest } = await import("../verbs/cognition.js");
  return buildCognitionYieldDigest({ hostname: HOST });
}

function pick(d: CognitionYieldDigest, id: string): CognitionInstanceYield {
  const row = d.instances.find((i) => i.id === id);
  if (row === undefined) {
    throw new Error(
      `instance ${id} absent from digest (have: ${d.instances.map((i) => i.id).join(", ")})`,
    );
  }
  return row;
}

/** Every rate object anywhere in the digest, for the structural gates. */
function everyRate(d: CognitionYieldDigest): Array<{ owner: string; name: string; rate: CognitionRate }> {
  const out: Array<{ owner: string; name: string; rate: CognitionRate }> = [];
  for (const i of d.instances) {
    for (const name of [
      "judged_share_of_produced",
      "keep_rate_of_judged",
      "pending_share_of_queue",
      "expiry_share_of_produced",
    ] as const) {
      const rate = i[name];
      if (rate !== null) out.push({ owner: i.id, name, rate });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The declared-expectation consumer — a fixture value nothing reads is not
// coverage
// ---------------------------------------------------------------------------

/**
 * Round 1 shipped `judged_share: 29 / 69` in the fixture and asserted it
 * NOWHERE. Mutating `judged_share_of_produced`'s denominator from `d.produced`
 * to `d.produced - d.expired` left all 34 of round 1's cases green while
 * perception's rate went 29/69 (42%) -> 29/29 (100%) in the 2026-08-26 world —
 * silently dropping that world's 40 expiry rows (and the 2026-09-01 world's
 * 345, where 224/569 becomes 224/224) out of the exact denominator AC-4 exists
 * to keep visible. A dead expectation reads like coverage in review, which is
 * the failure this whole brief is about, committed inside it.
 *
 * A whole-class sweep — mutate every declared leaf, run the suite, record which
 * mutations stay green — found SIXTEEN dead leaves of the 79 declared at that
 * moment, not one. So the fix is structural rather than sixteen new lines: a
 * declared value reaches an assertion ONLY through a keyed map, and a key with
 * no entry in that map THROWS. It takes TWO maps because the fixture has two
 * tiers — {@link TOP_LEVEL_KEY_ASSERTIONS} over each world's own keys
 * (the four channel totals, each instance block, the event pair) and
 * {@link DECLARED_KEY_ASSERTIONS} over the keys inside an instance block.
 * Round 2 built only the second, which left the eight channel totals reachable
 * without a guard and a junk key at the top level silently ignored; the
 * paragraph above `expectChannelField` records that miss. With both maps in
 * place, adding a value to `EXPECTED_*` at EITHER tier is RED rather than
 * invisible, and re-running that sweep against this file reads 0 dead.
 */
type Declared = Record<string, number | null>;

/** Cast an `as const` expectation block to the shape the driver walks. */
function decl(exp: unknown): Declared {
  return exp as Declared;
}

/**
 * Assert a rate's PARTS, not only its value.
 *
 * `value` is `numerator / denominator` by construction, so pinning it alone
 * cannot see a numerator and denominator that are both wrong by the same
 * factor. The parts are derived from OTHER declared counts — which makes this a
 * cross-check between the rate and the table it is a rate over, rather than a
 * second reading of the same number.
 */
function expectRate(
  rate: CognitionRate | null | undefined,
  numerator: number,
  denominator: number,
  value: number,
  where: string,
): void {
  expect(rate, `${where} is absent`).toBeTruthy();
  expect(rate?.numerator, `${where}.numerator`).toBe(numerator);
  expect(rate?.denominator, `${where}.denominator`).toBe(denominator);
  expect(rate?.value, `${where}.value`).toBeCloseTo(value, 12);
}

/** A declared sibling the derivation NEEDS. Absent is an error, not a skip. */
function sibling(exp: Declared, key: string, forKey: string, where: string): number {
  const v = exp[key];
  if (typeof v !== "number") {
    throw new Error(
      `${where} declares \`${forKey}\` but not the sibling \`${key}\` its numerator/denominator is derived from`,
    );
  }
  return v;
}

/**
 * Fixture key -> the assertion that consumes it. THE CLOSED SET.
 *
 * `lapsed` (the expiry numerator) is `expired + pending_expired`, and the two
 * channels each make one of those structurally `0` — so the derivation asserts
 * the absent half is really zero rather than assuming it.
 */
const DECLARED_KEY_ASSERTIONS: Record<
  string,
  (row: CognitionInstanceYield, exp: Declared, where: string) => void
> = {
  produced: (r, e, w) => expect(r.produced_rows, `${w}.produced_rows`).toBe(e.produced),
  kept: (r, e, w) => expect(r.kept, `${w}.kept`).toBe(e.kept),
  rejected_judged: (r, e, w) =>
    expect(r.rejected_judged, `${w}.rejected_judged`).toBe(e.rejected_judged),
  judged: (r, e, w) => expect(r.judged, `${w}.judged`).toBe(e.judged),
  pending_live: (r, e, w) => expect(r.pending_live, `${w}.pending_live`).toBe(e.pending_live),
  pending_expired: (r, e, w) =>
    expect(r.pending_expired, `${w}.pending_expired`).toBe(e.pending_expired),
  expired_not_judged: (r, e, w) =>
    expect(r.expired_not_judged, `${w}.expired_not_judged`).toBe(e.expired_not_judged),
  distinct_labels: (r, e, w) =>
    expect(r.distinct_label_values, `${w}.distinct_label_values`).toBe(e.distinct_labels),
  keep_rate: (r, e, w) =>
    expectRate(
      r.keep_rate_of_judged,
      sibling(e, "kept", "keep_rate", w),
      sibling(e, "judged", "keep_rate", w),
      e.keep_rate as number,
      `${w}.keep_rate_of_judged`,
    ),
  judged_share: (r, e, w) =>
    expectRate(
      r.judged_share_of_produced,
      sibling(e, "judged", "judged_share", w),
      sibling(e, "produced", "judged_share", w),
      e.judged_share as number,
      `${w}.judged_share_of_produced`,
    ),
  expiry_share: (r, e, w) => {
    const expired = sibling(e, "expired_not_judged", "expiry_share", w);
    // The half this channel does not carry must BE zero on the row, or the
    // numerator below is an assumption rather than a derivation.
    const pendingExpired = typeof e.pending_expired === "number" ? e.pending_expired : 0;
    expect(r.pending_expired, `${w}.pending_expired (the expiry numerator's second half)`).toBe(
      pendingExpired,
    );
    expectRate(
      r.expiry_share_of_produced,
      expired + pendingExpired,
      sibling(e, "produced", "expiry_share", w),
      e.expiry_share as number,
      `${w}.expiry_share_of_produced`,
    );
  },
};

/**
 * Consume EVERY key the fixture declares for one instance.
 *
 * The `throw` is the arm: it is what makes this a class fix rather than
 * sixteen patches. Returns the number of values consumed so a caller can prove
 * the call was not vacuous.
 */
function expectDeclared(row: CognitionInstanceYield, exp: Declared, where: string): number {
  const keys = Object.keys(exp);
  for (const key of keys) {
    const assertKey = DECLARED_KEY_ASSERTIONS[key];
    if (assertKey === undefined) {
      throw new Error(
        `${where} declares \`${key}\` and nothing consumes it — wire it into DECLARED_KEY_ASSERTIONS or delete it`,
      );
    }
    assertKey(row, exp, where);
  }
  expect(keys.length, `${where} consumed no declared value`).toBeGreaterThan(0);
  return keys.length;
}

// ---------------------------------------------------------------------------
// The same closure, one tier up
// ---------------------------------------------------------------------------

/**
 * Round 2 closed the class INSIDE an instance block and left the tier above it
 * open. A junk key at the TOP level of `EXPECTED_*` was silently ignored — the
 * suite stayed 36/36 and nothing threw — because the four channel totals
 * reached their assertions through a helper that HAND-LISTED exactly four
 * fields. 87 of the 95 declared leaves were guarded and 8 were not, inside the
 * mechanism built to stop exactly that. So the guard is extended rather than
 * the claim narrowed: the top-level keys get their own closed map, with the
 * same throw-on-unknown-key, and `expectDeclared` keeps the tier below.
 */
type TopLevel = Record<string, unknown>;

/** One channel field, by table. Returns the number of leaves consumed. */
function expectChannelField(
  d: CognitionYieldDigest,
  table: "suggestions" | "learnings",
  field: "total_rows" | "pending_rows",
  expected: unknown,
  where: string,
): number {
  const c = d.channels.find((x) => x.table === table);
  expect(c, `${where}: channel \`${table}\` is absent from the digest`).toBeTruthy();
  expect(c?.[field], where).toBe(expected);
  return 1;
}

/** Route one top-level INSTANCE block to {@link expectDeclared}, under its digest id. */
function instanceEntry(id: string) {
  return (d: CognitionYieldDigest, top: TopLevel, key: string): number =>
    expectDeclared(pick(d, id), decl(top[key]), id);
}

/**
 * Fixture TOP-LEVEL key -> the assertion that consumes it. THE CLOSED SET, one
 * tier above {@link DECLARED_KEY_ASSERTIONS}. A key with no entry here reaches
 * no assertion, so a key with no entry here THROWS.
 */
const TOP_LEVEL_KEY_ASSERTIONS: Record<
  string,
  (d: CognitionYieldDigest, top: TopLevel, key: string, where: string) => number
> = {
  suggestions_total: (d, t, k, w) =>
    expectChannelField(d, "suggestions", "total_rows", t[k], `${w}.${k}`),
  suggestions_pending: (d, t, k, w) =>
    expectChannelField(d, "suggestions", "pending_rows", t[k], `${w}.${k}`),
  learnings_total: (d, t, k, w) =>
    expectChannelField(d, "learnings", "total_rows", t[k], `${w}.${k}`),
  learnings_pending: (d, t, k, w) =>
    expectChannelField(d, "learnings", "pending_rows", t[k], `${w}.${k}`),
  perception: instanceEntry("perception"),
  cartographer: instanceEntry("cartographer"),
  subconscious: instanceEntry("subconscious"),
  synapse: instanceEntry("synapse"),
  arbiter: instanceEntry("arbiter"),
  curator: instanceEntry("curator"),
  // The janitor produced nothing. Its zeros are MEASURED and belong in the
  // table like any other row (TD-437 scored it exactly this way).
  janitor: instanceEntry("janitor"),
  // The legacy rule detectors, found as a COMPLEMENT. Nothing in `cli/src`
  // names `gap`/`stalled`/`pattern`/`conflict`; they are what is left when
  // every registered instance's predicate has taken its rows.
  unclaimed_suggestions: instanceEntry("(unclaimed:suggestions)"),
  // The `manual` learnings. No cognition instance produced them, so they belong
  // to no instance — a fact neither TD-423's nor TD-437's table contains,
  // because both were written per-instance.
  unclaimed_learnings: instanceEntry("(unclaimed:learnings)"),
  // The event record, reported ALONGSIDE the row counts and never reconciled
  // with them. D6 below is the narrative case; this entry is what keeps the
  // pair from sitting in the fixture unread if D6 is ever rewritten.
  events: (d, t, k, w) => {
    const e = pick(d, "perception").judgment_events;
    const exp = t[k] as { approved: number; rejected: number };
    expect(e?.approved, `${w}.${k}.approved`).toBe(exp.approved);
    expect(e?.rejected, `${w}.${k}.rejected`).toBe(exp.rejected);
    return 2;
  },
};

/**
 * Consume EVERY key one WORLD declares — channel totals and instance blocks
 * alike — and THROW on a key the map does not know. Returns the leaf count so a
 * caller can prove the call was not vacuous.
 */
function expectTopLevel(d: CognitionYieldDigest, exp: unknown, where: string): number {
  const top = exp as TopLevel;
  let consumed = 0;
  for (const key of Object.keys(top)) {
    const assertKey = TOP_LEVEL_KEY_ASSERTIONS[key];
    if (assertKey === undefined) {
      throw new Error(
        `${where} declares \`${key}\` and nothing consumes it — wire it into TOP_LEVEL_KEY_ASSERTIONS or delete it`,
      );
    }
    consumed += assertKey(d, top, key, where);
  }
  expect(consumed, `${where} consumed no declared value`).toBeGreaterThan(0);
  return consumed;
}

const CHANNEL_TOTAL_KEYS = [
  "suggestions_total",
  "suggestions_pending",
  "learnings_total",
  "learnings_pending",
] as const;

/** The four channel-level totals alone — through the same map, never beside it. */
function expectChannels(d: CognitionYieldDigest, exp: unknown, where: string): number {
  const top = exp as TopLevel;
  let consumed = 0;
  for (const key of CHANNEL_TOTAL_KEYS) consumed += TOP_LEVEL_KEY_ASSERTIONS[key](d, top, key, where);
  return consumed;
}

function writeConfig(cognition: Record<string, unknown>): void {
  writeFileSync(
    join(tmpRoot, "config.json"),
    JSON.stringify({ version: "7.0.0", cognition }),
    "utf-8",
  );
}

async function closeBrainDb(): Promise<void> {
  (await import("../lib/brain-db.js")).closeDb();
}

/** A roster row for an id that appears NOWHERE in `cli/src`. */
function stub(id: string, produced: string): RosterSeed {
  return {
    id,
    component: `cognition.${id}`,
    event_prefix: `cognition.${id}`,
    gate_keys: [`cognition.${id}.enabled`],
    gate_default: false,
    driver: "manual",
    driver_ref: null,
    output: `suggestions[source_module='${id}']`,
    produced,
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-yield-"));
  savedEnv = { ...process.env };
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
});

afterEach(async () => {
  await closeBrainDb();
  process.env = savedEnv;
});

// ---------------------------------------------------------------------------
// The predicate parser — the sole parser of a cross-package grammar
// ---------------------------------------------------------------------------

describe("parseProducedPredicate — the grammar's only parser", () => {
  it("parses each of the seven PRODUCTION declarations", async () => {
    const { parseProducedPredicate } = await import("../lib/brain-db.js");
    for (const row of PRODUCTION_ROSTER) {
      const p = parseProducedPredicate(row.produced);
      expect(p, `${row.id} declares an unparseable predicate: ${row.produced}`).not.toBeNull();
    }
    // Not merely "parsed" — the two SHAPES are both exercised, or the loop above
    // could pass while the OTHER branch was never reached.
    const literal = parseProducedPredicate("suggestions[source_module='janitor']");
    expect(literal).toEqual({
      table: "suggestions",
      clauses: [{ column: "source_module", kind: "literal", value: "janitor" }],
    });
    const complement = parseProducedPredicate(
      "suggestions[type_inferred=1, source_module=OTHER]",
    );
    expect(complement).toEqual({
      table: "suggestions",
      clauses: [
        { column: "type_inferred", kind: "literal", value: 1 },
        { column: "source_module", kind: "other" },
      ],
    });
  });

  it("REFUSES a table outside the allowlist and an unparseable token", async () => {
    const { parseProducedPredicate } = await import("../lib/brain-db.js");
    // The allowlist is a safety boundary, not a convenience: the table name is
    // INTERPOLATED into the SQL, so anything that reaches it must be a member of
    // a closed set checked first.
    expect(parseProducedPredicate("sqlite_master[name='learnings']")).toBeNull();
    // The subconscious's LEGACY `output` — the exact expression `readOutputCounts`
    // also refuses. A parser that "helpfully" understood `LLM-named` would count
    // every type_inferred=1 row and attribute all six suggestion-writing
    // instances to the subconscious.
    expect(
      parseProducedPredicate("suggestions[source_module=LLM-named, type_inferred=1]"),
    ).toBeNull();
    expect(parseProducedPredicate("")).toBeNull();
    expect(parseProducedPredicate("suggestions[]")).toBeNull();
    expect(parseProducedPredicate("suggestions")).toBeNull();
    // A partial understanding is refused WHOLE rather than counted in part.
    expect(parseProducedPredicate("suggestions[source_module='a', bogus]")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-6 (a) — the KNOWN-ANSWER arithmetic proof
// ---------------------------------------------------------------------------

describe("known-answer: the 2026-08-26 world TD-423 measured (AC-6)", () => {
  beforeEach(() => {
    seedWorld_2026_08_26(dbFile());
    writeConfig({});
  });

  it("reproduces the brief's per-instance table, field by field", async () => {
    const d = await digest();
    expect(d.degraded).toBe(false);
    const E = EXPECTED_2026_08_26;

    // EVERY value the fixture declares for this world — every instance block
    // AND the four channel totals — including the three rates this world
    // declares (`keep_rate`, `judged_share`, `expiry_share`; the digest's
    // fourth, `pending_share_of_queue`, is pinned by the two cases below).
    // Driving the whole object from its own keys, rather than hand-listing
    // either the instances or the channel fields, is what stops a future
    // expectation from being declared and never read.
    const consumed = expectTopLevel(d, E, "EXPECTED_2026_08_26");
    // Non-vacuous: the driver really did consume the whole table (50 leaves).
    expect(consumed).toBeGreaterThan(44);
    expect(pick(d, "(unclaimed:suggestions)").instance_id).toBeNull();

    // AC-4 IN ITS RATE FORM. `judged_share_of_produced` is 29/69, not 29/29:
    // the 40 expiry rows stay in the denominator and are reported as lapsed,
    // rather than being quietly removed so the instance scores 100%.
    expect(pick(d, "perception").judged_share_of_produced?.denominator).toBe(69);
    expect(pick(d, "perception").judged_share_of_produced?.value).not.toBe(1);
  });

  it("the pending SHARE is taken over the whole brain-wide queue", async () => {
    const d = await digest();
    const E = EXPECTED_2026_08_26;

    // 291 of the 1,554 rows waiting in `suggestions`. The denominator is the
    // QUEUE, not this instance's own output — a share of its own rows would
    // read ~99% and mean nothing about the queue an operator has to work.
    const sub = pick(d, "subconscious");
    expect(sub.pending_share_of_queue?.numerator).toBe(E.subconscious.pending_live);
    expect(sub.pending_share_of_queue?.denominator).toBe(E.suggestions_pending);
    expect(sub.pending_share_of_queue?.value).toBeCloseTo(291 / 1554, 12);
    expect(sub.queue_table).toBe("suggestions");

    // NEGATIVE CONTROL on the same field — perception is on `learnings`, whose
    // review queue is empty in this world, so its share is 0/0 and reads null.
    // Same field, different channel, different denominator: proof the reader
    // takes the denominator from the row's OWN channel.
    const p = pick(d, "perception");
    expect(p.pending_share_of_queue?.numerator).toBe(E.perception.pending_live);
    expect(p.pending_share_of_queue?.denominator).toBe(E.learnings_pending);
    expect(p.pending_share_of_queue?.value).toBeNull();
    expect(p.queue_table).toBe("learnings");
  });

  it("reproduces the brief's GOVERNING caveat — 1,610 rows, 1,554 pending, 56 judged", async () => {
    const d = await digest();
    // BOTH channels, not just the one the brief's table is about: the learnings
    // side carries the 69 rows AC-4 is a claim about, and leaving its totals
    // unasserted was how `learnings_total` sat in the fixture unread. Routed
    // through `TOP_LEVEL_KEY_ASSERTIONS` rather than beside it, so this second
    // consumer of the same four values cannot drift from the closed one.
    expect(expectChannels(d, EXPECTED_2026_08_26, "EXPECTED_2026_08_26")).toBe(4);
    const channel = d.channels.find((c) => c.table === "suggestions");

    // 56 of 1,610 — the 3.5% the brief calls its governing caveat. Summed from
    // the digest's own per-entry judged counts, so this is a cross-check of the
    // table above rather than a second read of the same query.
    const judged = d.instances.reduce((n, i) => n + (i.judged ?? 0), 0);
    const suggestionJudged = d.instances
      .filter((i) => i.channel === "suggestions")
      .reduce((n, i) => n + (i.judged ?? 0), 0);
    expect(suggestionJudged).toBe(56);
    expect(judged).toBeGreaterThan(suggestionJudged); // the learnings channel too
    expect(suggestionJudged / (channel?.total_rows ?? 1)).toBeCloseTo(0.0348, 4);
  });

  it("AC-4 — the 40 expiry rows are NOT rejections, and that CHANGES the rate", async () => {
    const d = await digest();
    const p = pick(d, "perception");

    // The compensation: 40 expiry-flipped rows, 6 human rejections, and the two
    // are in different buckets.
    expect(p.expired_not_judged).toBe(40);
    expect(p.rejected_judged).toBe(6);
    expect(p.judged).toBe(29);

    // NEGATIVE CONTROL — without the discriminator the number is 23/69 = 33%,
    // and 33% vs 79% is exactly the misreading TD-423 was filed about. Computed
    // here so the assertion above is a claim about the DISCRIMINATOR and not
    // about an accidentally-empty set.
    const naive = 23 / (23 + 6 + 40);
    expect(naive).toBeCloseTo(0.3333, 4);
    expect(p.keep_rate_of_judged?.value).toBeCloseTo(23 / 29, 10);
    expect(p.keep_rate_of_judged?.value).not.toBeCloseTo(naive, 3);

    // And the expiry is REPORTED, not merely excluded — a row dropped silently
    // from a denominator is a different defect from one that is named.
    expect(p.expiry_share_of_produced?.numerator).toBe(40);
    expect(p.expiry_share_of_produced?.denominator).toBe(69);
  });

  it("AC-5 — the subconscious is ONE entry, not 168", async () => {
    const d = await digest();
    // 168 distinct `source_module` values across 293 rows, and the digest has
    // exactly ONE row for them. A reading that grouped by `source_module` — the
    // obvious implementation — would return 168 entries here.
    expect(pick(d, "subconscious").distinct_label_values).toBe(
      EXPECTED_2026_08_26.subconscious.distinct_labels,
    );
    expect(d.instances.filter((i) => i.instance_id === "subconscious")).toHaveLength(1);
    // The roster's seven, plus one unclaimed bucket for `suggestions`. The
    // `learnings` channel has no unclaimed rows in this world, so no bucket is
    // invented for it.
    expect(d.instances).toHaveLength(PRODUCTION_ROSTER.length + 1);
    expect(d.instances.length).toBeLessThan(168);
  });

  it("the OTHER complement EXCLUDES every literal sibling's rows", async () => {
    const d = await digest();
    const sub = pick(d, "subconscious");
    // 766 rows carry `type_inferred = 1` in this world (293 + 441 + 21 + 8 + 3
    // + 0); the subconscious owns 293 of them. The other 473 belong to the five
    // literal siblings, and a `WHERE type_inferred = 1` reading — the tempting
    // shortcut — would swallow all six instances into one number.
    const literalSiblings =
      EXPECTED_2026_08_26.synapse.produced +
      EXPECTED_2026_08_26.cartographer.produced +
      EXPECTED_2026_08_26.arbiter.produced +
      EXPECTED_2026_08_26.curator.produced +
      EXPECTED_2026_08_26.janitor.produced;
    expect(sub.produced_rows).toBe(EXPECTED_2026_08_26.subconscious.produced);
    expect((sub.produced_rows ?? 0) + literalSiblings).toBe(766);
  });
});

// ---------------------------------------------------------------------------
// The 2026-09-01 world — the shape TD-437 left behind
// ---------------------------------------------------------------------------

describe("known-answer: the 2026-09-01 world TD-437 left behind", () => {
  beforeEach(() => {
    seedWorld_2026_09_01(dbFile());
    writeConfig({});
  });

  it("reproduces the post-triage per-instance counts", async () => {
    const d = await digest();
    const E = EXPECTED_2026_09_01;
    // Channel totals, every instance block, and the event pair — all of them,
    // driven from the fixture's own keys.
    const consumed = expectTopLevel(d, E, "EXPECTED_2026_09_01");
    expect(consumed).toBeGreaterThan(41);
  });

  it("the label census `types.ts` cites is reproduced ROW BY ROW", async () => {
    const d = await digest();
    // The comment on `distinct_label_values` states this census, and a census
    // stated as a rule ("1 for every literal instance") is a claim about every
    // member of the set — so every member is asserted, including the two that
    // read nothing. The three readings are NOT interchangeable: 1 is a label,
    // 0 is a measured absence of rows, and null is a reading never available.
    const census: Array<[string, number | null]> = [
      ["synapse", 1],
      ["arbiter", 1],
      ["curator", 1],
      ["cartographer", 1],
      // A literal instance that reads 0, which is what made "1 for every
      // literal instance" false.
      ["janitor", 0],
      ["subconscious", 196],
      ["(unclaimed:suggestions)", 4],
      // `learnings` declares no label column, so these two never carry a value.
      ["perception", null],
      ["(unclaimed:learnings)", null],
    ];
    for (const [id, expected] of census) {
      expect(pick(d, id).distinct_label_values, `${id}.distinct_label_values`).toBe(expected);
    }
    // Every instance in the digest is in the census — a row added later cannot
    // sit outside it and leave the comment quietly generalised again.
    expect(census.map(([id]) => id).sort()).toEqual(d.instances.map((i) => i.id).sort());
    // ...and the note is present exactly where a reading was made, absent where
    // it was not, so `null` never arrives wearing an explanation of a count.
    for (const i of d.instances) {
      expect(i.distinct_label_note === null, `${i.id}.distinct_label_note`).toBe(
        i.distinct_label_values === null,
      );
    }
  });

  it("AC-7 — a drained queue makes EVERY pending share unmeasured, never 0%", async () => {
    const d = await digest();
    for (const c of d.channels) expect(c.pending_rows, c.table).toBe(0);
    const shares = d.instances
      .map((i) => i.pending_share_of_queue)
      .filter((r): r is CognitionRate => r !== null);
    // Non-vacuous: there ARE shares to check.
    expect(shares.length).toBeGreaterThan(0);
    for (const r of shares) {
      expect(r.denominator).toBe(0);
      // `null`, not `0`. A 0/0 rendered as "0%" reads as "this instance
      // contributes nothing to the queue", which is a claim; the truth is that
      // there is no queue to have a share of.
      expect(r.value).toBeNull();
    }
  });

  it("D6 — the event record is reported ALONGSIDE, never reconciled", async () => {
    const d = await digest();
    const p = pick(d, "perception");
    const e = p.judgment_events;
    expect(e).not.toBeNull();
    // Keyed on the roster's DECLARED literals. Deriving `cognition.perception`
    // finds zero rows for the one instance that has a real review path (L-857).
    expect(e?.component).toBe("perception");
    expect(e?.approved_event).toBe("perception.candidate_approved");
    expect(e?.approved).toBe(EXPECTED_2026_09_01.events.approved);
    expect(e?.rejected).toBe(EXPECTED_2026_09_01.events.rejected);
    // The two records DISAGREE, and both survive. 224 judged rows vs 85 events;
    // 1 surviving rejected row vs 7 rejection events. A verb that averaged them
    // would report a number that is true of neither record.
    expect(p.judged).toBe(224);
    expect((e?.approved ?? 0) + (e?.rejected ?? 0)).toBe(85);
    expect(e?.window_days).toBe(30);
    expect(e?.note).toMatch(/LOWER BOUND/);

    // The informative direction IS surfaced: 7 rejection events, 1 surviving
    // rejected row, and the digest names the hard-delete path as the cause.
    expect(d.warnings.some((w) => /perception.*candidate_rejected.*HARD-delete/.test(w))).toBe(
      true,
    );
    expect(p.produced_is_surviving_count).toBe(true);
  });

  it("the reconciliation invariant holds on BOTH channels", async () => {
    const d = await digest();
    expect(d.channels.map((c) => c.table).sort()).toEqual(["learnings", "suggestions"]);
    for (const c of d.channels) {
      expect(c.reconciled, `${c.table} did not reconcile`).toBe(true);
      expect((c.claimed_rows ?? 0) + (c.unclaimed_rows ?? 0)).toBe(c.total_rows);
    }
    expect(d.channels.find((c) => c.table === "suggestions")?.total_rows).toBe(
      EXPECTED_2026_09_01.suggestions_total,
    );
    expect(d.channels.find((c) => c.table === "learnings")?.total_rows).toBe(
      EXPECTED_2026_09_01.learnings_total,
    );
    // LIVENESS — `reconciled: true` must be a MEASUREMENT, not a constant.
    // Insert three rows after the first read: the complement is recomputed, so
    // the subconscious's count MOVES and the channel still reconciles. A cached
    // or hard-coded `true` would pass the loop above and fail here.
    //
    // (The negative control that proves `reconciled` can be FALSE lives in the
    // duplicate-OTHER case below, where two rows claim the same complement.)
    seedSuggestions(dbFile(), [
      { source_module: "arrived_later", type_inferred: 1, status: "acted", count: 3 },
    ]);
    const after = await digest();
    expect(pick(after, "subconscious").produced_rows).toBe(
      EXPECTED_2026_09_01.subconscious.produced + 3,
    );
    expect(after.channels.find((c) => c.table === "suggestions")?.total_rows).toBe(
      EXPECTED_2026_09_01.suggestions_total + 3,
    );
    expect(after.channels.every((c) => c.reconciled)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test-plan item 3 — expiry vs. judgment discrimination
// ---------------------------------------------------------------------------

describe("expiry is distinguishable from judgment (AC-4)", () => {
  beforeEach(() => {
    seedYieldSchema(dbFile());
    seedRoster(dbFile(), PRODUCTION_ROSTER);
    writeConfig({});
  });

  it("learnings: deleted_at discriminates, and flipping it MOVES the rate", async () => {
    seedLearnings(dbFile(), [
      { source_extractor: "llm", review_status: "approved", deleted_at: null, count: 1 },
      // EXPIRY — `rejectStalePending` writes the status and nothing else.
      { source_extractor: "llm", review_status: "rejected", deleted_at: null, count: 1 },
      // JUDGMENT — the recurring reject branch writes BOTH.
      {
        source_extractor: "llm",
        review_status: "rejected",
        deleted_at: "2026-08-26 11:50:17",
        count: 1,
      },
    ]);

    const before = pick(await digest(), "perception");
    expect(before.produced_rows).toBe(3);
    expect(before.expired_not_judged).toBe(1);
    expect(before.rejected_judged).toBe(1);
    expect(before.judged).toBe(2);
    expect(before.keep_rate_of_judged?.denominator).toBe(2);
    expect(before.keep_rate_of_judged?.value).toBe(0.5);

    // NEGATIVE CONTROL — give the EXPIRED row a `deleted_at` and it becomes a
    // judgment: the denominator grows and the rate CHANGES. Without this, the
    // assertions above could be passing against a bucket that is empty for some
    // unrelated reason.
    await closeBrainDb();
    const db = new Database(dbFile());
    db.prepare(
      `UPDATE learnings SET deleted_at = '2026-08-27 00:00:00'
        WHERE review_status = 'rejected' AND deleted_at IS NULL`,
    ).run();
    db.close();

    const after = pick(await digest(), "perception");
    expect(after.expired_not_judged).toBe(0);
    expect(after.rejected_judged).toBe(2);
    expect(after.keep_rate_of_judged?.denominator).toBe(3);
    expect(after.keep_rate_of_judged?.value).toBeCloseTo(1 / 3, 10);
    expect(after.keep_rate_of_judged?.value).not.toBe(before.keep_rate_of_judged?.value);
  });

  it("suggestions: a LAPSED pending row is unjudged, never a rejection", async () => {
    seedSuggestions(dbFile(), [
      {
        source_module: "cartographer",
        type_inferred: 1,
        status: "pending",
        count: 1,
        expires_at: "2020-01-01 00:00:00",
      },
      { source_module: "cartographer", type_inferred: 1, status: "pending", count: 1 },
      { source_module: "cartographer", type_inferred: 1, status: "dismissed", count: 1 },
    ]);

    const row = pick(await digest(), "cartographer");
    expect(row.pending_expired).toBe(1);
    expect(row.pending_live).toBe(1);
    expect(row.rejected_judged).toBe(1);
    // The lapsed row is ABSENT from `judged` entirely — it is neither kept nor
    // rejected, because nobody looked at it.
    expect(row.judged).toBe(1);
    expect(row.keep_rate_of_judged?.denominator).toBe(1);
    expect(row.expiry_share_of_produced?.numerator).toBe(1);

    // ...but it IS still in the QUEUE. `pending_share_of_queue`'s numerator is
    // `pending_live + pending_expired` = 2, and this is the only world in the
    // suite where those two differ — in both known-answer worlds nothing has an
    // `expires_at`, so a reader that counted only `pending_live` would agree
    // with a correct one everywhere else. Lapsed-but-unjudged rows are work an
    // operator still has to clear; dropping them under-reports the queue.
    expect(row.pending_share_of_queue?.numerator).toBe(2);
    expect(row.pending_share_of_queue?.denominator).toBe(2);
    expect(row.pending_share_of_queue?.value).toBe(1);
  });

  it("`kept` is BROADER than approved — a merged learning was still kept", async () => {
    seedLearnings(dbFile(), [
      { source_extractor: "llm", review_status: "approved", deleted_at: null, count: 1 },
      // Approved at review time, later merged by the janitor. A naive
      // `review_status = 'approved'` reading calls this UNJUDGED and
      // under-reports the keep rate.
      {
        source_extractor: "llm",
        review_status: "merged",
        deleted_at: "2026-08-20 00:00:00",
        count: 1,
      },
      {
        source_extractor: "llm",
        review_status: "superseded",
        deleted_at: "2026-08-20 00:00:00",
        count: 1,
      },
      { source_extractor: "llm", review_status: "pruned", deleted_at: "2026-08-20 00:00:00", count: 1 },
    ]);
    const row = pick(await digest(), "perception");
    expect(row.kept).toBe(4);
    expect(row.judged).toBe(4);
    expect(row.rejected_judged).toBe(0);
    expect(row.keep_rate_of_judged?.value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test-plan item 2 — registry derivation, with no CLI edit
// ---------------------------------------------------------------------------

describe("the roster is DERIVED — an instance this code never heard of renders", () => {
  beforeEach(() => {
    seedYieldSchema(dbFile());
    writeConfig({});
  });

  it("a stub id absent from cli/src is measured with ZERO edit here", async () => {
    // `roadmap_drift` is the established sentinel: it appears nowhere in
    // `cli/src`. If this file ever has to name it to make the case pass, the
    // derivation has been broken and TD-327 has been re-opened.
    seedRoster(dbFile(), [stub("roadmap_drift", "suggestions[source_module='roadmap_drift']")]);
    seedSuggestions(dbFile(), [
      { source_module: "roadmap_drift", type_inferred: 1, status: "acted", count: 2 },
    ]);

    const row = pick(await digest(), "roadmap_drift");
    expect(row.produced_rows).toBe(2);
    expect(row.kept).toBe(2);
    expect(row.measured).toBe(true);
  });

  it("NEGATIVE CONTROL — an EMPTY declaration is unmeasured, never zero", async () => {
    seedRoster(dbFile(), [stub("roadmap_drift", "")]);
    seedSuggestions(dbFile(), [
      { source_module: "roadmap_drift", type_inferred: 1, status: "acted", count: 2 },
    ]);
    const row = pick(await digest(), "roadmap_drift");
    // NOT `produced_rows: 0`. "I could not look" and "I looked and found none"
    // must not share a representation, or the wrongness has no surface to show
    // up on (TD-411's degrade-to-a-DEFINED-unknown rule).
    expect(row.produced_rows).toBeNull();
    expect(row.measured).toBe(false);
    expect(row.unmeasured_reason).toMatch(/declares no `produced` predicate/);
    expect(row.channel).toBeNull();
  });

  it("an UNKNOWN output table is unmeasured, and the reason names the closed set", async () => {
    seedRoster(dbFile(), [stub("roadmap_drift", "entity_edges[edge_type='duplicates']")]);
    const d = await digest();
    const row = pick(d, "roadmap_drift");
    expect(row.produced_rows).toBeNull();
    expect(row.measured).toBe(false);
    // The STATED BOUND reaches the operator's screen: total over instances,
    // CLOSED over tables. Without it a reader takes `unmeasured` for a defect
    // in the instance rather than a gap in the reader.
    expect(row.unmeasured_reason).toMatch(/CLOSED set over tables/);
    expect(row.unmeasured_reason).toMatch(/suggestions, learnings/);

    // The DIGEST-level reason must be right too, and it is a different sentence:
    // `entity_edges` reads perfectly well, it simply has no model. Reporting it
    // as "not readable in this brain" would be a wrong-but-plausible reason —
    // the exact class the house rule forbids — and it would drag a bogus
    // `reconciled: false` along with it.
    expect(d.warnings.some((w) => /no judgment model for it/.test(w))).toBe(true);
    expect(d.warnings.some((w) => /not readable in this brain/.test(w))).toBe(false);
    expect(d.warnings.some((w) => /does not reconcile/.test(w))).toBe(false);
    expect(d.channels.map((c) => c.table)).not.toContain("entity_edges");
    // ...and no `(unclaimed:entity_edges)` bucket is invented for it.
    expect(d.instances.map((i) => i.id)).not.toContain("(unclaimed:entity_edges)");
  });

  it("AC-5 at scale — one OTHER row absorbs 195 labels while siblings keep theirs", async () => {
    seedRoster(dbFile(), [
      stub("late_arrival", "suggestions[source_module='late_arrival']"),
      {
        ...stub("subconscious", "suggestions[type_inferred=1, source_module=OTHER]"),
        id: "subconscious",
      },
    ]);
    seedSuggestions(dbFile(), [
      // A literal sibling that must be EXCLUDED from the complement.
      { source_module: "late_arrival", type_inferred: 1, status: "acted", count: 7 },
      // 195 LLM-minted labels over 358 rows — TD-437's audit, 2026-09-01.
      ...[
        { source_module: "seed_label", type_inferred: 1 as const, status: "acted" as const, count: 5 },
      ],
      ...Array.from({ length: 194 }, (_, i) => ({
        source_module: `llm_kind_${i}`,
        type_inferred: 1 as const,
        status: "pending" as const,
        count: i === 193 ? 353 - 193 : 1,
      })),
    ]);

    const d = await digest();
    const sub = pick(d, "subconscious");
    // The seeded audit shape, read back off the digest (TD-437's audit,
    // 2026-09-01) — a fixed denominator, not a live count of the table.
    expect(sub.produced_rows).toBe(358);
    expect(sub.distinct_label_values).toBe(195);
    // The sibling's 7 rows are NOT in the complement — that exclusion is the
    // whole mechanism, and registering the sibling required no edit here.
    expect(pick(d, "late_arrival").produced_rows).toBe(7);
    // Two roster rows, no unclaimed bucket (the complement took everything),
    // and emphatically NOT 195 entries.
    expect(d.instances).toHaveLength(2);
  });

  it("registering a NEW literal sibling SHRINKS the complement, with no edit", async () => {
    seedRoster(dbFile(), [
      { ...stub("subconscious", "suggestions[type_inferred=1, source_module=OTHER]") },
    ]);
    seedSuggestions(dbFile(), [
      { source_module: "alpha", type_inferred: 1, status: "acted", count: 4 },
      { source_module: "beta", type_inferred: 1, status: "acted", count: 6 },
    ]);
    expect(pick(await digest(), "subconscious").produced_rows).toBe(10);

    // Register an eighth instance claiming `alpha`. The complement must shrink
    // by exactly its rows — computed FROM THE ROSTER, so this is the property
    // that makes the CLI free of instance ids.
    await closeBrainDb();
    seedRoster(dbFile(), [stub("alpha", "suggestions[source_module='alpha']")]);
    const after = await digest();
    expect(pick(after, "subconscious").produced_rows).toBe(6);
    expect(pick(after, "alpha").produced_rows).toBe(4);
  });

  it("two rows claiming the SAME complement are named, not silently doubled", async () => {
    seedRoster(dbFile(), [
      stub("greedy_a", "suggestions[type_inferred=1, source_module=OTHER]"),
      stub("greedy_b", "suggestions[type_inferred=1, source_module=OTHER]"),
    ]);
    seedSuggestions(dbFile(), [
      { source_module: "x", type_inferred: 1, status: "acted", count: 5 },
    ]);
    const d = await digest();
    expect(pick(d, "greedy_a").produced_rows).toBe(5);
    expect(pick(d, "greedy_b").produced_rows).toBe(5);
    expect(d.warnings.some((w) => /each declare OTHER/.test(w))).toBe(true);
    // ...and the channel reports that it does NOT reconcile, so the overlap is
    // visible on the numbers as well as in prose.
    expect(d.channels.find((c) => c.table === "suggestions")?.reconciled).toBe(false);
    expect(d.warnings.some((w) => /does not reconcile/.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-3 / AC-7 structural gates
// ---------------------------------------------------------------------------

describe("structural gates — a rate can never be rendered without its denominator", () => {
  it("AC-3 — EVERY rate object names a non-empty denominator", async () => {
    seedWorld_2026_08_26(dbFile());
    writeConfig({});
    const d = await digest();
    const rates = everyRate(d);
    // Non-vacuous first: an empty list would pass the loop trivially.
    expect(rates.length).toBeGreaterThan(20);
    for (const { owner, name, rate } of rates) {
      expect(typeof rate.denominator_label, `${owner}.${name}`).toBe("string");
      expect(rate.denominator_label.length, `${owner}.${name}`).toBeGreaterThan(0);
    }
    // The judged-subset rate says so IN its own label — the brief's AC-3 asks
    // for exactly this and nothing weaker.
    expect(pick(d, "perception").keep_rate_of_judged?.denominator_label).toMatch(
      /judged-subset rate, NOT a population rate/,
    );
  });

  it("AC-7 — no rate reports 0 over an empty denominator", async () => {
    seedWorld_2026_09_01(dbFile());
    writeConfig({});
    const d = await digest();
    for (const { owner, name, rate } of everyRate(d)) {
      if (rate.denominator === 0) {
        expect(rate.value, `${owner}.${name} rendered a value over an empty set`).toBeNull();
      } else {
        expect(rate.value, `${owner}.${name}`).toBeCloseTo(
          rate.numerator / rate.denominator,
          12,
        );
      }
    }
  });

  it("AC-7 — an instance with rows but NO verdicts is unmeasured, not zero", async () => {
    seedYieldSchema(dbFile());
    seedRoster(dbFile(), PRODUCTION_ROSTER);
    writeConfig({});
    seedSuggestions(dbFile(), [
      { source_module: "edge_inference", type_inferred: 1, status: "pending", count: 441 },
    ]);
    const row = pick(await digest(), "synapse");
    expect(row.produced_rows).toBe(441);
    expect(row.judged).toBe(0);
    expect(row.measured).toBe(false);
    expect(row.unmeasured_reason).toMatch(/absence of verdicts is not a verdict/);
    expect(row.keep_rate_of_judged?.value).toBeNull();
    // It produced 441 rows and that IS reported — unmeasured is about the RATE,
    // not about the population. Collapsing both to null would lose the finding
    // TD-423 opens with.
    expect(row.pending_live).toBe(441);
  });

  it("an instance that produced NOTHING reports unmeasured, never 0/10", async () => {
    seedYieldSchema(dbFile());
    seedRoster(dbFile(), PRODUCTION_ROSTER);
    writeConfig({});
    // The janitor writes no suggestions of its own; it drives three instances
    // that do. TD-437 scored it `unmeasured` for exactly this reason.
    const row = pick(await digest(), "janitor");
    expect(row.produced_rows).toBe(0);
    expect(row.measured).toBe(false);
    expect(row.keep_rate_of_judged?.value).toBeNull();
    expect(row.judged_share_of_produced?.value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test-plan item 4 — the degraded path. A question never blocks a caller.
// ---------------------------------------------------------------------------

describe("degradation — a yield question never blocks (T13 posture)", () => {
  it("absent brain DB → degraded, empty roster, exit 0", async () => {
    const d = await digest();
    expect(d.degraded).toBe(true);
    expect(d.degraded_reason).toMatch(/not readable/);
    expect(d.instances).toEqual([]);
    expect(d.channels).toEqual([]);
    const { runCognition } = await import("../verbs/cognition.js");
    expect(runCognition({ action: "yield", json: false })).toBe(0);
  });

  it("brain present, cognition_instances absent → its OWN named reason", async () => {
    makeBrainDir();
    const db = new Database(dbFile());
    db.exec("CREATE TABLE t (x INTEGER)");
    db.close();
    const d = await digest();
    expect(d.degraded).toBe(true);
    expect(d.degraded_reason).toMatch(/cognition_instances not present/);
  });

  it("a roster with NO produced column renders, warns, and measures nothing", async () => {
    // The pre-TD-423 shape: cognition migration v1 only. The digest must still
    // render — it just says what it lost. Folding this into `degraded` would
    // suppress the whole surface over a partial loss.
    makeBrainDir();
    const db = new Database(dbFile());
    db.exec(`
      CREATE TABLE cognition_instances (
        id TEXT PRIMARY KEY, component TEXT NOT NULL, event_prefix TEXT NOT NULL,
        gate_keys TEXT NOT NULL, gate_default INTEGER NOT NULL DEFAULT 0,
        driver TEXT NOT NULL, driver_ref TEXT,
        output TEXT NOT NULL, registered_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO cognition_instances (id, component, event_prefix, gate_keys, gate_default, driver, driver_ref, output)
      VALUES ('synapse','cognition.synapse','cognition.synapse','["cognition.synapse.enabled"]',0,'schedule','synapse_engine','suggestions[source_module=''edge_inference'']');
    `);
    db.close();

    const d = await digest();
    expect(d.degraded).toBe(false);
    expect(d.warnings.some((w) => /TD-423/.test(w))).toBe(true);
    expect(d.warnings.some((w) => /produced column/.test(w))).toBe(true);
    for (const i of d.instances) {
      expect(i.measured, i.id).toBe(false);
      expect(i.produced_rows, i.id).toBeNull();
    }
  });

  it("roster present, the OUTPUT tables absent → unmeasured + a named warning", async () => {
    makeBrainDir();
    const db = new Database(dbFile());
    db.exec(`
      CREATE TABLE cognition_instances (
        id TEXT PRIMARY KEY, component TEXT NOT NULL, event_prefix TEXT NOT NULL,
        gate_keys TEXT NOT NULL, gate_default INTEGER NOT NULL DEFAULT 0,
        driver TEXT NOT NULL, driver_ref TEXT,
        output TEXT NOT NULL, produced TEXT NOT NULL DEFAULT '',
        registered_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO cognition_instances (id, component, event_prefix, gate_keys, gate_default, driver, driver_ref, output, produced)
      VALUES ('synapse','cognition.synapse','cognition.synapse','["cognition.synapse.enabled"]',0,'schedule','synapse_engine','x','suggestions[source_module=''edge_inference'']');
    `);
    db.close();

    const d = await digest();
    expect(d.degraded).toBe(false);
    const row = pick(d, "synapse");
    expect(row.produced_rows).toBeNull();
    expect(row.unmeasured_reason).toMatch(/suggestions is not present/);
    expect(d.warnings.some((w) => /not readable in this brain/.test(w))).toBe(true);
  });

  it("`cognition bogus` still exits 2, and the message names BOTH actions", async () => {
    const { runCognition } = await import("../verbs/cognition.js");
    expect(runCognition({ action: "bogus", json: false })).toBe(2);
    expect(runCognition({ action: "yield", json: false })).toBe(0);
    expect(runCognition({ action: "health", json: false })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The D9 auto-apply bound — derived from the config, not from an instance id
// ---------------------------------------------------------------------------

describe("an auto-apply switch is named as a bound on the produced count", () => {
  it("finds every truthy auto_* leaf under cognition, and only those", async () => {
    const { truthyAutoApplyKeys } = await import("../verbs/cognition.js");
    expect(
      truthyAutoApplyKeys({
        cognition: {
          synapse: { auto_approve: true, enabled: false },
          janitor: {
            enabled: true,
            pruning: { auto_prune: false },
            cluster: { auto_fork: true },
          },
        },
      }),
    ).toEqual(["cognition.janitor.cluster.auto_fork", "cognition.synapse.auto_approve"]);
    // A NON-boolean truthy value is not an armed switch — the same posture
    // `evaluateGates` takes on a gate key. And an absent `cognition` block is an
    // empty answer, not a throw.
    expect(truthyAutoApplyKeys({ cognition: { synapse: { auto_approve: "yes" } } })).toEqual([]);
    expect(truthyAutoApplyKeys({})).toEqual([]);
  });

  it("surfaces the bound in the digest's warnings when the key is armed", async () => {
    seedWorld_2026_09_01(dbFile());
    writeConfig({ synapse: { auto_approve: true } });
    const d = await digest();
    expect(
      d.warnings.some((w) => /cognition\.synapse\.auto_approve is true/.test(w)),
    ).toBe(true);
    expect(d.warnings.some((w) => /UNDER-reports/.test(w))).toBe(true);

    // NEGATIVE CONTROL — with the switch off the warning is ABSENT, so the
    // assertion above is about the switch and not about a line printed always.
    await closeBrainDb();
    writeConfig({ synapse: { auto_approve: false } });
    expect(
      (await digest()).warnings.some((w) => /auto_approve is true/.test(w)),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T11 — the verb performs ZERO writes
// ---------------------------------------------------------------------------

describe("the yield digest performs ZERO writes (T11)", () => {
  it("leaves the DB file byte-identical, and the read is non-vacuous", async () => {
    seedWorld_2026_09_01(dbFile());
    writeConfig({});

    const before = {
      sha: createHash("sha256").update(readFileSync(dbFile())).digest("hex"),
      mtimeMs: statSync(dbFile()).mtimeMs,
      size: statSync(dbFile()).size,
    };

    const d = await digest();

    const after = {
      sha: createHash("sha256").update(readFileSync(dbFile())).digest("hex"),
      mtimeMs: statSync(dbFile()).mtimeMs,
      size: statSync(dbFile()).size,
    };

    expect(after.sha).toBe(before.sha);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);

    // POSITIVE CONTROL. "No writes" is trivially true of a run that read
    // nothing. The same run must have produced real signal, or every assertion
    // above is vacuous.
    expect(d.degraded).toBe(false);
    expect(d.instances.length).toBeGreaterThan(0);
    expect(d.instances.some((i) => i.produced_rows !== null && i.produced_rows > 0)).toBe(true);
    expect(d.instances.some((i) => i.keep_rate_of_judged?.value !== null)).toBe(true);
    expect(d.instances.some((i) => (i.judgment_events?.approved ?? 0) > 0)).toBe(true);
    expect(d.channels.length).toBe(2);
    expect(d.channels.every((c) => c.reconciled)).toBe(true);
  });

  it("does not create a -wal sidecar on a delete-mode brain", async () => {
    seedWorld_2026_08_26(dbFile());
    writeConfig({});
    await digest();
    const db = new Database(dbFile(), { readonly: true });
    expect(String(db.pragma("journal_mode", { simple: true }))).toBe("delete");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// D1 — the health digest is untouched BY CONSTRUCTION
// ---------------------------------------------------------------------------

describe("the yield action does not leak into the health digest (D1)", () => {
  it("no health instance carries a yield field, on the same brain", async () => {
    seedWorld_2026_09_01(dbFile());
    writeConfig({});
    const { buildCognitionHealthDigest } = await import("../verbs/cognition.js");
    const health = buildCognitionHealthDigest({ hostname: HOST });
    expect(health.degraded).toBe(false);
    expect(health.instances.length).toBeGreaterThan(0);

    // `GET /api/cognition` forwards this shape VERBATIM to a hand-written
    // browser mirror that compiles with zero shared import. A yield field
    // arriving here would reach that mirror as a name it does not declare.
    const yieldOnly = [
      "produced_rows",
      "kept",
      "judged",
      "keep_rate_of_judged",
      "pending_share_of_queue",
      "judgment_events",
      "measured",
    ];
    for (const inst of health.instances) {
      for (const key of yieldOnly) {
        expect(Object.keys(inst), `${inst.id} leaked ${key}`).not.toContain(key);
      }
    }
    // And the health digest still answers its OWN question on this fixture, so
    // the absence above is not the absence of a digest.
    expect(health.instances.some((i) => i.output_rows !== null)).toBe(true);
  });
});
