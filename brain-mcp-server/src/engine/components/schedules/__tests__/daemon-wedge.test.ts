/**
 * TD-361 — a run that cannot terminate no longer wedges its schedule.
 *
 * The wedge: `claimSchedule`'s overlap guard refused to fire while ANY run of
 * the schedule was `'running'`, with no age bound and no owner predicate, so a
 * row whose owner process died mid-run blocked its schedule forever (94 days
 * measured at TD-327; 12.4 and 11.8 days on 2026-09-24, both LOCALLY BORN).
 *
 * The fix reaps by OWNER LIVENESS, never by age: every run row records the
 * process that owns it, and a sweep marks a `running` row `failed` only when
 * that owner provably cannot finish it. A live owner is never reaped however
 * old its run is (W3, W4, W8). A live-owned block SKIPS the slot, advancing
 * `next_run_at`, which is what removes the F2 hot loop (W10).
 *
 * RED-FIRST CONSTRAINT: this file imports only modules that exist at HEAD
 * (`startDaemon`, `scheduleMigrations`, `stdio-lifecycle`), so its HEAD reds are
 * BEHAVIOURAL, not module-not-found. Start times are read here with `ps`
 * directly — an independent reading of the format the brain stamps.
 *
 * Every DB is a file under `mkdtemp` (a child process must open the same file);
 * `IGRIS_BRAIN_DIR` and `IGRIS_PIDS_DIR` are sandboxed, asserted ARMED, and
 * restored BY KEY. Nothing here opens `~/.igris/memory/knowledge.db`.
 *
 * @module engine/components/schedules/__tests__/daemon-wedge.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startDaemon } from '../daemon.js';
import type { DaemonHandle } from '../daemon.js';
import { scheduleMigrations } from '../schema.js';
import { pidsDir } from '../../../../stdio-lifecycle.js';

// ---------------------------------------------------------------------------
// Reality fixture (harvested read-only from the 2026-09-24 snapshot)
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAIN_ROOT = join(HERE, '..', '..', '..', '..', '..');
const FIXTURE = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'td361-wedge-rows.json'), 'utf-8'),
) as {
  provenance: { reaped_at: string; brief_age_days: Record<string, number> };
  schedules: Record<string, unknown>[];
  schedule_runs: Record<string, unknown>[];
};

const SYNAPSE = 'sch-90302d0b';
const SUBCONSCIOUS = 'sch-ca730782';
const STUCK_SYNAPSE = 'run-d581ce72';
const STUCK_SUBCONSCIOUS = 'run-f5f17e9c';

const SANDBOX_MACHINE_ID = 'td361-sandbox-machine';
const FOREIGN_MACHINE_ID = 'td361-foreign-machine';
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

let sandbox: string;
let dbPath: string;
let db: Database.Database;
const daemons: DaemonHandle[] = [];
const children: ChildProcess[] = [];
const gates: Array<() => void> = [];
const SAVED = {
  IGRIS_BRAIN_DIR: process.env.IGRIS_BRAIN_DIR,
  IGRIS_PIDS_DIR: process.env.IGRIS_PIDS_DIR,
};

function restoreKey(key: keyof typeof SAVED): void {
  const v = SAVED[key];
  if (v === undefined) delete process.env[key];
  else process.env[key] = v;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'td361-wedge-'));
  process.env.IGRIS_BRAIN_DIR = sandbox;
  process.env.IGRIS_PIDS_DIR = join(sandbox, 'pids');
  mkdirSync(process.env.IGRIS_PIDS_DIR, { recursive: true });
  // The sandbox identity: a minted id, and this host as its only alias.
  writeFileSync(
    join(sandbox, 'config.json'),
    JSON.stringify({ machine: { id: SANDBOX_MACHINE_ID, aliases: [hostname()] } }),
  );
  // ARMED, not assumed: the legacy horizon reads the pidfile registry, and an
  // unfenced registry read would be the operator's real one.
  expect(pidsDir()).toBe(join(sandbox, 'pids'));
  expect(process.env.IGRIS_BRAIN_DIR).toBe(sandbox);

  dbPath = join(sandbox, 'knowledge.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  for (const m of scheduleMigrations) db.exec(m.sql);
});

afterEach(() => {
  while (gates.length) gates.pop()!();
  while (daemons.length) daemons.pop()!.stop();
  while (children.length) {
    const c = children.pop()!;
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  }
  vi.restoreAllMocks();
  db.close();
  rmSync(sandbox, { recursive: true, force: true });
  restoreKey('IGRIS_BRAIN_DIR');
  restoreKey('IGRIS_PIDS_DIR');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Dispatch = (name: string, args: Record<string, unknown>) => Promise<unknown>;

function okDispatch(): Dispatch {
  return vi.fn(async () => ({ ok: true }));
}

/** A dispatch that parks until the returned `release` is called. */
function gatedDispatch(): { dispatch: Dispatch; release: () => void; entered: Promise<void> } {
  let release!: () => void;
  let signalEntered!: () => void;
  const entered = new Promise<void>((r) => { signalEntered = r; });
  const gate = new Promise<void>((r) => { release = r; });
  gates.push(release);
  return {
    dispatch: async () => {
      signalEntered();
      await gate;
      return { ok: true };
    },
    release,
    entered,
  };
}

