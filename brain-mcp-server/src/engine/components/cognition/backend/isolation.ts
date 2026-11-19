/**
 * Brain Engine v7.1 — Cognition backend: brain-isolation (the LOAD-BEARING safety item).
 *
 * R-BRAIN-LEAK: the extractor's LLM child must NOT reach the live brain. A
 * prompt-injected brief title could call `igris_memory_store` mid-extraction;
 * the model could read/poison the very DB it reasons about. So every extraction
 * call runs in a CLEAN, brain-owned, per-run isolated HOME with ZERO MCP:
 *   - isolated HOME anchored under a brain-owned scratch root
 *     (`~/.igris/cache/llm-extractor/`), NEVER the operator's real HOME;
 *   - only an ALLOWLIST of auth stores is symlinked forward (`FORWARD`);
 *   - every config file a child reads is an OWNED copy with MCP, hook and exec
 *     keys removed, and antigravity (the sole `.gemini/*`-owning extractor
 *     harness since TD-474) gets owned empty `.env` files (BR-108; the why is
 *     in docs/COGNITION.md);
 *   - opencode gets an owned COPY (never a link) of the operator's model
 *     catalog (`.cache/opencode/{models.json,version}`) plus an owned
 *     `.config/opencode/opencode.json` naming `enabled_providers` — an
 *     ALLOWLIST of oauth-backed providers, so a stored metered (api-key)
 *     provider can never load even though `auth.json` stays a readable link
 *     (BR-110) — AND `permission: {"*":"deny", external_directory:{"*":"deny"}}`,
 *     a deny-all tool block (TD-476; the config's `permission` wins the
 *     `merge(defaults, agentSpecific, <config>)` precedence — proven, not
 *     inferred, see `plans/td476-evidence/phase0-static.txt`);
 *   - `assertUnderRoot` guards EVERY write path — a programming bug that would
 *     write under the real HOME fails fast.
 *
 * PORTED FROM FR-201 (COPY, don't import — R-PORT-DRIFT):
 *   - `makeIsolatedHome` / `assertUnderRoot` / the symlink machinery
 *       ← `~/StudioProjects/igris-os-eval/b5/harness/home-isolation.ts`.
 *   - the empty-`mcpServers` pattern
 *       ← `b5/judge.ts:423-514` (`buildJudgeGeminiHome` / `makeJudgeGeminiHome` —
 *         the eval-owned `config/mcp_config.json` written as `{"mcpServers": {}}`).
 *
 * FR-201's WHY was cold-baseline purity; here it is not exposing the LIVE brain
 * to an untrusted LLM call — same mechanism, different motivation.
 *
 * @module engine/components/cognition/backend/isolation
 * @author fifty.dev
 */

import { resolve, relative, isAbsolute, dirname } from 'node:path';
import {
  mkdirSync,
  existsSync,
  symlinkSync,
  rmSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ExtractorHarness } from '../types.js';
import { oauthProviders } from './opencode-model.js';

// ---------------------------------------------------------------------------
// Scratch root (brain-owned — NEVER the operator's real HOME)
// ---------------------------------------------------------------------------

/**
 * The brain-owned scratch ROOT under which every isolated HOME is anchored.
 * `~/.igris/cache/llm-extractor/`. This is NOT the operator's real HOME — it is
 * a dir the brain owns; isolated homes are `<root>/<harness>-<uuid>/`, unique
 * per run (concurrency-safe). Overridable via env for tests (a temp dir).
 */
export function extractorScratchRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.IGRIS_LLM_EXTRACTOR_SCRATCH_ROOT;
  if (override && override.trim().length > 0) return resolve(override);
  return resolve(homedir(), '.igris', 'cache', 'llm-extractor');
}

// ---------------------------------------------------------------------------
// What is forwarded, and what is owned (BR-108)
// ---------------------------------------------------------------------------

