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

/**
 * The five TRIAGE-TAB actions — the `target: "id"` rows of
 * `brain-write-bridge.ts#TRIAGE_ACTIONS`. That map has EIGHT rows since FR-249:
 * the two `brief-ref` rows are brief writes and live on the Briefs surface, and
 * the one `target: "none"` row (`create_goal`) has no subject at all, so it
 * belongs to no tab. This mirrors 5 of 8 deliberately, not by omission — see
 * `BRIEF_WRITE_ACTIONS` and `CREATE_ACTIONS` below for the other three.
 */
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

/**
 * Selected keys. A `Set` because membership is the only query the UI makes.
 *
 * FR-247 generalised the key TYPE, not the algebra. A suggestion is an integer
 * id; a brief is the `(project, brief_id)` PAIR, carried as the row key
 * `"<project>|<brief_id>"` the record list already builds. The default type
 * parameter is `number`, so every FR-241 declaration reads unchanged.
 */
export type SelectionKey = string | number;
export type Selection<K extends SelectionKey = number> = ReadonlySet<K>;

export const EMPTY_SELECTION: Selection = new Set<number>();
/** FR-247 — the string-keyed empty set, for brief selections. */
export const EMPTY_KEY_SELECTION: Selection<string> = new Set<string>();

export function toggleSelected<K extends SelectionKey>(
  current: Selection<K>,
  id: K,
): Selection<K> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Select every key given, ADDING to what is already selected.
 *
 * The key-taking form. `selectAll` below is this function over `rows.map(r =>
 * r.id)`, kept because four shipped call sites pass rows.
 */
export function selectAllKeys<K extends SelectionKey>(
  current: Selection<K>,
  keys: readonly K[],
): Selection<K> {
  const next = new Set(current);
  for (const k of keys) next.add(k);
  return next;
}

/** Select every visible row, ADDING to what is already selected. */
export function selectAll(current: Selection, rows: readonly TriageRow[]): Selection {
  return selectAllKeys(
    current,
    rows.map((r) => r.id),
  );
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
  return confineToKeys(
    current,
    rows.map((r) => r.id),
  );
}

/**
 * The key-taking form of {@link confineToVisible}, and it carries the SAME
 * safety property — not a convenience overload.
 *
 * FR-247's briefs list confines on `"<project>|<brief_id>"`, so a selection
 * made on page 1 cannot survive a project change and then be written to by a
 * bulk priority set. That is the case the property was written for, and it is
 * the first time the selection can reach rows in a DIFFERENT project.
 */
