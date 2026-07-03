/**
 * `igris session <gather|register>` — the session-lifecycle verb group
 * (FR-195). Mirrors the `sync <sub-verb>` grouping (`program.command("session
 * <action>")` → `runSession({action})`), and the unknown-action → exit 2
 * precedent.
 *
 * M1 shipped `gather` — the local-channel Lock-2/3 classifier (SKILL.md §2,
 * G1–G5). M2 adds `register` — the instance metadata upsert + LIVE
 * per-instance file write (SKILL.md §3.7). FR-190 extends registration with
 * harness/PID/start-time metadata and removes activity age from liveness.
 *
 * Channel: LOCAL (better-sqlite3 via brain-db.ts), no network. `gather` is
 * read-only w.r.t. `session_files` (#220 / Lock-2 "nothing destructive in
 * gather"). `register` DOES write — the instance row + the LIVE file — but
 * non-destructively (#230): the instance upsert and `sessionFileUpsert`'s
 * COALESCE never null an existing row's instance_id/state, and the on-disk
 * file write preserves an existing file's content (an idempotent re-run does
 * NOT clobber).
 */

import { hostname } from "node:os";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { detectCapabilities } from "../lib/detect.js";
import {
  classifyInstanceLiveness,
  resolveOwnerProcess,
} from "../lib/process-liveness.js";
import {
  listSessionFiles,
  listInstances,
  getSessionFileContent,
  registerOrUpdateInstanceState,
  sessionFileUpsert,
} from "../lib/brain-db.js";
import { projectSessionInstancesDir } from "../lib/paths.js";
import { basenameOfCwd } from "../lib/sync/util.js";
import { warn } from "../lib/log.js";
import type {
  SessionFileRow,
  InstanceRow,
  GatherDigest,
  GatherHandoff,
  GatherSibling,
  GatherCrashed,
  RegisterDigest,
} from "../types.js";

export type SessionAction = "gather" | "register";

export interface SessionOptions {
  /** Sub-action selector. */
  action: SessionAction;
  /** Project slug override; default basename(cwd) per the sync convention. */
  project?: string;
  /**
   * The harness's recovered prior instance id, if it could locate one
   * (SKILL.md §2 G4). For `gather` this maps a row to self; for `register`
   * it is the id to refresh (recover). Null/omitted → `register` mints a
   * fresh UUID via the instance upsert.
   */
  selfInstanceId?: string;
  /** Absolute path to the project directory (instance row project_path field). */
  projectPath?: string;
  /**
   * `register` only: the chosen handoff's resume content from `gather`'s
   * digest, to seed this LIVE file's Next Steps (the resume carry-forward,
   * SKILL.md §3.7 step 2c). Omitted/empty → no seed (fresh start).
   */
  seedNextSteps?: string;
  /** Emit JSON to stdout (default ON for the awaken path). */
  json?: boolean;
}

const VALID_ACTIONS: ReadonlySet<string> = new Set(["gather", "register"]);

/** The Lock-2/3 classification of a single `session_files` row (SKILL.md §2 G2). */
type RowClass =
  | "live-sibling"
  | "abandoned-live"
  | "genuine-handoff"
  | "ignore";

/**
 * Classify one `session_files` row against the active-instance registry —
 * the verbatim SKILL.md §2 G2 truth table + the FR-133 legacy-adoption
 * fall-through.
 *
 * `activeIds` is the set of instance ids returned by
 * `listInstances({status:'active', project})` — i.e. present in the registry
 * AND non-stale (the stale rows were excluded/marked by that call). `selfId`
 * is this harness's recovered id (or null at gather time per G4).
 */