const KEYCHAIN = 'Library/Keychains';
const GEMINI_AUTH = ['.gemini/oauth_creds.json', '.gemini/google_accounts.json', '.gemini/installation_id'];

// Auth stores only, symlinked at the same relative path (a token refresh must
// reach the operator's file). Never a file that can declare MCP, hooks or exec.
const FORWARD: Record<ExtractorHarness, readonly string[]> = {
  claude: [KEYCHAIN, '.claude/.credentials.json'],
  codex: [KEYCHAIN, '.codex/auth.json'],
  antigravity: [
    KEYCHAIN,
    ...GEMINI_AUTH,
    '.gemini/antigravity-cli/antigravity-oauth-token',
    '.gemini/antigravity-cli/installation_id',
    '.gemini/antigravity-cli/cache/onboarding.json',
  ],
  // The provider store only: its mcp-auth.json, sessions DB and snapshots stay behind (BR-109).
  opencode: [KEYCHAIN, '.local/share/opencode/auth.json'],
};

// codex root keys carried into the owned config.toml (single-line scalars only).
const CODEX_ROOT_KEYS: ReadonlySet<string> = new Set([
  'model',
  'model_reasoning_effort',
  'cli_auth_credentials_store',
  'forced_login_method',
  'forced_chatgpt_workspace_id',
  'preferred_auth_method',
]);

// codex 0.135.0 features on by default that can bring MCP/apps (BR-108 Phase 0.2).
const CODEX_FEATURE_DENY = [
  'apps',
  'in_app_browser',
  'plugin_sharing',
  'plugins',
  'skill_mcp_dependency_install',
  'tool_call_mcp_elicitation',
  // TD-476: the tools that let a codex child RUN or read. `--sandbox read-only` blocks writes, not
  // reads. Under an adversarial prompt codex ran zsh + rg + head, and its isolated HOME links its
  // own auth.json. `shell_tool` is its shell; `code_mode_host` is its code runner; `shell_snapshot`
  // starts the login shell on every run to snapshot its env, for the shell tool only. `unified_exec`
  // is NOT listed: codex 0.157.0 keeps it on whatever the config says (measured), so a deny line
  // for it would be false.
  'shell_tool',
  'code_mode_host',
  'shell_snapshot',
];

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** antigravity's working directory inside its isolated HOME (TD-476). Holds only an empty `.env`. */
export const AGY_WORKSPACE_DIR = 'workspace';

export interface IsolatedHome {
  /** Absolute path to the clean per-run isolated HOME (pass as env.HOME to the CLI). */
  home: string;
  /**
   * The child's working directory. It is `home` for every harness except antigravity, whose
   * headless mode auto-allows reads INSIDE its workspace (the cwd) and auto-denies them outside it
   * (TD-476, measured). Its cwd is therefore an EMPTY subdirectory, which puts the forwarded
   * credential links under `.gemini/` outside the workspace.
   */
  workspace: string;
  /** Reap the isolated HOME dir (best-effort). MUST be called after the spawn settles. */
  cleanup: () => void;
}

/**
 * Build a clean, brain-owned, per-run isolated HOME for one extraction call:
 * a fresh dir under `extractorScratchRoot()`, the harness's `FORWARD` auth
 * stores symlinked in, then its owned configs written (no MCP, hooks or exec).
 *
 * @param harness which harness (selects the forwarded stores + owned configs)
 * @param env     env to read the scratch-root override from (tests inject a temp dir)
 */
export function makeIsolatedHome(
  harness: ExtractorHarness,
  env: NodeJS.ProcessEnv = process.env,
): IsolatedHome {
  const scratchRoot = extractorScratchRoot(env);
  // <scratchRoot>/<harness>-<uuid>/ — unique per run (concurrency-safe).
  const home = resolve(scratchRoot, `${harness}-${randomUUID().slice(0, 8)}`);
  assertUnderRoot(home, scratchRoot);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });

  symlinkForward(harness, home);
  writeOwnedConfigs(harness, home, homedir());

  return {
    home,
    workspace: harness === 'antigravity' ? resolve(home, AGY_WORKSPACE_DIR) : home,
    cleanup: () => {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* best-effort reap */
      }
    },
  };
}

