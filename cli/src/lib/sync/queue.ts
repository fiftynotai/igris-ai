/**
 * `cli/src/lib/sync/queue.ts` — the atomic sync-queue drain primitive (FR-128).
 *
 * Centralises the rename-then-process drain algorithm so EVERY drain
 * call-site (`igris sync data`, `/awaken`, `/rest`, future doctor verbs)
 * exercises the same atomicity contract. L-253 was explicit: "Keep the
 * drain logic in one code path." `data.ts`/`status.ts` delegate here.
 *
 * Atomicity contract (the AC bullet pinned by FR-128):
 *   The sync-queue drain is atomic — a line appended by a sibling
 *   harness during a drain is never silently lost. The rename in
 *   `acquireDrainSnapshot` is the load-bearing moment: POSIX `rename(2)`
 *   is atomic on the same filesystem, so an append landing AFTER the
 *   rename creates a fresh `sync_queue.jsonl` (the open-with-O_APPEND
 *   writes go to whatever inode the path resolves to at write time);
 *   the appended line is therefore picked up by the next drain instead
 *   of being truncated alongside the drained set.
 *
 * Algorithm (load-bearing path):
 *   1. recoverStaleDrains(slug) — self-heal any `.draining-*` files left
 *      by a crashed prior drain. Idempotent: empty glob is a no-op.
 *   2. acquireDrainSnapshot(slug):
 *        a. if no canonical queue file, return null (nothing to drain).
 *        b. compute tempPath = `<queue>.draining-<pid>-<unix_ms>`.
 *        c. renameSync(queuePath, tempPath) — THE atomic moment.
 *        d. readFileSync(tempPath), parse, return {tempPath, entries}.
 *   3. caller replays entries via its own per-op dispatcher.
 *   4. finalizeDrainSnapshot(snapshot, success):
 *        - success=true  → unlinkSync(tempPath).
 *        - success=false → leave temp in place for next recovery, OR
 *          restore immediately if no fresh queue file appeared.
 *
 * Crash recovery (Q3 in the plan): a stale `.draining-*` is reclaimed by
 * the NEXT drain via `recoverStaleDrains`. No separate skill ritual; the
 * drain primitive self-heals. The first thing every snapshot acquisition
 * does is recovery — so a single `/sync data` after a crash is enough.
 *
 * Naming convention (Q2 in the plan): `sync_queue.jsonl.draining-<pid>-<ms>`
 * - Same directory → renameSync is guaranteed atomic (same filesystem).
 * - <pid>-<ms> pair is collision-proof inside a single boot window.
 * - Glob `sync_queue.jsonl.draining-*` finds every stale file.
 *
 * Append-during-rename benignness (risk row 1 in the plan):
 * If instance B is mid-`open(O_APPEND)` when A renames, B's write lands
 * in A's temp (the renamed inode), not the new canonical file. This is
 * correct: B's line ends up in A's drain set and gets processed; the
 * brain-side ON CONFLICT dedupe makes any rare double-processing benign.
 *
 * Synchronous fs APIs throughout (matches `data.ts`/`status.ts` style);
 * NO async/await within the rename → read → finalise window — the whole
 * atomicity argument stays local in one straight-line code path.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { brainDir } from "../paths.js";

/** Resolved snapshot of a renamed queue ready for replay. */
export interface DrainSnapshot {
  /** Absolute path to the renamed `.draining-<pid>-<ms>` temp file. */
  tempPath: string;
  /** Absolute path to the canonical `sync_queue.jsonl`. */
  queuePath: string;
  /** Non-empty, trimmed JSON-lines from the temp file (parse is the caller's job). */
  entries: string[];
}

/** Report describing what `recoverStaleDrains` reclaimed. */
export interface RecoveryReport {
  /** Absolute paths of `.draining-*` files that were reclaimed. */
  recoveredFiles: string[];
  /** Total non-empty lines merged from stale temps into the canonical queue. */
  mergedLines: number;
}

/** Read-only inspection result for `runSyncStatus`. */
export interface QueueDepthInspection {
  /** Non-empty lines in the canonical `sync_queue.jsonl` (0 when absent). */
  liveLines: number;
  /** Non-empty lines across every `.draining-*` file in the project dir. */
  drainingLines: number;
  /** Absolute paths of any `.draining-*` files currently on disk. */
  drainingFiles: string[];
}

