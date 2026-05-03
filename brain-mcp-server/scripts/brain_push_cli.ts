/**
 * TD-080 — Standalone brain-push CLI.
 *
 * Mirrors the perception_extract_cli.ts shape: a thin runner that invokes
 * `handleBrainPush` outside the MCP server process, so background actors
 * (perception extractor today, FR-118 subconscious tomorrow) can propagate
 * their local delta to the remote brain without going through the MCP
 * tool-call pathway.
 *
 * Pipeline:
 *   1. Parse CLI flags.
 *   2. Resolve remote_url + api_key from --remote-url/--api-key flags or
 *      from `~/.igris/config.json` (`remote_brain.url` + `remote_brain.api_key`).
 *      If neither source supplies both, exit 0 silently — remote not configured
 *      is a normal state, not an error.
 *   3. If --db override is supplied, set IGRIS_DB_PATH before any DB open.
 *   4. Call handleBrainPush({ remote_url, api_key }).
 *   5. Print response.content[0].text to stdout for the log file.
 *   6. Exit 0 on success or "remote not configured"; exit 1 only on hard
 *      error (DB unreachable, malformed args).
 *
 * Usage:
 *   npx tsx scripts/brain_push_cli.ts --project igris-ai
 *
 *   Optional flags:
 *     --db PATH                Override IGRIS_DB_PATH (test override)
 *     --remote-url URL         Override remote_brain.url from config.json
 *     --api-key KEY            Override remote_brain.api_key from config.json
 *     --config PATH            Override path to config.json (test override)
 *
 * Concurrency note: handleBrainPush uses fetchWithRetry with a 30s
 * AbortController timeout per attempt and a 5MB chunk cap. Worst-case
 * runtime is bounded; the parent helper script detaches us via nohup so
 * the caller's exit is never delayed.
 *
 * @module scripts/brain_push_cli
 * @author Fifty.ai
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleBrainPush } from '../src/tools/sync.js';
import { bootEngine } from '../src/engine/index.js';
import type { Engine } from '../src/engine/index.js';

// ---------------------------------------------------------------------------
// Usage block — printed on --help / -h. Kept in sync with the file header.
// ---------------------------------------------------------------------------

export const USAGE = `brain_push_cli — TD-080 standalone brain-push CLI

Pushes the local brain delta to a remote brain server outside the MCP server
process. Spawned (DETACHED) by background actors via brain_push_async.sh so
this machine's perception/subconscious output reaches other machines before
/rest. Reads remote_brain.url + remote_brain.api_key from ~/.igris/config.json
unless overridden by --remote-url / --api-key. Exits 0 on success or when
remote is not configured; exits 1 only on hard error.

Usage:
  npx tsx scripts/brain_push_cli.ts \\
    --project <slug> \\
    [--db <path>] [--remote-url <url>] [--api-key <key>] [--config <path>]

Required flags:
  --project <slug>            Project slug (used for log labelling)

Optional flags:
  --db <path>                 Override IGRIS_DB_PATH (test override)
  --remote-url <url>          Override remote_brain.url from config.json
  --api-key <key>             Override remote_brain.api_key from config.json
  --config <path>             Override path to ~/.igris/config.json (test override)
  --help, -h                  Print this help and exit 0

Examples:
  npx tsx scripts/brain_push_cli.ts --project igris-ai

  npx tsx scripts/brain_push_cli.ts --project igris-ai \\
    --remote-url http://staging.example.com:3001 \\
    --api-key test-key

  npx tsx scripts/brain_push_cli.ts --help
`;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

/**
 * Parsed CLI shape. Exported for unit tests so the parser is exercised
 * directly without spawning a subprocess.
 */