/**
 * Write the OWNED `~/.gemini/config/mcp_config.json` as `{"mcpServers": {}}`
 * inside the isolated home (agy's MCP file). Ported from
 * `judge.ts:buildJudgeGeminiHome:450-453`.
 */
export function writeEmptyGeminiMcp(home: string): void {
  writeOwned(home, '.gemini/config/mcp_config.json', JSON.stringify({ mcpServers: {} }, null, 2));
}

// ---------------------------------------------------------------------------
// Owned copies
// ---------------------------------------------------------------------------

function writeOwnedConfigs(harness: ExtractorHarness, home: string, real: string): void {
  if (harness === 'claude') ownClaudeJson(home, real);
  if (harness === 'codex') {
    writeOwned(home, '.codex/config.toml', ownCodexToml(readText(resolve(real, '.codex/config.toml'))));
  }
  if (harness === 'antigravity') {
    const settings = readJsonLoose(resolve(real, '.gemini/settings.json'));
    const kept = pickPaths(settings, [['security', 'auth'], ['selectedAuthType'], ['model']]);
    writeOwned(home, '.gemini/settings.json', JSON.stringify(kept));
    writeEmptyGeminiMcp(home);
    // Empty .env files end gemini-cli's first-hit .env search at the first dir.
    writeOwned(home, '.env', '');
    writeOwned(home, '.gemini/.env', '');
    // The agy workspace (TD-476): an empty cwd, so the credential links above sit OUTSIDE it,
    // where headless agy auto-denies reads. Its own empty .env ends the .env search inside it.
    writeOwned(home, `${AGY_WORKSPACE_DIR}/.env`, '');
    const src = resolve(real, '.gemini/antigravity-cli/settings.json');
    if (existsSync(src)) {
      writeOwned(home, '.gemini/antigravity-cli/settings.json', JSON.stringify(pickPaths(readJsonLoose(src), [['model']])));
    }
  }
  if (harness === 'opencode') {
    // The model catalog (BR-110): a real COPY, never a link — `opencode run` deletes
    // a cache dir that has no `version` marker, so the child must own a writable
    // copy rather than mutate the operator's. Each file is skipped independently
    // when the operator lacks it (mirrors `symlinkForward`'s "doesn't have it — skip");
    // the selection preflight (`preflight.ts`, reason `no_model_catalog`) is what
    // refuses a run before it ever reaches this path with the catalog absent.
    copyOwnedFile(home, real, '.cache/opencode/models.json');
    copyOwnedFile(home, real, '.cache/opencode/version');
    // The provider allowlist (Fork 3 = GO, Phase 0 evidence): ONLY oauth providers
    // may load, so a stored api-key entry in the operator's real auth.json can never
    // be reached even though `auth.json` itself stays a readable link (BR-109 Phase
    // 0.3 — opencode refreshes its OAuth token in place). An ALLOWLIST (not a
    // denylist) default-denies a provider the operator adds later. NEVER an empty
    // list — an empty list could read as "all providers enabled" in some versions —
    // so an empty result is SKIPPED (no file written) rather than written empty;
    // preflight's `no_subscription_model` refusal is what keeps a real run from ever
    // reaching this path in that state, and the builder throws defensively too
    // (`spawn-map.ts#buildOpencodeSpawn`).
    // TD-476: a `permission` deny-all block travels in the SAME owned write.
    // `"*":"deny"` is opencode's documented catch-all (its own shipped `explore`
    // agent uses this exact idiom); `external_directory` is a SIBLING key of the
    // same StructWithRest, not something the top-level `"*"` cascades into (the
    // `explore` agent sets it separately even though it already set `"*":"deny"`
    // at the top level) — both are shipped together, never one without the other.
    // Precedence is RESOLVED (not inferred): opencode's `build` agent computes
    // `permission: merge(defaults, fromConfig({question:"allow",plan_enter:"allow"}), fromConfig(config.permission))`,
    // and the evaluator is `rules.flat().findLast(...)` — the LAST matching rule
    // wins, so the config's `permission` (passed last) overrides `build`'s own
    // baked-in allow rules for every tool, including `read`
    // (`plans/td476-evidence/phase0-static.txt`, Orchestrator Phase-0 result #1).
    const providers = oauthProviders(real);
    if (providers.length > 0) {
      writeOwned(
        home,
        '.config/opencode/opencode.json',
        JSON.stringify({
          enabled_providers: providers,
          permission: { '*': 'deny', external_directory: { '*': 'deny' } },
        }),
      );
    }
  }
}

