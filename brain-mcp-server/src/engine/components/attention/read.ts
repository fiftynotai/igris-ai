/** FR-276 — read-only attention builders. Callers own the connection. */
import type Database from 'better-sqlite3';
import { CAPTURE_GAPS } from './types.js';
import { encodeNodeKey } from '../edges/graph-keys.js';
import type { AttentionSession, AttentionEvent, AttentionSessionList, AttentionSnapshot, AttentionNodeState } from './types.js';
export function attentionPresent(db: Database.Database): boolean {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='attention_sessions'").get()
        && !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='attention_events'").get();
}
export function sessionFromRow(row: Record<string, unknown>): AttentionSession {
    return { ...row, coverage: JSON.parse(String(row.coverage)) } as unknown as AttentionSession;
}
export function eventFromRow(row: Record<string, unknown>): AttentionEvent {
    const { node_type, node_project, node_id, selection, ...rest } = row;
    return { ...rest, selection: selection == null ? null : JSON.parse(String(selection)), node: node_type === null ? null : { type: node_type, project: node_project, id: node_id } } as unknown as AttentionEvent;
}
export function getAttentionSession(db: Database.Database, id: string): AttentionSession | null {
    if (!attentionPresent(db))
        return null;
    const row = db.prepare('SELECT * FROM attention_sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? sessionFromRow(row) : null;
}
function limitOf(n?: number): number {
    if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 100))
        throw new Error('limit must be an integer from 1 to 100');
    return n ?? 50;
}
export function listAttentionSessions(db: Database.Database, opts: {
    project?: string;
    before?: string;
    limit?: number;
} = {}): AttentionSessionList {
    const out: AttentionSessionList = { sessions: [], next_before: null, generated_at: new Date().toISOString(), degraded: null };
    if (!attentionPresent(db))
        return { ...out, degraded: { reason: 'attention schema unavailable' } };
    const limit = limitOf(opts.limit);
    const where: string[] = [];
    const values: unknown[] = [];
    if (opts.project !== undefined) {
        where.push('project = ?');
        values.push(opts.project);
    }
    if (opts.before) {
        const cursor = db.prepare('SELECT started_at, id FROM attention_sessions WHERE id = ?').get(opts.before) as {
            started_at: string;
            id: string;
        } | undefined;
        if (!cursor)
            throw new Error('unknown session cursor');
        where.push('(started_at < ? OR (started_at = ? AND id < ?))');
        values.push(cursor.started_at, cursor.started_at, cursor.id);
    }
    const rows = db.prepare(`SELECT * FROM attention_sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC, id DESC LIMIT ?`).all(...values, limit + 1) as Record<string, unknown>[];
    out.sessions = rows.slice(0, limit).map(sessionFromRow);
    if (rows.length > limit)
        out.next_before = out.sessions.at(-1)!.id;
    return out;
}
/** A snapshot reduces at most this many of the newest events at its cutoff; older ones stay pageable. */
export const SNAPSHOT_EVENT_WINDOW = 2000;
/** At most this many node states are returned; the most recently active are kept. */
export const SNAPSHOT_NODE_LIMIT = 100;
/** Supporting events per node state: the decisive event and the most recent one. */
export const NODE_EVENT_LIMIT = 2;
export function readAttentionSnapshot(db: Database.Database, opts: {
    session_id: string;
    through_sequence?: number;
    before?: number;
    limit?: number;
}): AttentionSnapshot {
    const out: AttentionSnapshot = { session: null, through_sequence: 0, latest_sequence: 0, node_states: [], recent_events: [], next_before: null, generated_at: new Date().toISOString(), degraded: null, truncated: false, counts: { events_total: 0, events_reduced: 0, nodes_reduced: 0, node_states: 0 } };
    if (!attentionPresent(db))
        return { ...out, degraded: { reason: 'attention schema unavailable' } };
    const session = getAttentionSession(db, opts.session_id);
    if (!session)
        return out;
    const limit = limitOf(opts.limit);
    for (const n of [opts.through_sequence, opts.before])
        if (n !== undefined && (!Number.isSafeInteger(n) || n < 0))
            throw new Error('sequence must be a non-negative safe integer');
    const through = Math.min(opts.through_sequence ?? session.last_sequence, session.last_sequence);
    // The window is anchored at the cutoff, so a past snapshot replays identically.
    const total = (db.prepare('SELECT COUNT(*) AS n FROM attention_events WHERE session_id = ? AND sequence <= ?').get(session.id, through) as { n: number }).n;
    const rows = db.prepare('SELECT * FROM attention_events WHERE session_id = ? AND sequence <= ? ORDER BY sequence DESC LIMIT ?').all(session.id, through, SNAPSHOT_EVENT_WINDOW) as Record<string, unknown>[];
    const events = rows.reverse().map(eventFromRow);
    const epoch = events.at(-1)?.context_epoch ?? 0;
    // Session-level facts come from the whole cutoff, never only the window.
    const endRow = db.prepare("SELECT * FROM attention_events WHERE session_id = ? AND sequence <= ? AND kind = 'end' ORDER BY sequence DESC LIMIT 1").get(session.id, through) as Record<string, unknown> | undefined;
    const end = endRow ? eventFromRow(endRow) : undefined;
    const compacted = !!db.prepare("SELECT 1 FROM attention_events WHERE session_id = ? AND sequence <= ? AND kind = 'epoch' LIMIT 1").get(session.id, through);
    out.session = { ...session, current_epoch: epoch, status: end ? session.status : 'active', ended_at: end?.observed_at ?? null, coverage: { ...session.coverage, compaction: compacted ? 'observed' : 'unknown' } };
    const gaps = (db.prepare(`SELECT DISTINCT reason FROM attention_events WHERE session_id = ? AND sequence <= ? AND kind = 'invocation' AND origin = 'tool_boundary' AND reason IN (${CAPTURE_GAPS.map(() => '?').join(',')})`).all(session.id, through, ...CAPTURE_GAPS) as { reason: string }[]).map(r => r.reason);
    if (gaps.length) {
        const ordered = CAPTURE_GAPS.filter(gap => gaps.includes(gap));
        out.session.coverage.gaps = [...new Set([...out.session.coverage.gaps, ...ordered])];
        out.degraded = { reason: ordered.join(' ') };
    }
    out.through_sequence = through;
    out.latest_sequence = session.last_sequence;
    const groups = new Map<string, AttentionEvent[]>();
    for (const event of events) {
        if (!event.node)
            continue;
        const key = encodeNodeKey(event.node);
        const group = groups.get(key) ?? [];
        group.push(event);
        groups.set(key, group);
    }
    for (const [key, all] of groups) {
        const current = all.filter(e => e.context_epoch === epoch);
        const historical = current.length === 0;
        const candidates = historical ? all : current;
        const successful = candidates.filter(e => e.outcome === 'succeeded');
        const direct = successful.filter(e => e.origin !== 'self_report');
        const preferred = direct.length ? direct : successful;
        const full = preferred.find(e => e.kind === 'delivery' && e.extent === 'full');
        const preview = preferred.find(e => e.kind === 'delivery' && e.extent === 'preview');
        const invocation = preferred.find(e => e.kind === 'invocation');
        const available = preferred.find(e => e.kind === 'availability');
        const last = candidates.at(-1)!;
        let state: AttentionNodeState['state'] = full ? 'full' : preview ? 'preview' : invocation ? 'invoked' : available ? 'available' : last.outcome === 'failed' ? 'failed' : 'unknown';
        if (historical)
            state = 'historical';
        const representative = full ?? preview ?? invocation ?? available ?? last;
        out.node_states.push({ key, node: last.node!, state, self_reported: representative.origin === 'self_report', historical, last_event: last, events: [...new Map([representative, ...all.slice(-(NODE_EVENT_LIMIT - 1))].map(e => [e.id, e])).values()].sort((a, b) => a.sequence - b.sequence) });
    }
    const nodes = out.node_states.length;
    if (nodes > SNAPSHOT_NODE_LIMIT) {
        const kept = new Set([...out.node_states].sort((a, b) => b.last_event.sequence - a.last_event.sequence).slice(0, SNAPSHOT_NODE_LIMIT).map(s => s.key));
        out.node_states = out.node_states.filter(s => kept.has(s.key));
    }
    out.truncated = events.length < total || out.node_states.length < nodes;
    out.counts = { events_total: total, events_reduced: events.length, nodes_reduced: nodes, node_states: out.node_states.length };
    if (out.truncated) {
        // Also stated as degradation, so a reader that predates `truncated` never drops activity silently.
        const bounded = `Snapshot bounded: ${out.node_states.length} of ${nodes} recorded nodes from the newest ${events.length} of ${total} events; older evidence is in history.`;
        out.degraded = { reason: out.degraded ? `${out.degraded.reason} ${bounded}` : bounded };
    }
    // History pages independently of the reducer window.
    const page = (opts.before === undefined
        ? db.prepare('SELECT * FROM attention_events WHERE session_id = ? AND sequence <= ? ORDER BY sequence DESC LIMIT ?').all(session.id, through, limit + 1)
        : db.prepare('SELECT * FROM attention_events WHERE session_id = ? AND sequence <= ? AND sequence < ? ORDER BY sequence DESC LIMIT ?').all(session.id, through, opts.before, limit + 1)) as Record<string, unknown>[];
    out.recent_events = page.slice(0, limit).map(eventFromRow);
    out.next_before = page.length > limit ? out.recent_events.at(-1)!.sequence : null;
    return out;
}
