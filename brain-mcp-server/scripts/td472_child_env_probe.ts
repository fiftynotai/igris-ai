/**
 * TD-472 — AC-3 live probe: does each harness still authenticate by SUBSCRIPTION
 * under the allowlist child env? (OPERATOR-RUN INSTRUMENT; never CI; the `td472_`
 * prefix keeps it out of the npm package — BR-101.)
 *
 * IT IMPORTS THE SHIPPED BACKEND (test_standards 9a). Per runnable harness it runs
 * two arms on the SAME argv and a fresh isolated HOME each, so env is the ONE
 * variable:
 *   allow  FIRST. The production `buildExtractorSpawn` + `execHarness`, untouched
 *          (plus `--add-back` names in bisect mode). First, so the arm that meets a
 *          due token refresh is the arm UNDER TEST (TD-471's lesson, inverted).
 *   base   The same spawn with ONLY `spawn.env` swapped for the TD-471 shape
 *          (`td471SubscriptionOnlyEnv` below — the control replica).
 * Prompt: system `Reply with exactly: OK`, user `ping`; no `--model` (production parity).
 *
 * PRE-REGISTERED VERDICT (one `verdict` line per harness, then one `overall` line):
 *   PASS               allow ok, auth-store witness unmoved
 *   PASS_WITH_REFRESH  allow ok, witness moved (a refresh ran under the allowlist)
 *   REGRESSION         allow not ok, base ok -> bisect with --add-back over dropped_names
 *   PRE_EXISTING       both not ok (the harness never worked in this shape; file a BR)
 *   BLOCKED_BRAIN_LEAK a forwarded MCP config declares igris-brain (no override; BR-108)
 *   BLOCKED_MCP        another forwarded MCP server is not in --accept-mcp
 *   NOT_LOGGED_IN      the harness's auth store is absent
 *   METERED_MODE       the stored login is metered; arms still run, `arms_verdict` holds the rest
 *
 * VALUES NEVER REACH OUTPUT (plan D6). Records carry envelope enums, booleans, byte
 * counts, stderr CLASS names from a fixed list, and env NAMES. Never stdout/stderr
 * text, never a value. Preflight parses the harness config files in-process and emits
 * key names, `type` enums and booleans only.
 *
 * USAGE (from a desktop-harness shell):
 *   cd brain-mcp-server && npx tsx scripts/td472_child_env_probe.ts --harness <h[,h…]> \
 *     [--out <jsonl>] [--timeout-sec 180] [--add-back N1,N2] [--accept-mcp n1,n2] \
 *     [--after-td471-watch] [--td471-evidence <dir>]
 * Exit 2 with one line when: CI is set; a flag is bad; a requested bin is not
 * resolvable; `claude` is requested while the TD-471 watcher is alive (override
 * `--after-td471-watch` only once its evidence JSONL holds a `verdict`/`stop` line);
 * an `--add-back` name is metered or in the claude namespace (a false PASS by billing).
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  buildExtractorSpawn,
  execHarness,
  extractText,
  HARNESS_BIN,
  type ExtractorSpawn,
} from '../src/engine/components/cognition/backend/index.js';
import { detectClaudeErrorEnvelope } from '../src/engine/components/cognition/backend/parse-output.js';
import type { ExtractorHarness } from '../src/engine/components/cognition/types.js';

// ---------------------------------------------------------------------------
// The TD-471 control shape — do not fix: it is what the base arm measures against
// ---------------------------------------------------------------------------

/** TD-471's `env.ts` rule at commit 8c95fe3, inlined VERBATIM (the `headSubscriptionOnlyEnv` idiom). */
const INHERITED_HARNESS_ENV_PREFIXES = ['CLAUDE', 'ANTHROPIC_'] as const;
const METERED_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const;
function td471SubscriptionOnlyEnv(
  base: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (!INHERITED_HARNESS_ENV_PREFIXES.some((p) => name.startsWith(p))) inherited[name] = value;
  }
  const env: NodeJS.ProcessEnv = { ...inherited, ...extra };
  for (const key of METERED_KEYS) delete env[key];
  return env;
}

// ---------------------------------------------------------------------------
// Args + refusals
// ---------------------------------------------------------------------------

const ALL: ExtractorHarness[] = ['claude', 'codex', 'gemini', 'antigravity', 'opencode'];
const PROMPT = { system: 'Reply with exactly: OK', user: 'ping' };
const F5_BR = 'BR-108';
const WATCHER_MARK = 'td471_host_auth_watch';

