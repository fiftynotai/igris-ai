/**
 * TD-525 — the real brain with the real (cached) MiniLM (ER1-ER4). Skipped unless
 * `MINILM_CACHED` (config.json, tokenizer.json, tokenizer_config.json and onnx/model.onnx
 * non-empty in the transformers `.cache/` the brain resolves). CI has no cache, so these four
 * are CI skips (decision 8). Every case asserts the cache listing is unchanged (L-2506).
 *
 * ER1 (AC1): `node --import tsx --import ticker-preload.mjs src/index.ts --http` on a free port,
 *   the TD-518 fenced env. A 50-learning push of ~2,000 chars each; the preload's 1 ms ticker
 *   window (SIGUSR2 after the push's reply to SIGUSR2 at the end, so the model load and the
 *   backlog, not the merge) must stay under 50 ms of main-thread CPU while `/health` is polled
 *   every 50 ms until `progress: 50/50`. One child pid; `parentLoads` (the PARENT's own
 *   `Pipeline loaded` lines, R9) recorded, expected 0.
 * ER2 (AC3, HTTP): a second push, SIGTERM about 1.5 s later: exit 0 with no signal, the child gone,
 *   no SIG, no `[fr220]` failure after `Shutting down`. On af682f2 this exits 134 on darwin (the
 *   main-thread pipeline meets `process.exit`).
 * ER3 (stdio): `igris_brain_pull` from a fake remote, stdin closed ~300 ms after the CHILD's
 *   `Pipeline loaded`: exit 0, child gone, every stdout line JSON-RPC, no SIG.
 * ER4 (AC2): an offline main-thread pipeline against the child, byte for byte (parent.mjs parity).
 *
 * ER1 and ER2 are two cases on one brain, so the CI skip count is four (ER1-ER4).
 * R9: a failing ER2/ER3 whose parent loaded a pipeline itself (`parentLoads > 0`) is labelled
 * NON-CONCLUSIVE in its failure message — that is the interactive D7 path, not the pass.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { minilmCached, cacheListing } from '../utils/__tests__/fixtures/embed-child/minilm.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAIN_ROOT = resolve(HERE, '..', '..');
const BRAIN_PKG = join(BRAIN_ROOT, 'package.json');
const ENTRY = join(BRAIN_ROOT, 'src', 'index.ts');
const FIX = join(BRAIN_ROOT, 'src', 'utils', '__tests__', 'fixtures', 'embed-child');
const TICKER = pathToFileURL(join(FIX, 'ticker-preload.mjs')).href;
const MINILM_CACHED = minilmCached(BRAIN_PKG);
const SIG = /libc\+\+abi|mutex lock failed|terminate called|Segmentation fault|FATAL ERROR/;
const GAP_BOUND_MS = 50;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await sleep(20);
  }
  return !alive(pid);
}
async function waitFor(pred: () => boolean, ms: number, what: string, err: () => string): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms\n--- stderr ---\n${err().slice(-4000)}`);
    await sleep(25);
  }
}
/** The embed children of `ppid` (by command line). */
function embedChildren(ppid: number): number[] {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m && Number(m[2]) === ppid && m[3].includes('embed-child'))
    .map((m) => Number(m[1]));
}
function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.on('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      srv.close(() => (port ? ok(port) : fail(new Error('no port'))));
    });
  });
}

