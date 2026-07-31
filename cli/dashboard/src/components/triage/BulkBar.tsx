/**
 * FR-241 — the selection bar and the TIERED confirmation dialog.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS COMPONENT DECIDES NOTHING
 * ─────────────────────────────────────────────────────────────────────────
 * Every number and every sentence comes from `triage/model.ts` — the tier
 * counts, the copy, whether a typed confirmation is demanded, and what must be
 * typed. That is deliberate: the safety-critical claim is "the operator was
 * told the truth about what this click does", and a claim that lives in JSX can
 * only be tested by rendering a dialog and reading the DOM. Here the component
 * is a renderer for a value that a 45-case table already pinned.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THE DIALOG GUARANTEES
 * ─────────────────────────────────────────────────────────────────────────
 *  - CANCEL issues no request. The dialog is pure local state until CONFIRM.
 *  - The hard-delete sentence renders in its own element (`.triage-danger`),
 *    last, so the count cannot be buried mid-paragraph.
 *  - A tier-3 BULK cannot be confirmed until the count is typed EXACTLY. The
 *    button is `disabled`, so neither Enter nor a stray click can fire it.
 *  - Every write affordance disappears — not greys out, disappears — when
 *    `health.write.available` is false. *Disabled, not broken*: a button that
 *    will certainly fail is worse than no button.
 */

import { useEffect, useState } from "react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import {
  confirmCopy,
  destructiveness,
  plural,
  reasonRequired,
  selectedRows,
  type Selection,
  type TriageAction,
  type TriageRow,
} from "../../triage/model";

export interface BulkBarProps {
  /** The actions this tab offers (`model.ts#TAB_ACTIONS`). */
  actions: readonly TriageAction[];
  selection: Selection;
  /** The rows currently on screen. Selection is confined to these. */
  rows: readonly TriageRow[];
  onSelectAll: () => void;
  onClear: () => void;
  /** Fired only after the dialog is confirmed. */
  onApply: (
    action: TriageAction,
    ids: number[],
    extra: { reason?: string; briefId?: string },
  ) => void;
  busy: boolean;
  /** `health.write.available`. False hides every write affordance. */
  writeAvailable: boolean;
  /** Why the write surface is down, verbatim, when it is. */
  writeReason: string | null;
  /** The last batch's readout, already formatted by `model.ts#summaryLine`. */
  readout: string | null;
  /** Per-id failures, carrying the BRAIN's own messages. */
  failures: readonly { id: number; error: string | null }[];
  /**
   * Which action's dialog is open on FIRST RENDER. Defaults to none.
   *
   * The app never passes it — the dialog is opened by clicking an action
   * button, and this component owns that state. It exists because
   * `renderToStaticMarkup` runs no effects and dispatches no events, so a
   * static render test could otherwise never see the dialog at all: the
   * safety-critical markup (the tier-3 sentence, the typed-confirmation input,
   * the disabled confirm button) would be untestable outside a browser. A
   * one-word initial-state prop is a smaller cost than leaving those unpinned
   * until the CDP run.
   */
  initialPending?: TriageAction | null;
}

const LABEL: Record<TriageAction, string> = {
  dismiss: "DISMISS",
  acted: "MARK ACTED",
  apply: "APPLY",
  approve: "APPROVE",
  reject: "REJECT",
};

