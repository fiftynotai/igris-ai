/**
 * TD-066 — Detached perception extraction CLI.
 *
 * Standalone runner that performs perception extraction over a transcript file
 * outside the MCP server process. Spawned (DETACHED) by
 * `perception_extract_and_persist.sh` from session_end / pre_compact hooks so
 * the parent Claude Code session exits immediately while LLM extraction runs
 * in the background.
 *
 * Pipeline:
 *   1. Parse CLI flags.
 *   2. Boot the brain engine (`bootEngine`, BR-060) so sqlite-vec, migrations,
 *      and component lifecycle are fully owned by the engine. Honors the
 *      `IGRIS_DB_PATH` override.
 *   3. Pre-flight: confirm `learnings` table exists.
 *   4. Read transcript file. If absent or empty, exit 0 silently.
 *   5. Resolve perception config + LLM extractor (3-layer chain).
 *   6. Call `runPerception` directly (no MCP roundtrip).
 *   7. On success, truncate the project's perception_inbox.jsonl atomically
 *      so legacy callers don't accumulate stale rows.
 *   8. FR-120: Inline brain-push phase. Resolves `~/.igris/config.json`
 *      remote_brain and invokes `handleBrainPush` against the same booted
 *      engine connection so this machine's delta reaches the VPS sync hub
 *      before /rest. Replaces the deleted `brain_push_cli.ts` +
 *      `brain_push_async.sh` fan-out (L-72 producer-consumer split — both
 *      halves of the async chain now share one detached process). Push
 *      failures are non-fatal: the rows are auto-queued in `sync_queue` by
 *      handleBrainPush and the CLI still exits 0.
 *   9. Dispose the embedding pipeline + `engine.shutdown()` in a `finally`
 *      block — releases the @huggingface/transformers ONNX worker pool and
 *      sqlite native resources BEFORE V8 teardown. Caller routes through
 *      `process.exitCode = code` (NOT `process.exit(code)`) so the event
 *      loop drains naturally and worker threads join cleanly. Without this
 *      ordering the synchronous exit path races with the worker pool's
 *      mutex and aborts with `mutex lock failed: Invalid argument`
 *      (libc++abi SIGABRT, exit 134). See BR-060.
 *  10. Exit 0 on success or empty transcript; exit 1 only on hard error
 *      (DB unreachable, malformed CLI args). Hooks must never block.
 *
 * Usage:
 *   npx tsx scripts/perception_extract_cli.ts \
 *     --project igris-ai \
 *     --transcript-path /path/to/transcript.jsonl
 *
 *   Optional flags:
 *     --brief-id BR-123        Brief context for the prompt
 *     --inbox-path PATH        Override inbox path (default: ~/.igris/projects/{slug}/session/perception_inbox.jsonl)
 *     --db PATH                Override IGRIS_DB_PATH (test override)
 *     --source LABEL           Trigger source label (default: 'detached')
 *
 * Concurrency note: WAL-mode SQLite + 5s busy timeout makes parallel runs
 * safe. The inbox truncation uses atomic rename via tempfile.
 *
 * @module scripts/perception_extract_cli
 * @author fifty.dev
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDb } from '../src/db.js';
import { bootEngine } from '../src/engine/index.js';
import type { Engine } from '../src/engine/index.js';
import {
  resolvePerceptionConfig,
  resolveLlmExtractorGlobalConfig,
} from '../src/engine/components/perception/index.js';
import { selectLlmExtractor } from '../src/engine/components/perception/extractors/llm_via_claude_code.js';
import { runPerception } from '../src/engine/components/perception/runner.js';
import { parseTranscript } from '../src/engine/components/perception/handlers.js';
import { writePerceptionEvent } from '../src/engine/components/perception/events.js';
import { disposeEmbeddingPipeline } from '../src/utils/embeddings.js';
import { handleBrainPush } from '../src/tools/sync.js';
import type { LlmExtractor } from '../src/engine/components/perception/extractors/llm_via_claude_code.js';
import type { PerceptionExtractorConfig } from '../src/engine/components/perception/types.js';

// ---------------------------------------------------------------------------
// Usage block — printed on --help / -h. Kept in sync with the file header.
// ---------------------------------------------------------------------------

export const USAGE = `perception_extract_cli — TD-066 detached perception extraction CLI

Reads a transcript file, runs the LLM perception extractor, persists pending
candidate learnings to the brain DB, and truncates the project's perception
inbox on success. Spawned by the session_end / pre_compact hooks via the
perception_extract_and_persist.sh wrapper. Exits 0 on success or empty
transcript; exits 1 only on hard error (DB unreachable, malformed args).

Usage:
  npx tsx scripts/perception_extract_cli.ts \\
    --project <slug> \\
    --transcript-path <path> \\
    [--brief-id <id>] [--inbox-path <path>] [--db <path>] [--source <label>] \\
    [--log-path <path>] [--no-log]

Required flags:
  --project <slug>            Project slug (e.g. igris-ai)
  --transcript-path <path>    Absolute path to the transcript file

Optional flags:
  --brief-id <id>             Brief context for the prompt (e.g. TD-066)
  --inbox-path <path>         Override inbox path (default: ~/.igris/projects/{slug}/session/perception_inbox.jsonl)
  --db <path>                 Override IGRIS_DB_PATH (test override)
  --source <label>            Trigger source label (default: detached)
  --log-path <path>           Override tee log path (default: ~/.igris/projects/{slug}/session/perception_extract.log)
  --no-log                    Disable tee-to-log entirely (TD-077)
  --help, -h                  Print this help and exit 0

Examples:
  npx tsx scripts/perception_extract_cli.ts --project igris-ai \\
    --transcript-path /tmp/session.jsonl --source session_end

  npx tsx scripts/perception_extract_cli.ts --help
`;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

/**
 * Parsed CLI shape. Exported for unit tests so the parser is exercised
 * directly without spawning a subprocess.
 */
