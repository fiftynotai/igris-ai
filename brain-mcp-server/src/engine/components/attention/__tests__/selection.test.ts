import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeAttention, sessionAction, eventAction, readAttentionResource } from '../actions.js';
import { callAttentionTool, observeDelivery } from '../capture.js';
import { readAttentionSnapshot, listAttentionSessions } from '../read.js';
import { runComponentMigrations } from '../../../storage/sqlite.js';
import { attentionMigrations } from '../schema.js';
import type { AttentionSelection } from '../types.js';

const dbs: Database.Database[] = [];
const dirs: string[] = [];
const node = { type: 'learning', project: 'alpha', id: '7' };
afterEach(() => {
    for (const db of dbs.splice(0)) if (db.open) db.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
    const db = new Database(':memory:');
    dbs.push(db);
    initializeAttention(db);
    const id = sessionAction(db, { action: 'begin', project: 'alpha' }).session!.id;
    return { db, id };
}
function events(db: Database.Database, id: string) {
    // `[...].reverse()`, not `toReversed()`: the package compiles against lib ES2022.
    return [...readAttentionSnapshot(db, { session_id: id }).recent_events].reverse();
}
function resourceFixture() {
    const root = mkdtempSync(join(tmpdir(), 'fr276-selection-'));
    dirs.push(root);
    mkdirSync(join(root, 'core', 'os'), { recursive: true });
    writeFileSync(join(root, 'core', 'os', 'INDEX.md'), '| module | layer | tier | scope | summary | consult_when |\n|---|---|---|---|---|---|\n| standards | conduct | boot | universal | Standards | — |\n');
    writeFileSync(join(root, 'core', 'os', 'standards.md'), 'actual standards');
    return root;
}

describe('FR-276 selection migration and evidence', () => {
    it('reads real v1 files without migration and preserves legacy evidence through the v2 upgrade', () => {
        const root = mkdtempSync(join(tmpdir(), 'fr276-selection-v1-'));
        dirs.push(root);
        const path = join(root, 'brain.db');
        const legacy = new Database(path);
        dbs.push(legacy);
        runComponentMigrations(legacy, 'attention', attentionMigrations.slice(0, 1));
        const id = sessionAction(legacy, { action: 'begin', project: 'alpha' }).session!.id;
        legacy.prepare("INSERT INTO attention_events(session_id,sequence,context_epoch,actor_id,operation_id,event_key,kind,node_type,node_project,node_id,outcome,extent,origin,reason) VALUES(?,1,0,'orchestrator','legacy-op','delivery','delivery','learning','alpha','7','succeeded','full','loader','legacy failure-independent note')").run(id);
        legacy.prepare('UPDATE attention_sessions SET last_sequence=1 WHERE id=?').run(id);
        legacy.close();
        const before = readFileSync(path);
        const readonly = new Database(path, { readonly: true, fileMustExist: true });
        dbs.push(readonly);
        readonly.pragma('query_only=ON');
        const oldEvent = events(readonly, id)[0]!;
        expect(oldEvent.selection).toBeNull();
        expect(oldEvent.reason).toBe('legacy failure-independent note');
        expect(listAttentionSessions(readonly).sessions).toHaveLength(1);
        expect(readonly.prepare("SELECT version FROM engine_migrations WHERE component='attention'").all()).toEqual([{ version: 1 }]);
        expect(readonly.prepare('PRAGMA table_info(attention_events)').all().some((row: any) => row.name === 'selection')).toBe(false);
        readonly.close();
        expect(readFileSync(path)).toEqual(before);
        const upgraded = new Database(path);
        dbs.push(upgraded);
        initializeAttention(upgraded);
        initializeAttention(upgraded);
        expect(upgraded.prepare("SELECT version FROM engine_migrations WHERE component='attention'").all()).toEqual([{ version: 1 }, { version: 2 }]);
        expect(events(upgraded, id)).toEqual([oldEvent]);
        const next = eventAction(upgraded, { session_id: id, node, kind: 'delivery', outcome: 'succeeded', selection: { category: 'task', reference: 'FR-276' } });
        expect(next.event!.sequence).toBe(2);
        expect(next.event!.selection).toEqual({ category: 'task', provenance: 'caller_declared', reference: 'FR-276' });
        expect(events(upgraded, id)[0]).toEqual(oldEvent);
    });

    it('compares selection metadata on retries while keeping failure reason independent', () => {
        const { db, id } = fixture();
        const input = { session_id: id, operation_id: 'same-delivery', node, kind: 'delivery', outcome: 'failed', reason: 'resource unavailable', selection: { category: 'boot', reference: 'boot:core' } };
        const first = eventAction(db, input);
        expect(first.ok).toBe(true);
        expect(eventAction(db, input).event).toEqual(first.event);
        for (const selection of [undefined, { category: 'task', reference: 'boot:core' }, { category: 'boot', reference: 'boot:user' }])
            expect(eventAction(db, { ...input, selection }).reason).toBe('operation evidence conflict');
        expect(events(db, id)).toHaveLength(1);
        expect(first.event!.selection).toEqual({ category: 'boot', provenance: 'caller_declared', reference: 'boot:core' });
        expect(first.event!.origin).toBe('self_report');
        expect(first.event!.reason).toBe('resource unavailable');
        const absentRef = eventAction(db, { ...input, operation_id: 'omitted-reference', selection: { category: 'user_request' } });
        expect(absentRef.event!.selection!.reference).toBeNull();
        expect(eventAction(db, { ...input, operation_id: 'maximum-reference', selection: { category: 'task', reference: 'a'.repeat(128) } }).ok).toBe(true);
    });

    it('records boot declarations for actual loader start/success and failures, preserving replay', () => {
        const { db, id } = fixture();
        const root = resourceFixture();
        const selection = { category: 'boot', reference: 'boot:core' };
        const resource = { type: 'os_module', project: null, id: 'igris-core:standards' };
        const input = { session_id: id, node: resource, operation_id: 'boot-read', selection };
        const result = readAttentionResource(db, input, { brain_root: root });
        expect(result.content).toBe('actual standards');
        const recorded: AttentionSelection = { ...selection, category: 'boot', provenance: 'caller_declared' };
        expect(events(db, id).map(event => event.selection)).toEqual([recorded, recorded]);
        expect(readAttentionResource(db, input, { brain_root: root }).result.reason).toMatch(/Duplicate/);
        const failed = readAttentionResource(db, { ...input, operation_id: 'missing', node: { ...resource, id: 'igris-core:missing' } }, { brain_root: root });
        expect(failed.content).toBeNull();
        expect(failed.result.event!.selection).toEqual(recorded);
        expect(failed.result.event!.reason).toContain('unavailable');
        expect(readAttentionSnapshot(db, { session_id: id, through_sequence: 2 }).recent_events.map(event => event.selection)).toEqual([recorded, recorded]);
    });
});

const invalidSelections = [
    null, 'boot', [], {}, { category: 1 }, { category: 'BOOT' }, { category: 'unknown' },
    { category: 'boot', provenance: 'observed' }, { category: 'boot', provenance: 'caller_declared' },
    { category: 'task', query: 'private question' },
    ...[null, 1, '', 'a'.repeat(129), '/private/path', 'file.md', 'why this', 'query?x=1', 'line\nbreak', 'trailing\n', 'trailing\r', 'trailing\r\n'].map(reference => ({ category: 'task', reference })),
];
describe('FR-276 strict public selection input', () => {
    it.each(invalidSelections)('rejects %j before any event, resource read, or tool side effect', async selection => {
        const { db, id } = fixture();
        const before = db.prepare('SELECT total_changes() AS n').get();
        const report = eventAction(db, { session_id: id, node, kind: 'delivery', outcome: 'succeeded', selection });
        expect(report.ok).toBe(false);
        expect(report.reason).toMatch(/invalid selection/);
        const resource = readAttentionResource(db, { session_id: id, node: { type: 'os_module', project: null, id: 'igris-core:standards' }, selection });
        expect(resource.content).toBeNull();
        expect(resource.result.reason).toMatch(/invalid selection/);
        let calls = 0;
        const call = await callAttentionTool(db, { session_id: id, tool: 'fixture', arguments: {}, selection }, async () => { calls++; return { content: [] }; });
        expect(call.isError).toBe(true);
        expect(calls).toBe(0);
        expect(events(db, id)).toEqual([]);
        expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    });
});

describe('FR-276 declared intent versus observed retrieval', () => {
    it('propagates declarations without altering the target response or retaining argument prose', async () => {
        const { db, id } = fixture();
        const response = { content: [{ type: 'text', text: 'private returned content' }], structuredContent: { exact: ['shape'] }, _meta: { existing: true } };
        const declaration = { category: 'user_request', reference: 'request:42' };
        const input = { session_id: id, operation_id: 'request-op', tool: 'igris_memory_get', arguments: { private: 'argument prose' }, selection: declaration };
        let calls = 0;
        const dispatch = async () => {
            calls++;
            observeDelivery({ node, outcome: 'succeeded', extent: 'full' });
            return response;
        };
        const actual = await callAttentionTool(db, input, dispatch);
        expect(actual).toEqual({ ...response, _meta: { ...response._meta, igris_attention: { session_id: id, operation_id: 'request-op', recorded: true, reason: null } } });
        expect(actual.content).toBe(response.content);
        expect(actual.structuredContent).toBe(response.structuredContent);
        expect(events(db, id).map(event => event.selection)).toEqual(Array(3).fill({ ...declaration, provenance: 'caller_declared' }));
        expect((await callAttentionTool(db, { ...input, selection: { category: 'task', reference: 'FR-276' } }, dispatch)).isError).toBe(true);
        expect(calls).toBe(1);
        const ledger = JSON.stringify(db.prepare('SELECT * FROM attention_events').all());
        expect(ledger).not.toContain('argument prose');
        expect(ledger).not.toContain('private returned content');
    });

    it('labels only successful known formatter deliveries as observed retrieval', async () => {
        const { db, id } = fixture();
        const cases = [
            { tool: 'igris_memory_get', observation: { node, outcome: 'succeeded' as const }, expected: true },
            { tool: 'igris_memory_get', observation: { node, outcome: 'failed' as const }, expected: false },
            { tool: 'arbitrary_tool', observation: { node, outcome: 'succeeded' as const }, expected: false },
            { tool: 'igris_memory_get', observation: { node: { ...node, type: 'brief' }, outcome: 'succeeded' as const }, expected: false },
            { tool: 'igris_memory_get', observation: { node, outcome: 'succeeded' as const }, error: true, expected: false },
        ];
        for (const [index, test] of cases.entries()) {
            const op = 'retrieval-' + index;
            const response = { content: [{ type: 'text', text: 'exact response' }], ...(test.error ? { isError: true } : {}) };
            const actual = await callAttentionTool(db, { session_id: id, operation_id: op, tool: test.tool, arguments: {} }, async () => {
                observeDelivery({ ...test.observation, extent: 'full' });
                return response;
            });
            expect(actual.content).toEqual(response.content);
            expect(actual.isError).toBe(response.isError);
            const recorded = events(db, id).filter(event => event.operation_id === op);
            expect(recorded.filter(event => event.kind === 'invocation').every(event => event.selection === null)).toBe(true);
            expect(recorded.find(event => event.kind === 'delivery')!.selection).toEqual(test.expected
                ? { category: 'retrieval', provenance: 'observed', reference: test.tool } : null);
        }
    });
});