export function BulkBar({
  actions,
  selection,
  rows,
  onSelectAll,
  onClear,
  onApply,
  busy,
  writeAvailable,
  writeReason,
  readout,
  failures,
  initialPending = null,
}: BulkBarProps) {
  const [pending, setPending] = useState<TriageAction | null>(initialPending);
  const [reason, setReason] = useState("");
  const [briefId, setBriefId] = useState("");
  const [typed, setTyped] = useState("");

  const chosen = selectedRows(selection, rows);
  const count = chosen.length;

  // Close the dialog if the selection empties underneath it — a re-read on the
  // beat can remove the very rows it is about, and confirming a dialog whose
  // subject no longer exists is how you dismiss the wrong batch.
  useEffect(() => {
    if (count === 0) setPending(null);
  }, [count]);

  if (!writeAvailable) {
    return (
      <div className="shell-banner" role="status">
        TRIAGE DISABLED — the write surface is unavailable, so this page is
        read-only. {writeReason ?? "no reason reported"}
      </div>
    );
  }

  const d = pending === null ? null : destructiveness(chosen, pending);
  const copy = pending === null || d === null ? null : confirmCopy(pending, d);
  const needsReason = pending !== null && reasonRequired(pending);
  const typedOk =
    copy === null || copy.requireTyped === null || typed.trim() === copy.requireTyped;
  const reasonOk = !needsReason || reason.trim().length > 0;

  const close = (): void => {
    setPending(null);
    setTyped("");
  };

  return (
    <>
      <div className="triage-bulk" data-selected={count}>
        <span className="record-readout">{plural(count, "row")} selected</span>
        <button type="button" className="record-filter-run" onClick={onSelectAll}>
          SELECT PAGE
        </button>
        <button
          type="button"
          className="record-filter-run"
          onClick={onClear}
          disabled={count === 0}
        >
          CLEAR
        </button>
        <span className="record-filters-spacer" />
        {actions.map((action) => (
          <Button
            key={action}
            size="sm"
            variant={action === "reject" ? "secondary" : "primary"}
            disabled={count === 0 || busy}
            onClick={() => {
              setTyped("");
              setPending(action);
            }}
          >
            {LABEL[action]}
          </Button>
        ))}
      </div>

      {readout !== null && (
        <p className="record-readout" role="status">
          {readout}
        </p>
      )}
      {failures.length > 0 && (
        <div className="shell-banner" role="status">
          {plural(failures.length, "item")} failed —{" "}
          {failures
            .slice(0, 5)
            .map((f) => `#${f.id}: ${f.error ?? "no message"}`)
            .join(" · ")}
          {failures.length > 5 ? ` · …and ${failures.length - 5} more` : ""}
        </div>
      )}

      {pending !== null && copy !== null && (
        <div
          className="triage-confirm"
          role="alertdialog"
          aria-modal="true"
          aria-label={copy.title}
          data-action={pending}
          data-hard-delete={d?.tier3 ?? 0}
        >
          <h2 className="triage-confirm-title">{copy.title}</h2>

          {/*
            One PARAGRAPH per line, never one joined string. The tier-3 sentence
            is the last entry and gets its own class so it can be styled alone —
            the plan's "rendered as its own sentence" requirement.
          */}
          {copy.lines.map((line) => (
            <p
              key={line}
              className={
                line === copy.hardDeleteLine
                  ? "triage-confirm-line triage-danger"
                  : "triage-confirm-line"
              }
            >
              {line}
            </p>
          ))}

          {needsReason && (
            <Input
              label="reason (required)"
              value={reason}
              placeholder="WHY IS THIS NOT WORTH DOING?"
              onChange={(e) => setReason(e.target.value)}
              help="Feeds dismissed_patterns and the suppression loop — a blind clear guarantees the backlog re-grows."
            />
          )}
          {pending === "acted" && (
            <Input
              label="brief id (optional)"
              value={briefId}
              placeholder="FR-241"
              onChange={(e) => setBriefId(e.target.value)}
              help="Which brief you opened in response."
            />
          )}

          {copy.requireTyped !== null && (
            <Input
              label={`type ${copy.requireTyped} to confirm the permanent deletions`}
              value={typed}
              placeholder={copy.requireTyped}
              onChange={(e) => setTyped(e.target.value)}
              invalid={typed.length > 0 && !typedOk}
              help="There is no undo tool for a hard delete. This is the confirmation that stands in for one."
            />
          )}

          <div className="triage-confirm-actions">
            <Button variant="ghost" size="sm" onClick={close} disabled={busy}>
              CANCEL
            </Button>
            <Button
              variant="primary"
              size="sm"
              // Every precondition is in ONE expression, and the button is
              // genuinely `disabled` rather than merely styled: a disabled
              // button cannot be activated by Enter, by a synthetic click, or
              // by a mis-aimed double-click landing after the dialog opened.
              disabled={busy || count === 0 || !typedOk || !reasonOk}
              onClick={() => {
                onApply(pending, chosen.map((r) => r.id), {
                  reason: reason.trim(),
                  briefId: briefId.trim(),
                });
                close();
              }}
            >
              {busy ? "…" : copy.confirmLabel}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
