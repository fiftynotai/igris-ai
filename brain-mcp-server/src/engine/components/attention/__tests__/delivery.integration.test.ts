import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootEngine, type Engine } from '../../../index.js';
import { sessionAction } from '../actions.js';
import { readAttentionSnapshot as readSnapshot } from '../read.js';
vi.mock('../../../../utils/embeddings.js', async (original) => ({ ...(await original<typeof import('../../../../utils/embeddings.js')>()), generateEmbedding: async () => new Float32Array(384) }));
let engine: Engine | undefined;
let dir: string | undefined;
beforeEach(() => {
    // vitest.setup.ts must fence process-wide singleton/config reads before imports.
    expect(process.env.HOME).toContain('igris-brain-vitest-belt-');
    expect(process.env.HOME).not.toBe(process.env.IGRIS_REAL_HOME);
    expect(process.env.IGRIS_DB_PATH).toBeUndefined();
    expect(process.env.IGRIS_BRAIN_DIR).toBeUndefined();
    vi.stubEnv('IGRIS_DISABLE_VEC', '0');
});
afterEach(() => {
    engine?.shutdown();
    engine = undefined;
    if (dir)
        rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    vi.unstubAllEnvs();
});
function setup() {
    dir = mkdtempSync(join(tmpdir(), 'fr276-delivery-'));
    engine = bootEngine({ dbPath: join(dir, 'brain.db'), components: { schedules: { enabled: false }, sync: { enabled: false }, cognition: { enabled: false }, cache: { enabled: false } } });
    const db = engine.storage.rawConnection;
    db.prepare("INSERT INTO projects(slug,name,path) VALUES('alpha','Alpha','/fixture/alpha'),('other','Other','/fixture/other')").run();
    const session = sessionAction(db, { action: 'begin', project: 'alpha' }).session!;
    const call = (tool: string, args: Record<string, unknown>, selection?: Record<string, unknown>) => engine!.gateway.dispatch('igris_attention_call', { session_id: session.id, tool, arguments: args, ...(selection ? { selection } : {}) });
    return { db, session, call };
}
describe('FR-276 real delivery boundaries', () => {
    it('receives engine.ready data, inventories published tools, and records a full context response only when delivered', async () => {
        const { db, session, call } = setup();
        expect(db.prepare("SELECT name FROM attention_tool_inventory WHERE name='igris_attention_call'").get()).toBeTruthy();
        db.prepare("INSERT INTO context_files(project_slug,key,content,content_hash) VALUES('alpha','architecture_map','actual document','rev1')").run();
        const raw = await engine!.gateway.dispatch('igris_context_get', { project: 'alpha', keys: ['architecture_map'] });
        expect(readSnapshot(db, { session_id: session.id }).recent_events).toHaveLength(0);
        const observed = await call('igris_context_get', { project: 'alpha', keys: ['architecture_map'] });
        expect(observed.content).toEqual(raw.content);
        expect((observed._meta as any).igris_attention.recorded).toBe(true);
        const state = readSnapshot(db, { session_id: session.id }).node_states.find(s => s.node.type === 'context_doc')!;
        expect(state.node).toEqual({ type: 'context_doc', project: 'alpha', id: 'architecture_map' });
        expect(state.state).toBe('full');
        expect(state.last_event.bytes).toBe(15);
        expect(state.last_event.selection).toEqual({ category: 'retrieval', provenance: 'observed', reference: 'igris_context_get' });
        const partial = await call('igris_context_get', { project: 'alpha', keys: ['architecture_map', 'missing_doc'] });
        expect(partial.isError).toBeFalsy();
        const after = readSnapshot(db, { session_id: session.id });
        expect(after.node_states.find(s => s.node.id === 'missing_doc')!.state).toBe('failed');
        // A partial miss is a successful call with one failed node, not a failed invocation.
        expect(after.recent_events.find(e => e.event_key === 'invocation:end')!.outcome).toBe('succeeded');
    });
    it('loads OS bytes from the configured local brain and never marks sync as delivery', async () => {
        const { db, session, call } = setup();
        const root = join(dir!, 'selected-brain');
        vi.stubEnv('IGRIS_BRAIN_DIR', root);
        mkdirSync(join(root, 'core', 'os'), { recursive: true });
        writeFileSync(join(root, 'core', 'os', 'INDEX.md'), '| module | layer | tier | scope | summary | consult_when |\n|---|---|---|---|---|---|\n| fixture | conduct | boot | universal | Fixture | — |\n');
        writeFileSync(join(root, 'core', 'os', 'fixture.md'), 'configured brain content');
        const response = await call('igris_context_load', { actor: '/boot', project: 'alpha' });
        expect(JSON.stringify(response.content)).toContain('configured brain content');
        const state = readSnapshot(db, { session_id: session.id }).node_states.find(s => s.node.id === 'igris-core:fixture')!;
        expect(state.state).toBe('full');
        await call('igris_context_sync', { project: 'alpha' });
        expect(readSnapshot(db, { session_id: session.id }).node_states.filter(s => s.node.type === 'context_doc')).toEqual([]);
    });
    it('captures actual preview/full memory responses without extra access or confidence changes', async () => {
        const { db, session, call } = setup();
        const body = 'attention knowledge '.repeat(40);
        const result = db.prepare("INSERT INTO learnings(project,category,title,content,scope,review_status,confidence) VALUES('alpha','pattern','attention fixture',?,'local','approved',0.7)").run(body);
        const id = Number(result.lastInsertRowid);
        await call('igris_memory_recall', { project: 'alpha', context: 'attention knowledge' });
        let state = readSnapshot(db, { session_id: session.id }).node_states.find(s => s.node.type === 'learning')!;
        expect(state.state).toBe('preview');
        expect(state.last_event.bytes).toBeLessThan(Buffer.byteLength(body));
        const before = db.prepare('SELECT access_count,confidence FROM learnings WHERE id=?').get(id) as {
            access_count: number;
            confidence: number;
        };
        await call('igris_memory_get', { id });
        const after = db.prepare('SELECT access_count,confidence FROM learnings WHERE id=?').get(id) as {
            access_count: number;
            confidence: number;
        };
        expect(after.access_count).toBe(before.access_count + 1);
        expect(after.confidence).toBe(0.7);
        state = readSnapshot(db, { session_id: session.id }).node_states.find(s => s.node.type === 'learning')!;
        expect(state.state).toBe('full');
        expect(state.last_event.source_revision).toMatch(/^[a-f0-9]{64}$/);
        expect(state.last_event.selection).toEqual({ category: 'retrieval', provenance: 'observed', reference: 'igris_memory_get' });
        db.pragma('query_only=ON');
        readSnapshot(db, { session_id: session.id });
        db.pragma('query_only=OFF');
        expect(db.prepare('SELECT access_count,confidence FROM learnings WHERE id=?').get(id)).toEqual(after);
    });
    it('records a promoted-learning pointer as preview, never as a read of the target document', async () => {
        const { db, session, call } = setup();
        db.prepare("INSERT INTO learnings(project,category,title,content,scope,review_status,promoted_to_doc) VALUES('alpha','pattern','pointer attention','attention body','local','approved','coding_guidelines.md')").run();
        await call('igris_memory_search', { query: 'attention', project: 'alpha' });
        const states = readSnapshot(db, { session_id: session.id }).node_states;
        expect(states.find(s => s.node.type === 'learning')!.state).toBe('preview');
        expect(states.filter(s => s.node.type === 'context_doc')).toEqual([]);
    });
    it('captures brief metadata as preview, full content as full, and missing content as failed', async () => {
        const { db, session, call } = setup();
        db.prepare("INSERT INTO brief_status(project,brief_id,title,status) VALUES('alpha','FR-1','fixture','Ready')").run();
        await call('igris_brief_list', { project: 'alpha' });
        expect(readSnapshot(db, { session_id: session.id }).node_states.find(s => s.node.type === 'brief')!.state).toBe('preview');
        db.prepare("INSERT INTO brief_files(project,brief_id,filename,content,content_hash) VALUES('alpha','FR-1','FR-1.md','full brief','hash-1')").run();
        await call('igris_brief_get', { project: 'alpha', brief_id: 'FR-1' });
        expect(readSnapshot(db, { session_id: session.id }).node_states.find(s => s.node.id === 'FR-1')!.state).toBe('full');
        await call('igris_brief_get', { project: 'alpha', brief_id: 'FR-404' });
        expect(readSnapshot(db, { session_id: session.id }).node_states.find(s => s.node.id === 'FR-404')!.state).toBe('failed');
    });
    it('rejects declared provenance through the real gateway before access and accepts caller reasons with response parity', async () => {
        const { db, session, call } = setup();
        const row = db.prepare("INSERT INTO learnings(project,category,title,content,scope,review_status) VALUES('alpha','pattern','selection fixture','actual content','local','approved')").run();
        const id = Number(row.lastInsertRowid);
        const count = () => db.prepare('SELECT access_count FROM learnings WHERE id=?').get(id);
        const before = count();
        const forged = await call('igris_memory_get', { id }, { category: 'retrieval', provenance: 'observed' });
        expect(forged.isError).toBe(true);
        expect(count()).toEqual(before);
        expect(readSnapshot(db, { session_id: session.id }).recent_events).toEqual([]);
        const invalidReference = await call('igris_memory_get', { id }, { category: 'task', reference: '/private/query' });
        expect(invalidReference.isError).toBe(true);
        expect(count()).toEqual(before);
        const plain = await engine!.gateway.dispatch('igris_memory_get', { id });
        // Recreate identical fixture state: the response includes its incremented access count.
        db.prepare('UPDATE learnings SET access_count=? WHERE id=?').run((before as { access_count: number }).access_count, id);
        const declared = await call('igris_memory_get', { id }, { category: 'task', reference: 'FR-276' });
        expect(declared.content).toEqual(plain.content);
        expect((declared._meta as any).igris_attention.recorded).toBe(true);
        expect(readSnapshot(db, { session_id: session.id }).recent_events.map(event => event.selection)).toEqual(Array(3).fill({ category: 'task', provenance: 'caller_declared', reference: 'FR-276' }));
        const schema = engine!.gateway.listTools().find(tool => tool.name === 'igris_attention_call')!.inputSchema.properties.selection as any;
        expect(schema.additionalProperties).toBe(false);
        expect(schema.properties.provenance).toBeUndefined();
        expect(schema.properties.reference.pattern).toBe('^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$');
    });
    it('uses stable historical session IDs for recall previews', async () => {
        const { db, session, call } = setup();
        const row = db.prepare("INSERT INTO sessions(project,summary) VALUES('other','historical work')").run();
        await call('igris_session_recall', { days: 2 });
        const state = readSnapshot(db, { session_id: session.id }).node_states.find(s => s.node.type === 'session')!;
        expect(state.node).toEqual({ type: 'session', project: 'other', id: String(row.lastInsertRowid) });
        expect(state.state).toBe('preview');
    });
});
