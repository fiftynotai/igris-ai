/**
 * FR-245 — the board's state machine: **one summary read for the column SET,
 * then one list read per column.**
 *
 * ─────────────────────────────────────────────────────────────────────────
 * D1 — TWO EXISTING ENDPOINTS, AND FR-245 ADDED NONE
 *
 * (The heading used to read "no seventeenth", which was true of the endpoint
 * count as FR-245 left it. FR-246 then added `/api/briefs/search` and FR-248
 * added `/api/search`, so the ORDINAL has been wrong twice. This file now
 * carries no count at all: a historical note that quotes a live number goes
 * stale on every endpoint after it, and it was never the claim. The claim was
 * always that the BOARD composes endpoints that already exist — and that is
 * unchanged, and cannot go stale.)
 * ─────────────────────────────────────────────────────────────────────────
 * `/api/summary` already returns `briefs.by_status`: a complete
 * `GROUP BY status` over the same project scope the board uses. That IS the
 * derived column set, exact and complete, with zero server work — so the board
 * adds no endpoint, no payload, no brain reader, no `params.ts` vocabulary and
 * no smoke-probe path. A `/api/briefs/board` would have been endpoint #17 and
 * would have swept two MAINTAINING rows, the bats exact-set assertion, the
 * shared types, the browser mirror and the docs, plus a new reader vendored
 * into the packed brain bundle — all for an ARRANGEMENT of rows the client can
 * already ask for.
 *
 * **THE COUNT HAS ONE SOURCE.** Every column's `total` is the `total` from THAT
 * column's own `/api/briefs` response. `/api/summary` supplies the SET and
 * never a number: a summary count is blind to the priority/effort/type filters
 * and would disagree with the cards under it, and one number with two sources
 * is precisely the drift this tier keeps being bitten by. `scopeTotal` below is
 * the summary's `briefs.total` and is used for ONE thing — stating whether the
 * columns account for the whole scope (AC-2) — never as a column count.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * D5 — THE BOARD DOES NOT FOLLOW `live.tick`
 * ─────────────────────────────────────────────────────────────────────────
 * The list refetches on the shell's 5-second beat. A board doing the same is
 * 1 + N requests every five seconds forever, each opening and closing a brain
 * handle. So the board reads ONCE per `(project, filter values)` tuple, stamps
 * `AS OF <generated_at>` and offers an explicit REFRESH — the shape
 * `RecordDetail` and `pages/Graph.tsx` already ship, for the same reason.
 *
 * The honest trade, and it is stated in the UI rather than only here: the board
 * is LESS LIVE than the list. An operator opening a board wants the shape of
 * the backlog, not a heartbeat, and the stamp says how old the shape is.
 *
 * A generation counter plus one `AbortController` per batch: N in-flight column
 * reads mean N chances for a stale response to land after a fresher batch
 * started, and a board that painted one column from the previous filter would
 * be wrong in the least visible way possible.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type BriefListRow } from "../lib/api";
import {
  boardQuery,
  columnLabel,
  deriveStatusColumns,
  type ColumnLabel,
} from "./board";
import type { FilterValues } from "./model";

export interface BoardColumnState {
  /** The RAW status. Identity, query value, and `data-status` on the column. */
  status: string;
  label: ColumnLabel;
  /** Rows with this status in scope per `/api/summary`, ignoring other filters. */
  seen: number;
  loading: boolean;
  /** At most `CARD_CAP` of them — the head of this column's own page. */
  rows: readonly BriefListRow[];
  /** Rows under the ACTIVE filters, before the cap. THIS column's own answer. */
  total: number;
  /** A transport failure reading this column. The others still render. */
  error: string | null;
  /** The endpoint's own `degraded.reason` for this column, verbatim. */
  degraded: string | null;
}

export interface BoardState {
  columns: readonly BoardColumnState[];
  /**
   * Every status in scope IGNORING the status filter — the chip vocabulary.
   *
   * Derived separately on purpose: the columns narrow to one when a status is
   * selected, and a chip strip built from the narrowed set would leave the
   * operator with a single chip and no way back except CLEAR FILTERS.
   */
  allStatuses: readonly string[];
  /** The first summary read is in flight and there is nothing to show yet. */
  loading: boolean;
  /** A TRANSPORT failure on the summary read. Not `degraded`. */
  error: string | null;
  /** The summary's own `degraded.reason`, verbatim. */
  degraded: string | null;
  /** `/api/summary`'s `briefs.total` for this scope. The AC-2 comparison. */
  scopeTotal: number | null;
  /** The summary's `generated_at` — what the AS OF stamp reports. */
  generatedAt: string | null;
  refresh: () => void;
}

