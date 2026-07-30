/**
 * FR-240 — the ONE detail pattern (AC #5): header, metadata grid, body slot,
 * neighbours slot, and the two navigation actions.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * "LOCATE IN GRAPH" IS THE SECOND HALF OF AC #3
 * ─────────────────────────────────────────────────────────────────────────
 * The first half is `NodeInspector`'s OPEN RECORD. This is the return trip, and
 * it is an `<a href="#/graph?focus=…">` carrying the same
 * `(type, project, id)` triple — the graph page finds the node by MATCHING
 * FIELDS (`layers/model.ts#findNode`) and selects it. No composite key is ever
 * constructed browser-side (D5).
 *
 * When a record has no graph node — a context doc, which is a FILE on disk (D8)
 * — `locateHref` is null and this renders an explicit NOT IN THE GRAPH note.
 * That absence is a fact about the data model; a missing button would read as a
 * bug, and a dead button would be worse.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE `AS OF` STAMP IS NOT DECORATION
 * ─────────────────────────────────────────────────────────────────────────
 * List views follow the shell's `live.tick` beat. A DETAIL does not: it is
 * fetched once per address, because a 5-second refetch of a brief body means
 * re-parsing and re-rendering a whole markdown document forever, on a lens whose
 * AC #5 sibling is "no idling render loop". `Graph.tsx` made the same call for
 * the same reason and carried its staleness in the query twin's AS OF line. So
 * does this — same precedent, same visible cost.
 *
 * READ-ONLY (AC #7): there is no control in this file that can write. The
 * checkboxes inside a rendered markdown body are `disabled` for the same reason
 * (`Markdown.tsx`).
 */

import type { RecordMetaItem } from "./RecordList";

export interface RecordDetailProps {
  /** `// BR-001 · PATTERN` */
  eye: string;
  title: string;
  badges?: React.ReactNode;
  meta: readonly RecordMetaItem[];
  /** Degraded / truncated / review-status banners. */
  banners?: React.ReactNode;
  /** Hash route back to this layer's list. */
  backHref: string;
  /** `#/graph?focus=…`, or null for a record with no graph node. */
  locateHref: string | null;
  /** Why there is no graph link. Required in spirit whenever `locateHref` is null. */
  locateNote?: string;
  /** Usually `<Markdown source={…} />`. */
  body?: React.ReactNode;
  /** The 1-hop block — see `RecordNeighbours`. */
  neighbours?: React.ReactNode;
  /** Anything layer-specific below the body (serving briefs, remediation). */
  children?: React.ReactNode;
  /** The payload's `generated_at`. See the header. */
  asOf?: string | null;
  loading?: boolean;
}

export function RecordDetail({
  eye,
  title,
  badges,
  meta,
  banners,
  backHref,
  locateHref,
  locateNote,
  body,
  neighbours,
  children,
  asOf,
  loading,
}: RecordDetailProps) {
  return (
    <article className="record-detail">
      <div className="record-detail-actions">
        <a className="record-page-btn" href={backHref} data-cursor="hover">
          ← BACK
        </a>
        {locateHref !== null ? (
          <a className="record-page-btn" href={locateHref} data-cursor="hover">
            LOCATE IN GRAPH
          </a>
        ) : (
          <span className="record-readout">
            {locateNote ?? "NOT IN THE GRAPH"}
          </span>
        )}
        <span className="record-filters-spacer" />
        {asOf !== undefined && asOf !== null && (
          <span className="record-readout">AS OF {asOf}</span>
        )}
      </div>

      {banners}

      <span className="shell-eye">{eye}</span>
      <h2 className="record-detail-title">{title}</h2>
      {badges !== undefined && (
        <div className="record-detail-badges">{badges}</div>
      )}

      <div className="record-detail-meta">
        {meta.map((m) => (
          <div key={m.k} className="shell-kv">
            <span>{m.k}</span>
            <b>{m.v}</b>
          </div>
        ))}
      </div>

      {loading === true && (
        <div aria-hidden>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="shell-skel"
              style={{ width: `${94 - i * 14}%` }}
            />
          ))}
        </div>
      )}

      {body !== undefined && <div className="record-detail-body">{body}</div>}

      {children}

      {neighbours}
    </article>
  );
}

/** One entry in the 1-hop block. */
export interface NeighbourEntry {
  /** The graph node's opaque key — React identity only, never parsed. */
  key: string;
  label: string;
  type: string;
  /** `#/layers/…` when a layer shows this type, else null. */
  href: string | null;
}

export interface RecordNeighboursProps {
  /** `loading` while the shared graph payload is in flight; `unavailable` on failure. */
  state: "loading" | "ready" | "unavailable" | "absent";
  entries: readonly NeighbourEntry[];
  /** Why the neighbourhood is unavailable or absent, stated rather than blank. */
  note?: string;
  /** Total incident edges — may exceed `entries.length` (see `neighbours.ts`). */
  edgeCount?: number;
}

/**
 * The 1-hop neighbourhood (D6).
 *
 * The entries come from `graph/neighbours.ts#neighboursOf` over the SHARED
 * `/api/graph` payload in `lib/graphCache.ts` — the same function and the same
 * payload the canvas uses, so this list and the canvas's 1-HOP list cannot
 * disagree. There is no neighbours endpoint: `traversal.ts` calls `getDb()`,
 * which opens the brain read-WRITE, and AC #7 forbids that.
 *
 * The four states are distinguished on purpose. `absent` (this record has no
 * node in the graph) and `unavailable` (the graph read failed) look identical if
 * you only render a count, and they have completely different remedies.
 */
export function RecordNeighbours({
  state,
  entries,
  note,
  edgeCount,
}: RecordNeighboursProps) {
  return (
    <section className="record-neighbours" aria-label="Graph neighbourhood">
      <span className="shell-eye">
        // 1-HOP
        {state === "ready" ? ` · ${entries.length}` : ""}
        {edgeCount !== undefined && state === "ready" ? ` · ${edgeCount} EDGES` : ""}
      </span>

      {state === "loading" && (
        <p className="record-note">Reading the graph for this project…</p>
      )}

      {state === "unavailable" && (
        <p className="record-note">
          {note ?? "The graph could not be read, so the neighbourhood is unknown."}
        </p>
      )}

      {state === "absent" && (
        <p className="record-note">
          {note ?? "This record has no node in the brain graph yet."}
        </p>
      )}

      {state === "ready" &&
        (entries.length === 0 ? (
          <p className="record-note">
            No edges reach this record. Nothing has been linked to it yet.
          </p>
        ) : (
          <ul className="record-hops">
            {entries.map((entry) => (
              <li key={entry.key}>
                {entry.href !== null ? (
                  <a className="record-hop" href={entry.href} data-cursor="hover">
                    <b>{entry.type}</b>
                    {entry.label}
                  </a>
                ) : (
                  // A neighbour of a type no layer shows (a session, a concept).
                  // Rendered, not hidden: the edge exists, and hiding it would
                  // understate the neighbourhood.
                  <span className="record-hop" data-disabled="true">
                    <b>{entry.type}</b>
                    {entry.label}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
