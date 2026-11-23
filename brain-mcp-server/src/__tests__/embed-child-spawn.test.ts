/**
 * TD-525 — the embed child at the process level (ES0c-ES8c). Real parent processes, real
 * children, real signals; the vitest worker loads no native addon.
 *
 * Each parent runs `node --import tsx fixtures/embed-child/parent.mjs <mode> <compiledDir>` with
 * cwd BRAIN_ROOT and an EXPLICIT minimal env (PATH, TMPDIR, a fresh mkdtemp HOME — the BR-117 /
 * TD-518 strip: no NODE_OPTIONS, no VITEST*, nothing spread from process.env). The parent imports
 * the client COMPILED to plain JS by `compile.mjs` (R8), so every child whose exit status is
 * asserted runs with `execArgv []` and no tsx loader thread. Children that hold real ORT use
 * `ort-matmul.mjs` (a MatMul session, no model file). The parent prints `FORKS <n>` (its
 * `syncBuiltinESMExports` fork counter) and `EXIT <pid> <code> <signal>` per child on stderr.
 *
 * SIG is the L-130 family. ES0c arms the detector. The Phase 0 gate found that on Linux a
 * `process.exit` with ORT loaded does NOT abort (G2: the G1 and G3 exit matrices re-run in Docker
 * node:22-bookworm, linux/arm64 only, node 22.23.5; x86_64 unmeasured), so on CI the
 * "no SIG, exit 0" checks are regression gates and ES0c is the armed control; on darwin an
 * ORT-only exit aborts 5/5.
 *
 * The controls ES0c, ES1c and ES8c never touch the client, so they run on a tree without it.
 * Every parent has a SIGKILL hang stop, and every `it` an explicit timeout (TD-336).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAIN_ROOT = resolve(HERE, '..', '..');
const FIX = join(BRAIN_ROOT, 'src', 'utils', '__tests__', 'fixtures', 'embed-child');
const PARENT = join(FIX, 'parent.mjs');
const SIG = /libc\+\+abi|mutex lock failed|terminate called|Segmentation fault|FATAL ERROR/;
const HANG_STOP_MS = 60_000;

interface Run {
  child: ChildProcess;
  out: () => string;
  err: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>;
  stderrEnd: Promise<number>;
  cleanup: () => void;
}

function runParent(mode: string, dir: string, arg?: string, opts: { detached?: boolean; stdin?: boolean } = {}): Run {
  const home = mkdtempSync(join(tmpdir(), 'td525-es-home-'));
  const child = spawn(process.execPath, ['--import', 'tsx', PARENT, mode, dir, ...(arg ? [arg] : [])], {
    cwd: BRAIN_ROOT,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: tmpdir(), HOME: home },
    stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    detached: opts.detached ?? false,
  });
  let out = '';
  let err = '';
  child.stdout!.on('data', (d: Buffer) => (out += d));
  child.stderr!.on('data', (d: Buffer) => (err += d));
  const stderrEnd = new Promise<number>((r) => child.stderr!.once('end', () => r(performance.now())));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((r) =>
    child.once('exit', (code, signal) => r({ code, signal, at: performance.now() })),
  );
  const hang = setTimeout(() => child.kill('SIGKILL'), HANG_STOP_MS);
  void exited.then(() => clearTimeout(hang));
  return {
    child,
    out: () => out,
    err: () => err,
    exited,
    stderrEnd,
    cleanup: () => {
      clearTimeout(hang);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function goneWithin(pid: number, ms: number): Promise<number | null> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (!alive(pid)) return Math.round(performance.now() - t0);
    await sleep(20);
  }
  return alive(pid) ? null : Math.round(performance.now() - t0);
}
async function waitFor(pred: () => boolean, ms: number, what: string, err: () => string): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms\n--- stderr ---\n${err()}`);
    await sleep(20);
  }
}
const childPid = (err: string): number => Number(/CHILD (\d+)/.exec(err)?.[1]);
const forks = (err: string): number | null => (/FORKS (\d+)/.exec(err) ? Number(/FORKS (\d+)/.exec(err)![1]) : null);
const jsonLines = (out: string): unknown[] => out.split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown);

describe('TD-525 — spawn-tier controls (no client needed)', () => {
  it('ES0c: the SIG detector is armed — an L-130 abort reads as SIGABRT plus a SIG line', async () => {
    const child = spawn(process.execPath, [join(FIX, 'abort-child.mjs')], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: tmpdir() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d));
    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
      child.once('close', (c, s) => r({ code: c, signal: s })),
    );
    expect({ code, signal }).toEqual({ code: null, signal: 'SIGABRT' });
    expect(err).toMatch(SIG);
  }, 30_000);

  it('ES1c: with stdio inherit, a child\'s three fd-1 writes DO reach the parent\'s stdout', async () => {
    const r = runParent('leak-control', '-');
    try {
      const { code } = await r.exited;
      expect(code).toBe(0);
      for (const m of ['LEAK-console.log', 'LEAK-stdout.write', 'LEAK-fd1']) expect(r.out()).toContain(m);
    } finally {
      r.cleanup();
    }
  }, 60_000);

  it('ES8c: unarmed, the closed-port empty-cache load fails on the FETCH, and writes nothing', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'td525-es8c-cache-'));
    const r = runParent('offline-control', '-', cache);
    try {
      const { code } = await r.exited;
      expect(code, r.err()).toBe(0);
      const [res] = jsonLines(r.out()) as Array<{ name: string; message: string }>;
      expect(res.name).toBe('EmbeddingsUnavailableError');
      expect(res.message).toMatch(/fetch failed/);
      expect(readdirSync(cache, { recursive: true })).toHaveLength(0);
    } finally {
      r.cleanup();
      rmSync(cache, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('TD-525 — the embed child at the process level', () => {
  let compiled: { dir: string };

  beforeAll(async () => {
    const { compileEmbedChild } = (await import(join(FIX, 'compile.mjs'))) as { compileEmbedChild: () => { dir: string } };
    compiled = compileEmbedChild();
  }, 60_000);

  afterAll(() => {
    if (compiled) rmSync(compiled.dir, { recursive: true, force: true });
  });

  it('ES1: the child\'s fd-1 writes land on the parent\'s STDERR; its stdout is one JSON line', async () => {
    const r = runParent('leak', compiled.dir);
    try {
      const { code } = await r.exited;
      expect(code, r.err()).toBe(0);
      const lines = r.out().split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual({ mode: 'leak', len: 384 });
      for (const m of ['LEAK-console.log', 'LEAK-stdout.write', 'LEAK-fd1']) expect(r.err()).toContain(m);
    } finally {
      r.cleanup();
    }
  }, 60_000);

  it('ES2 / ES2c: an idle child never holds the parent open; a pending request does', async () => {
    const r = runParent('natural', compiled.dir);
    try {
      await waitFor(() => r.out().includes('"natural"'), 45_000, 'natural result', r.err);
      const resultAt = performance.now();
      const { code, signal, at } = await r.exited;
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      expect(at - resultAt).toBeLessThanOrEqual(3_000);
      expect(await goneWithin(childPid(r.err()), 2_000)).not.toBeNull();
      await r.stderrEnd;
      expect(r.err()).not.toMatch(SIG);
    } finally {
      r.cleanup();
    }

    const h = runParent('busy-hold', compiled.dir, '1500');
    try {
      const { code } = await h.exited;
      expect(code, h.err()).toBe(0);
      const [res] = jsonLines(h.out()) as Array<{ ms: number; len: number }>;
      expect(res.len).toBe(384);
      expect(res.ms).toBeGreaterThanOrEqual(1_450);
    } finally {
      h.cleanup();
    }
  }, 120_000);

  it('ES3 / ES3b (R12): a SIGKILLed parent never leaves its child behind — idle or busy', async () => {
    for (const mode of ['orphan-idle', 'orphan-busy']) {
      const r = runParent(mode, compiled.dir);
      try {
        await waitFor(() => r.err().includes('READY'), 45_000, `${mode} ready`, r.err);
        const pid = childPid(r.err());
        const t0 = performance.now();
        r.child.kill('SIGKILL');
        await r.exited;
        const gone = await goneWithin(pid, mode === 'orphan-idle' ? 3_000 : 5_000);
        const eofMs = Math.round((await Promise.race([r.stderrEnd, sleep(10_000).then(() => Infinity)])) - t0);
        console.error(`[td525 ES3] ${mode}: child gone in ${gone} ms, parent-stderr EOF ${eofMs} ms, drain timeout ${/drain timeout/.test(r.err())}`);
        expect(gone, `${mode} child ${pid} still alive`).not.toBeNull();
        expect(eofMs).toBeLessThanOrEqual(5_000);
        expect(r.err()).not.toMatch(SIG);
      } finally {
        r.cleanup();
      }
    }
  }, 120_000);

  it('ES4 (R7): a group SIGINT ×10 — parent exits 0, child gone, exactly one fork, no SIG', async () => {
    for (let i = 0; i < 10; i++) {
      const r = runParent('group', compiled.dir, undefined, { detached: true });
      try {
        await waitFor(() => r.err().includes('READY'), 45_000, `group ${i} ready`, r.err);
        const pid = childPid(r.err());
        process.kill(-r.child.pid!, 'SIGINT');
        const { code, signal } = await r.exited;
        expect({ i, code, signal }).toEqual({ i, code: 0, signal: null });
        expect(await goneWithin(pid, 2_000)).not.toBeNull();
        await Promise.race([r.stderrEnd, sleep(5_000)]);
        expect(forks(r.err())).toBe(1);
        expect(r.err()).not.toMatch(SIG);
      } finally {
        r.cleanup();
      }
    }
  }, 300_000);

  it('ES5: the stdio shape — stdin EOF runs the teardown with a busy ORT child: exit 0, child gone, stdout clean', async () => {
    const r = runParent('stdio-shape', compiled.dir, undefined, { stdin: true });
    try {
      await waitFor(() => r.err().includes('READY'), 45_000, 'stdio-shape ready', r.err);
      const pid = childPid(r.err());
      const t0 = performance.now();
      r.child.stdin!.end();
      const { code, signal, at } = await r.exited;
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      expect(at - t0).toBeLessThanOrEqual(5_000);
      expect(await goneWithin(pid, 2_000)).not.toBeNull();
      await Promise.race([r.stderrEnd, sleep(5_000)]);
      expect(r.out().split('\n').filter(Boolean)).toHaveLength(1);
      expect(jsonLines(r.out())[0]).toMatchObject({ mode: 'stdio-shape' });
      expect(r.err()).not.toMatch(SIG);
    } finally {
      r.cleanup();
    }
  }, 90_000);

  it('ES6: the HTTP shape — SIGTERM → shutdown → exit(0) with a busy ORT child: exit 0, child gone, no SIG', async () => {
    const r = runParent('http-shape', compiled.dir);
    try {
      await waitFor(() => r.err().includes('READY'), 45_000, 'http-shape ready', r.err);
      const pid = childPid(r.err());
      r.child.kill('SIGTERM');
      const { code, signal } = await r.exited;
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      expect(await goneWithin(pid, 2_000)).not.toBeNull();
      await Promise.race([r.stderrEnd, sleep(5_000)]);
      expect(r.err()).not.toMatch(SIG);
    } finally {
      r.cleanup();
    }
  }, 90_000);

  it('ES8 (D5): armed offline, the same load fails LOCALLY (G7 text), never fetches, writes nothing', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'td525-es8-cache-'));
    const r = runParent('offline', compiled.dir, cache);
    try {
      const { code } = await r.exited;
      expect(code, r.err()).toBe(0);
      const [res] = jsonLines(r.out()) as Array<{ name: string; message: string }>;
      expect(res.name).toBe('EmbeddingsUnavailableError');
      expect(res.message).toMatch(/allowRemoteModels=false.*not found locally/);
      expect(res.message).not.toMatch(/fetch failed/);
      expect(readdirSync(cache, { recursive: true })).toHaveLength(0);
    } finally {
      r.cleanup();
      rmSync(cache, { recursive: true, force: true });
    }
  }, 60_000);
});
