/** FR-276 — validated local actions; no singleton connection or remote transport. */
import type Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { runComponentMigrations } from '../../storage/sqlite.js';
import { attentionMigrations } from './schema.js';
import { attentionPresent, getAttentionSession, eventFromRow } from './read.js';
import { DEFAULT_COVERAGE } from './types.js';
import type { AttentionActionResult, AttentionEventKind, AttentionOutcome, AttentionExtent, AttentionSelection } from './types.js';
import { appendEvent, nodeRef, operationId, sessionId, textField, selectionDeclaration } from './store.js';
import { scanAttentionInventory } from './inventory.js';
import { encodeNodeKey } from '../edges/graph-keys.js';
export function initializeAttention(db: Database.Database): void { runComponentMigrations(db, 'attention', attentionMigrations); }
function result(action: string, patch: Partial<AttentionActionResult> = {}): AttentionActionResult { return { ok: false, action, session: null, event: null, degraded: false, reason: null, ...patch }; }
function failure(action: string, error: unknown): AttentionActionResult { return result(action, { reason: error instanceof Error ? error.message : 'attention action failed' }); }
/** The instance id names a scratchpad file, so it is never path-shaped — the CLI's session register rule. */
const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]{1,256}$/;
function identityField(value: unknown, key: string): string {
    if (key === 'instance_id' && (typeof value !== 'string' || !INSTANCE_ID_RE.test(value)))
        throw new Error('invalid instance_id');
    return textField(value, key);
}
export function sessionAction(db: Database.Database, input: Record<string, unknown>): AttentionActionResult {
    const action = String(input.action ?? '');
    if (!attentionPresent(db))
        return result(action, { degraded: true, reason: 'attention schema unavailable' });
    try {
        if (!['begin', 'bind', 'epoch', 'end'].includes(action))
            throw new Error('unknown attention action');
        const id = action === 'begin' && input.session_id === undefined ? randomUUID() : sessionId(input.session_id);
        const op = operationId(input.operation_id);
        return db.transaction(() => {
            let session = getAttentionSession(db, id);
            if (action === 'begin') {
                const fields = ['project', 'instance_id', 'harness', 'harness_session_id', 'machine_id', 'parent_session_id'] as const;
                const values = fields.map(key => input[key] == null ? null : identityField(input[key], key));
                if (input.parent_session_id != null && !getAttentionSession(db, sessionId(input.parent_session_id)))
                    throw new Error('unknown parent session');
                if (session) {
                    for (let i = 0; i < fields.length; i++)
                        if (values[i] !== null && session[fields[i]] !== values[i])
                            throw new Error('session identity conflict');
                    return result(action, { ok: true, session });
                }
                db.prepare(`INSERT INTO attention_sessions(id,project,instance_id,harness,harness_session_id,machine_id,parent_session_id,coverage) VALUES(?,?,?,?,?,?,?,?)`).run(id, ...values, JSON.stringify(DEFAULT_COVERAGE));
                return result(action, { ok: true, session: getAttentionSession(db, id) });
            }
            if (!session)
                throw new Error('unknown attention session');
            if (action === 'bind') {
                if (session.status !== 'active')
                    throw new Error('attention session ended');
                for (const key of ['project', 'instance_id', 'harness', 'harness_session_id', 'machine_id'] as const) {
                    if (input[key] == null)
                        continue;
                    const value = identityField(input[key], key);
                    if (session[key] !== null && session[key] !== value)
                        throw new Error('session identity conflict');
                    db.prepare(`UPDATE attention_sessions SET ${key}=? WHERE id=?`).run(value, id);
                }
                return result(action, { ok: true, session: getAttentionSession(db, id) });
            }
            const prior = db.prepare('SELECT * FROM attention_events WHERE session_id=? AND operation_id=? AND event_key=?').get(id, op, action) as Record<string, unknown> | undefined;
            if (prior)
                return result(action, { ok: true, session, event: eventFromRow(prior) });
            if (session.status !== 'active') {
                if (action === 'end')
                    return result(action, { ok: true, session });
                throw new Error('attention session ended');
            }
            const reason = input.reason == null ? null : textField(input.reason, 'reason', 500);
            if (action === 'epoch') {
                const coverage = { ...session.coverage, compaction: 'observed' };
                db.prepare('UPDATE attention_sessions SET current_epoch=current_epoch+1,coverage=? WHERE id=?').run(JSON.stringify(coverage), id);
            }
            const event = appendEvent(db, { session_id: id, operation_id: op, event_key: action, kind: action as 'epoch' | 'end', node: null, outcome: 'succeeded', origin: 'harness', reason });
            if (action === 'end') {
                const status = input.status ?? 'ended';
                if (!['ended', 'interrupted'].includes(String(status)))
                    throw new Error('invalid end status');
                db.prepare("UPDATE attention_sessions SET status=?,ended_at=datetime('now') WHERE id=?").run(status, id);
            }
            session = getAttentionSession(db, id);
            return result(action, { ok: true, session, event });
        }).immediate();
    }
    catch (error) {
        return failure(action, error);
    }
}
export function eventAction(db: Database.Database, input: Record<string, unknown>): AttentionActionResult {
    if (!attentionPresent(db))
        return result('event', { degraded: true, reason: 'attention schema unavailable' });
    try {
        const selection = selectionDeclaration(input.selection);
        const kind = input.kind as AttentionEventKind;
        if (!['delivery', 'invocation', 'availability'].includes(kind))
            throw new Error('invalid report kind');
        const node = nodeRef(input.node);
        // A single external operation may return multiple nodes or lifecycle phases.
        // Explicit keys identify repeated observations of the same state.
        const eventKey = input.event_key === undefined
            ? 'report:' + createHash('sha256').update(JSON.stringify([kind, node, input.outcome, input.extent ?? null])).digest('hex')
            : textField(input.event_key, 'event_key');
        const event = appendEvent(db, { session_id: sessionId(input.session_id), operation_id: operationId(input.operation_id), actor_id: input.actor_id as string | undefined, event_key: eventKey, kind, node, outcome: input.outcome as AttentionOutcome, extent: input.extent as AttentionExtent | undefined, origin: 'self_report', selection, source_revision: input.source_revision as string | undefined, bytes: input.bytes as number | undefined, reason: input.reason as string | undefined });
        return result('event', { ok: true, event, session: getAttentionSession(db, event.session_id) });
    }
    catch (error) {
        return failure('event', error);
    }
}
export function readAttentionResource(db: Database.Database, input: Record<string, unknown>, options: {
    brain_root?: string;
} = {}): {
    result: AttentionActionResult;
    content: string | null;
    truncated: boolean;
} {
    let session_id: string, op: string, node: ReturnType<typeof nodeRef>, selection: AttentionSelection | null;
    try {
        selection = selectionDeclaration(input.selection);
        session_id = sessionId(input.session_id);
        op = operationId(input.operation_id);
        node = nodeRef(input.node);
        const session = getAttentionSession(db, session_id);
        if (!session || session.status !== 'active')
            throw new Error('unknown or ended attention session');
        db.transaction(() => {
            if (db.prepare('SELECT id FROM attention_events WHERE session_id=? AND operation_id=? LIMIT 1').get(session_id, op))
                throw new Error('Duplicate operation_id: resource was not delivered again.');
            appendEvent(db, { session_id, operation_id: op, actor_id: input.actor_id as string | undefined, event_key: 'resource:start', kind: 'delivery', node, outcome: 'started', extent: 'unknown', origin: 'loader', selection });
        }).immediate();
    }
    catch (error) {
        return { result: failure('read', error), content: null, truncated: false };
    }
    try {
        const max = input.max_bytes ?? 262144;
        if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 2097152)
            throw new Error('max_bytes must be 1–2097152');
        const { resources } = scanAttentionInventory(db, { brain_root: options.brain_root ?? (process.env.IGRIS_BRAIN_DIR?.trim() || join(homedir(), '.igris')), project: node.project });
        const resource = resources.get(encodeNodeKey(node));
        if (!resource)
            throw new Error('resource unavailable in discovered inventory');
        const path = realpathSync(resource.path), root = realpathSync(resource.root);
        if (path !== root && !path.startsWith(root + sep))
            throw new Error('resource outside inventory root');
        if (statSync(path).size > 10485760)
            throw new Error('resource exceeds 10 MiB source limit');
        const bytes = readFileSync(path);
        const truncated = bytes.length > max;
        let end = Math.min(max, bytes.length);
        if (truncated)
            while (end > 0 && (bytes[end]! & 0xc0) === 0x80)
                end--;
        const content = bytes.subarray(0, end).toString('utf8');
        try {
            const event = appendEvent(db, { session_id, operation_id: op, actor_id: input.actor_id as string | undefined, event_key: 'resource', kind: 'delivery', node, outcome: 'succeeded', extent: truncated ? 'preview' : 'full', origin: 'loader', selection, source_revision: createHash('sha256').update(bytes).digest('hex'), bytes: end });
            return { result: result('read', { ok: true, event, session: getAttentionSession(db, session_id) }), content, truncated };
        }
        catch {
            return { result: result('read', { ok: true, degraded: true, reason: 'Resource delivered; evidence recording failed.' }), content, truncated };
        }
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : 'resource read failed';
        try {
            const event = appendEvent(db, { session_id, operation_id: op, actor_id: input.actor_id as string | undefined, event_key: 'resource', kind: 'delivery', node, outcome: 'failed', extent: 'unknown', origin: 'loader', selection, reason: reason.slice(0, 500) });
            return { result: result('read', { event, session: getAttentionSession(db, session_id), reason }), content: null, truncated: false };
        }
        catch {
            return { result: failure('read', new Error('resource read or evidence recording failed')), content: null, truncated: false };
        }
    }
}
