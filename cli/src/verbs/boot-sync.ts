/**
 * `igris boot-sync` — the REMOTE channel (FR-195 M3, decision D-B).
 *
 * Reproduces SKILL.md §3.6 (the awaken VPS sync step) as a CLI verb. Two
 * independent parts, each skip-on-fail so the verb NEVER blocks session start
 * (exit 0 even when degraded — a missing/unreachable remote is a local-only
 * run, not an error):
 *
 *   1. Queue drain — drains the local `sync_queue.jsonl` AND triggers the
 *      brain-side `igris_sync_queue_drain` over HTTP, by calling the EXISTING
 *      `drainSyncQueueOnly` seam in `lib/sync/data.ts` (#253 / L-253: the
 *      sync-queue drain lives in ONE code path; boot-sync reuses it, never
 *      forks it). This part is legitimately VPS-side — it drains the VPS's own
 *      queue table, exactly like `sync data`.
 *
 *   2. The VPS→local row pull (D-B) — the directionally-correct reproduction
 *      of the brain's `handleBrainPull` (#169). A CLI process has no stdio MCP
 *      server, so it CANNOT `mcpCall(remote, "igris_brain_pull")` — that runs
 *      the brain's pull handler ON THE VPS against the VPS's OWN db (VPS→VPS,
 *      circular). Instead boot-sync GETs the remote rows over the VPS's
 *      `GET /sync/pull` endpoint (`syncPull` in mcp-client.ts) and merges them
 *      LAST-WRITE-WINS into the LOCAL brain DB (`mergePulledTables` in
 *      brain-db.ts). This is the same client logic the brain runs locally — the
 *      only difference is WHERE the merge lands (the local db, by construction).
 *
 * The plan's "3 directional pulls" (brain_pull / session_file_pull /
 * definition_pull) collapse to this ONE GET: `session_files` and
 * `definition_files` are both in the brain's `SYNC_TABLES`, so `/sync/pull`
 * already carries them. The MCP tools `igris_session_file_pull` /
 * `igris_definition_pull` are LOCAL-DB READERS (they SELECT from the process's
 * own db; brain-mcp-server/src/tools/sync.ts:1499/1601) — NOT remote
 * replicators — so there is no separate remote endpoint to hit for them.
 *
 * Channel: REMOTE (HTTP). The LOCAL merge target is reached through brain-db.ts
 * (in-process better-sqlite3); the network half is mcp-client.ts. stdout is the
 * JSON digest ONLY — all progress notices go through `warn()` (stderr), because
 * `info()` writes to stdout and would corrupt the digest.
 */

import { detectCapabilities } from "../lib/detect.js";
import { readRemoteBrainConfig, syncPull } from "../lib/mcp-client.js";
import { drainSyncQueueOnly } from "../lib/sync/data.js";
import {
  BOOT_SYNC_PULL_TABLES,
  mergePulledTables,
  readPullSince,
} from "../lib/brain-db.js";
import type { PullMergeSummary } from "../lib/brain-db.js";
import { basenameOfCwd } from "../lib/sync/util.js";
import { warn } from "../lib/log.js";
import type {
  BootSyncDigest,
  BootSyncNormalization,
  BootSyncPull,
  BootSyncQueueDrain,
} from "../types.js";

export interface BootSyncOptions {
  /** Project slug override; default basename(cwd) per the sync convention. */
  project?: string;
  /** Emit JSON to stdout (default ON for the awaken path). */
  json?: boolean;
}

/** Empty per-pull / drain / definitions shapes for the skip/degraded branches. */
function skippedPull(reason: string): BootSyncPull {
  return { ok: false, summary: reason };
}
function skippedDrain(): BootSyncQueueDrain {
  return { ok: false, drained: 0 };
}
function noDefinitions(): BootSyncDigest["definitions_updated"] {
  return { agents: 0, skills: 0, rules: 0, prompts: 0 };
}

/**
 * Run the queue drain via the shared `sync data` primitive. Never throws —
 * `drainSyncQueueOnly` maps any failure to `{ok:false, drained:0}`.
 */
async function runQueueDrain(slug: string): Promise<BootSyncQueueDrain> {
  const result = await drainSyncQueueOnly({ projectSlug: slug });
  if (!result.ok) {
    warn("boot-sync: queue drain did not complete (preserving queue for retry).");
  }
  return result;
}

