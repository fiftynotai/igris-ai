/**
 * FR-241 — **the bulk bar and the tiered confirm dialog, RENDERED.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS ALONGSIDE `triage/__tests__/model.test.ts`
 * ─────────────────────────────────────────────────────────────────────────────
 * `model.test.ts` proves the COPY is computed correctly. It cannot prove the
 * dialog RENDERS it — a component that computed a perfect `ConfirmCopy` and then
 * displayed `copy.lines[0]` alone would pass every one of those 45 cases while
 * silently dropping the hard-delete sentence. That is the whole failure mode
 * this brief is guarding against, so it gets its own gate.
 *
 * WHAT THIS FILE PROVES
 *   - the tier-3 sentence reaches the DOM, in its own element, marked
 *     `.triage-danger`, and LAST;
 *   - a tier-3 bulk renders a typed-confirmation input AND leaves the confirm
 *     button `disabled` until the count is typed;
 *   - `writeAvailable: false` renders NO write control at all — *disabled, not
 *     broken*;
 *   - the selection count and the per-id failure messages are rendered
 *     verbatim (the brain's own words, never re-worded).
 *
 * WHAT IT DOES **NOT** PROVE
 *   Anything about EFFECTS or events. `renderToStaticMarkup` runs no
 *   `useEffect`, dispatches nothing, and applies no stylesheet — so "CANCEL
 *   issues no request" and "CONFIRM fires the POST" are NOT assertable here.
 *   **Siblings:** the CDP gate `G-BR-8` in `cli/scripts/browser-gate.mjs`,
 *   which clicks through a real dialog against a real seeded brain and counts
 *   the requests the page issued; and `dashboard-triage-endpoint.test.ts`,
 *   which owns what the request DOES.
 *
 * NOTE ON `useState`: `renderToStaticMarkup` renders the INITIAL state only, so
 * the dialog cannot be opened by clicking. It is opened by rendering with
 * `initialPending`, which is the one prop `BulkBar` carries for this file's
 * benefit — see its JSDoc for why that trade was taken.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BulkBar } from "../BulkBar";
import { TAB_ACTIONS, type TriageRow } from "../../../triage/model";

function html(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

/** Three first-time (tier 3) + two recurring (tier 2) candidates. */
const MIXED: TriageRow[] = [
  { id: 1, seen_again_count: 0 },
  { id: 2, seen_again_count: 0 },
  { id: 3, seen_again_count: 0 },
  { id: 4, seen_again_count: 4 },
  { id: 5, seen_again_count: 2 },
];

const base = {
  actions: TAB_ACTIONS.candidates,
  rows: MIXED,
  onSelectAll: () => {},
  onClear: () => {},
  onApply: () => {},
  busy: false,
  writeAvailable: true,
  writeReason: null,
  readout: null,
  failures: [],
} as const;

describe("the bar itself", () => {
  it("renders the selection count and one button per action", () => {
    const out = html(
      <BulkBar {...base} selection={new Set([1, 2])} initialPending={null} />,
    );
    expect(out).toContain("2 rows selected");
    expect(out).toContain("APPROVE");
    expect(out).toContain("REJECT");
    // `apply` is on no tab (D4) — a bulk bar is the wrong control for an action
    // that fires heterogeneous side effects.
    expect(out).not.toContain(">APPLY<");
  });

  it("marks an EMPTY selection so it cannot read as armed", () => {
    const out = html(<BulkBar {...base} selection={new Set()} initialPending={null} />);
    expect(out).toContain('data-selected="0"');
    expect(out).toContain("0 rows selected");
    // Every action button is disabled with nothing selected.
    expect(out.match(/<button[^>]*disabled[^>]*>APPROVE/)).not.toBeNull();
  });

  it("renders the BRAIN's verbatim failure messages, not a rewrite", () => {
    const out = html(
      <BulkBar
        {...base}
        selection={new Set([1])}
        initialPending={null}
        readout="REJECT — 2 of 3 applied, 1 failed"
        failures={[
          { id: 7, ok: false, error: "Suggestion 7 already acted; cannot dismiss" },
        ]}
      />,
    );
    expect(out).toContain("REJECT — 2 of 3 applied, 1 failed");
    expect(out).toContain("Suggestion 7 already acted; cannot dismiss");
    // FR-247 — the id still renders as `#7`. `outcomeLabel` reads `ref` first,
    // and this surface never carries one, so the id-addressed form must be
    // what comes out. Without this the widening could have silently turned
    // every triage failure into a bare `?`.
    expect(out).toContain("#7:");
  });
});