export interface CliArgs {
  /** Project slug. Required (unless `help` is true). */
  project: string;
  /** Absolute path to the transcript file. Required (unless `help` is true). */
  transcriptPath: string;
  /** Optional brief id passed through to extractor context. */
  briefId: string | undefined;
  /** Optional override for the inbox path that gets truncated post-success. */
  inboxPath: string | undefined;
  /** Optional `IGRIS_DB_PATH` override. */
  dbPathOverride: string | undefined;
  /** Trigger source label (default 'detached'). */
  source: string;
  /**
   * TD-077: Override the tee log path. When undefined and `noLog=false`,
   * defaults to `~/.igris/projects/{slug}/session/perception_extract.log`.
   */
  logPath: string | undefined;
  /**
   * TD-077: When true, suppress the tee-to-log behaviour entirely. The CLI
   * still writes to stdout/stderr as usual; only the log artifact is omitted.
   * Used by the test suite to avoid writing junk to `~/.igris/`.
   */
  noLog: boolean;
  /** Set when `--help` / `-h` is in argv. Caller should print USAGE and exit 0. */
  help: boolean;
}

/**
 * Parse process.argv (or any string array) into a CliArgs struct.
 *
 * If `--help` or `-h` is present, returns a sentinel CliArgs with
 * `help: true` and empty required fields — required-flag validation is
 * skipped so users can ask for help without supplying anything else.
 *
 * Throws on missing required flags (`--project`, `--transcript-path`) or
 * when a flag that takes a value is followed by another flag.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  // --help / -h short-circuit. Returned BEFORE required-flag checks so
  // `--help` works on its own. main() detects help=true and prints USAGE.
  if (argv.includes('--help') || argv.includes('-h')) {
    return {
      project: '',
      transcriptPath: '',
      briefId: undefined,
      inboxPath: undefined,
      dbPathOverride: undefined,
      source: 'detached',
      logPath: undefined,
      noLog: false,
      help: true,
    };
  }

  const requireValue = (flag: string): string => {
    const idx = argv.indexOf(flag);
    if (idx < 0) return '';
    const val = argv[idx + 1];
    if (!val || val.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return val;
  };

  const project = requireValue('--project');
  if (!project) {
    throw new Error('--project is required');
  }

  const transcriptPath = requireValue('--transcript-path');
  if (!transcriptPath) {
    throw new Error('--transcript-path is required');
  }

  const briefId = requireValue('--brief-id') || undefined;
  const inboxPath = requireValue('--inbox-path') || undefined;
  const dbPathOverride = requireValue('--db') || undefined;
  const source = requireValue('--source') || 'detached';
  // TD-077: optional --log-path override; --no-log is a boolean toggle.
  const logPath = requireValue('--log-path') || undefined;
  const noLog = argv.includes('--no-log');

  return {
    project,
    transcriptPath,
    briefId,
    inboxPath,
    dbPathOverride,
    source,
    logPath,
    noLog,
    help: false,
  };
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

/**
 * Read a transcript file with size cap. Returns empty string on missing or
 * empty file. Tail-reads when over the cap so we keep the most recent window.
 *
 * Cap matches the hook-side cap (4 MB) — the perception submit handler caps
 * at 5 MB anyway, and the LLM gate respects byte limits independently.
 */
