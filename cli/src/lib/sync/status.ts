/**
 * `igris sync status [--dry-run]` — status sub-verb.
 *
 * Reports:
 *   - VPS reachability (HTTP GET to <remote_brain.url>/health)
 *   - Sync queue depth (line count of local sync_queue.jsonl PLUS
 *     any `.draining-*` temps from a mid-flight or crashed drain
 *     — FR-128: under-counting during a drain misled operators)
 *   - Stale drains in-progress count (when any `.draining-*` exists)
 *   - Last-push timestamp (mtime of sync_queue.jsonl, OR newest
 *     `.draining-*` mtime when no canonical file, OR "never")
 *   - Brain version (from /health response body when available)
 *
 * No SSH, no MCP tool calls — just an HTTP GET + a couple of fs.stat calls.
 * This makes `sync status` safe to run anywhere (no SSH key required, no
 * VPS config required beyond `remote_brain.url`).
 *
 * `--dry-run` describes what would be checked without making the network
 * call. Useful for hermetic tests and for confirming the config wiring.
 *
 * Tests mock `node:https` / `node:http` at the boundary (per L-159 /
 * TD-098: never `vi.mock` the module under test).
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { healthCheck, readRemoteBrainConfig } from "../mcp-client.js";
import { DryRunCollector } from "../dry-run.js";
import { brainDir } from "../paths.js";
import { basenameOfCwd } from "./util.js";
import { inspectQueueDepth } from "./queue.js";
import { info, warn, error as logError } from "../log.js";

export interface SyncStatusOptions {
  /** When true, describe checks without making network calls. */
  dryRun?: boolean;
  /**
   * Override the project slug used to locate the local sync queue.
   * Defaults to `basename(process.cwd())`.
   */
  projectSlug?: string;
}

export interface SyncStatusReport {
  vpsReachable: boolean;
  vpsHealthStatusCode: number | null;
  brainVersion: string | null;
  /**
   * True queue depth: live `sync_queue.jsonl` lines PLUS any lines
   * currently held in `.draining-*` temps from a mid-flight or
   * crashed drain (FR-128). Without this, a mid-drain status report
   * under-counts and the operator mis-judges queue pressure.
   */
  queueDepth: number;
  queuePath: string;
  lastPushAt: string | null;
  /** Absolute paths of any `sync_queue.jsonl.draining-*` files present (FR-128). */
  drainingFiles?: string[];
  /** Non-empty lines across all `.draining-*` files (subset of queueDepth). */
  drainingLines?: number;
}

/**
 * Run `igris sync status`. Returns process exit code.
 *
 * Exit codes:
 *   0 — status report printed (regardless of VPS reachability)
 *   1 — remote_brain not configured (no URL to check)
 */
export async function runSyncStatus(
  opts: SyncStatusOptions = {},
): Promise<number> {
  const dryRun = opts.dryRun === true;
  const dry = dryRun ? new DryRunCollector() : null;

  const remote = readRemoteBrainConfig();
  if (remote === null) {
    logError(
      "remote_brain config not found in ~/.igris/config.json. Add a 'remote_brain' block with url + api_key to enable status checks.",
    );
    return 1;
  }

  const slug = opts.projectSlug ?? basenameOfCwd();
  const queuePath = join(brainDir(), "projects", slug, "sync_queue.jsonl");

  if (dry !== null) {
    dry.wouldFetchUrl(`${remote.url.replace(/\/$/, "")}/health`);
    dry.print();
    info("");
    info("sync status (dry-run):");
    info(`  remote_brain.url:     ${remote.url}`);
    info(`  local sync queue:     ${queuePath}`);
    info("");
    return 0;
  }

  // Probe remote health.
  const health = await healthCheck(remote.url);
  const vpsReachable = health.statusCode !== null;
  const brainVersion = extractBrainVersion(health.body);

  // Local queue depth + last-push. FR-128: depth = live lines + lines
  // in any `.draining-*` temp files (mid-drain status must not
  // under-report).
  const depth = inspectQueueDepth(slug);
  const queueDepth = depth.liveLines + depth.drainingLines;
  let lastPushAt: string | null = null;
  if (existsSync(queuePath)) {
    try {
      const stat = statSync(queuePath);
      lastPushAt = stat.mtime.toISOString();
    } catch {
      // Queue file unreadable — leave timestamp null.
    }
  } else if (depth.drainingFiles.length > 0) {
    // Canonical queue absent (mid-drain) — fall back to the newest
    // `.draining-*` mtime so the operator still has a timestamp.
    let newest = 0;
    for (const dp of depth.drainingFiles) {
      try {
        const m = statSync(dp).mtime.getTime();
        if (m > newest) newest = m;
      } catch {
        // skip
      }
    }
    if (newest > 0) lastPushAt = new Date(newest).toISOString();
  }

  // Print report.
  info("");
  info("Igris sync status:");
  info(`  remote_brain:    ${remote.url}`);
  info(
    `  reachable:       ${vpsReachable ? "yes" : "no"} (HTTP ${health.statusCode ?? "unreachable"})`,
  );
  info(`  brain version:   ${brainVersion ?? "unknown"}`);
  info(`  queue depth:     ${queueDepth} entries`);
  if (depth.drainingFiles.length > 0) {
    info(
      `  stale drains:    ${depth.drainingFiles.length} in-progress (drainingLines=${depth.drainingLines}) — will be reclaimed by next sync data`,
    );
  }
  info(`  queue path:      ${queuePath}`);
  info(`  last push:       ${lastPushAt ?? "never"}`);
  info("");

  if (!vpsReachable) {
    warn("VPS unreachable — check 'remote_brain.url' or network connectivity.");
  }

  return 0;
}

/**
 * Try to extract a `version` field from the /health response body.
 * The brain's /health endpoint returns a JSON object that historically
 * includes `{status, version, ...}`. Returns null on parse failure.
 */
function extractBrainVersion(body: string): string | null {
  if (body.length === 0) return null;
  try {
    const parsed = JSON.parse(body) as { version?: unknown };
    if (typeof parsed.version === "string") return parsed.version;
    return null;
  } catch {
    return null;
  }
}

