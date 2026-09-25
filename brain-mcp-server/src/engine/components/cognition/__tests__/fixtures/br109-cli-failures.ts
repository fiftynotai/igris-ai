/**
 * BR-109 — each extractor CLI's MEASURED failure bytes, for stub CLIs that replay them
 * through the real `runBackend` (test_standards: "fixtures from reality", TD-447).
 *
 * Provenance (this machine, 2026-09-25; evidence under
 * `~/.igris/projects/igris-ai/plans/br109-evidence/`):
 *   - opencode 1.14.22: `opencode-diagnosis.json` — the production spawn, exit 0, stdout 0 B.
 *   - codex-cli 0.135.0: `codex-400-events.jsonl` + `codex-400-provenance.txt` — ONE production
 *     spawn, exit 1, stdout 601 B; stored redacted (only the thread UUID differed).
 *   - gemini-cli 0.45.0: `phase0-gemini-offline.{txt,jsonl}` + `phase0-gemini-head-argv-stderr.txt`
 *     — offline, an empty scratch HOME: the HEAD argv (exit 1) and the BR-109 argv (exit 41);
 *     `gemini-diagnosis.json` — LIVE in the BR-108 isolated HOME: exit 55, the tier refusal
 *     then the folder-trust refusal on stderr (H15).
 * Two substitutions, both environment identifiers the classifiers never read: codex's
 * `thread_id` is a fixture UUID of the same length, and gemini's scratch-HOME path is
 * `/tmp/fx-home`. SYNTHETIC shapes (no live capture) say so where they are defined.
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
// gemini-cli 0.45.0 (measured offline)
// ---------------------------------------------------------------------------

/** The yargs rejection line of the HEAD argv (`--print-timeout 120s --print`). */
export const GEMINI_UNKNOWN_ARGS_LINE = 'Unknown arguments: print-timeout, printTimeout, print';

/** H8: the HEAD argv — exit 1, the rejection line, then yargs' help (the first 12 of 46 lines). */
export const GEMINI_UNKNOWN_ARGS: CliOutcome = {
  stdout: '',
  stderr: [
    GEMINI_UNKNOWN_ARGS_LINE,
    'Usage: gemini [options] [command]',
    '',
    'Gemini CLI - Defaults to interactive mode. Use -p/--prompt for non-interactive (headless) mode.',
    '',
    'Commands:',
    '  gemini mcp                   Manage MCP servers',
    '  gemini extensions <command>  Manage Gemini CLI extensions.  [aliases: extension]',
    '  gemini skills <command>      Manage agent skills.  [aliases: skill]',
    '  gemini hooks <command>       Manage Gemini CLI hooks.  [aliases: hook]',
    '  gemini gemma                 Manage local Gemma model routing',
    '  gemini [query..]             Launch Gemini CLI  [default]',
    '',
    '',
  ].join('\n'),
  code: 1,
};

/** The exit-41 message (validateNonInteractiveAuth, gemini-ORQHD633.js:15420) with the HOME path substituted. */
export const GEMINI_AUTH_41_LINE =
  'Please set an Auth method in your /tmp/fx-home/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA';

/** H7: the BR-109 argv with no auth method configured — exit 41 (FATAL_AUTHENTICATION_ERROR). */
export const GEMINI_AUTH_41: CliOutcome = { stdout: '', stderr: `${GEMINI_AUTH_41_LINE}\n`, code: 41 };

/** H9: gemini's text-mode answer. SYNTHETIC (the success shape). */
export const GEMINI_OK: CliOutcome = { stdout: 'OK\n', stderr: '', code: 0 };

// ---------------------------------------------------------------------------
// gemini-cli 0.45.0, LIVE in the BR-108 isolated HOME (measured 2026-09-25,
// `br109-evidence/gemini-diagnosis.json` + `probe-gemini-20260925T072118Z.jsonl`)
// ---------------------------------------------------------------------------

/**
 * The vendor's tier refusal: the `reasonMessage` of the `IneligibleTierError` gemini's
 * first auth pass logs (`Error authenticating:`, gemini-ORQHD633.js:16057; the error class
 * is chunk-6T7N6JF2.js:307307). Verbatim.
 */
export const GEMINI_TIER_REASON_MESSAGE =
  'This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google';

/** The folder-trust refusal (`FatalUntrustedWorkspaceError`, exit 55, gemini-ORQHD633.js:9876). Verbatim. */
export const GEMINI_UNTRUSTED_LINE =
  'Gemini CLI is not running in a trusted directory. To proceed, either use `--skip-trust`, set the `GEMINI_CLI_TRUST_WORKSPACE=true` environment variable, or trust this directory in interactive mode. For more details, see https://geminicli.com/docs/cli/trusted-folders/#headless-and-automated-environments';

/** The `util.inspect` body of the logged error, as the diagnosis kept it (it starts mid stack frame). */
const GEMINI_TIER_INSPECT_TAIL = [
  's/task_queues:103:5) {',
  '  ineligibleTiers: [',
  '    {',
  "      reasonCode: 'UNSUPPORTED_CLIENT',",
  `      reasonMessage: '${GEMINI_TIER_REASON_MESSAGE}',`,
  "      tierId: 'free-tier',",
  "      tierName: 'Gemini Code Assist for individuals'",
  '    }',
  '  ]',
  '}',
].join('\n');

