/**
 * TD-471 — host-auth expiry-boundary watcher (OPERATOR-RUN INSTRUMENT; never CI;
 * the `td471_` prefix keeps it out of the npm package — BR-101).
 *
 * QUESTION. Does a headless `claude -p` extractor child fail with
 * `Failed to authenticate: OAuth session expired and could not be refreshed`
 * because it INHERITS the desktop harness's host-auth channel
 * (`CLAUDE_CODE_ENTRYPOINT=claude-desktop` + `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH`)?
 * The only proof that counts is a real access-token expiry, so this script ticks
 * until one arrives and records every arm at that moment.
 *
 * IT IMPORTS THE SHIPPED BACKEND (test_standards 9a): the fixed arm is the real
 * `buildExtractorSpawn('claude', …)` run through the real `execHarness`, and every
 * isolated arm shares that spawn's argv and isolated HOME, so env is the ONE
 * variable. It imports nothing from `db.ts` or the engine — it cannot open the brain.
 *
 * ARMS (one subscription call each; 120 s bound each):
 *   host_iso        ALWAYS FIRST. Isolated HOME + the pre-TD-471 env shape
 *                   (`headSubscriptionOnlyEnv` below — the control-arm replica).
 *   host_real       capture tick only. Real HOME, same env, cwd = an empty temp dir
 *                   (outside every registered project, so Igris hooks no-op), plus
 *                   `--settings {"disableAllHooks":true}` when `claude --help` lists it.
 *   fixed_iso       the production path, byte for byte. Also a heartbeat on tick 1
 *                   and every 6th tick after, after host_iso.
 *   host_iso_after  capture tick only; host_iso again after fixed_iso.
 *   fixed_real      capture tick only, and only if fixed_iso failed: real HOME +
 *                   fixed env, to separate isolation from env.
 * A capture tick is a tick whose host_iso is classified `auth_error`. The host arm
 * runs first so IT meets the expired token; a fixed arm first would refresh the
 * token and lose the boundary for a whole token lifetime.
 *
 * PRE-REGISTERED VERDICT (the final JSONL line of a capture):
 *   H1_CONFIRMED          host_iso auth, host_real auth, fixed_iso ok, host_iso_after ok
 *   ISOLATION_IMPLICATED  host_iso auth, fixed_iso auth, fixed_real ok
 *   REFRESH_DEAD          every arm auth, fixed_real included
 *   OTHER                 anything else — the raw rows stand
 * No capture before the stop → a final `NO_CAPTURE` line.
 *
 * VALUES NEVER REACH OUTPUT (plan D6). Records carry envelope fields, the stderr
 * BYTE COUNT (never its text) and env NAMES only. Refusals name no value.
 *
 * USAGE (from a desktop-harness shell, so the parent env carries the gate pair):
 *   cd brain-mcp-server && nohup npx tsx scripts/td471_host_auth_watch.ts \
 *       --out <evidence>/watch-<UTC>.jsonl > <evidence>/watch.log 2>&1 &
 *   flags: --out <path>   (default ~/.igris/projects/igris-ai/plans/td471-evidence/watch-<UTC>.jsonl)
 *          --interval-min <n> (10)  --max-hours <n> (30)  --stop-after <captures> (1)
 * Exit 2 with one line when: CI is set; the parent env lacks the gate pair (as-is
 * ≡ fixed, so a run would be non-discriminating); `claude` is not resolvable.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  buildExtractorSpawn,
  execHarness,
  subscriptionOnlyEnv,
  type ExtractorSpawn,
} from '../src/engine/components/cognition/backend/index.js';
import { detectClaudeErrorEnvelope } from '../src/engine/components/cognition/backend/parse-output.js';

// ---------------------------------------------------------------------------
// The pre-TD-471 control shape
// ---------------------------------------------------------------------------

/**
 * HEAD's `subscriptionOnlyEnv` before TD-471, inlined VERBATIM as the control arm:
 * the parent env minus the two metered keys, plus `extra`. Do not "fix" it — it
 * is the shape whose failure the watcher is measuring (MAINTAINING.md, TD-471 row).
 */
function headSubscriptionOnlyEnv(
  base: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  return env;
}

// ---------------------------------------------------------------------------
// Args + refusals
// ---------------------------------------------------------------------------

/** The CLI's host-refresh entrypoints (2.1.281: `new Set(["claude-desktop","claude-desktop-3p","local-agent"])`). */
const HOST_ENTRYPOINTS = new Set(['claude-desktop', 'claude-desktop-3p', 'local-agent']);

const ARM_TIMEOUT_MS = 120_000;
const HEARTBEAT_EVERY = 6;
const PROMPT = { system: 'Reply with exactly: OK', user: 'ping' };

interface Args {
  out: string;
  intervalMin: number;
  maxHours: number;
  stopAfter: number;
}

