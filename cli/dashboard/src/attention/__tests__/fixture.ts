import type { AttentionEvent, AttentionNodeState, AttentionSession, AttentionSnapshot, GraphNode } from "../../lib/api";

export const SESSION_A = "00000000-0000-4000-8000-000000000001";
export const SESSION_B = "00000000-0000-4000-8000-000000000002";
export const resource: GraphNode = { key: "opaque-shared-key", type: "os_module", project: null, id: "igris-core:conduct", label: "Conduct", degree: 0, attrs: {} };
export function event(over: Partial<AttentionEvent> = {}): AttentionEvent {
  return { id: 1, session_id: SESSION_A, sequence: 1, context_epoch: 0, actor_id: "root", operation_id: "load-conduct", event_key: "delivered", kind: "delivery", node: resource, outcome: "succeeded", extent: "full", origin: "loader", source_revision: "sha256:fixture", bytes: 42, reason: null, observed_at: "2026-10-19T10:00:00.000Z", ...over };
}
export function state(over: Partial<AttentionNodeState> = {}): AttentionNodeState {
  return { key: resource.key, node: resource, state: "full", self_reported: false, historical: false, last_event: event(), events: [event()], ...over };
}
export function session(over: Partial<AttentionSession> = {}): AttentionSession {
  return { id: SESSION_A, project: "demo", instance_id: null, harness: "codex", harness_session_id: null, machine_id: null, parent_session_id: null, status: "active", current_epoch: 0, started_at: "2026-10-19T10:00:00.000Z", ended_at: null, last_sequence: 1, coverage: { level: "partial", observed: ["resource_loader"], gaps: ["external tools unobserved"], compaction: "unknown" }, ...over };
}
export function snapshot(over: Partial<AttentionSnapshot> = {}): AttentionSnapshot {
  return { session: session(), through_sequence: 1, latest_sequence: 1, node_states: [state()], recent_events: [event()], next_before: null, generated_at: "2026-10-19T10:00:01.000Z", degraded: null, truncated: false, counts: { events_total: 1, events_reduced: 1, nodes_reduced: 1, node_states: 1 }, ...over };
}