function classifyRow(
  row: SessionFileRow,
  siblingIds: ReadonlySet<string>,
  deadIds: ReadonlySet<string>,
  selfId: string | null,
): RowClass {
  // archived → already consumed and superseded; ignore (both registry states).
  if (row.state === "archived") {
    return "ignore";
  }

  // FR-133 legacy adoption: filename='CURRENT_SESSION.md' AND instance_id IS
  // NULL predates the per-instance model — it has no owning instance, so it is
  // never a LIVE SIBLING or ABANDONED LIVE; it falls THROUGH the table to
  // GENUINE HANDOFF regardless of its (live|rested) state. Checked before the
  // state branches so a legacy 'live' row is not misclassified ABANDONED.
  if (row.filename === "CURRENT_SESSION.md" && row.instance_id === null) {
    return "genuine-handoff";
  }

  // Owner is "in the active registry, non-stale" when its id is in activeIds.
  // A row owned by self is excluded from sibling-hood (G2's "and NOT self").
  // At gather time self is not yet registered (G4), so a recovered selfId is
  // the only way a row maps to self; if selfId is null, no row is self.
  const ownerId = row.instance_id;
  if (ownerId !== null && ownerId === selfId) {
    return "ignore";
  }
  const ownerIsSibling = ownerId !== null && siblingIds.has(ownerId);
  const ownerIsDead = ownerId !== null && deadIds.has(ownerId);

  if (row.state === "live") {
    // live + owner proven/declared non-dead → LIVE SIBLING (display only).
    // live + owner absent OR proven-dead → ABANDONED LIVE (crash; never consumed).
    return ownerIsSibling && !ownerIsDead ? "live-sibling" : "abandoned-live";
  }

  if (row.state === "rested") {
    // rested + still-live owner  → eligible handoff (unusual-but-valid).
    // rested + owner absent/stale → GENUINE HANDOFF.
    // Both rested cases are eligible as a handoff (the table's right cell is
    // GENUINE HANDOFF; the left cell is "eligible as a handoff").
    return "genuine-handoff";
  }

  // Unknown/forward-compat state → ignore (never destructive on the unknown).
  return "ignore";
}

/**
 * Parse the `**Mode:**` line out of a handoff file's content (e.g. "REST
 * MODE"). Returns null when no such line is present. Mirrors the awaken
 * skill's read of the file's Status section — purely a display field.
 */
function parseMode(content: string): string | null {
  // TD-279: belt-and-suspenders — coerce so a non-string caller can never
  // hit `.match is not a function` (the read boundary already coerces).
  const text = typeof content === "string" ? content : String(content ?? "");
  const m = text.match(/^\*\*Mode:\*\*\s*(.+?)\s*$/m);
  return m ? m[1] : null;
}

/**
 * Extract a labelled field from a handoff file's content. Tries the bold
 * `**Label:** value` form (single-line) used by the per-instance files.
 * Returns "" when absent — the digest carries an empty string rather than
 * null so the skill renders a stable shape.
 */
function parseField(content: string, label: string): string {
  // TD-279: belt-and-suspenders — coerce so a non-string caller can never
  // hit `.match is not a function` (the read boundary already coerces).
  const text = typeof content === "string" ? content : String(content ?? "");
  const re = new RegExp(
    `^\\*\\*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\*\\*\\s*(.+?)\\s*$`,
    "m",
  );
  const m = text.match(re);
  return m ? m[1] : "";
}

/**
 * Build the `session gather` digest — the faithful G1–G5 sweep.
 *
 * G1 enumerate → G2 classify each row → G3 pick newest GENUINE HANDOFF +
 * fetch ITS content only → G4 self id (recovered-or-null) → G5 the display
 * lists. Nothing destructive happens (Lock-2): the only DB writes are
 * `listInstances`'s registry maintenance.
 */
