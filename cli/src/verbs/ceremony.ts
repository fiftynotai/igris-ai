/**
 * `igris ceremony start|stop --name <boot|rest|register|hunt-init>` — the
 * brain-timed ceremony stamp (FR-268).
 *
 * WHY A VERB AND NOT PROSE. Per-skill invocation telemetry was dropped in
 * June 2026 because it was prose the orchestrator was asked to emit, and
 * prose is not a control (L-1314; FR-267 measured prose emission at 31 %).
 * The four ceremony skills now call THIS verb as their first and last
 * executable step; `scripts/validate_ceremony_sites.sh` hard-fails a skill
 * that loses a stamp site, and `igris kpi` reports unpaired starts per week.
 *
 * WHY THE CLI WRITE DOOR AND NOT AN MCP TOOL. `boot`'s start must run before
 * the brain MCP session exists (it is the first executable step); the local
 * write door (`brain-db.ts#ceremonyEventWrite`, create-never, the precedent
 * `session register` set) needs no MCP session and no network. The brain
 * still owns the schema (instances migration v4) and the clock: `created_at`
 * is `datetime('now')` on the row, `duration_ms` is computed IN SQL from the
 * paired open start — the verb never passes a timestamp (§18.10).
 *
 * The vocabulary is THIS allowlist, not a DDL CHECK (SQLite cannot widen a
 * CHECK): adding a ceremony is a verb edit + one skill pair + one validator
 * row, never a migration.
 *
 * Exit 0 ALWAYS on a stamp attempt — a ceremony never blocks on its own
 * telemetry; `degraded` + `skipped[]` say what did not land. Exit 2 only on
 * a malformed invocation (unknown action / name, missing --name), which is an
 * authoring error the validator also catches.
 */

import { ensureMachineIdentity } from "../lib/machine-identity.js";
import { basenameOfCwd } from "../lib/sync/util.js";
import { detectCapabilities } from "../lib/detect.js";
import { BrainTableMissingError, ceremonyEventWrite } from "../lib/brain-db.js";
import type { CeremonyDigest, CeremonyName } from "../types.js";

export type CeremonyAction = "start" | "stop";

/** The ceremonies the record admits — one skill pair + one validator row each. */
export const CEREMONY_NAMES: readonly CeremonyName[] = ["boot", "rest", "register", "hunt-init"];

const VALID_ACTIONS: ReadonlySet<string> = new Set(["start", "stop"]);

export interface CeremonyOptions {
  action: string;
  name?: string;
  /** Slug; default = basename of cwd (the `igris instance` / `igris detect` rule). */
  project?: string;
  instanceId?: string;
  brief?: string;
  json?: boolean;
}

function isCeremonyName(s: string): s is CeremonyName {
  return (CEREMONY_NAMES as readonly string[]).includes(s);
}

function emit(digest: CeremonyDigest): number {
  process.stdout.write(JSON.stringify(digest) + "\n");
  return 0;
}

export function runCeremony(opts: CeremonyOptions): number {
  if (!VALID_ACTIONS.has(opts.action)) {
    process.stderr.write(`error: unknown ceremony action '${opts.action}'. Valid: start, stop.\n`);
    return 2;
  }
  const action = opts.action as CeremonyAction;
  if (opts.name === undefined || opts.name === "") {
    process.stderr.write(`error: ceremony ${action} requires --name <${CEREMONY_NAMES.join("|")}>.\n`);
    return 2;
  }
  if (!isCeremonyName(opts.name)) {
    process.stderr.write(
      `error: unknown ceremony name '${opts.name}'. Valid: ${CEREMONY_NAMES.join(", ")}.\n`,
    );
    return 2;
  }
  const name = opts.name;
  // `||`, not `??`: `--project ""` must fall to the cwd basename, never store an empty slug.
  const slug = opts.project || basenameOfCwd();

  const digest: CeremonyDigest = {
    degraded: false,
    ceremony: name,
    event_type: action,
    project: slug,
    id: null,
    created_at: null,
    paired: null,
    paired_start_id: null,
    duration_ms: null,
    warnings: [],
    skipped: [],
  };

  const caps = detectCapabilities();
  if (!caps.brain_db) {
    digest.degraded = true;
    digest.skipped.push("brain db absent");
    return emit(digest);
  }

  try {
    // BR-100: a writer; pairs on the identity (brain-db).
    const me = ensureMachineIdentity();
    const row = ceremonyEventWrite({
      project: slug,
      ceremony: name,
      event_type: action,
      machine_hostname: me.hostname,
      machine_id: me.machine_id,
      aliases: me.aliases,
      instance_id: opts.instanceId ?? null,
      brief_id: opts.brief ?? null,
    });
    digest.id = row.id;
    digest.created_at = row.created_at;
    digest.paired = row.paired;
    digest.paired_start_id = row.paired_start_id;
    digest.duration_ms = row.duration_ms;
    if (action === "stop" && row.paired === false) {
      digest.warnings.push(`unpaired stop — no open start for ${name} in ${slug} on this host`);
    }
  } catch (err) {
    digest.degraded = true;
    if (err instanceof BrainTableMissingError) {
      digest.skipped.push(
        "ceremony_events absent — brain older than FR-268 (instances v4); rebuild cli + respawn the brain",
      );
    } else {
      digest.skipped.push(`write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return emit(digest);
}
