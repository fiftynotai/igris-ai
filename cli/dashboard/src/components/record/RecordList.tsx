/**
 * FR-240 — the ONE list pattern (AC #5). Briefs, learnings, context docs and
 * goals all render through this file.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE AC IS "SHARED COMPONENTS, NOT FOUR BESPOKE LAYOUTS"
 * ─────────────────────────────────────────────────────────────────────────
 * So the shape of a row is DATA (`RecordListRow`), not markup a view writes for
 * itself. Each layer maps its payload rows to that descriptor and hands them
 * over. When a layer wants something the descriptor cannot express, the
 * descriptor grows — the file does not get copied. `badges` and `trail` exist
 * precisely so a layer can add its own vocabulary (a `retrieval` rank, a
 * deadline, an inventory verdict) without a second list.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A ROW IS AN ANCHOR, NOT A CLICK HANDLER
 * ─────────────────────────────────────────────────────────────────────────
 * Rows navigate with `href` to a hash route (`layers/model.ts#recordHash`), so:
 * middle-click opens a second window, the URL is copyable, the browser's own
 * back button works, and the address bar states the `(type, project, id)`
 * triple the operator is reading (D5 / BR-078). A `onClick` router would have
 * none of those properties and would need a keyboard handler to be reachable at
 * all. `onOpen` remains for the one case with no address (an inventory row for
 * a doc that does not exist yet).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * EMPTY IS FOUR STATES, NOT ONE (AC #6)
 * ─────────────────────────────────────────────────────────────────────────
 * The caller passes an `EmptyCopy` chosen by `layers/model.ts#emptyStateFor` —
 * degraded / filtered / empty / no-project. This file renders it and stamps the
 * kind onto the element as `data-empty-kind`, so the browser gate can assert
 * WHICH state is showing rather than merely that something is.
 */

import type { EmptyCopy, PageState } from "../../layers/model";
import { hasNext, hasPrev, nextOffset, pageLabel, prevOffset } from "../../layers/model";
import { EmptyState } from "../ui/EmptyState";
import { FilterBar, type FilterBarProps } from "./FilterBar";

/** One `key: value` line in a row's or a detail's metadata grid. */
export interface RecordMetaItem {
  k: string;
  v: string;
}

export interface RecordListRow {
  /** React key AND the selection identity. Opaque to this component. */
  key: string;
  /** The mono `// …` line above the title. */
  eye: string;
  title: string;
  meta: readonly RecordMetaItem[];
  /** Layer-specific chips/pills. */
  badges?: React.ReactNode;
  /** A second line under the title — a preview, a summary, a reason. */
  trail?: string | null;
  /** Hash route to this record. Preferred over `onOpen`; see the header. */
  href?: string | null;
  /** For a row with no address. Renders a `<button>` instead of an `<a>`. */
  onOpen?: () => void;
  /** Rendered as the current row. */
  active?: boolean;
  /** A row that cannot be opened at all (an inventory row for a missing doc). */
  disabled?: boolean;
  /**
   * FR-241 — the multi-select affordance, for the triage surface.
   *
   * THE DESCRIPTOR GREW; THE FILE WAS NOT COPIED. That is this component's own
   * stated rule (see the header), and it matters more here than anywhere: a
   * forked list for the one page that can DELETE rows would be the one list
   * whose empty states, pagination and row semantics drift from the other four.
   *
   * Rendered as a SIBLING of the row anchor, never inside it: an
   * `<input type=checkbox>` nested in an `<a>` is a control whose click both
   * toggles and navigates, and which keyboard users cannot reach without
   * triggering the link.
   */
  select?: {
    checked: boolean;
    onToggle: () => void;
    /** Announced to a screen reader — the row title is not in the control. */
    label: string;
  };
}

export interface RecordListProps {
  /** `// BRIEFS` — the layer's eye line. */
  eye: string;
  heading: string;
  lede?: string;
  /** Degraded / review-status / retrieval-mode banners. Rendered above the bar. */
  banners?: React.ReactNode;
  filters?: FilterBarProps;
  rows: readonly RecordListRow[];
  /** Absent for a layer with no pagination (the context-doc inventory). */
  page?: PageState & { onOffset: (next: number) => void };
  loading?: boolean;
  /** Which of the four "nothing to show" states this is. */
  empty: EmptyCopy;
  /** Extra content below the rows (the missing-docs block). */
  children?: React.ReactNode;
}

function Row({ row }: { row: RecordListRow }) {
  const body = (
    <>
      <span className="record-row-eye">{row.eye}</span>
      <span className="record-row-title">{row.title}</span>
      {row.trail !== undefined && row.trail !== null && row.trail.length > 0 && (
        <span className="record-row-trail">{row.trail}</span>
      )}
      {row.badges !== undefined && (
        <span className="record-row-badges">{row.badges}</span>
      )}
      <span className="record-row-meta">
        {row.meta.map((m) => (
          <span key={m.k} className="record-row-kv">
            <b>{m.k}</b>
            {m.v}
          </span>
        ))}
      </span>
    </>
  );

  const shared = {
    className: "record-row",
    "data-active": row.active === true ? "true" : undefined,
  } as const;

  const inner =
    row.disabled === true ? (
      <div {...shared} data-disabled="true">
        {body}
      </div>
    ) : row.href !== undefined && row.href !== null ? (
      <a {...shared} href={row.href} data-cursor="hover">
        {body}
      </a>
    ) : (
      <button {...shared} type="button" onClick={row.onOpen}>
        {body}
      </button>
    );

  if (row.select === undefined) return <li>{inner}</li>;

  return (
    <li className="record-li-select">
      <input
        type="checkbox"
        className="record-select"
        checked={row.select.checked}
        onChange={row.select.onToggle}
        aria-label={row.select.label}
        // Selection identity is the row key, exposed so the browser gate can
        // assert WHICH rows are selected rather than merely how many.
        data-select-key={row.key}
      />
      {inner}
    </li>
  );
}

export function RecordList({
  eye,
  heading,
  lede,
  banners,
  filters,
  rows,
  page,
  loading,
  empty,
  children,
}: RecordListProps) {
  return (
    <>
      <span className="shell-eye">{eye}</span>
      <h1 className="shell-h1 glitch">{heading}</h1>
      {lede !== undefined && <p className="shell-lede">{lede}</p>}

      {banners}

      {filters !== undefined && <FilterBar {...filters} />}

      {rows.length === 0 ? (
        loading === true ? (
          // A skeleton rather than an empty state while the first read is in
          // flight: showing "nothing here yet" for 40 ms and then a list is a
          // flicker that reads as a bug.
          <div aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="shell-skel"
                style={{ width: `${92 - i * 11}%` }}
              />
            ))}
          </div>
        ) : (
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
        )
      ) : (
        <ul className="record-list">
          {rows.map((row) => (
            <Row key={row.key} row={row} />
          ))}
        </ul>
      )}

      {children}

      {page !== undefined && rows.length > 0 && (
        <div className="record-page">
          <button
            type="button"
            className="record-page-btn"
            disabled={!hasPrev(page)}
            onClick={() => page.onOffset(prevOffset(page))}
          >
            ← PREV
          </button>
          <span className="record-readout">{pageLabel(page)}</span>
          <button
            type="button"
            className="record-page-btn"
            disabled={!hasNext(page)}
            onClick={() => page.onOffset(nextOffset(page))}
          >
            NEXT →
          </button>
        </div>
      )}
    </>
  );
}
