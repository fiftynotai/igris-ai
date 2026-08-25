/**
 * FR-266 — the diagnostics model, unit-tested with no browser.
 *
 * Everything a component could get quietly wrong lives in `../model`, and this
 * file is why: a tone is a CLAIM ABOUT WHO IS AT FAULT, and getting it wrong is
 * not a visual bug — it sends an operator to the wrong instance. `Diagnostics.tsx`
 * decides no tone at all; it asks these functions.
 *
 * THE THREE RULES THAT NEEDED A TEST RATHER THAN A REVIEW
 * ------------------------------------------------------
 *  1. `toneFor` is TOTAL over `string`. The cognition registry is OPEN and the
 *     CLI/brain pair is not upgraded atomically on a running machine, so a
 *     seventh status can arrive. A `switch` with no default renders a blank
 *     chip, which is worse than a wrong one: a blank says nothing is wrong.
 *  2. `blocked_upstream` is NOT `alarm`. The fault is the DRIVER's, and
 *     `classify()` exists precisely so the operator is not sent to the healthy
 *     instance. Painting it red re-creates that mistake in pixels.
 *  3. `disabled` is NOT a fault at all. It is an operator choice (AC-4), and
 *     the panel must be able to say WHICH gate, verbatim.
 *
 * @module diagnostics/__tests__/model.test
 */

import { describe, expect, it } from "vitest";
import type { CognitionInstanceHealth } from "../../lib/api";
import {
  KNOWN_STATUSES,
  TONES,
  describeInstance,
  gateLine,
  statusLabel,
  toneCounts,
  toneFor,
  unknownStatuses,
} from "../model";

/**
 * A minimal healthy row; each test overrides only the field it is about.
 *
 * `status` is widened to `string` on the OVERRIDE, deliberately.
 * `CognitionStatus` is a six-member union, but it is a COMPILE-TIME claim that
 * nothing enforces at runtime: the payload arrives through `JSON.parse`, which
 * validates nothing, and the value is projected by the BRAIN — a separately
 * versioned npm package. So a seventh status is representable on the wire while
 * being unrepresentable in the type, and a test that could not construct one
 * could not test the rule that exists for it.
 */
function row(
  over: Partial<Omit<CognitionInstanceHealth, "status">> & { status?: string } = {},
): CognitionInstanceHealth {
  return {
    id: "example",
    component: "cognition.example",
    event_prefix: "cognition.example",
    gate_keys: ["cognition.example.enabled"],
    gate_default: false,
    enabled: true,
    disabled_by: null,
    driver: "manual",
    driver_ref: null,
    status: "ok",
    reason: "latest terminal event on this host is cognition.example.run_succeeded",
    last_run_at: "2026-08-24T09:00:00.000Z",
    last_outcome: "cognition.example.run_succeeded",
    last_run_any_host: "2026-08-24T09:00:00.000Z",
    runs_today: 1,
    output: "suggestions[source_module='example']",
    output_rows: 3,
    schedule: null,
    ...over,
  } as CognitionInstanceHealth;
}

// ---------------------------------------------------------------------------
// toneFor — totality first, because that is the rule with no compiler behind it
// ---------------------------------------------------------------------------

describe("toneFor is TOTAL and survives a status this build has never heard of", () => {
  it("answers a tone for every KNOWN status", () => {
    for (const status of KNOWN_STATUSES) {
      const tone = toneFor(status);
      expect(TONES, `toneFor(${status}) = ${String(tone)}`).toContain(tone);
    }
  });

  it("answers a tone for a status invented after this build shipped", () => {
    // Not hypothetical: `cognition_instances` is projected by the BRAIN and
    // read by the CLI, and the two are separate npm packages upgraded
    // independently. `brain-db.ts#readCognitionRoster` already carries a
    // tolerant column read for the same reason one layer down.
    for (const unknown of ["quarantined", "", "OK", "ok ", "throttled_by_budget"]) {
      const tone = toneFor(unknown);
      expect(TONES, `toneFor(${JSON.stringify(unknown)}) = ${String(tone)}`).toContain(tone);
    }
  });

  it("an unknown status is ATTENTION — never silently healthy, never a false alarm", () => {
    // `ok` would hide it. `alarm` would cry wolf on a status that might mean
    // nothing is wrong. `attention` says "this build cannot judge this", which
    // is the honest reading, and the raw string is rendered beside it.
    expect(toneFor("quarantined")).toBe("attention");
    expect(toneFor("")).toBe("attention");
  });

  it("SELF-NEGATIVE-CONTROL — the tone set really discriminates", () => {
    // If every status mapped to one tone, every assertion in this file would
    // pass and the panel would be a monochrome list.
    const distinct = new Set(KNOWN_STATUSES.map(toneFor));
    expect(distinct.size).toBeGreaterThan(1);
    expect([...distinct].sort()).toEqual(["alarm", "attention", "off", "ok"]);
  });
});