interface Args {
  harnesses: ExtractorHarness[];
  out: string;
  timeoutSec: number;
  addBack: string[];
  acceptMcp: string[];
  afterWatch: boolean;
  watchEvidence: string;
}

/** Print one refusal line and exit 2 (no env value is ever named). */
function refuse(line: string): never {
  process.stderr.write(`td472_child_env_probe: REFUSED — ${line}\n`);
  process.exit(2);
}

const utcStamp = (d = new Date()): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const list = (v: string): string[] => v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);

function parseArgs(argv: string[]): Args {
  const evidence = resolve(homedir(), '.igris/projects/igris-ai/plans');
  const args: Args = {
    harnesses: [],
    out: join(evidence, 'td472-evidence', `probe-${utcStamp()}.jsonl`),
    timeoutSec: 180,
    addBack: [],
    acceptMcp: [],
    afterWatch: false,
    watchEvidence: join(evidence, 'td471-evidence'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--after-td471-watch') {
      args.afterWatch = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) refuse(`flag ${flag} needs a value`);
    i += 1;
    if (flag === '--harness') {
      for (const h of list(value)) {
        if (!(ALL as string[]).includes(h)) refuse(`unknown harness ${h} (one of ${ALL.join(',')})`);
        args.harnesses.push(h as ExtractorHarness);
      }
    } else if (flag === '--out') args.out = resolve(value);
    else if (flag === '--timeout-sec') {
      const n = Number(value);
      if (!(n > 0)) refuse('--timeout-sec must be > 0');
      args.timeoutSec = n;
    } else if (flag === '--add-back') args.addBack = list(value);
    else if (flag === '--accept-mcp') args.acceptMcp = list(value);
    else if (flag === '--td471-evidence') args.watchEvidence = resolve(value);
    else refuse(`unknown flag ${flag}`);
  }
  if (args.harnesses.length === 0) refuse('--harness is required');
  return args;
}

function write(out: string, rec: object): void {
  appendFileSync(out, `${JSON.stringify(rec)}\n`);
}

/** Resolve a bin on the CURRENT PATH (the one every arm inherits). */
function resolveBin(bin: string): string {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { env: process.env, encoding: 'utf-8', timeout: 5_000 });
  return r.status === 0 ? r.stdout.trim() : '';
}

function watcherAlive(): boolean {
  const r = spawnSync('ps', ['-Ao', 'command'], { encoding: 'utf-8', timeout: 5_000 });
  return (r.stdout ?? '').split('\n').some((l) => l.includes(WATCHER_MARK));
}

