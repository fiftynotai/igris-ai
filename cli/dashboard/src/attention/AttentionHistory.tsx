import type { AttentionSnapshot } from "../lib/api";
import { eventLabel } from "./model";

export function AttentionHistory({ snapshot, through, before, onReplay, onPage }: {
  snapshot: AttentionSnapshot; through: number | null; before: number | null;
  onReplay: (sequence: number | null) => void; onPage: (sequence: number | null) => void;
}) {
  return <section className="attention-section" aria-label="Session activity history">
    <h3>HISTORY · {through === null ? "LIVE" : `REPLAY THROUGH ${through}`}</h3>
    <p className="graph-inspector-hint">Through event {snapshot.through_sequence} of {snapshot.latest_sequence}. This page shows up to 50 events.</p>
    <div className="attention-actions">
      {through !== null && <button type="button" className="graph-control" onClick={() => onReplay(null)}>RETURN TO LIVE</button>}
      {before !== null && <button type="button" className="graph-control" onClick={() => onPage(null)}>LATEST EVENTS</button>}
      {snapshot.next_before !== null && <button type="button" className="graph-control" onClick={() => onPage(snapshot.next_before)}>OLDER EVENTS</button>}
    </div>
    {snapshot.recent_events.length === 0 ? <p>No events in this page of the recording.</p> : <ol className="attention-history">
      {snapshot.recent_events.map((event) => <li key={event.id} data-history-sequence={event.sequence}>
        <button type="button" className="graph-control" onClick={() => onReplay(event.sequence)} aria-label={`Replay through event ${event.sequence}`}>
          #{event.sequence} · {eventLabel(event)}
        </button>
        <span>{event.node?.id ?? event.kind} · epoch {event.context_epoch}</span>
        <span>{event.actor_id} · {event.origin === "self_report" ? "SELF-REPORTED" : event.origin}</span>
        <time>{event.observed_at}</time>
      </li>)}
    </ol>}
  </section>;
}
