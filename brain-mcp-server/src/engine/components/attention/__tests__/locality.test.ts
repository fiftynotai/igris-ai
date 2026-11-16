/** FR-276 — attention is machine-local: an engine served over HTTP (the VPS brain) never exposes it. */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { bootEngine, type Engine } from '../../../index.js';
const ATTENTION_TOOLS = ['igris_attention_call', 'igris_attention_event', 'igris_attention_session'];
// Same quiet set as the delivery integration test: no daemons or egress in a unit boot.
const QUIET = { schedules: { enabled: false }, sync: { enabled: false }, cognition: { enabled: false }, cache: { enabled: false } };
const engines: Engine[] = [];
const dirs: string[] = [];
afterEach(() => {
    for (const engine of engines.splice(0))
        engine.shutdown();
    for (const dir of dirs.splice(0))
        rmSync(dir, { recursive: true, force: true });
});
function boot(transport?: 'stdio' | 'http'): Engine {
    const dir = mkdtempSync(join(tmpdir(), 'fr276-locality-'));
    dirs.push(dir);
    const engine = bootEngine({ dbPath: join(dir, 'brain.db'), components: QUIET, ...(transport ? { transport } : {}) });
    engines.push(engine);
    return engine;
}
const names = (engine: Engine) => engine.gateway.listTools().map(tool => tool.name);
describe('FR-276 attention locality', () => {
    it('an HTTP (VPS) engine registers no attention component, tables, tools or dispatch facade', async () => {
        const local = boot(), remote = boot('http');
        expect(names(local).filter(name => !names(remote).includes(name)).sort()).toEqual(ATTENTION_TOOLS);
        expect(names(remote).filter(name => name.startsWith('igris_attention_'))).toEqual([]);
        expect(remote.gateway.toolCount()).toBe(local.gateway.toolCount() - ATTENTION_TOOLS.length);
        expect(remote.registry.getBootOrder()).not.toContain('attention');
        await expect(remote.gateway.dispatch('igris_attention_call', { session_id: 'x', tool: 'igris_project_list', arguments: {} })).rejects.toThrow('Unknown tool: igris_attention_call');
        expect(remote.storage.rawConnection.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'attention_%'").all()).toEqual([]);
    });
    it('a stdio engine is local and keeps attention, explicitly or by default', () => {
        for (const engine of [boot('stdio'), boot()]) {
            expect(names(engine).filter(name => name.startsWith('igris_attention_')).sort()).toEqual(ATTENTION_TOOLS);
            expect(engine.registry.getBootOrder()).toContain('attention');
        }
    });
    it('the server entry point boots its engine with the transport it serves', () => {
        // src/index.ts starts a server on import, so its one wiring line is pinned at source level.
        const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../index.ts'), 'utf8');
        const getEngine = source.slice(source.indexOf('function getEngine('), source.indexOf('_engine = bootEngine(config)'));
        expect(getEngine).toMatch(/transport: parseConfig\(\)\.mode,/);
        expect(source).toMatch(/if \(config\.mode === 'http'\) \{\s*runHttp\(config\)/);
    });
});
