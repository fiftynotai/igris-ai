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
 *
 * FR-128 atomic drain: the read-then-truncate pair has been replaced by
 * the rename-then-process primitive in `./queue.ts`. `runSyncData`
 * delegates: `acquireDrainSnapshot` produces a renamed snapshot of the
 * queue (the rename is the atomic moment), `dispatchEntry` replays each
 * line, and `finalizeDrainSnapshot(snap, ok)` either deletes the temp
 * (success) or preserves it for crash-recovery (failure). Per L-253
 * the drain logic lives in ONE code path — this module never inlines
 * the rename/unlink; it always calls through `queue.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mcpCall, readRemoteBrainConfig, type RemoteBrainConfig } from "../mcp-client.js";
import { DryRunCollector } from "../dry-run.js";
import { brainDir } from "../paths.js";
import { basenameOfCwd } from "./util.js";
import {
  acquireDrainSnapshot,
  finalizeDrainSnapshot,
  inspectQueueDepth,
  type DrainSnapshot,
} from "./queue.js";
import { info, error as logError, getVerbosity, setVerbosity } from "../log.js";

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

  // Resolve local queue path (for dry-run display + log messages).
  const slug = opts.projectSlug ?? basenameOfCwd();
  const queuePath = join(brainDir(), "projects", slug, "sync_queue.jsonl");

  // Dry-run: NEVER mutate the filesystem (no acquireDrainSnapshot). We
  // read the queue read-only via inspectQueueDepth/readFileSync so the
  // plan reflects on-disk depth without renaming anything.
  if (dry !== null) {
    const depth = inspectQueueDepth(slug);
    // Read the live queue contents (if any) to enumerate entries in
    // the plan. We do NOT count `.draining-*` lines here because the
    // dry-run plan should reflect what an actual `runSyncData` would
    // process — and the live drain would recover-then-rename, so
    // post-recovery the live queue would carry all surviving lines.
    let entries: string[] = [];
    try {
      const raw = readFileSync(queuePath, "utf-8");
      entries = raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch {
      // No queue file (or unreadable) → empty plan, drain-only.
    }
    if (entries.length === 0) {
      info(`sync data: local queue empty (${queuePath}); nothing to replay locally.`);
      dry.wouldInvokeCommand(
        "mcp:igris_sync_queue_drain",
        [],
        "drain remote brain queue (would still call even with empty local queue)",
      );
      dry.print();
      return 0;
    }
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
    if (depth.drainingFiles.length > 0) {
      dry.wouldInvokeCommand(
        "fs:recoverStaleDrains",
        [`stale_files=${depth.drainingFiles.length}`],
        "reclaim stale .draining-* files into queue before drain",
      );
    }
    dry.print();
    return 0;
  }

  // FR-128 atomic acquisition: rename queue → temp, read entries from
  // temp. Any sibling-harness append landing AFTER this returns goes
  // to a fresh `sync_queue.jsonl` and survives for the next drain.
  // `acquireDrainSnapshot` also self-heals any `.draining-*` files
  // left by a crashed prior drain (Q3 in the FR-128 plan).
  let snapshot: DrainSnapshot | null;
  try {
    snapshot = acquireDrainSnapshot(slug);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`failed to acquire drain snapshot for ${queuePath}: ${msg}`);
    return 1;
  }

  if (snapshot === null || snapshot.entries.length === 0) {
    // Snapshot may be non-null with zero entries if recovery promoted
    // an empty stale file. Either way, nothing to replay locally — but
    // we still trigger the remote drain (other instances may have
    // queued on the brain side).
    if (snapshot !== null) {
      finalizeDrainSnapshot(snapshot, true);
    }
    info(`sync data: local queue empty (${queuePath}); nothing to replay locally.`);
    const drainResult = await callRemoteDrain(remote);
    if (drainResult !== 0) return drainResult;
    return 0;
  }

  info(`sync data: replaying ${snapshot.entries.length} local queue entries via remote MCP...`);

  // Phase 1 — per-entry dispatch loop. Stops on first failure; the
  // temp is finalised as failed so the next drain's recovery pass
  // reclaims it. The drain logic stays in one code path (L-253).
  for (let i = 0; i < snapshot.entries.length; i++) {
    const raw = snapshot.entries[i];
    const entry = parseEntry(raw);
    if (entry === null) {
      logError(
        `sync data: entry ${i} is not valid JSON; preserving queue. Raw: ${truncate(raw, 200)}`,
      );
      finalizeDrainSnapshot(snapshot, false);
      return 1;
    }
    const op = entry.operation;
    if (typeof op !== "string" || op.length === 0) {
      logError(
        `sync data: entry ${i} missing 'operation' field; preserving queue. Raw: ${truncate(raw, 200)}`,
      );
      finalizeDrainSnapshot(snapshot, false);
      return 1;
    }

    const dispatchResult = await dispatchEntry(remote, entry, i);
    if (dispatchResult !== 0) {
      // dispatchEntry already logged. Finalise as failure → temp is
      // either renamed back to canonical (if no sibling appended) or
      // left in place for the next recovery pass.
      finalizeDrainSnapshot(snapshot, false);
      return dispatchResult;
    }
  }

  info(`sync data: ${snapshot.entries.length} entries replayed; calling brain-side drain...`);

  // Phase 2 — drain the brain-side queue. Only runs after every local
  // entry succeeded.
  const drainResult = await callRemoteDrain(remote);
  if (drainResult !== 0) {
    // Local entries already replayed — but the brain-side drain failed.
    // Preserve the local queue (finalize as failure) so the user can
    // re-run; the brain dedupes via INSERT ... ON CONFLICT semantics.
    finalizeDrainSnapshot(snapshot, false);
    return drainResult;
  }

  // Both phases succeeded — unlink the temp via the primitive (the
  // canonical queue is already gone, replaced by any sibling appends
  // that arrived after the rename).
  finalizeDrainSnapshot(snapshot, true);
  info(`sync data: drained ${snapshot.entries.length} entries; local queue cleared.`);

  return 0;
}

/** Structured result of {@link drainSyncQueueOnly}. */
export interface QueueDrainResult {
  /** True when the local replay + brain-side drain both succeeded (or there was nothing to do). */
  ok: boolean;
  /** Count of local queue entries replayed this drain (0 for an empty queue). */
  drained: number;
}

/**
 * FR-195 (M3) — the queue-drain half of `sync data`, exposed as a structured
 * seam for `boot-sync` so the awaken remote channel reuses the SAME drain code
 * path (#253 / L-253: keep the drain logic in ONE place — never fork it).
 *
 * Delegates straight to `runSyncData()` (no behavior change to `sync data`
 * itself) and maps its exit code to `{ok}`, capturing the entry count via a
 * read-only `inspectQueueDepth` snapshot taken BEFORE the drain (the drain
 * removes the file, so depth must be read first). This is intentionally a thin
 * adapter — it does NOT re-implement the rename/replay/unlink; `runSyncData`
 * remains the single owner of the atomicity contract.
 *
 * NEVER throws: a thrown error from the underlying drain is caught and mapped
 * to `{ok:false, drained:0}` so boot-sync records a skip and continues (the
 * never-block-session-start contract). The `remote_brain`-unconfigured case is
 * handled by `runSyncData` returning exit 1 → `{ok:false}` here; boot-sync's
 * own degraded-mode check short-circuits before calling this, so this path is
 * the belt-and-braces fallback.
 *
 * stdout discipline: `runSyncData` narrates progress via `info()`, which writes
 * to STDOUT. boot-sync emits a JSON digest to stdout, so that chatter would
 * corrupt the digest. This seam (which exists SOLELY to adapt `sync data` for
 * the digest-emitting boot-sync path) flips verbosity to `quiet` around the
 * drain — silencing `info`/`warn` (stdout/stderr noise) while preserving
 * `error` (stderr) — then restores the prior verbosity. This does NOT change
 * `runSyncData` or `sync data`'s own behavior; it only quiets the reused call.
 */
export async function drainSyncQueueOnly(
  opts: SyncDataOptions = {},
): Promise<QueueDrainResult> {
  const slug = opts.projectSlug ?? basenameOfCwd();
  // Read depth BEFORE the drain — runSyncData renames/removes the queue file,
  // so a post-drain inspection would always report zero. Counts live lines in
  // the canonical queue plus any in-flight `.draining-*` temps from a prior
  // crash (those get recovered + replayed by this drain).
  let drained = 0;
  try {
    const depth = inspectQueueDepth(slug);
    drained = depth.liveLines + depth.drainingLines;
  } catch {
    drained = 0;
  }

  // Quiet the reused drain's stdout chatter so the caller's digest stays clean.
  const priorVerbosity = getVerbosity();
  setVerbosity("quiet");
  try {
    const code = await runSyncData(opts);
    // On failure the queue is preserved (not drained) → report 0 drained.
    return { ok: code === 0, drained: code === 0 ? drained : 0 };
  } catch {
    return { ok: false, drained: 0 };
  } finally {
    setVerbosity(priorVerbosity);
  }
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
