/**
 * TD-472 / BR-108 — live probe: does each harness still authenticate by SUBSCRIPTION
 * under the allowlist child env AND the allowlist isolated HOME, and does it spawn
 * no MCP server? (OPERATOR-RUN INSTRUMENT; never CI; the `td472_` prefix keeps it
 * out of the npm package — BR-101. BR-108 extends this file rather than forking a
 * `br108_` script, which the prune rule would NOT catch.)
 *
 * IT IMPORTS THE SHIPPED BACKEND (test_standards 9a). Per runnable harness it runs
 * two arms on the SAME argv and a fresh isolated HOME each, so env is the ONE
 * variable:
 *   allow  FIRST. The production `buildExtractorSpawn` + `execHarness`, untouched
 *          (plus `--add-back` names / `--add-back-file` links in bisect mode). First,
 *          so the arm that meets a due token refresh is the arm UNDER TEST.
 *   base   The same spawn with ONLY `spawn.env` swapped for the TD-471 shape
 *          (`td471SubscriptionOnlyEnv` below — the control replica).
 *   inventory  (claude only, `--mcp-inventory`) the allow argv with
 *          `--output-format stream-json --verbose`; emits the `system/init` MCP
 *          server count + names and the count of `mcp__` tools, nothing else.
 * Prompt: system `Reply with exactly: OK`, user `ping`; no `--model` (production parity).
 *
 * PROCESS CENSUS (BR-108). Every arm is sampled every 150 ms with
 * `ps -Ao pid=,ppid=,args=`; the probe's DESCENDANTS are classified in-process
 * (`cli_self`, `igris_brain`, `declared_server`, `mcp`) and only the executable
 * basename + class names are kept, never args. `mcp_spawned` = a non-`cli_self`
 * descendant carrying any other class. Scope: LOCAL processes only — a remote MCP
 * (codex `codex_apps`, claude.ai connectors) spawns no process, and a server that
 * daemonizes out of the ppid tree is missed. `--census-selftest` spawns a canary
 * (`node -e … igris-brain-census-canary`) that MUST read `mcp_spawned: true` with
 * class `igris_brain`; live arms are refused unless it passed in the same process.
 *
 * PRE-REGISTERED VERDICT (one `verdict` line per harness, then one `overall` line).
 * Preflight decision order: BLOCKED_BRAIN_LEAK → BLOCKED_MCP → BLOCKED_ARGV →
 * NOT_LOGGED_IN → METERED_MODE → RUN.
 *   PASS               allow ok, auth-store witness unmoved
 *   PASS_WITH_REFRESH  allow ok, witness moved (a refresh ran under the allowlist)
 *   REGRESSION         allow not ok, base ok -> bisect with --add-back / --add-back-file
 *   PRE_EXISTING       both not ok (the harness never worked in this shape; file a BR)
 *   MCP_SPAWNED        any arm's census saw an MCP-class descendant (overrides PASS)
 *   CENSUS_BLIND       the allow arm's census never saw the CLI itself (replaces PASS)
 *   BLOCKED_BRAIN_LEAK a file in the isolated HOME declares igris-brain (a BR-108 regression)
 *   BLOCKED_MCP        another MCP server is declared in the isolated HOME and not in
 *                      --accept-mcp, or (codex) `codex mcp list` names one / a denied
 *                      feature reads enabled
 *   BLOCKED_ARGV       a builder flag is absent from this CLI's --help (BR-109)
 *   NOT_LOGGED_IN      the harness's auth store is absent
 *   METERED_MODE       the stored login is metered; arms still run, `arms_verdict` holds the rest
 *
 * VALUES NEVER REACH OUTPUT (plan D6). Records carry envelope enums, booleans, byte
 * counts, stderr CLASS names from a fixed list, env NAMES and MCP server NAMES. Never
 * stdout/stderr text, never a value, never a TOML header other than as a
 * `mcp_servers.<name>` name, never a process's args. Config files are parsed
 * in-process by basename; the auth-store basenames are never parsed by the MCP walk.
 *
 * USAGE (from a desktop-harness shell):
 *   cd brain-mcp-server && npx tsx scripts/td472_child_env_probe.ts --harness <h[,h…]> \
 *     [--out <jsonl>] [--timeout-sec 180] [--add-back N1,N2] [--add-back-file rel1,rel2] \
 *     [--accept-mcp n1,n2] [--census-selftest] [--preflight-only] [--mcp-inventory] \
 *     [--after-td471-watch] [--td471-evidence <dir>]
 *   `--preflight-only` writes the preflight records and stops: NO subscription call.
 * Exit 2 with one line when: CI is set; a flag is bad; a requested bin is not
 * resolvable; `claude` is requested while the TD-471 watcher is alive (override
 * `--after-td471-watch` only once its evidence JSONL holds a `verdict`/`stop` line);
 * an `--add-back` name is metered or in the claude namespace (a false PASS by billing);
 * an `--add-back-file` path could carry MCP, hooks, settings or `.env`; live arms
 * are requested without a passing `--census-selftest`; the self-test fails.
 */