function buildGatherDigest(
  slug: string,
  selfId: string | null,
): GatherDigest {
  // G1 — enumerate. FR-190: instance reads no longer purge/mark stale based on
  // activity age; liveness is classified per instance below.
  const files: SessionFileRow[] = listSessionFiles(slug);
  const instanceRows: InstanceRow[] = listInstances({
    status: "all",
    includeStale: true,
    project: slug,
  });
  const siblingIds = new Set<string>();
  const deadIds = new Set<string>();
  const instanceById = new Map<string, InstanceRow>();
  const livenessById = new Map<
    string,
    ReturnType<typeof classifyInstanceLiveness>
  >();
  for (const inst of instanceRows) {
    instanceById.set(inst.id, inst);
    const liveness = classifyInstanceLiveness(inst);
    livenessById.set(inst.id, liveness);
    if (liveness.status === "dead" || liveness.status === "dead_pid_reused") {
      deadIds.add(inst.id);
    } else {
      siblingIds.add(inst.id);
    }
  }

  const siblings: GatherSibling[] = [];
  const crashed: GatherCrashed[] = [];
  const genuineHandoffs: SessionFileRow[] = [];

  // G2 — classify each row.
  for (const row of files) {
    const klass = classifyRow(row, siblingIds, deadIds, selfId);
    if (klass === "live-sibling" && row.instance_id !== null) {
      const inst = instanceById.get(row.instance_id);
      const liveness = livenessById.get(row.instance_id);
      siblings.push({
        instance_id: row.instance_id,
        current_brief: inst ? inst.current_brief : null,
        // Prefer explicit state update time, then activity time, then the file
        // mtime for legacy rows.
        last_active: inst ? (inst.state_updated_at ?? inst.last_activity_at) : row.updated_at,
        harness: inst ? inst.harness : null,
        liveness_status: liveness?.status,
        liveness_method: liveness?.method,
        lease_expires_at: inst ? inst.lease_expires_at : null,
      });
    } else if (klass === "abandoned-live") {
      const liveness =
        row.instance_id !== null ? livenessById.get(row.instance_id) : undefined;
      crashed.push({
        instance_id: row.instance_id ?? "",
        last_active: row.updated_at,
        scratchpad: `session/${row.filename}`,
        liveness_status: liveness?.status,
        liveness_method: liveness?.method,
      });
    } else if (klass === "genuine-handoff") {
      genuineHandoffs.push(row);
    }
    // "ignore" → archived/unknown; nothing to surface.
  }

  // G3 — pick THE handoff: the most-recent updated_at among genuine handoffs.
  // listSessionFiles already returns rows ORDER BY updated_at DESC, so the
  // first genuine-handoff encountered is the newest; but sort defensively in
  // case the source ordering ever changes (the contract is "newest wins").
  let handoff: GatherHandoff | null = null;
  if (genuineHandoffs.length > 0) {
    genuineHandoffs.sort((a, b) =>
      a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0,
    );
    const chosen = genuineHandoffs[0];
    // Fetch content ONLY for the chosen handoff (the G3 optimization).
    const content = getSessionFileContent(slug, chosen.filename) ?? "";
    const isLegacy =
      chosen.filename === "CURRENT_SESSION.md" && chosen.instance_id === null;
    handoff = {
      instance_id: chosen.instance_id,
      filename: chosen.filename,
      mode: parseMode(content),
      // Resume fields: per-instance files carry these as bold labels. Try the
      // common label spellings the awaken skill §5 / §7 write.
      resume_point:
        parseField(content, "Resume Point") ||
        parseField(content, "Next Session Instructions"),
      next_steps: parseField(content, "Next Steps"),
      is_legacy: isLegacy,
    };
  }

  return {
    degraded: false,
    handoff,
    self_instance_id: selfId,
    siblings,
    crashed,
    fresh_start: handoff === null,
  };
}

/**
 * Build the LIVE per-instance file content for a FRESH register.
 *
 * Carries the §3.7 line shape the MAINTAINING contract pins — the phase-guard
 * fallback (`scripts/git-hooks/pre-commit`) and `/hunt` both grep these exact
 * bold labels:
 *   - `**Instance ID:** <id>`   (the per-instance keying)
 *   - `**Mode:** Active`        (flips to HUNT MODE once a hunt starts — §7)
 *   - `**Active Brief:** <brief|None>`  (the phase-guard + /hunt parse target)
 * `seedNextSteps` (from gather's chosen handoff) is appended as the resume
 * carry-forward (§3.7 step 2c). Empty seed → a `None yet` placeholder so the
 * label is always present (a stable shape for downstream parsers).
 */
function buildLiveFileContent(
  instanceId: string,
  activeBrief: string | null,
  seedNextSteps: string,
): string {
  const nextSteps = seedNextSteps.trim().length > 0 ? seedNextSteps.trim() : "None yet";
  return [
    `# Session — instance ${instanceId}`,
    "",
    "## Status",
    `**Instance ID:** ${instanceId}`,
    "**Mode:** Active",
    `**Active Brief:** ${activeBrief ?? "None"}`,
    "",
    "## Next Steps",
    nextSteps,
    "",
  ].join("\n");
}

/**
 * Run the `register` action — the instance metadata upsert + LIVE per-instance file
 * write (SKILL.md §3.7). Returns the digest + the process exit code.
 *
 * Non-destructive (#230): the instance upsert refreshes-or-mints the registry
 * row; the LIVE file is written FRESH only when it does not already exist on
 * disk — an idempotent re-run (same recovered id) PRESERVES the existing file's
 * content rather than clobbering the running instance's scratchpad. The
 * `sessionFileUpsert(state='live')` re-affirms the DB row's LIVE state via
 * COALESCE (an omitted field never downgrades).
 */