/** Print one refusal line and exit 2 (no env value is ever named). */
function refuse(line: string): never {
  process.stderr.write(`td471_host_auth_watch: REFUSED — ${line}\n`);
  process.exit(2);
}

function utcStamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    out: resolve(homedir(), '.igris/projects/igris-ai/plans/td471-evidence', `watch-${utcStamp()}.jsonl`),
    intervalMin: 10,
    maxHours: 30,
    stopAfter: 1,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) refuse(`flag ${flag} needs a value`);
    const num = Number(value);
    switch (flag) {
      case '--out':
        args.out = resolve(value);
        break;
      case '--interval-min':
        if (!(num > 0)) refuse('--interval-min must be > 0');
        args.intervalMin = num;
        break;
      case '--max-hours':
        if (!(num > 0)) refuse('--max-hours must be > 0');
        args.maxHours = num;
        break;
      case '--stop-after':
        if (!(Number.isInteger(num) && num > 0)) refuse('--stop-after must be a positive integer');
        args.stopAfter = num;
        break;
      default:
        refuse(`unknown flag ${flag}`);
    }
    i += 1;
  }
  return args;
}

// ---------------------------------------------------------------------------
// One arm
// ---------------------------------------------------------------------------

type Outcome = 'ok' | 'auth_error' | 'other';

interface ArmRecord {
  kind: 'arm';
  ts: string;
  tick: number;
  arm: string;
  exit: number | null;
  secs: number;
  timed_out: boolean;
  type: unknown;
  subtype: unknown;
  is_error: unknown;
  api_error_status: unknown;
  terminal_reason: unknown;
  result_head: string | null;
  classified: 'api_error' | 'auth_error' | null;
  stderr_bytes: number;
  outcome: Outcome;
}

/** The last `{type:"result"}` line of claude's stdout, or null. */
function lastResultEnvelope(stdout: string): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const ev = JSON.parse(t) as Record<string, unknown>;
      if (ev.type === 'result') found = ev;
    } catch {
      /* not JSON — ignored */
    }
  }
  return found;
}

/** Run one arm and write its record. The spawn's isolated HOME is reaped in `finally`. */
async function runArm(
  out: string,
  tick: number,
  arm: string,
  spawn: ExtractorSpawn,
): Promise<ArmRecord> {
  const started = Date.now();
  try {
    const res = await execHarness(spawn.bin, spawn.args, {
      cwd: spawn.cwd,
      env: spawn.env,
      timeout_ms: ARM_TIMEOUT_MS,
      stdin: spawn.prompt,
    });
    const ev = lastResultEnvelope(res.stdout);
    const envelope = detectClaudeErrorEnvelope(res.stdout);
    const result = ev && typeof ev.result === 'string' ? ev.result.slice(0, 160) : null;
    const ok = !res.timed_out && res.code === 0 && ev !== null && ev.is_error === false;
    const rec: ArmRecord = {
      kind: 'arm',
      ts: new Date().toISOString(),
      tick,
      arm,
      exit: res.code,
      secs: Math.round((Date.now() - started) / 100) / 10,
      timed_out: res.timed_out,
      type: ev?.type ?? null,
      subtype: ev?.subtype ?? null,
      is_error: ev?.is_error ?? null,
      api_error_status: ev?.api_error_status ?? null,
      terminal_reason: ev?.terminal_reason ?? null,
      result_head: result,
      classified: envelope?.kind ?? null,
      stderr_bytes: Buffer.byteLength(res.stderr),
      outcome: envelope?.kind === 'auth_error' ? 'auth_error' : ok ? 'ok' : 'other',
    };
    write(out, rec);
    return rec;
  } finally {
    spawn.cleanup();
  }
}

function write(out: string, rec: object): void {
  appendFileSync(out, `${JSON.stringify(rec)}\n`);
}

// ---------------------------------------------------------------------------
// Spawn shapes — every isolated arm reuses the production argv + isolated HOME
// ---------------------------------------------------------------------------

function isoSpawn(scratch: string, envShape: 'host' | 'fixed'): ExtractorSpawn {
  const spawn = buildExtractorSpawn('claude', PROMPT, { env: { IGRIS_LLM_EXTRACTOR_SCRATCH_ROOT: scratch } });
  // 'fixed' is the production spawn untouched; 'host' swaps ONLY the env.
  if (envShape === 'host') spawn.env = headSubscriptionOnlyEnv(process.env, { HOME: spawn.cwd });
  return spawn;
}

