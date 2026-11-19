import type { AttentionSessionList } from "../lib/api";
import { attentionHash } from "./model";

export function SessionPicker({ selected, payload, error, older, onPage, onRefresh }: {
  selected: string | null; payload: AttentionSessionList | null; error: string | null;
  older: boolean; onPage: (before: string | null) => void; onRefresh: () => void;
}) {
  return <div className="attention-picker">
    <label htmlFor="attention-session">SESSION ATTENTION</label>
    <select id="attention-session" className="graph-control" value={selected ?? ""}
      onChange={(event) => { location.hash = attentionHash(event.target.value || null, location.hash); }}>
      <option value="">Whole brain · no session overlay</option>
      {selected !== null && !payload?.sessions.some((session) => session.id === selected) && <option value={selected}>{selected}</option>}
      {payload?.sessions.map((session) => <option key={session.id} value={session.id}>
        {session.project ?? "unbound"} · {session.harness ?? "unknown harness"} · {session.status} · {session.started_at} · {session.id.slice(0, 8)}
      </option>)}
    </select>
    <button type="button" className="graph-control" onClick={onRefresh}>REFRESH SESSIONS</button>
    {payload?.next_before != null && <button type="button" className="graph-control" onClick={() => onPage(payload.next_before)}>OLDER SESSIONS</button>}
    {older && <button type="button" className="graph-control" onClick={() => onPage(null)}>LATEST SESSIONS</button>}
    {(error !== null || payload?.degraded != null) && <span role="status">Session list unavailable — {error ?? payload?.degraded?.reason}</span>}
  </div>;
}
