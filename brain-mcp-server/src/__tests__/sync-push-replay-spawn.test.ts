/**
 * BR-121 P3 — the REAL `/sync/push` route answers a byte-identical re-send
 * from its receipt ledger. The in-process tests (`sync.test.ts` R1-R7) drive
 * `receiveSyncPush` with a digest they compute themselves; only a real HTTP
 * child proves the route-level `express.json({ verify })` hook hashes the
 * exact bytes it received, and that the route consults the ledger at all.
 *
 * HOW. The test spawns `node --import tsx src/index.ts --http --port <free>
 * --host 127.0.0.1` and POSTs one body twice, then a body that differs only in
 * `pushed_at`. The table is `event_log`, never `learnings`: a learnings merge
 * schedules the post-merge embed pass, which would load the MiniLM model.
 *
 * FENCE (TD-426, test_standards "real-process tier") — the helpers are copied
 * from `server-version-spawn.test.ts` P2: the child env is an EXPLICIT MINIMAL
 * OBJECT (fresh mkdtemp `HOME`, fresh `IGRIS_BRAIN_DIR`, `PATH`, `TMPDIR`,
 * `BRAIN_API_KEY`), never a spread of `process.env`; the test asserts the DB
 * landed in the sandbox and the fake-HOME default path was never created.
 * Readiness is the http banner's `started (http, <host:port>)` tail, never a
 * sleep; the hang stop is an explicit SIGKILL.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAIN_ROOT = resolve(HERE, '..', '..');
const ENTRY = join(BRAIN_ROOT, 'src', 'index.ts');

const SPAWN_TEST_TIMEOUT_MS = 60_000;
const HTTP_HANG_STOP_MS = 45_000;
const HTTP_READY_DEADLINE_MS = 30_000;

interface Sandbox {
  fakeHome: string;
  brainDir: string;
  sandboxDb: string;
  fakeDefaultDb: string;
  env: Record<string, string>;
  cleanup: () => void;
}

function makeSandbox(): Sandbox {
  const fakeHome = mkdtempSync(join(tmpdir(), 'br121-home-'));
  const brainDir = mkdtempSync(join(tmpdir(), 'br121-brain-'));
  // better-sqlite3 never creates a parent dir (TD-426 idiom).
  mkdirSync(join(fakeHome, '.igris', 'memory'), { recursive: true });
  mkdirSync(join(brainDir, 'memory'), { recursive: true });
  return {
    fakeHome,
    brainDir,
    sandboxDb: join(brainDir, 'memory', 'knowledge.db'),
    fakeDefaultDb: join(fakeHome, '.igris', 'memory', 'knowledge.db'),
    env: {
      HOME: fakeHome,
      IGRIS_BRAIN_DIR: brainDir,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      TMPDIR: tmpdir(),
    },
    cleanup: () => {
      rmSync(brainDir, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    },
  };
}

function expectFenced(sb: Sandbox, stderr: string): void {
  expect(stderr).toContain(`[brain] db: ${sb.sandboxDb}`);
  expect(existsSync(sb.sandboxDb)).toBe(true);
  expect(existsSync(sb.fakeDefaultDb)).toBe(false);
  expect(existsSync(join(sb.fakeHome, '.igris', 'brain-mcp-server.pids'))).toBe(false);
}

function deadline<T>(p: Promise<T>, ms: number, what: string, stderr: () => string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what}: no result within ${ms} ms\n--- child stderr ---\n${stderr()}`)),
      ms,
    );
  });
  return Promise.race([p, stop]).finally(() => clearTimeout(timer));
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => (port > 0 ? resolvePort(port) : reject(new Error('no port assigned'))));
    });
  });
}

describe('BR-121 — the real /sync/push route replays a byte-identical re-send', () => {
  it('P3: identical bytes twice → the second reply is replayed; a different pushed_at merges', async () => {
    const sb = makeSandbox();
    const apiKey = 'br121-test-key';
    const port = await freePort();
    const listening = `started (http, 127.0.0.1:${port})`;
    let stderr = '';
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', ENTRY, '--http', '--port', String(port), '--host', '127.0.0.1'],
      { cwd: BRAIN_ROOT, env: { ...sb.env, BRAIN_API_KEY: apiKey }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const hangStop = setTimeout(() => child.kill('SIGKILL'), HTTP_HANG_STOP_MS);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
      child.once('exit', (code, signal) => done({ code, signal })),
    );
    try {
      const ready = new Promise<void>((done, fail) => {
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf-8');
          if (stderr.includes(listening)) done();
        });
        void exited.then(({ code, signal }) =>
          fail(new Error(`http child exited before its banner: code=${code} signal=${signal}\n${stderr}`)),
        );
      });
      await deadline(ready, HTTP_READY_DEADLINE_MS, `http banner "…${listening}"`, () => stderr);

      const row = { id: 121, event_name: 'br121', component: 'p3', payload: '{}', created_at: '2026-11-23 00:00:00' };
      const body = (pushedAt: string) => JSON.stringify({ tables: { event_log: [row] }, pushed_at: pushedAt, schema_version: 9 });
      const post = async (raw: string) => {
        const res = await fetch(`http://127.0.0.1:${port}/sync/push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: raw,
        });
        return { status: res.status, json: (await res.json()) as Record<string, unknown> };
      };

      const same = body('2026-11-23 00:00:01');
      const first = await post(same);
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ ok: true, results: { event_log: { inserted: 1 } } });
      expect(first.json).not.toHaveProperty('replayed');

      const second = await post(same);
      expect(second.status).toBe(200);
      expect(second.json).toEqual({ ...first.json, replayed: true });

      const third = await post(body('2026-11-23 00:00:02'));
      expect(third.status).toBe(200);
      expect(third.json).not.toHaveProperty('replayed');
      expect(third.json).toMatchObject({ results: { event_log: { inserted: 0, skipped: 1 } } });

      child.kill('SIGTERM');
      const { code, signal } = await exited;
      expect({ code, signal }, stderr).toEqual({ code: 0, signal: null });
      expect(stderr.match(/\[brain\] \/sync\/push replay [0-9a-f]{12}/g)).toHaveLength(1);
      expectFenced(sb, stderr);
    } finally {
      clearTimeout(hangStop);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      sb.cleanup();
    }
  }, SPAWN_TEST_TIMEOUT_MS);
});