function realHomeSpawn(scratch: string, envShape: 'host' | 'fixed', settingsFlag: boolean): ExtractorSpawn {
  const template = isoSpawn(scratch, 'fixed');
  template.cleanup(); // only the argv/bin/prompt are reused; the real-HOME arm has no isolated HOME
  const cwd = mkdtempSync(join(scratch, 'real-cwd-'));
  const env = envShape === 'host' ? headSubscriptionOnlyEnv(process.env) : subscriptionOnlyEnv(process.env);
  const args = settingsFlag ? [...template.args, '--settings', '{"disableAllHooks":true}'] : template.args;
  return {
    ...template,
    args,
    env,
    cwd,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

function verdict(o: Record<string, Outcome | undefined>): string {
  const all = Object.values(o).filter((v): v is Outcome => v !== undefined);
  if (o.host_iso === 'auth_error' && o.host_real === 'auth_error' && o.fixed_iso === 'ok' && o.host_iso_after === 'ok') {
    return 'H1_CONFIRMED';
  }
  if (o.host_iso === 'auth_error' && o.fixed_iso === 'auth_error' && o.fixed_real === 'ok') {
    return 'ISOLATION_IMPLICATED';
  }
  if (o.fixed_real !== undefined && all.every((v) => v === 'auth_error')) return 'REFRESH_DEAD';
  return 'OTHER';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (process.env.CI) refuse('CI is set — this instrument makes real subscription calls and never runs in CI');
  const env = process.env;
  if (!env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH || !HOST_ENTRYPOINTS.has(env.CLAUDE_CODE_ENTRYPOINT ?? '')) {
    refuse(
      'the parent env lacks the gate pair (CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH non-empty + a host CLAUDE_CODE_ENTRYPOINT); ' +
        'as-is would equal fixed — launch from a desktop-harness shell',
    );
  }
  const which = spawnSync('/bin/sh', ['-c', 'command -v claude'], { env, encoding: 'utf-8', timeout: 5_000 });
  const claudePath = which.status === 0 ? which.stdout.trim() : '';
  if (!claudePath) refuse('`claude` is not resolvable on PATH');

  const probe = (flag: string): string =>
    spawnSync(claudePath, [flag], { env, encoding: 'utf-8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] })
      .stdout ?? '';
  const version = (): string => probe('--version').split('\n')[0].trim().slice(0, 80);
  const settingsFlag = probe('--help').includes('--settings');

  mkdirSync(dirname(args.out), { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), `td471-watch-${process.pid}-`));
  const reap = (): void => rmSync(scratch, { recursive: true, force: true });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      write(args.out, { kind: 'stop', ts: new Date().toISOString(), reason: sig });
      reap();
      process.exit(130);
    });
  }

  const startedAt = Date.now();
  const deadline = startedAt + args.maxHours * 3_600_000;
  const fixedNames = new Set(Object.keys(subscriptionOnlyEnv(env, { HOME: scratch })));
  write(args.out, {
    kind: 'header',
    started_at: new Date(startedAt).toISOString(),
    pid: process.pid,
    claude_path: claudePath,
    claude_version: version(),
    interval_min: args.intervalMin,
    max_hours: args.maxHours,
    stop_after: args.stopAfter,
    real_home_settings_branch: settingsFlag ? 'disableAllHooks' : 'none (--settings not in --help)',
    removed_by_fix: Object.keys(env).filter((k) => !fixedNames.has(k)).sort(),
  });

  let captures = 0;
  try {
    for (let tick = 1; ; tick += 1) {
      const host = await runArm(args.out, tick, 'host_iso', isoSpawn(scratch, 'host'));
      if (host.outcome === 'auth_error') {
        const o: Record<string, Outcome | undefined> = { host_iso: host.outcome };
        write(args.out, { kind: 'capture', ts: new Date().toISOString(), tick, claude_version: version() });
        o.host_real = (await runArm(args.out, tick, 'host_real', realHomeSpawn(scratch, 'host', settingsFlag))).outcome;
        o.fixed_iso = (await runArm(args.out, tick, 'fixed_iso', isoSpawn(scratch, 'fixed'))).outcome;
        o.host_iso_after = (await runArm(args.out, tick, 'host_iso_after', isoSpawn(scratch, 'host'))).outcome;
        if (o.fixed_iso !== 'ok') {
          o.fixed_real = (await runArm(args.out, tick, 'fixed_real', realHomeSpawn(scratch, 'fixed', settingsFlag))).outcome;
        }
        captures += 1;
        write(args.out, { kind: 'verdict', ts: new Date().toISOString(), tick, verdict: verdict(o), outcomes: o });
        if (captures >= args.stopAfter) return;
      } else if ((tick - 1) % HEARTBEAT_EVERY === 0) {
        await runArm(args.out, tick, 'fixed_iso', isoSpawn(scratch, 'fixed'));
      }
      const nextAt = startedAt + tick * args.intervalMin * 60_000;
      if (nextAt > deadline) {
        write(args.out, { kind: 'stop', ts: new Date().toISOString(), reason: 'max_hours', captures, verdict: captures === 0 ? 'NO_CAPTURE' : 'see verdict lines' });
        return;
      }
      await new Promise((r) => setTimeout(r, Math.max(0, nextAt - Date.now())));
    }
  } finally {
    reap();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`td471_host_auth_watch: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