/**
 * Build a short human summary line from the per-table merge counts, e.g.
 * "5 learnings, 2 errors, 1 instances". Lists only tables that received rows
 * with a non-zero merge count; an all-skipped pull yields "no new changes".
 */
function summarizeMerge(perTable: Record<string, { inserted: number; updated: number }>): string {
  const parts: string[] = [];
  for (const config of BOOT_SYNC_PULL_TABLES) {
    const r = perTable[config.table];
    if (!r) continue;
    const merged = r.inserted + r.updated;
    if (merged > 0) parts.push(`${merged} ${config.table}`);
  }
  return parts.length > 0 ? parts.join(", ") : "no new changes";
}

/**
 * TD-338 — render the ingress-normalization report, or `undefined` when the
 * pull folded nothing and received nothing non-canonical.
 *
 * The table name is carried in each line rather than nesting per-table, because
 * the operator question this answers is "what did sync rewrite on the way in",
 * not "how did each table fare". Every fold and every passthrough is NAMED —
 * the fold is allowed to be lossy only in the sense the fold table already
 * licenses, and never silently.
 */
function describeNormalization(
  summary: PullMergeSummary,
): BootSyncNormalization | undefined {
  if (
    summary.totalNormalized === 0 &&
    summary.normalizations.length === 0 &&
    summary.nonCanonical.length === 0
  ) {
    return undefined;
  }
  // CAVEAT: this resolves a key back to its table by SEARCHING the per-table
  // results, which is exact only while at most one pulled table maps that key.
  // True today — `SYNC_NORMALIZED_FIELDS` maps `brief_status` alone — but if a
  // second table ever normalizes and shares a syncKey shape, carry the table
  // name on the record instead of recovering it here.
  const tableOf = (key: string): string => {
    for (const config of BOOT_SYNC_PULL_TABLES) {
      const r = summary.perTable[config.table];
      if (!r) continue;
      if (
        r.normalizations?.some((n) => n.key === key) ||
        r.nonCanonical?.some((n) => n.key === key)
      ) {
        return config.table;
      }
    }
    return "?";
  };
  return {
    normalized: summary.totalNormalized,
    folds: summary.normalizations.map(
      (n) =>
        `${tableOf(n.key)} ${n.key}: ${n.field} ${JSON.stringify(n.from)} -> ${JSON.stringify(n.to)}`,
    ),
    non_canonical: summary.nonCanonical.map(
      (n) => `${tableOf(n.key)} ${n.key}: ${n.field}=${JSON.stringify(n.value)}`,
    ),
  };
}

/**
 * The VPS→local row pull. GETs `/sync/pull` for every boot-sync table (sending
 * each table's local `last_pull_at` as the `since_*` cursor), then merges the
 * returned rows LWW into the local DB. Returns the pull result plus the
 * session-files count and per-type definition counts the digest surfaces.
 *
 * Never throws: a network failure (statusCode 0 / non-200) or a local merge
 * error is caught and mapped to `{ok:false}` so the drain result still reports
 * and the verb exits 0.
 */