// ---------------------------------------------------------------------------
// The tone assignments themselves (AC-4)
// ---------------------------------------------------------------------------

describe("the tone assignments encode WHO IS AT FAULT", () => {
  it("ok is ok", () => {
    expect(toneFor("ok")).toBe("ok");
  });

  it("failing and wedged are BOTH alarm", () => {
    // `failing` — it failed and nothing succeeded after.
    // `wedged`  — it cannot fire again until a human clears the open run.
    // Different causes, same demand on the operator.
    expect(toneFor("failing")).toBe("alarm");
    expect(toneFor("wedged")).toBe("alarm");
  });

  it("blocked_upstream is ATTENTION, not alarm — the fault is the driver's", () => {
    /*
     * THE RULE THIS FILE EXISTS FOR. A co-driven instance runs only inside its
     * driver's run and has no switch or schedule of its own, so painting it red
     * puts an alarm next to the thing that is NOT broken — the exact defect
     * `classify()` was written to prevent, re-created one tier up in pixels.
     */
    expect(toneFor("blocked_upstream")).not.toBe("alarm");
    expect(toneFor("blocked_upstream")).toBe("attention");
  });

  it("no_signal is attention — absence of EVIDENCE, not a fault", () => {
    // `event_log` is purged at 30 days, so "no signal" means "silent for at
    // least that long", never "never ran". An alarm here would train an
    // operator to retire working instances.
    expect(toneFor("no_signal")).toBe("attention");
  });

  it("disabled is OFF, and distinct from every fault tone (AC-4)", () => {
    // A disabled instance is an operator CHOICE. This is the assertion AC-4
    // names: `disabled` must be distinguishable from `failing`.
    expect(toneFor("disabled")).toBe("off");
    expect(toneFor("disabled")).not.toBe(toneFor("failing"));
    expect(toneFor("disabled")).not.toBe(toneFor("wedged"));
    expect(toneFor("disabled")).not.toBe(toneFor("ok"));
  });

  it("a FAILING instance is visually distinct from a HEALTHY one (AC-4)", () => {
    expect(toneFor("failing")).not.toBe(toneFor("ok"));
  });
});

// ---------------------------------------------------------------------------
// statusLabel — the chip word, including for a status with no label
// ---------------------------------------------------------------------------

