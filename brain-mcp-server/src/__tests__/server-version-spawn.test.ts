/**
 * TD-518 — real MCP handshakes: the brain's `initialize` answer and both
 * startup banners carry `brain-mcp-server/package.json`'s version, on BOTH
 * transports (AC-1, AC-2). The first test tier in this repo to send a real MCP
 * `initialize`.
 *
 * HOW. The SDK `Client` drives the server exactly as a harness does:
 *  - P1 (stdio): `StdioClientTransport` spawns `node --import tsx src/index.ts`.
 *  - P2 (http): the test spawns `… src/index.ts --http --port <free> --host
 *    127.0.0.1` and connects a `StreamableHTTPClientTransport`; it also reads
 *    the authenticated REST body `GET /api/brain-stats`, the sixth site.
 * The SOURCE runs through tsx, never `dist/`: the CI `brain-vitest` job does
 * not build, and a `skipIf(!dist)` would add a skip to the count that
 * `.github/workflows/test.yml` narrates for that job. The BUILT bundle's layout
 * is pinned in the cli suite (`cli/src/__tests__/tarball.test.ts`, the TD-518
 * bundled-layout initialize tier).
 *
 * FENCE (TD-426, test_standards "real-process tier"). The child env is an
 * EXPLICIT MINIMAL OBJECT, never a spread of `process.env`: a fresh mkdtemp
 * `HOME`, a fresh `IGRIS_BRAIN_DIR` sandbox, `PATH`, `TMPDIR` (tsx's cache) and,
 * for P2 only, `BRAIN_API_KEY`. So `IGRIS_DB_PATH`, `IGRIS_PIDS_DIR`,
 * `BRAIN_HTTP` (which would flip the stdio child into http mode), `BRAIN_PORT`,
 * `BRAIN_HOST`, `NODE_OPTIONS`, `VITEST*`, `TEST`, `NODE_ENV` and
 * `IGRIS_REAL_HOME` are absent by construction. (`StdioClientTransport` adds
 * only its own safe list — HOME, LOGNAME, PATH, SHELL, TERM, USER — under ours,
 * so our `HOME` wins.) Each test asserts the DB landed in the sandbox and the
 * fake-HOME default path was never created.
 *
 * TIMING. Readiness is observed evidence (the SDK handshake; the http banner's
 * version-independent `started (http, <host:port>)` tail),
 * never a sleep. Every `it` carries SPAWN_TEST_TIMEOUT_MS; P1's hang stop is
 * the SDK's close escalation (stdin end, then SIGTERM, then SIGKILL), P2's is
 * an explicit SIGKILL at HTTP_HANG_STOP_MS.
 *
 * RED-first on c5c523f: `serverInfo.version` '7.2.0' (expected the package's
 * 7.4.0), both banners `v7.2.0`, `/api/brain-stats` version '7.2.0'.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAIN_ROOT = resolve(HERE, '..', '..');
const ENTRY = join(BRAIN_ROOT, 'src', 'index.ts');
/** The package manifest, read with fs — the oracle every assertion compares against. */
const PKG = JSON.parse(readFileSync(join(BRAIN_ROOT, 'package.json'), 'utf-8')) as {
  name: string;
  version: string;
};

/** Per-`it` budget: a cold tsx boot of the whole engine, twice under CI load. */
const SPAWN_TEST_TIMEOUT_MS = 60_000;
/** Initialize-request budget handed to the SDK (inside the per-test budget). */
const HANDSHAKE_TIMEOUT_MS = 45_000;
/** P2: the http child is SIGKILLed if still alive after this. */
const HTTP_HANG_STOP_MS = 45_000;
/** P2: the http banner must appear within this. */
const HTTP_READY_DEADLINE_MS = 30_000;
/** How long to wait for the child's stderr to close after the client is closed. */
const STDERR_END_DEADLINE_MS = 15_000;

interface Sandbox {
  fakeHome: string;
  brainDir: string;
  sandboxDb: string;
  fakeDefaultDb: string;
  env: Record<string, string>;
  cleanup: () => void;
}

