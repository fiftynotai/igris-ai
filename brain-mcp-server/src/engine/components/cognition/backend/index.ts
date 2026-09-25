/**
 * Brain Engine v7.1 — Cognition backend: the composed run-the-LLM seam.
 *
 * Composes the ported FR-201 pieces into ONE call the engine uses:
 *   resolveBackend (env.ts, + preflightHarness at selection, BR-109) →
 *   buildExtractorSpawn (spawn-map.ts) → execHarness (exec.ts) →
 *   classifyExecResult: detectHarnessFailure → the unknown-argument rule →
 *   extractText (parse-output.ts) → cleanup.
 *
 * The engine owns the GATES (cold-start, budget, timeout-as-config, lifecycle);
 * this backend owns "run the isolated LLM call on the resolved harness and hand
 * back a text blob (or a typed failure)". It is the harness-agnostic seam the
 * three eventual consumers (perception, subconscious, the FR-201 judge) ride.
 *
 * @module engine/components/cognition/backend
 * @author fifty.dev
 */

import type { ExtractorHarness, ExtractorPrompt } from '../types.js';
import { buildExtractorSpawn, type ExtractorSpawn, type SpawnOptions } from './spawn-map.js';
import { execHarness, type ExecResult } from './exec.js';
import { extractText, detectHarnessFailure, detectUnknownArgument, scrubSecrets } from './parse-output.js';

export {
  subscriptionOnlyEnv,
  isHarnessCliAvailable,
  resetHarnessCliProbeCache,
  resolveHarness,
  resolveBackend,
  HARNESS_BIN,
  type LlmExtractorGlobalConfig,
} from './env.js';
export {
  makeIsolatedHome,
  assertUnderRoot,
  writeEmptyGeminiMcp,
  extractorScratchRoot,
  forwardPathsFor,
  FORBIDDEN_IGRIS_MARKERS,
  AGY_WORKSPACE_DIR,
  type IsolatedHome,
} from './isolation.js';
export {
  resolveOpencodeModel,
  oauthProviders,
  type OpencodeModelResolution,
  type OpencodeModelUsable,
  type OpencodeModelRefused,
} from './opencode-model.js';
export {
  buildExtractorSpawn,
  composePrompt,
  type ExtractorSpawn,
  type SpawnOptions,
  type PromptDelivery,
} from './spawn-map.js';
export { execHarness, type ExecResult, type ExecOptions } from './exec.js';
export {
  extractText,
  classifyCliError,
  detectHarnessFailure,
  detectUnknownArgument,
  scrubSecrets,
  stripAnsi,
  type CliFailure,
} from './parse-output.js';
export { preflightHarness, resetPreflightCache, HELP_ARGV, flagsInHelp } from './preflight.js';

/** Why a backend run did not yield usable text. */
export type BackendFailReason =
  | 'timeout'
  | 'non_zero_exit'
  | 'spawn_error'
  | 'empty_response'
  | 'api_error' // TD-447 claude envelope; BR-109 any detected CLI error envelope
  | 'auth_error' // 401/403 or an authentication message
  | 'model_unsupported' // BR-109: the CLI or its server does not serve the model
  | 'cli_incompatible' // BR-109: the CLI rejected the invocation (unknown flag)
  | 'account_unsupported'; // BR-109: the vendor refuses this account's tier for this CLI.
  // TD-474: kept for recorded runs — gemini's classifier (its only producer) is
  // retired, so no current harness produces this value; see `HarnessRefusalReason`
  // in `../types.js` for the DISTINCT, selection-time `harness_retired` reason.

/** The result of one isolated LLM call. */
export interface BackendRunResult {
  /** True when the call produced a non-empty text blob. */
  ok: boolean;
  /** The extracted text blob (empty on failure). */
  text: string;
  /** Set when ok===false. */
  fail_reason?: BackendFailReason;
  /** A short diagnostic for the lifecycle payload, secret-shape scrubbed (BR-109 D2). */
  detail?: string;
}

const failed = (fail_reason: BackendFailReason, detail: string): BackendRunResult => ({
  ok: false,
  text: '',
  fail_reason,
  detail: scrubSecrets(detail),
});

/**
 * Turn one exec result into a backend result: timeout → the harness's own failure
 * channel → an unknown-argument rejection → `non_zero_exit` → text (else
 * `empty_response`). Every `detail` is scrubbed. Shared with the TD-472 probe.
 */
export function classifyExecResult(harness: ExtractorHarness, res: ExecResult, timeoutMs: number): BackendRunResult {
  if (res.timed_out) return failed('timeout', `timeout after ${timeoutMs}ms`);
  const named = detectHarnessFailure(harness, res);
  if (named) return failed(named.kind, named.detail);
  const rejected = detectUnknownArgument(res);
  if (rejected !== null) return failed('cli_incompatible', rejected);
  if (res.code !== 0 && !res.stdout.trim()) {
    return failed('non_zero_exit', `exit ${String(res.code)}: ${res.stderr.trim().slice(0, 200)}`);
  }
  const text = extractText(harness, res.stdout);
  return text.trim() ? { ok: true, text } : failed('empty_response', 'no text in stdout');
}

/**
 * Run one isolated extraction call on `harness` with `prompt`. Builds the
 * brain-isolated spawn, executes it with `timeoutMs`, parses the harness's
 * output to a text blob, and ALWAYS reaps the isolated HOME (the `cleanup` runs
 * in `finally`). Never throws — failures surface as `{ ok:false, fail_reason }`.
 *
 * The `runExec`/`buildSpawn` seams are injectable so the engine's unit tests can
 * exercise timeout / non-zero-exit / parse paths WITHOUT a real CLI.
 *
 * @param harness   the resolved harness
 * @param prompt    the instance's {system, user} prompt
 * @param timeoutMs the wall-clock budget
 * @param opts      spawn options + injectable seams
 */
export async function runBackend(
  harness: ExtractorHarness,
  prompt: ExtractorPrompt,
  timeoutMs: number,
  opts: SpawnOptions & {
    buildSpawn?: typeof buildExtractorSpawn;
    runExec?: typeof execHarness;
  } = {},
): Promise<BackendRunResult> {
  const buildSpawn = opts.buildSpawn ?? buildExtractorSpawn;
  const runExec = opts.runExec ?? execHarness;

  // Built outside the exec `try` (its `finally` needs the spawn), but a builder that throws
  // must still honour "never throws": buildExtractorSpawn has already reaped its HOME (BR-110).
  let spawn: ExtractorSpawn;
  try {
    spawn = buildSpawn(harness, prompt, opts);
  } catch (err) {
    return failed('spawn_error', err instanceof Error ? err.message.slice(0, 200) : String(err));
  }
  try {
    // Delivery shapes the argv + stdin: 'stdin' pipes the prompt body (claude);
    // 'argv' appends it as the final argument (codex, opencode, agy).
    const args =
      spawn.delivery === 'argv' ? [...spawn.args, spawn.prompt] : spawn.args;
    const res = await runExec(spawn.bin, args, {
      cwd: spawn.cwd,
      env: spawn.env,
      timeout_ms: timeoutMs,
      stdin: spawn.delivery === 'stdin' ? spawn.prompt : undefined,
    });
    return classifyExecResult(harness, res, timeoutMs);
  } catch (err) {
    return failed('spawn_error', err instanceof Error ? err.message.slice(0, 200) : String(err));
  } finally {
    spawn.cleanup();
  }
}