interface Snapshot {
  columns: BoardColumnState[];
  allStatuses: string[];
  busy: boolean;
  error: string | null;
  degraded: string | null;
  scopeTotal: number | null;
  generatedAt: string | null;
}

const EMPTY: Snapshot = {
  columns: [],
  allStatuses: [],
  busy: true,
  error: null,
  degraded: null,
  scopeTotal: null,
  generatedAt: null,
};

const reason = (err: unknown): string =>
  err instanceof ApiError ? err.message : String(err);

export function useBoardColumns(input: {
  project: string | null;
  values: FilterValues;
}): BoardState {
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [nonce, setNonce] = useState(0);
  const generation = useRef(0);

  const { project } = input;
  const statusFilter = input.values.status ?? "";
  // A stable, order-independent key, so the effect fires when a VALUE changes
  // rather than when the caller's object identity does (`useLayerList`'s rule).
  const valueKey = Object.keys(input.values)
    .sort()
    .map((k) => `${k}=${input.values[k] ?? ""}`)
    .join("&");

  // Read inside the effect, never a dependency: the values are already covered
  // by `valueKey` and depending on the object would refetch on every render.
  const valuesRef = useRef(input.values);
  valuesRef.current = input.values;

  useEffect(() => {
    const ctrl = new AbortController();
    const mine = ++generation.current;
    /** Still the current batch, and not aborted. Checked before every write. */
    const live = (): boolean => generation.current === mine && !ctrl.signal.aborted;

    setSnap((cur) => ({ ...cur, busy: true, error: null }));

    api
      .summary(project, ctrl.signal)
      .then((summary) => {
        if (!live()) return;
        const byStatus = summary.briefs.by_status;
        const derived = deriveStatusColumns({ byStatus, statusFilter });
        const columns: BoardColumnState[] = derived.map((c) => ({
          status: c.status,
          label: columnLabel(c.status),
          seen: c.seen,
          loading: true,
          rows: [],
          total: 0,
          error: null,
          degraded: null,
        }));
        setSnap({
          columns,
          allStatuses: deriveStatusColumns({ byStatus }).map((c) => c.status),
          busy: false,
          error: null,
          degraded: summary.degraded?.reason ?? null,
          scopeTotal: summary.briefs.total,
          generatedAt: summary.generated_at,
        });

        // A DEGRADED summary means the column set is not trustworthy, so no
        // column read is issued at all — D9: the board shows the degraded state
        // with the reason verbatim and does NOT fall back to rendering the six
        // known statuses. A hand-listed column set is exactly what this brief
        // forbids, and a fallback is that failure wearing a disguise.
        if (summary.degraded != null) return;

        for (const col of columns) {
          const q = boardQuery({
            project,
            values: valuesRef.current,
            status: col.status,
          });
          api
            .briefs(q, ctrl.signal)
            .then((payload) => {
              if (!live()) return;
              patch(setSnap, col.status, {
                loading: false,
                rows: payload.items,
                total: payload.total,
                degraded: payload.degraded?.reason ?? null,
                error: null,
              });
            })
            .catch((err: unknown) => {
              if (!live()) return;
              // One column failing is not the board failing. It says so in its
              // own header and the other columns keep their counts.
              patch(setSnap, col.status, { loading: false, error: reason(err) });
            });
        }
      })
      .catch((err: unknown) => {
        if (!live()) return;
        setSnap({ ...EMPTY, busy: false, error: reason(err) });
      });

    return () => ctrl.abort();
    // `input.values` is covered by `valueKey`; the fetchers are `api`'s, which
    // are module-level and stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, valueKey, statusFilter, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return {
    columns: snap.columns,
    allStatuses: snap.allStatuses,
    // Only "loading" while there is nothing on screen: a REFRESH must not blank
    // a board the operator is reading.
    loading: snap.busy && snap.columns.length === 0,
    error: snap.error,
    degraded: snap.degraded,
    scopeTotal: snap.scopeTotal,
    generatedAt: snap.generatedAt,
    refresh,
  };
}

/** Merge one column's outcome into the snapshot, leaving the others alone. */
function patch(
  setSnap: React.Dispatch<React.SetStateAction<Snapshot>>,
  status: string,
  next: Partial<BoardColumnState>,
): void {
  setSnap((cur) => ({
    ...cur,
    columns: cur.columns.map((c) => (c.status === status ? { ...c, ...next } : c)),
  }));
}
