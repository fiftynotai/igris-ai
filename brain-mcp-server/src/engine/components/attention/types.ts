/** FR-276 — local session attention contracts. No content or credentials are stored. */
import type { BrainGraphNode } from '../edges/whole-graph.js';
export interface AttentionNodeRef {
    type: string;
    project: string | null;
    id: string;
}
export type AttentionOrigin = 'loader' | 'tool_boundary' | 'harness' | 'self_report';
export type AttentionExtent = 'preview' | 'full' | 'unknown';
export type AttentionOutcome = 'started' | 'succeeded' | 'failed' | 'unknown';
export type AttentionEventKind = 'delivery' | 'invocation' | 'availability' | 'epoch' | 'end';
export type AttentionSelectionCategory = 'boot' | 'task' | 'retrieval' | 'user_request';
export interface AttentionSelection {
    category: AttentionSelectionCategory;
    provenance: 'caller_declared' | 'observed';
    reference: string | null;
}
export interface AttentionCoverage {
    level: 'partial' | 'unavailable';
    observed: string[];
    gaps: string[];
    compaction: 'observed' | 'unknown';
}
export interface AttentionSession {
    id: string;
    project: string | null;
    instance_id: string | null;
    harness: string | null;
    harness_session_id: string | null;
    machine_id: string | null;
    parent_session_id: string | null;
    status: 'active' | 'ended' | 'interrupted';
    current_epoch: number;
    started_at: string;
    ended_at: string | null;
    last_sequence: number;
    coverage: AttentionCoverage;
}
export interface AttentionEvent {
    id: number;
    session_id: string;
    sequence: number;
    context_epoch: number;
    actor_id: string;
    operation_id: string;
    event_key: string;
    kind: AttentionEventKind;
    node: AttentionNodeRef | null;
    outcome: AttentionOutcome;
    extent: AttentionExtent | null;
    origin: AttentionOrigin;
    source_revision: string | null;
    bytes: number | null;
    reason: string | null;
    selection: AttentionSelection | null;
    observed_at: string;
}
export interface AttentionNodeState {
    key: string;
    node: AttentionNodeRef;
    state: 'available' | 'preview' | 'full' | 'invoked' | 'failed' | 'unknown' | 'historical';
    self_reported: boolean;
    historical: boolean;
    last_event: AttentionEvent;
    events: AttentionEvent[];
}
export interface AttentionSnapshot {
    session: AttentionSession | null;
    through_sequence: number;
    latest_sequence: number;
    node_states: AttentionNodeState[];
    recent_events: AttentionEvent[];
    next_before: number | null;
    generated_at: string;
    degraded: {
        reason: string;
    } | null;
    /** True when node_states omit evidence: the event window or the node limit was reached. */
    truncated: boolean;
    counts: {
        /** Events at or before through_sequence. */
        events_total: number;
        /** Newest of those reduced into node_states (at most SNAPSHOT_EVENT_WINDOW). */
        events_reduced: number;
        /** Distinct nodes in the reduced events. */
        nodes_reduced: number;
        /** Node states returned (at most SNAPSHOT_NODE_LIMIT, most recently active kept). */
        node_states: number;
    };
}
export interface AttentionSessionList {
    sessions: AttentionSession[];
    next_before: string | null;
    generated_at: string;
    degraded: {
        reason: string;
    } | null;
}
export interface AttentionInventory {
    nodes: BrainGraphNode[];
    revision: string;
    generated_at: string;
    sources: {
        source: string;
        available: boolean;
        reason: string | null;
    }[];
    degraded: {
        reason: string;
    } | null;
}
export interface AttentionActionResult {
    ok: boolean;
    action: string;
    session: AttentionSession | null;
    event: AttentionEvent | null;
    degraded: boolean;
    reason: string | null;
}
export interface DeliveryObservation {
    node: AttentionNodeRef;
    outcome: AttentionOutcome;
    extent?: AttentionExtent;
    source_revision?: string | null;
    bytes?: number | null;
    reason?: string | null;
}
export const DEFAULT_COVERAGE: AttentionCoverage = {
    level: 'partial', observed: ['local resource loader', 'correlated brain calls'],
    gaps: ['Uncorrelated calls and filesystem reads', 'External tools without a verified adapter', 'Hidden model attention and context retention'], compaction: 'unknown',
};

/** Persisted on the completing invocation so incomplete capture survives reload/replay. */
export const COLLECTION_GAP = 'Observation collection incomplete or bounded at 200 records.';
/** Persisted on the completing invocation when the ledger could not record its start; the target still ran. */
export const INVOCATION_START_GAP = 'Invocation start not recorded: the ledger was unavailable before dispatch.';
/** Invocation reasons that mark a session's coverage as degraded at replay. */
export const CAPTURE_GAPS: readonly string[] = [COLLECTION_GAP, INVOCATION_START_GAP];
