/**
 * BR-121 AC2 — `embedNullLearnings` yields a macrotask between rows, so a
 * concurrent `/health` keeps answering while a backlog embeds.
 *
 * WHY A BLOCKING FAKE. onnxruntime-node 1.21.0 runs each inference as a
 * `setImmediate` followed by a SYNCHRONOUS `binding.run` on the main thread
 * (`dist/backend.js`). A fake embedder that busy-waits D ms and then resolves
 * reproduces exactly that: the loop's `await` on an already-resolved promise
 * resumes in a microtask, so without a yield the whole backlog runs as ONE
 * macrotask and no timer, socket or `/health` request is served until it
 * ends. The fake is injected through the core's own `deps.embed` seam — no
 * module mock, no model, no network.
 *
 * THE INSTRUMENT. A 1 ms ticker stands in for a request waiting in the loop.
 *  - Its turn COUNT is the load-proof proof of the yield: it must run between
 *    the rows (>= N-2 turns, see E2). RED gives 0.
 *  - Lag is the most MAIN-THREAD CPU spent between two of its turns — the
 *    longest stretch OUR code held the loop — bounded at most N*D/4, so a full
 *    machine (RED ~N*D) and GREEN (~D) are separated by at least 4x.
 * Not `monitorEventLoopDelay`: a wall-clock lag also counts the OS
 * descheduling the process, which this code does not cause. On the 2026-11-23
 * build host (load average 66-100 on 8 cores) a loop that DID yield between
 * rows read a `monitorEventLoopDelay` max of 222-638 ms while its CPU stretch
 * read 13-19 ms. The wait is still wall time: there, burning 20 ms of CPU took
 * 833 ms, which would have made each test run 23 s or more.
 *
 * The wall-time floor proves the fake really blocked. E3 counts the 25 ms
 * pauses exactly: N-1, never one after the last row.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { embedNullLearnings } from '../learning-embed.js';

const N = 60;
const D = 20;
const PAUSE = 25;
const LAG_BOUND_MS = 100 * (process.env.CI ? 3 : 1);

/** Main-thread CPU in ms — a clock the OS scheduler cannot stretch. */
const threadCpuMs = (): number => {
  const u = process.threadCpuUsage();
  return (u.user + u.system) / 1e3;
};

function blockingEmbed(calls: { n: number }) {
  return async (_text: string): Promise<Float32Array> => {
    const end = performance.now() + D;
    while (performance.now() < end) { /* block the event loop, as binding.run does */ }
    calls.n++;
    const v = new Float32Array(384);
    v[calls.n % 384] = 1;
    return v;
  };
}

/** A 1 ms ticker; stop() reports its turns and the most CPU the loop spent between two of them. */
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

describe('BR-121 — embedNullLearnings yields between rows', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
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
    for (let i = 0; i < N; i++) ins.run(`yield title ${i}`, `yield body ${i}`);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  const nullCount = (): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM learnings WHERE embedding IS NULL').get() as { n: number }).n;

  it('E2: yieldMs 0 — a blocking backlog never holds the loop past the bound, and every row is embedded', async () => {
    expect(LAG_BOUND_MS).toBeLessThanOrEqual((N * D) / 4);
    const calls = { n: 0 };
    const t0 = performance.now();
    const stop = startTicker();
    const summary = await embedNullLearnings(
      db,
      { dryRun: false, yieldMs: 0, log: () => {} },
      { embed: blockingEmbed(calls) },
    );
    const lag = stop();
    const wall = performance.now() - t0;

    expect(summary).toMatchObject({ scanned: N, embedded: N, failures: 0 });
    expect(nullCount()).toBe(0);
    expect(wall).toBeGreaterThanOrEqual(N * D); // the fake really blocked
    // A turn between rows (RED: 0). N-2, not N-1: the test body runs in the poll
    // phase, so the first setImmediate yield reaches the check phase before the
    // next timers phase, and the timer misses that one gap.
    expect(lag.ticks).toBeGreaterThanOrEqual(N - 2);
    expect(lag.maxGapCpuMs).toBeLessThan(LAG_BOUND_MS);
  }, 20_000);

  it('E3: yieldMs 25 — a pause between rows (N-1 of them), none after the last', async () => {
    const calls = { n: 0 };
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const t0 = performance.now();
    await embedNullLearnings(db, { dryRun: false, yieldMs: PAUSE, log: () => {} }, { embed: blockingEmbed(calls) });
    const wall = performance.now() - t0;
    const pauses = timers.mock.calls.filter((c) => c[1] === PAUSE).length;
    timers.mockRestore();

    expect(nullCount()).toBe(0);
    expect(pauses).toBe(N - 1);
    expect(wall).toBeGreaterThanOrEqual(N * D + 0.8 * (N - 1) * PAUSE);
  }, 20_000);
});

// TD-525 R4 — `deps.stopOn(err)`: when it returns true the loop logs that row's FAILED line
// and stops, so a refused or closed embed child costs one line per pass, not one per row.
describe('TD-525 — embedNullLearnings stops on a stopOn error', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
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
    for (let i = 1; i <= 5; i++) ins.run(`stop title ${i}`, `stop body ${i}`);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  /** Throws on row 2 (the 2nd call); records every text it is handed. */
  function failOnSecond(seen: string[]) {
    return async (text: string): Promise<Float32Array> => {
      seen.push(text);
      if (seen.length === 2) throw Object.assign(new Error('child refused'), { name: 'EmbeddingsUnavailableError' });
      return new Float32Array(384).fill(0.05);
    };
  }

  it('LE1: stopOn → true after row 2 fails: rows 3-5 never reach embed, one FAILED line, no pause after the stop', async () => {
    const seen: string[] = [];
    const lines: string[] = [];
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const stopOn = vi.fn((e: unknown) => (e as Error).name === 'EmbeddingsUnavailableError');
    const summary = await embedNullLearnings(
      db,
      { dryRun: false, yieldMs: PAUSE, log: (m) => lines.push(m) },
      { embed: failOnSecond(seen), stopOn },
    );
    const pauses = timers.mock.calls.filter((c) => c[1] === PAUSE).length;
    timers.mockRestore();

    expect.soft(seen).toHaveLength(2); // RED (stopOn ignored): 5
    expect.soft(lines.filter((l) => l.includes('FAILED'))).toHaveLength(1);
    expect.soft(pauses).toBe(1); // after row 1 only (RED: 4)
    expect.soft(stopOn).toHaveBeenCalledTimes(1);
    expect.soft(summary).toMatchObject({ scanned: 5, embedded: 1, failures: 1 });
  });

  it('LE1c: stopOn → false keeps going: all 5 rows are attempted', async () => {
    const seen: string[] = [];
    const lines: string[] = [];
    const summary = await embedNullLearnings(
      db,
      { dryRun: false, log: (m) => lines.push(m) },
      { embed: failOnSecond(seen), stopOn: () => false },
    );
    expect(seen).toHaveLength(5);
    expect(lines.filter((l) => l.includes('FAILED'))).toHaveLength(1);
    expect(summary).toMatchObject({ scanned: 5, embedded: 4, failures: 1 });
  });
});
