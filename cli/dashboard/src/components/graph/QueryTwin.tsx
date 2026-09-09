/**
 * FR-239 — the exemption-04 twin, rendered.
 *
 * dataviz.md: *"**The query is the twin.** Every data-viz surface exposes the
 * query — or the saved-view definition — that produced the current node set, in
 * mono, adjacent to the canvas. **Unreproducible canvases are forbidden.**"*
 * It is also the replacement for diagram rules 06 and 08: a surface ID, the
 * query, and an as-of timestamp stand in for `FIG. 14.N` plus a version stamp.
 *
 * THREE FIELDS, NOT FOUR (D5). There is no `VIEWPORT` line. A viewport is a
 * property of where the reader is looking, not of what produced the node set —
 * including it would imply that panning changes the query, which is exactly the
 * confusion the twin exists to prevent.
 *
 * EVERY STRING HERE IS THE SERVER'S (D3). This component formats; it does not
 * compose. A twin the browser assembled would be a caption the client invented.
 */

import type { GraphQueryTwin } from "../../lib/api";

export interface QueryTwinProps {
  twin: GraphQueryTwin;
}

export function QueryTwin({ twin }: QueryTwinProps) {
  return (
    <section className="graph-twin" aria-label="Query provenance">
      <div className="graph-twin-row">
        <span className="graph-twin-key">SURFACE</span>
        <span className="graph-twin-val">{twin.surface}</span>
      </div>
      <div className="graph-twin-row">
        <span className="graph-twin-key">QUERY</span>
        <span className="graph-twin-val">
          {/* Rendered verbatim, line for line. Never re-wrapped or re-worded. */}
          {twin.query.map((line, i) => (
            <span key={i} className="graph-twin-line">
              {line}
            </span>
          ))}
        </span>
      </div>
      <div className="graph-twin-row">
        <span className="graph-twin-key">AS OF</span>
        <span className="graph-twin-val">
          {twin.as_of}
          {"   ·   "}
          {twin.scale}
        </span>
      </div>
    </section>
  );
}
