/**
 * FR-266 T5 — **the cognition panel, RENDERED, over the failing world.**
 *
 * `renderToStaticMarkup` in the node env — the pattern `record.test.tsx` and
 * `Markdown.test.tsx` already use. No DOM, no jsdom, no mock: `CognitionPanel`
 * is a pure function of its props (see `pages/Diagnostics.tsx`'s
 * `CognitionPanelProps` docblock for why the route/panel split exists), so the
 * markup asserted below is the markup the browser gets.
 *
 * WHAT THIS FILE PROVES
 * ---------------------
 *  - AC-4: a FAILING instance is visually distinct from a HEALTHY one, and
 *    `disabled` is distinct from `failing` — asserted on `data-tone`, so it is
 *    machine-checkable rather than eyeballed.
 *  - AC-4's second half: the DISABLED row carries its `disabled_by` string
 *    VERBATIM, so the operator gets a gate key rather than a bare word.
 *  - AC-3: every instance in the payload reaches the markup, including one whose
 *    id appears in no shipped file.
 *  - AC-5: all four non-render states produce a STATED sentence, and none of
 *    them produces `variant="loading"` without a successor.
 *
 * WHAT IT DOES NOT PROVE
 * ----------------------
 *  - That the payload below is what the server actually sends. **Sibling:**
 *    `cli/src/__tests__/dashboard-cognition-endpoint.test.ts`, which drives the
 *    REAL classifier over a REAL seeded brain and asserts these exact statuses
 *    and these exact reason substrings.
 *  - That anything is on screen. `renderToStaticMarkup` applies no stylesheet.
 *    **Sibling:** `browser-gate.mjs`'s `#/diagnostics` target, which reads the
 *    rows out of a live document.
 *
 * ⚠ THE PAYLOAD BELOW IS A MIRROR OF A SERVER FIXTURE, AND THE MIRROR IS
 * CHECKED. `cli/src/__tests__/dashboard-layers-source.test.ts` asserts that
 * every status in `dashboard-layers-fixture.ts#COGNITION_FIXTURE.expected`
 * appears in THIS file — so a branch the server world can produce cannot quietly
 * stop being rendered here. The two files cannot share an import: this one
 * compiles under `dashboard/tsconfig.json` (DOM lib, no node types) and the
 * fixture imports `better-sqlite3`.
 *
 * @module diagnostics/__tests__/panel.test
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CognitionPanel } from "../../pages/Diagnostics";
import type {
  CognitionHealthDigest,
  CognitionInstanceHealth,
  CognitionPayload,
  CognitionScheduleSignal,
} from "../../lib/api";

/** The gate the fixture switches off — the one operator CHOICE in the world. */
const DISABLED_GATE = "cognition.janitor.cluster.enabled";
/** An instance id that appears in no SHIPPED file. The AC-3 probe. */
const DERIVED_ID = "roadmap_drift";
/** The open run that wedges `janitor`. */
const OPEN_RUN = "run-open-janitor";

function schedule(over: Partial<CognitionScheduleSignal> = {}): CognitionScheduleSignal {
  return {
    name: "janitor_engine",
    rows: 1,
    enabled: true,
    next_run_at: "2026-08-20T00:00:00.000Z",
    overdue: true,
    open_run_id: OPEN_RUN,
    open_run_started_at: "2026-08-11T00:00:00.000Z",
    open_run_age_days: 14,
    ...over,
  };
}

function instance(
  over: Partial<Omit<CognitionInstanceHealth, "status">> & { id: string; status: string },
): CognitionInstanceHealth {
  return {
    component: `cognition.${over.id}`,
    event_prefix: `cognition.${over.id}`,
    gate_keys: [`cognition.${over.id}.enabled`],
    gate_default: false,
    enabled: true,
    disabled_by: null,
    driver: "manual",
    driver_ref: null,
    reason: "a reason",
    last_run_at: "2026-08-24T09:00:00.000Z",
    last_outcome: `cognition.${over.id}.run_succeeded`,
    last_run_any_host: "2026-08-24T09:00:00.000Z",
    runs_today: 1,
    output: `suggestions[source_module='${over.id}']`,
    output_rows: 2,
    schedule: null,
    ...over,
  } as CognitionInstanceHealth;
}