function daemon(opts: {
  dispatch?: Dispatch;
  emit?: (event: string, data: Record<string, unknown>) => void;
  liveness?: Record<string, unknown>;
} = {}): DaemonHandle {
  const dispatch = opts.dispatch ?? okDispatch();
  const ctx = {
    getDispatch: () => dispatch,
    bus: { emit: opts.emit ?? (() => {}) },
    getDb: () => db,
    ...(opts.liveness ? { liveness: opts.liveness } : {}),
  };
  const d = startDaemon(ctx as Parameters<typeof startDaemon>[0]);
  daemons.push(d);
  return d;
}

/** Insert a fixture row VERBATIM — every harvested column, nothing added. */
function seedFixtureSchedule(id: string): void {
  const row = FIXTURE.schedules.find((r) => r.id === id)!;
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO schedules (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).run(...cols.map((c) => row[c]));
}

function seedFixtureRun(id: string): void {
  const row = FIXTURE.schedule_runs.find((r) => r.id === id)!;
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO schedule_runs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).run(...cols.map((c) => row[c]));
}

/** A due noop-free mcp-tool schedule (the engines' shape) with `next_run_at` in the past. */
function seedDueSchedule(id: string): void {
  db.prepare(`
    INSERT INTO schedules (id, name, cron_expr, handler_type, handler_config, enabled, next_run_at)
    VALUES (?, ?, '0 * * * *', 'mcp-tool', '{"tool":"stub_tool","args":{}}', 1, ?)
  `).run(id, `td361 ${id}`, new Date(Date.now() - 60_000).toISOString());
}

/** An owner-stamped `running` row (the post-fix shape). */
function seedStampedRun(o: {
  id: string;
  scheduleId: string;
  pid: number;
  startedAtOfOwner: string | null;
  machineId?: string | null;
  startedAt?: string;
}): void {
  db.prepare(`
    INSERT INTO schedule_runs
      (id, schedule_id, status, started_at, attempt,
       machine_id, machine_hostname, owner_pid, owner_started_at)
    VALUES (?, ?, 'running', ?, 1, ?, ?, ?, ?)
  `).run(
    o.id,
    o.scheduleId,
    o.startedAt ?? new Date(Date.now() - TWO_HOURS_MS).toISOString(),
    o.machineId === undefined ? SANDBOX_MACHINE_ID : o.machineId,
    hostname(),
    o.pid,
    o.startedAtOfOwner,
  );
}

function run(id: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(id) as Record<string, unknown>;
}

function runsOf(scheduleId: string): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at')
    .all(scheduleId) as Record<string, unknown>[];
}

function nextRunAtMs(scheduleId: string): number {
  const r = db.prepare('SELECT next_run_at FROM schedules WHERE id = ?').get(scheduleId) as {
    next_run_at: string | null;
  };
  return r.next_run_at === null ? NaN : Date.parse(r.next_run_at);
}

function rewind(scheduleId: string): void {
  db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1_000).toISOString(), scheduleId);
}

/** `ps -p <pid> -o lstart=` — the same instrument the brain stamps with. */
function lstart(pid: number): string {
  return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf-8' }).trim();
}

/**
 * A live sibling process holding the SAME DB file open. On `done` on stdin it
 * writes the run's terminal status itself and exits — the "long job finishes
 * on its own" half of AC-3.
 */