/**
 * Copy an owned file (mode 0o600) at `rel` from the operator's real HOME — never a
 * link. Skips silently when the operator has no source file (mirrors
 * `symlinkForward`). Refuses a destination outside `home`.
 */
function copyOwnedFile(home: string, real: string, rel: string): void {
  const src = resolve(real, rel);
  if (!existsSync(src)) return; // operator doesn't have it — skip
  const dest = resolve(home, rel);
  assertUnderRoot(dest, home);
  mkdirSync(dirname(dest), { recursive: true });
  assertUnderRoot(realpathSync(dirname(dest)), realpathSync(home));
  if (existsSync(dest) || isSymlink(dest)) rmSync(dest, { recursive: true, force: true });
  copyFileSync(src, dest);
  chmodSync(dest, 0o600);
}

/** `.claude.json` minus `mcpServers`, `projects` (per-project MCP) and `primaryApiKey`; no source ⇒ no file. */
function ownClaudeJson(home: string, real: string): void {
  const src = resolve(real, '.claude.json');
  if (!existsSync(src)) return;
  const j = readJsonLoose(src) ?? {};
  for (const k of ['mcpServers', 'projects', 'primaryApiKey']) delete j[k];
  writeOwned(home, '.claude.json', JSON.stringify(j));
}

const TOML_SCALAR = /^\s*([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|true|false|[+-]?[0-9][0-9_.eE+-]*)\s*(#.*)?$/;

/**
 * Root-section lines `<CODEX_ROOT_KEYS> = <one-line scalar>` copied verbatim,
 * everything else dropped, then the `[features]` deny block. Lines inside a
 * multi-line string are never copied and never end the root section.
 */
function ownCodexToml(src: string | null): string {
  const kept: string[] = [];
  let inMulti: string | null = null;
  for (const line of (src ?? '').split(/\r?\n/)) {
    if (inMulti) {
      if (line.split(inMulti).length % 2 === 0) inMulti = null;
      continue;
    }
    if (/^\s*\[/.test(line)) break;
    const m = TOML_SCALAR.exec(line);
    if (m && CODEX_ROOT_KEYS.has(m[1])) {
      kept.push(line);
      continue;
    }
    for (const q of ['"""', "'''"]) {
      if (line.split(q).length % 2 === 0) {
        inMulti = q;
        break;
      }
    }
  }
  return [...kept, '', '[features]', ...CODEX_FEATURE_DENY.map((f) => `${f} = false`), ''].join('\n');
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** Only the listed key paths (whole subtrees) survive. */
function pickPaths(src: Json | null, paths: string[][]): Json {
  const out: Json = {};
  for (const p of paths) {
    let v: unknown = src;
    for (const k of p) v = isObj(v) ? v[k] : undefined;
    if (v === undefined) continue;
    let o = out;
    for (const k of p.slice(0, -1)) o = (o[k] ??= {}) as Json;
    o[p[p.length - 1]] = v;
  }
  return out;
}

function readText(p: string): string | null {
  try {
    return readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

/** JSON, else JSONC with `//` and block comments stripped outside strings, else null (fail-closed). */
function readJsonLoose(p: string): Json | null {
  const text = readText(p);
  if (text === null) return null;
  for (const t of [text, stripJsonComments(text)]) {
    try {
      const j: unknown = JSON.parse(t);
      return isObj(j) ? j : null;
    } catch {
      /* next form */
    }
  }
  return null;
}

function stripJsonComments(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i += 1;
      out += '\n';
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 1;
    } else out += c;
  }
  return out;
}

/**
 * Write an owned file (mode 0o600) at `rel`. Refuses a path outside the home
 * or under a linked ancestor, and replaces any existing entry rather than
 * writing through it.
 */
function writeOwned(home: string, rel: string, text: string): void {
  const dest = resolve(home, rel);
  assertUnderRoot(dest, home);
  mkdirSync(dirname(dest), { recursive: true });
  assertUnderRoot(realpathSync(dirname(dest)), realpathSync(home));
  if (existsSync(dest) || isSymlink(dest)) rmSync(dest, { recursive: true, force: true });
  writeFileSync(dest, text, { mode: 0o600, flag: 'wx' });
}

// ---------------------------------------------------------------------------
// Symlink machinery (ported from home-isolation.ts)
// ---------------------------------------------------------------------------

/** Symlink each `FORWARD` entry at the same relative path; a missing source is skipped. */
function symlinkForward(harness: ExtractorHarness, isolatedHome: string): void {
  const realHome = homedir();
  for (const rel of FORWARD[harness]) {
    const src = resolve(realHome, rel);
    if (!existsSync(src) && !isSymlink(src)) continue; // operator doesn't have it — skip
    const dest = resolve(isolatedHome, rel);
    assertUnderRoot(dest, isolatedHome);
    mkdirSync(dirname(dest), { recursive: true });
    linkInto(src, dest);
  }
}

/**
 * Assert `target` resolves to a path INSIDE `root`. The measure-only guard: every
 * dir this module creates and every symlink LINK path it places must live under
 * the brain-owned scratch root, never escape into the operator's real HOME.
 * Throws (fail-fast) on an escape — a programming bug, not a runtime condition.
 * (Symlink TARGETS legitimately point outside; this guards the LINK paths.)
 * Ported verbatim from `home-isolation.ts:assertUnderRoot`.
 */
export function assertUnderRoot(target: string, root: string): void {
  const r = resolve(root);
  const t = resolve(target);
  const rel = relative(r, t);
  if (rel === '') return; // target IS the root
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `cognition/isolation: refusing to operate on a path outside the brain-owned scratch root.\n` +
        `  root:   ${r}\n  target: ${t}\n` +
        `This is the R-BRAIN-LEAK safety guard — the extractor must never write under the ` +
        `operator's real HOME.`,
    );
  }
}

/** Replace any existing entry at dest with a symlink to src (idempotent). */
function linkInto(src: string, dest: string): void {
  try {
    if (existsSync(dest) || isSymlink(dest)) rmSync(dest, { recursive: true, force: true });
  } catch {
    /* re-symlink below surfaces a real failure */
  }
  symlinkSync(src, dest);
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test/diagnostic helpers
// ---------------------------------------------------------------------------

/** Igris-global / MCP-bearing paths an isolated HOME must NEVER contain. */
export const FORBIDDEN_IGRIS_MARKERS = [
  '.claude/CLAUDE.md',
  '.codex/AGENTS.md',
  '.igris/core',
  '.config/opencode/opencode.json', // present ONLY as our owned enabled_providers allowlist (checked separately, BR-110)
  '.gemini/config/mcp_config.json', // present ONLY as our empty-mcpServers file (checked separately)
  '.gemini/agents',
  '.gemini/extensions',
  '.config/opencode/command',
  '.codex/plugins',
];

/** The operator paths a harness symlinks forward. For the test and the probe. */
export function forwardPathsFor(harness: ExtractorHarness): readonly string[] {
  return FORWARD[harness];
}