function runRegister(opts: SessionOptions): { digest: RegisterDigest; code: number } {
  const slug = opts.project ?? basenameOfCwd();
  const seedNextSteps = opts.seedNextSteps ?? "";

  // Detect first — a missing brain DB means we cannot register (no registry,
  // no DB-backed LIVE row). Degrade, exit 0, never block (SKILL.md §3.7's
  // "skip gracefully ... do NOT block session start").
  const caps = detectCapabilities();
  if (!caps.brain_db) {
    return {
      digest: {
        degraded: true,
        instance_id: opts.selfInstanceId ?? "",
        minted: false,
        live_file: "",
        seeded_from_handoff: false,
      },
      code: 0,
    };
  }

  // Instance metadata upsert — recover (selfInstanceId supplied) or mint (omitted).
  // Wrapped so a BrainTableMissingError (a present-but-unmigrated DB) degrades
  // rather than crashing the awaken sequence.
  let registration;
  try {
    const owner = resolveOwnerProcess();
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    registration = registerOrUpdateInstanceState({
      instance_id: opts.selfInstanceId,
      machine_hostname: hostname(),
      machine_os: process.platform,
      project_slug: slug,
      project_path: opts.projectPath ?? null,
      harness: caps.harness,
      owner_pid: owner ? owner.pid : null,
      owner_started_at: owner ? owner.started_at : null,
      liveness_method: owner ? "pid_start_time" : "none",
      liveness_status: owner ? "alive" : "unknown_no_metadata",
      liveness_checked_at: now,
    });
  } catch (err) {
    warn(
      `session register: instance upsert skipped (${
        err instanceof Error ? err.message : String(err)
      }).`,
    );
    return {
      digest: {
        degraded: true,
        instance_id: opts.selfInstanceId ?? "",
        minted: false,
        live_file: "",
        seeded_from_handoff: false,
      },
      code: 0,
    };
  }

  const instanceId = registration.instance_id;
  const relFilename = `instances/${instanceId}.md`;
  const instancesDir = projectSessionInstancesDir(slug);
  const diskPath = join(instancesDir, `${instanceId}.md`);

  // Write the LIVE file ON DISK — but NON-DESTRUCTIVELY (#230). A re-run of a
  // recovered instance finds its own file already present and PRESERVES it (the
  // running instance owns + writes its own scratchpad freely; we must not
  // clobber it back to a skeleton). Only a fresh instance (no file yet) gets the
  // §3.7 skeleton seeded from the handoff.
  let content: string;
  let seededFromHandoff = false;
  if (existsSync(diskPath)) {
    content = readFileSync(diskPath, "utf-8");
    // The file already carries this instance's living state; do not reseed.
  } else {
    mkdirSync(instancesDir, { recursive: true });
    content = buildLiveFileContent(instanceId, null, seedNextSteps);
    writeFileSync(diskPath, content, "utf-8");
    seededFromHandoff = seedNextSteps.trim().length > 0;
  }

  // Affirm the DB row at state='live' with the same content. COALESCE makes
  // this safe to repeat: an omitted field never nulls/downgrades, and passing
  // instance_id + state='live' explicitly keeps the row owned + LIVE.
  try {
    sessionFileUpsert({
      project: slug,
      filename: relFilename,
      content,
      instance_id: instanceId,
      state: "live",
    });
  } catch (err) {
    // The instance row already landed; a session_files write failure is a partial
    // success — surface it as degraded but keep the minted/recovered id.
    warn(
      `session register: session_files upsert skipped (${
        err instanceof Error ? err.message : String(err)
      }).`,
    );
    return {
      digest: {
        degraded: true,
        instance_id: instanceId,
        minted: registration.minted,
        live_file: relFilename,
        seeded_from_handoff: seededFromHandoff,
      },
      code: 0,
    };
  }

  return {
    digest: {
      degraded: false,
      instance_id: instanceId,
      minted: registration.minted,
      live_file: relFilename,
      seeded_from_handoff: seededFromHandoff,
    },
    code: 0,
  };
}

/**
 * Run the session verb. Dispatches the action; unknown → exit 2 (matching
 * the `sync bogus` precedent).
 */
export function runSession(opts: SessionOptions): number {
  if (!VALID_ACTIONS.has(opts.action)) {
    process.stderr.write(
      `error: unknown session action '${opts.action}'. Valid: gather, register.\n`,
    );
    return 2;
  }

  if (opts.action === "register") {
    const { digest, code } = runRegister(opts);
    process.stdout.write(JSON.stringify(digest) + "\n");
    return code;
  }

  // action === "gather"
  const slug = opts.project ?? basenameOfCwd();
  const selfId = opts.selfInstanceId ?? null;

  // Detect first — a missing brain DB is a fresh-start (degraded), exit 0,
  // never block (SKILL.md invariant). We do NOT attempt any local read in
  // that mode.
  const caps = detectCapabilities();
  if (!caps.brain_db) {
    const digest: GatherDigest = {
      degraded: true,
      handoff: null,
      self_instance_id: selfId,
      siblings: [],
      crashed: [],
      fresh_start: true,
    };
    process.stdout.write(JSON.stringify(digest) + "\n");
    return 0;
  }

  const digest = buildGatherDigest(slug, selfId);
  process.stdout.write(JSON.stringify(digest) + "\n");
  return 0;
}
