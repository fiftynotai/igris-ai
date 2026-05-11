/**
 * `igris sync data [--dry-run]` — data-sync sub-verb.
 *
 * Drains the local sync_queue.jsonl AND triggers the remote
 * `igris_sync_queue_drain` MCP tool over HTTP.
 *
 * Local queue contract (matches the legacy `/sync` skill at lines 156-167):
 *   - Path: `~/.igris/projects/<slug>/sync_queue.jsonl`
 *   - Each line is a JSON object with at least `{operation, ...args}`.
 *   - When `operation === "brief_sync"` or `"brief_create"`, the entry
 *     is replayed as the corresponding MCP call with the recorded args.
 *   - On per-entry failure: stop the loop, preserve the queue file for
 *     the next attempt; the brain-side drain is NOT invoked.
 *   - Only after every entry replays successfully is the brain-side
 *     `igris_sync_queue_drain` invoked, and only after THAT succeeds is
 *     the local queue file unlinked.
 *
 * Why per-entry dispatch (NOT a batched `local_entries` arg): the brain
 * server's `igris_sync_queue_drain` schema accepts only `{remote_url,
 * api_key}` (see `brain-mcp-server/src/tools/sync.ts:1014-1017`). Any
 * `local_entries` argument would be silently discarded by the brain's
 * Zod parse, and the local queue would be unlinked with no replay —
 * permanent data loss. This was sentinel's Bug 2 in the M4 reject; the
 * legacy `/sync` skill at git-history `core/skills/sync/SKILL.md` lines
 * 156-167 specified per-entry dispatch and we now match that semantic.
 *
 * Tests use a real tmp `sync_queue.jsonl` and mock the MCP HTTP boundary
 * (per L-159 / TD-098: never `vi.mock` the module under test).
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { mcpCall, readRemoteBrainConfig, type RemoteBrainConfig } from "../mcp-client.js";
import { DryRunCollector } from "../dry-run.js";
import { brainDir } from "../paths.js";
import { basenameOfCwd } from "./util.js";
import { info, warn, error as logError } from "../log.js";

export interface SyncDataOptions {
  /** When true, enumerate plan without invoking MCP. */
  dryRun?: boolean;
  /**
   * Override the project slug used to locate the local sync queue.
   * Defaults to `basename(process.cwd())` — matches /sync skill convention.
   */
  projectSlug?: string;
}

/** Parsed queue entry — `operation` is required, everything else flows through. */
interface QueueEntry {
  operation?: string;
  [key: string]: unknown;
}

/**
 * Run `igris sync data`. Returns process exit code.
 *
 * Exit codes:
 *   0 — success (drained N entries, or empty queue)
 *   1 — remote_brain not configured, MCP call failed, queue read failed
 */