export function readTranscriptFile(filePath: string): string {
  const MAX_BYTES = 4 * 1024 * 1024;
  if (!fs.existsSync(filePath)) return '';
  const stat = fs.statSync(filePath);
  if (stat.size === 0) return '';
  if (stat.size <= MAX_BYTES) {
    return fs.readFileSync(filePath, 'utf-8');
  }
  // Tail-read for oversize files.
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(MAX_BYTES);
    fs.readSync(fd, buffer, 0, MAX_BYTES, stat.size - MAX_BYTES);
    return buffer.toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Atomically truncate a file by writing an empty temp file alongside and
 * renaming. Concurrent appenders see either the old content or the empty
 * file — never a partial write.
 *
 * No-op when the file is absent.
 */
export function truncateFileAtomic(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, '', 'utf-8');
  fs.renameSync(tmp, filePath);
}

/**
 * Resolve the default inbox path for a project slug. Mirrors the path
 * convention used by the legacy `perception_extract.sh`.
 */
export function defaultInboxPath(projectSlug: string): string {
  return path.join(
    os.homedir(),
    '.igris',
    'projects',
    projectSlug,
    'session',
    'perception_inbox.jsonl',
  );
}

/**
 * TD-077: Resolve the default tee-log path for a project slug. Mirrors
 * `defaultInboxPath` (same `~/.igris/projects/{slug}/session/` directory) so
 * operators can grep both alongside each other.
 */
export function defaultLogPath(projectSlug: string): string {
  return path.join(
    os.homedir(),
    '.igris',
    'projects',
    projectSlug,
    'session',
    'perception_extract.log',
  );
}

/**
 * FR-120: resolved remote-brain config for the inline push phase. `null`
 * means "remote is not configured" — a normal state for fresh installs and
 * local-only setups; the inline push silently skips in that case.
 */
export interface RemoteBrainConfig {
  remoteUrl: string;
  apiKey: string;
}

/**
 * FR-120: Default path to the Igris config file. Exported so tests can
 * fixture alongside it.
 */
export function defaultBrainConfigPath(): string {
  return path.join(os.homedir(), '.igris', 'config.json');
}

/**
 * FR-120: Resolve the remote-brain config from `~/.igris/config.json`.
 *
 * Trimmed shape vs. the deleted `brain_push_cli.ts:resolveRemoteConfig`:
 * the CLI is now invoked exclusively by the perception_extract_and_persist
 * hook (no operator-supplied --remote-url / --api-key flags), so we read
 * straight from `config.json`. Tests pass a fixture path via
 * `configPathOverride`. Malformed or missing config → returns null.
 *
 * Exported so tests can drive resolution without spawning the CLI.
 */
export function resolveRemoteBrainConfig(
  configPathOverride?: string,
): RemoteBrainConfig | null {
  const configPath = configPathOverride ?? defaultBrainConfigPath();
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(raw) as { remote_brain?: { url?: string; api_key?: string } };
    const remoteUrl = cfg.remote_brain?.url ?? '';
    const apiKey = cfg.remote_brain?.api_key ?? '';
    if (!remoteUrl || !apiKey) return null;
    return { remoteUrl, apiKey };
  } catch {
    // Malformed config.json → treated as "remote not configured" (silent skip).
    // Same posture as the deleted brain_push_cli.ts:resolveRemoteConfig.
    return null;
  }
}

