import type { AttentionNodeState, AttentionState } from "../lib/api";
import { EVIDENCE } from "./model";

export function AttentionLegend({ states }: { states: readonly AttentionNodeState[] }) {
  return <details className="attention-section" open>
    <summary>Evidence legend · {states.length} recorded nodes</summary>
    <ul className="attention-legend">
      {(Object.keys(EVIDENCE) as AttentionState[]).map((state) => <li key={state} title={EVIDENCE[state].meaning}>
        <span className="attention-mark" data-evidence={state}>{EVIDENCE[state].mark}</span>
        <span>{EVIDENCE[state].label}</span><b>{states.filter((node) => node.state === state).length}</b>
      </li>)}
      <li><span className="attention-mark">S</span><span>Self-reported origin</span><b>{states.filter((node) => node.self_reported).length}</b></li>
    </ul>
    <p className="graph-inspector-hint">Available means discovered. Delivery does not prove comprehension or retention. Semantic edges are relationships, not observed retrieval paths.</p>
  </details>;
}
