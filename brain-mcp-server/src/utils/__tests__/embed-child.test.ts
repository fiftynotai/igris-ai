/**
 * TD-525 — the embed-child client and its child process (EC0-EC19; EC4 was dropped with the
 * queue cap, EC11 with the RSS recycle, which G5 did not require).
 *
 * The client is the real module, loaded DYNAMICALLY in `beforeAll` (R2: no test file statically
 * imports a module that does not exist yet, so on af682f2 every case fails on that import).
 * `node:child_process` is wrapped: the wrapper records each `fork` (entry, args, options, the
 * ChildProcess) and can substitute the entry and options (EC13 runs the COMPILED child with
 * `execArgv []`, R8; EC15 a skewed entry). Embed modules are the fixtures in
 * `fixtures/embed-child/` — none of them loads a model; EC0b alone uses the default module
 * (the real `embeddings.ts`, offline), whose outcome follows `MINILM_CACHED`.
 *
 * Every case carries an explicit timeout (TD-336). Budgets that include a tsx child start are
 * generous (`loadMs` 30 s): a cold tsx child took 0.13-0.75 s on the loaded build host, and
 * 5-7 s in the spike.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { ChildProcess, ForkOptions } from 'node:child_process';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { embedNullLearnings } from '../learning-embed.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..');
const FIX = new URL('./fixtures/embed-child/', import.meta.url).href;
const fix = (name: string, q?: Record<string, string>): string =>
  FIX + name + (q ? '?' + new URLSearchParams(q).toString() : '');
const SIG = /libc\+\+abi|mutex lock failed|terminate called|Segmentation fault|FATAL ERROR/;

type Opts = Record<string, unknown>;
interface ClientLike { embed(t: string): Promise<Float32Array>; close(): void; readonly pid: number | undefined }
interface ClientModule { createEmbedChild(o?: Opts): ClientLike }

const F = vi.hoisted(() => ({
  calls: [] as Array<{ entry: string; args: readonly string[]; opts: Record<string, unknown>; cp: ChildProcess }>,
  sub: null as null | ((entry: string, args: readonly string[], opts: Record<string, unknown>) => [string, readonly string[], Record<string, unknown>]),
  onFork: null as null | ((cp: ChildProcess) => void),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    fork: (entry: string, args: readonly string[], opts: Record<string, unknown>) => {
      const [e, a, o] = F.sub ? F.sub(entry, args, opts) : [entry, args, opts];
      const cp = real.fork(e, [...a], o as ForkOptions);
      F.calls.push({ entry, args, opts, cp });
      F.onFork?.(cp);
      return cp;
    },
  };
});

let M: ClientModule;
let fakeVector: (t: string) => Float32Array;
let edgeVector: () => Float32Array;
let compiled: { dir: string; child: string };
let minilm: { minilmCached(p: string): boolean; cacheListing(p: string): string };
const BRAIN_PKG = resolve(SRC, '..', 'package.json');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number | undefined): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function goneWithin(pid: number | undefined, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await sleep(20);
  }
  return !alive(pid);
}
const exitOf = (c: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
  c.exitCode !== null || c.signalCode !== null
    ? Promise.resolve({ code: c.exitCode, signal: c.signalCode })
    : new Promise((r) => c.once('exit', (code, signal) => r({ code, signal })));
const buf = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const nameOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return (e as Error).name;
  }
};

beforeAll(async () => {
  M = (await import('../embed-child-client.js')) as unknown as ClientModule;
  ({ fakeVector } = (await import(FIX + 'fake-vector.mjs')) as { fakeVector: typeof fakeVector });
  ({ edgeVector } = (await import(FIX + 'edge.mjs')) as { edgeVector: typeof edgeVector });
  minilm = (await import(FIX + 'minilm.mjs')) as typeof minilm;
  const { compileEmbedChild } = (await import(FIX + 'compile.mjs')) as { compileEmbedChild: () => typeof compiled };
  compiled = compileEmbedChild();
}, 60_000);

describe('TD-525 — embed-child client', () => {
  const clients: ClientLike[] = [];
  let tmp: string;
  let lines: string[];

  const mk = (o: Opts): ClientLike => {
    const c = M.createEmbedChild(o);
    clients.push(c);
    return c;
  };
  const breakerLines = (): string[] => lines.filter((l) => /\[embed-child\] .*refusing/.test(l));

  beforeEach(() => {
    F.calls.length = 0;
    F.sub = null;
    F.onFork = null;
    tmp = mkdtempSync(join(tmpdir(), 'td525-ec-'));
    lines = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
  });

  afterEach(() => {
    for (const c of clients.splice(0)) c.close();
    for (const { cp } of F.calls) if (cp.exitCode === null && cp.signalCode === null) cp.kill('SIGKILL');
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('EC0 (TS layout): the fork shape, and a fixture embed round-trips', async () => {
    const c = mk({ embedModule: fix('burn.mjs'), loadMs: 30_000 });
    const v = await c.embed('ec0');
    expect(buf(v).equals(buf(fakeVector('ec0')))).toBe(true);
    expect(F.calls).toHaveLength(1);
    const { entry, args, opts } = F.calls[0];
    expect.soft(entry).toMatch(/src[\\/]utils[\\/]embed-child\.ts$/);
    expect.soft(args).toEqual([fix('burn.mjs')]);
    expect.soft(opts.execArgv).toEqual(['--import', 'tsx']);
    expect.soft(opts.serialization).toBe('advanced');
    expect.soft(opts.stdio).toEqual(['ignore', 2, 2, 'ipc']);
    expect.soft(opts.detached).toBeFalsy();
    expect.soft(opts.env).toBeTypeOf('object');
    expect.soft(opts.env as Record<string, string>).not.toHaveProperty('NODE_OPTIONS');
  }, 60_000);

  it('EC0b (default module): the real embeddings.ts, offline — a 384-float vector iff MINILM_CACHED, else EmbeddingsUnavailableError; the cache is untouched', async () => {
    const cached = minilm.minilmCached(BRAIN_PKG);
    const before = minilm.cacheListing(BRAIN_PKG);
    const c = mk({ loadMs: 90_000 });
    const t0 = Date.now();
    let out: Float32Array | Error;
    try {
      out = await c.embed('ec0b default module');
    } catch (e) {
      out = e as Error;
    }
    if (cached) {
      expect(out).toBeInstanceOf(Float32Array);
      expect((out as Float32Array).length).toBe(384);
    } else {
      expect((out as Error).name).toBe('EmbeddingsUnavailableError');
      expect(Date.now() - t0).toBeLessThan(30_000);
    }
    expect(minilm.cacheListing(BRAIN_PKG)).toBe(before);
  }, 120_000);

  it('EC1 / EC1c: IEEE-754 edge values cross IPC byte for byte; a planted -0 → +0 flip is caught', async () => {
    const c = mk({ embedModule: fix('edge.mjs'), loadMs: 30_000 });
    const v = await c.embed('edges');
    const want = edgeVector();
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.byteOffset).toBe(0);
    expect(v.length).toBe(384);
    expect(buf(v).equals(buf(want))).toBe(true);
    // EC1c: the comparison sees the sign bit; `===` would not.
    const flipped = edgeVector();
    flipped[0] = 0;
    expect(flipped[0] === v[0]).toBe(true);
    expect(buf(flipped).equals(buf(v))).toBe(false);
  }, 60_000);

  it('EC2 (lazy): no fork before the first embed; close() before any embed never forks', async () => {
    const a = mk({ embedModule: fix('burn.mjs'), loadMs: 30_000 });
    expect(F.calls).toHaveLength(0);
    a.close();
    expect(await nameOf(a.embed('x'))).toBe('EmbedChildClosedError');
    expect(F.calls).toHaveLength(0);
    const b = mk({ embedModule: fix('burn.mjs'), loadMs: 30_000 });
    expect(F.calls).toHaveLength(0);
    await b.embed('y');
    expect(F.calls).toHaveLength(1);
  }, 60_000);

  it('EC3 / EC3c: one request in flight; each later request is timed from its own send', async () => {
    let inflight = 0;
    let maxInflight = 0;
    // Count requests on the wire: +1 per {id,text} sent, -1 per reply.
    F.onFork = (cp) => {
      const send = cp.send.bind(cp) as (m: unknown) => boolean;
      (cp as unknown as { send: (m: unknown) => boolean }).send = (m: unknown) => {
        if ((m as { text?: string }).text !== undefined) maxInflight = Math.max(maxInflight, ++inflight);
        return send(m);
      };
      cp.on('message', (m: { id?: number }) => {
        if (m.id !== undefined) inflight--;
      });
    };
    const slow = fix('burn.mjs', { heavy: '300', heavyRows: '1000', wall: '1' });
    const c = mk({ embedModule: slow, requestMs: 900, loadMs: 30_000 });
    const t0 = Date.now();
    const out = await Promise.allSettled([c.embed('a'), c.embed('b'), c.embed('c'), c.embed('d')]);
    expect(out.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
    expect(maxInflight).toBe(1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_200);

    // EC3c: requestMs below one inference. Call 1 rides the load budget; call 2 times out.
    const d = mk({ embedModule: slow, requestMs: 150, loadMs: 30_000 });
    expect(await nameOf(d.embed('one'))).toBe('resolved');
    expect(await nameOf(d.embed('two'))).toBe('EmbedTimeoutError');
  }, 120_000);

  it('EC5 (AC3): a crash mid-row is retried once on a fresh child — no row is lost', async () => {
    const db = new Database(':memory:');
    try {
      (createRequire(import.meta.url)('sqlite-vec') as { load: (d: Database.Database) => void }).load(db);
      db.exec(`
        CREATE TABLE learnings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
          embedding BLOB, embedding_model TEXT DEFAULT ''
        );
        CREATE VIRTUAL TABLE learnings_vec USING vec0(embedding float[384]);
      `);
      const ins = db.prepare("INSERT INTO learnings (project, category, title, content) VALUES ('p', 'pattern', ?, ?)");
      for (let i = 0; i < 3; i++) ins.run(`ec5 ${i}`, `ec5 body ${i}`);
      const marker = join(tmp, 'crashed');
      const c = mk({ embedModule: fix('crash.mjs', { mode: 'once', marker }), loadMs: 30_000 });
      const summary = await embedNullLearnings(db, { dryRun: false, log: () => {} }, { embed: (t) => c.embed(t) });
      expect(summary).toMatchObject({ embedded: 3, failures: 0 });
      expect(F.calls).toHaveLength(2);
      expect(existsSync(marker)).toBe(true); // the crash really happened
    } finally {
      db.close();
    }
  }, 90_000);

  it('EC6 (breaker): 3 consecutive crashes refuse further calls with no fork; one half-open probe after breakerMs', async () => {
    const c = mk({ embedModule: fix('crash.mjs', { mode: 'always' }), breakerMs: 1_000, loadMs: 30_000 });
    expect(await nameOf(c.embed('1'))).toBe('EmbedChildCrashedError');
    expect(await nameOf(c.embed('2'))).not.toBe('resolved');
    expect(F.calls).toHaveLength(3);
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      expect(await nameOf(c.embed('refused ' + i))).toBe('EmbeddingsUnavailableError');
      expect(Date.now() - t0).toBeLessThan(250);
    }
    expect(F.calls).toHaveLength(3);
    expect(breakerLines()).toHaveLength(1);
    await sleep(1_100);
    expect(await nameOf(c.embed('probe'))).not.toBe('resolved');
    expect(F.calls).toHaveLength(4); // exactly one probe fork, and it re-opened
  }, 120_000);

  it('EC7 (start failures): a missing module dies before ready (retried once, then the breaker); a hung import hits loadMs', async () => {
    const c = mk({ embedModule: fix('does-not-exist.mjs'), loadMs: 30_000 });
    expect(await nameOf(c.embed('1'))).toBe('EmbedChildCrashedError');
    expect(F.calls).toHaveLength(2);
    expect(await nameOf(c.embed('2'))).not.toBe('resolved');
    expect(F.calls).toHaveLength(3);
    expect(breakerLines()).toHaveLength(1);

    F.calls.length = 0;
    const h = mk({ embedModule: fix('hang.mjs', { at: 'import' }), loadMs: 300 });
    expect(await nameOf(h.embed('x'))).toBe('EmbedTimeoutError');
    expect(F.calls).toHaveLength(1);
    expect(await goneWithin(F.calls[0].cp.pid, 1_000)).toBe(true);
  }, 120_000);

  it('EC8 (hang): a request that never answers times out at requestMs, its child is killed, the next call respawns', async () => {
    const c = mk({ embedModule: fix('hang.mjs', { at: 'embed', nth: '2' }), requestMs: 500, loadMs: 30_000 });
    expect(await nameOf(c.embed('1'))).toBe('resolved');
    const t0 = Date.now();
    expect(await nameOf(c.embed('2'))).toBe('EmbedTimeoutError');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(490);
    expect(await goneWithin(F.calls[0].cp.pid, 1_000)).toBe(true);
    expect(await nameOf(c.embed('3'))).toBe('resolved');
    expect(F.calls).toHaveLength(2);
  }, 90_000);

  it('EC9 (typed error): the name crosses IPC; a refusal within idleMs makes no IPC call; no breaker', async () => {
    const c = mk({ embedModule: fix('typed-fail.mjs'), idleMs: 5_000, loadMs: 30_000 });
    const first = await c.embed('x').catch((e: Error) => e);
    expect((first as Error).name).toBe('EmbeddingsUnavailableError');
    expect((first as Error).message).toMatch(/fixture/);
    const cp = F.calls[0].cp;
    const send = vi.spyOn(cp, 'send');
    expect(await nameOf(c.embed('y'))).toBe('EmbeddingsUnavailableError');
    expect(send).not.toHaveBeenCalled();
    expect(F.calls).toHaveLength(1);
    expect(breakerLines()).toHaveLength(0);
  }, 60_000);

  it('EC10 / EC10c (idle reap): an idle child drains to exit 0; the next embed forks again', async () => {
    const c = mk({ embedModule: fix('burn.mjs'), idleMs: 200, loadMs: 30_000 });
    await c.embed('x');
    const exit = await Promise.race([exitOf(F.calls[0].cp), sleep(3_000).then(() => null)]);
    expect(exit).toEqual({ code: 0, signal: null });
    await c.embed('y');
    expect(F.calls).toHaveLength(2);

    const d = mk({ embedModule: fix('burn.mjs'), idleMs: 60_000, loadMs: 30_000 });
    await d.embed('z');
    await sleep(1_000);
    expect(alive(d.pid)).toBe(true);
  }, 60_000);

  it('EC12 (close): close() rejects the pending request, kills the child, latches; double close and close after a crash are safe', async () => {
    const c = mk({ embedModule: fix('burn.mjs', { heavy: '5000', heavyRows: '10', wall: '1' }), loadMs: 30_000 });
    const pending = c.embed('busy');
    while (F.calls.length === 0) await sleep(5);
    await sleep(200);
    const pid = F.calls[0].cp.pid;
    c.close();
    expect(await nameOf(pending)).toBe('EmbedChildClosedError');
    expect(await goneWithin(pid, 1_000)).toBe(true);
    expect(await nameOf(c.embed('after'))).toBe('EmbedChildClosedError');
    expect(F.calls).toHaveLength(1);
    expect(() => c.close()).not.toThrow();

    const k = mk({ embedModule: fix('crash.mjs', { mode: 'always' }), loadMs: 30_000 });
    await nameOf(k.embed('x'));
    expect(() => k.close()).not.toThrow();
  }, 60_000);

  it('EC13 (ORT drain, compiled): a real ORT session in a plain-JS child is idle-reaped to code 0, signal null, no SIG', async () => {
    let stderr = '';
    F.sub = (_e, a, o) => [compiled.child, a, { ...o, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }];
    const c = mk({ embedModule: fix('ort-matmul.mjs'), idleMs: 300, loadMs: 30_000 });
    for (let i = 0; i < 3; i++) await c.embed('ort ' + i);
    const cp = F.calls[0].cp;
    cp.stderr?.on('data', (d: Buffer) => (stderr += d));
    cp.stdout?.on('data', (d: Buffer) => (stderr += d));
    expect(F.calls[0].opts.execArgv).toEqual(['--import', 'tsx']); // the client asked for tsx …
    const exit = await Promise.race([exitOf(cp), sleep(10_000).then(() => null)]);
    expect(exit).toEqual({ code: 0, signal: null }); // … the substituted compiled child drained
    expect(stderr).not.toMatch(SIG);
  }, 90_000);

  it('EC15 (skew): a child that speaks another protocol version is a start failure', async () => {
    F.sub = (_e, a, o) => [fileURLToPath(fix('ready-v999.mjs')), a, { ...o, execArgv: [] }];
    const c = mk({ embedModule: fix('burn.mjs'), loadMs: 30_000 });
    expect(await nameOf(c.embed('x'))).toBe('EmbedChildCrashedError');
    expect(F.calls.length).toBeGreaterThanOrEqual(1);
    for (const { cp } of F.calls) expect(await goneWithin(cp.pid, 2_000)).toBe(true);
  }, 60_000);

  it('EC16 / EC16c (R3): the first request gets loadMs from fork; later ones get requestMs', async () => {
    const q = { load: '1500', heavy: '600', heavyRows: '2', wall: '1' };
    const c = mk({ embedModule: fix('burn.mjs', q), requestMs: 300, loadMs: 6_000 });
    expect(await nameOf(c.embed('first'))).toBe('resolved'); // >= 2.1 s, far over requestMs
    expect(await nameOf(c.embed('second'))).toBe('EmbedTimeoutError'); // 600 ms > 300

    F.calls.length = 0;
    const d = mk({ embedModule: fix('burn.mjs', q), requestMs: 60_000, loadMs: 300 });
    expect(await nameOf(d.embed('first'))).toBe('EmbedTimeoutError');
    expect(await goneWithin(F.calls[0].cp.pid, 1_000)).toBe(true);
  }, 90_000);

  it('EC17 / EC17c (R7): an unrequested SIGINT is an external stop — rejected as closed, no retry, no breaker; the next call forks', async () => {
    const marker = join(tmp, 'sigint');
    const c = mk({ embedModule: fix('sigint-self.mjs', { marker }), loadMs: 30_000 });
    expect(await nameOf(c.embed('x'))).toBe('EmbedChildClosedError');
    expect(F.calls).toHaveLength(1);
    expect(F.calls[0].cp.signalCode).toBe('SIGINT');
    expect(breakerLines()).toHaveLength(0);
    expect(await nameOf(c.embed('y'))).toBe('resolved');
    expect(F.calls).toHaveLength(2);
    // EC17c is EC5: an unrequested SIGKILL is a crash, and it IS retried.
  }, 60_000);

  it('EC18 / EC18c (R11): the child env is an allowlist — no NODE_OPTIONS, no BRAIN_API_KEY', async () => {
    const saved = { NODE_OPTIONS: process.env.NODE_OPTIONS, BRAIN_API_KEY: process.env.BRAIN_API_KEY };
    process.env.NODE_OPTIONS = '--require /nonexistent-td525';
    process.env.BRAIN_API_KEY = 'x';
    try {
      const c = mk({ embedModule: fix('env.mjs'), loadMs: 30_000 });
      const e = (await c.embed('x').catch((err: Error) => err)) as Error;
      expect(e.name).toBe('EnvKeys'); // it started: an inherited NODE_OPTIONS would have killed it
      const keys = e.message.split(',');
      expect(keys).not.toContain('NODE_OPTIONS');
      expect(keys).not.toContain('BRAIN_API_KEY');
      const passed = Object.keys(F.calls[0].opts.env as Record<string, string>);
      expect(passed.length).toBeGreaterThan(0);
      expect(passed.every((k) => /^(PATH|HOME|TMPDIR|LANG|LC_\w+)$/.test(k))).toBe(true);

      // EC18c: the same NODE_OPTIONS, inherited by a raw fork, kills the child at boot.
      const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      const raw = real.fork(fileURLToPath(fix('ready-v999.mjs')), [], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      const exit = await exitOf(raw);
      expect(exit.code).not.toBe(0);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }, 60_000);

  it('EC19 (R5): a module without setEmbeddingsOffline is a start failure — no embed is attempted', async () => {
    const marker = join(tmp, 'embedded');
    const c = mk({ embedModule: fix('no-offline.mjs', { marker }), loadMs: 30_000 });
    expect(await nameOf(c.embed('x'))).toBe('EmbedChildCrashedError');
    expect(existsSync(marker)).toBe(false);
    expect(lines.some((l) => l.includes('[embed-child] pid='))).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// EC14 — the static guard (comments stripped by the TypeScript transpiler)
// ---------------------------------------------------------------------------

const ts = createRequire(BRAIN_PKG)('typescript') as typeof import('typescript');
const strip = (code: string): string =>
  ts.transpileModule(code, {
    compilerOptions: { removeComments: true, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: false,
  }).outputText;
const staticImports = (code: string): string[] =>
  [...code.matchAll(/^\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? m[2]);

function childViolations(code: string): string[] {
  const c = strip(code);
  const v: string[] = [];
  if (staticImports(c).some((s) => !s.startsWith('node:'))) v.push('non-node static import');
  if (!c.includes('.setEmbeddingsOffline()')) v.push('no unguarded setEmbeddingsOffline()');
  if (c.includes('setEmbeddingsOffline?.')) v.push('guarded setEmbeddingsOffline?.');
  if (/process\.exit\(|reallyExit\(/.test(c)) v.push('process.exit');
  if (/sqlite|['"][^'"]*db\.js['"]/.test(c)) v.push('db import');
  if (!/\bv: 1\b/.test(c)) v.push('no v: 1');
  return v;
}

function clientViolations(code: string): string[] {
  const c = strip(code);
  const v: string[] = [];
  if (staticImports(c).some((s) => !s.startsWith('node:'))) v.push('non-node static import');
  if (!c.includes("'ignore', 2, 2, 'ipc'")) v.push('stdio shape');
  if (!/\benv:/.test(c)) v.push('no env option');
  if (!/\.v !== 1\b/.test(c)) v.push('no v 1 check');
  if (/detached/.test(c)) v.push('detached');
  return v;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return d.name === '__tests__' ? [] : walk(p);
    return d.name.endsWith('.ts') ? [p] : [];
  });
}

function callSites(needle: RegExp, exclude: string[]): string[] {
  const out: string[] = [];
  for (const f of walk(SRC)) {
    const rel = f.slice(SRC.length + 1).split('\\').join('/');
    if (exclude.includes(rel)) continue;
    const raw = readFileSync(f, 'utf8');
    if (!needle.test(raw)) continue;
    for (const _m of strip(raw).matchAll(new RegExp(needle.source, 'g'))) out.push(rel);
  }
  return out.sort();
}

describe('TD-525 EC14 — static guard', () => {
  it('EC14: call sites, the child rules and the client rules', () => {
    const child = readFileSync(join(SRC, 'utils', 'embed-child.ts'), 'utf8');
    const client = readFileSync(join(SRC, 'utils', 'embed-child-client.ts'), 'utf8');
    expect(childViolations(child)).toEqual([]);
    expect(clientViolations(client)).toEqual([]);
    const own = ['utils/embed-child-client.ts'];
    expect(callSites(/\b(?:getEmbedChild|createEmbedChild)\(/, own)).toEqual(['tools/sync.ts']);
    expect(callSites(/\bshutdownEmbedChild\(/, own)).toEqual(['index.ts', 'index.ts']);
    expect([...new Set(callSites(/\bscheduleLearningEmbedAfterMerge\(/, []))]).toEqual(['index.ts', 'tools/sync.ts']);
  });

  it('EC14 self-test: planted violations are flagged; the same text in a comment is not', () => {
    const ok = "import { writeSync } from 'node:fs';\nconst emb = await import('./embeddings.js');\nemb.setEmbeddingsOffline();\nsend({ ready: 1, v: 1 });\n";
    expect(childViolations(ok)).toEqual([]);
    expect(childViolations(ok + '// process.exit(0)\n/* reallyExit( */\n')).toEqual([]);
    expect(childViolations(ok + 'process.exit(0);\n')).toContain('process.exit');
    expect(childViolations(ok.replace('emb.setEmbeddingsOffline();', 'emb.setEmbeddingsOffline?.();'))).toEqual(
      expect.arrayContaining(['guarded setEmbeddingsOffline?.', 'no unguarded setEmbeddingsOffline()']),
    );
    expect(childViolations("import Database from 'better-sqlite3';\nnew Database(':memory:');\n" + ok)).toEqual(
      expect.arrayContaining(['non-node static import', 'db import']),
    );
    expect(childViolations(ok.replace('v: 1', 'v: 2'))).toContain('no v: 1');
    const okClient = "import { fork } from 'node:child_process';\nfork(e, [], { env: x, stdio: ['ignore', 2, 2, 'ipc'] });\nif (m.v !== 1) k();\n";
    expect(clientViolations(okClient)).toEqual([]);
    expect(clientViolations(okClient.replace("'ignore', 2, 2, 'ipc'", "'inherit'"))).toContain('stdio shape');
    expect(clientViolations(okClient.replace('env: x, ', ''))).toContain('no env option');
    expect(clientViolations(okClient + 'fork(e, [], { detached: true });\n')).toContain('detached');
  });
});