interface Sandbox { home: string; brainDir: string; db: string; tickerOut: string; env: Record<string, string>; cleanup(): void }
function makeSandbox(): Sandbox {
  const home = mkdtempSync(join(tmpdir(), 'td525-er-home-'));
  const brainDir = mkdtempSync(join(tmpdir(), 'td525-er-brain-'));
  mkdirSync(join(home, '.igris', 'memory'), { recursive: true });
  mkdirSync(join(brainDir, 'memory'), { recursive: true });
  const tickerOut = join(brainDir, 'ticker.jsonl');
  return {
    home,
    brainDir,
    db: join(brainDir, 'memory', 'knowledge.db'),
    tickerOut,
    env: { HOME: home, IGRIS_BRAIN_DIR: brainDir, PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: tmpdir(), TD525_TICKER_OUT: tickerOut },
    cleanup: () => {
      rmSync(brainDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}
function lastTicker(sb: Sandbox): { maxGapCpuMs: number; ticks: number; parentLoads: number } {
  const lines = readFileSync(sb.tickerOut, 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]) as { maxGapCpuMs: number; ticks: number; parentLoads: number };
}
async function dumpTicker(child: ChildProcess, sb: Sandbox): Promise<{ maxGapCpuMs: number; ticks: number; parentLoads: number }> {
  const n = existsSync(sb.tickerOut) ? readFileSync(sb.tickerOut, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  child.kill('SIGUSR2');
  await waitFor(() => existsSync(sb.tickerOut) && readFileSync(sb.tickerOut, 'utf8').trim().split('\n').filter(Boolean).length > n, 10_000, 'ticker dump', () => '');
  return lastTicker(sb);
}
const nullCount = (dbPath: string): number => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM learnings WHERE embedding IS NULL').get() as { n: number }).n;
  } finally {
    db.close();
  }
};

const WORDS = 'brain memory sync embed child process vector learning pattern decision mistake onnx runtime thread health pass row backlog merge push pull'.split(' ');
function learning(tag: string, i: number, chars = 2_000): Record<string, unknown> {
  let s = 1 + i * 7919;
  let content = `${tag} ${i}: `;
  while (content.length < chars) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    content += WORDS[s % WORDS.length] + (s % 11 === 0 ? '. ' : ' ');
  }
  return {
    project: 'td525', category: 'pattern', title: `${tag} learning ${i}`, content, tags: '', tech_stack: '',
    scope: 'local', source_brief: '', confidence: 0.8, created_at: '2026-11-23 00:00:00', updated_at: '2026-11-23 00:00:00',
    access_count: 0, provenance: 'observed', review_status: 'approved', source_extractor: 'manual',
  };
}

function startHttpBrain(sb: Sandbox, port: number, apiKey: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', TICKER, ENTRY, '--http', '--port', String(port), '--host', '127.0.0.1'], {
    cwd: BRAIN_ROOT,
    env: { ...sb.env, BRAIN_API_KEY: apiKey },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((r) =>
    child.once('exit', (code, signal) => r({ code, signal, at: Date.now() })),
  );
  const hang = setTimeout(() => child.kill('SIGKILL'), 280_000);
  void exited.then(() => clearTimeout(hang));
  return { child, exited, err: () => stderr };
}