async function runRemotePull(
  remoteUrl: string,
  apiKey: string,
): Promise<{
  pull: BootSyncPull;
  sessionFilesPulled: number;
  definitions: BootSyncDigest["definitions_updated"];
}> {
  // Build the per-table `since` cursor map from the local sync_state. A brain
  // DB missing sync_state yields epoch cursors (full pull) — readPullSince
  // handles that without throwing.
  const sinceByTable: Record<string, string> = {};
  try {
    for (const config of BOOT_SYNC_PULL_TABLES) {
      sinceByTable[config.table] = readPullSince(remoteUrl, config.table);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`boot-sync: could not read pull cursors: ${msg}`);
    return {
      pull: skippedPull(`pull cursor read failed: ${msg}`),
      sessionFilesPulled: 0,
      definitions: noDefinitions(),
    };
  }

  const resp = await syncPull({ url: remoteUrl, apiKey }, sinceByTable);
  if (resp.statusCode !== 200) {
    const reason =
      resp.statusCode === 0
        ? `remote unreachable: ${resp.body}`
        : `remote pull HTTP ${resp.statusCode}`;
    warn(`boot-sync: ${reason}; skipping pull (local brain unchanged).`);
    return {
      pull: skippedPull(reason),
      sessionFilesPulled: 0,
      definitions: noDefinitions(),
    };
  }

  // Count the per-type definition rows BEFORE merging (the merge result is
  // per-table, not per-type; the digest wants the type split). The pull body's
  // `definition_files` rows carry a `type` column.
  const definitions = noDefinitions();
  const defRows = resp.tables["definition_files"];
  if (Array.isArray(defRows)) {
    for (const row of defRows) {
      const t = (row as { type?: unknown }).type;
      if (t === "agent") definitions.agents++;
      else if (t === "skill") definitions.skills++;
      else if (t === "rule") definitions.rules++;
      else if (t === "prompt") definitions.prompts++;
    }
  }

  // Merge LWW into the LOCAL db. mergePulledTables wraps the whole set in a
  // transaction and advances sync_state.last_pull_at per merged table.
  try {
    const summary = mergePulledTables(remoteUrl, resp.tables);
    const sf = summary.perTable["session_files"];
    const sessionFilesPulled = sf ? sf.inserted + sf.updated : 0;
    const pull: BootSyncPull = {
      ok: true,
      summary: summarizeMerge(summary.perTable),
    };
    // TD-338: attach the ingress-normalization report ONLY when there is
    // something to say. A clean pull leaves the digest byte-identical to its
    // pre-TD-338 shape — the honesty contract adds signal, not noise.
    const normalization = describeNormalization(summary);
    if (normalization) pull.normalization = normalization;
    return { pull, sessionFilesPulled, definitions };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`boot-sync: local merge failed: ${msg}; sync state NOT advanced.`);
    return {
      pull: skippedPull(`local merge failed: ${msg}`),
      sessionFilesPulled: 0,
      definitions: noDefinitions(),
    };
  }
}

/**
 * Build the boot-sync digest. Both parts (queue drain + remote pull) run
 * independently; either's failure is recorded without aborting the other.
 *
 * When `remote_brain` is unconfigured the verb is fully degraded: the pull is
 * skipped (`skipped: ["remote unconfigured"]`) AND the queue drain is skipped
 * (the drain requires the remote — `runSyncData` returns exit 1 with no remote;
 * recording it as a skip is more honest than a spurious `ok:false`). exit 0.
 */
export async function buildBootSyncDigest(slug: string): Promise<BootSyncDigest> {
  const caps = detectCapabilities();
  const remote = readRemoteBrainConfig();

  if (remote === null || !caps.remote_brain) {
    // Fully degraded — no remote configured. Skip both the pull and the drain
    // (both depend on the remote). Never block: exit 0 with a skipped note.
    return {
      degraded: true,
      brain_pull: skippedPull("remote unconfigured"),
      queue_drain: skippedDrain(),
      session_files_pulled: 0,
      definitions_updated: noDefinitions(),
      skipped: ["remote unconfigured"],
    };
  }

  const skipped: string[] = [];

  // Part 1 — queue drain (independent). Reuses the `sync data` primitive.
  const queueDrain = await runQueueDrain(slug);
  if (!queueDrain.ok) skipped.push("queue drain incomplete");

  // Part 2 — the VPS→local row pull (independent of part 1's outcome).
  const { pull, sessionFilesPulled, definitions } = await runRemotePull(
    remote.url,
    remote.apiKey,
  );
  if (!pull.ok) skipped.push("remote pull skipped");

  return {
    degraded: false,
    brain_pull: pull,
    queue_drain: queueDrain,
    session_files_pulled: sessionFilesPulled,
    definitions_updated: definitions,
    skipped,
  };
}

/**
 * Run the boot-sync verb. ALWAYS exit 0 (the remote channel never blocks
 * session start); the digest's `degraded` + per-part `ok` flags + `skipped`
 * list tell the skill what ran.
 */
export async function runBootSync(opts: BootSyncOptions): Promise<number> {
  const slug = opts.project ?? basenameOfCwd();
  const json = opts.json !== false;

  const digest = await buildBootSyncDigest(slug);
  if (json) process.stdout.write(JSON.stringify(digest) + "\n");
  return 0;
}
