/**
 * BR-100 — the brain copy of the machine-identity module.
 *
 * Two halves:
 *   1. the PURE REGION replayed from `fixtures/machine-identity-fixtures.json`
 *      (the same table `cli/src/__tests__/machine-identity.test.ts` replays —
 *      a logic edit that is not mirrored reds on the other side);
 *   2. the brain I/O shell: the config path honours `IGRIS_BRAIN_DIR` (a WRITE
 *      seam — a build smoke under the seam must never mint into the operator's
 *      real `~/.igris/config.json`, the TD-426 class), an absent or malformed
 *      config is never created or clobbered, the mint is idempotent, the `wx`
 *      lockfile degrades to `id: null` without throwing, and a stale lock is
 *      broken.
 *
 * Every write here lands under `mkdtemp`. The fake-HOME witness proves the
 * real home is never touched; the suite additionally asserts the sandbox is
 * ARMED before each I/O case (a fence that is not armed is not a fence).
 *
 * @module __tests__/machine-identity.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, hostname: vi.fn(() => actual.hostname()) };
});

import {
  ensureMachineIdentity,
  isSameMachine,
  readMachineIdentity,
  resolveIdentity,
  withMintedId,
  withObservedHostname,
  type MachineIdentity,
} from '../machine-identity.js';

const HERE = dirname(fileURLToPath(import.meta.url));

interface Fixtures {
  resolve: Array<{ name: string; config: unknown; liveHostname: string; expected: MachineIdentity }>;
  sameMachine: Array<{
    name: string;
    row: { machine_id?: string | null; machine_hostname: string | null };
    me: MachineIdentity;
    expected: boolean;
  }>;
  observe: Array<{
    name: string;
    config: Record<string, unknown>;
    host: string;
    expected: { changed: boolean; aliases: string[] };
  }>;
}

const FIXTURES = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'machine-identity-fixtures.json'), 'utf-8'),
) as Fixtures;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function sha(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

// ---------------------------------------------------------------------------
// 1. Pure region — the shared fixture replay
// ---------------------------------------------------------------------------

describe('BR-100 pure region — fixture replay (brain copy)', () => {
  it('the fixture corpus is non-trivial and covers both verdicts of isSameMachine', () => {
    expect(FIXTURES.resolve.length).toBeGreaterThanOrEqual(8);
    expect(FIXTURES.sameMachine.some((c) => c.expected)).toBe(true);
    expect(FIXTURES.sameMachine.some((c) => !c.expected)).toBe(true);
    expect(FIXTURES.observe.some((c) => c.expected.changed)).toBe(true);
    expect(FIXTURES.observe.some((c) => !c.expected.changed)).toBe(true);
  });

  for (const c of FIXTURES.resolve) {
    it(`resolveIdentity: ${c.name}`, () => {
      expect(resolveIdentity(c.config, c.liveHostname)).toEqual(c.expected);
    });
  }

  for (const c of FIXTURES.sameMachine) {
    it(`isSameMachine: ${c.name}`, () => {
      expect(isSameMachine(c.row, c.me)).toBe(c.expected);
    });
  }

  for (const c of FIXTURES.observe) {
    it(`withObservedHostname: ${c.name}`, () => {
      const out = withObservedHostname(c.config, c.host);
      expect(out.changed).toBe(c.expected.changed);
      const block = out.next.machine as { aliases?: unknown };
      expect(block.aliases).toEqual(c.expected.aliases);
      if (!out.changed) expect(out.next).toBe(c.config); // identity, not a copy
    });
  }

  it('withMintedId sets id + minted_at, keeps sibling keys and existing aliases, never mutates its input', () => {
    const cfg = { remote_brain: { url: 'https://x' }, machine: { aliases: ['A', 7] } };
    const frozen = JSON.stringify(cfg);
    const next = withMintedId(cfg, 'X', '2026-09-06T00:00:00.000Z');
    expect(next).toEqual({
      remote_brain: { url: 'https://x' },
      machine: { id: 'X', aliases: ['A'], minted_at: '2026-09-06T00:00:00.000Z' },
    });
    expect(JSON.stringify(cfg)).toBe(frozen);
  });

  it('withMintedId on a config with no machine block creates one with empty aliases', () => {
    const next = withMintedId({ a: 1 }, 'X', 'T');
    expect(next).toEqual({ a: 1, machine: { id: 'X', aliases: [], minted_at: 'T' } });
  });
});

// ---------------------------------------------------------------------------
// 2. The brain I/O shell
// ---------------------------------------------------------------------------

describe('BR-100 brain I/O shell — IGRIS_BRAIN_DIR is the config WRITE seam', () => {
  let sandbox: string;
  let fakeHome: string;
  let witness: string;
  let witnessSha: string;
  let savedHome: string | undefined;
  let savedBrainDir: string | undefined;

  beforeEach(() => {
    // Restore keys INDIVIDUALLY: `process.env = saved` swaps in a plain object,
    // after which a later `process.env.HOME = …` never reaches libuv's getenv
    // and `os.homedir()` keeps the FIRST sandbox (measured: 8 cases red).
    savedHome = process.env.HOME;
    savedBrainDir = process.env.IGRIS_BRAIN_DIR;
    sandbox = mkdtempSync(join(tmpdir(), 'br100-brain-'));
    fakeHome = mkdtempSync(join(tmpdir(), 'br100-home-'));
    mkdirSync(join(fakeHome, '.igris'), { recursive: true });
    witness = join(fakeHome, '.igris', 'config.json');
    writeFileSync(witness, JSON.stringify({ machine: { id: 'home-id', aliases: ['home-host'] }, k: 1 }, null, 2) + '\n');
    witnessSha = sha(witness);
    process.env.HOME = fakeHome;
    process.env.IGRIS_BRAIN_DIR = sandbox;
    // The fence must be ARMED, not assumed.
    expect(process.env.IGRIS_BRAIN_DIR).toBe(sandbox);
    expect(os.homedir()).toBe(fakeHome);
    vi.mocked(os.hostname).mockReset();
    vi.mocked(os.hostname).mockImplementation(() => 'host-1');
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedBrainDir === undefined) delete process.env.IGRIS_BRAIN_DIR;
    else process.env.IGRIS_BRAIN_DIR = savedBrainDir;
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  function sandboxConfig(): string {
    return join(sandbox, 'config.json');
  }

  it('an ABSENT config.json → no mint, NO file created (init owns creation); identity = legacy posture', () => {
    const me = ensureMachineIdentity();
    expect(me).toEqual({ machine_id: null, hostname: 'host-1', aliases: ['host-1'] });
    expect(existsSync(sandboxConfig())).toBe(false);
    expect(sha(witness)).toBe(witnessSha);
  });

  it('a MALFORMED config.json is never clobbered (byte witness) and yields the legacy posture', () => {
    writeFileSync(sandboxConfig(), '{ not json');
    const before = sha(sandboxConfig());
    const me = ensureMachineIdentity();
    expect(me.machine_id).toBeNull();
    expect(sha(sandboxConfig())).toBe(before);
  });

  it('mints ONCE into <IGRIS_BRAIN_DIR>/config.json, seeds aliases with the live hostname, stamps minted_at; the real-home witness is untouched', () => {
    writeFileSync(sandboxConfig(), JSON.stringify({ remote_brain: { url: 'https://x', api_key: 'k' }, cognition: { janitor: { enabled: true } } }, null, 2) + '\n');
    const first = ensureMachineIdentity();
    expect(first.machine_id).toMatch(UUID_V4);
    expect(first.aliases).toEqual(['host-1']);

    const second = ensureMachineIdentity();
    expect(second.machine_id).toBe(first.machine_id);

    const stored = JSON.parse(readFileSync(sandboxConfig(), 'utf-8')) as Record<string, unknown>;
    // Sibling keys preserved, in order.
    expect(Object.keys(stored)).toEqual(['remote_brain', 'cognition', 'machine']);
    expect(stored.remote_brain).toEqual({ url: 'https://x', api_key: 'k' });
    expect(stored.cognition).toEqual({ janitor: { enabled: true } });
    const block = stored.machine as { id: string; aliases: string[]; minted_at: string };
    expect(block.id).toBe(first.machine_id);
    expect(block.aliases).toEqual(['host-1']);
    expect(Number.isNaN(Date.parse(block.minted_at))).toBe(false);
    // TD-220: mode 600 after the write.
    if (process.platform !== 'win32') expect(statSync(sandboxConfig()).mode & 0o777).toBe(0o600);
    // The real home was never touched.
    expect(sha(witness)).toBe(witnessSha);
    expect(readFileSync(witness, 'utf-8')).not.toContain(first.machine_id as string);
  });

  it('the hostname is read at CALL time: a changed hostname is appended to machine.aliases on the next ensure, the id is unchanged', () => {
    writeFileSync(sandboxConfig(), '{}\n');
    const a = ensureMachineIdentity();
    vi.mocked(os.hostname).mockImplementation(() => 'host-2');
    const b = ensureMachineIdentity();
    expect(b.machine_id).toBe(a.machine_id);
    expect(b.hostname).toBe('host-2');
    expect(b.aliases).toEqual(['host-1', 'host-2']);
    const stored = JSON.parse(readFileSync(sandboxConfig(), 'utf-8')) as { machine: { aliases: string[] } };
    expect(stored.machine.aliases).toEqual(['host-1', 'host-2']);
    // A third ensure under host-2 is a pure no-op (no write): mtime pinned.
    const mtime = statSync(sandboxConfig()).mtimeMs;
    utimesSync(sandboxConfig(), new Date(mtime - 60_000), new Date(mtime - 60_000));
    const pinned = statSync(sandboxConfig()).mtimeMs;
    ensureMachineIdentity();
    expect(statSync(sandboxConfig()).mtimeMs).toBe(pinned);
  });

  it('readMachineIdentity is PURE: it never writes, and unions the live hostname in memory only', () => {
    writeFileSync(sandboxConfig(), JSON.stringify({ machine: { id: 'X', aliases: ['old'] } }) + '\n');
    const before = sha(sandboxConfig());
    const me = readMachineIdentity();
    expect(me).toEqual({ machine_id: 'X', hostname: 'host-1', aliases: ['old', 'host-1'] });
    expect(sha(sandboxConfig())).toBe(before);
  });

  it('with IGRIS_BRAIN_DIR unset the resolver falls back to `os.homedir()` at CALL time (read path)', () => {
    delete process.env.IGRIS_BRAIN_DIR;
    const me = readMachineIdentity();
    expect(me.machine_id).toBe('home-id');
    expect(me.aliases).toEqual(['home-host', 'host-1']);
  });

  it('under a test runner with IGRIS_BRAIN_DIR unset, the WRITER is contained: no mint into the (fake) home config', () => {
    delete process.env.IGRIS_BRAIN_DIR;
    writeFileSync(witness, '{}\n');
    const w = sha(witness);
    const me = ensureMachineIdentity();
    expect(me.machine_id).toBeNull();
    expect(sha(witness)).toBe(w);
  });

  it('a HELD lock → ensure returns id:null, writes nothing, throws nothing, one stderr line', () => {
    writeFileSync(sandboxConfig(), '{}\n');
    writeFileSync(`${sandboxConfig()}.lock`, String(process.pid));
    const before = sha(sandboxConfig());
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const me = ensureMachineIdentity();
      expect(me.machine_id).toBeNull();
      expect(me.aliases).toEqual(['host-1']);
      expect(sha(sandboxConfig())).toBe(before);
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0][0])).toMatch(/machine-identity.*lock/);
    } finally {
      err.mockRestore();
    }
  });

  it('a STALE lock (older than 5 s) is broken and the mint proceeds', () => {
    writeFileSync(sandboxConfig(), '{}\n');
    const lock = `${sandboxConfig()}.lock`;
    writeFileSync(lock, '1');
    const old = new Date(Date.now() - 10_000);
    utimesSync(lock, old, old);
    const me = ensureMachineIdentity();
    expect(me.machine_id).toMatch(UUID_V4);
    expect(existsSync(lock)).toBe(false);
  });
});
