/**
 * FR-245 — **every decision the briefs BOARD makes that is worth asserting.**
 * PURE: no React, no DOM, no fetch, no clock.
 *
 * The board is a second ARRANGEMENT of the briefs layer, not a second layer:
 * the same rows, partitioned by `brief_status.status` into columns. Everything
 * a reviewer could get wrong about that partition — which columns exist, in
 * what order, what each column asks the endpoint for, how a 75-character status
 * becomes a header — lives here rather than in a `.tsx`, for the reason
 * `layers/model.ts` states in its own header: a table and a few pure functions
 * can be asserted by the node vitest env with no browser.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS FILE FOLDS NOTHING. THAT IS THE DESIGN, NOT A DEFECT.
 * ─────────────────────────────────────────────────────────────────────────
 * `brief_status.status` has NO CHECK constraint (see `params.ts`'s filter
 * vocabularies, which are `null` for exactly this reason). When this board was
 * built the operator's brain held FIFTEEN distinct values including three
 * spellings of "finished" (`Done` 1195 / `Completed` 24 / `Complete` 1), two of
 * in-flight (`In Progress` 26 / `InProgress` 4), one with a commit hash welded
 * into it, and two that are whole sentences. (Counts read READ-ONLY on
 * 2026-08-02 and reproduced in `__tests__/board.test.ts`'s fixture; they are
 * illustrative of the SHAPE, not a contract — nothing here reads them.)
 *
 * **TD-333 HAS SINCE SHIPPED, and it resolved the vocabulary this docstring was
 * waiting on** — `normalizeStatus` / `CANONICAL_STATUSES` in
 * `brain-mcp-server/src/tools/brief-normalize.ts`, a fold at every write
 * boundary and at both sync-ingress doors, and schema v25 folding the 29
 * historical rows. **The census above is now HISTORICAL.** After v25 the three
 * folded spellings are gone from a migrated brain; `Cancelled` / `Superseded` /
 * `Deferred` remain deliberately non-canonical (they are MISSING STATES, not
 * spellings — see that file's exclusion list), and so do the welded-payload row
 * and the two sentences, which are hand-migrated rather than folded.
 *
 * **NONE OF THAT CHANGES ONE LINE OF CODE HERE, and that is the point.** The
 * board renders EVERY value as its own column, with its own count, from its own
 * query. It does not merge `Done` with `Completed`, because merging is
 * arithmetic over values the system does not know are the same — and the moment
 * the UI performs that arithmetic, the operator's read of their own backlog is
 * silently rewritten and the data defect becomes invisible. TD-333 fixed the
 * STORE; the UI's job is still to be honest about whatever the store holds,
 * including whatever the next un-normalised writer puts there.
 * `layers/__tests__/board.test.ts` B6 pins THREE separate columns so a future
 * "helpful" merge fails a test rather than shipping. **Do not delete that pin
 * on the grounds that the data is now clean** — the fold-nothing design is what
 * makes the NEXT drift visible.
 *
 * The one concession is ORDER (D7): spellings that normalise to the same string
 * sort into the same lifecycle slot, so `InProgress` sits beside `In Progress`
 * instead of scattering across the strip. Ordering touches neither the rows nor
 * the queries. Synonyms — `Completed`, `Complete`, `Done(Resolvedbydec8d1f)` —
 * are NOT normalised-equal to anything, so they land in the tail. Recognising
 * them would need a synonym table, and a synonym table is one keystroke from a
 * fold. (`STATUS_ALIASES` is now exactly that table, one package away, and it is
 * deliberately NOT imported here: a display layer that folds is a display layer
 * that can hide a store defect.)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHERE THE COLUMN SET COMES FROM: DATA UNION VOCABULARY (D1)
 * ─────────────────────────────────────────────────────────────────────────
 * `deriveStatusColumns` unions the statuses PRESENT in the scope (the
 * `briefs.by_status` map `/api/summary` already returns — a complete
 * `GROUP BY status`, so no status can be missed) with the documented lifecycle
 * vocabulary below. Neither alone is right: the data alone loses `In Progress`
 * on a project with nothing in flight, and the vocabulary alone hides
 * `Superseded`, `Deferred` and `Cancelled`, which exist in the brain and are
 * NOT in the documented set.
 */

import { FILTERS, listQuery, type FilterValues } from "./model";

