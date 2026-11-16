import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// Every sha256 input, so a test can prove a content hash was (or was not) built.
const hashed = vi.hoisted(() => [] as string[]);
vi.mock('node:crypto', async (original) => {
    const actual = await original<typeof import('node:crypto')>();
    const createHash = ((algorithm: string, options?: Parameters<typeof actual.createHash>[1]) => {
        const hash = actual.createHash(algorithm, options);
        const update = hash.update.bind(hash) as (data: unknown, encoding?: unknown) => typeof hash;
        hash.update = ((data: unknown, encoding?: unknown) => {
            hashed.push(String(data));
            return update(data, encoding);
        }) as typeof hash.update;
        return hash;
    }) as typeof actual.createHash;
    return { ...actual, default: { ...actual, createHash }, createHash };
});
vi.mock('../capture.js', async (original) => {
    const actual = await original<typeof import('../capture.js')>();
    return { ...actual, observeDelivery: vi.fn(actual.observeDelivery) };
});
vi.mock('../../../../utils/embeddings.js', async (original) => ({ ...(await original<typeof import('../../../../utils/embeddings.js')>()), generateEmbedding: async () => new Float32Array(384) }));
import { bootEngine, type Engine } from '../../../index.js';
import { sessionAction } from '../actions.js';
import { observeDelivery } from '../capture.js';
import { readAttentionSnapshot } from '../read.js';
let engine: Engine | undefined;
let dir: string | undefined;
beforeEach(() => {
    // vitest.setup.ts fences process-wide singleton/config reads before imports.
    expect(process.env.HOME).toContain('igris-brain-vitest-belt-');
    expect(process.env.IGRIS_DB_PATH).toBeUndefined();
    vi.stubEnv('IGRIS_DISABLE_VEC', '0');
});
afterEach(() => {
    engine?.shutdown();
    engine = undefined;
    if (dir)
        rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});
const LEARNING = 'guarded learning body '.repeat(30);
const BRIEF = 'guarded brief body';
const CONTEXT = 'guarded context document';
const OS_MODULE = 'guarded os module content';
function setup() {
    dir = mkdtempSync(join(tmpdir(), 'fr276-capture-guard-'));
    const root = join(dir, 'brain-root');
    mkdirSync(join(root, 'core', 'os'), { recursive: true });
    writeFileSync(join(root, 'core', 'os', 'INDEX.md'), '| module | layer | tier | scope | summary | consult_when |\n|---|---|---|---|---|---|\n| guarded | conduct | boot | universal | Guarded | — |\n');
    writeFileSync(join(root, 'core', 'os', 'guarded.md'), OS_MODULE);
    vi.stubEnv('IGRIS_BRAIN_DIR', root);
    engine = bootEngine({ dbPath: join(dir, 'brain.db'), components: { schedules: { enabled: false }, sync: { enabled: false }, cognition: { enabled: false }, cache: { enabled: false } } });
    const db = engine.storage.rawConnection;
    db.prepare("INSERT INTO projects(slug,name,path) VALUES('alpha','Alpha','/fixture/alpha')").run();
    const learning = Number(db.prepare("INSERT INTO learnings(project,category,title,content,scope,review_status) VALUES('alpha','pattern','guarded fixture',?,'local','approved')").run(LEARNING).lastInsertRowid);
    db.prepare("INSERT INTO brief_status(project,brief_id,title,status) VALUES('alpha','FR-1','fixture','Ready')").run();
    db.prepare("INSERT INTO brief_files(project,brief_id,filename,content,content_hash) VALUES('alpha','FR-1','FR-1.md',?,'hash-1')").run(BRIEF);
    db.prepare("INSERT INTO context_files(project_slug,key,content,content_hash) VALUES('alpha','architecture_map',?,'rev1')").run(CONTEXT);
    db.prepare("INSERT INTO goals(goal_id,project_slug,title,outcome) VALUES('GL-1','alpha','guarded goal','done')").run();
    db.prepare("INSERT INTO sessions(project,summary) VALUES('alpha','guarded session')").run();
    // Every native call site that builds a delivery observation.
    const calls: [string, Record<string, unknown>][] = [
        ['igris_memory_search', { query: 'guarded', project: 'alpha' }],
        ['igris_memory_recall', { project: 'alpha', context: 'guarded learning' }],
        ['igris_memory_hybrid_search', { query: 'guarded', project: 'alpha' }],
        ['igris_memory_get', { id: learning }],
        ['igris_memory_get', { id: learning + 1000 }],
        ['igris_brief_list', { project: 'alpha' }],
        ['igris_brief_get', { project: 'alpha', brief_id: 'FR-1' }],
        ['igris_brief_get', { project: 'alpha', brief_id: 'FR-404' }],
        ['igris_context_get', { project: 'alpha', keys: ['architecture_map', 'missing_doc'] }],
        ['igris_context_load', { actor: '/boot', project: 'alpha' }],
        ['igris_goal_list', {}],
        ['igris_goal_get', { goal_id: 'GL-1' }],
        ['igris_goal_get', { goal_id: 'GL-404' }],
        ['igris_session_recall', { days: 2 }],
    ];
    return { db, calls };
}
const builtFor = (content: string) => hashed.filter(input => input === content).length;
describe('FR-276 observation building is gated on an active capture scope', () => {
    it('builds no delivery observation, content hash or byte count on a native call without a scope', async () => {
        const { db, calls } = setup();
        const byteLength = vi.spyOn(Buffer, 'byteLength');
        vi.mocked(observeDelivery).mockClear();
        hashed.length = 0;
        for (const [tool, args] of calls) {
            const response = await engine!.gateway.dispatch(tool, args);
            expect(JSON.stringify(response.content).length).toBeGreaterThan(0);
        }
        // Soft, so a regression names every call site class that builds eagerly.
        expect.soft(vi.mocked(observeDelivery).mock.calls.length).toBe(0);
        expect.soft(builtFor(LEARNING), 'learning sha256').toBe(0);
        expect.soft(builtFor(OS_MODULE), 'os module sha256').toBe(0);
        const counted = byteLength.mock.calls.map(([value]) => value);
        expect.soft(counted, 'brief byte count').not.toContain(BRIEF);
        expect.soft(counted, 'context byte count').not.toContain(CONTEXT);
        expect.soft(counted, 'learning byte count').not.toContain(LEARNING);
        // Native calls never write attention evidence.
        expect(db.prepare('SELECT COUNT(*) AS n FROM attention_events').get()).toEqual({ n: 0 });
    });
    it('still builds every observation inside a scope, one recorded delivery per observation', async () => {
        const { db, calls } = setup();
        const session = sessionAction(db, { action: 'begin', project: 'alpha' }).session!;
        vi.mocked(observeDelivery).mockClear();
        hashed.length = 0;
        for (const [tool, args] of calls)
            await engine!.gateway.dispatch('igris_attention_call', { session_id: session.id, tool, arguments: args });
        const observed = vi.mocked(observeDelivery).mock.calls.length;
        expect(observed).toBeGreaterThan(0);
        expect(db.prepare("SELECT COUNT(*) AS n FROM attention_events WHERE kind='delivery'").get()).toEqual({ n: observed });
        expect(builtFor(LEARNING)).toBeGreaterThan(0);
        expect(builtFor(OS_MODULE)).toBeGreaterThan(0);
        const states = readAttentionSnapshot(db, { session_id: session.id }).node_states;
        for (const type of ['learning', 'brief', 'context_doc', 'os_module', 'goal', 'session'])
            expect(states.some(s => s.node.type === type), type).toBe(true);
    });
});
