/**
 * `igris project <action>` — per-project brain records written from the CLI.
 * One action today: `watermark` (FR-274). FR-273's `relations` extends this
 * command group rather than minting a second one.
 *
 * `igris project watermark [--project <slug>]` records the KNOWLEDGE
 * WATERMARK: the HEAD SHA and checked-out branch of the project ROW's path
 * (never the session cwd — a worktree hunt's `hunt/*` branch is usually gone
 * after merge), stamped with the DB clock. `/rest` and the SessionEnd hook
 * both call it, so the watermark says which commit the brain's knowledge
 * reflects; `igris_project_status` renders it with a `git log <sha>..` line.
 *
 * WHY A VERB. It is the one surface both a skill and a hook can call (a hook
 * cannot reach MCP), it needs no MCP session and no network (the FR-268
 * `igris ceremony` precedent), and it keeps SQL out of the hook.
 *
 * NEVER BLANKS. A successful read writes all three columns in ONE UPDATE; every
 * failure — path absent, not a repo top level, git missing or failing, unborn
 * HEAD, unregistered slug, a brain without projects:2 — writes NOTHING and
 * names the reason in `skipped[]`.
 *
 * Exit 0 on every record attempt (a session end never blocks on its own
 * telemetry); exit 2 only for an unknown action.
 */

import { basenameOfCwd } from "../lib/sync/util.js";
import { detectCapabilities } from "../lib/detect.js";
import {
  BrainColumnMissingError,
  BrainTableMissingError,
  knowledgeWatermarkWrite,
  readWatermarkTarget,
  type WatermarkTarget,
} from "../lib/brain-db.js";
import { readHeadWatermark } from "../lib/git-head.js";
import type { ProjectWatermarkDigest } from "../types.js";

const VALID_ACTIONS: ReadonlySet<string> = new Set(["watermark"]);

/** Options for {@link runProject}. */
export interface ProjectOptions {
  action: string;
  /** Slug; default = basename of cwd (the `igris ceremony` rule). */
  project?: string;
}

function emit(digest: ProjectWatermarkDigest): number {
  process.stdout.write(JSON.stringify(digest) + "\n");
  return 0;
}

function degrade(digest: ProjectWatermarkDigest, err: unknown): number {
  digest.degraded = true;
  if (err instanceof BrainColumnMissingError) {
    digest.skipped.push("projects:2 not applied — knowledge_* columns absent; rebuild cli + respawn the brain");
  } else if (err instanceof BrainTableMissingError) {
    digest.skipped.push("projects table absent — the brain has not migrated this DB");
  } else {
    digest.skipped.push(`brain write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return emit(digest);
}

/**
 * Run `igris project <action>`. Prints one JSON digest line on stdout.
 *
 * @param opts - The action (`watermark`) and the optional `--project` slug.
 * @returns 0 on every record attempt; 2 on an unknown action.
 */
export function runProject(opts: ProjectOptions): number {
  if (!VALID_ACTIONS.has(opts.action)) {
    process.stderr.write(`error: unknown project action '${opts.action}'. Valid: watermark.\n`);
    return 2;
  }
  // `||`, not `??`: `--project ""` falls to the cwd basename.
  const slug = opts.project || basenameOfCwd();

  const digest: ProjectWatermarkDigest = {
    degraded: false,
    project: slug,
    path: null,
    recorded: false,
    watermark: null,
    previous: null,
    skipped: [],
  };

  if (!detectCapabilities().brain_db) {
    digest.degraded = true;
    digest.skipped.push("brain db absent");
    return emit(digest);
  }

  let target: WatermarkTarget | undefined;
  try {
    target = readWatermarkTarget(slug);
  } catch (err) {
    return degrade(digest, err);
  }
  if (target === undefined) {
    digest.skipped.push("project not registered");
    return emit(digest);
  }
  digest.path = target.path;
  if (typeof target.knowledge_sha === "string" && target.knowledge_sha !== "") {
    digest.previous = {
      sha: target.knowledge_sha,
      branch: target.knowledge_branch,
      recorded_at: target.knowledge_recorded_at,
    };
  }

  const head = readHeadWatermark(target.path);
  if (!head.ok) {
    digest.skipped.push(head.reason);
    return emit(digest);
  }

  try {
    const written = knowledgeWatermarkWrite(slug, head.sha, head.branch);
    if (written === undefined) {
      digest.skipped.push("project not registered");
      return emit(digest);
    }
    digest.recorded = true;
    digest.watermark = written;
  } catch (err) {
    return degrade(digest, err);
  }
  return emit(digest);
}