/**
 * The documented brief lifecycle.
 *
 * SOURCE, and there is exactly one: `docs/architecture/brief-state-source-of-truth.md`
 * line 13, the `brief_status.status` row of its authority table. Mirroring it
 * here makes this file a consumer of MAINTAINING row 95 (`brief_status.status`,
 * the canonical build-state source — this citation said "row 94" until TD-333
 * checked it and found the row had been pushed down by an insertion above it,
 * which is exactly why that table is APPENDED to and never inserted into) — a vocabulary change sweeps this constant
 * in the same commit. **TD-333 verified this set and did NOT change it**: the
 * canonical six are unchanged, and `CANONICAL_STATUSES` in
 * `brain-mcp-server/src/tools/brief-normalize.ts` is element-identical to this
 * array, in the same order. It is a DISPLAY vocabulary, exactly as `params.ts`'s
 * filter specs are: it decides which columns appear when the data is silent,
 * and it never filters a row out.
 */
export const KNOWN_BRIEF_STATUSES = [
  "Draft",
  "Ready",
  "In Progress",
  "Blocked",
  "Done",
  "Archived",
] as const;

/**
 * Cards rendered per column, uniformly.
 *
 * D2. `Done` is 75% of the corpus, and the two rejected answers were "collapse
 * `Done` by default" and "just order it last". Collapsing special-cases one
 * VALUE of an open vocabulary, which is the same class of error as a
 * hand-listed column set one layer down: the day `Archived` reaches 500 it
 * needs the same treatment and nothing tells you. A uniform cap is a rule about
 * COLUMNS — the header reads `12 OF 493` and the column hands you to the list,
 * which is the surface for 493 rows.
 */
export const CARD_CAP = 12;

/** Header characters before truncation. See `columnLabel`. */
export const LABEL_MAX = 22;

/**
 * Above this many columns the board STATES the count in a banner.
 *
 * Information, never a cap. A cap is hiding, and hiding is the one thing this
 * arrangement must not do.
 */
export const MANY_COLUMNS = 20;

/** One derived column, before any data is fetched for it. */
export interface StatusColumn {
  /** The RAW status value. This is what reaches the query, always. */
  status: string;
  /** Lifecycle index, or `null` for a value outside the documented set. */
  rank: number | null;
  /** The normalised form. Two columns sharing one are spellings, not synonyms. */
  family: string;
  /** Rows with this status in scope, per `/api/summary`. `0` for a vocabulary-only column. */
  seen: number;
}

/**
 * Lowercase, and drop everything that is not a letter or a digit.
 *
 * FOR SORTING ONLY. It never reaches a query, never merges two columns and
 * never changes a count. `InProgress` and `In Progress` both normalise to
 * `inprogress`, which is what puts them side by side.
 */
