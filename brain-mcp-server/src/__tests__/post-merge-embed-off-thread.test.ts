/**
 * TD-525 AC1-AC3 — the post-merge embed pass runs inference OFF the brain's main thread.
 *
 * OT1 drives the production pass (`runPostMergeEmbedPass`) over a 50-row backlog while a 1 ms
 * ticker runs (test_standards, BR-121: lag is main-thread CPU between two turns). The embed child
 * is real (a forked process); its embed module is the `burn.mjs` fixture, which burns CPU like one
 * MiniLM inference: LOAD = 4·BOUND on the first call, 4·BOUND for rows 0-2, 2 ms after. The
 * planted control OT1c (`post-merge-embed-inproc-control.test.ts`) runs the same burn in process
 * and must see a stretch of at least 4·BOUND; OT1 must see less than BOUND, every row embedded by
 * a pid that is not this one, and the in-process fallback never called.
 *
 * NO STATIC IMPORT of `utils/embed-child-client` (R2): the client is a factory mock over
 * `importOriginal()`, which runs only when production code imports the client. On af682f2 nothing
 * does, so this file loads and the RED is an assertion (in-process embeds, test-pid log lines).
 * `node:child_process` is wrapped to count forks. `utils/embeddings.js` is mocked so the old
 * in-process path burns the same way and is counted; no model is ever loaded here.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BOUND = 50 * (process.env.CI ? 3 : 1);
const N = 50;
const LOAD = 4 * BOUND;
const HEAVY = 4 * BOUND;
const LIGHT = 2;
const FIX = new URL('../utils/__tests__/fixtures/embed-child/', import.meta.url).href;

type Embed = ((t: string) => Promise<Float32Array>) & { calls: () => number };
interface ClientLike { embed(t: string): Promise<Float32Array>; close(): void; readonly pid: number | undefined }

const S = vi.hoisted(() => ({
  opts: {} as Record<string, unknown>,
  client: null as ClientLike | null,
  forks: [] as ChildProcess[],
  inproc: null as null | ((t: string) => Promise<Float32Array>),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    fork: (...a: Parameters<typeof real.fork>) => {
      const c = real.fork(...a);
      S.forks.push(c);
      return c;
    },
  };
});

vi.mock('../db.js', () => ({ getDb: vi.fn(), BRAIN_DIR: '/tmp/igris-test' }));

vi.mock('../utils/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/embeddings.js')>();
  return { ...actual, generateEmbedding: (t: string) => S.inproc!(t) };
});

vi.mock('../utils/embed-child-client.js', async (importOriginal) => {
  const real = await importOriginal<{ createEmbedChild: (o: object) => ClientLike }>();
  return { ...real, getEmbedChild: () => (S.client ??= real.createEmbedChild(S.opts)) };
});

import { runPostMergeEmbedPass } from '../tools/sync.js';
import { embeddingToBuffer } from '../utils/embeddings.js';
import { normalizedFingerprint } from '../utils/learning-embed.js';

const threadCpuMs = (): number => {
  const u = process.threadCpuUsage();
  return (u.user + u.system) / 1e3;
};

function startTicker(): () => { ticks: number; maxGapCpuMs: number } {
  let ticks = 0;
  let maxGap = 0;
  let last = threadCpuMs();
  let on = true;
  const tick = (): void => {
    const now = threadCpuMs();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks++;
    if (on) timer = setTimeout(tick, 1);
  };
  let timer = setTimeout(tick, 1);
  return () => {
    on = false;
    clearTimeout(timer);
    maxGap = Math.max(maxGap, threadCpuMs() - last);
    return { ticks, maxGapCpuMs: maxGap };
  };
}

describe('TD-525 — the post-merge pass embeds in a child process', () => {
  let dir: string;
  let db: Database.Database;
  let burn: { makeEmbed: (o: object) => Embed; fakeVector: (t: string) => Float32Array };
  let inproc: Embed;

  beforeAll(async () => {
    burn = (await import(FIX + 'burn.mjs')) as typeof burn;
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'td525-ot-'));
    db = new Database(join(dir, 'ot.db'));
    (createRequire(import.meta.url)('sqlite-vec') as { load: (d: Database.Database) => void }).load(db);
    db.exec(`
      CREATE TABLE learnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
        embedding BLOB, embedding_model TEXT DEFAULT ''
      );
      CREATE VIRTUAL TABLE learnings_vec USING vec0(embedding float[384]);
    `);
    S.forks.length = 0;
    S.client = null;
  });

  afterEach(() => {
    S.client?.close();
    S.client = null;
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function seed(n: number): void {
    const ins = db.prepare("INSERT INTO learnings (project, category, title, content) VALUES ('p', 'pattern', ?, ?)");
    for (let i = 0; i < n; i++) ins.run(`ot title ${i}`, `ot body ${i}`);
  }
  const nullCount = (): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM learnings WHERE embedding IS NULL').get() as { n: number }).n;
  const exitOf = (c: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
    c.exitCode !== null || c.signalCode !== null
      ? Promise.resolve({ code: c.exitCode, signal: c.signalCode })
      : new Promise((r) => c.once('exit', (code, signal) => r({ code, signal })));

  it('OT1 (AC1, AC2): a 50-row backlog never holds the main thread for BOUND, and the child wrote every vector', async () => {
    expect(LOAD + HEAVY).toBeGreaterThanOrEqual(8 * BOUND); // OT1c's stretch is 4·BOUND; RED ~8·BOUND
    seed(N);
    const log = join(dir, 'pids.jsonl');
    const q = new URLSearchParams({ load: String(LOAD), heavy: String(HEAVY), heavyRows: '3', light: String(LIGHT), log });
    S.opts = { embedModule: FIX + 'burn.mjs?' + q.toString(), idleMs: 500, loadMs: 30_000 };
    inproc = burn.makeEmbed({ load: LOAD, heavy: HEAVY, heavyRows: 3, light: LIGHT, wall: false, log });
    S.inproc = inproc;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const t0 = performance.now();
    const stop = startTicker();
    await runPostMergeEmbedPass(db);
    const lag = stop();
    const wall = performance.now() - t0;
    errSpy.mockRestore();

    const rows = db.prepare('SELECT title, content, embedding FROM learnings ORDER BY id').all() as Array<{ title: string; content: string; embedding: Buffer | null }>;
    const pids = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { pid: number }).pid) : [];
    expect.soft(lag.maxGapCpuMs, `max main-thread stretch ${lag.maxGapCpuMs.toFixed(1)} ms`).toBeLessThan(BOUND);
    expect.soft(lag.ticks).toBeGreaterThanOrEqual(N - 1);
    expect.soft(nullCount()).toBe(0);
    expect.soft(rows.every((r) => r.embedding !== null && r.embedding.equals(embeddingToBuffer(burn.fakeVector(normalizedFingerprint(r.title, r.content)))))).toBe(true);
    expect.soft(wall).toBeGreaterThanOrEqual(LOAD + 3 * HEAVY + (N - 3) * LIGHT);
    expect.soft(pids).toHaveLength(N);
    expect.soft(pids.every((p) => p !== process.pid)).toBe(true);
    expect.soft(new Set(pids).size).toBe(1);
    expect.soft(inproc.calls()).toBe(0);
  }, 120_000);

  it('OT2 (AC3 lazy): 0 rows → 0 forks; 5 rows → exactly 1 fork; close() → that child exits', async () => {
    S.opts = { embedModule: FIX + 'burn.mjs', idleMs: 60_000, loadMs: 30_000 };
    inproc = burn.makeEmbed({});
    S.inproc = inproc;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runPostMergeEmbedPass(db); // empty backlog
    expect.soft(S.forks).toHaveLength(0);

    seed(5);
    await runPostMergeEmbedPass(db);
    errSpy.mockRestore();
    expect.soft(S.forks).toHaveLength(1); // RED on af682f2: 0
    expect.soft(nullCount()).toBe(0);
    if (S.forks.length === 1) {
      const exit = exitOf(S.forks[0]);
      S.client!.close();
      await expect(exit).resolves.toBeTruthy();
    }
  }, 60_000);

  it('OT3 (R4 through the pass): a child that always crashes → 3 forks, at most 4 FAILED lines, one breaker line, rows stay NULL', async () => {
    seed(10);
    S.opts = { embedModule: FIX + 'crash.mjs?mode=always', breakerMs: 60_000, loadMs: 30_000 };
    inproc = burn.makeEmbed({});
    S.inproc = inproc;
    const lines: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));

    await runPostMergeEmbedPass(db);
    errSpy.mockRestore();

    expect.soft(S.forks).toHaveLength(3); // RED on af682f2: 0
    expect.soft(lines.filter((l) => l.includes('FAILED')).length).toBeGreaterThan(0);
    expect.soft(lines.filter((l) => l.includes('FAILED')).length).toBeLessThanOrEqual(4);
    expect.soft(lines.filter((l) => /\[embed-child\] .*refusing/.test(l))).toHaveLength(1);
    expect.soft(nullCount()).toBe(10);
    expect.soft(inproc.calls()).toBe(0);
  }, 60_000);
});