describe("statusLabel is total too, and never renders an empty chip", () => {
  it("renders each known status as a readable word", () => {
    expect(statusLabel("blocked_upstream")).toBe("BLOCKED UPSTREAM");
    expect(statusLabel("no_signal")).toBe("NO SIGNAL");
    expect(statusLabel("ok")).toBe("OK");
    expect(statusLabel("disabled")).toBe("DISABLED");
  });

  it("an unknown status renders its RAW string, never a blank", () => {
    // The operator can then read the value the brain actually sent and go
    // looking for it, which a blank chip makes impossible.
    expect(statusLabel("quarantined")).toBe("QUARANTINED");
    expect(statusLabel("weird_new_thing")).toBe("WEIRD NEW THING");
  });

  it("a status that is empty still produces a non-empty chip", () => {
    expect(statusLabel("").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// gateLine — D4's deliberate limit, rendered rather than guessed
// ---------------------------------------------------------------------------

describe("gateLine renders disabled_by VERBATIM, and only when it applies", () => {
  it("an enabled instance has no gate line", () => {
    expect(gateLine(row({ status: "ok", enabled: true, disabled_by: null }))).toBeNull();
  });

  it("a disabled instance names the FAILING gate key, verbatim", () => {
    /*
     * The key is reproduced character-for-character rather than prettified: it
     * is a path into `config.json` and the operator's next action is to open
     * that file and find it. `cartographer` declares TWO gates, and the digest
     * reports the one that FAILED — reporting the first DECLARED key would
     * send them to the wrong toggle.
     */
    const line = gateLine(
      row({ status: "disabled", enabled: false, disabled_by: "cognition.janitor.cluster.enabled" }),
    );
    expect(line).toContain("cognition.janitor.cluster.enabled");
    expect(line).toContain("config.json");
  });

  it("the ONE case that IS distinguishable today gets its own sentence", () => {
    /*
     * D4 defers "never enabled" vs "deliberately disabled": `evaluateGates`
     * returns the same `disabled_by` for an ABSENT key and an EXPLICIT `false`,
     * and no field carries the raw resolved value, so no render can recover it.
     *
     * `(no gate declared)` is different — it is not a config key at all, it is
     * an instance that declared no gate, which is a DEFECT in the instance
     * rather than a choice by the operator. Sending someone to `config.json` to
     * look for a key called `(no gate declared)` is the failure this branch
     * prevents.
     */
    const line = gateLine(
      row({ status: "disabled", enabled: false, disabled_by: "(no gate declared)" }),
    );
    expect(line).not.toContain("config.json");
    expect(line).toContain("declares no gate");
  });
});

// ---------------------------------------------------------------------------
// describeInstance — the whole row view, and its stated unknowns
// ---------------------------------------------------------------------------

describe("describeInstance states an unknown rather than inventing a value", () => {
  it("carries the tone, the raw status and the server's reason verbatim", () => {
    const view = describeInstance(
      row({ status: "failing", reason: "latest terminal event on this host is X" }),
    );
    expect(view.tone).toBe("alarm");
    expect(view.status).toBe("failing");
    // The reason is the classifier's own operator-readable sentence. Rewriting
    // it here would be a second explanation of the same verdict.
    expect(view.reason).toBe("latest terminal event on this host is X");
  });

  it("a null last_run_at renders a STATED unknown, not an empty cell", () => {
    const view = describeInstance(row({ status: "no_signal", last_run_at: null, last_outcome: null }));
    expect(view.lastRun.length).toBeGreaterThan(0);
    expect(view.lastRun.toLowerCase()).toContain("no");
  });

  it("the driver line names the driver AND its ref when there is one", () => {
    expect(describeInstance(row({ driver: "co_driven", driver_ref: "janitor" })).driver).toContain(
      "janitor",
    );
    // A `manual` instance has no ref, and the line must not read "manual · null".
    expect(describeInstance(row({ driver: "manual", driver_ref: null })).driver).not.toContain(
      "null",
    );
  });

  it("a schedule line appears only when there is a schedule, and names the open run", () => {
    expect(describeInstance(row({ schedule: null })).schedule).toBeNull();
    const wedged = describeInstance(
      row({
        status: "wedged",
        driver: "schedule",
        driver_ref: "janitor_engine",
        schedule: {
          name: "janitor_engine",
          rows: 1,
          enabled: true,
          next_run_at: "2026-08-20T00:00:00.000Z",
          overdue: true,
          open_run_id: "run-open-janitor",
          open_run_started_at: "2026-08-11T00:00:00.000Z",
          open_run_age_days: 14,
        },
      }),
    );
    expect(wedged.schedule).toContain("run-open-janitor");
    expect(wedged.schedule).toContain("OVERDUE");
  });

  it("output_rows null renders as an honest unknown, not as 0", () => {
    /*
     * `null` means the declared output expression is not a countable
     * `table[column='value']` form — the subconscious names an OPEN
     * `source_module`. Rendering that as `0` would say "it has produced
     * nothing", which is a different and false claim.
     */
    const view = describeInstance(row({ output_rows: null }));
    expect(view.output).not.toContain(" 0 ");
    expect(view.output).toContain("suggestions[source_module='example']");
  });
});

// ---------------------------------------------------------------------------
// The roster-level summaries the panel header renders
// ---------------------------------------------------------------------------

describe("toneCounts and unknownStatuses summarise WITHOUT hiding anything", () => {
  it("counts every tone, including the ones at zero", () => {
    const counts = toneCounts([row({ status: "ok" }), row({ status: "failing" })]);
    // Every tone is a key, so a zero is rendered as a zero rather than being
    // absent — an absent key reads as "not applicable", which is not the same.
    expect(Object.keys(counts).sort()).toEqual([...TONES].sort());
    expect(counts.ok).toBe(1);
    expect(counts.alarm).toBe(1);
    expect(counts.attention).toBe(0);
    expect(counts.off).toBe(0);
  });

  it("reports the unknown statuses by name, deduplicated", () => {
    const found = unknownStatuses([
      row({ status: "ok" }),
      row({ status: "quarantined" }),
      row({ status: "quarantined" }),
    ]);
    expect(found).toEqual(["quarantined"]);
  });

  it("a roster of only KNOWN statuses reports no unknowns", () => {
    expect(unknownStatuses(KNOWN_STATUSES.map((s) => row({ status: s })))).toEqual([]);
  });
});
