/**
 * FR-241 — the triage surface's PURE logic. Selection algebra, the
 * destructiveness tiering, the confirmation copy, and the request builder.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY ALL OF IT IS HERE AND NONE OF IT IS IN A COMPONENT
 * ─────────────────────────────────────────────────────────────────────────
 * This is the first surface in the dashboard that can DESTROY data, and one of
 * its five actions destroys it irrecoverably. The property that matters —
 * "the operator is told the truth about what this click will do" — is a pure
 * function of the selected rows and the chosen action. Put it in a component
 * and the only way to test it is to render a dialog and read strings out of the
 * DOM; put it here and it is a table-driven unit test that runs in 3 ms and
 * covers the mixed selection, which is the case that actually bites.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE THREE TIERS — AND WHY A BLANKET "IRREVERSIBLE" BANNER IS A BUG
 * ─────────────────────────────────────────────────────────────────────────
 * L-140 records reject as a hard delete. That is HALF STALE: FR-116 M3 forked
 * `handlePerceptionReject` (`perception/handlers.ts:661-717`) on
 * `seen_again_count`, and the two branches have completely different outcomes.
 *
 *   TIER 1 — status flip.   dismiss / acted / apply / approve.
 *                           The row survives with a changed status. There is no
 *                           un-dismiss TOOL, so reversing it means hand-editing
 *                           the brain — recoverable, but not by this UI.
 *   TIER 2 — SOFT delete.   reject where `seen_again_count > 0` (recurring).
 *                           `review_status='rejected'` + `deleted_at`; the row
 *                           is still there.
 *   TIER 3 — HARD delete.   reject where `seen_again_count == 0` (first-time).
 *                           `DELETE FROM learnings` + `learnings_vec`. Gone.
 *
 * A dialog that says "irreversible" for all of them is LYING about tiers 1 and
 * 2, and a dialog that lies about the common case trains the operator to click
 * through the one case where it was telling the truth. So the copy is computed
 * from the actual selection, the tier-3 count gets its OWN SENTENCE, and a
 * tier-3 bulk demands the count be TYPED. That typed confirmation is the
 * "explicit irreversible confirmation" standing in for an undo story that
 * cannot exist for a `DELETE`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * UNKNOWN `seen_again_count` COUNTS AS TIER 3
 * ─────────────────────────────────────────────────────────────────────────
 * `undefined`/`null` means the client could not tell which branch a row will
 * take. The two possible errors are not symmetric: over-warning costs a
 * needless typed confirmation, under-warning costs a row. So absence resolves
 * to the WORSE tier, and `unknownTier3` reports how many of the tier-3 count
 * got there that way, so the copy can say so instead of implying certainty.
 */

/** The five actions, mirroring `brain-write-bridge.ts#TRIAGE_ACTIONS`' keys. */
export const TRIAGE_ACTIONS = [
  "dismiss",
  "acted",
  "apply",
  "approve",
  "reject",
] as const;
export type TriageAction = (typeof TRIAGE_ACTIONS)[number];

/**
 * Ids per POST. Mirrors `cli/src/lib/dashboard/params.ts#MAX_BULK`.
 *
 * The client CHUNKS at this boundary rather than letting the server clamp:
 * a clamp silently drops the tail, and "I selected 250 and 50 vanished" is the
 * shape of a bug report nobody can reproduce. `chunkIds` is the mirror, and
 * `params.ts`'s clamp is the backstop for a client that ignores it.
 */
export const MAX_BULK = 200;

/** The two sub-tabs. Different tables, different actions, one page. */
export const TRIAGE_TABS = ["suggestions", "candidates"] as const;
export type TriageTab = (typeof TRIAGE_TABS)[number];

/** Which actions each tab offers. The frozen map's keys, partitioned by table. */
export const TAB_ACTIONS: Record<TriageTab, readonly TriageAction[]> = {
  suggestions: ["dismiss", "acted"],
  candidates: ["approve", "reject"],
};

/**
 * The minimum a row must expose to be triaged.
 *
 * Deliberately NOT `SuggestionRow | LearningListRow`: this module must not know
 * what a suggestion IS, for the same reason the server layer must not. The two
 * views map their payload rows to this and the tiering is one implementation.
 */
export interface TriageRow {
  id: number;
  /**
   * `learnings.seen_again_count` for a candidate; ABSENT for a suggestion (a
   * suggestion is never rejected, so it never reaches the fork). Absent on a
   * candidate means "unknown", and unknown is treated as tier 3.
   */
  seen_again_count?: number | null;
}

// ---------------------------------------------------------------------------
// Selection algebra
// ---------------------------------------------------------------------------

/** Selected ids. A `Set` because membership is the only query the UI makes. */
export type Selection = ReadonlySet<number>;

export const EMPTY_SELECTION: Selection = new Set<number>();

