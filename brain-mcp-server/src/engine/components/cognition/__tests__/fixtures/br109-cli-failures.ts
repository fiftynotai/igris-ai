/**
 * BR-109 — each extractor CLI's MEASURED failure bytes, for stub CLIs that replay them
 * through the real `runBackend` (test_standards: "fixtures from reality", TD-447).
 *
 * Provenance (this machine, 2026-09-25; evidence under
 * `~/.igris/projects/igris-ai/plans/br109-evidence/`):
 *   - opencode 1.14.22: `opencode-diagnosis.json` — the production spawn, exit 0, stdout 0 B.
 *   - codex-cli 0.135.0: `codex-400-events.jsonl` + `codex-400-provenance.txt` — ONE production
 *     spawn, exit 1, stdout 601 B; stored redacted (only the thread UUID differed).
 * TD-474: the gemini-cli 0.45.0 measured bytes (`phase0-gemini-offline.{txt,jsonl}`,
 * `phase0-gemini-head-argv-stderr.txt`, `gemini-diagnosis.json`) that justified retiring
 * gemini from the extractor role are RETIRED from this fixture file along with the
 * classifier they pinned (`detectGeminiFailure`) — the evidence still lives under
 * `br109-evidence/` and is cited by `docs/COGNITION.md`'s "gemini — retired from the
 * extractor" subsection, not restated here.
 * One substitution, an environment identifier the classifiers never read: codex's
 * `thread_id` is a fixture UUID of the same length. SYNTHETIC shapes (no live capture)
 * say so where they are defined.
 *
 * Excluded from compile (`src/**\/__tests__/**`), so it costs 0 packed bytes. No value here
 * is credential-shaped except H11's deliberate `sk-` / JWT-like placeholders, which are
 * `fx` runs no provider issues (gitleaks-checked).
 *
 * @module engine/components/cognition/__tests__/fixtures/br109-cli-failures
 */

/** A captured CLI outcome a stub replays: its stdout, stderr and exit code. */
export interface CliOutcome {
  stdout: string;
  stderr: string;
  code: number;
}

// ---------------------------------------------------------------------------
// opencode 1.14.22 (measured)
// ---------------------------------------------------------------------------

/** The run header opencode prints to stderr before any answer (ANSI included). */
export const OPENCODE_HEADER = '\u001b[0m\n> build · gpt-5.4-mini-fast\n\u001b[0m\n';

/** H1: `opencode run` with a stale OpenAI OAuth login — exit 0, empty stdout, the error on stderr. */
export const OPENCODE_TOKEN_REFRESH_401: CliOutcome = {
  stdout: '',
  stderr: `${OPENCODE_HEADER}\u001b[91m\u001b[1mError: \u001b[0mToken refresh failed: 401\n`,
  code: 0,
};

/** H2 control: the same header, an answer on stdout, no `Error:` line. SYNTHETIC (the success shape). */
export const OPENCODE_OK: CliOutcome = { stdout: 'OK\n', stderr: OPENCODE_HEADER, code: 0 };

/** H3: a model the provider does not serve. SYNTHETIC — H1's ANSI shape with the plan's message. */
export const OPENCODE_MODEL_NOT_FOUND: CliOutcome = {
  stdout: '',
  stderr: `${OPENCODE_HEADER}\u001b[91m\u001b[1mError: \u001b[0mModel not found: openai/fx\n`,
  code: 0,
};

// ---------------------------------------------------------------------------
// codex-cli 0.135.0 (measured)
// ---------------------------------------------------------------------------

/** The server's model-version message, inside both the `error` and the `turn.failed` event. */
export const CODEX_400_MESSAGE =
  "The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.";

const codexInner = (status: number, type: string, message: string): string =>
  JSON.stringify({ type: 'error', status, error: { type, message } });

/** H4: `codex exec --json` answering the 400 — four JSONL events, exit 1 (601 B, as measured). */
export const CODEX_MODEL_400: CliOutcome = {
  stdout: [
    JSON.stringify({ type: 'thread.started', thread_id: '00000000-0000-4000-8000-000000000000' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'error', message: codexInner(400, 'invalid_request_error', CODEX_400_MESSAGE) }),
    JSON.stringify({ type: 'turn.failed', error: { message: codexInner(400, 'invalid_request_error', CODEX_400_MESSAGE) } }),
    '',
  ].join('\n'),
  stderr: 'codex verbose log (212,862 B live; not kept)\n',
  code: 1,
};

/** H5: a `turn.failed` whose inner error is a 401. SYNTHETIC — H4's layout with an auth status. */
export const CODEX_TURN_FAILED_401: CliOutcome = {
  stdout: [
    JSON.stringify({ type: 'thread.started', thread_id: '00000000-0000-4000-8000-000000000000' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'turn.failed', error: { message: codexInner(401, 'invalid_request_error', 'Your session has expired.') } }),
    '',
  ].join('\n'),
  stderr: '',
  code: 1,
};

/**
 * H6: a transient `error` event, then the answer. SYNTHETIC and RECALLED, not measured: the
 * `item.completed` / `agent_message` success shape is the plan's recalled codex stream (the live
 * PASS confirms it, BR-109 Phase 9.4). A reasoning item rides along so D1a's drop is visible.
 */
export const CODEX_RETRY_THEN_OK: CliOutcome = {
  stdout: [
    JSON.stringify({ type: 'thread.started', thread_id: '00000000-0000-4000-8000-000000000000' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'thinking' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'OK' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    '',
  ].join('\n'),
  stderr: '',
  code: 0,
};

/** H11: secret-shaped substrings inside an error message. SYNTHETIC placeholders (`fx` runs). */
export const H11_SK = 'sk-fxfxfxfxfxfxfxfx';
export const H11_JWT = 'eyJfxfxfxfxfx.fx.fx';
export const CODEX_SECRET_IN_MESSAGE: CliOutcome = {
  stdout: [
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'turn.failed',
      error: { message: codexInner(500, 'server_error', `upstream rejected key ${H11_SK} with token ${H11_JWT}`) },
    }),
    '',
  ].join('\n'),
  stderr: '',
  code: 1,
};

// ---------------------------------------------------------------------------
// print-mode harnesses (SYNTHETIC success shape; TD-474: gemini's live/offline
// classifier fixtures are deleted — this const is kept for H10's antigravity
// control, the sole surviving headless-`--print` harness)
// ---------------------------------------------------------------------------

/** H9→H10: a headless-print harness's text-mode answer. SYNTHETIC (the success shape). Still needed by H10's antigravity control. */
export const PRINT_OK: CliOutcome = { stdout: 'OK\n', stderr: '', code: 0 };

// ---------------------------------------------------------------------------
// claude (synthetic: commander's unknown-option shape)
// ---------------------------------------------------------------------------

/** H13: an option the installed claude does not know. SYNTHETIC — commander's `error: unknown option` line. */
export const CLAUDE_UNKNOWN_OPTION: CliOutcome = { stdout: '', stderr: "error: unknown option '--fx'\n", code: 1 };