/**
 * THE 2026-08-24 FAILURE STATE, in the panel's own vocabulary.
 *
 * Every `reason` string is the classifier's own sentence — the templates in
 * `cli/src/verbs/cognition.ts#classify`. The endpoint suite asserts the LIVE
 * classifier emits these same substrings over the seeded brain
 * (`toContain("janitor is wedged")`, `toContain("fix the driver, not this
 * instance")`, `toContain("with no later success")`), which is what makes this
 * fixture a mirror rather than an invention.
 */
const INSTANCES: CognitionInstanceHealth[] = [
  instance({
    id: "perception",
    component: "perception",
    event_prefix: "perception",
    gate_default: true,
    driver: "session_hook",
    driver_ref: "session_end",
    status: "ok",
    reason: "latest terminal event on this host is perception.run_succeeded at 2026-08-24",
    last_outcome: "perception.run_succeeded",
  }),
  instance({
    id: "subconscious",
    driver: "schedule",
    driver_ref: "subconscious_engine",
    status: "ok",
    reason:
      "latest terminal event on this host is cognition.subconscious.run_succeeded at 2026-08-24",
    schedule: schedule({
      name: "subconscious_engine",
      overdue: false,
      open_run_id: null,
      open_run_started_at: null,
      open_run_age_days: null,
    }),
  }),
  instance({
    id: "synapse",
    driver: "schedule",
    driver_ref: "synapse_engine",
    status: "failing",
    reason:
      "latest terminal event on this host is cognition.synapse.run_failed at 2026-08-23, with no later success",
    last_outcome: "cognition.synapse.run_failed",
    schedule: schedule({
      name: "synapse_engine",
      overdue: false,
      open_run_id: null,
      open_run_started_at: null,
      open_run_age_days: null,
    }),
  }),
  instance({
    id: "janitor",
    driver: "schedule",
    driver_ref: "janitor_engine",
    status: "wedged",
    reason:
      `janitor_engine has an OPEN run ${OPEN_RUN} 14 days old, next_run_at 2026-08-20 is in the past. ` +
      "The daemon's overlap guard refuses to fire while any run is 'running', " +
      "so this schedule cannot fire again until the row reaches a terminal status.",
    schedule: schedule(),
  }),
  instance({
    id: "arbiter",
    gate_keys: ["cognition.janitor.enabled"],
    driver: "co_driven",
    driver_ref: "janitor",
    status: "blocked_upstream",
    reason:
      "runs only inside a janitor run, and janitor is wedged. " +
      "It has no switch or schedule of its own — fix the driver, not this instance.",
  }),
  instance({
    id: "curator",
    gate_keys: ["cognition.janitor.enabled"],
    driver: "co_driven",
    driver_ref: "janitor",
    status: "blocked_upstream",
    reason:
      "runs only inside a janitor run, and janitor is wedged. " +
      "It has no switch or schedule of its own — fix the driver, not this instance.",
  }),
  instance({
    id: "cartographer",
    gate_keys: ["cognition.janitor.enabled", DISABLED_GATE],
    enabled: false,
    disabled_by: DISABLED_GATE,
    driver: "co_driven",
    driver_ref: "janitor",
    status: "disabled",
    reason: `gate ${DISABLED_GATE} is not true in config.json`,
  }),
  instance({
    id: DERIVED_ID,
    status: "ok",
    reason: `latest terminal event on this host is cognition.${DERIVED_ID}.run_succeeded`,
  }),
];

function digest(over: Partial<CognitionHealthDigest> = {}): CognitionHealthDigest {
  return {
    degraded: false,
    degraded_reason: null,
    hostname: "fixture-host",
    event_log_retention_days: 30,
    event_log_oldest_at: "2026-07-26T18:06:55.000Z",
    instances: INSTANCES,
    warnings: [],
    ...over,
  };
}

