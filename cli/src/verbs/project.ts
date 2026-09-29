/**
 * `igris project <action>` — per-project brain records. Actions: `watermark`
 * (FR-274, a write), and FR-273's READ verbs `relations` (the lookup and the
 * `--boot` line) and `kinds list`, which run the brain's relations action layer
 * from the vendored bundle (`brain-bridge.ts#loadRelationsActions`) on a
 * `query_only` handle — the CLI holds zero relations SQL. The WRITE verbs
 * (`relate`, `unrelate`, `kinds add|alias|merge`) run the same module on the
 * create-never write door (`withBrainWriteDoor`).
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
 * telemetry); exit 2 only for an unknown action or an unexpected argument.
 */

import { basenameOfCwd } from "../lib/sync/util.js";
import { detectCapabilities } from "../lib/detect.js";
import {
  BrainColumnMissingError,
  BrainDbAbsentError,
  BrainTableMissingError,
  withBrainWriteDoor,
  knowledgeWatermarkWrite,
  readWatermarkTarget,
  type WatermarkTarget,
} from "../lib/brain-db.js";
import { readHeadWatermark } from "../lib/git-head.js";
import { brainDbPath } from "../lib/paths.js";
import {
  lastRelationsActionsFailure,
  loadRelationsActions,
  loadVendoredEmbeddings,
  openBrainReadonly,
  type RelationActionResult,
  type RelationsActionsModule,
} from "../lib/brain-bridge.js";
import type {
  ProjectWriteDigest,
  ProjectKindsDigest,
  ProjectRelationsBootDigest,
  ProjectRelationsDigest,
  ProjectWatermarkDigest,
} from "../types.js";
import { existsSync } from "node:fs";

const VALID_ACTIONS = "watermark, relations, relate, unrelate, kinds";