export interface CliArgs {
  /** Project slug. Required (unless `help` is true). Used for log labels. */
  project: string;
  /** Optional `IGRIS_DB_PATH` override. */
  dbPathOverride: string | undefined;
  /** Optional remote URL override (otherwise read from config.json). */
  remoteUrlOverride: string | undefined;
  /** Optional API key override (otherwise read from config.json). */
  apiKeyOverride: string | undefined;
  /** Optional path to config.json (test override). */
  configPathOverride: string | undefined;
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
 * Throws on missing required flags (`--project`) or when a flag that takes
 * a value is followed by another flag.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  // --help / -h short-circuit. Returned BEFORE required-flag checks so
  // `--help` works on its own. main() detects help=true and prints USAGE.
  if (argv.includes('--help') || argv.includes('-h')) {
    return {
      project: '',
      dbPathOverride: undefined,
      remoteUrlOverride: undefined,
      apiKeyOverride: undefined,
      configPathOverride: undefined,
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

  const dbPathOverride = requireValue('--db') || undefined;
  const remoteUrlOverride = requireValue('--remote-url') || undefined;
  const apiKeyOverride = requireValue('--api-key') || undefined;
  const configPathOverride = requireValue('--config') || undefined;

  return {
    project,
    dbPathOverride,
    remoteUrlOverride,
    apiKeyOverride,
    configPathOverride,
    help: false,
  };
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Resolved remote-brain config. `null` means "remote is not configured" —
 * a normal state that should result in exit 0, not an error.
 */
export interface RemoteConfig {
  remoteUrl: string;
  apiKey: string;
}

/**
 * Default path to the Igris config file. Exported so tests can build
 * fixtures alongside it.
 */
export function defaultConfigPath(): string {
  return path.join(os.homedir(), '.igris', 'config.json');
}

/**
 * Resolve the remote-brain config from CLI overrides + config.json.
 *
 * Hybrid input model (Q-2 design decision, TD-080 plan):
 *   - If both --remote-url AND --api-key are supplied, use them directly
 *     and skip config.json entirely.
 *   - Otherwise read from config.json's `remote_brain` block, with any
 *     supplied flag taking precedence over the file value.
 *   - If after both sources EITHER value is missing/empty, return null
 *     (remote not configured).
 *
 * Exported so tests can drive resolution without spawning the CLI.
 */
export function resolveRemoteConfig(
  args: Pick<CliArgs, 'remoteUrlOverride' | 'apiKeyOverride' | 'configPathOverride'>,
): RemoteConfig | null {
  let configRemoteUrl = '';
  let configApiKey = '';

  // Only read config.json if at least one value is missing from flags. Saves
  // a file-system stat in the all-flags path and avoids surfacing a confusing
  // "config missing" error when the operator explicitly passed flags.
  if (!args.remoteUrlOverride || !args.apiKeyOverride) {
    const configPath = args.configPathOverride ?? defaultConfigPath();
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const cfg = JSON.parse(raw) as { remote_brain?: { url?: string; api_key?: string } };
        configRemoteUrl = cfg.remote_brain?.url ?? '';
        configApiKey = cfg.remote_brain?.api_key ?? '';
      } catch {
        // Malformed config.json is treated as "remote not configured" — same
        // posture as missing file. The caller (helper script) is silent in
        // this state by design.
      }
    }
  }

  const remoteUrl = args.remoteUrlOverride ?? configRemoteUrl;
  const apiKey = args.apiKeyOverride ?? configApiKey;

  if (!remoteUrl || !apiKey) {
    return null;
  }

  return { remoteUrl, apiKey };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * CLI main. Reads args, resolves remote config, invokes handleBrainPush.
 *
 * Exit codes:
 *   - 0: success, or "remote not configured" (silent skip)
 *   - 1: malformed args, DB unreachable, or hard handler failure
 *
 * @param argv - process.argv-shaped array (overridable for tests)
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
  // BEFORE the first call. Same pattern as perception_extract_cli.ts.
  if (args.dbPathOverride) {
    process.env.IGRIS_DB_PATH = args.dbPathOverride;
  }

  const remote = resolveRemoteConfig(args);
  if (!remote) {
    // Silent skip: remote not configured is a normal state for fresh installs
    // or local-only setups. The helper script calling us logs nothing on this
    // path either, so the operator sees no spurious failures.
    console.error(
      `brain_push_cli: remote not configured, skipping (project=${args.project})`,
    );
    return 0;
  }

  // BR-064 Fix A: boot the engine BEFORE invoking handleBrainPush so that
  // per-component migrations run on this connection. Without this step the
  // legacy `migrateSchema` fallback in db.ts:getDb() only creates v1-v15
  // tables — leaving component-owned tables (goals, entity_edges, tasks,
  // suggestions, dismissed_patterns, ...) absent. handleBrainPush iterates
  // SYNC_TABLES and would then throw `no such table: goals` (or whichever
  // component table landed first). bootEngine internally calls setAdapter()
  // so subsequent getDb() calls inside handleBrainPush resolve to this
  // booted connection automatically.
  //
  // dbPath: honor the --db override (already set on env above) so tests can
  // point at an in-memory or sandbox DB. Otherwise default to the canonical
  // ~/.igris/memory/knowledge.db path (matches db.ts:resolveDbPath).
  const dbPath = process.env.IGRIS_DB_PATH
    ?? path.join(os.homedir(), '.igris', 'memory', 'knowledge.db');
  let engine: Engine;
  try {
    engine = bootEngine({ dbPath, components: {} });
  } catch (err) {
    console.error(
      `[brain_push_cli] engine boot failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  let result;
  try {
    result = await handleBrainPush({
      remote_url: remote.remoteUrl,
      api_key: remote.apiKey,
    });
  } catch (err) {
    console.error(
      `[brain_push_cli] handleBrainPush threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  } finally {
    // Tear down the engine (closes DB, stops component listeners). Runs after
    // the awaited push completes so the connection stays open through fetch
    // chunking. Wrapped in try/catch so a shutdown failure does not mask the
    // success/failure path above.
    try {
      engine.shutdown();
    } catch (shutdownErr) {
      console.error(
        `[brain_push_cli] engine shutdown failed (non-fatal): ${
          shutdownErr instanceof Error ? shutdownErr.message : String(shutdownErr)
        }`,
      );
    }
  }

  // handleBrainPush returns MCP-shaped { content: [{ type, text }], isError? }.
  // Print the text payload so it lands in the log file the helper tails.
  // isError=true is the queue-failed path; rows are already enqueued in
  // sync_queue for retry, so we still exit 0 — the failure surfaces via /scan
  // and the next /awaken §3.6.1 drain.
  const text = result.content?.[0]?.text ?? '(no response text)';
  console.log(text);
  return 0;
}

// Run main only when invoked as the CLI entry point, not when imported
// by tests. Tests import the module by path and never have
// `brain_push_cli` as argv[1].
const entryPoint = process.argv[1] ?? '';
const isDirectRun = /brain_push_cli(\.ts|\.js)?$/.test(entryPoint);

if (isDirectRun) {
  main().then((code) => {
    process.exit(code);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