describe.skipIf(!MINILM_CACHED)('TD-525 — the real brain with the cached MiniLM', () => {
  // ER1 and ER2 share one HTTP brain: ER2's push lands on the brain ER1 warmed.
  let sb: Sandbox;
  let brain: ReturnType<typeof startHttpBrain> | null = null;
  let push: (rows: Array<Record<string, unknown>>) => Promise<number>;
  let childPid = 0;
  let before = '';

  afterAll(() => {
    if (brain && brain.child.exitCode === null && brain.child.signalCode === null) brain.child.kill('SIGKILL');
    sb?.cleanup();
  });

  it('ER1 (AC1): /health and the main thread stay free through a 50-row embed in the child', async () => {
    before = cacheListing(BRAIN_PKG);
    sb = makeSandbox();
    const apiKey = 'td525-er-key';
    const port = await freePort();
    const b = startHttpBrain(sb, port, apiKey);
    brain = b;
    push = async (rows) => {
      const res = await fetch(`http://127.0.0.1:${port}/sync/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ tables: { learnings: rows }, pushed_at: new Date().toISOString(), schema_version: 9 }),
      });
      return res.status;
    };
    await waitFor(() => b.err().includes(`started (http, 127.0.0.1:${port})`), 60_000, 'http banner', b.err);
    const health: Array<{ status: number; ms: number }> = [];
    const kids = new Set<number>();
    expect(await push(Array.from({ length: 50 }, (_, i) => learning('er1', i)))).toBe(200);
    // Window start: after the reply, so boot and the synchronous merge are excluded (the merge is
    // BR-121's measured cost, not this pass's); the pass starts on a later setImmediate.
    await dumpTicker(b.child, sb);
    const t0 = Date.now();
    while (!/progress: 50\/50/.test(b.err())) {
      if (Date.now() - t0 > 240_000) throw new Error('ER1: no progress: 50/50 within 240 s\n' + b.err().slice(-3000));
      const h0 = performance.now();
      const r = await fetch(`http://127.0.0.1:${port}/health`).then((x) => x.status, () => 0);
      health.push({ status: r, ms: performance.now() - h0 });
      for (const k of embedChildren(b.child.pid!)) kids.add(k);
      await sleep(50);
    }
    const win = await dumpTicker(b.child, sb);
    const ms = health.map((h) => h.ms).sort((x, y) => x - y);
    const pct = (p: number) => Math.round(ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] ?? 0);
    console.error(`[td525 ER1] gap ${win.maxGapCpuMs.toFixed(1)} ms CPU over ${win.ticks} ticks; /health n=${ms.length} p50 ${pct(0.5)} p95 ${pct(0.95)} max ${Math.round(ms[ms.length - 1] ?? 0)} ms; children ${[...kids].join(',')}; parentLoads ${win.parentLoads}`);
    childPid = [...kids][0] ?? 0;
    expect.soft(win.maxGapCpuMs, 'max main-thread CPU stretch during the pass').toBeLessThan(GAP_BOUND_MS);
    expect.soft(health.every((h) => h.status === 200)).toBe(true);
    expect.soft(nullCount(sb.db)).toBe(0);
    expect.soft(kids.size, 'one embed child for the whole pass').toBe(1);
    expect.soft(win.parentLoads).toBe(0);
    expect(cacheListing(BRAIN_PKG)).toBe(before);
  }, 300_000);

  it('ER2 (AC3, HTTP): SIGTERM about 1.5 s into a second pass exits 0, the child gone, no SIG, no pass failure after shutdown', async () => {
    if (!brain) throw new Error('ER2 needs the brain ER1 started');
    const b = brain;
    expect(await push(Array.from({ length: 20 }, (_, i) => learning('er2', i)))).toBe(200);
    await sleep(1_500);
    b.child.kill('SIGTERM');
    const { code, signal } = await Promise.race([b.exited, sleep(10_000).then(() => ({ code: 'TIMEOUT', signal: null }))]);
    const tail = b.err().slice(b.err().indexOf('Shutting down'));
    const parentLoads = lastTicker(sb).parentLoads;
    const label = parentLoads > 0 ? `NON-CONCLUSIVE (parentLoads=${parentLoads}, the D7 path) ` : '';
    console.error(`[td525 ER2] exit ${JSON.stringify({ code, signal })}; child ${childPid}; parentLoads ${parentLoads}`);
    expect.soft({ code, signal }, `${label}exit after SIGTERM`).toEqual({ code: 0, signal: null });
    if (childPid) expect.soft(await goneWithin(childPid, 2_000), `${label}child gone`).toBe(true);
    expect.soft(b.err(), `${label}SIG`).not.toMatch(SIG);
    expect.soft(tail, `${label}no pass failure after Shutting down`).not.toMatch(/\[fr220\]/);
    expect(cacheListing(BRAIN_PKG)).toBe(before);
  }, 60_000);

  it('ER3 (stdio): a pull merges 30 learnings; stdin EOF ~300 ms after the child loads → exit 0, child gone, stdout is JSON-RPC only', async () => {
    const before = cacheListing(BRAIN_PKG);
    const sb = makeSandbox();
    const rows = Array.from({ length: 30 }, (_, i) => learning('er3', i));
    const remote: Server = createHttpServer((req, res) => {
      if (req.url?.startsWith('/sync/pull')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tables: { learnings: rows } }));
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => remote.listen(0, '127.0.0.1', () => r()));
    const rport = (remote.address() as { port: number }).port;
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', TICKER, ENTRY], {
      cwd: BRAIN_ROOT,
      env: sb.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.stderr.on('data', (d: Buffer) => (err += d));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once('exit', (code, signal) => r({ code, signal })));
    const hang = setTimeout(() => child.kill('SIGKILL'), 200_000);
    const send = (m: object) => child.stdin.write(JSON.stringify(m) + '\n');
    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'td525-er3', version: '0.0.0' } } });
      await waitFor(() => /"id":1/.test(out), 60_000, 'initialize answer', () => err);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'igris_brain_pull', arguments: { remote_url: `http://127.0.0.1:${rport}`, api_key: 'k' } } });
      await waitFor(() => /"id":2/.test(out), 60_000, 'pull answer', () => err);
      await waitFor(() => err.includes('Pipeline loaded'), 120_000, 'a Pipeline loaded line', () => err);
      const kids = embedChildren(child.pid!);
      child.kill('SIGUSR2');
      await sleep(300);
      child.stdin.end();
      const res = await Promise.race([exited, sleep(10_000).then(() => ({ code: 'TIMEOUT', signal: null }))]);
      const parentLoads = existsSync(sb.tickerOut) ? lastTicker(sb).parentLoads : -1;
      const label = parentLoads > 0 ? `NON-CONCLUSIVE (parentLoads=${parentLoads}, the D7 path) ` : '';
      console.error(`[td525 ER3] exit ${JSON.stringify(res)}; children ${kids.join(',')}; parentLoads ${parentLoads}`);
      expect.soft(res, `${label}exit after stdin EOF`).toEqual({ code: 0, signal: null });
      for (const k of kids) expect.soft(await goneWithin(k, 2_000), `${label}child ${k} gone`).toBe(true);
      expect.soft(kids, 'the pass forked one child').toHaveLength(1);
      for (const line of out.split('\n').filter(Boolean)) expect.soft(() => JSON.parse(line), `stdout line: ${line.slice(0, 120)}`).not.toThrow();
      expect.soft(err, `${label}SIG`).not.toMatch(SIG);
      expect(cacheListing(BRAIN_PKG)).toBe(before);
    } finally {
      clearTimeout(hang);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      remote.close();
      sb.cleanup();
    }
  }, 300_000);

  it('ER4 (AC2): the child\'s vectors are byte-identical to an offline main-thread pipeline; 10 interleaved rounds; both drain to exit 0', async () => {
    const before = cacheListing(BRAIN_PKG);
    const { compileEmbedChild } = (await import(pathToFileURL(join(FIX, 'compile.mjs')).href)) as { compileEmbedChild: () => { dir: string } };
    const compiled = compileEmbedChild();
    const home = mkdtempSync(join(tmpdir(), 'td525-er4-home-'));
    try {
      const child = spawn(process.execPath, ['--import', 'tsx', join(FIX, 'parent.mjs'), 'parity', compiled.dir], {
        cwd: BRAIN_ROOT,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: tmpdir(), HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => (out += d));
      child.stderr.on('data', (d: Buffer) => (err += d));
      const hang = setTimeout(() => child.kill('SIGKILL'), 200_000);
      const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once('close', (c, s) => r({ code: c, signal: s })));
      clearTimeout(hang);
      expect({ code, signal }, err.slice(-3000)).toEqual({ code: 0, signal: null });
      const res = JSON.parse(out.trim().split('\n').pop()!) as { pid: number; rows: Array<{ len: number; equal: boolean; cosine: number }> };
      expect(res.rows).toHaveLength(15);
      for (const r of res.rows) {
        expect.soft(r.len).toBe(384);
        expect.soft(r.equal).toBe(true);
        expect.soft(r.cosine).toBeGreaterThanOrEqual(1 - 1e-6);
      }
      expect.soft(err).toMatch(new RegExp(`EXIT ${res.pid} 0 null`)); // the child drained on its idle reap
      expect.soft(err).not.toMatch(SIG);
      expect(cacheListing(BRAIN_PKG)).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(compiled.dir, { recursive: true, force: true });
    }
  }, 240_000);
});
