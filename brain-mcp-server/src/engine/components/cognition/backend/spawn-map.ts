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
 * user text with a clear delimiter. The `prompt` passed via argv/stdin is built
 * by the caller (`exec` pipes it on stdin for claude/codex per the perception
 * extractor, or via argv for the gemini-family `--print`).
 *
 * EVERY spawn runs in the brain-isolated HOME (empty mcpServers, auth symlinked
 * forward, --strict-mcp-config / read-only sandbox) so the extraction child can
 * NEVER reach the live brain (R-BRAIN-LEAK).
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
  /** Soft timeout in seconds for harnesses with their own print-timeout (gemini family). */
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
 * Codex (OpenAI). `codex exec` read-only with NO MCP/tools: the read-only
 * sandbox + pointing the brain MCP at `/usr/bin/false` so it cannot reach the
 * eval/live DB. The composed prompt is the argv tail. Subscription auth (no
 * OPENAI_API_KEY). Ported from `judge.ts:buildCodexSpawn:345-369`.
 */
function buildCodexSpawn(prompt: ExtractorPrompt, opts: SpawnOptions, iso: IsolatedHome): ExtractorSpawn {
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    // Read-only sandbox: no filesystem writes, cannot read brain state on disk.
    '--sandbox',
    'read-only',
    // No MCP: point the brain at a no-op so it cannot reach the live DB.
    '-c',
    `mcp_servers.igris-brain.command="/usr/bin/false"`,
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
 * Gemini-family (gemini / antigravity → the `gemini`/`agy` CLI). Headless
 * `--print` in the brain-isolated Gemini HOME whose `config/mcp_config.json` is
 * OWNED and EMPTY (`{"mcpServers": {}}` — written by isolation.ts), so the child
 * has ZERO brain/tool access. `--print-timeout` pins the deadline. The composed
 * prompt is the argv tail. Subscription auth.
 * Ported from `judge.ts:buildAgySpawn:526-545` (generalized to gemini too).
 */
function buildGeminiFamilySpawn(
  harness: 'gemini' | 'antigravity',
  prompt: ExtractorPrompt,
  opts: SpawnOptions,
  iso: IsolatedHome,
): ExtractorSpawn {
  const printTimeoutSec = Math.max(60, opts.printTimeoutSec ?? 120);
  const args = ['--print-timeout', `${printTimeoutSec}s`, '--print'];
  if (opts.model) args.push('--model', opts.model);
  return {
    bin: HARNESS_BIN[harness],
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
 * project-scoped config from the cwd (the empty isolated home) and global config
 * from `~/.config/opencode` (symlinked forward minus the OS-context files). The
 * composed prompt is the argv tail. Subscription auth.
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
 * brain-isolated HOME (empty mcpServers, auth symlinked) and composes the
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
      return buildGeminiFamilySpawn('gemini', prompt, opts, iso);
    case 'antigravity':
      return buildGeminiFamilySpawn('antigravity', prompt, opts, iso);
    case 'opencode':
      return buildOpencodeSpawn(prompt, opts, iso);
  }
}
