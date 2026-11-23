/**
 * TD-525 OT1c — the planted control for OT1 (`post-merge-embed-off-thread.test.ts`).
 *
 * The same burn fixture and the same 50-row backlog, embedded IN PROCESS through the core's own
 * seam (`embedNullLearnings(db, { yieldMs: 25 }, { embed: makeEmbed() })`). The 1 ms ticker must
 * see a main-thread stretch of at least 4·BOUND (one heavy row), and every logged pid is this
 * process. So OT1's "< BOUND" cannot pass because the instrument is blind. Green on both trees.
 *
 * This file never references the embed-child client (R2): it must load on af682f2.
 * The burn is CPU time, not wall time (a departure from sync.test.ts E4, `:846`): a wall burn on
 * a loaded host would let the OS stretch the clock and make this control flaky.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { embedNullLearnings } from '../utils/learning-embed.js';

const BOUND = 50 * (process.env.CI ? 3 : 1);
const N = 50;
const BURN = new URL('../utils/__tests__/fixtures/embed-child/burn.mjs', import.meta.url).href;

const threadCpuMs = (): number => {
  const u = process.threadCpuUsage();
  return (u.user + u.system) / 1e3;
};

/** The learning-embed-yield.test.ts ticker: turns, and the most main-thread CPU between two. */
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

describe('TD-525 OT1c — the in-process control', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'td525-ot1c-'));
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
    const ins = db.prepare("INSERT INTO learnings (project, category, title, content) VALUES ('p', 'pattern', ?, ?)");
    for (let i = 0; i < N; i++) ins.run(`ot title ${i}`, `ot body ${i}`);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('OT1c: the same backlog in process holds the loop for at least 4·BOUND, in this pid', async () => {
    const log = join(dir, 'pids.jsonl');
    const { makeEmbed } = (await import(BURN)) as { makeEmbed: (o: object) => (t: string) => Promise<Float32Array> };
    const embed = makeEmbed({ load: 4 * BOUND, heavy: 4 * BOUND, heavyRows: 3, light: 2, wall: false, log });

    const stop = startTicker();
    const summary = await embedNullLearnings(db, { dryRun: false, yieldMs: 25, log: () => {} }, { embed });
    const lag = stop();

    const pids = readFileSync(log, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { pid: number }).pid);
    expect(summary).toMatchObject({ scanned: N, embedded: N, failures: 0 });
    expect(lag.maxGapCpuMs).toBeGreaterThanOrEqual(4 * BOUND);
    expect(pids).toHaveLength(N);
    expect(new Set(pids)).toEqual(new Set([process.pid]));
  }, 60_000);
});