describe("the write surface being down HIDES every affordance", () => {
  it("renders a stated reason and NO button", () => {
    const out = html(
      <BulkBar
        {...base}
        selection={new Set([1, 2, 3])}
        initialPending={null}
        writeAvailable={false}
        writeReason="brain engine module not found: engine/index.js"
      />,
    );
    expect(out).toContain("TRIAGE DISABLED");
    expect(out).toContain("brain engine module not found");
    // *Disabled, not broken*: no button that will certainly fail.
    expect(out).not.toContain("<button");
    expect(out).not.toContain("REJECT");
  });

  it("SELF-NEGATIVE-CONTROL — the same props WITH the surface up render buttons", () => {
    // Without this, "no button" is also what you observe from a component that
    // renders nothing at all for these props.
    const out = html(
      <BulkBar {...base} selection={new Set([1, 2, 3])} initialPending={null} />,
    );
    expect(out).toContain("<button");
    expect(out).toContain("REJECT");
    expect(out).not.toContain("TRIAGE DISABLED");
  });
});

describe("the tiered confirm dialog", () => {
  const dialog = (selection: number[], action: "approve" | "reject" = "reject") =>
    html(<BulkBar {...base} selection={new Set(selection)} initialPending={action} />);

  it("a MIXED reject names 3 permanent and 2 recoverable, in the DOM", () => {
    const out = dialog([1, 2, 3, 4, 5]);
    expect(out).toContain("3 items will be PERMANENTLY DELETED");
    expect(out).toContain("2 items will be SOFT-deleted");
    expect(out).toContain("recoverable");
    // The count that must NOT appear as the permanent one.
    expect(out).not.toContain("5 items will be PERMANENTLY DELETED");
  });

  it("the hard-delete sentence is its OWN element, classed, and LAST", () => {
    const out = dialog([1, 2, 3, 4, 5]);
    const danger = /<p class="triage-confirm-line triage-danger">([^<]*)<\/p>/.exec(out);
    expect(danger, "no .triage-danger element in the dialog").not.toBeNull();
    expect(danger![1]).toContain("PERMANENTLY DELETED");
    expect(danger![1]).toContain("cannot be undone");
    // LAST: nothing follows it among the copy lines.
    const lines = [...out.matchAll(/<p class="triage-confirm-line[^"]*">/g)];
    expect(lines.length).toBe(2);
    expect(out.indexOf('triage-confirm-line triage-danger')).toBeGreaterThan(
      out.indexOf('<p class="triage-confirm-line">'),
    );
  });

  it("a tier-3 BULK renders the typed input and DISABLES confirm until it matches", () => {
    const out = dialog([1, 2, 3, 4, 5]);
    expect(out).toContain("type 3 to confirm the permanent deletions");
    expect(out).toContain("There is no undo tool for a hard delete");
    // The confirm button is genuinely `disabled` — not merely styled — so it
    // cannot be activated by Enter or by a synthetic click.
    expect(out).toMatch(/<button[^>]*disabled[^>]*>DELETE 3 PERMANENTLY<\/button>/);
    // ...and CANCEL is NOT disabled: an operator must always be able to back out.
    expect(out).toMatch(/<button[^>]*>CANCEL<\/button>/);
    expect(out.match(/<button[^>]*disabled[^>]*>CANCEL/)).toBeNull();
  });

  it("an ALL-RECOVERABLE reject has no danger line and no typed input", () => {
    // The negative control for both assertions above.
    const out = dialog([4, 5]);
    expect(out).not.toContain("triage-danger");
    expect(out).not.toContain("PERMANENTLY");
    expect(out).not.toContain("to confirm the permanent deletions");
    expect(out).toContain("REJECT 2");
  });

  it("a SINGLE hard delete states PERMANENT but demands no typing", () => {
    const out = dialog([1]);
    expect(out).toContain("1 item will be PERMANENTLY DELETED");
    expect(out).not.toContain("to confirm the permanent deletions");
  });

  it("APPROVE over the same rows claims nothing is deleted", () => {
    // The action forks the tiering, and the dialog must follow it: a dialog
    // that keyed off the ROWS alone would warn about deletion on an approve.
    const out = dialog([1, 2, 3, 4, 5], "approve");
    expect(out).not.toContain("DELETED");
    expect(out).not.toContain("triage-danger");
    expect(out).toContain("5 items will change status");
    expect(out).toContain("no un-approve tool");
  });

  it("a DISMISS dialog demands a reason and says why", () => {
    const out = html(
      <BulkBar
        {...base}
        actions={TAB_ACTIONS.suggestions}
        rows={[{ id: 1 }, { id: 2 }]}
        selection={new Set([1, 2])}
        initialPending="dismiss"
      />,
    );
    expect(out).toContain("reason (required)");
    expect(out).toContain("suppression loop");
    // Confirm is disabled while the reason is blank.
    expect(out).toMatch(/<button[^>]*disabled[^>]*>DISMISS 2<\/button>/);
  });

  it("the dialog announces itself as an alertdialog and stamps the tier count", () => {
    const out = dialog([1, 2, 3, 4, 5]);
    expect(out).toContain('role="alertdialog"');
    expect(out).toContain('aria-modal="true"');
    // The browser gate reads this attribute to assert WHICH tier is on screen
    // rather than merely that a dialog is.
    expect(out).toContain('data-hard-delete="3"');
    expect(out).toContain('data-action="reject"');
  });
});