export function normaliseForOrder(status: string): string {
  return status.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const RANK_BY_FAMILY = new Map<string, number>(
  KNOWN_BRIEF_STATUSES.map((s, i) => [normaliseForOrder(s), i]),
);

/**
 * The lifecycle rank of a status, or `null`.
 *
 * An unknown status inherits the rank of the known status whose normalised form
 * it EXACTLY equals — nothing looser. `Completed` does not become `Done` here;
 * it normalises to `completed`, matches nothing, and ranks `null`.
 */
export function statusRank(status: string): number | null {
  return RANK_BY_FAMILY.get(normaliseForOrder(status)) ?? null;
}

/**
 * The ordered column set for a scope.
 *
 * `byStatus` is `/api/summary`'s `briefs.by_status` — a complete `GROUP BY
 * status` over the same scope, so its key set is a SUPERSET of the statuses of
 * any filtered subset within that scope. There is no status the board can miss.
 *
 * `statusFilter` (D6) INTERSECTS the set rather than being passed through to
 * the per-column query, because the board's axis IS status: a `status=Done`
 * filter and a per-column `status=Ready` query are a contradiction that
 * `URLSearchParams.set` would resolve silently, last write wins.
 */
export function deriveStatusColumns(input: {
  byStatus: Readonly<Record<string, number>> | null | undefined;
  statusFilter?: string;
}): StatusColumn[] {
  const seen = input.byStatus ?? {};
  const raw = new Set<string>(Object.keys(seen).filter((s) => s.length > 0));
  for (const known of KNOWN_BRIEF_STATUSES) raw.add(known);

  const filter = input.statusFilter ?? "";
  if (filter.length > 0) {
    // The intersection of the derived set with one value is that value. Stated
    // as a branch rather than as a `.filter()` so the case where the filter
    // names a status the set does NOT hold — reachable only by a hand-edited
    // request, since the chips are built from this same set — renders that one
    // column showing zero, instead of an empty intersection silently widening
    // back to every column. The operator asked for one status; they get one.
    return [column(filter, seen)];
  }

  return [...raw].map((s) => column(s, seen)).sort(compareColumns);
}

function column(status: string, seen: Readonly<Record<string, number>>): StatusColumn {
  return {
    status,
    rank: statusRank(status),
    family: normaliseForOrder(status),
    seen: seen[status] ?? 0,
  };
}

/**
 * Lifecycle head, then everything else by count descending, then alphabetically.
 *
 * Total and deterministic: the final tie-break is the raw string, so two
 * statuses with the same rank and the same count cannot swap between renders.
 * Within one lifecycle slot the EXACT documented spelling sorts first, so
 * `In Progress` precedes `InProgress` rather than the pair's order depending on
 * which one happens to have more rows.
 */
function compareColumns(a: StatusColumn, b: StatusColumn): number {
  if (a.rank !== b.rank) {
    if (a.rank === null) return 1;
    if (b.rank === null) return -1;
    return a.rank - b.rank;
  }
  if (a.rank !== null) {
    const canonical = KNOWN_BRIEF_STATUSES[a.rank] as string;
    if (a.status === canonical) return -1;
    if (b.status === canonical) return 1;
  }
  if (a.seen !== b.seen) return b.seen - a.seen;
  return a.status < b.status ? -1 : a.status > b.status ? 1 : 0;
}

/** A column header, truncated to fit, with the full value kept beside it. */
export interface ColumnLabel {
  /** What the header renders. At most `LABEL_MAX` characters plus an ellipsis. */
  label: string;
  /** The raw status, byte for byte. Stamped on the column and used as the tooltip. */
  full: string;
  truncated: boolean;
}

/**
 * D3 — a pure truncation, not a CSS ellipsis alone.
 *
 * Two statuses on this brain are 34-66-character sentences and one carries a
 * commit hash, so a raw header breaks a fixed-width column. The CSS backstop
 * (`overflow:hidden; text-overflow:ellipsis`) still ships, but CSS truncation
 * is invisible to node vitest and to a DOM query — so "the header was
 * TRUNCATED, not lost" would be unassertable. Doing it here makes it a table
 * test, and keeps `full` available for `title` and `data-status`.
 */
export function columnLabel(status: string): ColumnLabel {
  if (status.length <= LABEL_MAX) {
    return { label: status, full: status, truncated: false };
  }
  return { label: `${status.slice(0, LABEL_MAX)}…`, full: status, truncated: true };
}

/**
 * One column's request (D6).
 *
 * The user's `status` value is REMOVED from the filter values and the column's
 * own raw status is set instead — one code path, one pure function, one test.
 * Everything else (`project`, `priority`, `effort`, `brief_type`) passes
 * through unchanged, which is how "all existing filters work in board mode" is
 * satisfied for real rather than by assertion.
 *
 * `limit` is `CARD_CAP` because a column shows at most that many cards; the
 * response's `total` is the count under the same filters BEFORE pagination,
 * which is exactly the number the header prints. That is why the count comes
 * from this response and never from `/api/summary`: a summary count is blind to
 * the priority/effort/type filters and would disagree with the cards under it.
 */
export function boardQuery(input: {
  project: string | null;
  values: FilterValues;
  status: string;
  limit?: number;
}): URLSearchParams {
  const rest: Record<string, string> = { ...input.values };
  delete rest.status;
  const q = listQuery({
    layer: "briefs",
    project: input.project,
    values: rest,
    limit: input.limit ?? CARD_CAP,
    offset: 0,
  });
  // AFTER `listQuery`, and with `set` rather than `append`: the raw status is
  // the authority for this column and there can only ever be one of it.
  q.set("status", input.status);
  return q;
}

/**
 * What OPEN IN LIST hands to the list view.
 *
 * NOT an href, and that is D4's reasoning applied one level down. A filter is
 * not an ADDRESS: `pages/Layers.tsx` records the same call for project scope
 * ("sharing a link to briefs should not force the recipient into the sender's
 * project"), and putting a status in the hash would make `layerHash` and
 * `recordHash` carry it or drop it — the one file whose codec BR-078 makes
 * correctness-critical. So the handoff is VALUES, the page applies them as the
 * list's initial filters, and this function is what makes "OPEN IN LIST opens
 * the list filtered to THIS column" assertable without a browser.
 */
export function listHandoffFor(status: string): FilterValues {
  return { status };
}

/** Whether any filter OTHER than `status` is narrowing the board. */
export function hasNonStatusFilters(values: FilterValues): boolean {
  return (FILTERS.briefs ?? []).some((def) => {
    if (def.name === "status") return false;
    const v = values[def.name];
    return v !== undefined && v.length > 0;
  });
}
