/**
 * Brain Engine v7.1 — Cognition backend: per-harness spawn map.
 *
 * PORTED FROM FR-201 (COPY, don't import — R-PORT-DRIFT):
 *   - the per-harness invocation map (exact headless flags per CLI)
 *       ← `~/StudioProjects/igris-os-eval/b5/judge.ts:330-557`
 *         (`buildCodexSpawn` :345-369, `buildClaudeSpawn` :377-406,
 *          `buildAgySpawn` :526-545, `buildSpawn` dispatch :548-557).
 *   - `subscriptionOnlyEnv` + the empty-MCP / strict-mcp-config / isolated-HOME
 *     wiring are factored into `env.ts` + `isolation.ts` (this file composes them).
 *
 * GENERALIZED: the judge built ONE prompt string; a cognition instance hands the
 * backend a {system, user} pair. Claude takes `--system-prompt` (the perception
 * pattern — instructions on a separate channel from untrusted content); the
 * other harnesses (no system-prompt flag) get the system text prepended to the
 * user text with a clear delimiter. The prompt goes on stdin for claude and
 * gemini (`--prompt ''`, BR-109: gemini-cli 0.45.0 has no `--print`) and as
 * the argv tail for codex, opencode and agy.
 *
 * EVERY spawn runs in the brain-isolated HOME (auth stores symlinked, owned
 * MCP-free configs; see docs/COGNITION.md) plus each CLI's verified MCP switch,
 * so the extraction child can NEVER reach the live brain (R-BRAIN-LEAK).
 *
 * @module engine/components/cognition/backend/spawn-map
 * @author fifty.dev
 */

import type { ExtractorHarness, ExtractorPrompt } from '../types.js';
import { subscriptionOnlyEnv, HARNESS_BIN } from './env.js';
import { makeIsolatedHome, type IsolatedHome } from './isolation.js';

/** How the prompt body reaches the child: piped on stdin, or passed as an argv tail. */
export type PromptDelivery = 'stdin' | 'argv';

/** The argv + spawn options for one extraction invocation. */
export interface ExtractorSpawn {
  /** The CLI binary. */
  bin: string;
  /** The argv (excluding the prompt when delivered via stdin). */
  args: string[];
  /** The child env (subscription-only, HOME redirected to the isolated home). */
  env: NodeJS.ProcessEnv;
  /** The cwd — the isolated home (carries no live brain / Igris-global files). */
  cwd: string;
  /** How the prompt body is delivered to the child. */
  delivery: PromptDelivery;
  /** The full prompt body (system + user composed) — piped or appended per `delivery`. */
  prompt: string;
  /** Reap the isolated HOME after the spawn settles. Caller MUST run it. */
  cleanup: () => void;
}

/** Options threaded into a spawn (timeout is owned by exec, not the spawn). */
export interface SpawnOptions {
  /** Optional model pin (a valid id for the harness). Omitted ⇒ subscription default. */
  model?: string;
  /** agy's own `--print-timeout` in seconds (min 60, default 120). */
  printTimeoutSec?: number;
  /** Env override for the isolated home scratch root (tests inject a temp dir). */
  env?: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// Prompt composition
// ---------------------------------------------------------------------------

/**
 * Compose the {system, user} pair into ONE prompt body for harnesses without a
 * dedicated system-prompt channel. The system text leads, then a delimiter, then
 * the user text. Claude uses `--system-prompt` instead (see buildClaudeSpawn).
 */
export function composePrompt(p: ExtractorPrompt): string {
  return [p.system, '', '---', '', p.user].join('\n');
}

// ---------------------------------------------------------------------------
// Per-harness spawn builders (ported from judge.ts)
// ---------------------------------------------------------------------------

/**
 * Claude (Anthropic). Headless `claude -p` in the brain-isolated HOME with NO
 * MCP and NO tools (`--strict-mcp-config` with no `--mcp-config` ⇒ ZERO MCP
 * servers; empty `--allowedTools` ⇒ no tools). The system prompt is delivered
 * on `--system-prompt` (separate channel from the untrusted user body, which is
 * piped on stdin). Subscription auth (no ANTHROPIC_API_KEY).
 * Ported from `judge.ts:buildClaudeSpawn:377-406`.
 */
function buildClaudeSpawn(prompt: ExtractorPrompt, opts: SpawnOptions, iso: IsolatedHome): ExtractorSpawn {
  const args = [
    '-p',
    '--output-format',
    'json',
    // ZERO MCP + ZERO tools: the extractor grades from the prompt alone and
    // cannot reach the live brain (R-BRAIN-LEAK).
    '--strict-mcp-config',
    '--allowedTools',
    '',
    // Instructions on a separate channel from the untrusted transcript/digest.
    '--system-prompt',
    prompt.system,
  ];
  if (opts.model) args.push('--model', opts.model);
  return {
    bin: HARNESS_BIN.claude,
    args,
    env: subscriptionOnlyEnv(process.env, { HOME: iso.home }),
    cwd: iso.home,
    delivery: 'stdin',
    prompt: prompt.user, // system already on --system-prompt; user piped on stdin
    cleanup: iso.cleanup,
  };
}

/**
 * Codex (OpenAI). `codex exec` in the read-only sandbox; the owned config.toml
 * declares no MCP server, so no `-c mcp_servers.*` override is passed (one on an
 * absent table CREATES a server, BR-108). The composed prompt is the argv tail.
 * Subscription auth (no OPENAI_API_KEY). Ported from `judge.ts:buildCodexSpawn:345-369`.
 */
function buildCodexSpawn(prompt: ExtractorPrompt, opts: SpawnOptions, iso: IsolatedHome): ExtractorSpawn {
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    // Read-only sandbox: no filesystem writes, cannot read brain state on disk.
    '--sandbox',
    'read-only',
  ];
  if (opts.model) args.push('-m', opts.model);
  return {
    bin: HARNESS_BIN.codex,
    args,
    env: subscriptionOnlyEnv(process.env, { HOME: iso.home }),
    cwd: iso.home,
    delivery: 'argv',
    prompt: composePrompt(prompt),
    cleanup: iso.cleanup,
  };
}