function render(over: Partial<CognitionPayload> = {}, extra: Partial<{ loading: boolean; error: string | null; brainPath: string | null }> = {}): string {
  const payload: CognitionPayload = {
    cognition: digest(),
    generated_at: "2026-08-25T09:00:00.000Z",
    degraded: null,
    ...over,
  };
  return renderToStaticMarkup(
    <CognitionPanel
      payload={payload}
      loading={extra.loading ?? false}
      error={extra.error ?? null}
      brainPath={extra.brainPath ?? "/home/op/.igris/memory/knowledge.db"}
    />,
  );
}

/** Every `data-tone` in the markup, in document order. */
function tones(html: string): string[] {
  return [...html.matchAll(/data-instance-row="[^"]*"[^>]*data-tone="([^"]*)"/g)].map(
    (m) => m[1] as string,
  );
}

/** The `data-tone` of one named row. */
function toneOf(html: string, id: string): string | null {
  const m = new RegExp(`data-instance-row="${id}"[^>]*data-tone="([^"]*)"`).exec(html);
  return m === null ? null : (m[1] as string);
}

// ---------------------------------------------------------------------------
// AC-4 — visual distinction, asserted on attributes rather than on pixels
// ---------------------------------------------------------------------------

describe("AC-4 — a failing instance is distinct, and disabled is not an alarm", () => {
  it("FAILING and HEALTHY carry different tones", () => {
    const html = render();
    expect(toneOf(html, "synapse")).toBe("alarm");
    expect(toneOf(html, "perception")).toBe("ok");
    expect(toneOf(html, "synapse")).not.toBe(toneOf(html, "perception"));
  });

  it("DISABLED is distinct from FAILING — an operator choice, not an alarm", () => {
    const html = render();
    expect(toneOf(html, "cartographer")).toBe("off");
    expect(toneOf(html, "cartographer")).not.toBe(toneOf(html, "synapse"));
    expect(toneOf(html, "cartographer")).not.toBe(toneOf(html, "janitor"));
  });

  it("BLOCKED_UPSTREAM is NOT painted like the thing that is actually broken", () => {
    /*
     * The rule this whole surface turns on. `arbiter` and `curator` are not
     * broken — `janitor` is. Rendering all three the same colour sends the
     * operator to whichever they read first, which is the defect `classify()`
     * exists to prevent.
     */
    const html = render();
    expect(toneOf(html, "arbiter")).toBe("attention");
    expect(toneOf(html, "curator")).toBe("attention");
    expect(toneOf(html, "arbiter")).not.toBe(toneOf(html, "janitor"));
  });

  it("the tone reaches the BADGE too, not only the row attribute", () => {
    // `data-tone` is what the tests read; the badge class is what the operator
    // sees. Asserting only the former would pass on a panel that rendered every
    // chip identically.
    const html = render();
    expect(html).toContain("badge-alarm");
    expect(html).toContain("badge-live");
    expect(html).toContain("badge-warn");
    expect(html).toContain("badge-muted");
  });

  it("POSITIVE CONTROL — every tone is present, so no tone assertion is vacuous", () => {
    /*
     * A renderer that emitted ONE tone for everything, or that rendered nothing
     * at all, satisfies every `not.toBe` above. This is the assertion that stops
     * that: all four tones must appear, in a render of eight rows.
     */
    const seen = new Set(tones(render()));
    expect([...seen].sort()).toEqual(["alarm", "attention", "off", "ok"]);
  });
});

// ---------------------------------------------------------------------------
// The sentences that make a tone actionable
// ---------------------------------------------------------------------------

describe("the rows carry the classifier's own words, not a paraphrase", () => {
  it("the DISABLED row names its gate key VERBATIM (D4)", () => {
    /*
     * This build cannot tell "never enabled" from "deliberately switched off" —
     * `evaluateGates` returns the same `disabled_by` for an absent key and an
     * explicit `false`. So it shows the KEY and lets the operator look, which
     * turns a bare `DISABLED` into a next action.
     */
    const html = render();
    expect(html).toContain(DISABLED_GATE);
    expect(html).toContain("config.json");
  });

  it("the BLOCKED rows NAME the driver, so the operator goes to janitor", () => {
    const html = render();
    expect(html).toContain("fix the driver, not this instance");
    expect(html).toContain("janitor is wedged");
  });

  it("the WEDGED row names the OPEN RUN that is holding it", () => {
    const html = render();
    expect(html).toContain(OPEN_RUN);
    expect(html).toContain("OVERDUE");
  });

  it("the footer bounds a NO SIGNAL verdict with the retention floor", () => {
    // Without it a reader takes "no signal" for "never ran" and retires a
    // working instance — the failure `event_log`'s 30-day purge creates.
    const html = render();
    expect(html).toContain("30");
    expect(html).toContain("2026-07-26");
    expect(html).toContain("never &quot;never ran&quot;");
  });

  it("the footer names the host every verdict is scoped to", () => {
    expect(render()).toContain("fixture-host");
  });
});

// ---------------------------------------------------------------------------
// AC-3 — the roster is whatever the payload says it is
// ---------------------------------------------------------------------------

describe("AC-3 — every instance in the payload reaches the markup", () => {
  it("renders all eight rows, in the payload's order", () => {
    const html = render();
    const ids = [...html.matchAll(/data-instance-row="([^"]*)"/g)].map((m) => m[1]);
    expect(ids).toEqual(INSTANCES.map((i) => i.id));
  });

  it("an instance whose id is in NO shipped file still renders", () => {
    // A hardcoded roster of the seven real instances cannot produce this row,
    // which is what makes AC-3 falsifiable here rather than merely plausible.
    const html = render();
    expect(html).toContain(`data-instance-row="${DERIVED_ID}"`);
  });

  it("a NINTH instance invented at render time appears with no code change", () => {
    const html = renderToStaticMarkup(
      <CognitionPanel
        payload={{
          cognition: digest({
            instances: [
              ...INSTANCES,
              instance({ id: "an_instance_from_the_future", status: "ok" }),
            ],
          }),
          generated_at: "2026-08-25T09:00:00.000Z",
          degraded: null,
        }}
        loading={false}
        error={null}
        brainPath={null}
      />,
    );
    expect(html).toContain('data-instance-row="an_instance_from_the_future"');
  });

  it("an UNRECOGNISED status renders, is flagged, and is not silently healthy", () => {
    const html = renderToStaticMarkup(
      <CognitionPanel
        payload={{
          cognition: digest({
            instances: [instance({ id: "quarantined_one", status: "quarantined" })],
          }),
          generated_at: "2026-08-25T09:00:00.000Z",
          degraded: null,
        }}
        loading={false}
        error={null}
        brainPath={null}
      />,
    );
    // The raw value survives to the markup...
    expect(html).toContain('data-status="quarantined"');
    expect(html).toContain("QUARANTINED");
    // ...it is treated as needing attention rather than as `ok`.
    //
    // Scoped to the ROW, not to the document: the counter strip legitimately
    // carries `data-tone="ok"` on a counter reading 0, because every tone is
    // rendered including the empty ones. A document-wide `not.toContain` would
    // be asserting against that feature rather than against this row.
    expect(toneOf(html, "quarantined_one")).toBe("attention");
    expect(toneOf(html, "quarantined_one")).not.toBe("ok");
    // ...and the panel SAYS it did not recognise it.
    expect(html).toContain("data-diag-unknown");
  });
});

// ---------------------------------------------------------------------------
// AC-5 — it degrades to a stated unknown, never to a blank or an eternal spinner
// ---------------------------------------------------------------------------

describe("AC-5 — every non-render state produces a SENTENCE (TD-405)", () => {
  it("ENVELOPE degraded (no brain) renders the server's reason verbatim", () => {
    const html = render({
      cognition: null,
      degraded: { reason: "brain database not found at /home/op/.igris/memory/knowledge.db" },
    });
    expect(html).toContain("data-diag-degraded=\"envelope\"");
    expect(html).toContain("/home/op/.igris/memory/knowledge.db");
    // NOT an empty panel: the surface still renders, with its counters at zero.
    expect(html).toContain("data-diag-counts");
  });

  it("DIGEST degraded (an old brain build) is a DIFFERENT sentence", () => {
    /*
     * Two remedies: "there is no brain" -> install one; "the roster table is
     * absent" -> boot a build that projects it. Collapsing them hides which one
     * applies, which is the point `cognition-health.test.ts` makes one tier down.
     */
    const html = render({
      cognition: digest({
        degraded: true,
        degraded_reason:
          "cognition_instances not present — this brain has not booted a build that projects the roster",
        instances: [],
      }),
    });
    expect(html).toContain("data-diag-degraded=\"digest\"");
    expect(html).toContain("cognition_instances not present");
    // ...and the two are genuinely different markers, not one reused.
    expect(html).not.toContain("data-diag-degraded=\"envelope\"");
  });

  it("an EMPTY roster with no degradation still says something", () => {
    const html = render({ cognition: digest({ instances: [] }) });
    expect(html).toContain("no instances registered");
    // A blank region here would read as "everything is fine".
    expect(html).not.toContain("data-instance-row");
  });

  it("a TRANSPORT failure renders the error, and NOT a loading state", () => {
    const html = renderToStaticMarkup(
      <CognitionPanel
        payload={null}
        loading={false}
        error="read timed out after 15s"
        brainPath={null}
      />,
    );
    expect(html).toContain("read timed out after 15s");
    expect(html).toContain('data-variant="error"');
    // THE TD-405 ASSERTION. `payload === null && !loading` must never render the
    // loading variant — that is precisely the eternal loader this AC names.
    expect(html).not.toContain('data-variant="loading"');
  });

  it("a null payload with NO error still states something rather than blanking", () => {
    const html = renderToStaticMarkup(
      <CognitionPanel payload={null} loading={false} error={null} brainPath={null} />,
    );
    expect(html).toContain('data-variant="error"');
    expect(html.length).toBeGreaterThan(200);
    expect(html).not.toContain('data-variant="loading"');
  });

  it("the LOADING state exists, so the assertions above are not vacuous", () => {
    // SELF-NEGATIVE-CONTROL for the two `not.toContain('data-variant="loading"')`
    // assertions: if the panel could never render a loading state at all, they
    // would pass for the wrong reason.
    const html = renderToStaticMarkup(
      <CognitionPanel payload={null} loading={true} error={null} brainPath={null} />,
    );
    expect(html).toContain('data-variant="loading"');
  });

  it("digest WARNINGS are rendered, not swallowed", () => {
    const html = render({
      cognition: digest({
        warnings: ["duplicate schedule rows named janitor_engine (2)"],
      }),
    });
    expect(html).toContain("duplicate schedule rows named janitor_engine (2)");
  });
});

// ---------------------------------------------------------------------------
// The counters
// ---------------------------------------------------------------------------

describe("the tone counters render every tone, including the zeroes", () => {
  it("a roster with no alarms still renders an alarm counter reading 0", () => {
    const html = render({
      cognition: digest({ instances: [instance({ id: "only_one", status: "ok" })] }),
    });
    // An ABSENT counter reads as "not applicable"; a zero reads as "none". They
    // are different claims and the panel makes the second one.
    expect(html).toContain('data-tone="alarm"');
    expect(html).toContain("<b>0</b> alarm");
    expect(html).toContain("<b>1</b> healthy");
  });

  it("the registered total comes from the payload, not from a constant", () => {
    expect(render()).toContain(`<b>${INSTANCES.length}</b> registered`);
  });
});
