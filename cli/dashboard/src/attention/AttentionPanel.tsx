import type { AttentionInventory, AttentionNodeState, AttentionSessionList, AttentionSnapshot } from "../lib/api";
import type { SemanticNeighbour } from "./lens";
import { AttentionHistory } from "./AttentionHistory";
import { AttentionInspector } from "./AttentionInspector";
import { AttentionLegend } from "./AttentionLegend";
import { attentionHash, EVIDENCE } from "./model";

export function AttentionPanel({ sessionId, snapshot, error, loading, inventory, inventoryError, selectedKey, offMap, neighbour, sessions, through, before, onReplay, onPage, onSelect, onRefresh }: {
  sessionId: string | null; snapshot: AttentionSnapshot | null; error: string | null; loading: boolean;
  inventory: AttentionInventory | null; inventoryError: string | null; selectedKey: string | null;
  neighbour?: SemanticNeighbour | null;
  offMap: readonly AttentionNodeState[]; sessions: AttentionSessionList | null;
  through: number | null; before: number | null; onReplay: (sequence: number | null) => void;
  onPage: (sequence: number | null) => void; onSelect: (key: string) => void; onRefresh: () => void;
}) {
  const session = snapshot?.session ?? null;
  const selected = snapshot?.node_states.find((node) => node.key === selectedKey) ?? null;
  const children = sessions?.sessions.filter((child) => child.parent_session_id === session?.id) ?? [];
  return <aside className="attention-panel" aria-label="Session attention" data-attention-session={session?.id ?? ""} data-attention-through={snapshot?.through_sequence ?? ""}>
    <div className="attention-section">
      <span className="graph-inspector-eye">// SESSION ATTENTION</span>
      {sessionId === null && <p>Choose a recording to see what that chat received and invoked.</p>}
      {loading && <p role="status">Reading this session’s evidence…</p>}
      {error !== null && <p role="status">Activity unavailable — {error.includes("HTTP 404") ? "Recording not found, or this server does not support session attention." : error}{snapshot !== null ? " The last successful observation remains visible." : ""}</p>}
      {snapshot?.degraded != null && <p role="status">Activity degraded — {snapshot.degraded.reason}</p>}
      {session !== null && <>
        <h2>{session.project ?? "Unbound project"}</h2>
        <dl className="attention-facts">
          <dt>Recording</dt><dd>{session.id}</dd>
          <dt>Status</dt><dd>{session.status}</dd>
          <dt>Harness</dt><dd>{session.harness ?? "unknown"}</dd>
          <dt>Chat binding</dt><dd>{session.harness_session_id ?? "unknown — no verified chat identity"}</dd>
          <dt>Instance</dt><dd>{session.instance_id ?? "not bound"}</dd>
          <dt>Started</dt><dd>{session.started_at}</dd>
          <dt>Ended</dt><dd>{session.ended_at ?? "not observed"}</dd>
          <dt>Epoch</dt><dd>{session.current_epoch}</dd>
          <dt>Activity as of</dt><dd>{snapshot?.generated_at}</dd>
        </dl>
        {session.parent_session_id !== null && <a className="graph-control" href={attentionHash(session.parent_session_id)}>PARENT RECORDING</a>}
        {children.map((child) => <a className="graph-control" key={child.id} href={attentionHash(child.id)}>CHILD · {child.id.slice(0, 8)}</a>)}
        <p className="attention-coverage">Coverage: {session.coverage.level} · compaction {session.coverage.compaction}</p>
        <details><summary>Observation coverage and gaps</summary>
          <p>Observed: {session.coverage.observed.join(", ") || "none reported"}</p>
          <ul>{session.coverage.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul>
          <p>Delivery is evidence of an observed boundary, not a view into model attention or retained context.</p>
        </details>
        <button type="button" className="graph-control" onClick={onRefresh}>REFRESH ACTIVITY</button>
      </>}
    </div>
    <details className="attention-section">
      <summary>Capability inventory · {inventory === null ? "unavailable" : `${inventory.nodes.length} nodes`}</summary>
      <p>As of {inventory?.generated_at ?? "unavailable"}</p>
      <p>Revision {inventory?.revision ?? "unknown"}</p>
      {inventoryError !== null && <p role="status">Inventory unavailable — {inventoryError}</p>}
      {inventory?.degraded != null && <p role="status">Inventory degraded — {inventory.degraded.reason}</p>}
      <ul>{inventory?.sources.map((source) => <li key={source.source}>{source.source}: {source.available ? "available" : "unavailable"}{source.reason !== null ? ` — ${source.reason}` : ""}</li>)}</ul>
      <p>Installed or published capabilities are not proof of exposure to this chat.</p>
    </details>
    {snapshot !== null && session !== null && <>
      <AttentionLegend states={snapshot.node_states} />
      <details className="attention-section" open>
        <summary>Recorded nodes · {offMap.length} outside this map</summary>
        {snapshot.node_states.length === 0 ? <p>This recording contains no node observations yet. Coverage gaps remain unknown.</p> : <ul className="attention-nodes">
          {snapshot.node_states.map((node) => <li key={node.key}>
            <button type="button" className="graph-control" data-attention-node={node.key} data-evidence={node.state} onClick={() => onSelect(node.key)}>
              <span>{EVIDENCE[node.state].mark} · {node.node.id}</span>
              <small>{EVIDENCE[node.state].label}{node.self_reported ? " · SELF-REPORTED" : ""}{offMap.some((item) => item.key === node.key) ? " · outside map" : ""}</small>
            </button>
          </li>)}
        </ul>}
      </details>
      <AttentionInspector neighbour={neighbour} state={selected} offMap={offMap.some((node) => node.key === selected?.key)} />
      <AttentionHistory snapshot={snapshot} through={through} before={before} onReplay={onReplay} onPage={onPage} />
    </>}
  </aside>;
}