export async function runSyncData(opts: SyncDataOptions = {}): Promise<number> {
  const dryRun = opts.dryRun === true;
  const dry = dryRun ? new DryRunCollector() : null;

  const remote = readRemoteBrainConfig();
  if (remote === null) {
    logError(
      "remote_brain config not found in ~/.igris/config.json. Add a 'remote_brain' block with url + api_key.",
    );
    return 1;
  }

  // Resolve local queue path.
  const slug = opts.projectSlug ?? basenameOfCwd();
  const queuePath = join(brainDir(), "projects", slug, "sync_queue.jsonl");

  // Read the queue.
  let entries: string[] = [];
  if (existsSync(queuePath)) {
    try {
      const raw = readFileSync(queuePath, "utf-8");
      entries = raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`failed to read sync queue ${queuePath}: ${msg}`);
      return 1;
    }
  }

  if (entries.length === 0) {
    info(`sync data: local queue empty (${queuePath}); nothing to replay locally.`);
    if (dry !== null) {
      dry.wouldInvokeCommand(
        "mcp:igris_sync_queue_drain",
        [],
        "drain remote brain queue (would still call even with empty local queue)",
      );
      dry.print();
    } else {
      // Even with empty local queue we trigger remote drain — the remote
      // queue may have entries from other instances.
      const drainResult = await callRemoteDrain(remote);
      if (drainResult !== 0) return drainResult;
    }
    return 0;
  }

  if (dry !== null) {
    // Per-entry replay plan first, then the remote drain.
    for (let i = 0; i < entries.length; i++) {
      const entry = parseEntry(entries[i]);
      const op = entry?.operation ?? "<unknown>";
      const tool = mcpToolForOperation(op);
      const label = tool ?? `unknown-op:${op}`;
      dry.wouldInvokeCommand(
        `mcp:${label}`,
        [`entry_index=${i}`],
        `replay queued ${op} entry`,
      );
    }
    dry.wouldInvokeCommand(
      "mcp:igris_sync_queue_drain",
      [],
      "drain remote brain queue (after per-entry replay)",
    );
    dry.wouldWriteFile(queuePath, "remove queue file after successful drain");
    dry.print();
    return 0;
  }

  info(`sync data: replaying ${entries.length} local queue entries via remote MCP...`);

  // Phase 1 — per-entry dispatch loop. Stops on first failure; queue
  // file is preserved so the next attempt can retry from the same state.
  for (let i = 0; i < entries.length; i++) {
    const raw = entries[i];
    const entry = parseEntry(raw);
    if (entry === null) {
      logError(
        `sync data: entry ${i} is not valid JSON; preserving queue. Raw: ${truncate(raw, 200)}`,
      );
      return 1;
    }
    const op = entry.operation;
    if (typeof op !== "string" || op.length === 0) {
      logError(
        `sync data: entry ${i} missing 'operation' field; preserving queue. Raw: ${truncate(raw, 200)}`,
      );
      return 1;
    }

    const dispatchResult = await dispatchEntry(remote, entry, i);
    if (dispatchResult !== 0) {
      // dispatchEntry already logged. Queue file stays put.
      return dispatchResult;
    }
  }

  info(`sync data: ${entries.length} entries replayed; calling brain-side drain...`);

  // Phase 2 — drain the brain-side queue. Only runs after every local
  // entry succeeded.
  const drainResult = await callRemoteDrain(remote);
  if (drainResult !== 0) {
    // Local entries already replayed — but the brain-side drain failed.
    // Preserve the local queue too: the user can re-run, the brain will
    // dedupe via INSERT ... ON CONFLICT semantics on the per-tool side.
    return drainResult;
  }

  // Both phases succeeded — clear the local queue file.
  try {
    unlinkSync(queuePath);
    info(`sync data: drained ${entries.length} entries; local queue cleared.`);
  } catch (err) {
    // The drain succeeded but we couldn't unlink the file. Log and
    // continue — the queue is now stale (its entries are already on the
    // brain) and the next run will re-replay; the brain's own dedupe
    // (ON CONFLICT) will handle the redundant calls. Safer to leave the
    // file than to silently truncate and risk hiding a permission bug.
    const msg = err instanceof Error ? err.message : String(err);
    warn(
      `sync data: drained ${entries.length} entries but could not unlink queue (${msg}); will re-replay on next run (brain dedupes).`,
    );
  }

  return 0;
}

/**
 * Map a queue-entry operation kind to the MCP tool that replays it.
 * Returns null for unknown ops (caller should treat as a hard error —
 * we don't want to silently skip operations we don't understand).
 */
function mcpToolForOperation(op: string): string | null {
  switch (op) {
    case "brief_sync":
      return "igris_brief_sync";
    case "brief_create":
      return "igris_brief_create";
    default:
      return null;
  }
}

/**
 * TD-128 M3 — caller-side strict allow-list for queue replay.
 *
 * Each set MUST mirror the corresponding tool's `inputSchema.properties`
 * keys in `brain-mcp-server/src/engine/components/briefs/index.ts`. The
 * brain gateway runs in warn-mode today (TD-128 M1) and will reject
 * extras at M4 — keeping these allow-lists in sync with the brain-side
 * schemas forecloses the silent-data-forwarding failure that the
 * previous `Object.entries(entry)` spread enabled.
 *
 * NOTE on `cache_path`: NOT in this allow-list because callers of
 * `buildToolArgs` resolve `cache_path → content` BEFORE forwarding
 * (see `dispatchEntry`). The resolved `content` IS in the allow-list.
 */
const ALLOWED_KEYS_PER_OP: Record<string, ReadonlySet<string>> = {
  // Mirrors igris_brief_sync inputSchema.properties (briefs/index.ts:81-114).
  brief_sync: new Set([
    "project",
    "brief_id",
    "brief_type",
    "title",
    "status",
    "priority",
    "effort",
    "phase",
  ]),
  // Mirrors igris_brief_create inputSchema.properties (briefs/index.ts:257-302).
  brief_create: new Set([
    "project",
    "brief_id",
    "title",
    "content",
    "filename",
    "brief_type",
    "status",
    "priority",
    "effort",
    "phase",
    "parent_brief",
  ]),
};