/**
 * TD-077: Tee `process.stdout` and `process.stderr` to the given log file IN
 * ADDITION to the original streams. Returns a `restore()` callback that
 * reverts the stream patches and waits for the underlying file write stream
 * to drain.
 *
 * Implementation: open a write stream in append mode (`flags: 'a'`), then
 * monkey-patch `stdout.write` / `stderr.write` to also push the chunk to the
 * stream. The restore() is await-safe: it reverts the originals first, then
 * ends the write stream and resolves on the 'finish' event so no log lines
 * are lost when `main()` resolves.
 *
 * Failure to create the parent directory or open the log file is non-fatal —
 * we surface a stderr line and return a no-op `restore()` so direct CLI runs
 * without a writable `~/.igris/...` path still produce stdout/stderr (matches
 * the wrapper script's `|| true` pattern).
 *
 * Composes with BR-060: must be installed BEFORE `bootEngine` so any
 * boot-error stderr is captured, and `restore()` must run AFTER
 * `engine.shutdown()` and `disposeEmbeddingPipeline` so the success line
 * (printed before the existing try/finally exits) lands in the log. The
 * BR-060 5s shutdown safety-valve calls `process.exit(0)` directly which
 * skips the outer finally — the success line is already tee'd by then,
 * so the most we lose is shutdown stderr after the timeout fires.
 */