export function confineToKeys<K extends SelectionKey>(
  current: Selection<K>,
  keys: readonly K[],
): Selection<K> {
  const visible = new Set<K>(keys);
  const next = new Set<K>();
  for (const k of current) if (visible.has(k)) next.add(k);
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
 *
 * FR-247 made it generic over the item type so it also chunks `refs`. The NAME
 * is kept: renaming it sweeps this file, `useTriage.ts` and two suites for a
 * noun, which is D5's reasoning one level down. It chunks a batch; the batch
 * used to only ever be ids.
 */
export function chunkIds<T>(ids: readonly T[], size: number = MAX_BULK): T[][] {
  if (size < 1) throw new RangeError(`chunk size must be >= 1 (got ${size})`);
  const out: T[][] = [];
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
  id: number | null;
  /** FR-247 — populated instead of `id` for a brief-addressed action. */
  ref?: { project: string; brief_id: string } | null;
  ok: boolean;
  error: string | null;
  /** FR-249 — the id a `create_goal` allocated. `null` for every other row. */
  created_id?: string | null;
}

/**
 * How a failure names its subject: an id, or a brief, or nothing at all.
 *
 * FR-249's create has NO subject — that is the definition of a `target: "none"`
 * row — so `"?"` is the honest label rather than a placeholder for a lookup
 * that failed. The banner that renders it already carries the action name, so
 * "CREATE_GOAL — ? : title exceeds maximum length of 256 characters" reads
 * correctly; inventing a subject here would be the only lie available.
 */
export function outcomeLabel(o: TriageItemOutcome): string {
  if (o.ref !== undefined && o.ref !== null) {
    return `${o.ref.project}/${o.ref.brief_id}`;
  }
  return o.id === null ? "?" : `#${o.id}`;
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
export function summaryLine(action: string, s: TriageSummary): string {
  const head = `${action.toUpperCase()} — ${s.applied} of ${s.requested} applied`;
  const tail = s.failed > 0 ? `, ${s.failed} failed` : "";
  const deg = s.degraded !== null ? ` · ${s.degraded}` : "";
  return `${head}${tail}${deg}`;
}

// ---------------------------------------------------------------------------
// FR-247 — the two BRIEF writes
// ---------------------------------------------------------------------------

/**
 * The brief-addressed actions, mirroring the `target: "brief-ref"` rows of
 * `brain-write-bridge.ts#TRIAGE_ACTIONS`.
 *
 * Deliberately a SEPARATE constant from `TRIAGE_ACTIONS` above rather than two
 * more entries in it: the two lists answer different questions. That one is
 * "what may the triage tabs offer"; this one is "what may a BRIEF row offer",
 * and the surfaces have no overlap. A single list would need every consumer to
 * filter it by target, which is the map's job, not the client's.
 */
export const BRIEF_WRITE_ACTIONS = ["set_priority", "attach_goal"] as const;
export type BriefWriteAction = (typeof BRIEF_WRITE_ACTIONS)[number];

/**
 * FR-249 — the SUBJECTLESS actions, mirroring the `target: "none"` rows.
 *
 * A third list rather than an entry in either above, for the same reason those
 * two are separate: they answer different questions. This one is "what may a
 * mutation with no subject be", and a subjectless action shares no consumer
 * with a selection-driven one — it has no selection to be enabled by, no count
 * to render and no per-item results to attribute.
 *
 * NO DESTRUCTIVENESS TIER, and the absence is a decision. The three tiers exist
 * for DELETES (`confirmCopy`'s subject: the typed confirmation, the hard-delete
 * sentence). A create destroys nothing, cannot be bulk, and its subject does
 * not exist until it succeeds — so routing it through the tier machinery would
 * mean rendering a permanent-deletion warning for the least destructive act on
 * the surface, which is how the real warnings stop being read.
 */
export const CREATE_ACTIONS = ["create_goal"] as const;
export type CreateAction = (typeof CREATE_ACTIONS)[number];

/** Every action this client can post. Used where the families converge. */
export type WriteAction = TriageAction | BriefWriteAction | CreateAction;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PRIORITY VOCABULARY — A MIRROR, AND WHY IT IS A HAND-LIST ON PURPOSE
 * ═══════════════════════════════════════════════════════════════════════════
 * Mirrors `brain-mcp-server/src/tools/brief-normalize.ts:92#CANONICAL_PRIORITIES`,
 * which the Vite chunk cannot import (the brain bundle is not a client
 * dependency). MAINTAINING carries the contract row and names this file as the
 * FIRST out-of-brain consumer of a vocabulary that had exactly one source; the
 * change procedure is: edit the brain source, mirror here, re-run the mirror
 * assertion in `__tests__/model.test.ts`.
 *
 * THIS CONTRADICTS FR-245's "enumerate from the data, not a hand-list" — AND
 * THAT IS THE POINT. That instruction was written for a READ surface (the board
 * columns, the filter options), where enumerating faithfully is exactly right
 * because the UI is REPORTING what the brain holds. A PICKER does not report a
 * vocabulary, it PRESCRIBES one. Enumerating from the data here would offer
 * `P4-Trivial` and a bare `P2` as things an operator can ASSIGN — i.e. the UI
 * would manufacture new instances of the drift TD-338 exists to explain.
 * Measured on the operator brain (Phase-0 P0.2): 5 bare `P2`, 2 bare `P1`, 1
 * `P4-Trivial` out of 1,818 rows.
 *
 * THE NON-CANONICAL VALUES DO NOT VANISH. Three places, all shipped and all
 * untouched by this brief:
 *   1. the list-row badge renders `row.priority` VERBATIM (`Briefs.tsx`), so a
 *      `P4-Trivial` brief still reads `P4-Trivial`;
 *   2. the FILTER's options come from `optionsFromRows` — data-derived — so
 *      `P4-Trivial` stays filterable;
 *   3. `priorityChoices` below renders a non-canonical CURRENT value as a
 *      DISABLED `not offerable` entry, so a selected brief never looks unset
 *      when it is not.
 *
 * STATED CONSEQUENCE, not pursued: `normalizePriority` folds at the handler, so
 * writing ANY value to a bare-`P2` brief also canonicalises it. That is a side
 * effect of a correct write. TD-338 owns the 8 rows and the SYNC path that
 * minted them (an LWW column copy with no normaliser); folding them here
 * without closing that door would just re-run.
 */
export const CANONICAL_PRIORITIES = [
  "P0-Critical",
  "P1-High",
  "P2-Medium",
  "P3-Low",
] as const;
export type CanonicalPriority = (typeof CANONICAL_PRIORITIES)[number];

/**
 * The sentinel the picker uses for "unset it".
 *
 * A distinct token rather than `""`: an empty string is what a CLEARED FILTER
 * emits and every filter path in this app reads it as "no filter", so reusing
 * it here would make "clear this brief's priority" indistinguishable from "do
 * nothing" one refactor from now. `buildBriefWriteRequest` turns it into the
 * empty string ON THE WIRE, which is what `normalizePriority` folds to SQL
 * NULL — the "Unset" family since v18/TD-238.
 */
export const PRIORITY_CLEAR = "__clear__";

/** One entry of the priority picker. */
export interface PriorityChoice {
  value: string;
  label: string;
  /** A non-canonical CURRENT value: shown so it is not lost, never assignable. */
  offerable: boolean;
}

/**
 * The picker's entries for a given current value.
 *
 * `current` is the value the selected brief holds, or `null`. When it is
 * non-canonical and non-null it is prepended as a DISABLED entry — see the
 * vocabulary block above for why it must be visible rather than silently
 * absent. When the selection is mixed (more than one brief, differing values)
 * the caller passes `null` and gets the canonical set plus CLEAR.
 */
export function priorityChoices(current: string | null): PriorityChoice[] {
  const canonical = CANONICAL_PRIORITIES as readonly string[];
  const out: PriorityChoice[] = [];
  if (current !== null && current.length > 0 && !canonical.includes(current)) {
    out.push({ value: current, label: `${current} — not offerable`, offerable: false });
  }
  for (const p of CANONICAL_PRIORITIES) out.push({ value: p, label: p, offerable: true });
  out.push({ value: PRIORITY_CLEAR, label: "CLEAR (unset)", offerable: true });
  return out;
}

/**
 * Build one brief-write request body.
 *
 * Same posture as `buildTriageRequest`: only the keys the server's
 * `parseTriageBody` accepts for this action, and only when they have a value.
 * `refs` and `ids` are MUTUALLY EXCLUSIVE on the wire and the server 400s a
 * body carrying the wrong one, so this never emits `ids`.
 */
export function buildBriefWriteRequest(
  action: BriefWriteAction,
  refs: readonly { project: string; brief_id: string }[],
  extra: { priority?: string; goalId?: string } = {},
): { action: string; refs: { project: string; brief_id: string }[]; priority?: string; goal_id?: string } {
  const body = {
    action,
    refs: refs.map((r) => ({ project: r.project, brief_id: r.brief_id })),
  } as {
    action: string;
    refs: { project: string; brief_id: string }[];
    priority?: string;
    goal_id?: string;
  };
  if (action === "set_priority" && extra.priority !== undefined) {
    // The sentinel becomes the empty string on the wire — `normalizePriority`
    // folds that to SQL NULL. The sentinel itself is never sent: a literal
    // `"__clear__"` reaching the brain would be stored verbatim as a NINTH
    // non-canonical value, which is precisely the drift this file refuses to add to.
    body.priority = extra.priority === PRIORITY_CLEAR ? "" : extra.priority;
  }
  if (action === "attach_goal") {
    const g = extra.goalId?.trim();
    if (g !== undefined && g.length > 0) body.goal_id = g;
  }
  return body;
}

/**
 * Build the `create_goal` request body.
 *
 * `project` is the shell's scope and its ABSENCE is the all-projects scope —
 * the brain stores that as `project_slug NULL`, which the goals layer already
 * renders as "Cross-project". So an empty string is NOT SENT rather than sent
 * as `""`: both reach the same row, but only one of them says what was meant.
 *
 * A blank title or outcome is refused HERE as well as by the button's
 * `disabled`, because a builder that can emit a body the brain will certainly
 * refuse is a builder a future caller can misuse. The brain's own
 * `Missing required fields: title, outcome` remains the message if one ever
 * gets through — this client never invents a validation sentence of its own.
 */
export function buildCreateGoalRequest(
  title: string,
  outcome: string,
  project?: string | null,
): {
  action: string;
  goal_title: string;
  goal_outcome: string;
  goal_project?: string;
} | null {
  const t = title.trim();
  const o = outcome.trim();
  if (t.length === 0 || o.length === 0) return null;
  const p = project?.trim() ?? "";
  return {
    action: "create_goal",
    goal_title: t,
    goal_outcome: o,
    ...(p.length > 0 ? { goal_project: p } : {}),
  };
}

/** The `(project, brief_id)` pair, encoded as the record list's row key. */
export function refKey(ref: { project: string; brief_id: string }): string {
  return `${ref.project}|${ref.brief_id}`;
}

/**
 * The confirmation copy for a brief write.
 *
 * A SEPARATE, much smaller function from `confirmCopy` above, and deliberately
 * so: that one's whole subject is the DELETE tiering (L-140's three tiers, the
 * typed confirmation, the hard-delete sentence). Neither brief write can delete
 * anything — a priority set is a column update on a nullable column and an
 * attach is an idempotent edge insert — so routing them through the tier
 * machinery would mean rendering "there is no un-set_priority tool" in the
 * register reserved for permanent deletion. Warning about a reversible thing in
 * the voice used for an irreversible one is how the irreversible warning stops
 * being read.
 */
export function briefWriteCopy(
  action: BriefWriteAction,
  count: number,
  detail: string,
): { title: string; lines: string[]; confirmLabel: string } {
  const noun = plural(count, "brief");
  const priority = action === "set_priority";
  return {
    title: priority ? `Set priority on ${noun}?` : `Attach ${noun} to ${detail}?`,
    lines: [
      priority
        ? detail === PRIORITY_CLEAR
          ? `${noun}: priority UNSET (NULL).`
          : `${noun}: priority ${detail}.`
        : `${noun}: a serves_goal edge to ${detail}.`,
      // The ONE sentence that has to be here. It states what is NOT touched —
      // the operator is looking at a bulk write on the surface whose sibling
      // action can delete a row permanently, and the difference is the point.
      "Reversible, and nothing else on the brief changes — not status, not phase, not the body.",
    ],
    confirmLabel: priority ? `SET PRIORITY ON ${count}` : `ATTACH ${count}`,
  };
}
