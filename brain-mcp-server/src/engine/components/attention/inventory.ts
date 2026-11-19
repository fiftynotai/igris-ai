/** FR-276 — discovered inventory; no secret configs, engine boot, or database writes. */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep, basename } from 'node:path';
import { encodeNodeKey } from '../edges/graph-keys.js';
import { parseIndexModules } from '../context/index.js';
import type { AttentionInventory, AttentionNodeRef } from './types.js';
export interface InventoryOptions {
    brain_root: string;
    project?: string | null;
}
export interface InventoryResource {
    path: string;
    root: string;
}
function confined(path: string, root: string): boolean {
    try {
        const p = realpathSync(path), r = realpathSync(root);
        return p === r || p.startsWith(r + sep);
    }
    catch {
        return false;
    }
}
/** Also used by the loader: only discovered identifiers can become filesystem reads. */
export function scanAttentionInventory(db: Database.Database, opts: InventoryOptions): {
    inventory: AttentionInventory;
    resources: Map<string, InventoryResource>;
} {
    const root = resolve(opts.brain_root);
    const resources = new Map<string, InventoryResource>();
    const out: AttentionInventory = { nodes: [], revision: '', generated_at: new Date().toISOString(), sources: [], degraded: null };
    const physical = new Set<string>();
    const emitted = new Set<string>();
    const add = (node: AttentionNodeRef, label: string, path?: string, trustedRoot?: string, scope = 'installed') => {
        if (path) {
            if (!trustedRoot || !confined(path, trustedRoot) || !statSync(path).isFile()) {
                out.sources.push({ source: 'resource:' + encodeNodeKey(node), available: false, reason: 'Listed resource missing or outside its inventory root' });
                return;
            }
            const canonical = realpathSync(path);
            if (physical.has(canonical))
                return;
            physical.add(canonical);
        }
        const key = encodeNodeKey(node);
        if (emitted.has(key))
            return;
        emitted.add(key);
        const attrs: Record<string, unknown> = { availability_scope: scope };
        if (path) {
            const stat = statSync(path);
            attrs.source_revision = `${stat.size}:${stat.mtimeMs}`;
            resources.set(key, { path, root: trustedRoot! });
        }
        out.nodes.push({ ...node, key, label, attrs, degree: 0 });
    };
    // A source callback may return a reason that annotates an available source.
    const source = (name: string, fn: () => string | null | void) => { try {
        out.sources.push({ source: name, available: true, reason: fn() ?? null });
    }
    catch {
        out.sources.push({ source: name, available: false, reason: `${name} inventory unavailable` });
    } };
    source('os_modules', () => {
        const core = join(root, 'core'), index = join(core, 'os', 'INDEX.md');
        if (!confined(index, core))
            throw new Error('missing index');
        const bytes = statSync(index).size;
        if (bytes > 262144)
            throw new Error('index too large');
        add({ type: 'os_module', project: null, id: 'igris-core:INDEX' }, 'OS module index', index, core);
        for (const mod of parseIndexModules(readFileSync(index, 'utf8'))) {
            if (!/^[A-Za-z0-9_-]+$/.test(mod.module))
                continue;
            const file = mod.module === 'SOUL' ? join(core, 'SOUL.md') : mod.module === 'USER' ? join(root, 'USER.md') : join(core, 'os', mod.module + '.md');
            add({ type: 'os_module', project: null, id: 'igris-core:' + mod.module }, mod.module, file, mod.module === 'USER' ? root : core);
        }
        const dir = join(core, 'os', 'harness-specific');
        if (existsSync(dir))
            for (const name of readdirSync(dir).sort())
                if (/^[\w-]+\.md$/.test(name) && !name.startsWith('_'))
                    add({ type: 'os_module', project: null, id: 'igris-core:harness-specific/' + name.slice(0, -3) }, 'Harness · ' + name.slice(0, -3), join(dir, name), core);
    });
    // core ships with every install; loadout and registry exist only once the operator adds to them.
    for (const [folder, namespace, optional] of [['core', 'igris-core', false], ['loadout', 'igris-registry', true], ['registry', 'igris-registry', true]] as const) {
        for (const type of ['skill', 'agent'] as const)
            source(folder + '_' + type + 's', () => {
                const dir = join(root, folder, type + 's');
                // Only ENOENT reads as absent; any other stat or read failure still degrades.
                if (!statSync(dir, { throwIfNoEntry: false })) {
                    if (optional)
                        return 'absent (optional)';
                    throw new Error('missing directory');
                }
                for (const name of readdirSync(dir).sort()) {
                    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith('.'))
                        continue;
                    const entry = join(dir, name);
                    let file = entry;
                    if (statSync(entry).isDirectory()) {
                        const candidates = type === 'skill' ? ['SKILL.md'] : ['AGENT.md', name + '.md', 'agent.md'];
                        file = candidates.map(n => join(entry, n)).find(existsSync) ?? '';
                    }
                    else if (!name.endsWith('.md'))
                        continue;
                    if (!file)
                        continue;
                    add({ type, project: null, id: namespace + ':' + basename(name, '.md') }, basename(name, '.md'), file, dir);
                }
                return null;
            });
    }
    source('context_docs', () => {
        const rows = db.prepare('SELECT slug FROM projects').all() as {
            slug: string;
        }[];
        for (const { slug } of rows) {
            if (opts.project && opts.project !== slug)
                continue;
            if (!/^[A-Za-z0-9_-]+$/.test(slug))
                continue;
            const dir = join(root, 'projects', slug, 'context');
            if (!existsSync(dir))
                continue;
            for (const name of readdirSync(dir).sort())
                if (/^[A-Za-z0-9_.-]+\.md$/.test(name) && !name.startsWith('.'))
                    add({ type: 'context_doc', project: slug, id: name.slice(0, -3) }, name.slice(0, -3), join(dir, name), dir);
        }
    });
    source('brain_tools', () => {
        const rows = db.prepare('SELECT provider,name FROM attention_tool_inventory ORDER BY provider,name').all() as {
            provider: string;
            name: string;
        }[];
        if (!rows.length)
            throw new Error('no observed publication');
        for (const row of rows)
            add({ type: 'tool', project: null, id: row.provider + ':' + row.name }, row.name, undefined, undefined, 'published');
    });
    // Missing optional sources are visible individually, not converted into an empty success.
    const failures = out.sources.filter(s => !s.available);
    if (failures.length)
        out.degraded = { reason: `Partial inventory: ${failures.map(s => s.source).join(', ')}` };
    out.nodes.sort((a, b) => a.key.localeCompare(b.key));
    out.revision = createHash('sha256').update(JSON.stringify({ nodes: out.nodes, sources: out.sources })).digest('hex');
    return { inventory: out, resources };
}
export function buildAttentionInventory(db: Database.Database, opts: InventoryOptions): AttentionInventory { return scanAttentionInventory(db, opts).inventory; }
