/**
 * FR-245 — the briefs BOARD: the same rows as the list, arranged in columns.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * D8 — THIS FILE RENDERS NO ROW MARKUP OF ITS OWN
 * ─────────────────────────────────────────────────────────────────────────
 * `architecture_map.md`'s Client Record Tier rule 2 is the governing text: *"a
 * row is DATA (`RecordListRow`), not markup a view writes for itself."* A board
 * that wrote its own card markup would violate the one thing this tier forbids,
 * so it composes `RecordRow` — the same function `RecordList` calls, exported
 * for this consumer — and `record.test.tsx` asserts the two emit identical row
 * markup for the same descriptor.
 *
 * What this file DOES own is the arrangement: a horizontally scrolling strip of
 * fixed-width columns, each a header over a capped stack of rows. That is why
 * it is a SIBLING of `RecordList` rather than a `layout="board"` prop on it —
 * the prop would put per-column fetch state, column headers and a scroll region
 * inside a component whose header says it renders one list, which is the fork
 * wearing `RecordList`'s name.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * READ-ONLY, AND MEASURABLY SO (AC-6)
 * ─────────────────────────────────────────────────────────────────────────
 * There is no drag affordance here and there never will be: `brief_status.status`
 * is the CANONICAL build-state source (MAINTAINING row 94), and TD-311 forbids
 * resolving a state contradiction by editing brief data. A board that let you
 * drag a card from `Blocked` to `Done` would be a write path into the one
 * column the whole build state is read from, dressed as a convenience.
 *
 * "This page issues no writes" is trivially true of a page with no write code,
 * so the claim is not left to a scan alone: `dashboard-layers-source.test.ts`
 * greps the drag VOCABULARY over these files with a planted positive control,
 * and `G-BR-12f` drives real CDP mouse drags at a card and reads an in-page
 * counter that also reports `GET > 0`, so the zero is a measurement rather than
 * a dead counter. Both have mutations that make them go red.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE LAYOUT GRAMMAR THIS BLOCK INTRODUCES (for `design_system.md`)
 * ─────────────────────────────────────────────────────────────────────────
 * Fixed-width columns (they scroll, they never compress), hairline separators,
 * zero radius, token-only colour, a mono header carrying `n OF total`, and a
 * pure truncation rule at 22 characters. The CSS block in `styles/base.css`
 * states it too; `/ground design_system` is TD-335 and will lift it.
 */

import type { EmptyCopy } from "../../layers/model";
import { EmptyState } from "../ui/EmptyState";
import { FilterBar, type FilterBarProps } from "./FilterBar";
import { RecordHeading, RecordRow, type RecordListRow } from "./RecordList";

export interface RecordBoardColumn {
  /** The RAW status value — stamped on the column, never abbreviated. */
  status: string;
  /** `columnLabel(status)` — the truncated header plus the full string. */
  label: { label: string; full: string; truncated: boolean };
  rows: readonly RecordListRow[];
  /** Rows under the active filters BEFORE the card cap. This column's own count. */
  total: number;
  loading: boolean;
  /** A transport failure for THIS column. The rest of the board still renders. */
  error?: string | null;
  /** The endpoint's own degraded reason for this column, verbatim. */
  degraded?: string | null;
}

export interface RecordBoardProps {
  eye: string;
  heading: string;
  lede?: string;
  /** The view toggle. Same slot, same control, as the list's. */
  actions?: React.ReactNode;
  banners?: React.ReactNode;
  filters?: FilterBarProps;
  columns: readonly RecordBoardColumn[];
  /** Cards per column. Rendered in the header as `n OF total`. */
  cardCap: number;
  /** The summary's `generated_at`. The board does not follow the beat (D5). */
  asOf: string | null;
  onRefresh: () => void;
  /** Switch to the list, filtered to this column's status. */
  onOpenInList: (status: string) => void;
  /** Rows the whole scope holds, per `/api/summary`. AC-2's right-hand side. */
  scopeTotal: number | null;
  /** True when a filter other than `status` is narrowing the columns. */
  filtered: boolean;
  loading?: boolean;
  /** Rendered INSTEAD of the columns — degraded, filtered, empty, no-project. */
  empty?: EmptyCopy;
  /** One line under the strip: the TD-333 note, the many-columns count. */
  note?: React.ReactNode;
}

