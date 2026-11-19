import type { AttentionEvent, AttentionNodeState, AttentionSelection } from "../lib/api";
import type { SemanticNeighbour } from "./lens";
import { EVIDENCE, eventLabel } from "./model";

const SELECTION_LABELS = { boot: "Boot rules", task: "Task relevance", retrieval: "Retrieval", user_request: "Explicit user request" };

export function SelectionReason({ selection }: { selection: AttentionSelection | null | undefined }) {
  return <span data-selection-provenance={selection?.provenance ?? "not_recorded"}>{selection == null ? "Not recorded" : <>
    {SELECTION_LABELS[selection.category]} · {selection.provenance === "observed" ? "Observed retrieval" : "Reported by agent"}
    {selection.reference !== null && <> · {selection.reference}</>}
  </>}</span>;
}

export function EventEvidence({ event }: { event: AttentionEvent }) {
  return <div className="attention-event" data-event-sequence={event.sequence} data-origin={event.origin}>
    <b>{eventLabel(event)}</b>
    {event.origin === "self_report" && <strong className="attention-self-report">SELF-REPORTED</strong>}
    <dl className="attention-facts">
      <dt>Why selected</dt><dd><SelectionReason selection={event.selection} /></dd>
      <dt>Actor</dt><dd>{event.actor_id}</dd>
      <dt>Time</dt><dd><time>{event.observed_at}</time></dd>
      <dt>Origin</dt><dd>{event.origin}</dd>
      <dt>Outcome</dt><dd>{event.outcome}</dd>
      <dt>Extent</dt><dd>{event.extent ?? "not applicable"}</dd>
      <dt>Revision</dt><dd>{event.source_revision ?? "unknown"}</dd>
      <dt>Bytes</dt><dd>{event.bytes ?? "unknown"}</dd>
      <dt>Epoch / event</dt><dd>{event.context_epoch} / {event.sequence}</dd>
      <dt>Operation</dt><dd>{event.operation_id}</dd>
    </dl>
    {event.reason !== null && <p>Event detail: {event.reason}</p>}
  </div>;
}

export function AttentionInspector({ state, offMap, neighbour }: { state: AttentionNodeState | null; offMap: boolean; neighbour?: SemanticNeighbour | null }) {
  return <section className="attention-section" aria-label="Session evidence inspector" data-attention-inspector={state?.key ?? ""}>
    <h3>SESSION EVIDENCE</h3>
    {state === null && neighbour != null ? <>
      <b>{neighbour.node.label}</b><h3>Related node</h3>
      <p>No activity recorded for this node in this chat. It is shown because of a direct knowledge relationship.</p>
      <ul>{neighbour.relations.map((edge) => <li key={edge.id}>{edge.type.replaceAll("_", " ")} · {edge.provenance} · {edge.from} → {edge.to}</li>)}</ul>
    </> : state === null ? <p className="graph-inspector-hint">Select a recorded node to inspect its evidence. No observation for a node does not mean unused.</p> : <>
      <b>{state.node.id}</b>
      <p data-evidence={state.state}>{EVIDENCE[state.state].mark} · {EVIDENCE[state.state].label}{state.historical ? " · historical" : ""}</p>
      <p>{state.node.type} · {state.node.project ?? "global"}</p>
      <h3>Why selected · Latest receipt</h3>
      <p><SelectionReason selection={state.last_event.selection} /></p>
      <p className="graph-inspector-hint">Reasons describe why an item was chosen. Delivery receipts show what was actually loaded.</p>
      {offMap && <p role="status">Outside this map: omitted by scope, truncation, missing inventory, or identity mismatch. Evidence remains inspectable.</p>}
      {state.self_reported && <p className="attention-self-report">SELF-REPORTED evidence is present. Inspect each event’s origin.</p>}
      <p className="graph-inspector-hint">Recent supporting events; older evidence is available through history.</p>
      {state.events.map((event) => <EventEvidence key={event.id} event={event} />)}
    </>}
  </section>;
}