/** True when any watcher JSONL in `dir` holds a `verdict` or `stop` line (kind only is read). */
function watcherFinished(dir: string): boolean {
  if (!existsSync(dir)) return false;
  for (const f of readdirSync(dir)) {
    if (!/^watch-.*\.jsonl$/.test(f)) continue;
    for (const line of readFileSync(join(dir, f), 'utf-8').split('\n')) {
      try {
        const kind = (JSON.parse(line) as { kind?: unknown }).kind;
        if (kind === 'verdict' || kind === 'stop') return true;
      } catch {
        /* partial / non-JSON line */
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Preflight (names, enums and booleans only)
// ---------------------------------------------------------------------------

/** The auth store per harness, relative to the real HOME (D4); its mtime is the refresh witness. */
const AUTH_STORE: Record<ExtractorHarness, string> = {
  claude: '.claude.json',
  codex: '.codex/auth.json',
  gemini: '.gemini/oauth_creds.json',
  antigravity: '.gemini/oauth_creds.json',
  opencode: '.local/share/opencode/auth.json',
};
/** The D4 refresh witness (stat only). agy: none identifiable from the Phase 0.2 read. */
const WITNESS: Record<ExtractorHarness, string | null> = {
  claude: 'Library/Keychains/login.keychain-db',
  codex: '.codex/auth.json',
  gemini: '.gemini/oauth_creds.json',
  antigravity: null,
  opencode: '.local/share/opencode/auth.json',
};
/** `--help` argv per harness (the subcommand whose flags the builder uses). */
const HELP_ARGV: Record<ExtractorHarness, string[]> = {
  claude: ['--help'],
  codex: ['exec', '--help'],
  gemini: ['--help'],
  antigravity: ['--help'],
  opencode: ['run', '--help'],
};

const enumOr = (v: unknown, re: RegExp): string | null => (typeof v === 'string' && re.test(v) ? v : v == null ? null : '<non-enum>');
const readJson = (p: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};
const objKeys = (v: unknown): string[] => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : []);

function authMode(h: ExtractorHarness, home: string): { mode: Record<string, unknown>; metered: boolean } {
  const store = readJson(join(home, AUTH_STORE[h]));
  if (h === 'claude') {
    return { mode: { has_oauthAccount: store?.oauthAccount != null, has_primaryApiKey: store?.primaryApiKey != null }, metered: false };
  }
  if (h === 'codex') {
    const keySet = typeof store?.OPENAI_API_KEY === 'string' && store.OPENAI_API_KEY.length > 0;
    return { mode: { has_tokens_object: objKeys(store?.tokens).length > 0, openai_api_key_set: keySet }, metered: keySet };
  }
  if (h === 'opencode') {
    const providers: Record<string, string | null> = {};
    for (const [name, entry] of Object.entries(store ?? {})) {
      providers[name] = enumOr((entry as { type?: unknown } | null)?.type, /^(oauth|api|wellknown)$/);
    }
    return { mode: { providers }, metered: Object.values(providers).includes('api') };
  }
  const settings = readJson(join(home, '.gemini/settings.json'));
  const nested = (settings?.security as { auth?: { selectedType?: unknown } } | undefined)?.auth?.selectedType;
  const selectedType = enumOr(settings?.selectedType ?? nested, /^[a-z][a-z0-9-]{0,40}$/);
  return { mode: { selectedType }, metered: selectedType !== null && /api-key|vertex/.test(selectedType) };
}

/** MCP server NAMES declared in the forwarded MCP configs inside an isolated HOME. */
function forwardedMcp(iso: string): Array<{ file: string; name: string }> {
  const found: Array<{ file: string; name: string }> = [];
  for (const file of ['.gemini/settings.json', '.claude.json', '.gemini/config/mcp_config.json']) {
    const j = readJson(join(iso, file));
    for (const name of objKeys(j?.mcpServers)) found.push({ file, name });
    if (file === '.claude.json') {
      for (const p of Object.values((j?.projects as Record<string, unknown> | undefined) ?? {})) {
        for (const name of objKeys((p as { mcpServers?: unknown } | null)?.mcpServers)) found.push({ file, name });
      }
    }
  }
  const toml = join(iso, '.codex/config.toml');
  if (existsSync(toml)) {
    for (const line of readFileSync(toml, 'utf-8').split('\n')) {
      const m = /^\s*\[?\s*mcp_servers\.("?)([A-Za-z0-9_-]+)\1[.\]\s=]/.exec(line);
      if (m) found.push({ file: '.codex/config.toml', name: m[2] });
    }
  }
  const seen = new Set<string>();
  return found.filter((f) => {
    const key = `${f.file}:${f.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Names the builder argv neutralizes: claude's --strict-mcp-config (all of .claude.json), codex -c overrides. */
function neutralized(spawn: ExtractorSpawn, f: { file: string; name: string }): boolean {
  if (f.file === '.claude.json') return spawn.args.includes('--strict-mcp-config');
  if (f.file === '.codex/config.toml') return spawn.args.some((a) => a.startsWith(`mcp_servers.${f.name}.command=`));
  return false;
}

function flagsPresent(bin: string, h: ExtractorHarness, flags: string[], env: NodeJS.ProcessEnv): Record<string, boolean> {
  const r = spawnSync(bin, HELP_ARGV[h], { env, encoding: 'utf-8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const out: Record<string, boolean> = {};
  for (const f of flags) out[f] = new RegExp(`(^|[\\s,\\[])${f.replace(/[-]/g, '\\-')}([\\s,=\\]]|$)`, 'm').test(text);
  return out;
}

// ---------------------------------------------------------------------------
// One arm
// ---------------------------------------------------------------------------

type Outcome = 'ok' | 'auth' | 'other';

const STDERR_CLASSES: Array<[string, RegExp]> = [
  ['auth', /unauthori[sz]ed|\b401\b|\b403\b|not logged in|authenticat|credential|oauth|expired|refresh/i],
  ['keychain', /keychain|SecItem|errSec/i],
  ['network', /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|proxy|certificate|UNABLE_TO_GET_ISSUER/i],
  ['argv', /unknown (argument|option)|unexpected argument|Usage:/i],
  ['mcp', /\bmcp\b/i],
  ['quota', /quota|rate limit|\b429\b/i],
  ['env', /environment variable|not set/i],
];

const mtime = (p: string | null): number | null => {
  try {
    return p ? statSync(p).mtimeMs : null;
  } catch {
    return null;
  }
};

async function runArm(
  out: string,
  h: ExtractorHarness,
  arm: 'allow' | 'base',
  spawn: ExtractorSpawn,
  timeoutSec: number,
): Promise<{ outcome: Outcome; witnessMoved: boolean | null }> {
  const witness = WITNESS[h] ? join(homedir(), WITNESS[h] as string) : null;
  const before = mtime(witness);
  const started = Date.now();
  try {
    const args = spawn.delivery === 'argv' ? [...spawn.args, spawn.prompt] : spawn.args;
    const res = await execHarness(spawn.bin, args, {
      cwd: spawn.cwd,
      env: spawn.env,
      timeout_ms: timeoutSec * 1_000,
      stdin: spawn.delivery === 'stdin' ? spawn.prompt : undefined,
    });
    const envelope = h === 'claude' ? detectClaudeErrorEnvelope(res.stdout) : null;
    const answerOk = envelope === null && /\bOK\b/.test(extractText(h, res.stdout));
    const stderrClasses = STDERR_CLASSES.filter(([, re]) => re.test(res.stderr)).map(([c]) => c);
    const childNames = new Set(Object.keys(spawn.env));
    const dropped = Object.keys(process.env).filter((n) => !childNames.has(n)).sort();
    const text = `${res.stdout}\n${res.stderr}`;
    const mentioned = dropped.filter((n) => new RegExp(`(^|[^A-Za-z0-9_])${n}([^A-Za-z0-9_]|$)`).test(text));
    const after = mtime(witness);
    const witnessMoved = before === null || after === null ? null : after !== before;
    const ok = !res.timed_out && res.code === 0 && answerOk;
    const outcome: Outcome = ok ? 'ok' : envelope?.kind === 'auth_error' || stderrClasses.includes('auth') ? 'auth' : 'other';
    let claudeEnvelope: object | undefined;
    if (h === 'claude') {
      let last: Record<string, unknown> | null = null;
      for (const line of res.stdout.split('\n')) {
        try {
          const ev = JSON.parse(line.trim()) as Record<string, unknown>;
          if (ev.type === 'result') last = ev;
        } catch {
          /* not JSON */
        }
      }
      claudeEnvelope = {
        type: enumOr(last?.type, /^[a-z_]{1,40}$/),
        subtype: enumOr(last?.subtype, /^[a-z_]{1,40}$/),
        is_error: typeof last?.is_error === 'boolean' ? last.is_error : null,
        classified: envelope?.kind ?? null,
      };
    }
    write(out, {
      kind: 'arm',
      ts: new Date().toISOString(),
      harness: h,
      arm,
      exit: res.code,
      secs: Math.round((Date.now() - started) / 100) / 10,
      timed_out: res.timed_out,
      stdout_bytes: Buffer.byteLength(res.stdout),
      stderr_bytes: Buffer.byteLength(res.stderr),
      answer_ok: answerOk,
      ...(claudeEnvelope ? { claude_envelope: claudeEnvelope } : {}),
      stderr_classes: stderrClasses,
      dropped_names: dropped,
      dropped_names_mentioned: mentioned,
      auth_store_mtime_changed: witnessMoved,
      outcome,
    });
    return { outcome, witnessMoved };
  } finally {
    spawn.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (process.env.CI) refuse('CI is set — this instrument makes real subscription calls and never runs in CI');
  const badBack = args.addBack.filter((n) => /_API_KEY$/.test(n) || /^CLAUDE/.test(n) || /^ANTHROPIC_/.test(n));
  if (badBack.length > 0) refuse(`--add-back may not name a metered or claude-namespace variable (${badBack.join(',')})`);
  const bins = new Map<ExtractorHarness, string>();
  for (const h of args.harnesses) {
    const p = resolveBin(HARNESS_BIN[h]);
    if (!p) refuse(`\`${HARNESS_BIN[h]}\` (${h}) is not resolvable on PATH`);
    bins.set(h, p);
  }
  if (args.harnesses.includes('claude') && watcherAlive()) {
    if (!args.afterWatch) refuse('the TD-471 watcher is alive; a claude call now would refresh the token and erase its expiry boundary');
    if (!watcherFinished(args.watchEvidence)) refuse('--after-td471-watch given, but no watcher JSONL holds a verdict or stop line yet');
  }

  mkdirSync(dirname(args.out), { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), `td472-probe-${process.pid}-`));
  const reap = (): void => rmSync(scratch, { recursive: true, force: true });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      write(args.out, { kind: 'stop', ts: new Date().toISOString(), reason: sig });
      reap();
      process.exit(130);
    });
  }
  const opts = { env: { IGRIS_LLM_EXTRACTOR_SCRATCH_ROOT: scratch } };
  write(args.out, {
    kind: 'header',
    ts: new Date().toISOString(),
    pid: process.pid,
    harnesses: args.harnesses,
    timeout_sec: args.timeoutSec,
    add_back: args.addBack,
    accept_mcp: args.acceptMcp,
    node: process.version,
  });

  const verdicts: Record<string, string> = {};
  try {
    for (const h of args.harnesses) {
      const bin = bins.get(h) as string;
      const probeSpawn = buildExtractorSpawn(h, PROMPT, opts);
      const mcp = forwardedMcp(probeSpawn.cwd).filter((f) => !neutralized(probeSpawn, f));
      const flags = probeSpawn.args.filter((a) => a.startsWith('-'));
      const version = spawnSync(bin, ['--version'], { env: probeSpawn.env, cwd: probeSpawn.cwd, encoding: 'utf-8', timeout: 15_000 });
      const versionLine = (version.stdout ?? '').split('\n')[0].trim();
      const helpFlags = flagsPresent(bin, h, flags, probeSpawn.env);
      probeSpawn.cleanup();
      const auth = authMode(h, homedir());
      const storePresent = existsSync(join(homedir(), AUTH_STORE[h]));
      const leak = mcp.filter((f) => f.name === 'igris-brain');
      const blocked = mcp.filter((f) => f.name !== 'igris-brain' && !args.acceptMcp.includes(f.name));
      const decision = leak.length > 0 ? 'BLOCKED_BRAIN_LEAK' : blocked.length > 0 ? 'BLOCKED_MCP' : !storePresent ? 'NOT_LOGGED_IN' : auth.metered ? 'METERED_MODE' : 'RUN';
      write(args.out, {
        kind: 'preflight',
        ts: new Date().toISOString(),
        harness: h,
        bin_path: bin,
        version: /^[\w .()+\-/:]{1,80}$/.test(versionLine) ? versionLine : '<unparsed>',
        argv_flags_in_help: helpFlags,
        auth_store_present: storePresent,
        auth_mode: auth.mode,
        forwarded_mcp: mcp,
        run_decision: decision,
        ...(decision === 'BLOCKED_BRAIN_LEAK'
          ? { refusal: `igris-brain is declared in a forwarded MCP config; a live call would boot the live brain — blocked until ${F5_BR} lands` }
          : {}),
      });
      if (decision !== 'RUN' && decision !== 'METERED_MODE') {
        verdicts[h] = decision;
        write(args.out, { kind: 'verdict', ts: new Date().toISOString(), harness: h, verdict: decision });
        continue;
      }
      const allowSpawn = buildExtractorSpawn(h, PROMPT, opts);
      for (const n of args.addBack) if (process.env[n] !== undefined) allowSpawn.env[n] = process.env[n];
      const allow = await runArm(args.out, h, 'allow', allowSpawn, args.timeoutSec);
      const baseSpawn = buildExtractorSpawn(h, PROMPT, opts);
      baseSpawn.env = td471SubscriptionOnlyEnv(process.env, { HOME: baseSpawn.cwd });
      const base = await runArm(args.out, h, 'base', baseSpawn, args.timeoutSec);
      const armsVerdict =
        allow.outcome === 'ok'
          ? allow.witnessMoved
            ? 'PASS_WITH_REFRESH'
            : 'PASS'
          : base.outcome === 'ok'
            ? 'REGRESSION'
            : 'PRE_EXISTING';
      verdicts[h] = decision === 'METERED_MODE' ? 'METERED_MODE' : armsVerdict;
      write(args.out, {
        kind: 'verdict',
        ts: new Date().toISOString(),
        harness: h,
        verdict: verdicts[h],
        arms_verdict: armsVerdict,
        outcomes: { allow: allow.outcome, base: base.outcome },
        refresh_witness_moved: allow.witnessMoved,
      });
    }
    write(args.out, { kind: 'overall', ts: new Date().toISOString(), verdicts });
    process.stdout.write(`${JSON.stringify(verdicts)}\n`);
  } finally {
    reap();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`td472_child_env_probe: ${err instanceof Error ? err.name : 'error'}\n`);
  process.exit(1);
});