export function setupTeeLog(logPath: string): { restore: () => Promise<void> } {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  } catch (err) {
    process.stderr.write(
      `[perception_extract_cli] log dir create failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return { restore: async () => {} };
  }

  let stream: fs.WriteStream;
  try {
    stream = fs.createWriteStream(logPath, { flags: 'a' });
  } catch (err) {
    process.stderr.write(
      `[perception_extract_cli] log open failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return { restore: async () => {} };
  }

  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);

  // The signature of stream.Writable.write is overloaded; we wrap it loosely
  // and forward all original arguments. Errors writing to the log stream are
  // swallowed so a tee failure can never abort the run.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
    try {
      stream.write(chunk);
    } catch {
      // ignore tee write failure
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origStdout as any)(chunk, ...rest);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: any, ...rest: any[]) => {
    try {
      stream.write(chunk);
    } catch {
      // ignore tee write failure
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origStderr as any)(chunk, ...rest);
  };

  return {
    restore: async () => {
      // Revert the patches BEFORE ending the stream so any stderr emitted
      // during teardown still goes to the real stderr.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = origStdout;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = origStderr;
      await new Promise<void>((resolve) => {
        stream.end(() => resolve());
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

/**
 * Execute the extraction pipeline against an opened DB. Pure-ish: side
 * effects are confined to DB writes (via `runPerception`) and inbox
 * truncation. Exported for tests so they can drive it without spawning
 * the CLI as a subprocess.
 *
 * @returns counts produced by the perception runner so callers can log a
 *   summary line.
 */
export async function runPerceptionFromTranscript(
  db: import('better-sqlite3').Database,
  options: {
    project: string;
    transcriptText: string;
    briefId: string | undefined;
    source: string;
    config: PerceptionExtractorConfig;
    llmExtractor: LlmExtractor;
    /**
     * Trigger label threaded into perception lifecycle events (TD-074).
     * Defaults to 'detached' (the CLI is the primary caller) so detached
     * runs always carry the right dimension.
     */
    trigger?: string;
  },
): Promise<{
  inserted: number;
  llmExtracted: number;
  suppressed: number;
  llmStatus: string;
  /** TD-086 — number of candidates skipped by the cheap-dedup pre-filter. */
  deduped: number;
}> {
  const events = parseTranscript(options.transcriptText);
  if (events.length === 0) {
    return {
      inserted: 0,
      llmExtracted: 0,
      suppressed: 0,
      llmStatus: 'skipped:empty',
      deduped: 0,
    };
  }
  const trigger = options.trigger ?? 'detached';
  const runOptions: import('../src/engine/components/perception/runner.js').RunPerceptionOptions = {
    events,
    project: options.project,
    source: options.source,
    trigger,
  };
  if (options.briefId) runOptions.brief_id = options.briefId;
  const result = await runPerception(
    db,
    runOptions,
    options.config,
    options.llmExtractor,
  );
  return {
    inserted: result.inserted,
    llmExtracted: result.llm_extracted,
    suppressed: result.suppressed,
    llmStatus: result.llm_status,
    deduped: result.deduped,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * CLI main. Reads args, boots engine, runs extraction, truncates inbox,
 * shuts down engine.
 *
 * Exit codes:
 *   - 0: success, no transcript, or empty transcript
 *   - 1: malformed args, DB unreachable, engine boot failure, or pre-flight
 *     failure
 *
 * All other failure modes (LLM timeout, parse errors) are absorbed inside
 * `runPerception` and surfaced as no-ops. Hooks must never block on us.
 *
 * Lifecycle (BR-060):
 *   The post-args workflow runs inside `try { ... } finally { ... }`. The
 *   finally block disposes the @huggingface/transformers pipeline first
 *   (so the ONNX worker pool is gone), then calls `engine.shutdown()`. The
 *   shutdown is wrapped in a 5-second timer (Path B-lite from the plan):
 *   if either step ever hangs (locked statement, stuck dispose), we
 *   force-exit 0 since the work is already persisted and the success line
 *   is already on stdout. This prevents the wrapper script from blocking
 *   indefinitely. The CLI entry point uses `process.exitCode = code` (not
 *   `process.exit(code)`) so the event loop drains naturally — the
 *   synchronous exit path races with native worker pool teardown and
 *   aborts with `mutex lock failed`.
 */
export async function main(argv: string[] = process.argv): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // --help / -h: print usage to stdout (success channel) and exit 0.
  // Help is intentionally handled BEFORE tee setup — there is nothing
  // worth logging for a help invocation, and we'd rather not create a
  // log file just because someone asked for usage.
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  // TD-077: install the tee BEFORE `bootEngine` so any boot-error stderr is
  // captured in the log artifact. The wrapper script
  // `perception_extract_and_persist.sh` already redirects via shell; this
  // duplicates capture for direct CLI invocations (smoke tests, ad-hoc
  // operator runs, manual /scan triage). `--no-log` opts out (used by the
  // test suite to avoid writing junk to `~/.igris/`). The restore is run in
  // an outer finally below, AFTER `engine.shutdown()` has flushed the
  // success line.
  let teeRestore: () => Promise<void> = async () => {};
  if (!args.noLog) {
    const logPath = args.logPath ?? defaultLogPath(args.project);
    const tee = setupTeeLog(logPath);
    teeRestore = tee.restore;
  }

  try {
  // --db override is honored by setting the env var that getDb() reads
  // BEFORE the first call. better-sqlite3 has no global rebind hook, so
  // any later --db flag would be ignored — handled at parse time.
  if (args.dbPathOverride) {
    process.env.IGRIS_DB_PATH = args.dbPathOverride;
  }

  // BR-060: boot the engine (not just getDb()) so sqlite-vec, migrations, and
  // component lifecycle are fully owned by the engine. The shutdown() call in
  // the `finally` below routes through registry.shutdown -> storage.close,
  // releasing the engine's native resources in deterministic order. Mirrors
  // BR-064 in brain_push_cli.ts. The actual SIGABRT root cause was the race
  // between process.exit() and the @huggingface/transformers ONNX worker
  // pool teardown — addressed by `process.exitCode = code` at the bottom of
  // this file. The boot+shutdown lifecycle here is defense in depth: it
  // ensures every native subsystem we own has a chance to release cleanly
  // before V8 tears down.
  //
  // dbPath honors the --db override (already set on env above) so the
  // existing test suite's IGRIS_DB_PATH sandboxing still works. Otherwise
  // default to the canonical ~/.igris/memory/knowledge.db path (tiers 2 and
  // 4 of db.ts:resolveDbPath; this explicit-path caller skips its
  // IGRIS_BRAIN_DIR tier — TD-426).
  const dbPath = process.env.IGRIS_DB_PATH
    ?? path.join(os.homedir(), '.igris', 'memory', 'knowledge.db');
  let engine: Engine;
  try {
    engine = bootEngine({ dbPath, components: {} });
  } catch (err) {
    console.error(
      `Error: engine boot failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  // bootEngine internally calls setAdapter(), so subsequent getDb() calls
  // resolve to this booted connection automatically. We use getDb() (rather
  // than reading engine.storage.rawConnection directly) so the existing test
  // suite — which mocks getDb() — still drives the same code path.
  const db = getDb();

  try {
    // Pre-flight: required table must exist. If learnings is missing, the
    // brain has not been booted on this machine — exit clean rather than
    // attempting a SQL stack trace into the void.
    const tableRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'learnings'")
      .get() as { name: string } | undefined;
    if (!tableRow) {
      // TD-074: emit a structured `run_failed` for the db_error pre-flight.
      // Wrapped in try/catch since the event_log table itself may be missing
      // on a brain that has never booted — in that case writePerceptionEvent
      // surfaces a stderr line and returns. We still exit 1 so callers see
      // the hard infrastructure failure.
      try {
        writePerceptionEvent(db, 'perception.run_failed', {
          project: args.project,
          reason: 'db_error',
          error_message: 'learnings table missing — brain not booted on this machine',
          trigger: 'detached',
        });
      } catch {
        // Helper already absorbs failures; this catch is belt-and-braces.
      }
      console.error(
        'Error: learnings table missing — brain not booted on this machine. ' +
          'Start the MCP server once to apply migrations.',
      );
      return 1;
    }

    const transcriptText = readTranscriptFile(args.transcriptPath);
    if (transcriptText.length === 0) {
      // Empty / missing transcript is the common no-op case — succeed silently.
      // Intentionally NO `run_started` emission here: emitting one without
      // a terminal event would surface as "stuck RUNNING" in /scan.
      return 0;
    }

    const config = resolvePerceptionConfig();
    // FR-118 M1: the detached extractor rides the shared cognition backend.
    // Resolve the global llm_extractor harness chain (default 'claude').
    const llmExtractor = selectLlmExtractor(config, undefined, resolveLlmExtractorGlobalConfig());

    let result;
    try {
      result = await runPerceptionFromTranscript(db, {
        project: args.project,
        transcriptText,
        briefId: args.briefId,
        source: args.source,
        config,
        llmExtractor,
        trigger: 'detached',
      });
    } catch (err) {
      // Defensive — runPerception swallows extractor errors internally, so a
      // throw here means infrastructure (DB, embeddings) failed. The runner
      // already wrote `perception.run_failed` to event_log before re-throwing
      // (TD-074 lifecycle invariant), so we do NOT double-emit here.
      //
      // Exit 0 to preserve the TD-073 detached-process contract: hooks must
      // never block, and the wrapper script invokes us with `|| true` so the
      // exit code is mostly informational. The structured failure is already
      // visible via /scan and /awaken. db_error pre-flight above remains the
      // sole exit-1 path (alongside malformed-args).
      console.error(
        `[perception_extract_cli] runPerception failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }

    // Truncate the inbox on success regardless of inserted count — the inbox
    // is a queue for legacy callers, and this CLI replaces the drain step.
    const inboxPath = args.inboxPath ?? defaultInboxPath(args.project);
    try {
      truncateFileAtomic(inboxPath);
    } catch (err) {
      // Truncation failure is non-fatal — the next run will overwrite again.
      console.error(
        `[perception_extract_cli] inbox truncate failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // FR-120: Push the local delta inline as the final lifecycle phase. The
    // producer (extract) and consumer (push) live in the same detached
    // process per L-72 ("background async features must have BOTH halves
    // background"). The handler is the same one the MCP exposes — single
    // canonical sync path. Wrapped in its own try/catch so a push failure
    // does NOT reverse the extract success: the extracted rows are already
    // persisted and the failed-push rows are queued in `sync_queue` by
    // handleBrainPush itself for the next /awaken §3.6.1 drain.
    //
    // Position: AFTER inbox truncation (synchronous, fast) and BEFORE the
    // BR-060 finally block that disposes the transformers pipeline and
    // shuts down the engine — `handleBrainPush` calls `getDb()` which
    // requires the engine connection to still be open.
    let pushSummary: string;
    try {
      const remote = resolveRemoteBrainConfig();
      if (remote) {
        const pushResult = await handleBrainPush({
          remote_url: remote.remoteUrl,
          api_key: remote.apiKey,
        });
        const pushText = pushResult.content?.[0]?.text ?? '(no push response)';
        // handleBrainPush contract (verified TD-097 audit): isError=true means
        // queueFailedRows was attempted before returning (catch block at
        // sync.ts:864 always runs queueFailedRows ahead of isError return).
        // Hard-fail-without-attempting-queue is impossible by construction;
        // a queue-write itself can still fail (inner try/catch at sync.ts:869).
        pushSummary = pushResult.isError ? 'queued' : 'pushed';
        // Log the first line of the push text so operators tailing
        // perception_extract.log see the row counts and chunk count from
        // handleBrainPush. The full text contains \n-separated table
        // counts; we only want the headline on the summary log.
        console.log(`[perception_extract_cli] push: ${pushText.split('\n')[0]}`);
      } else {
        pushSummary = 'remote_not_configured';
      }
    } catch (pushErr) {
      pushSummary = 'failed';
      console.error(
        `[perception_extract_cli] push failed (non-fatal — rows queued via handleBrainPush): ${
          pushErr instanceof Error ? pushErr.message : String(pushErr)
        }`,
      );
    }

    console.log(
      `[perception_extract_cli] inserted=${result.inserted} llm=${result.llmExtracted} ` +
        `suppressed=${result.suppressed} deduped=${result.deduped} ` +
        `llm_status=${result.llmStatus} push=${pushSummary} project=${args.project}`,
    );
    return 0;
  } finally {
    // BR-060: dispose the @huggingface/transformers pipeline first, then
    // the engine. The dispose() call releases the ONNX runtime's native
    // worker pool synchronously so its threads are joined before V8
    // teardown runs. Without this, the worker pool's mutex would still be
    // owned by a live thread when the runtime exits, and atexit handlers
    // race -> `mutex lock failed: Invalid argument` (libc++abi SIGABRT).
    //
    // Defensive 5-second timeout (Path B-lite from the plan): if either
    // step ever hangs (locked statement, stuck dispose), force-exit 0. The
    // success line and lifecycle events are already persisted at this
    // point, so a forced exit is safe — better than blocking the wrapper
    // script indefinitely. The timer is `unref()`-ed so it does not keep
    // the event loop alive purely for itself.
    const shutdownTimer = setTimeout(() => {
      console.error(
        '[perception_extract_cli] shutdown timed out after 5s, forcing exit',
      );
      process.exit(0);
    }, 5000);
    shutdownTimer.unref();
    try {
      // Step 1: dispose the embedding pipeline (transformers + ONNX
      // runtime). Best-effort and idempotent — no-op when the pipeline
      // was never loaded (cold-path runs that hit the LLM gate but never
      // produced candidates).
      await disposeEmbeddingPipeline();

      // Step 2: tear down the engine (storage.close, registry.shutdown).
      // Closes the sqlite-vec extension cleanly. Even though the abort
      // root cause was the transformers worker pool (not sqlite-vec),
      // routing through engine.shutdown() ensures every native subsystem
      // we own gets a chance to release resources in deterministic order
      // — defense in depth against future component additions that load
      // their own native code.
      engine.shutdown();
    } catch (shutdownErr) {
      console.error(
        `[perception_extract_cli] shutdown failed (non-fatal): ${
          shutdownErr instanceof Error ? shutdownErr.message : String(shutdownErr)
        }`,
      );
    } finally {
      clearTimeout(shutdownTimer);
    }
  }
  } finally {
    // TD-077: tee teardown happens AFTER the BR-060 lifecycle block above
    // (engine.shutdown + disposeEmbeddingPipeline) so the success line and
    // any shutdown stderr have already been captured. Note: the BR-060 5s
    // shutdown safety-valve calls `process.exit(0)` directly which skips
    // this outer finally — accepted residual since the success line was
    // tee'd before that timer fired. Restoration is await-safe and revert
    // the stream patches before ending the underlying file stream.
    await teeRestore();
  }
}

// Run main only when invoked as the CLI entry point, not when imported
// by tests. Tests import the module by path and never have
// `perception_extract_cli` as argv[1].
const entryPoint = process.argv[1] ?? '';
const isDirectRun = /perception_extract_cli(\.ts|\.js)?$/.test(entryPoint);

if (isDirectRun) {
  // BR-060: set process.exitCode and let the event loop drain naturally
  // INSTEAD of calling process.exit() synchronously. The synchronous exit
  // path triggers libuv/V8 atexit handlers that race with the
  // @huggingface/transformers ONNX runtime's worker pool teardown — the
  // race aborts the process with `mutex lock failed: Invalid argument`
  // (libc++abi SIGABRT, exit ~134). Letting the loop drain naturally lets
  // the worker pool finish its own cleanup before V8 tears down. Same
  // exit-code semantics; safer teardown.
  main().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