/**
 * Gemini (`gemini` CLI) in the brain-isolated Gemini HOME (owned MCP-free
 * settings). `--allowed-mcp-server-names` with one name no server has blocks
 * every server from any settings layer (an EMPTY list blocks nothing). A bare
 * `--prompt` token makes the run headless whatever the TTY, and its empty value
 * leaves stdin as the whole prompt (BR-109). `execHarness` owns the deadline.
 * `--skip-trust`: headless gemini exits 55 in an untrusted cwd. The cwd is the
 * isolated home (owned files + auth links only); trust reads that home's
 * `.gemini/.env` (owned, empty) and project dirs, and opens the MCP start path,
 * where the sentinel still blocks every server name (docs/COGNITION.md).
 */
function buildGeminiSpawn(prompt: ExtractorPrompt, opts: SpawnOptions, iso: IsolatedHome): ExtractorSpawn {
  const args = ['--allowed-mcp-server-names', '__igris_extractor_no_mcp__', '--skip-trust', '--prompt', ''];
  if (opts.model) args.push('--model', opts.model);
  return {
    bin: HARNESS_BIN.gemini,
    args,
    env: subscriptionOnlyEnv(process.env, { HOME: iso.home }),
    cwd: iso.home,
    delivery: 'stdin',
    prompt: composePrompt(prompt),
    cleanup: iso.cleanup,
  };
}

/**
 * Antigravity (`agy`). Headless `--print` in the brain-isolated Gemini HOME;
 * `--print-timeout` pins the deadline; the composed prompt is the argv tail.
 * Ported from `judge.ts:buildAgySpawn:526-545`.
 */
function buildAgySpawn(prompt: ExtractorPrompt, opts: SpawnOptions, iso: IsolatedHome): ExtractorSpawn {
  const printTimeoutSec = Math.max(60, opts.printTimeoutSec ?? 120);
  const args = ['--print-timeout', `${printTimeoutSec}s`, '--print'];
  if (opts.model) args.push('--model', opts.model);
  return {
    bin: HARNESS_BIN.antigravity,
    args,
    env: subscriptionOnlyEnv(process.env, { HOME: iso.home }),
    cwd: iso.home,
    delivery: 'argv',
    prompt: composePrompt(prompt),
    cleanup: iso.cleanup,
  };
}

/**
 * OpenCode. Headless `run` in the brain-isolated HOME. OpenCode reads
 * project-scoped config from the cwd (the empty isolated home); no global
 * `~/.config/opencode` is forwarded, and of its data dir only `auth.json`
 * (BR-109). The composed prompt is the argv tail.
 * Subscription auth.
 * (No FR-201 judge backend for opencode — modelled on the antigravity `--print`
 * shape + opencode's `run` headless verb; the same isolation guarantees apply.)
 */
function buildOpencodeSpawn(prompt: ExtractorPrompt, opts: SpawnOptions, iso: IsolatedHome): ExtractorSpawn {
  const args = ['run'];
  if (opts.model) args.push('--model', opts.model);
  return {
    bin: HARNESS_BIN.opencode,
    args,
    env: subscriptionOnlyEnv(process.env, { HOME: iso.home }),
    cwd: iso.home,
    delivery: 'argv',
    prompt: composePrompt(prompt),
    cleanup: iso.cleanup,
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Build the spawn for one extraction call on `harness`. Creates the
 * brain-isolated HOME (auth symlinked, owned MCP-free configs) and composes the
 * per-harness headless invocation. The caller (`exec.ts:execHarness`) runs it,
 * then MUST call `spawn.cleanup()` to reap the isolated HOME.
 *
 * Ported dispatch ← `judge.ts:buildSpawn:548-557`, extended to gemini/opencode.
 *
 * @param harness the resolved harness
 * @param prompt  the instance's {system, user} prompt
 * @param opts    model pin / print-timeout / env override
 */
export function buildExtractorSpawn(
  harness: ExtractorHarness,
  prompt: ExtractorPrompt,
  opts: SpawnOptions = {},
): ExtractorSpawn {
  const iso = makeIsolatedHome(harness, opts.env ?? process.env);
  switch (harness) {
    case 'claude':
      return buildClaudeSpawn(prompt, opts, iso);
    case 'codex':
      return buildCodexSpawn(prompt, opts, iso);
    case 'gemini':
      return buildGeminiSpawn(prompt, opts, iso);
    case 'antigravity':
      return buildAgySpawn(prompt, opts, iso);
    case 'opencode':
      return buildOpencodeSpawn(prompt, opts, iso);
  }
}