import { spawn as spawnChild, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  assertUnderRoot,
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
const WATCHER_MARK = 'td471_host_auth_watch';
/** `--add-back-file` may never link a path that can declare MCP, hooks, settings or metered keys. */
const ADD_BACK_FILE_REFUSED = /mcp|hook|settings\.json|config\.toml|\.env|extensions|agents|plugins/i;

interface Args {
  harnesses: ExtractorHarness[];
  out: string;
  timeoutSec: number;
  addBack: string[];
  addBackFile: string[];
  acceptMcp: string[];
  afterWatch: boolean;
  watchEvidence: string;
  censusSelftest: boolean;
  preflightOnly: boolean;
  mcpInventory: boolean;
}

/** Print one refusal line and exit 2 (no env value is ever named). */
function refuse(line: string): never {
  process.stderr.write(`td472_child_env_probe: REFUSED — ${line}\n`);
  process.exit(2);
}

const utcStamp = (d = new Date()): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const list = (v: string): string[] => v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
const BOOLEAN_FLAGS: Record<string, keyof Args> = {
  '--after-td471-watch': 'afterWatch',
  '--census-selftest': 'censusSelftest',
  '--preflight-only': 'preflightOnly',
  '--mcp-inventory': 'mcpInventory',
};

function parseArgs(argv: string[]): Args {
  const evidence = resolve(homedir(), '.igris/projects/igris-ai/plans');
  const args: Args = {
    harnesses: [],
    out: join(evidence, 'td472-evidence', `probe-${utcStamp()}.jsonl`),
    timeoutSec: 180,
    addBack: [],
    addBackFile: [],
    acceptMcp: [],
    afterWatch: false,
    watchEvidence: join(evidence, 'td471-evidence'),
    censusSelftest: false,
    preflightOnly: false,
    mcpInventory: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const bool = BOOLEAN_FLAGS[flag];
    if (bool) {
      (args as unknown as Record<string, boolean>)[bool] = true;
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
    else if (flag === '--add-back-file') args.addBackFile = list(value);
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

/** Config basenames the MCP walk parses; anything else (auth stores included) is never opened. */
const MCP_CONFIG_BASENAMES = new Set([
  'settings.json',
  'mcp_config.json',
  '.claude.json',
  'config.toml',
  'opencode.json',
  'opencode.jsonc',
  'config.json',
  'gemini-extension.json',
  '.mcp.json',
]);
const WALK_CAP = 50_000;

/** Parse JSON, else JSONC with whole-line `//` comments removed. */
function readJsonc(p: string): unknown {
  const text = readFileSync(p, 'utf-8');
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
    } catch {
      return null;
    }
  }
}

/** MCP server NAMES in one config file: every `mcpServers` object at any depth + opencode's top-level `mcp`. */
function mcpNamesInFile(p: string): string[] {
  if (p.endsWith('.toml')) {
    const names: string[] = [];
    const key = '(?:"([^"]+)"|([A-Za-z0-9_-]+))';
    const res = [new RegExp(`^\\s*\\[\\s*mcp_servers\\.${key}`), new RegExp(`^\\s*mcp_servers\\.${key}\\s*\\.`)];
    for (const line of readFileSync(p, 'utf-8').split('\n')) {
      for (const re of res) {
        const m = re.exec(line);
        if (m) names.push(m[1] ?? m[2]);
      }
      const inline = /mcp_servers\s*=\s*\{(.*)\}/.exec(line);
      if (inline) for (const m of inline[1].matchAll(new RegExp(`(?:^|[{,])\\s*${key}\\s*=\\s*\\{`, 'g'))) names.push(m[1] ?? m[2]);
    }
    return names;
  }
  const j = readJsonc(p);
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return;
    for (const [k, child] of Object.entries(v)) {
      if (k === 'mcpServers') out.push(...objKeys(child));
      walk(child);
    }
  };
  walk(j);
  if (j && typeof j === 'object' && !Array.isArray(j)) out.push(...objKeys((j as { mcp?: unknown }).mcp));
  return out;
}

/** MCP server NAMES declared by any config file reachable in an isolated HOME (symlinks followed). */
function forwardedMcp(iso: string): { found: Array<{ file: string; name: string }>; truncated: boolean } {
  const found: Array<{ file: string; name: string }> = [];
  const seen = new Set<string>();
  let visited = 0;
  const visit = (abs: string, rel: string): void => {
    if (visited >= WALK_CAP) return;
    visited += 1;
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    let isDir = false;
    try {
      isDir = statSync(real).isDirectory();
    } catch {
      return;
    }
    if (isDir) {
      let entries: string[] = [];
      try {
        entries = readdirSync(real);
      } catch {
        return;
      }
      for (const e of entries) visit(join(abs, e), rel ? `${rel}/${e}` : e);
      return;
    }
    if (!MCP_CONFIG_BASENAMES.has(basename(rel))) return;
    try {
      for (const name of mcpNamesInFile(real)) found.push({ file: rel, name });
    } catch {
      /* unreadable */
    }
  };
  visit(iso, '');
  const dedup = new Set<string>();
  return {
    found: found.filter((f) => {
      const k = `${f.file}:${f.name}`;
      if (dedup.has(k)) return false;
      dedup.add(k);
      return true;
    }),
    truncated: visited >= WALK_CAP,
  };
}

/** MCP server NAMES the operator's REAL config files declare (the census's `declared_server` class). */
function operatorDeclaredNames(): string[] {
  const home = homedir();
  const files = [
    '.claude.json',
    '.gemini/settings.json',
    '.gemini/antigravity-cli/settings.json',
    '.codex/config.toml',
    '.config/opencode/opencode.json',
    '.config/opencode/opencode.jsonc',
    '.config/opencode/config.json',
  ];
  const names = new Set<string>();
  for (const f of files) {
    const p = join(home, f);
    if (!existsSync(p)) continue;
    try {
      for (const n of mcpNamesInFile(p)) names.add(n);
    } catch {
      /* unreadable */
    }
  }
  return [...names];
}

/** Only claude's --strict-mcp-config neutralizes a declaring file (all of .claude.json). */
function neutralized(spawn: ExtractorSpawn, f: { file: string; name: string }): boolean {
  return f.file === '.claude.json' && spawn.args.includes('--strict-mcp-config');
}

function flagsPresent(bin: string, h: ExtractorHarness, flags: string[], env: NodeJS.ProcessEnv): Record<string, boolean> {
  const r = spawnSync(bin, HELP_ARGV[h], { env, encoding: 'utf-8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const out: Record<string, boolean> = {};
  for (const f of flags) out[f] = new RegExp(`(^|[\\s,\\[])${f.replace(/[-]/g, '\\-')}([\\s,=\\]]|$)`, 'm').test(text);
  return out;
}

/** codex offline checks in the isolated HOME: `mcp list` name count + the owned deny block's booleans. */
function codexOffline(bin: string, spawn: ExtractorSpawn): { names: number | null; features: Record<string, boolean | null> } {
  const opts = { env: spawn.env, cwd: spawn.cwd, encoding: 'utf-8' as const, timeout: 20_000 };
  const mcp = spawnSync(bin, ['mcp', 'list', '--json'], opts);
  let names: number | null = null;
  try {
    names = (JSON.parse(mcp.stdout ?? '') as unknown[]).length;
  } catch {
    /* unparsed */
  }
  const toml = readFileSync(join(spawn.cwd, '.codex/config.toml'), 'utf-8');
  const deny = toml.slice(toml.indexOf('[features]')).split('\n').slice(1).map((l) => /^([a-z0-9_]+) = false$/.exec(l.trim())?.[1]).filter((n): n is string => !!n);
  const rows = new Map<string, string>();
  for (const l of (spawnSync(bin, ['features', 'list'], opts).stdout ?? '').split('\n')) {
    const parts = l.trim().split(/\s+/);
    if (parts.length >= 2) rows.set(parts[0], parts[parts.length - 1]);
  }
  const features: Record<string, boolean | null> = {};
  for (const n of deny) features[n] = rows.has(n) ? rows.get(n) === 'true' : null;
  return { names, features };
}

// ---------------------------------------------------------------------------
// Process census (BR-108)
// ---------------------------------------------------------------------------

interface CensusResult {
  samples: number;
  cli_seen: boolean;
  descendants: Array<{ exe_basename: string; classes: string[] }>;
  mcp_spawned: boolean;
}

const MCP_ARGS = /modelcontextprotocol|mcp[-_]server|[-_]mcp\b|\bmcp[-_]/i;
const BRAIN_ARGS = /igris-brain|brain-mcp-server/;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Paths that identify the CLI's own processes: the bin, its realpath, and its npm package root. */
function cliMarks(bin: string): string[] {
  const marks = new Set<string>([bin]);
  try {
    const real = realpathSync(bin);
    marks.add(real);
    let d = dirname(real);
    for (let i = 0; i < 4 && d !== dirname(d) && d !== homedir(); i += 1) {
      if (existsSync(join(d, 'package.json'))) {
        marks.add(d);
        break;
      }
      d = dirname(d);
    }
  } catch {
    /* unresolvable: the bin path alone */
  }
  return [...marks];
}

class Census {
  private timer: NodeJS.Timeout | null = null;
  private samples = 0;
  private cliSeen = false;
  private spawned = false;
  private readonly seen = new Map<string, { exe_basename: string; classes: string[] }>();
  private readonly declared: RegExp | null;
  // Descendants alive before the arm (tsx's esbuild service, whose args name brain-mcp-server) are not the arm's.
  private preexisting: Set<number> | null = null;

  constructor(
    private readonly marks: string[],
    declaredNames: string[],
  ) {
    const usable = declaredNames.filter((n) => n.length >= 3);
    this.declared = usable.length > 0 ? new RegExp(`(^|[^A-Za-z0-9_-])(${usable.map(escapeRe).join('|')})([^A-Za-z0-9_-]|$)`) : null;
  }

  start(): void {
    this.preexisting = null;
    this.sample();
    this.timer = setInterval(() => this.sample(), 150);
  }

  stop(): CensusResult {
    if (this.timer) clearInterval(this.timer);
    this.sample();
    return { samples: this.samples, cli_seen: this.cliSeen, descendants: [...this.seen.values()], mcp_spawned: this.spawned };
  }

  private sample(): void {
    const r = spawnSync('ps', ['-Ao', 'pid=,ppid=,args='], { encoding: 'utf-8', timeout: 5_000, maxBuffer: 32 * 1024 * 1024 });
    if (r.status !== 0) return;
    if (this.preexisting !== null) this.samples += 1;
    const children = new Map<number, Array<{ pid: number; args: string }>>();
    for (const line of (r.stdout ?? '').split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const ppid = Number(m[2]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid)?.push({ pid: Number(m[1]), args: m[3] });
    }
    const queue = [...(children.get(process.pid) ?? [])];
    const first = this.preexisting === null;
    if (first) this.preexisting = new Set();
    while (queue.length > 0) {
      const p = queue.shift() as { pid: number; args: string };
      queue.push(...(children.get(p.pid) ?? []));
      const exe = basename(p.args.split(/\s+/)[0] ?? '');
      if (exe === 'ps') continue;
      if (first) {
        this.preexisting?.add(p.pid);
        continue;
      }
      if (this.preexisting?.has(p.pid)) continue;
      const classes: string[] = [];
      if (this.marks.some((mk) => p.args.includes(mk))) classes.push('cli_self');
      if (BRAIN_ARGS.test(p.args)) classes.push('igris_brain');
      if (this.declared?.test(p.args)) classes.push('declared_server');
      if (MCP_ARGS.test(p.args)) classes.push('mcp');
      if (classes.includes('cli_self')) this.cliSeen = true;
      else if (classes.length > 0) this.spawned = true;
      const key = `${exe}|${classes.join(',')}`;
      if (!this.seen.has(key)) this.seen.set(key, { exe_basename: exe, classes });
    }
  }
}

/** The positive control: a canary child whose args name igris-brain MUST read as spawned. */
async function censusSelftest(): Promise<CensusResult> {
  const census = new Census([], []);
  census.start(); // BEFORE the canary: a pre-existing descendant is excluded by design
  const canary = spawnChild(process.execPath, ['-e', 'setTimeout(()=>{},1500)', 'igris-brain-census-canary'], { stdio: 'ignore' });
  await new Promise<void>((done) => canary.on('exit', () => done()));
  return census.stop();
}

// ---------------------------------------------------------------------------
// One arm
// ---------------------------------------------------------------------------

type Outcome = 'ok' | 'auth' | 'other';
type Arm = 'allow' | 'base' | 'inventory';

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

/** claude stream-json `system/init`: MCP server count + names and the `mcp__` tool count only. */
function claudeInventory(stdout: string): object {
  for (const line of stdout.split('\n')) {
    try {
      const ev = JSON.parse(line.trim()) as { type?: unknown; subtype?: unknown; mcp_servers?: unknown; tools?: unknown };
      if (ev.type !== 'system' || ev.subtype !== 'init') continue;
      const servers = Array.isArray(ev.mcp_servers) ? ev.mcp_servers : [];
      const names = servers.map((s) => (s as { name?: unknown } | null)?.name).filter((n): n is string => typeof n === 'string');
      const tools = Array.isArray(ev.tools) ? ev.tools : [];
      return {
        init_seen: true,
        mcp_servers_count: servers.length,
        mcp_server_names: names,
        mcp_tools_count: tools.filter((t) => typeof t === 'string' && t.startsWith('mcp__')).length,
      };
    } catch {
      /* not JSON */
    }
  }
  return { init_seen: false };
}

async function runArm(
  out: string,
  h: ExtractorHarness,
  arm: Arm,
  spawn: ExtractorSpawn,
  timeoutSec: number,
  census: Census,
): Promise<{ outcome: Outcome; witnessMoved: boolean | null; census: CensusResult }> {
  const witness = WITNESS[h] ? join(homedir(), WITNESS[h] as string) : null;
  const before = mtime(witness);
  const started = Date.now();
  census.start();
  let censusResult: CensusResult | null = null;
  try {
    const args = spawn.delivery === 'argv' ? [...spawn.args, spawn.prompt] : spawn.args;
    const res = await execHarness(spawn.bin, args, {
      cwd: spawn.cwd,
      env: spawn.env,
      timeout_ms: timeoutSec * 1_000,
      stdin: spawn.delivery === 'stdin' ? spawn.prompt : undefined,
    });
    censusResult = census.stop();
    const inventory = arm === 'inventory';
    const envelope = h === 'claude' && !inventory ? detectClaudeErrorEnvelope(res.stdout) : null;
    const answerOk = envelope === null && /\bOK\b/.test(inventory ? res.stdout : extractText(h, res.stdout));
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
    if (h === 'claude' && !inventory) {
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
      ...(inventory ? { inventory: claudeInventory(res.stdout) } : {}),
      stderr_classes: stderrClasses,
      dropped_names: dropped,
      dropped_names_mentioned: mentioned,
      auth_store_mtime_changed: witnessMoved,
      outcome,
      census: censusResult,
    });
    return { outcome, witnessMoved, census: censusResult };
  } finally {
    if (censusResult === null) census.stop();
    spawn.cleanup();
  }
}

/** Link the named real-HOME paths into the allow arm's isolated HOME (the agy bisect). */
function addBackFiles(spawn: ExtractorSpawn, rels: string[]): void {
  for (const rel of rels) {
    const src = join(homedir(), rel);
    const dest = join(spawn.cwd, rel);
    assertUnderRoot(dest, spawn.cwd);
    if (!existsSync(src)) continue;
    let exists = true;
    try {
      lstatSync(dest);
    } catch {
      exists = false;
    }
    if (exists) refuse(`--add-back-file ${rel} already exists in the isolated HOME (owned or forwarded)`);
    mkdirSync(dirname(dest), { recursive: true });
    symlinkSync(src, dest);
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
  const badFile = args.addBackFile.filter((r) => ADD_BACK_FILE_REFUSED.test(r) || isAbsolute(r) || r.split('/').includes('..'));
  if (badFile.length > 0) refuse(`--add-back-file may not name a path that can carry MCP, hooks, settings or .env (${badFile.join(',')})`);
  if (args.mcpInventory && !args.harnesses.includes('claude')) refuse('--mcp-inventory is a claude-only arm');
  if (!args.preflightOnly && !args.censusSelftest) refuse('live arms need --census-selftest (a census that was never shown to fire proves nothing)');
  const bins = new Map<ExtractorHarness, string>();
  for (const h of args.harnesses) {
    const p = resolveBin(HARNESS_BIN[h]);
    if (!p) refuse(`\`${HARNESS_BIN[h]}\` (${h}) is not resolvable on PATH`);
    bins.set(h, p);
  }
  if (args.harnesses.includes('claude') && !args.preflightOnly && watcherAlive()) {
    if (!args.afterWatch) refuse('the TD-471 watcher is alive; a claude call now would refresh the token and erase its expiry boundary');
    if (!watcherFinished(args.watchEvidence)) refuse('--after-td471-watch given, but no watcher JSONL holds a verdict or stop line yet');
  }

  mkdirSync(dirname(args.out), { recursive: true });
  if (args.censusSelftest) {
    const self = await censusSelftest();
    const passed = self.mcp_spawned && self.descendants.some((d) => d.classes.includes('igris_brain'));
    write(args.out, { kind: 'census_selftest', ts: new Date().toISOString(), passed, census: self });
    if (!passed) refuse('the census self-test did not see its igris-brain canary; the census is blind');
  }
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
    add_back_file: args.addBackFile,
    accept_mcp: args.acceptMcp,
    preflight_only: args.preflightOnly,
    mcp_inventory: args.mcpInventory,
    node: process.version,
  });
  const declared = operatorDeclaredNames();

  const verdicts: Record<string, string> = {};
  try {
    for (const h of args.harnesses) {
      const bin = bins.get(h) as string;
      const probeSpawn = buildExtractorSpawn(h, PROMPT, opts);
      const walk = forwardedMcp(probeSpawn.cwd);
      const mcp = walk.found.filter((f) => !neutralized(probeSpawn, f));
      const flags = probeSpawn.args.filter((a) => a.startsWith('-'));
      const version = spawnSync(bin, ['--version'], { env: probeSpawn.env, cwd: probeSpawn.cwd, encoding: 'utf-8', timeout: 15_000 });
      const versionLine = (version.stdout ?? '').split('\n')[0].trim();
      const helpFlags = flagsPresent(bin, h, flags, probeSpawn.env);
      const codex = h === 'codex' ? codexOffline(bin, probeSpawn) : null;
      probeSpawn.cleanup();
      const auth = authMode(h, homedir());
      const storePresent = existsSync(join(homedir(), AUTH_STORE[h]));
      const leak = mcp.filter((f) => f.name === 'igris-brain');
      const blocked = mcp.filter((f) => f.name !== 'igris-brain' && !args.acceptMcp.includes(f.name));
      const codexMcpLive = codex !== null && (codex.names !== 0 || Object.values(codex.features).some((v) => v !== false));
      const argvMissing = Object.entries(helpFlags).filter(([, present]) => !present).map(([f]) => f);
      const decision =
        leak.length > 0
          ? 'BLOCKED_BRAIN_LEAK'
          : blocked.length > 0 || codexMcpLive
            ? 'BLOCKED_MCP'
            : argvMissing.length > 0
              ? 'BLOCKED_ARGV'
              : !storePresent
                ? 'NOT_LOGGED_IN'
                : auth.metered
                  ? 'METERED_MODE'
                  : 'RUN';
      const refusals: Record<string, string> = {
        BLOCKED_BRAIN_LEAK: 'igris-brain is declared in a file inside the isolated HOME; a live call would boot the live brain — a BR-108 regression',
        BLOCKED_ARGV: `builder flags absent from this CLI's --help (${argvMissing.join(',')}) — BR-109`,
      };
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
        forwarded_mcp_walk_truncated: walk.truncated,
        ...(codex ? { codex_mcp_list_names: codex.names, codex_mcp_features_enabled: codex.features } : {}),
        run_decision: decision,
        ...(refusals[decision] ? { refusal: refusals[decision] } : {}),
      });
      if (args.preflightOnly || (decision !== 'RUN' && decision !== 'METERED_MODE')) {
        verdicts[h] = args.preflightOnly ? `PREFLIGHT_${decision}` : decision;
        write(args.out, { kind: 'verdict', ts: new Date().toISOString(), harness: h, verdict: verdicts[h] });
        continue;
      }
      const marks = cliMarks(bin);
      const allowSpawn = buildExtractorSpawn(h, PROMPT, opts);
      for (const n of args.addBack) if (process.env[n] !== undefined) allowSpawn.env[n] = process.env[n];
      addBackFiles(allowSpawn, args.addBackFile);
      const allow = await runArm(args.out, h, 'allow', allowSpawn, args.timeoutSec, new Census(marks, declared));
      const baseSpawn = buildExtractorSpawn(h, PROMPT, opts);
      baseSpawn.env = td471SubscriptionOnlyEnv(process.env, { HOME: baseSpawn.cwd });
      const base = await runArm(args.out, h, 'base', baseSpawn, args.timeoutSec, new Census(marks, declared));
      let inventorySpawned = false;
      if (h === 'claude' && args.mcpInventory) {
        const invSpawn = buildExtractorSpawn(h, PROMPT, opts);
        const i = invSpawn.args.indexOf('--output-format');
        invSpawn.args.splice(i, 2, '--output-format', 'stream-json', '--verbose');
        inventorySpawned = (await runArm(args.out, h, 'inventory', invSpawn, args.timeoutSec, new Census(marks, declared))).census.mcp_spawned;
      }
      const armsVerdict =
        allow.outcome === 'ok'
          ? allow.witnessMoved
            ? 'PASS_WITH_REFRESH'
            : 'PASS'
          : base.outcome === 'ok'
            ? 'REGRESSION'
            : 'PRE_EXISTING';
      const spawned = allow.census.mcp_spawned || base.census.mcp_spawned || inventorySpawned;
      const censusVerdict = spawned ? 'MCP_SPAWNED' : armsVerdict.startsWith('PASS') && !allow.census.cli_seen ? 'CENSUS_BLIND' : armsVerdict;
      verdicts[h] = decision === 'METERED_MODE' ? 'METERED_MODE' : censusVerdict;
      write(args.out, {
        kind: 'verdict',
        ts: new Date().toISOString(),
        harness: h,
        verdict: verdicts[h],
        arms_verdict: armsVerdict,
        outcomes: { allow: allow.outcome, base: base.outcome },
        refresh_witness_moved: allow.witnessMoved,
        mcp_spawned: spawned,
        cli_seen: allow.census.cli_seen,
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
