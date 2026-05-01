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
 *   2. Open the brain DB via `getDb()` (honors `IGRIS_DB_PATH` override).
 *   3. Pre-flight: confirm `learnings` table exists.
 *   4. Read transcript file. If absent or empty, exit 0 silently.
 *   5. Resolve perception config + LLM extractor (3-layer chain).
 *   6. Call `runPerception` directly (no MCP roundtrip).
 *   7. On success, truncate the project's perception_inbox.jsonl atomically
 *      so legacy callers don't accumulate stale rows.
 *   8. Exit 0 on success or empty transcript; exit 1 only on hard error
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
 * @author Fifty.ai
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDb } from '../src/db.js';
import { resolvePerceptionConfig } from '../src/engine/components/perception/index.js';
import { selectLlmExtractor } from '../src/engine/components/perception/extractors/llm_via_claude_code.js';
import { runPerception } from '../src/engine/components/perception/runner.js';
import { parseTranscript } from '../src/engine/components/perception/handlers.js';
import { writePerceptionEvent } from '../src/engine/components/perception/events.js';
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
    [--brief-id <id>] [--inbox-path <path>] [--db <path>] [--source <label>]

Required flags:
  --project <slug>            Project slug (e.g. igris-ai)
  --transcript-path <path>    Absolute path to the transcript file

Optional flags:
  --brief-id <id>             Brief context for the prompt (e.g. TD-066)
  --inbox-path <path>         Override inbox path (default: ~/.igris/projects/{slug}/session/perception_inbox.jsonl)
  --db <path>                 Override IGRIS_DB_PATH (test override)
  --source <label>            Trigger source label (default: detached)
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

  return {
    project,
    transcriptPath,
    briefId,
    inboxPath,
    dbPathOverride,
    source,
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
): Promise<{ inserted: number; llmExtracted: number; suppressed: number; llmStatus: string }> {
  const events = parseTranscript(options.transcriptText);
  if (events.length === 0) {
    return { inserted: 0, llmExtracted: 0, suppressed: 0, llmStatus: 'skipped:empty' };
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
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * CLI main. Reads args, opens DB, runs extraction, truncates inbox.
 *
 * Exit codes:
 *   - 0: success, no transcript, or empty transcript
 *   - 1: malformed args, DB unreachable, or pre-flight failure
 *
 * All other failure modes (LLM timeout, parse errors) are absorbed inside
 * `runPerception` and surfaced as no-ops. Hooks must never block on us.
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
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  // --db override is honored by setting the env var that getDb() reads
  // BEFORE the first call. better-sqlite3 has no global rebind hook, so
  // any later --db flag would be ignored — handled at parse time.
  if (args.dbPathOverride) {
    process.env.IGRIS_DB_PATH = args.dbPathOverride;
  }

  let db: import('better-sqlite3').Database;
  try {
    db = getDb();
  } catch (err) {
    console.error(
      `Error: failed to open brain DB: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

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
  const llmExtractor = selectLlmExtractor(config);

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

  console.log(
    `[perception_extract_cli] inserted=${result.inserted} llm=${result.llmExtracted} ` +
      `suppressed=${result.suppressed} llm_status=${result.llmStatus} project=${args.project}`,
  );
  return 0;
}

// Run main only when invoked as the CLI entry point, not when imported
// by tests. Tests import the module by path and never have
// `perception_extract_cli` as argv[1].
const entryPoint = process.argv[1] ?? '';
const isDirectRun = /perception_extract_cli(\.ts|\.js)?$/.test(entryPoint);

if (isDirectRun) {
  main().then((code) => {
    process.exit(code);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
