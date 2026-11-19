import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initializeAttention, sessionAction, eventAction, readAttentionResource } from '../actions.js';
import { getAttentionSession, readAttentionSnapshot, listAttentionSessions, SNAPSHOT_EVENT_WINDOW, SNAPSHOT_NODE_LIMIT, NODE_EVENT_LIMIT } from '../read.js';
import { appendEvent } from '../store.js';
import { callAttentionTool, observeDelivery } from '../capture.js';
import { buildAttentionInventory } from '../inventory.js';
import { COLLECTION_GAP, INVOCATION_START_GAP } from '../types.js';
import { createSqliteAdapter } from '../../../storage/sqlite.js';
import { migrateSchema } from '../../../../db.js';
import { attentionMigrations } from '../schema.js';
import { createGateway } from '../../../gateway.js';
import type { ToolInputSchema } from '../../../types.js';
import { SYNC_TABLES, processSyncPush } from '../../../../tools/sync.js';
import { buildEgressManifest } from '../../../../tools/egress-manifest.js';
const dbs: Database.Database[] = [];
const dirs: string[] = [];
afterEach(() => {
    for (const db of dbs.splice(0))
        if (db.open)
            db.close();
    for (const dir of dirs.splice(0))
        rmSync(dir, { recursive: true, force: true });
});
function fixture() {
    const db = new Database(':memory:');
    dbs.push(db);
    initializeAttention(db);
    return db;
}
function begin(db: Database.Database, project = 'same-project') {
    const result = sessionAction(db, { action: 'begin', project });
    expect(result.ok).toBe(true);
    return result.session!.id;
}
const node = { type: 'learning', project: 'origin-project', id: '7' };
function observed(db: Database.Database, id: string, extent: 'full' | 'preview' = 'full') {
    return appendEvent(db, { session_id: id, event_key: 'delivery', operation_id: randomUUID(), kind: 'delivery', node, outcome: 'succeeded', extent, origin: 'tool_boundary' });
}
function rootFixture() {
    const dir = mkdtempSync(join(tmpdir(), 'fr276-inventory-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'core', 'os'), { recursive: true });
    writeFileSync(join(dir, 'core', 'os', 'INDEX.md'), '| module | layer | tier | scope | summary | consult_when |\n|---|---|---|---|---|---|\n| standards | conduct | boot | universal | Standards | — |\n| USER | operator | boot | orchestrator | User | — |\n');
    writeFileSync(join(dir, 'core', 'os', 'standards.md'), 'safe content');
    writeFileSync(join(dir, 'USER.md'), 'operator preferences');
    return dir;
}
describe('FR-276 schema and lifecycle evidence', () => {
    it('runs the real legacy and component migration chain idempotently', () => {
        const dir = mkdtempSync(join(tmpdir(), 'fr276-schema-'));
        dirs.push(dir);
        const storage = createSqliteAdapter(join(dir, 'brain.db'));
        dbs.push(storage.rawConnection);
        migrateSchema(storage.rawConnection);
        storage.runMigrations('attention', attentionMigrations);
        initializeAttention(storage.rawConnection);
        expect(storage.rawConnection.prepare("SELECT version FROM engine_migrations WHERE component='attention'").all()).toEqual([{ version: 1 }, { version: 2 }]);
        expect(storage.rawConnection.prepare("PRAGMA foreign_key_list(attention_sessions)").all()).toEqual([]);
    });
    it('keeps local tables out of replication', () => {
        const names = SYNC_TABLES.map(t => t.table);
        for (const name of ['attention_sessions', 'attention_events', 'attention_tool_inventory'])
            expect(names).not.toContain(name);
    });
    it('ignores injected attention replication and omits telemetry from generated disclosure', () => {
        const db = fixture(), id = begin(db);
        observed(db, id);
        const before = db.prepare('SELECT * FROM attention_sessions').all();
        const push = processSyncPush(db, { attention_sessions: [{ id, project: 'injected' }], attention_events: [{ session_id: id, sequence: 99 }], attention_tool_inventory: [{ provider: 'remote', name: 'secret-tool' }] });
        expect(push.results).toEqual({});
        expect(db.prepare('SELECT * FROM attention_sessions').all()).toEqual(before);
        expect(db.prepare('SELECT COUNT(*) AS n FROM attention_events').get()).toEqual({ n: 1 });
        expect(buildEgressManifest(SYNC_TABLES).markdown).not.toContain('attention_');
    });
    it('rejects conflicting self-report retry evidence', () => {
        const db = fixture(), id = begin(db);
        const input = { session_id: id, operation_id: 'reported-read', event_key: 'read-event', node, kind: 'delivery', outcome: 'succeeded', extent: 'full' };
        expect(eventAction(db, input).ok).toBe(true);
        expect(eventAction(db, input).ok).toBe(true);
        expect(eventAction(db, { ...input, extent: 'preview' }).reason).toBe('operation evidence conflict');
        expect(readAttentionSnapshot(db, { session_id: id }).latest_sequence).toBe(1);
    });
    it('keeps multiple lifecycle phases and returned nodes under one operation idempotent', () => {
        const db = fixture(), id = begin(db);
        const start = { session_id: id, operation_id: 'external-op', kind: 'invocation', node, outcome: 'started' };
        const done = { ...start, outcome: 'succeeded' };
        const second = { ...done, node: { ...node, id: '8' } };
        for (const input of [start, done, second]) {
            const first = eventAction(db, input);
            const retry = eventAction(db, input);
            expect(first.ok).toBe(true);
            expect(retry.event!.id).toBe(first.event!.id);
        }
        const snapshot = readAttentionSnapshot(db, { session_id: id });
        expect(snapshot.latest_sequence).toBe(3);
        expect(snapshot.node_states.map(s => s.state)).toEqual(['invoked', 'invoked']);
    });
    it('reports a missing listed resource as an inventory gap', () => {
        const db = fixture(), root = rootFixture();
        rmSync(join(root, 'core', 'os', 'standards.md'));
        const inventory = buildAttentionInventory(db, { brain_root: root });
        expect(inventory.nodes.some(n => n.id === 'igris-core:standards')).toBe(false);
        expect(inventory.sources.some(s => !s.available && s.source.includes('standards'))).toBe(true);
    });
    it('isolates two chats in one project, binds early events, and refuses identity overwrite', () => {
        const db = fixture(), a = begin(db), b = begin(db);
        observed(db, a);
        expect(sessionAction(db, { action: 'bind', session_id: a, instance_id: 'instance-a', harness_session_id: 'chat-a' }).ok).toBe(true);
        expect(sessionAction(db, { action: 'bind', session_id: a, instance_id: 'instance-b' }).ok).toBe(false);
        expect(readAttentionSnapshot(db, { session_id: a }).node_states[0]!.node.project).toBe('origin-project');
        expect(readAttentionSnapshot(db, { session_id: b }).node_states).toEqual([]);
        expect(getAttentionSession(db, a)!.instance_id).toBe('instance-a');
    });
    it('refuses a path-shaped instance identity on begin and bind, as session register does', () => {
        const db = fixture(), a = begin(db);
        for (const bad of ['../../etc', 'a/b', 'instance a', 'x'.repeat(257), 'inst\n', '', 7]) {
            const bound = sessionAction(db, { action: 'bind', session_id: a, instance_id: bad });
            expect(bound, JSON.stringify(bad)).toMatchObject({ ok: false, degraded: false, reason: 'invalid instance_id' });
            const begun = sessionAction(db, { action: 'begin', instance_id: bad });
            expect(begun, JSON.stringify(bad)).toMatchObject({ ok: false, degraded: false, reason: 'invalid instance_id' });
        }
        expect(getAttentionSession(db, a)!.instance_id).toBeNull();
        expect(listAttentionSessions(db).sessions).toHaveLength(1);
        expect(sessionAction(db, { action: 'bind', session_id: a, instance_id: 'instance_A-1' }).ok).toBe(true);
        expect(sessionAction(db, { action: 'begin', instance_id: 'x'.repeat(256) }).ok).toBe(true);
    });
    it('preserves explicit parent lineage and rejects nonexistent parents', () => {
        const db = fixture(), parent = begin(db);
        const child = sessionAction(db, { action: 'begin', project: 'same-project', parent_session_id: parent });
        expect(child.session!.parent_session_id).toBe(parent);
        expect(sessionAction(db, { action: 'begin', parent_session_id: randomUUID() }).ok).toBe(false);
    });
    it('records only self-reported provenance through the public report action', () => {
        const db = fixture(), id = begin(db);
        const r = eventAction(db, { session_id: id, node, kind: 'delivery', outcome: 'succeeded', extent: 'full', origin: 'tool_boundary' });
        expect(r.event!.origin).toBe('self_report');
        expect(readAttentionSnapshot(db, { session_id: id }).node_states[0]!.self_reported).toBe(true);
    });
    it('does not turn availability into invocation or delivery', () => {
        const db = fixture(), id = begin(db);
        eventAction(db, { session_id: id, node, kind: 'availability', outcome: 'succeeded' });
        expect(readAttentionSnapshot(db, { session_id: id }).node_states[0]!.state).toBe('available');
    });
    it('advances an epoch once, keeps history, and derives replay coverage from cutoff', () => {
        const db = fixture(), id = begin(db);
        const old = observed(db, id);
        sessionAction(db, { action: 'epoch', session_id: id, operation_id: 'compact-1', reason: 'observed reset' });
        sessionAction(db, { action: 'epoch', session_id: id, operation_id: 'compact-1' });
        expect(getAttentionSession(db, id)!.current_epoch).toBe(1);
        expect(readAttentionSnapshot(db, { session_id: id }).node_states[0]!.state).toBe('historical');
        const past = readAttentionSnapshot(db, { session_id: id, through_sequence: old.sequence });
        expect(past.node_states[0]!.state).toBe('full');
        expect(past.session!.coverage.compaction).toBe('unknown');
        observed(db, id, 'preview');
        expect(readAttentionSnapshot(db, { session_id: id }).node_states[0]!.state).toBe('preview');
    });
    it('retains decisive successful evidence when later attempts fail repeatedly', () => {
        const db = fixture(), id = begin(db);
        const full = observed(db, id);
        for (let i = 0; i < 30; i++)
            appendEvent(db, { session_id: id, event_key: 'failed', kind: 'delivery', node, outcome: 'failed', origin: 'loader' });
        const state = readAttentionSnapshot(db, { session_id: id }).node_states[0]!;
        expect(state.state).toBe('full');
        expect(state.events.length).toBeLessThanOrEqual(20);
        expect(state.events.map(e => e.id)).toContain(full.id);
        expect(state.last_event.outcome).toBe('failed');
    });
    it('ends independently of instances and forbids further reports', () => {
        const db = fixture(), id = begin(db);
        observed(db, id);
        expect(sessionAction(db, { action: 'end', session_id: id }).ok).toBe(true);
        expect(readAttentionSnapshot(db, { session_id: id }).session!.status).toBe('ended');
        expect(eventAction(db, { session_id: id, node, kind: 'delivery', outcome: 'succeeded' }).ok).toBe(false);
        expect(readAttentionSnapshot(db, { session_id: id }).node_states).toHaveLength(1);
    });
    it('uses stable pagination and reports missing schema without creating tables', () => {
        const db = fixture();
        begin(db);
        begin(db);
        const first = listAttentionSessions(db, { limit: 1 });
        expect(first.next_before).not.toBeNull();
        const next = listAttentionSessions(db, { limit: 1, before: first.next_before! });
        expect(next.sessions[0]!.id).not.toBe(first.sessions[0]!.id);
        const blank = new Database(':memory:');
        dbs.push(blank);
        expect(readAttentionSnapshot(blank, { session_id: randomUUID() }).degraded).not.toBeNull();
        expect(blank.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'attention_%'").all()).toEqual([]);
    });
    it('can read snapshots with query_only enforced', () => {
        const db = fixture(), id = begin(db);
        observed(db, id);
        db.pragma('query_only=ON');
        expect(readAttentionSnapshot(db, { session_id: id }).node_states).toHaveLength(1);
        expect(listAttentionSessions(db).sessions).toHaveLength(1);
    });
});
describe('FR-276 scoped calls and resource evidence', () => {
    it('keeps concurrent async calls isolated and leaves direct observers inert', async () => {
        const db = fixture(), a = begin(db), b = begin(db);
        observeDelivery({ node, outcome: 'succeeded', extent: 'full' });
        const dispatch = async (_name: string, args: Record<string, unknown>) => {
            await new Promise(r => setTimeout(r, args.delay as number));
            observeDelivery({ node: { ...node, id: String(args.id) }, outcome: 'succeeded', extent: 'preview' });
            return { content: [{ type: 'text', text: String(args.id) }] };
        };
        const [ra, rb] = await Promise.all([callAttentionTool(db, { session_id: a, tool: 'fixture', arguments: { id: 'a', delay: 15 } }, dispatch), callAttentionTool(db, { session_id: b, tool: 'fixture', arguments: { id: 'b', delay: 1 } }, dispatch)]);
        expect(ra.content[0]!.text).toBe('a');
        expect(rb.content[0]!.text).toBe('b');
        const aNodes = readAttentionSnapshot(db, { session_id: a }).node_states.filter(n => n.node.type === 'learning');
        expect(aNodes.map(n => n.node.id)).toEqual(['a']);
        expect(readAttentionSnapshot(db, { session_id: b }).node_states.filter(n => n.node.type === 'learning').map(n => n.node.id)).toEqual(['b']);
    });
    it('uses the real strict gateway, refuses duplicate side effects, and never stores arguments', async () => {
        const db = fixture(), id = begin(db);
        const gateway = createGateway();
        let calls = 0;
        gateway.register([{ name: 'fixture', description: 'fixture', inputSchema: { type: 'object', additionalProperties: false, properties: { secret: {} }, required: ['secret'] }, handler: () => {
                    calls++;
                    return { content: [{ type: 'text', text: 'ok' }] };
                } }]);
        const input = { session_id: id, tool: 'fixture', operation_id: 'one', arguments: { secret: 'TOP-SECRET' } };
        await callAttentionTool(db, input, gateway.dispatch);
        const duplicate = await callAttentionTool(db, input, gateway.dispatch);
        expect(duplicate.isError).toBe(true);
        expect(calls).toBe(1);
        const invalid = await callAttentionTool(db, { ...input, operation_id: 'two', arguments: { secret: 'TOP-SECRET', extra: 1 } }, gateway.dispatch);
        expect(invalid.isError).toBe(true);
        expect(calls).toBe(1);
        expect(JSON.stringify(db.prepare('SELECT * FROM attention_events').all())).not.toContain('TOP-SECRET');
        expect(readAttentionSnapshot(db, { session_id: id }).recent_events[0]!.outcome).toBe('failed');
    });
    it('persists bounded-capture gaps and reveals them only after their replay cutoff', async () => {
        const db = fixture(), id = begin(db);
        const result = await callAttentionTool(db, { session_id: id, tool: 'fixture', arguments: {} }, async () => {
            for (let i = 0; i < 201; i++)
                observeDelivery({ node: { ...node, id: String(i) }, outcome: 'succeeded', extent: 'preview' });
            return { content: [{ type: 'text', text: 'all 201 references delivered' }] };
        });
        expect(result.content[0]!.text).toBe('all 201 references delivered');
        expect((result._meta as any).igris_attention.recorded).toBe(false);
        const snapshot = readAttentionSnapshot(db, { session_id: id });
        expect(snapshot.session!.coverage.gaps).toContain('Observation collection incomplete or bounded at 200 records.');
        expect(snapshot.degraded).not.toBeNull();
        // The capture bound: exactly 200 observations persisted. The snapshot then bounds its node states.
        expect(db.prepare("SELECT COUNT(*) AS n FROM attention_events WHERE kind = 'delivery' AND node_type = 'learning'").get()).toEqual({ n: 200 });
        expect(snapshot.counts.nodes_reduced).toBe(201);
        expect(snapshot.node_states).toHaveLength(SNAPSHOT_NODE_LIMIT);
        expect(readAttentionSnapshot(db, { session_id: id, through_sequence: 1 }).degraded).toBeNull();
    });
    it('refuses unknown same-brain identity before dispatch', async () => {
        const db = fixture();
        let calls = 0;
        const r = await callAttentionTool(db, { session_id: randomUUID(), tool: 'fixture', arguments: {} }, async () => {
            calls++;
            return { content: [] };
        });
        expect(r.isError).toBe(true);
        expect(calls).toBe(0);
    });
    it('never records delivery for a thrown or error target, and returns native error text without recording it', async () => {
        const db = fixture(), id = begin(db);
        const gateway = createGateway();
        const schema: ToolInputSchema = { type: 'object', additionalProperties: false, properties: { secret: {} } };
        gateway.register([
            { name: 'thrower', description: 'fixture', inputSchema: schema, handler: () => {
                    observeDelivery({ node, outcome: 'succeeded', extent: 'full', bytes: 9 });
                    throw new Error('native failure detail');
                } },
            { name: 'reporter', description: 'fixture', inputSchema: schema, handler: () => {
                    observeDelivery({ node: { ...node, id: '8' }, outcome: 'succeeded', extent: 'preview', bytes: 4 });
                    return { isError: true, content: [{ type: 'text', text: 'native error body' }] };
                } },
        ]);
        const thrown = await callAttentionTool(db, { session_id: id, tool: 'thrower', arguments: { secret: 'TOP-SECRET' } }, gateway.dispatch);
        expect(thrown.isError).toBe(true);
        expect(thrown.content).toEqual([{ type: 'text', text: 'Error executing thrower: native failure detail' }]);
        const reported = await callAttentionTool(db, { session_id: id, tool: 'reporter', arguments: { secret: 'TOP-SECRET' } }, gateway.dispatch);
        expect(reported.isError).toBe(true);
        expect(reported.content).toEqual([{ type: 'text', text: 'native error body' }]);
        const snapshot = readAttentionSnapshot(db, { session_id: id });
        expect(snapshot.node_states.filter(s => s.node.type === 'learning').map(s => s.state)).toEqual(['failed', 'failed']);
        expect(snapshot.recent_events.filter(e => e.event_key === 'invocation:end').map(e => e.outcome)).toEqual(['failed', 'failed']);
        const rows = db.prepare('SELECT * FROM attention_events').all() as Record<string, unknown>[];
        expect(rows.filter(r => r.kind === 'delivery' && (r.outcome === 'succeeded' || r.extent === 'full' || r.extent === 'preview'))).toEqual([]);
        expect(JSON.stringify(rows)).not.toMatch(/TOP-SECRET|native failure detail|native error body/);
    });
    it('returns the native strict-input rejection text, which names keys and never values', async () => {
        const db = fixture(), id = begin(db);
        const gateway = createGateway();
        gateway.register([{ name: 'fixture', description: 'fixture', inputSchema: { type: 'object', additionalProperties: false, properties: { secret: {} }, required: ['secret'] }, handler: () => ({ content: [] }) }]);
        const extra = await callAttentionTool(db, { session_id: id, tool: 'fixture', arguments: { secret: 'TOP-SECRET', extra: 1 } }, gateway.dispatch);
        expect(extra.content[0]!.text).toMatch(/^Error executing fixture: fixture: unknown argument 'extra'\./);
        const missing = await callAttentionTool(db, { session_id: id, tool: 'fixture', arguments: {} }, gateway.dispatch);
        expect(missing.content[0]!.text).toMatch(/^Error executing fixture: fixture: missing required argument 'secret'\./);
        expect(JSON.stringify([extra, missing])).not.toContain('TOP-SECRET');
    });
    it('records a partial miss as a succeeded invocation with per-node failed evidence', async () => {
        const db = fixture(), id = begin(db);
        const r = await callAttentionTool(db, { session_id: id, tool: 'fixture', arguments: {} }, async () => {
            observeDelivery({ node, outcome: 'succeeded', extent: 'full', bytes: 5 });
            observeDelivery({ node: { ...node, id: 'missing' }, outcome: 'failed', extent: 'unknown', reason: 'not found' });
            return { content: [{ type: 'text', text: 'one found, one missing' }] };
        });
        expect(r.isError).toBeUndefined();
        const snapshot = readAttentionSnapshot(db, { session_id: id });
        expect(snapshot.recent_events.find(e => e.event_key === 'invocation:end')!.outcome).toBe('succeeded');
        expect(Object.fromEntries(snapshot.node_states.map(s => [s.node.id, s.state]))).toEqual({ 'igris-brain:fixture': 'invoked', '7': 'full', missing: 'failed' });
    });
    it('still dispatches when the pre-dispatch ledger write fails, and records the start gap', async () => {
        const db = fixture(), id = begin(db);
        let calls = 0;
        db.pragma('query_only=ON');
        const r = await callAttentionTool(db, { session_id: id, tool: 'fixture', arguments: {} }, async () => {
            calls++;
            // The ledger recovers before the target completes, so the end is recorded.
            db.pragma('query_only=OFF');
            observeDelivery({ node, outcome: 'succeeded', extent: 'full', bytes: 5 });
            return { content: [{ type: 'text', text: 'native result' }] };
        });
        expect(calls).toBe(1);
        expect(r.isError).toBeUndefined();
        expect(r.content).toEqual([{ type: 'text', text: 'native result' }]);
        expect((r._meta as any).igris_attention).toMatchObject({ recorded: false, reason: INVOCATION_START_GAP });
        const snapshot = readAttentionSnapshot(db, { session_id: id });
        expect(snapshot.recent_events.map(e => e.event_key).sort()).toEqual(['delivery:0', 'invocation:end']);
        expect(snapshot.session!.coverage.gaps).toContain(INVOCATION_START_GAP);
        expect(snapshot.degraded).toEqual({ reason: INVOCATION_START_GAP });
        // A ledger that stays down still never refuses the native call.
        db.pragma('query_only=ON');
        const down = await callAttentionTool(db, { session_id: id, tool: 'fixture', arguments: {} }, async () => {
            calls++;
            return { content: [{ type: 'text', text: 'still native' }] };
        });
        db.pragma('query_only=OFF');
        expect(calls).toBe(2);
        expect(down.content).toEqual([{ type: 'text', text: 'still native' }]);
        expect((down._meta as any).igris_attention.recorded).toBe(false);
    });
    it('keeps refusing unknown identity and duplicate operations when the ledger cannot record', async () => {
        const db = fixture(), id = begin(db);
        let calls = 0;
        const dispatch = async () => {
            calls++;
            return { content: [] };
        };
        await callAttentionTool(db, { session_id: id, tool: 'fixture', operation_id: 'once', arguments: {} }, dispatch);
        db.pragma('query_only=ON');
        expect((await callAttentionTool(db, { session_id: randomUUID(), tool: 'fixture', arguments: {} }, dispatch)).isError).toBe(true);
        expect((await callAttentionTool(db, { session_id: id, tool: 'fixture', operation_id: 'once', arguments: {} }, dispatch)).isError).toBe(true);
        db.pragma('query_only=OFF');
        expect(calls).toBe(1);
    });
    it('preserves a successful target result if end recording becomes unavailable', async () => {
        const db = fixture(), id = begin(db);
        const r = await callAttentionTool(db, { session_id: id, tool: 'fixture', arguments: {} }, async () => {
            db.pragma('query_only=ON');
            return { content: [{ type: 'text', text: 'delivered' }] };
        });
        expect(r.content[0]!.text).toBe('delivered');
        expect((r._meta as any).igris_attention.recorded).toBe(false);
    });
    it('discovers canonical inventory, distinguishes publication, and blocks arbitrary paths/symlinks', () => {
        const db = fixture(), root = rootFixture();
        db.exec('CREATE TABLE projects(slug TEXT)');
        db.prepare("INSERT INTO attention_tool_inventory(provider,name) VALUES('igris-brain','fixture')").run();
        const inv = buildAttentionInventory(db, { brain_root: root });
        expect(inv.nodes.find(n => n.id === 'igris-brain:fixture')!.attrs.availability_scope).toBe('published');
        expect(inv.nodes.find(n => n.id === 'igris-core:standards')!.attrs.availability_scope).toBe('installed');
        expect(JSON.stringify(inv)).not.toContain('safe content');
        const outside = join(root, 'outside.md');
        writeFileSync(outside, 'private');
        symlinkSync(outside, join(root, 'core', 'os', 'escape.md'));
        writeFileSync(join(root, 'core', 'os', 'INDEX.md'), '| module | layer | tier | scope | summary | consult_when |\n|---|---|---|---|---|---|\n| escape | conduct | boot | universal | Escape | — |\n');
        expect(buildAttentionInventory(db, { brain_root: root }).nodes.some(n => n.id === 'igris-core:escape')).toBe(false);
    });
    it('records exact full/UTF8 preview delivery, refuses changed retry, and shows failures', () => {
        const db = fixture(), id = begin(db), root = rootFixture();
        const resource = { type: 'os_module', project: null, id: 'igris-core:standards' };
        const full = readAttentionResource(db, { session_id: id, node: resource, operation_id: 'read-1' }, { brain_root: root });
        expect(full.content).toBe('safe content');
        expect(full.result.event!.extent).toBe('full');
        writeFileSync(join(root, 'core', 'os', 'standards.md'), 'ééé');
        const retry = readAttentionResource(db, { session_id: id, node: resource, operation_id: 'read-1' }, { brain_root: root });
        expect(retry.content).toBeNull();
        expect(retry.result.reason).toMatch(/Duplicate/);
        const preview = readAttentionResource(db, { session_id: id, node: resource, max_bytes: 3 }, { brain_root: root });
        expect(preview.content).toBe('é');
        expect(preview.result.event!.extent).toBe('preview');
        expect(preview.result.event!.bytes).toBe(2);
        const failed = readAttentionResource(db, { session_id: id, node: { ...resource, id: '../../secret' } }, { brain_root: root });
        expect(failed.result.event!.outcome).toBe('failed');
        expect(failed.content).toBeNull();
    });
});
describe('FR-276 bounded snapshots', () => {
    const selection = { category: 'retrieval' as const, provenance: 'observed' as const, reference: 'igris_memory_get' };
    function busy(db: Database.Database, id: string, events: number, nodes: number, from = 0, allowClosed = false) {
        for (let i = from; i < from + events; i++)
            appendEvent(db, { session_id: id, operation_id: 'op-' + i, event_key: 'delivery:0', kind: 'delivery', node: { type: 'learning', project: 'origin-project', id: String(i % nodes) }, outcome: 'succeeded', extent: 'preview', origin: 'tool_boundary', bytes: 512, source_revision: 'a'.repeat(64), selection }, allowClosed);
    }
    const replayable = (s: ReturnType<typeof readAttentionSnapshot>) => ({ node_states: s.node_states, recent_events: s.recent_events, through_sequence: s.through_sequence, next_before: s.next_before, degraded: s.degraded, truncated: s.truncated, counts: s.counts });
    it('bounds a live-shaped 1,655-event poll by node and per-node caps, with counts', () => {
        // Shaped like the measured live session (35e25be6): 661 start/end call pairs over
        // 13 tools and 333 deliveries over 110 learnings, i.e. 1,655 events on 123 nodes.
        const db = fixture(), id = begin(db);
        const declared = { category: 'task' as const, provenance: 'caller_declared' as const, reference: 'FR-276' };
        for (let i = 0; i < 661; i++) {
            const call = { session_id: id, operation_id: randomUUID(), kind: 'invocation' as const, node: { type: 'tool', project: null, id: 'igris-brain:igris_tool_' + (i % 13) }, origin: 'tool_boundary' as const, selection: declared };
            appendEvent(db, { ...call, event_key: 'invocation:start', outcome: 'started' });
            appendEvent(db, { ...call, event_key: 'invocation:end', outcome: 'succeeded' });
        }
        for (let i = 0; i < 333; i++)
            appendEvent(db, { session_id: id, operation_id: randomUUID(), event_key: 'delivery:0', kind: 'delivery', node: { type: 'learning', project: 'origin-project', id: String(i % 110) }, outcome: 'succeeded', extent: 'preview', origin: 'tool_boundary', bytes: 512, source_revision: 'a'.repeat(64), selection });
        const snapshot = readAttentionSnapshot(db, { session_id: id });
        expect(snapshot.counts).toEqual({ events_total: 1655, events_reduced: 1655, nodes_reduced: 123, node_states: SNAPSHOT_NODE_LIMIT });
        expect(snapshot.truncated).toBe(true);
        expect(Math.max(...snapshot.node_states.map(s => s.events.length))).toBe(NODE_EVENT_LIMIT);
        // The pre-bound reducer returned 450,567 B for this fixture (measured); the bound halves it.
        expect(JSON.stringify(snapshot).length).toBeLessThan(250_000);
    });
    it('caps node states to the most recently active, in first-seen order, and flags truncation', () => {
        const db = fixture(), id = begin(db), nodes = SNAPSHOT_NODE_LIMIT + 10;
        busy(db, id, nodes, nodes);
        const snapshot = readAttentionSnapshot(db, { session_id: id });
        expect(snapshot.node_states.map(s => s.node.id)).toEqual(Array.from({ length: SNAPSHOT_NODE_LIMIT }, (_, i) => String(i + 10)));
        expect(snapshot.truncated).toBe(true);
        expect(snapshot.counts).toEqual({ events_total: nodes, events_reduced: nodes, nodes_reduced: nodes, node_states: SNAPSHOT_NODE_LIMIT });
        // Readers that predate `truncated` still see the bound as degradation, never a silent drop.
        expect(snapshot.degraded!.reason).toBe(`Snapshot bounded: ${SNAPSHOT_NODE_LIMIT} of ${nodes} recorded nodes from the newest ${nodes} of ${nodes} events; older evidence is in history.`);
        const small = fixture(), smallId = begin(small);
        busy(small, smallId, 5, 2);
        expect(readAttentionSnapshot(small, { session_id: smallId })).toMatchObject({ truncated: false, degraded: null, counts: { events_total: 5, events_reduced: 5, nodes_reduced: 2, node_states: 2 } });
    });
    it('reduces a reproducible window of the newest events, keeps session facts and pages history past it', () => {
        const db = fixture(), id = begin(db);
        appendEvent(db, { session_id: id, operation_id: 'gap', event_key: 'invocation:end', kind: 'invocation', node: { type: 'tool', project: null, id: 'igris-brain:fixture' }, outcome: 'succeeded', origin: 'tool_boundary', reason: COLLECTION_GAP });
        sessionAction(db, { action: 'epoch', session_id: id, operation_id: 'compact-1' });
        busy(db, id, SNAPSHOT_EVENT_WINDOW + 3, 3);
        const total = SNAPSHOT_EVENT_WINDOW + 5;
        const snapshot = readAttentionSnapshot(db, { session_id: id });
        expect(snapshot.truncated).toBe(true);
        expect(snapshot.counts).toEqual({ events_total: total, events_reduced: SNAPSHOT_EVENT_WINDOW, nodes_reduced: 3, node_states: 3 });
        expect(snapshot.node_states.map(s => s.node.type)).toEqual(['learning', 'learning', 'learning']);
        // Session-level facts are read at the cutoff, not from the window.
        expect(snapshot.session!.coverage.compaction).toBe('observed');
        expect(snapshot.session!.coverage.gaps).toContain(COLLECTION_GAP);
        expect(snapshot.degraded!.reason).toBe(`${COLLECTION_GAP} Snapshot bounded: 3 of 3 recorded nodes from the newest ${SNAPSHOT_EVENT_WINDOW} of ${total} events; older evidence is in history.`);
        // History paging is independent of the reducer window.
        expect(readAttentionSnapshot(db, { session_id: id, before: 3, limit: 5 }).recent_events.map(e => e.sequence)).toEqual([2, 1]);
        // A past cutoff replays identically after more events arrive.
        const past = readAttentionSnapshot(db, { session_id: id, through_sequence: total });
        busy(db, id, 5, 7, total);
        expect(replayable(readAttentionSnapshot(db, { session_id: id, through_sequence: total }))).toEqual(replayable(past));
    });
    it('reads the end event and capture gaps over the whole cutoff when both sit before the reducer window', () => {
        const db = fixture(), id = begin(db);
        appendEvent(db, { session_id: id, operation_id: 'start-gap', event_key: 'invocation:end', kind: 'invocation', node: { type: 'tool', project: null, id: 'igris-brain:fixture' }, outcome: 'succeeded', origin: 'tool_boundary', reason: INVOCATION_START_GAP });
        const ended = sessionAction(db, { action: 'end', session_id: id });
        expect(ended.ok).toBe(true);
        // Boundary evidence may still land after end (allowClosed); push both facts out of the window.
        // One outer transaction keeps 2,001 appends fast on a loaded machine.
        db.transaction(() => busy(db, id, SNAPSHOT_EVENT_WINDOW + 1, 3, 0, true))();
        const total = SNAPSHOT_EVENT_WINDOW + 3;
        const snapshot = readAttentionSnapshot(db, { session_id: id });
        expect(snapshot.counts).toEqual({ events_total: total, events_reduced: SNAPSHOT_EVENT_WINDOW, nodes_reduced: 3, node_states: 3 });
        // More than SNAPSHOT_EVENT_WINDOW events follow both facts, so neither is in the reduced window.
        expect(total - ended.event!.sequence).toBeGreaterThan(SNAPSHOT_EVENT_WINDOW);
        expect(snapshot.node_states.map(s => s.node.type)).toEqual(['learning', 'learning', 'learning']);
        expect(snapshot.session!.status).toBe('ended');
        expect(snapshot.session!.ended_at).toBe(ended.event!.observed_at);
        expect(snapshot.session!.ended_at).not.toBeNull();
        expect(snapshot.session!.coverage.gaps).toContain(INVOCATION_START_GAP);
        expect(snapshot.degraded!.reason).toBe(`${INVOCATION_START_GAP} Snapshot bounded: 3 of 3 recorded nodes from the newest ${SNAPSHOT_EVENT_WINDOW} of ${total} events; older evidence is in history.`);
        // A cutoff before the end event still replays an active session that already carried the gap.
        const before = readAttentionSnapshot(db, { session_id: id, through_sequence: ended.event!.sequence - 1 });
        expect(before.session).toMatchObject({ status: 'active', ended_at: null });
        expect(before.session!.coverage.gaps).toContain(INVOCATION_START_GAP);
        expect(before.degraded).toEqual({ reason: INVOCATION_START_GAP });
    });
});
describe('FR-276 inventory optional sources', () => {
    function inventoryRoot(db: Database.Database) {
        const root = rootFixture();
        db.exec('CREATE TABLE projects(slug TEXT)');
        db.prepare("INSERT INTO attention_tool_inventory(provider,name) VALUES('igris-brain','fixture')").run();
        for (const type of ['skills', 'agents'])
            mkdirSync(join(root, 'core', type), { recursive: true });
        return root;
    }
    it('reports missing optional loadout/registry directories as absent, not as degraded', () => {
        const db = fixture(), root = inventoryRoot(db);
        const inventory = buildAttentionInventory(db, { brain_root: root });
        expect(inventory.degraded).toBeNull();
        expect(inventory.sources.filter(s => /^(loadout|registry)_/.test(s.source))).toEqual(['loadout_skills', 'loadout_agents', 'registry_skills', 'registry_agents'].map(source => ({ source, available: true, reason: 'absent (optional)' })));
    });
    it('still degrades for a missing required source or an unreadable optional directory', () => {
        const db = fixture(), root = inventoryRoot(db);
        rmSync(join(root, 'core', 'skills'), { recursive: true });
        mkdirSync(join(root, 'registry'));
        writeFileSync(join(root, 'registry', 'skills'), 'not a directory');
        const inventory = buildAttentionInventory(db, { brain_root: root });
        expect(inventory.degraded).toEqual({ reason: 'Partial inventory: core_skills, registry_skills' });
        expect(inventory.sources.find(s => s.source === 'registry_agents')).toEqual({ source: 'registry_agents', available: true, reason: 'absent (optional)' });
    });
});
