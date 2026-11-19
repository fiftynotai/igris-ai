/**
 * TD-361 — the run-owner classifier and its instruments, in isolation.
 *
 * `classifyRunOwner` is PURE: every probe (`isAlive`, `startTimeOf`) and every
 * fact (`me`, `selfPid`, `inFlight`, `legacyHorizonMs`) is injected, so each row
 * of the design table is its own case with no real process involved. The
 * daemon-level behaviour against REAL child processes is `daemon-wedge.test.ts`.
 *
 * The one rule every case below serves: a row is DEAD only when its owner
 * provably cannot finish it. Every unprovable state is ALIVE.
 *
 * @module engine/components/schedules/__tests__/run-liveness.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyRunOwner,
  computeLegacyHorizon,
  normalizeStartedAt,
  type LivenessEnv,
  type RunOwnerRow,
} from '../run-liveness.js';
import { parseEtime } from '../../../../process-liveness.js';
import { pidsDir } from '../../../../stdio-lifecycle.js';

const ME = { machine_id: 'm-local', hostname: 'host-a', aliases: ['host-a'] };
const SELF_PID = 4242;
const SELF_START = 'Thu Sep 24 13:29:57 2026';
const OTHER_PID = 5151;
const OTHER_START = 'Thu Sep 24 09:00:00 2026';

function env(over: Partial<LivenessEnv> = {}): LivenessEnv {
  return {
    me: ME,
    selfPid: SELF_PID,
    selfStartedAt: SELF_START,
    inFlight: new Set<string>(),
    isAlive: () => true,
    startTimeOf: () => OTHER_START,
    legacyHorizonMs: Date.parse('2026-09-24T10:00:00Z'),
    ...over,
  };
}

function stamped(over: Partial<RunOwnerRow> = {}): RunOwnerRow {
  return {
    id: 'run-x',
    started_at: '2026-09-24T09:00:00.000Z',
    machine_id: 'm-local',
    machine_hostname: 'host-a',
    owner_pid: OTHER_PID,
    owner_started_at: OTHER_START,
    ...over,
  };
}

function legacy(startedAt: string): RunOwnerRow {
  return { id: 'run-legacy', started_at: startedAt };
}

describe('classifyRunOwner — the design table (TD-361)', () => {
  it('owner stamped on ANOTHER machine id → DEAD owner_foreign_machine', () => {
    expect(classifyRunOwner(stamped({ machine_id: 'm-foreign' }), env()))
      .toEqual({ alive: false, reason: 'owner_foreign_machine' });
  });

  it('a NULL machine_id falls back to the hostname alias list (BR-100 isSameMachine)', () => {
    expect(classifyRunOwner(stamped({ machine_id: null, machine_hostname: 'host-b' }), env()).reason)
      .toBe('owner_foreign_machine');
    expect(classifyRunOwner(stamped({ machine_id: null, machine_hostname: 'host-a' }), env()).alive)
      .toBe(true);
  });

  it('THIS process, run in flight → ALIVE self_in_flight', () => {
    const row = stamped({ id: 'run-mine', owner_pid: SELF_PID, owner_started_at: SELF_START });
    expect(classifyRunOwner(row, env({ inFlight: new Set(['run-mine']) })))
      .toEqual({ alive: true, reason: 'self_in_flight' });
  });

  it('THIS process, run NOT in flight → DEAD self_not_in_flight (a writer that skipped the registry)', () => {
    const row = stamped({ id: 'run-mine', owner_pid: SELF_PID, owner_started_at: SELF_START });
    expect(classifyRunOwner(row, env()))
      .toEqual({ alive: false, reason: 'self_not_in_flight' });
  });

  it('same machine, owner pid not alive → DEAD owner_dead', () => {
    expect(classifyRunOwner(stamped(), env({ isAlive: () => false })))
      .toEqual({ alive: false, reason: 'owner_dead' });
  });

  it('same machine, pid alive but its start time differs from the stamp → DEAD owner_pid_reused', () => {
    expect(classifyRunOwner(stamped(), env({ startTimeOf: () => 'Fri Sep 25 01:00:00 2026' })))
      .toEqual({ alive: false, reason: 'owner_pid_reused' });
  });

  it('same machine, pid alive, start time UNREADABLE (ps unavailable) → ALIVE pid_only_unverified', () => {
    expect(classifyRunOwner(stamped(), env({ startTimeOf: () => null })))
      .toEqual({ alive: true, reason: 'pid_only_unverified' });
  });

  it('same machine, pid alive, stamp carries NO start time → ALIVE pid_only_unverified (never guessed as reuse)', () => {
    expect(classifyRunOwner(stamped({ owner_started_at: null }), env()))
      .toEqual({ alive: true, reason: 'pid_only_unverified' });
  });

  it('same machine, pid alive, start time matches → ALIVE pid_start_time — however old the run', () => {
    const ancient = stamped({ started_at: '2020-01-01T00:00:00.000Z' });
    expect(classifyRunOwner(ancient, env()))
      .toEqual({ alive: true, reason: 'pid_start_time' });
  });

  it('legacy row (no owner) that started BEFORE every live brain process → DEAD legacy_predates_live_processes', () => {
    expect(classifyRunOwner(legacy('2026-09-11T23:53:22.291Z'), env()))
      .toEqual({ alive: false, reason: 'legacy_predates_live_processes' });
  });

  it('legacy row that started AFTER the horizon → ALIVE legacy_unprovable', () => {
    expect(classifyRunOwner(legacy('2026-09-24T10:00:01.000Z'), env()))
      .toEqual({ alive: true, reason: 'legacy_unprovable' });
  });

  it('legacy row exactly AT the horizon → ALIVE (strictly-before is the rule)', () => {
    expect(classifyRunOwner(legacy('2026-09-24T10:00:00.000Z'), env()).alive).toBe(true);
  });

  it('legacy row with NO computable horizon → ALIVE legacy_unprovable', () => {
    expect(classifyRunOwner(legacy('2026-01-01T00:00:00.000Z'), env({ legacyHorizonMs: null })))
      .toEqual({ alive: true, reason: 'legacy_unprovable' });
  });

  it('legacy row with an unparseable started_at → ALIVE legacy_unprovable', () => {
    expect(classifyRunOwner(legacy('not a date'), env()))
      .toEqual({ alive: true, reason: 'legacy_unprovable' });
  });
});

describe('parseEtime — `ps -o etime=` is `[[dd-]hh:]mm:ss`, locale-independent (literal fixtures)', () => {
  it.each([
    ['05:07', 5 * 60_000 + 7_000],
    ['   05:07', 5 * 60_000 + 7_000],
    ['01:02:03', 3_600_000 + 2 * 60_000 + 3_000],
    ['3-01:02:03', 3 * 86_400_000 + 3_600_000 + 2 * 60_000 + 3_000],
  ])('%j → %d ms', (text, ms) => {
    expect(parseEtime(text)).toBe(ms);
  });

  it.each([[''], ['abc'], ['1:2:3:4'], ['-01:02']])('malformed %j → null', (text) => {
    expect(parseEtime(text)).toBeNull();
  });
});

describe('normalizeStartedAt — both stored forms are UTC', () => {
  it('the ISO-Z and SQLite `YYYY-MM-DD HH:MM:SS` forms of one instant compare equal', () => {
    expect(normalizeStartedAt('2026-09-11T23:53:22.000Z')).toBe(normalizeStartedAt('2026-09-11 23:53:22'));
  });

  it('the space form is read as UTC, never local', () => {
    expect(normalizeStartedAt('2026-09-11 23:53:22')).toBe(Date.UTC(2026, 8, 11, 23, 53, 22));
  });

  it('garbage → null', () => {
    expect(normalizeStartedAt('yesterday')).toBeNull();
    expect(normalizeStartedAt(null)).toBeNull();
  });
});

describe('computeLegacyHorizon — the earliest start among brain processes that could own a row', () => {
  let sandbox: string;
  const saved = { IGRIS_BRAIN_DIR: process.env.IGRIS_BRAIN_DIR, IGRIS_PIDS_DIR: process.env.IGRIS_PIDS_DIR };
  const kids: ChildProcess[] = [];
  let dbFile: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'td361-horizon-'));
    process.env.IGRIS_BRAIN_DIR = sandbox;
    process.env.IGRIS_PIDS_DIR = join(sandbox, 'pids');
    mkdirSync(process.env.IGRIS_PIDS_DIR);
    expect(pidsDir()).toBe(join(sandbox, 'pids')); // ARMED: never the real registry
    dbFile = join(sandbox, 'knowledge.db');
    writeFileSync(dbFile, '');
  });

  afterEach(() => {
    while (kids.length) kids.pop()!.kill('SIGKILL');
    rmSync(sandbox, { recursive: true, force: true });
    for (const k of ['IGRIS_BRAIN_DIR', 'IGRIS_PIDS_DIR'] as const) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function selfStartMs(): number {
    return Date.now() - process.uptime() * 1000;
  }

  function register(pid: number, dbPath: string): void {
    writeFileSync(
      join(sandbox, 'pids', `${pid}.json`),
      JSON.stringify({ pid, ppid: 1, started_at: new Date().toISOString(), db_path: dbPath }),
    );
  }

  it('an empty registry → this process’s own start', () => {
    const h = computeLegacyHorizon(dbFile)!;
    expect(Math.abs(h - selfStartMs())).toBeLessThan(250);
  });

  it('a LIVE sibling registered on the same DB and older than this process → the sibling’s start', () => {
    // The parent (the vitest runner) is alive and started before this worker.
    register(process.ppid, dbFile);
    const h = computeLegacyHorizon(dbFile)!;
    expect(h).toBeLessThan(selfStartMs());
  });

  it('a record for a DEAD pid is ignored', async () => {
    const k = spawn(process.execPath, ['-e', '0']);
    kids.push(k);
    await new Promise((r) => k.once('exit', r));
    register(k.pid!, dbFile);
    const h = computeLegacyHorizon(dbFile)!;
    expect(Math.abs(h - selfStartMs())).toBeLessThan(250);
  });

  it('a live record bound to a DIFFERENT db file is ignored', () => {
    const other = join(sandbox, 'other.db');
    writeFileSync(other, '');
    register(process.ppid, other);
    const h = computeLegacyHorizon(dbFile)!;
    expect(Math.abs(h - selfStartMs())).toBeLessThan(250);
  });
});