/** gemini.js's top-level catch prints a `FatalError` in red: ESC[31m … ESC[0m. */
const red = (s: string): string => `\u001b[31m${s}\u001b[0m`;

/**
 * H15: MEASURED — the BR-109 argv without `--skip-trust`, exit 55, stdout 0 B. The stderr is
 * the last 700 of its 1232 bytes, exactly as the redacted diagnosis kept them (the head —
 * `Error authenticating: IneligibleTierError: …` and stack frames naming install paths —
 * was not kept). No scratch path survives in the kept tail, so nothing is substituted.
 */
export const GEMINI_TIER_THEN_UNTRUSTED_55: CliOutcome = {
  stdout: '',
  stderr: `${GEMINI_TIER_INSPECT_TAIL}\n${red(GEMINI_UNTRUSTED_LINE)}\n`,
  code: 55,
};

/**
 * H16: the trust refusal ALONE, exit 55 — what an account with an eligible tier gets under
 * the argv without `--skip-trust`. DERIVED from H15's measured bytes (its trust line, verbatim).
 */
export const GEMINI_UNTRUSTED_55: CliOutcome = { stdout: '', stderr: `${red(GEMINI_UNTRUSTED_LINE)}\n`, code: 55 };

/**
 * H17: the PREDICTED shape with `--skip-trust` — SYNTHETIC, source-derived, not measured. The
 * trust gate passes, the second `refreshAuth` (gemini-ORQHD633.js:16282) rethrows the
 * non-Fatal `IneligibleTierError`, and gemini.js's top-level catch (:152-157) writes
 * `An unexpected critical error occurred:` + the stack and exits 1. Install paths are `/fx`.
 */
export const GEMINI_TIER_AFTER_SKIP_TRUST_1: CliOutcome = {
  stdout: '',
  stderr: [
    `Error authenticating: IneligibleTierError: ${GEMINI_TIER_REASON_MESSAGE}`,
    '    at throwIneligibleOrProjectIdError (file:///fx/bundle/chunk-6T7N6JF2.js:307446:11)',
    `    at process.processTicksAndRejections (node:internal/proces${GEMINI_TIER_INSPECT_TAIL}`,
    `An unexpected critical error occurred:IneligibleTierError: ${GEMINI_TIER_REASON_MESSAGE}`,
    '    at throwIneligibleOrProjectIdError (file:///fx/bundle/chunk-6T7N6JF2.js:307446:11)',
    '',
  ].join('\n'),
  code: 1,
};

/**
 * H18 false-positive rows (SYNTHETIC): the trust and tier words where they are NOT a failure.
 * gemini prints a home-directory startup warning on stderr on every isolated run (the cwd is
 * HOME, gemini-ORQHD633.js `homeDirectoryCheck`), so an answered run with noisy stderr is real.
 */
export const GEMINI_FP_ANSWER_MENTIONS_TRUST: CliOutcome = {
  stdout: `The note says: ${GEMINI_UNTRUSTED_LINE} It also lists ineligibleTiers with reasonCode UNSUPPORTED_CLIENT.\n`,
  stderr: '',
  code: 0,
};
export const GEMINI_FP_ANSWER_WITH_STDERR_NOISE: CliOutcome = {
  stdout: 'OK\n',
  stderr: `${GEMINI_TIER_INSPECT_TAIL}\n${GEMINI_UNTRUSTED_LINE}\n`,
  code: 0,
};
export const GEMINI_FP_OTHER_TRUST_WORDS: CliOutcome = {
  stdout: '',
  stderr: 'Error: could not read the trusted folders file\n',
  code: 1,
};

/**
 * The gemini-cli 0.45.0 options the `$0 [query..]` command accepts under `.strict()` — the
 * SECOND SPELLING P4 checks the builder's argv against. Long names + aliases, read from
 * `/opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/gemini-ORQHD633.js`: the global
 * `--debug`/`-d` (:7964), the command's options (:8045-8208; `--skip-trust` is a boolean at
 * :8064, so it takes no value), `.version()`/`-v`, `.help()`/`-h` (:8209). The hidden internal
 * `--isCommand` is left out on purpose.
 */
export const GEMINI_045_OPTIONS: readonly string[] = [
  '--debug', '-d',
  '--model', '-m',
  '--prompt', '-p',
  '--prompt-interactive', '-i',
  '--skip-trust',
  '--worktree', '-w',
  '--sandbox', '-s',
  '--yolo', '-y',
  '--approval-mode',
  '--policy',
  '--admin-policy',
  '--acp',
  '--experimental-acp',
  '--allowed-mcp-server-names',
  '--allowed-tools',
  '--extensions', '-e',
  '--list-extensions', '-l',
  '--resume', '-r',
  '--session-file',
  '--session-id',
  '--list-sessions',
  '--delete-session',
  '--include-directories',
  '--screen-reader',
  '--output-format', '-o',
  '--fake-responses',
  '--fake-responses-non-strict',
  '--record-responses',
  '--raw-output',
  '--accept-raw-output-risk',
  '--version', '-v',
  '--help', '-h',
];

// ---------------------------------------------------------------------------
// claude (synthetic: commander's unknown-option shape)
// ---------------------------------------------------------------------------

/** H13: an option the installed claude does not know. SYNTHETIC — commander's `error: unknown option` line. */
export const CLAUDE_UNKNOWN_OPTION: CliOutcome = { stdout: '', stderr: "error: unknown option '--fx'\n", code: 1 };