export function RecordBoard({
  eye,
  heading,
  lede,
  actions,
  banners,
  filters,
  columns,
  cardCap,
  asOf,
  onRefresh,
  onOpenInList,
  scopeTotal,
  filtered,
  loading,
  empty,
  note,
}: RecordBoardProps) {
  // Every column's own answer, added up. The single-source rule holds: this is
  // a sum over the per-column `/api/briefs` totals and never over the summary.
  const columnSum = columns.reduce((n, c) => n + c.total, 0);
  const anyLoading = columns.some((c) => c.loading);

  return (
    <>
      <span className="shell-eye">{eye}</span>
      <RecordHeading heading={heading} actions={actions} />
      {lede !== undefined && <p className="shell-lede">{lede}</p>}

      {banners}

      {filters !== undefined && <FilterBar {...filters} />}

      <div className="record-board-meta">
        {/*
          The staleness, stated in the UI rather than only in the plan. The
          board reads once per scope and filter set, so an operator who leaves
          it open is looking at a picture with a timestamp — the same contract
          `RecordDetail` carries for the same reason.
        */}
        <span className="record-readout">
          {asOf === null ? "AS OF —" : `AS OF ${asOf}`}
        </span>
        <span
          className="record-readout"
          data-column-sum={String(columnSum)}
          data-scope-total={scopeTotal === null ? "" : String(scopeTotal)}
        >
          {anyLoading
            ? `${columns.length} ${columns.length === 1 ? "COLUMN" : "COLUMNS"} · READING`
            : filtered || scopeTotal === null
              ? `${columns.length} ${columns.length === 1 ? "COLUMN" : "COLUMNS"} · ${columnSum} BRIEFS`
              : `${columns.length} ${columns.length === 1 ? "COLUMN" : "COLUMNS"} · ${columnSum} OF ${scopeTotal} BRIEFS`}
        </span>
        <button type="button" className="record-filter-run" onClick={onRefresh}>
          REFRESH
        </button>
      </div>

      {empty !== undefined ? (
        <EmptyState
          data-empty-kind={empty.kind}
          meta={empty.meta}
          headline={
            <>
              <em>{empty.headline}</em>
            </>
          }
          message={empty.message}
        />
      ) : loading === true ? (
        // The same skeleton the list shows, for the same reason: a flash of
        // "nothing here yet" followed by a board reads as a bug.
        <div aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="shell-skel" style={{ width: `${92 - i * 11}%` }} />
          ))}
        </div>
      ) : (
        <div className="record-board">
          {columns.map((col) => (
            <Column
              key={col.status}
              col={col}
              cardCap={cardCap}
              onOpenInList={onOpenInList}
            />
          ))}
        </div>
      )}

      {note !== undefined && <p className="record-board-note">{note}</p>}
    </>
  );
}

function Column({
  col,
  cardCap,
  onOpenInList,
}: {
  col: RecordBoardColumn;
  cardCap: number;
  onOpenInList: (status: string) => void;
}) {
  // The cap is enforced HERE as well as in the query window, so it is a
  // property of the arrangement rather than of one caller's `limit`.
  const cards = col.rows.slice(0, cardCap);
  const shown = cards.length;
  const more = col.total > shown;

  return (
    <section
      className="record-board-col"
      /*
        THE FULL RAW VALUE, ALWAYS — never the truncated label. This is what the
        browser gate and the source suite read to assert the exact status is
        present and no brief has been silently relabelled, and it is the reason
        the truncation is a pure function rather than a CSS ellipsis alone.
      */
      data-status={col.label.full}
      data-total={String(col.total)}
    >
      <header className="record-board-head">
        <span className="record-board-label" title={col.label.full}>
          {col.label.label}
        </span>
        <span className="record-board-count">
          {col.loading
            ? "READING"
            : col.total === shown
              ? String(col.total)
              : `${shown} OF ${col.total}`}
        </span>
      </header>

      {col.error != null && (
        <p className="record-board-err">READ FAILED — {col.error}</p>
      )}
      {col.degraded != null && (
        <p className="record-board-err">DEGRADED — {col.degraded}</p>
      )}

      {/*
        A column with zero rows still RENDERS, showing 0. It is not an empty
        state: it is the information that this filter empties this column, and
        it is what keeps the column set stable while an operator clicks filter
        chips instead of columns appearing and vanishing under the cursor.
      */}
      <ul className="record-list record-board-cards">
        {cards.map((row) => (
          <RecordRow key={row.key} row={row} />
        ))}
      </ul>

      {/*
        D2's other half, and the reachability claim's mechanism. The cap is
        uniform across columns, so `Done` at 75% of the corpus becomes a NUMBER
        IN A HEADER rather than a wall of cards — and EVERY non-empty column
        hands the operator to the surface that is for 493 rows, which is what
        makes "every brief is reachable in at most two clicks" true rather than
        true-for-the-short-columns. A filter is not an address, so this is a
        button rather than an anchor: see `board.ts#listHandoffFor`.
      */}
      {col.total > 0 && (
        <button
          type="button"
          className="record-board-more"
          data-open-in-list={col.label.full}
          onClick={() => onOpenInList(col.status)}
        >
          {more ? `+${col.total - shown} MORE — OPEN IN LIST →` : "OPEN IN LIST →"}
        </button>
      )}
    </section>
  );
}
