/** Validated ledger writer shared by local actions and observed delivery boundaries. */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { eventFromRow, getAttentionSession } from './read.js';
import type { AttentionEvent, AttentionNodeRef, AttentionOrigin, AttentionEventKind, AttentionOutcome, AttentionExtent, AttentionSelection } from './types.js';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function textField(value: unknown, name: string, max = 256): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f]/.test(value))
        throw new Error(`invalid ${name}`);
    return value;
}
export function sessionId(value: unknown): string {
    const id = textField(value, 'session_id');
    if (!UUID_RE.test(id)) throw new Error('invalid session_id');
    return id;
}
export function nodeRef(value: unknown): AttentionNodeRef {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('invalid node');
    const n = value as Record<string, unknown>;
    return { type: textField(n.type, 'node.type', 64), project: n.project === null ? null : textField(n.project, 'node.project'), id: textField(n.id, 'node.id', 1024) };
}
export function operationId(value?: unknown): string { return value === undefined ? randomUUID() : textField(value, 'operation_id'); }
const SELECTION_CATEGORIES = ['boot', 'task', 'retrieval', 'user_request'];
export const SELECTION_REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
function isSelectionReference(value: unknown): value is string {
    // Require the complete match: JavaScript's $ also accepts a final newline.
    return typeof value === 'string' && SELECTION_REFERENCE_RE.exec(value)?.[0] === value;
}
/** Public declarations cannot claim observation, or carry prose, queries or paths. */
export function selectionDeclaration(value: unknown): AttentionSelection | null {
    if (value === undefined) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid selection');
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some(key => !['category', 'reference'].includes(key))) throw new Error('invalid selection field');
    if (typeof input.category !== 'string' || !SELECTION_CATEGORIES.includes(input.category)) throw new Error('invalid selection category');
    if (input.reference !== undefined && !isSelectionReference(input.reference))
        throw new Error('invalid selection reference');
    return { category: input.category as AttentionSelection['category'], provenance: 'caller_declared', reference: (input.reference as string | undefined) ?? null };
}
function selectionMetadata(value: AttentionSelection | null | undefined): AttentionSelection | null {
    if (value == null) return null;
    if (typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !['category', 'provenance', 'reference'].includes(key))
        || !SELECTION_CATEGORIES.includes(value.category)
        || !['caller_declared', 'observed'].includes(value.provenance)
        || (value.provenance === 'observed' && value.category !== 'retrieval')
        || (value.reference != null && !isSelectionReference(value.reference)))
        throw new Error('invalid selection metadata');
    return { category: value.category, provenance: value.provenance, reference: value.reference ?? null };
}
export interface EventInput {
    session_id: string;
    operation_id?: string;
    actor_id?: string;
    event_key: string;
    kind: AttentionEventKind;
    node: AttentionNodeRef | null;
    outcome: AttentionOutcome;
    extent?: AttentionExtent | null;
    origin: AttentionOrigin;
    source_revision?: string | null;
    bytes?: number | null;
    reason?: string | null;
    selection?: AttentionSelection | null;
}
export function appendEvent(db: Database.Database, input: EventInput, allowClosed = false): AttentionEvent {
    const id = sessionId(input.session_id);
    const op = operationId(input.operation_id);
    const actor = textField(input.actor_id ?? 'orchestrator', 'actor_id');
    const key = textField(input.event_key, 'event_key');
    const node = input.node === null ? null : nodeRef(input.node);
    if (!['delivery', 'invocation', 'availability', 'epoch', 'end'].includes(input.kind))
        throw new Error('invalid event kind');
    if (!['started', 'succeeded', 'failed', 'unknown'].includes(input.outcome))
        throw new Error('invalid outcome');
    if (input.extent != null && !['preview', 'full', 'unknown'].includes(input.extent))
        throw new Error('invalid extent');
    if (!['loader', 'tool_boundary', 'harness', 'self_report'].includes(input.origin))
        throw new Error('invalid origin');
    if (input.bytes != null && (!Number.isSafeInteger(input.bytes) || input.bytes < 0))
        throw new Error('invalid bytes');
    const revision = input.source_revision == null ? null : textField(input.source_revision, 'source_revision', 256);
    const reason = input.reason == null ? null : textField(input.reason, 'reason', 500);
    const selection = selectionMetadata(input.selection);
    return db.transaction(() => {
        const existing = db.prepare('SELECT * FROM attention_events WHERE session_id=? AND operation_id=? AND event_key=?').get(id, op, key) as Record<string, unknown> | undefined;
        if (existing) {
            const prior = eventFromRow(existing);
            const unchanged = prior.actor_id === actor && prior.kind === input.kind
                && prior.outcome === input.outcome && prior.extent === (input.extent ?? null)
                && prior.origin === input.origin && prior.source_revision === revision
                && prior.bytes === (input.bytes ?? null) && prior.reason === reason
                && JSON.stringify(prior.selection) === JSON.stringify(selection)
                && JSON.stringify(prior.node) === JSON.stringify(node);
            if (!unchanged) throw new Error('operation evidence conflict');
            return prior;
        }
        const session = getAttentionSession(db, id);
        if (!session)
            throw new Error('unknown attention session');
        if (session.status !== 'active' && !allowClosed)
            throw new Error('attention session ended');
        const seq = session.last_sequence + 1;
        db.prepare('UPDATE attention_sessions SET last_sequence=? WHERE id=?').run(seq, id);
        const result = db.prepare(`INSERT INTO attention_events(session_id,sequence,context_epoch,actor_id,operation_id,event_key,kind,node_type,node_project,node_id,outcome,extent,origin,source_revision,bytes,reason,selection) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, seq, session.current_epoch, actor, op, key, input.kind, node?.type ?? null, node?.project ?? null, node?.id ?? null, input.outcome, input.extent ?? null, input.origin, revision, input.bytes ?? null, reason, selection === null ? null : JSON.stringify(selection));
        return eventFromRow(db.prepare('SELECT * FROM attention_events WHERE id=?').get(result.lastInsertRowid) as Record<string, unknown>);
    }).immediate();
}