/** Options for {@link runProject} / {@link runProjectCommand}. */
export interface ProjectOptions {
  action: string;
  /** Positional arguments after the action (`kinds list`). */
  args?: string[];
  /** Slug; default = basename of cwd (the `igris ceremony` rule). */
  project?: string;
  /** relations: hops to follow (an integer; the action layer clamps to 5). */
  depth?: string;
  /** relations: out | in | both. */
  direction?: string;
  /** relations: only this kind (an alias resolves). */
  kind?: string;
  /** relations: `--no-check` sets false — no watermark git checks. */
  check?: boolean;
  /** relations: print the one-line /boot digest instead of the lookup. */
  boot?: boolean;
  /** relate: repeatable `k=v` detail pairs. */
  detail?: string[];
  /** kinds add: the new kind's fields (`--kind-direction`: `--direction` is traversal). */
  meaning?: string;
  kindDirection?: string;
  forwardLabel?: string;
  inverseLabel?: string;
  example?: string;
  /** kinds add: repeatable aliases. */
  alias?: string[];
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
  if (opts.action !== "watermark") {
    process.stderr.write(`error: unknown project action '${opts.action}'. Valid: ${VALID_ACTIONS}.\n`);
    return 2;
  }
  if ((opts.args ?? []).length > 0) {
    process.stderr.write(`error: unexpected argument '${opts.args![0]}' for 'project watermark'.\n`);
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

// ---------------------------------------------------------------------------
// FR-273 — the relations READ verbs
// ---------------------------------------------------------------------------

function usage(message: string): number {
  process.stderr.write(`error: ${message}\n`);
  return 2;
}

function print(digest: unknown): number {
  process.stdout.write(JSON.stringify(digest) + "\n");
  return 0;
}

/**
 * Open the vendored relations module and a READ-ONLY handle, or name why not.
 * Never creates a DB (`openBrainReadonly` is `fileMustExist`).
 */
async function relationsContext(): Promise<
  { ok: true; mod: RelationsActionsModule; db: NonNullable<ReturnType<typeof openBrainReadonly>> } | { ok: false; reason: string }
> {
  if (!existsSync(brainDbPath())) return { ok: false, reason: "brain db absent" };
  const mod = await loadRelationsActions();
  if (mod === null) return { ok: false, reason: `brain relations module unavailable: ${lastRelationsActionsFailure() ?? "unknown"}` };
  const db = openBrainReadonly();
  if (db === null) return { ok: false, reason: "brain db could not be opened read-only" };
  return { ok: true, mod, db };
}

/**
 * `igris project relations` — the lookup digest, or with `--boot` the one-line
 * /boot digest. Exit 0 always (degraded included); 2 on a usage error.
 */
async function runRelations(opts: ProjectOptions): Promise<number> {
  if ((opts.args ?? []).length > 0) return usage(`unexpected argument '${opts.args![0]}' for 'project relations'.`);
  const lookupArgs: Record<string, unknown> = {};
  if (opts.depth !== undefined) {
    if (!/^[1-9][0-9]*$/.test(opts.depth)) return usage(`--depth must be a positive integer (got '${opts.depth}').`);
    lookupArgs.depth = Number(opts.depth);
  }
  if (opts.direction !== undefined) {
    if (!["out", "in", "both"].includes(opts.direction)) return usage(`--direction must be out, in or both (got '${opts.direction}').`);
    lookupArgs.direction = opts.direction;
  }
  if (opts.kind !== undefined) lookupArgs.kind = opts.kind;
  if (opts.check === false) lookupArgs.check_watermarks = false;
  const slug = opts.project || basenameOfCwd();

  const ctx = await relationsContext();
  if (opts.boot === true) {
    if (!ctx.ok) {
      const d: ProjectRelationsBootDigest = { degraded: true, reason: ctx.reason, project: slug, registered: false, line: null, neighbours: 0 };
      return print(d);
    }
    try {
      return print(ctx.mod.relationsBootDigest(ctx.db, slug));
    } catch (err) {
      const d: ProjectRelationsBootDigest = { degraded: true, reason: `brain read failed: ${err instanceof Error ? err.message : String(err)}`, project: slug, registered: false, line: null, neighbours: 0 };
      return print(d);
    } finally {
      ctx.db.close();
    }
  }

  const digest: ProjectRelationsDigest = { degraded: false, reason: null, project: slug, relations: null };
  if (!ctx.ok) {
    digest.degraded = true;
    digest.reason = ctx.reason;
    return print(digest);
  }
  try {
    const result = await ctx.mod.lookupAction(ctx.db, { slug, ...lookupArgs });
    if (!result.ok && result.refused?.code === "not_migrated") {
      digest.degraded = true;
      digest.reason = result.refused.message;
    } else {
      digest.relations = result;
    }
  } catch (err) {
    digest.degraded = true;
    digest.reason = `brain read failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    ctx.db.close();
  }
  return print(digest);
}

/** `igris project kinds list` — the registry. Round A: `list` only. */
async function runKinds(opts: ProjectOptions): Promise<number> {
  const [sub, ...rest] = opts.args ?? [];
  if (sub === "add" || sub === "alias" || sub === "merge") return runWrite(`kinds.${sub}`, rest, opts);
  if (sub !== "list") return usage(`unknown kinds action '${sub ?? ""}'. Valid: list, add, alias, merge.`);
  if (rest.length > 0) return usage(`unexpected argument '${rest[0]}' for 'project kinds list'.`);
  const digest: ProjectKindsDigest = { degraded: false, reason: null, action: "kinds.list", ok: false, result: null };
  const ctx = await relationsContext();
  if (!ctx.ok) {
    digest.degraded = true;
    digest.reason = ctx.reason;
    return print(digest);
  }
  try {
    const result = await ctx.mod.kindsAction(ctx.db, { action: "list" });
    if (!result.ok && result.refused?.code === "not_migrated") {
      digest.degraded = true;
      digest.reason = result.refused.message;
    } else {
      digest.ok = result.ok;
      digest.result = result;
    }
  } catch (err) {
    digest.degraded = true;
    digest.reason = `brain read failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    ctx.db.close();
  }
  return print(digest);
}

/**
 * The `igris project <action> [args...]` entry point: `relations` and `kinds`
 * are async (they load the vendored module); `watermark` and an unknown action
 * go to {@link runProject}.
 */
export async function runProjectCommand(opts: ProjectOptions): Promise<number> {
  if (opts.action === "relations") return runRelations(opts);
  if (opts.action === "kinds") return runKinds(opts);
  if (opts.action === "relate" || opts.action === "unrelate") return runWrite(opts.action, opts.args ?? [], opts);
  return runProject(opts);
}

// — FR-273 D11: the WRITE verbs (exit 0 written / 1 refused / 2 usage / 3 degraded)

type WriteAction = ProjectWriteDigest["action"];
const WRITE_ARITY: Record<WriteAction, number> = { relate: 3, unrelate: 3, "kinds.add": 1, "kinds.alias": 2, "kinds.merge": 2 };
const RELATION_TABLES = ["project_relation_kinds", "project_relations"];

// `k=v` pairs → a detail map; null when one is malformed.
function parseDetail(pairs: string[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i <= 0 || i === p.length - 1) return null;
    out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}

async function runWrite(action: WriteAction, args: string[], opts: ProjectOptions): Promise<number> {
  const want = WRITE_ARITY[action];
  if (args.length !== want) {
    return usage(`'project ${action.replace(".", " ")}' takes ${want} argument(s), got ${args.length}.`);
  }
  let detail: Record<string, string> | undefined;
  if ((opts.detail ?? []).length > 0) {
    if (action !== "relate") return usage("--detail applies to 'project relate' only.");
    const d = parseDetail(opts.detail!);
    if (d === null) return usage("--detail takes key=value (non-empty key and value).");
    detail = d;
  }
  let call: (m: RelationsActionsModule, db: Parameters<RelationsActionsModule["relateAction"]>[0]) => Promise<RelationActionResult>;
  if (action === "relate" || action === "unrelate") {
    const [from, kind, to] = args;
    const a = { action: action === "relate" ? "declare" : "remove", from, kind, to, ...(detail ? { detail } : {}) };
    call = (m, db) => m.relateAction(db, a);
  } else if (action === "kinds.add") {
    const a: Record<string, unknown> = {
      action: "add", name: args[0], meaning: opts.meaning, direction: opts.kindDirection,
      forward_label: opts.forwardLabel, inverse_label: opts.inverseLabel, example: opts.example,
    };
    if ((opts.alias ?? []).length > 0) a.aliases = opts.alias;
    call = (m, db) => m.kindsAction(db, a);
  } else if (action === "kinds.alias") {
    call = (m, db) => m.kindsAction(db, { action: "alias", name: args[0], alias: args[1] });
  } else {
    call = (m, db) => m.kindsAction(db, { action: "merge", retired: args[0], survivor: args[1] });
  }

  const digest: ProjectWriteDigest = { degraded: false, reason: null, action, ok: false, result: null, replication: null };
  const degrade = (reason: string): number => {
    digest.degraded = true;
    digest.reason = reason;
    print(digest);
    return 3;
  };
  if (!existsSync(brainDbPath())) return degrade("brain db absent");
  const mod = await loadRelationsActions();
  if (mod === null) return degrade(`brain relations module unavailable: ${lastRelationsActionsFailure() ?? "unknown"}`);
  const emb = await loadVendoredEmbeddings();
  let result: RelationActionResult;
  try {
    result = await withBrainWriteDoor(RELATION_TABLES, (db) => call(mod, db), {
      beforeClose: () => emb?.disposeEmbeddingPipeline(),
    });
  } catch (err) {
    if (err instanceof BrainDbAbsentError) return degrade("brain db absent");
    if (err instanceof BrainTableMissingError) return degrade(`projects:3 not applied — ${err.message}`);
    return degrade(`brain write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!result.ok && result.refused?.code === "not_migrated") return degrade(result.refused.message);
  digest.ok = result.ok;
  digest.result = result;
  // Only a changed row replicates; nothing written (refused, no-op) says null.
  const changed = result.ok && (result.data as { changed?: unknown } | undefined)?.changed === true;
  digest.replication = changed ? "next brain push" : null;
  print(digest);
  return result.ok ? 0 : 1;
}
