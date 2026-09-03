/**
 * Brain Engine v7.1 — Cognition backend: the composed run-the-LLM seam.
 *
 * Composes the ported FR-201 pieces into ONE call the engine uses:
 *   resolveBackend (env.ts) → buildExtractorSpawn (spawn-map.ts) →
 *   execHarness (exec.ts) → detectClaudeErrorEnvelope (claude, TD-447) →
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
import { buildExtractorSpawn, type SpawnOptions } from './spawn-map.js';
import { execHarness } from './exec.js';
import { extractText, detectClaudeErrorEnvelope } from './parse-output.js';

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
  authPathsFor,
  hybridDirsFor,
  FORBIDDEN_IGRIS_MARKERS,
  type IsolatedHome,
} from './isolation.js';
export {
  buildExtractorSpawn,
  composePrompt,
  type ExtractorSpawn,
  type SpawnOptions,
  type PromptDelivery,
} from './spawn-map.js';
export { execHarness, type ExecResult, type ExecOptions } from './exec.js';
export { extractText } from './parse-output.js';

/** Why a backend run did not yield usable text. */
export type BackendFailReason =
  | 'timeout'
  | 'non_zero_exit'
  | 'spawn_error'
  | 'empty_response'
  | 'api_error' // TD-447: claude reported an API failure inside its result envelope
  | 'auth_error'; // TD-447: same envelope, 401/403 or an authentication message

/** The result of one isolated LLM call. */
export interface BackendRunResult {
  /** True when the call produced a non-empty text blob. */
  ok: boolean;
  /** The extracted text blob (empty on failure). */
  text: string;
  /** Set when ok===false. */
  fail_reason?: BackendFailReason;
  /** A short diagnostic (stderr tail / exit code) for the lifecycle payload. */
  detail?: string;
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

  const spawn = buildSpawn(harness, prompt, opts);
  try {
    // Delivery shapes the argv + stdin: 'stdin' pipes the prompt body; 'argv'
    // appends it as the final argument (gemini/codex/opencode take the prompt
    // as a positional arg, claude pipes it on stdin).
    const args =
      spawn.delivery === 'argv' ? [...spawn.args, spawn.prompt] : spawn.args;
    const res = await runExec(spawn.bin, args, {
      cwd: spawn.cwd,
      env: spawn.env,
      timeout_ms: timeoutMs,
      stdin: spawn.delivery === 'stdin' ? spawn.prompt : undefined,
    });

    if (res.timed_out) {
      return { ok: false, text: '', fail_reason: 'timeout', detail: `timeout after ${timeoutMs}ms` };
    }
    if (res.code !== 0 && !res.stdout.trim()) {
      return {
        ok: false,
        text: '',
        fail_reason: 'non_zero_exit',
        detail: `exit ${String(res.code)}: ${res.stderr.trim().slice(0, 200)}`,
      };
    }
    // TD-447: claude reports API/auth failures INSIDE the result envelope (exit 1
    // with non-empty stdout), which extractText would otherwise lift as the answer.
    if (harness === 'claude') {
      const envelope = detectClaudeErrorEnvelope(res.stdout);
      if (envelope) return { ok: false, text: '', fail_reason: envelope.kind, detail: envelope.detail };
    }
    const text = extractText(harness, res.stdout);
    if (!text.trim()) {
      return { ok: false, text: '', fail_reason: 'empty_response', detail: 'no text in stdout' };
    }
    return { ok: true, text };
  } catch (err) {
    return {
      ok: false,
      text: '',
      fail_reason: 'spawn_error',
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  } finally {
    spawn.cleanup();
  }
}