/**
 * Build the MCP tool args object for a queue entry, restricting forwarded
 * keys to the allow-list for the entry's operation. Drops `operation`
 * (the dispatcher's discriminator) and any historical/legacy fields not
 * declared in the brain's strict schema.
 *
 * Throws on unknown op — `dispatchEntry` already gates on a known op via
 * `mcpToolForOperation`, so this is a defensive invariant.
 */
function buildToolArgs(op: string, entry: QueueEntry): Record<string, unknown> {
  const allowed = ALLOWED_KEYS_PER_OP[op];
  if (!allowed) {
    throw new Error(`buildToolArgs: no allow-list for op '${op}'`);
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (k === "operation") continue;
    if (allowed.has(k)) result[k] = v;
  }
  return result;
}

/**
 * Replay a single queue entry as an MCP call. Returns process exit code
 * (0 on success, 1 on failure).
 *
 * For `brief_create` entries, if the entry has a `cache_path` field
 * instead of inline `content`, the file is read and substituted into
 * the args before the call (matches the legacy /sync skill contract).
 */
async function dispatchEntry(
  remote: RemoteBrainConfig,
  entry: QueueEntry,
  index: number,
): Promise<number> {
  const op = entry.operation as string;
  const tool = mcpToolForOperation(op);
  if (tool === null) {
    logError(
      `sync data: entry ${index} has unknown operation '${op}'; preserving queue. ` +
        `Add a handler in dispatchEntry() if this op is intentional.`,
    );
    return 1;
  }

  // TD-128 M3 — resolve cache_path → content BEFORE allow-list filtering.
  // We mutate a shallow copy so the original entry stays untouched (test
  // assertions and downstream callers may inspect it).
  const resolved: QueueEntry = { ...entry };
  if (op === "brief_create" && typeof resolved.cache_path === "string") {
    const cachePath = resolved.cache_path;
    try {
      resolved.content = readFileSync(cachePath, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(
        `sync data: entry ${index} (brief_create) cache_path=${cachePath} unreadable: ${msg}; preserving queue.`,
      );
      return 1;
    }
    delete resolved.cache_path;
  }

  // Build tool args via strict per-op allow-list (TD-128 M3). Any field
  // not declared in the brain's inputSchema.properties is dropped here,
  // matching warn-mode (M1) and the upcoming reject-mode (M4) contract.
  const toolArgs = buildToolArgs(op, resolved);

  const result = await mcpCall(remote, tool, toolArgs);
  if (result.statusCode === 200) {
    info(`sync data: entry ${index} (${op}) replayed via ${tool} (HTTP 200).`);
    return 0;
  }
  logError(
    `sync data: entry ${index} (${op}) failed via ${tool} (HTTP ${result.statusCode}): ${truncate(result.body, 500)}; preserving queue.`,
  );
  return 1;
}

function parseEntry(line: string): QueueEntry | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as QueueEntry;
  } catch {
    return null;
  }
}

/**
 * Invoke the remote `igris_sync_queue_drain` MCP tool. Returns process
 * exit code (0 on success, 1 on HTTP failure or non-200 response).
 *
 * The brain's drain schema accepts only `{remote_url, api_key}` (see
 * `brain-mcp-server/src/tools/sync.ts:1014-1017`). We do NOT pass
 * `local_entries` — the brain reads exclusively from its own
 * `sync_queue` table. Per-entry replay happens in `dispatchEntry`
 * BEFORE this call.
 */
async function callRemoteDrain(
  remote: RemoteBrainConfig,
): Promise<number> {
  const args: Record<string, unknown> = {
    remote_url: remote.url,
    api_key: remote.apiKey,
  };
  const result = await mcpCall(remote, "igris_sync_queue_drain", args);
  if (result.statusCode === 200) {
    info(`sync data: remote drain OK (HTTP 200)`);
    return 0;
  }
  logError(
    `sync data: remote drain failed (HTTP ${result.statusCode}): ${truncate(result.body, 500)}`,
  );
  return 1;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "... [truncated]";
}
