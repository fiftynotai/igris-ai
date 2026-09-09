/**
 * FR-239 — the selected entity's payload attributes.
 *
 * **THIS COMPONENT STILL ISSUES NO FETCH, AND THAT IS A SCOPE FENCE (R11).**
 * Every field it renders is already in the `/api/graph` payload — `label`,
 * `type`, `project`, `degree`, and the per-type `attrs` bag the builder
 * assembled.
 *
 * FR-239's version of this note said: *"the moment this needs a second endpoint
 * — a brief's body, a learning's content, a session transcript — it has become
 * FR-240's, not FR-239's."* FR-240 arrived, and the resolution is that this file
 * STILL issues no fetch. It gained a LINK. `OPEN RECORD` navigates to
 * `#/layers/<layer>/<project>/<id>`, and the record view does its own read.
 *
 * That distinction is the whole scope fence. FR-237's scale argument is that
 * this layer *"returns NO body content"*, so a per-node detail fetch HERE would
 * reintroduce the superlinear payload term the builder was designed to remove —
 * a graph of 2,400 nodes would become 2,400 potential body reads hanging off a
 * hover. A link costs nothing and moves the read to a surface that shows one
 * record at a time.
 *
 * The href is built from `node.type` / `node.project` / `node.id` — the
 * STRUCTURED triple — and never from `node.key`. `graph-keys.ts:26-29`:
 * *"Consumers should read the structured fields and treat `key` as an opaque
 * handle."* (D5. Porting the key form would make a fourth mirror of it.)
 */

import type { GraphNode } from "../../lib/api";
import { shapeFor } from "../../graph/shapes";
import { recordHrefForNode } from "../../layers/model";

export interface NodeInspectorProps {
  node: GraphNode;
  neighbours: readonly GraphNode[];
  /** M3 — was `() => undefined`, which made 12 styled buttons no-ops. */
  onSelect: (key: string) => void;
  /**
   * Interaction 5 — trace the lineage out of this node.
   *
   * This control is the ONLY way a `hot` edge can occur. `dataviz.md` rule 04
   * binds four edge types unconditionally and exemption 03 makes `hot`
   * per-interaction; without a trace to run, the role was unreachable and the
   * canvas had three edge types, not four.
   */
  onTrace: (key: string) => void;
  onClose: () => void;
}

/** `attrs` values are `unknown` from the builder. Render, never interpret. */
function display(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value === "" ? "—" : value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

export function NodeInspector({
  node,
  neighbours,
  onSelect,
  onTrace,
  onClose,
}: NodeInspectorProps) {
  const attrs = Object.entries(node.attrs);
  const recordHref = recordHrefForNode(node);

  return (
    <aside className="graph-inspector" aria-label="Selected entity">
      <div className="graph-inspector-head">
        <span className="graph-inspector-eye">
          {/* The finer domain type is TEXT, never geometry (dataviz §07 rule 3). */}
          // {node.type.toUpperCase()} · {shapeFor(node)}
        </span>
        <button
          type="button"
          className="graph-control graph-inspector-close"
          onClick={onClose}
          aria-label="Clear selection"
        >
          ×
        </button>
      </div>

      <h2 className="graph-inspector-title">{node.label}</h2>

      {/*
        AC #3, the graph → record direction. An `<a href>` rather than a click
        handler, so the address bar states the record's `(type, project, id)`
        triple and the link is copyable, middle-clickable and back-buttonable.
      */}
      {recordHref !== null ? (
        <a
          className="graph-control graph-inspector-trace"
          href={recordHref}
          data-cursor="hover"
        >
          OPEN RECORD
        </a>
      ) : (
        /*
          NOT every node type has a detail view, and saying so is information.
          Session, concept, decision and cluster nodes are real graph nodes that
          FR-240 does not render — a missing control here would read as a bug and
          a dead control would be worse. The browser gate (G-BR-1) asserts THIS
          state for those types rather than asserting a blank page.
        */
        <span className="graph-inspector-more">
          // NO DETAIL VIEW FOR {node.type.toUpperCase()}
        </span>
      )}

      <button
        type="button"
        className="graph-control graph-inspector-trace"
        onClick={() => onTrace(node.key)}
      >
        TRACE LINEAGE
      </button>

      <div className="shell-kv">
        <span>id</span>
        <b>{node.id}</b>
      </div>
      <div className="shell-kv">
        <span>project</span>
        <b>{node.project ?? "—"}</b>
      </div>
      <div className="shell-kv">
        <span>degree</span>
        <b>{node.degree}</b>
      </div>
      {node.boundary === true && (
        <div className="shell-kv">
          <span>boundary</span>
          {/* Pulled in by adjacency during a drill — outside the current scope. */}
          <b>outside this scope</b>
        </div>
      )}
      {node.phantom === true && (
        <div className="shell-kv">
          <span>phantom</span>
          <b>no backing row</b>
        </div>
      )}

      {attrs.length > 0 && (
        <>
          <span className="graph-inspector-eye">// ATTRS</span>
          {attrs.map(([k, v]) => (
            <div key={k} className="shell-kv">
              <span>{k}</span>
              <b>{display(v)}</b>
            </div>
          ))}
        </>
      )}

      {neighbours.length > 0 && (
        <>
          <span className="graph-inspector-eye">
            // 1-HOP · {neighbours.length}
          </span>
          <ul className="graph-inspector-hops">
            {neighbours.slice(0, 12).map((n) => (
              <li key={n.key}>
                <button
                  type="button"
                  className="graph-control graph-inspector-hop"
                  onClick={() => onSelect(n.key)}
                >
                  {n.label}
                </button>
              </li>
            ))}
          </ul>
          {neighbours.length > 12 && (
            <span className="graph-inspector-more">
              +{neighbours.length - 12} more
            </span>
          )}
        </>
      )}
    </aside>
  );
}