/** Project-dir-relative basename of the canonical queue file. */
const QUEUE_BASENAME = "sync_queue.jsonl";
/** Prefix used to detect `.draining-*` temps via `readdirSync`. */
const DRAINING_PREFIX = `${QUEUE_BASENAME}.draining-`;

/** Compute the absolute path to a project's canonical queue file. */
function queuePathFor(slug: string): string {
  return join(brainDir(), "projects", slug, QUEUE_BASENAME);
}

/** List absolute paths of every `.draining-*` file in the project dir. */
function listStaleDrainingFiles(slug: string): string[] {
  const projectDir = dirname(queuePathFor(slug));
  if (!existsSync(projectDir)) return [];
  let names: string[];
  try {
    names = readdirSync(projectDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(DRAINING_PREFIX))
    .map((n) => join(projectDir, n));
}

/** Split a file's contents into trimmed, non-empty lines. */
function nonEmptyLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Scan the project dir for any `sync_queue.jsonl.draining-*` files left
 * by a crashed prior drain and reclaim them into the canonical queue.
 *
 * Reclamation rules:
 *   - If no canonical `sync_queue.jsonl` exists: `renameSync(stale, queuePath)`.
 *     The stale file becomes the new canonical queue verbatim.
 *   - If `sync_queue.jsonl` exists: read both, PREPEND stale lines to
 *     the canonical lines (preserves first-in-first-out time-order
 *     across the crash), write through a `.merge-tmp` temp + atomic
 *     renameSync over the canonical name, then unlink the stale.
 *
 * Idempotent: an empty glob is a no-op. Safe to call from every drain.
 */
export function recoverStaleDrains(slug: string): RecoveryReport {
  const queuePath = queuePathFor(slug);
  const stale = listStaleDrainingFiles(slug);
  const report: RecoveryReport = { recoveredFiles: [], mergedLines: 0 };
  if (stale.length === 0) return report;

  // Stable processing order: name-sorted so a deterministic prepend chain
  // results when there are multiple stale files (the unix-ms suffix is
  // monotonic within a boot so this also matches time-order).
  stale.sort();

  for (const stalePath of stale) {
    let staleLines: string[];
    try {
      staleLines = nonEmptyLines(readFileSync(stalePath, "utf-8"));
    } catch {
      // Unreadable stale — leave on disk for operator inspection; do
      // NOT mark as recovered. The next call will re-attempt.
      continue;
    }

    if (!existsSync(queuePath)) {
      // No live queue → adopt the stale verbatim. The atomic rename
      // promotes the stale inode to the canonical name in one syscall.
      renameSync(stalePath, queuePath);
      report.recoveredFiles.push(stalePath);
      report.mergedLines += staleLines.length;
      continue;
    }

    // Canonical queue already exists — merge stale lines at the HEAD
    // (the stale entries were enqueued BEFORE the current canonical
    // entries, by time-order: the crash interrupted an older drain).
    let liveLines: string[];
    try {
      liveLines = nonEmptyLines(readFileSync(queuePath, "utf-8"));
    } catch {
      // If the live queue is unreadable, fall back to leaving stale
      // on disk for the next attempt.
      continue;
    }
    const merged = [...staleLines, ...liveLines];
    const mergeTmp = `${queuePath}.merge-tmp`;
    const body = merged.length === 0 ? "" : merged.join("\n") + "\n";
    writeFileSync(mergeTmp, body);
    renameSync(mergeTmp, queuePath);
    unlinkSync(stalePath);
    report.recoveredFiles.push(stalePath);
    report.mergedLines += staleLines.length;
  }

  return report;
}

/**
 * Acquire an atomic snapshot of the queue for processing.
 *
 * Returns `null` when there is nothing to drain (no canonical queue
 * file present after self-healing). Otherwise returns a `DrainSnapshot`
 * whose `tempPath` is the renamed file and whose `entries` are the
 * non-empty trimmed JSON lines parsed from it.
 *
 * The caller MUST call `finalizeDrainSnapshot(snapshot, ok)` exactly
 * once when done — success unlinks the temp; failure leaves it for the
 * next drain's recovery pass to reclaim.
 *
 * Defensive assert: the temp path is constructed by appending to the
 * source path so `dirname(tempPath) === dirname(queuePath)` always
 * holds (renameSync atomicity requires same filesystem; we enforce
 * same directory which is a strictly stronger guarantee).
 */
export function acquireDrainSnapshot(slug: string): DrainSnapshot | null {
  // Self-heal any stale temps from a prior crashed drain BEFORE we
  // touch the canonical queue. After this call, all surviving entries
  // are in `sync_queue.jsonl`.
  recoverStaleDrains(slug);

  const queuePath = queuePathFor(slug);
  if (!existsSync(queuePath)) return null;

  const tempPath = `${queuePath}.draining-${process.pid}-${Date.now()}`;
  if (dirname(tempPath) !== dirname(queuePath)) {
    // Belt-and-braces — string concat keeps same directory by
    // construction. If this ever fires, the rename atomicity argument
    // is invalidated and we MUST abort rather than do a non-atomic
    // copy+delete fallback.
    throw new Error(
      `acquireDrainSnapshot: temp path ${tempPath} is not in the same dir as ${queuePath}`,
    );
  }

  // THE atomic moment. Any sibling-harness append landing AFTER this
  // call creates a fresh `sync_queue.jsonl`; this drain's set is
  // frozen as of the inode that was at queuePath at this instant.
  renameSync(queuePath, tempPath);

  const raw = readFileSync(tempPath, "utf-8");
  const entries = nonEmptyLines(raw);
  return { tempPath, queuePath, entries };
}

/**
 * Finalise a drain snapshot.
 *
 * On `success === true`: the snapshot's temp file is unlinked — the
 * drain is complete and the queue is clean.
 *
 * On `success === false`: the temp file is preserved for the next
 * drain's `recoverStaleDrains` pass to reclaim. As an optimisation,
 * if NO fresh `sync_queue.jsonl` has appeared in the meantime, the
 * temp is renamed back to the canonical name in one atomic step so
 * the queue is immediately observable to status/other harnesses (no
 * crash-recovery dependency for the common case).
 */
export function finalizeDrainSnapshot(
  snapshot: DrainSnapshot,
  success: boolean,
): void {
  if (success) {
    try {
      unlinkSync(snapshot.tempPath);
    } catch {
      // The drain succeeded but unlink failed (permission? race with
      // another janitor?). The file is now stale-but-harmless: the
      // next drain's recoverStaleDrains will reclaim it, and the
      // brain-side ON CONFLICT dedupe makes any re-replay a no-op.
    }
    return;
  }

  // Failure path — leave the temp in place for next-drain recovery.
  // If no fresh queue file has appeared, rename the temp back to
  // canonical so a follow-up `igris sync data` finds a normal queue
  // (and so `inspectQueueDepth` reports the same depth as before).
  if (!existsSync(snapshot.queuePath)) {
    try {
      renameSync(snapshot.tempPath, snapshot.queuePath);
      return;
    } catch {
      // Fall through — leave the .draining-* in place; recovery
      // will reclaim on next drain.
    }
  }
  // Canonical queue already has appended entries from a sibling;
  // leave the temp where it is and let recoverStaleDrains merge.
}

/**
 * Read-only queue inspection for `runSyncStatus`.
 *
 * Counts non-empty lines in the canonical `sync_queue.jsonl` AND every
 * `.draining-*` temp currently on disk. A mid-drain status report
 * MUST surface the temp-file lines too — otherwise the operator sees
 * a misleadingly low depth while a drain is in flight.
 */
export function inspectQueueDepth(slug: string): QueueDepthInspection {
  const queuePath = queuePathFor(slug);
  let liveLines = 0;
  if (existsSync(queuePath)) {
    try {
      liveLines = nonEmptyLines(readFileSync(queuePath, "utf-8")).length;
    } catch {
      // Queue unreadable → treat as zero; status surfaces nothing
      // misleading and the operator sees the broader status anyway.
    }
  }

  const drainingFiles = listStaleDrainingFiles(slug);
  let drainingLines = 0;
  for (const dp of drainingFiles) {
    try {
      drainingLines += nonEmptyLines(readFileSync(dp, "utf-8")).length;
    } catch {
      // Unreadable temp → ignore (matches the canonical-read branch).
    }
  }

  return { liveLines, drainingLines, drainingFiles };
}