/** A fresh fake HOME + IGRIS_BRAIN_DIR sandbox and the minimal child env that points at them. */
function makeSandbox(): Sandbox {
  const fakeHome = mkdtempSync(join(tmpdir(), 'td518-home-'));
  const brainDir = mkdtempSync(join(tmpdir(), 'td518-brain-'));
  // Pre-create BOTH memory/ parents: better-sqlite3 never creates a parent dir,
  // and a throw there would masquerade as a clean early exit (TD-426 idiom).
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

/** Assert the child stayed in its sandbox (TD-426 escape check). */
function expectFenced(sb: Sandbox, stderr: string): void {
  expect(stderr).toContain(`[brain] db: ${sb.sandboxDb}`);
  expect(existsSync(sb.sandboxDb)).toBe(true);
  expect(existsSync(sb.fakeDefaultDb)).toBe(false);
  expect(existsSync(join(sb.fakeHome, '.igris', 'brain-mcp-server.pids'))).toBe(false);
}

/** Reject after `ms` with `what` and the child's stderr so far. */
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

/** A port that was free on 127.0.0.1 a moment ago (the brain rejects `--port 0`). */
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

describe('TD-518 — the brain reports package.json version over a real MCP handshake', () => {
  it('P1 stdio: initialize returns serverInfo.version === package.json version, and the banner prints it (TD-518 AC-1, AC-2)', async () => {
    expect(PKG.name).toBe('igris-brain-mcp-server');
    expect(PKG.version).toMatch(/^\d+\.\d+\.\d+/);
    const sb = makeSandbox();
    let stderr = '';
    try {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', ENTRY],
        cwd: BRAIN_ROOT,
        env: sb.env,
        stderr: 'pipe',
      });
      // Collected BEFORE connect: the PassThrough exists from construction.
      const stderrStream = transport.stderr;
      if (stderrStream === null) throw new Error('StdioClientTransport did not pipe stderr');
      stderrStream.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });
      const stderrEnded = new Promise<void>((done) => stderrStream.once('end', () => done()));

      const client = new Client({ name: 'td518-probe', version: '0.0.0' });
      let serverInfo: ReturnType<Client['getServerVersion']> = undefined;
      try {
        await client.connect(transport, { timeout: HANDSHAKE_TIMEOUT_MS }).catch((err: unknown) => {
          throw new Error(`stdio handshake failed: ${String(err)}\n--- child stderr ---\n${stderr}`);
        });
        serverInfo = client.getServerVersion();
      } finally {
        await client.close();
        await deadline(stderrEnded, STDERR_END_DEADLINE_MS, 'stdio child stderr end', () => stderr);
      }

      // Soft, so one run reports every wrong site (serverInfo AND banner).
      expect.soft(serverInfo?.version).toBe(PKG.version);
      expect.soft(serverInfo).toEqual({ name: 'igris-brain', version: PKG.version });
      expect.soft(stderr).toContain(`Igris Brain MCP Server v${PKG.version} started (stdio)`);
      expect(stderr).not.toContain('[brain] version unknown');
      expectFenced(sb, stderr);
    } finally {
      sb.cleanup();
    }
  }, SPAWN_TEST_TIMEOUT_MS);

  it('P2 http: initialize and /api/brain-stats report package.json version, and the banner prints it (TD-518 AC-1, AC-2)', async () => {
    const sb = makeSandbox();
    const apiKey = 'td518-test-key';
    const port = await freePort();
    // Readiness keys on the banner's version-independent tail, so a wrong
    // version fails fast at the exact-banner assertion below, not at a deadline.
    const listening = `started (http, 127.0.0.1:${port})`;
    const banner = `Igris Brain MCP Server v${PKG.version} ${listening}`;
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
      // Readiness = the listening banner, or the child dying first.
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
      // Soft, so one run reports every wrong site (banner, serverInfo, brain-stats).
      expect.soft(stderr).toContain(banner);

      const headers = { Authorization: `Bearer ${apiKey}` };
      const client = new Client({ name: 'td518-probe', version: '0.0.0' });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
            requestInit: { headers },
          }),
          { timeout: HANDSHAKE_TIMEOUT_MS },
        );
        const serverInfo = client.getServerVersion();
        expect.soft(serverInfo?.version).toBe(PKG.version);
        expect.soft(serverInfo).toEqual({ name: 'igris-brain', version: PKG.version });
      } finally {
        await client.close();
      }

      const res = await fetch(`http://127.0.0.1:${port}/api/brain-stats`, { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { version?: unknown };
      expect.soft(body.version).toBe(PKG.version);

      // SIGTERM runs shutdownHttp, which exits 0.
      child.kill('SIGTERM');
      const { code, signal } = await exited;
      expect({ code, signal }, stderr).toEqual({ code: 0, signal: null });
      expect(stderr).not.toContain('[brain] version unknown');
      expectFenced(sb, stderr);
    } finally {
      clearTimeout(hangStop);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      sb.cleanup();
    }
  }, SPAWN_TEST_TIMEOUT_MS);
});
