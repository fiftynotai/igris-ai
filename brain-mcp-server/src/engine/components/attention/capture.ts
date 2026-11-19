/** FR-276 — request-scoped observations. Native calls without a scope remain untouched. */
import type Database from 'better-sqlite3';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolResult } from '../../types.js';
import { errMsg } from '../../helpers.js';
import { COLLECTION_GAP, INVOCATION_START_GAP, type DeliveryObservation, type AttentionSelection } from './types.js';
import { appendEvent, nodeRef, operationId, sessionId, textField, selectionDeclaration } from './store.js';
import { getAttentionSession } from './read.js';
interface Collector {
    observations: DeliveryObservation[];
    incomplete: boolean;
}
const scope = new AsyncLocalStorage<Collector>();
/** These formatter boundaries prove retrieval, not relevance or a caller's intent. */
const RETRIEVAL_NODE_TYPES: Readonly<Record<string, string>> = {
    igris_memory_search: 'learning', igris_memory_recall: 'learning',
    igris_memory_get: 'learning', igris_memory_hybrid_search: 'learning',
    igris_brief_get: 'brief', igris_brief_list: 'brief',
    igris_session_recall: 'session', igris_goal_get: 'goal', igris_goal_list: 'goal',
    igris_context_get: 'context_doc', igris_context_load: 'os_module',
};
/** Only formatter-owned structured facts enter this buffer; no response prose is parsed. */
export function observeDelivery(observation: DeliveryObservation): void {
    const active = scope.getStore();
    if (!active)
        return;
    try {
        if (active.observations.length >= 200) {
            active.incomplete = true;
            return;
        }
        active.observations.push({ ...observation, node: nodeRef(observation.node) });
    }
    catch {
        active.incomplete = true;
    }
}
/** Call sites check this before building an observation, so native calls never pay for its hash or byte count. */
export function attentionCaptureActive(): boolean { return scope.getStore() !== undefined; }
export async function callAttentionTool(db: Database.Database, input: Record<string, unknown>, dispatch: (name: string, args: Record<string, unknown>) => Promise<ToolResult>): Promise<ToolResult> {
    let id: string, op: string, actor: string, tool: string, selection: AttentionSelection | null;
    const refuse = (reason: string): ToolResult => ({ isError: true, content: [{ type: 'text', text: reason }] });
    try {
        selection = selectionDeclaration(input.selection);
        id = sessionId(input.session_id);
        op = operationId(input.operation_id);
        actor = textField(input.actor_id ?? 'orchestrator', 'actor_id');
        tool = textField(input.tool, 'tool');
        if (tool.startsWith('igris_attention_'))
            return refuse('Nested attention calls are not supported.');
        if (!input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments))
            return refuse('arguments must be an object');
    }
    catch (error) {
        return refuse(error instanceof Error ? error.message : 'Attention call refused.');
    }
    // Identity and duplicate checks always refuse; a ledger that cannot record the start does not.
    const refusal = (): string | null => {
        const session = getAttentionSession(db, id);
        if (!session || session.status !== 'active')
            return 'Unknown or ended attention session on this brain.';
        if (db.prepare('SELECT id FROM attention_events WHERE session_id=? AND operation_id=? LIMIT 1').get(id, op))
            return 'Duplicate operation_id: target was not executed again.';
        return null;
    };
    let startGap = false;
    try {
        const refused = db.transaction(() => {
            const reason = refusal();
            if (reason === null)
                appendEvent(db, { session_id: id, operation_id: op, actor_id: actor, event_key: 'invocation:start', kind: 'invocation', node: { type: 'tool', project: null, id: 'igris-brain:' + tool }, outcome: 'started', origin: 'tool_boundary', selection });
            return reason;
        }).immediate();
        if (refused !== null)
            return refuse(refused);
    }
    catch {
        let refused: string | null = null;
        try {
            refused = refusal();
        }
        catch {
            // Identity is unreadable too; nothing can be recorded against the wrong session.
        }
        if (refused !== null)
            return refuse(refused);
        startGap = true;
    }
    const collector: Collector = { observations: [], incomplete: false };
    let response: ToolResult;
    let threw = false;
    try {
        response = await scope.run(collector, () => dispatch(tool, input.arguments as Record<string, unknown>));
    }
    catch (error) {
        threw = true;
        // The text the native MCP path returns (src/index.ts). It is never persisted: it may echo argument values.
        response = refuse(`Error executing ${tool}: ${errMsg(error)}`);
    }
    // A failed target delivered nothing it observed: no successful delivery is ever recorded for it.
    const failed = threw || response.isError === true;
    const observations = failed
        ? collector.observations.map(o => o.outcome === 'succeeded' ? { node: o.node, outcome: 'failed' as const, extent: 'unknown' as const, source_revision: o.source_revision ?? null, reason: 'Target failed; delivery not confirmed.' } : o)
        : collector.observations;
    const gap = startGap ? INVOCATION_START_GAP : collector.incomplete ? COLLECTION_GAP : null;
    let recorded = true;
    let reason: string | null = null;
    try {
        db.transaction(() => {
            // Per-node misses stay on their delivery events; the invocation outcome is the target's own.
            appendEvent(db, { session_id: id, operation_id: op, actor_id: actor, event_key: 'invocation:end', kind: 'invocation', node: { type: 'tool', project: null, id: 'igris-brain:' + tool }, outcome: failed ? 'failed' : 'succeeded', origin: 'tool_boundary', selection, reason: gap }, true);
            for (let i = 0; i < observations.length; i++) {
                const observation = observations[i]!;
                const deliverySelection = selection ?? (!failed && observation.outcome === 'succeeded' && RETRIEVAL_NODE_TYPES[tool] === observation.node.type
                    ? { category: 'retrieval' as const, provenance: 'observed' as const, reference: tool } : null);
                appendEvent(db, { ...observation, selection: deliverySelection, session_id: id, operation_id: op, actor_id: actor, event_key: 'delivery:' + i, kind: 'delivery', origin: 'tool_boundary' }, true);
            }
        }).immediate();
        if (gap !== null) {
            recorded = false;
            reason = gap;
        }
    }
    catch {
        recorded = false;
        reason = 'Target result preserved; evidence recording failed.';
    }
    const existingMeta = typeof response._meta === 'object' && response._meta !== null ? response._meta as Record<string, unknown> : {};
    return { ...response, _meta: { ...existingMeta, igris_attention: { session_id: id, operation_id: op, recorded, reason } } };
}