export function toggleSelected(current: Selection, id: number): Selection {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Select every visible row, ADDING to what is already selected. */
export function selectAll(current: Selection, rows: readonly TriageRow[]): Selection {
  const next = new Set(current);
  for (const r of rows) next.add(r.id);
  return next;
}

/**
 * Drop every selected id that is not on the visible page.
 *
 * THIS IS A SAFETY PROPERTY, not tidiness. Selection lives above the list, so
 * without this a selection made on page 1 survives a filter change, a project
 * change and a page turn — and then a bulk action fires at rows the operator
 * can no longer see. The rule is: you may only act on what is on screen.
 *
 * It is also what keeps `destructiveness` honest, because the tier of a
 * selected id can only be computed from a row that is loaded.
 */
export function confineToVisible(
  current: Selection,
  rows: readonly TriageRow[],
): Selection {
  const visible = new Set(rows.map((r) => r.id));
  const next = new Set<number>();
  for (const id of current) if (visible.has(id)) next.add(id);
  return next;
}

/** The selected rows, in the visible list's order. */
export function selectedRows(
  selection: Selection,
  rows: readonly TriageRow[],
): TriageRow[] {
  return rows.filter((r) => selection.has(r.id));
}

/**
 * Split ids into `MAX_BULK`-sized requests.
 *
 * An empty input yields ZERO chunks, never one empty chunk: the server refuses
 * an empty `ids` array (a 400), and a UI that can fire an empty bulk action is
 * a UI whose selection state is wrong. `[]` here means "there is nothing to
 * send", which the caller must treat as "do not send".
 */
export function chunkIds(ids: readonly number[], size: number = MAX_BULK): number[][] {
  if (size < 1) throw new RangeError(`chunk size must be >= 1 (got ${size})`);
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push([...ids.slice(i, i + size)]);
  return out;
}

// ---------------------------------------------------------------------------
// Destructiveness
// ---------------------------------------------------------------------------

export interface Destructiveness {
  /** Status flips. The row survives with a changed status. */
  tier1: number;
  /** Soft deletes — `deleted_at` set, the row survives. */
  tier2: number;
  /** HARD deletes — the row and its vector entry are gone. */
  tier3: number;
  /** Of `tier3`, how many are there because the count was UNKNOWN, not zero. */
  unknownTier3: number;
  total: number;
}

/**
 * Tier the selection under one action.
 *
 * `reject` is the only action that forks; every other action is a status flip
 * on every row it touches. That asymmetry is why this takes the ACTION and not
 * just the rows — the same three rows are tier 1 under `approve` and tiers 2/3
 * under `reject`, and a function that could not say so would make the whole
 * dialog decorative.
 */
export function destructiveness(
  rows: readonly TriageRow[],
  action: TriageAction,
): Destructiveness {
  const total = rows.length;
  if (action !== "reject") {
    return { tier1: total, tier2: 0, tier3: 0, unknownTier3: 0, total };
  }
  let tier2 = 0;
  let tier3 = 0;
  let unknownTier3 = 0;
  for (const row of rows) {
    const seen = row.seen_again_count;
    if (seen === undefined || seen === null || !Number.isFinite(seen)) {
      // See the header: absence resolves to the WORSE tier, and says so.
      tier3 += 1;
      unknownTier3 += 1;
    } else if (seen > 0) {
      tier2 += 1;
    } else {
      tier3 += 1;
    }
  }
  return { tier1: 0, tier2, tier3, unknownTier3, total };
}

// ---------------------------------------------------------------------------
// The confirmation copy
// ---------------------------------------------------------------------------

export interface ConfirmCopy {
  /** The dialog's headline. */
  title: string;
  /**
   * One sentence per tier PRESENT in the selection, in ascending severity.
   * The tier-3 sentence is always its own entry and always last, so it cannot
   * be buried mid-paragraph by a longer tier-1 clause.
   */
  lines: string[];
  /** The tier-3 sentence, repeated here so a renderer can style it alone. */
  hardDeleteLine: string | null;
  /** `tier3` — the number the operator must TYPE, or `null` when they need not. */
  requireTyped: string | null;
  /** Label for the confirm button. Names the action and the count. */
  confirmLabel: string;
}

const ACTION_VERB: Record<TriageAction, string> = {
  dismiss: "Dismiss",
  acted: "Mark as acted",
  apply: "Apply the suggested action for",
  approve: "Approve",
  reject: "Reject",
};

/** `1 item` / `12 items` — used everywhere, so it is defined once. */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Build the confirmation copy for a selection under an action.
 *
 * The typed confirmation fires when the batch would HARD-DELETE something AND
 * contains more than one item. A single hard delete still gets the sentence and
 * a deliberate click; a BULK hard delete gets a gesture that cannot be produced
 * by a mis-aimed double-click, which is the failure this guards against. The
 * rule is stated here rather than in the dialog so the test can pin it.
 */
export function confirmCopy(
  action: TriageAction,
  d: Destructiveness,
): ConfirmCopy {
  const lines: string[] = [];

  if (d.tier1 > 0) {
    lines.push(
      `${plural(d.tier1, "item")} will change status. The row survives, but there is no ` +
        `un-${action} tool — reversing this means hand-editing the brain.`,
    );
  }
  if (d.tier2 > 0) {
    lines.push(
      `${plural(d.tier2, "item")} will be SOFT-deleted (recurring patterns): the row stays in ` +
        `the brain with a deleted_at stamp and is recoverable.`,
    );
  }

  // Tier 3 is ALWAYS its own sentence, and always last. This is the plan's
  // explicit requirement and it is the reason `lines` is an array rather than
  // one interpolated paragraph.
  const hardDeleteLine =
    d.tier3 > 0
      ? `${plural(d.tier3, "item")} will be PERMANENTLY DELETED. This cannot be undone.` +
        (d.unknownTier3 > 0
          ? ` (${d.unknownTier3} of those could not be checked for recurrence, so they are ` +
            `counted as permanent.)`
          : "")
      : null;
  if (hardDeleteLine !== null) lines.push(hardDeleteLine);

  if (lines.length === 0) {
    lines.push("Nothing is selected. This action would do nothing.");
  }

  return {
    title: `${ACTION_VERB[action]} ${plural(d.total, "item")}?`,
    lines,
    hardDeleteLine,
    requireTyped: d.tier3 > 0 && d.total > 1 ? String(d.tier3) : null,
    confirmLabel:
      d.tier3 > 0
        ? `DELETE ${d.tier3} PERMANENTLY`
        : `${ACTION_VERB[action].toUpperCase()} ${d.total}`,
  };
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/** Mirrors `cli/src/types.ts#TriageRequest`. */
export interface TriageRequestBody {
  action: string;
  ids: number[];
  reason?: string;
  brief_id?: string;
}

/**
 * Build one request body.
 *
 * Only the keys the server's `parseTriageBody` accepts, and only when they have
 * a value: it refuses an unknown top-level field outright (the TD-128 posture
 * one layer out), so a client that sent `reason: undefined` through
 * `JSON.stringify` would be fine, but one that sent `reason: ""` on an `acted`
 * would get a 400 it did not deserve. An EMPTY string is therefore treated as
 * "not supplied" — the operator left the box blank.
 */
export function buildTriageRequest(
  action: TriageAction,
  ids: readonly number[],
  extra: { reason?: string; briefId?: string } = {},
): TriageRequestBody {
  const body: TriageRequestBody = { action, ids: [...ids] };
  const reason = extra.reason?.trim();
  const briefId = extra.briefId?.trim();
  if (action === "dismiss" || action === "reject") {
    if (reason !== undefined && reason.length > 0) body.reason = reason;
  }
  if (action === "acted") {
    if (briefId !== undefined && briefId.length > 0) body.brief_id = briefId;
  }
  return body;
}

/**
 * Is a reason REQUIRED for this action?
 *
 * `dismiss` only. The reason feeds `dismissed_patterns`, which feeds the
 * suppression loop — the mechanism that stops the backlog re-growing. A blind
 * bulk clear throws that signal away and guarantees a fourth 407-item queue, so
 * the UI makes the field prominent rather than optional-looking. It is a UI
 * requirement, not a server one: the brain accepts a reason-less dismiss.
 */
export function reasonRequired(action: TriageAction): boolean {
  return action === "dismiss";
}

// ---------------------------------------------------------------------------
// Result merging
// ---------------------------------------------------------------------------

/** Mirrors `cli/src/types.ts#TriageItemResultPayload`. */
export interface TriageItemOutcome {
  id: number;
  ok: boolean;
  error: string | null;
}

/** One request's response, narrowed to what the merge needs. */
export interface TriageResponseLike {
  applied: number;
  failed: number;
  results: TriageItemOutcome[];
  params: string[];
  degraded: { reason: string } | null;
}

export interface TriageSummary {
  applied: number;
  failed: number;
  /** Every failed id with the BRAIN's own message. Never re-worded. */
  failures: TriageItemOutcome[];
  params: string[];
  /** The first degraded reason across the chunks, or `null`. */
  degraded: string | null;
  requested: number;
}

/**
 * Merge the responses of a chunked bulk into one summary.
 *
 * `requested` is the CALLER's count, not the sum of the responses: a chunk that
 * came back degraded reports `applied: 0` and no results, and summing responses
 * would quietly shrink the denominator so "0 of 0 applied" looked like success.
 */
export function mergeResults(
  requested: number,
  responses: readonly TriageResponseLike[],
): TriageSummary {
  let applied = 0;
  let failed = 0;
  const failures: TriageItemOutcome[] = [];
  const params: string[] = [];
  let degraded: string | null = null;

  for (const r of responses) {
    applied += r.applied;
    failed += r.failed;
    for (const item of r.results) if (!item.ok) failures.push(item);
    for (const p of r.params) if (!params.includes(p)) params.push(p);
    if (degraded === null && r.degraded !== null) degraded = r.degraded.reason;
  }

  return { applied, failed, failures, params, degraded, requested };
}

/** The one-line readout under the bulk bar after an apply. */
export function summaryLine(action: TriageAction, s: TriageSummary): string {
  const head = `${action.toUpperCase()} — ${s.applied} of ${s.requested} applied`;
  const tail = s.failed > 0 ? `, ${s.failed} failed` : "";
  const deg = s.degraded !== null ? ` · ${s.degraded}` : "";
  return `${head}${tail}${deg}`;
}