async function spawnOwner(runId?: string): Promise<ChildProcess> {
  const src = `
    const D = require('better-sqlite3');
    const db = new D(${JSON.stringify(dbPath)});
    db.pragma('busy_timeout = 5000');
    process.stdout.write('ready\\n');
    let buf = '';
    process.stdin.on('data', (c) => {
      buf += c;
      if (!buf.includes('done')) return;
      ${runId === undefined ? '' : `db.prepare("UPDATE schedule_runs SET status='success', finished_at=? WHERE id=?").run(new Date().toISOString(), ${JSON.stringify(runId)});`}
      db.close();
      process.stdout.write('finished\\n');
      process.exit(0);
    });
  `;
  const child = spawn(process.execPath, ['-e', src], {
    cwd: BRAIN_ROOT,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  children.push(child);
  await waitForLine(child, 'ready');
  return child;
}

function waitForLine(child: ChildProcess, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = '';
    const onData = (c: Buffer): void => {
      out += c.toString();
      if (out.includes(line)) {
        child.stdout!.off('data', onData);
        resolve();
      }
    };
    child.stdout!.on('data', onData);
    child.once('exit', (code) => {
      if (!out.includes(line)) reject(new Error(`child exited ${code} before '${line}'`));
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((r) => child.once('exit', () => r()));
}

// ---------------------------------------------------------------------------
// T0 — the fixture is what the brief says it is
// ---------------------------------------------------------------------------

describe('TD-361 fixture provenance (T0)', () => {
  it("carries the two stuck runs at the brief's own ages (12.4 d / 11.8 d at the reap)", () => {
    const reap = Date.parse(FIXTURE.provenance.reaped_at);
    for (const r of FIXTURE.schedule_runs) {
      expect(r.status).toBe('running');
      expect(r.finished_at).toBeNull();
      const days = Math.round(((reap - Date.parse(r.started_at as string)) / 86_400_000) * 10) / 10;
      expect(days).toBe(FIXTURE.provenance.brief_age_days[r.id as string]);
    }
    expect(FIXTURE.schedule_runs.map((r) => r.id)).toEqual([STUCK_SYNAPSE, STUCK_SUBCONSCIOUS]);
  });
});

// ---------------------------------------------------------------------------
// The wedge and its release
// ---------------------------------------------------------------------------

describe('TD-361 — a run that cannot terminate no longer wedges its schedule', () => {
  it('W1 (AC-1): the reality fixture — a 12.4-day legacy synapse run is released and the schedule fires', async () => {
    seedFixtureSchedule(SYNAPSE);
    seedFixtureRun(STUCK_SYNAPSE);
    const d = daemon();
    await d.tickOnce();

    const stuck = run(STUCK_SYNAPSE);
    expect(stuck.status).toBe('failed');
    expect(stuck.error).toMatch(/^abandoned:.*legacy_predates_live_processes/);
    const runs = runsOf(SYNAPSE);
    expect(runs).toHaveLength(2);
    const fresh = runs.find((r) => r.id !== STUCK_SYNAPSE)!;
    expect(fresh.status).toBe('success');
    expect(nextRunAtMs(SYNAPSE)).toBeGreaterThan(Date.now());
  });

  it('W2: both 2026-09-24 wedges (synapse + subconscious) are released by ONE tick', async () => {
    seedFixtureSchedule(SYNAPSE);
    seedFixtureSchedule(SUBCONSCIOUS);
    seedFixtureRun(STUCK_SYNAPSE);
    seedFixtureRun(STUCK_SUBCONSCIOUS);
    const d = daemon();
    await d.tickOnce();

    for (const [sch, stuckId] of [[SYNAPSE, STUCK_SYNAPSE], [SUBCONSCIOUS, STUCK_SUBCONSCIOUS]]) {
      expect(run(stuckId).status).toBe('failed');
      const fresh = runsOf(sch).filter((r) => r.id !== stuckId);
      expect(fresh).toHaveLength(1);
      expect(fresh[0].status).toBe('success');
    }
  });

  it('W3 (AC-3): a 2-hour run owned by a LIVE sibling process is NOT reaped, completes on its own, then cadence resumes', async () => {
    seedDueSchedule('sch-w3');
    const owner = await spawnOwner('run-w3-long');
    // 2 h is longer than llm_timeout_ms (300 s) + any headroom AND longer than
    // the 74.7-min janitor run measured healthy on 2026-09-12 (plan F4).
    seedStampedRun({ id: 'run-w3-long', scheduleId: 'sch-w3', pid: owner.pid!, startedAtOfOwner: lstart(owner.pid!) });

    const d = daemon();
    await d.tickOnce();
    expect(run('run-w3-long').status).toBe('running');
    expect(runsOf('sch-w3')).toHaveLength(1);
    expect(nextRunAtMs('sch-w3')).toBeGreaterThan(Date.now()); // the slot was SKIPPED

    owner.stdin!.write('done\n');
    await waitForExit(owner);
    expect(run('run-w3-long').status).toBe('success');

    rewind('sch-w3');
    await d.tickOnce();
    const runs = runsOf('sch-w3');
    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.id !== 'run-w3-long')!.status).toBe('success');
  });

  it('W4: a run in flight in THIS process, aged 2 h, is not reaped by a second daemon and completes', async () => {
    seedDueSchedule('sch-w4');
    const g = gatedDispatch();
    const a = daemon({ dispatch: g.dispatch });
    const inFlight = a.tickOnce();
    await g.entered;
    const [live] = runsOf('sch-w4');
    expect(live.status).toBe('running');
    db.prepare('UPDATE schedule_runs SET started_at = ? WHERE id = ?')
      .run(new Date(Date.now() - TWO_HOURS_MS).toISOString(), live.id);
    rewind('sch-w4');

    const b = daemon();
    await b.tickOnce();
    expect(run(live.id as string).status).toBe('running');
    expect(runsOf('sch-w4')).toHaveLength(1);

    g.release();
    await inFlight;
    expect(run(live.id as string).status).toBe('success');
  });

  it('W5 (crash): an owner killed with SIGKILL is reaped as owner_dead and the schedule re-fires', async () => {
    seedDueSchedule('sch-w5');
    const owner = await spawnOwner();
    seedStampedRun({ id: 'run-w5', scheduleId: 'sch-w5', pid: owner.pid!, startedAtOfOwner: lstart(owner.pid!) });
    owner.kill('SIGKILL');
    await waitForExit(owner);

    const d = daemon();
    await d.tickOnce();
    expect(run('run-w5').status).toBe('failed');
    expect(run('run-w5').error).toMatch(/owner_dead/);
    expect(runsOf('sch-w5').filter((r) => r.id !== 'run-w5')).toHaveLength(1);
  });

  it('W6 (pid reuse): a live pid whose start time differs from the stamp is reaped as owner_pid_reused', async () => {
    seedDueSchedule('sch-w6');
    const other = await spawnOwner();
    seedStampedRun({ id: 'run-w6', scheduleId: 'sch-w6', pid: other.pid!, startedAtOfOwner: 'Thu Jan  1 00:00:00 1970' });

    const d = daemon();
    await d.tickOnce();
    expect(run('run-w6').status).toBe('failed');
    expect(run('run-w6').error).toMatch(/owner_pid_reused/);
  });

  it('W7 (foreign machine): an owner-stamped row from another machine id is reaped as owner_foreign_machine', async () => {
    seedDueSchedule('sch-w7');
    // Even a pid that IS alive here: a run in THIS file can only be finished by
    // a process writing THIS file, and a foreign machine's process cannot.
    seedStampedRun({
      id: 'run-w7', scheduleId: 'sch-w7', pid: process.pid,
      startedAtOfOwner: lstart(process.pid), machineId: FOREIGN_MACHINE_ID,
    });

    const d = daemon();
    await d.tickOnce();
    expect(run('run-w7').status).toBe('failed');
    expect(run('run-w7').error).toMatch(/owner_foreign_machine/);
  });

  it('W8a (conservative): a legacy row YOUNGER than every live brain process blocks, and the slot is skipped', async () => {
    seedDueSchedule('sch-w8a');
    db.prepare(`INSERT INTO schedule_runs (id, schedule_id, status, started_at, attempt)
                VALUES ('run-w8a', 'sch-w8a', 'running', ?, 1)`).run(new Date().toISOString());
    const d = daemon();
    await d.tickOnce();
    expect(run('run-w8a').status).toBe('running');
    expect(runsOf('sch-w8a')).toHaveLength(1);
    expect(nextRunAtMs('sch-w8a')).toBeGreaterThan(Date.now());
  });

  it('W8b (conservative): a live owner whose start time cannot be read (ps unavailable) blocks', async () => {
    seedDueSchedule('sch-w8b');
    const owner = await spawnOwner();
    seedStampedRun({ id: 'run-w8b', scheduleId: 'sch-w8b', pid: owner.pid!, startedAtOfOwner: lstart(owner.pid!) });
    const d = daemon({ liveness: { startTimeOf: () => null } });
    await d.tickOnce();
    expect(run('run-w8b').status).toBe('running');
    expect(runsOf('sch-w8b')).toHaveLength(1);
  });

  it('W8c (conservative): with no computable legacy horizon, a 12-day legacy row blocks', async () => {
    seedFixtureSchedule(SYNAPSE);
    seedFixtureRun(STUCK_SYNAPSE);
    const d = daemon({ liveness: { legacyHorizonMs: null } });
    await d.tickOnce();
    expect(run(STUCK_SYNAPSE).status).toBe('running');
    expect(runsOf(SYNAPSE)).toHaveLength(1);
  });

  it('W9: a graceful stop() marks the in-flight run interrupted; the owner’s later truth still wins', async () => {
    seedDueSchedule('sch-w9');
    const g = gatedDispatch();
    const d = daemon({ dispatch: g.dispatch });
    const inFlight = d.tickOnce();
    await g.entered;
    const [live] = runsOf('sch-w9');

    d.stop();
    const interrupted = run(live.id as string);
    expect(interrupted.status).toBe('failed');
    expect(interrupted.error).toMatch(/^interrupted:/);
    expect(interrupted.finished_at).not.toBeNull();

    g.release();
    await inFlight;
    // The terminal UPDATE is unconditional by id: the owner's truthful
    // completion overwrites a wrong interruption (or a wrong reap).
    expect(run(live.id as string).status).toBe('success');
  });

  it('W10 (F2 hot loop): a live-owned block advances next_run_at, and no zero-delay timer is re-armed', async () => {
    seedDueSchedule('sch-w10');
    const g = gatedDispatch();
    const a = daemon({ dispatch: g.dispatch });
    const inFlight = a.tickOnce();
    await g.entered;
    rewind('sch-w10');

    // Construct B first (its constructor legitimately arms a 0-delay timer: the
    // schedule IS due), then spy, then tick.
    const b = daemon();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    await b.tickOnce();
    expect(nextRunAtMs('sch-w10')).toBeGreaterThan(Date.now());
    const zeroDelayRearms = spy.mock.calls.filter(([, ms]) => (ms ?? 0) === 0);
    expect(zeroDelayRearms).toHaveLength(0);

    g.release();
    await inFlight;
  });

  it('W10b (F2 hot loop, measured): over 250 ms of real timers a blocked schedule re-ticks at most once', async () => {
    seedDueSchedule('sch-w10b');
    const g = gatedDispatch();
    const a = daemon({ dispatch: g.dispatch });
    const inFlight = a.tickOnce();
    await g.entered;
    rewind('sch-w10b');

    const spy = vi.spyOn(globalThis, 'setTimeout');
    const b = daemon();
    await new Promise((r) => setTimeout(r, 250));
    b.stop();
    const tickArms = spy.mock.calls.filter(
      ([fn, ms]) => (ms ?? 0) === 0 && String(fn).includes('tick()'),
    ).length;
    // HEAD: every blocked claim re-armed setTimeout(tick, 0) — a busy loop of
    // BEGIN IMMEDIATE claims for as long as the wedge lasted. Fixed: the ONE
    // arm is B's constructor (the schedule was due); the blocked claim skips
    // the slot and the next arm waits for it.
    console.error(`[TD-361 W10b] zero-delay tick arms in 250 ms: ${tickArms}`);
    expect(tickArms).toBeLessThanOrEqual(1);

    g.release();
    await inFlight;
  });

  it('W11: the sweep runs at daemon START — a stuck legacy row is failed before any tick', () => {
    seedFixtureSchedule(SUBCONSCIOUS);
    seedFixtureRun(STUCK_SUBCONSCIOUS);
    daemon();
    expect(run(STUCK_SUBCONSCIOUS).status).toBe('failed');
  });

  it('W12: a reap emits the EXISTING schedule.run_complete event with reaped:true and the reason', async () => {
    seedFixtureSchedule(SYNAPSE);
    seedFixtureRun(STUCK_SYNAPSE);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    daemon({ emit: (event, data) => events.push({ event, data }) });
    const reap = events.find((e) => e.data.run_id === STUCK_SYNAPSE);
    expect(reap).toBeDefined();
    expect(reap!.event).toBe('schedule.run_complete');
    expect(reap!.data).toMatchObject({
      schedule_id: SYNAPSE,
      status: 'failed',
      reaped: true,
      reason: 'legacy_predates_live_processes',
    });
  });
});
