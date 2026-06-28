/**
 * Shared TS interfaces for the Igris CLI.
 */

/**
 * Shape of `~/.igris/projects/<slug>/installed_features.json`.
 *
 * `schema_version` is forward-only — readers MUST migrate older versions on
 * load (see installed-features.ts) and writers MUST always emit the latest
 * schema_version. Hash fields are content hashes of the canonical files at
 * install time, used by `update --all` to skip projects that are already
 * up to date.
 */
export interface InstalledFeatures {
  schema_version: number;
  cli_version: string;
  /**
   * Channel kind that fed the brain at install time (M2 — schema v2).
   * Mirrors `~/.igris/.install-source.json#channel`. `null` means the
   * install ran before init/refresh deposited the install-source file
   * (legacy v1 row migrated forward).
   */
  brain_channel: Channel | null;
  /**
   * Resolved channel ref ("v7.0.0", "main", or any tag) at install time
   * (M2 — schema v2). Mirrors `~/.igris/.install-source.json#ref`. `null`
   * for legacy v1 rows.
   */
  brain_ref: string | null;
  /** sha256 of `~/.igris/core/hooks/canonical-settings.json`, or null when --no-hooks. */
  hooks_version: string | null;
  /** sha256 of `~/.igris/core/agents/manifest.yaml`, or null when not present. */
  agents_version: string | null;
  /** sha256 of recursive sort+hash of `~/.igris/core/skills`, or null when not present. */
  skills_version: string | null;
  /**
   * DEPRECATED (FR-187): always `null`. The universal rule
   * `core/rules/00-igris-universal.md` was retired; its baseline moved into
   * `core/os/standards.md`. The field is retained in the v2 schema (as an
   * always-null vestige) to avoid a forced schema migration; it no longer
   * carries an install-integrity signal. Do not reintroduce a rule hash.
   */
  rules_version: string | null;
  /** ISO-8601 timestamp of original install. Preserved across re-installs. */
  installed_at: string;
  /** ISO-8601 timestamp of last write. Updated every install/update. */
  updated_at: string;
}

/**
 * Row in the brain's `projects` table (subset relevant to CLI).
 */
export interface RegistryRow {
  slug: string;
  name: string;
  path: string;
  tech_stack: string;
  igris_version: string;
  status?: string;
  registered_at?: string;
  last_session_at?: string;
}

/**
 * Per-row drift classification for `igris doctor`.
 */
export interface DriftRow {
  slug: string;
  path: string;
  driftClass:
    | "clean"
    | "path-missing"
    | "not-installed"
    | "hooks-missing"
    | "hooks-stale"
    | "slug-basename-mismatch"
    | "duplicate-path"
    | "symlink-target"
    | "brain-core-missing"
    | "brain-core-stale"
    | "channel-mismatch"
    | "bridge-missing"
    | "mcp-unregistered"
    | "secret-perms"
    | "skills-pollution"
    | "antigravity-skills-link";
  recommendedFix: string;
  /** Resolved realpath when row.path is itself a symlink. */
  resolvedPath?: string;
}

/**
 * In-memory shape of `~/.igris/core/hooks/canonical-settings.json`.
 * `_doc` and any non-`hooks` keys are preserved on load but ignored on merge.
 */
export interface CanonicalHooks {
  _doc?: string;
  hooks: Record<string, unknown>;
}

/**
 * Channel kind: where to fetch brain core content from.
 *
 * - "release": latest published GitHub release tag (default).
 * - "main":    bleeding-edge main branch.
 * - "tag":     a specific git tag, captured in InstallSource.ref.
 * - "branch":  a specific git branch (e.g. "develop"), captured in
 *              InstallSource.ref (TD-154). The "main" kind is the special-cased
 *              default branch; "branch" covers every other branch name.
 */
export type Channel = "release" | "main" | "tag" | "branch";

/**
 * Per-CLI bridge target. Phase 2 supports four CLIs natively; bridges
 * are emitted for any subset. Auto-detection (cli-detect.ts) returns
 * a Set of these values.
 */
export type CLITarget =
  | "claude"
  | "codex"
  | "gemini"
  | "opencode"
  | "antigravity";

/**
 * Persisted shape of `~/.igris/.install-source.json`.
 *
 * Records HOW the runtime brain core was assembled so that `igris
 * refresh` can re-fetch from the same source AND `igris doctor` can
 * detect drift between the runtime and the recorded channel head.
 */
export interface InstallSource {
  schema_version: number;
  /** Logical channel selector. */
  channel: Channel;
  /** Resolved reference: tag name like "v7.0.0", or "main", or "<custom>". */
  ref: string;
  /** ISO-8601 timestamp of last successful fetch. */
  fetched_at: string;
  /** SHA-256 of the fetched gzipped tarball, used as cache key. */
  content_sha256: string;
  /** Source kind for reproducibility / diagnostics. */
  source: "github" | "from-source" | "cache";
  /** Absolute path when source != "github" (the contributor repo or cached tarball). */
  source_path: string | null;
}

/**
 * FR-195 (M1) — a `session_files` row as enumerated by `igris session gather`.
 *
 * Mirrors the SELECT projection of `handleSessionFileList`
 * (`brain-mcp-server/src/tools/sessions.ts:330-349`): metadata only, no
 * `content` (gather fetches content for the chosen handoff alone). `state`
 * is the 3-state lifecycle column added by the sessions component schema
 * v2 (`brain-mcp-server/src/engine/components/sessions/schema.ts:59-61`).
 */
export interface SessionFileRow {
  filename: string;
  instance_id: string | null;
  state: string;
  content_hash: string;
  updated_at: string;
}

/**
 * FR-195 (M1) — an `instances` registry row as listed by `igris session
 * gather`.
 *
 * Mirrors the SELECT projection of `handleInstanceList`
 * (`brain-mcp-server/src/tools/instances.ts:159-165`).
 */
export interface InstanceRow {
  id: string;
  machine_hostname: string;
  machine_os: string | null;
  project_slug: string | null;
  current_brief: string | null;
  current_phase: string | null;
  current_task: string | null;
  status: string;
  last_heartbeat_at: string;
  harness: string | null;
  harness_session_id: string | null;
  owner_pid: number | null;
  owner_started_at: string | null;
  liveness_method: string | null;
  liveness_status: InstanceLivenessStatus | null;
  liveness_checked_at: string | null;
  lease_expires_at: string | null;
  state_updated_at: string | null;
}

export type InstanceLivenessStatus =
  | "alive"
  | "dead"
  | "dead_pid_reused"
  | "unknown_remote"
  | "unknown_no_metadata";

/**
 * FR-195 (M1) — capability-detection digest emitted by `igris detect`.
 *
 * The L0 pass the awaken skill runs first. `mode` collapses the individual
 * capability booleans into the single degradation verdict each downstream
 * verb branches on (see the Detect consumption section of the FR-195 plan).
 * `full` requires the local brain DB present; `degraded-no-db` is a
 * fresh-start (never an error); `degraded-no-remote` means the VPS pulls
 * (`boot-sync`, M3) are skipped but local verbs still run.
 */
export interface DetectResult {
  harness: "claude" | "codex" | "gemini" | "opencode" | "antigravity" | "unknown";
  /** Default project slug for Mount verbs: basename(process.cwd()). */
  project_slug: string;
  /** Current project directory seen by the booting CLI process. */
  project_path: string;
  /** Resolved Igris brain root (`~/.igris` or IGRIS_BRAIN_DIR override). */
  brain_root: string;
  /** `existsSync(brainDbPath())` — the local channel is available. */
  brain_db: boolean;
  /** `command -v sqlite3` — only matters for the skill's own remaining shell-outs (the verbs use in-process better-sqlite3). */
  sqlite3: boolean;
  /** `readRemoteBrainConfig() !== null` — the VPS sync channel is configured. */
  remote_brain: boolean;
  mode: "full" | "degraded-no-db" | "degraded-no-remote";
}

/**
 * FR-195 (M1) — the chosen handoff inside the `session gather` digest, or a
 * null-island when this is a fresh start (no genuine handoff found).
 *
 * Field names mirror the resume fields the awaken skill §5 renders. `mode`
 * is the handoff file's `**Mode:**` value (e.g. "REST MODE") parsed from
 * its content; `is_legacy` flags the FR-133 `CURRENT_SESSION.md` adoption
 * path.
 */
export interface GatherHandoff {
  /** Owning instance UUID of the chosen handoff, or null for a legacy CURRENT_SESSION.md row. */
  instance_id: string | null;
  filename: string;
  /** The handoff's declared mode (e.g. "REST MODE"), or null when unparseable. */
  mode: string | null;
  resume_point: string;
  next_steps: string;
  /** FR-133: true when the handoff is a pre-per-instance CURRENT_SESSION.md row. */
  is_legacy: boolean;
}

/** FR-195 (M1) — a LIVE-SIBLING entry in the `session gather` digest. */
export interface GatherSibling {
  instance_id: string;
  current_brief: string | null;
  last_active: string;
  harness?: string | null;
  liveness_status?: InstanceLivenessStatus;
  liveness_method?: string;
  lease_expires_at?: string | null;
}

/** FR-195 (M1) — an ABANDONED-LIVE (crashed) entry in the `session gather` digest. */
export interface GatherCrashed {
  instance_id: string;
  last_active: string;
  /** On-disk scratchpad path for the crashed instance's session file. */
  scratchpad: string;
  liveness_status?: InstanceLivenessStatus;
  liveness_method?: string;
}

/**
 * FR-195 (M1) — the `igris session gather` digest (the Lock-2/3 classifier
 * output). Read by the rewritten awaken SKILL.md (M4).
 *
 * `degraded` is true when the brain DB was absent (fresh start, exit 0 —
 * never blocks session start). `handoff` is null when no genuine handoff
 * exists. `self_instance_id` is recovered-if-possible else null (minting
 * is deferred to `session register`, M2).
 */
export interface GatherDigest {
  degraded: boolean;
  handoff: GatherHandoff | null;
  self_instance_id: string | null;
  siblings: GatherSibling[];
  crashed: GatherCrashed[];
  fresh_start: boolean;
}

/**
 * FR-195 (M2) — the `session register` digest.
 *
 * Emitted after instance registration/state upsert + LIVE per-instance file
 * write (SKILL.md §4.4). `minted` is true when no prior id was supplied (a fresh
 * UUID was generated); false when an existing id was recovered+refreshed.
 * `seeded_from_handoff` is true when gather selected a genuine handoff whose
 * Next Steps were carried into the new LIVE file (the resume context).
 */
export interface RegisterDigest {
  degraded: boolean;
  instance_id: string;
  minted: boolean;
  /** On-disk path of the LIVE per-instance file, relative to the project session dir. */
  live_file: string;
  seeded_from_handoff: boolean;
}

/**
 * FR-195 (M2) — the `housekeeping` digest (H0–H3).
 *
 * Each field maps to one sweep step (SKILL.md §4.5): `h0_legacy_retired` is
 * true when the legacy CURRENT_SESSION.md row was retired this run;
 * `h1_archived` lists the `<id>-<rested_at>.md` archive filenames produced by
 * the supersession step; `h2_rolled` / `h3_ceiling_rolled` are the counts of
 * individual files folded into month digests by the 30-day roll / 150-ceiling
 * valve. `noop` is true when nothing was touched (the common single-instance
 * fresh-archive case).
 */
export interface HousekeepingDigest {
  degraded: boolean;
  h0_legacy_retired: boolean;
  h1_archived: string[];
  h2_rolled: number;
  h3_ceiling_rolled: number;
  noop: boolean;
}

/**
 * FR-195 (M2) — a brief-status summary inside the `assess` digest. Mirrors
 * the summary-only projection of `handleBriefDashboard`
 * (`brain-mcp-server/src/tools/briefs.ts:205-234`): a total plus
 * counts-by-status and counts-by-priority. NOT the full brief table.
 */
export interface AssessBriefs {
  total: number;
  by_status: Record<string, number>;
  by_priority: Record<string, number>;
}

/**
 * FR-195 (M2) — the git working-tree snapshot inside the `assess` digest.
 * `branch` is null when not on a branch (detached HEAD) or git is unavailable;
 * `dirty` reflects `git status --porcelain` having any output; `ahead` is the
 * commit count ahead of the upstream (0 when no upstream / unavailable).
 */
export interface AssessGit {
  branch: string | null;
  dirty: boolean;
  ahead: number;
}

/**
 * FR-195 (M2) — an upcoming-goal entry inside the `assess` digest. Mirrors the
 * `upcoming_days` projection of `handleGoalList`
 * (`brain-mcp-server/src/engine/components/goals/handlers.ts:382-440`):
 * active goals with a deadline within N days (14 in /awaken).
 */
export interface AssessGoal {
  goal_id: string;
  title: string;
  deadline: string | null;
  priority: string;
}

/**
 * FR-195 (M2) — the `assess` digest (the MINIMAL D-A scope).
 *
 * Briefs summary + active blockers + git snapshot + active-instance count +
 * upcoming goals (14d). DELIBERATELY OMITS the task queue, perception pending,
 * and cross-project recall (D-A in the FR-195 plan — those re-introduce the
 * noise the ceremony-teardown flagged). `degraded` is true when the brain DB
 * was absent (empty briefs/goals, exit 0 — never blocks).
 */
export interface AssessDigest {
  degraded: boolean;
  briefs: AssessBriefs;
  blockers: string[];
  git: AssessGit;
  active_instances: number;
  goals_upcoming: AssessGoal[];
}

/** FR-209 — project profile fields read from the local brain `projects` row. */
export interface ProjectProfile {
  slug: string;
  path: string | null;
  archetype: string | null;
  tech_stack: string | null;
}

/** FR-209 — graceful read result for the local brain project profile. */
export interface ProjectProfileResult {
  degraded: boolean;
  profile: ProjectProfile | null;
}

/** FR-209 — context-doc applicability tri-state. */
export type ContextDocApplies = "yes" | "no" | "unknown";

/** FR-209 — one catalog row joined to project context-doc existence. */
export interface ContextDocInventoryRow {
  type: string;
  target: string;
  applies_when: string;
  applies: ContextDocApplies;
  optional: boolean;
  summary: string;
  exists: boolean;
  missing_applicable: boolean;
}

/** FR-209 — digest emitted by `igris context-docs inventory`. */
export interface ContextDocsInventoryDigest {
  project: string;
  archetype: string | null;
  tech_stack: string | null;
  degraded: boolean;
  docs: ContextDocInventoryRow[];
  missing_applicable: string[];
  remediation: string[];
}

/**
 * FR-195 (M3) — the per-pull result inside the `boot-sync` digest. `ok` is
 * false when that pull failed (network error, non-200, or a local merge
 * error); the verb continues to the next pull regardless (skip-on-fail).
 * `summary` is a short human line (e.g. "5 learnings, 2 errors") on success,
 * or the failure reason on `ok:false`.
 */
export interface BootSyncPull {
  ok: boolean;
  summary: string;
}

/** FR-195 (M3) — the queue-drain result inside the `boot-sync` digest. */
export interface BootSyncQueueDrain {
  ok: boolean;
  /** Count of local queue entries drained this run. */
  drained: number;
}

/**
 * FR-195 (M3) — the `boot-sync` digest (the REMOTE channel; never blocks).
 *
 * Emitted after the queue drain + the VPS→local row pull (SKILL.md §4).
 * `degraded` is true when `remote_brain` is unconfigured — the pulls are
 * skipped and `skipped` lists the reason(s); exit is still 0 (a missing remote
 * is a local-only run, not an error). Each part is independent: a failed pull
 * records `ok:false` in `brain_pull` but does not abort the drain or vice
 * versa. `session_files_pulled` / `definitions_updated` are surfaced
 * counts from the single `/sync/pull` (those tables ride the same pull — there
 * is no separate remote endpoint for them; see the boot-sync module header).
 */
export interface BootSyncDigest {
  degraded: boolean;
  /** The VPS→local row pull (learnings/errors/instances/brief_status/… via GET /sync/pull). */
  brain_pull: BootSyncPull;
  /** The local sync_queue.jsonl drain (reuses the `sync data` primitive). */
  queue_drain: BootSyncQueueDrain;
  /** Count of session_files rows merged from the pull (inserted + updated). */
  session_files_pulled: number;
  /** Definition rows merged from the pull, split by definition type. */
  definitions_updated: { agents: number; skills: number; rules: number; prompts: number };
  /** One-line reasons any part was skipped (e.g. "remote unconfigured"). */
  skipped: string[];
}

/**
 * Lightweight manifest describing what a brain-core tarball delivers.
 * Currently a stub used by dry-run reporting and doctor's stale check;
 * may grow in M5 for delta-fetch optimization (currently out of scope).
 */
export interface BrainCoreManifest {
  channel: Channel;
  ref: string;
  content_sha256: string;
  fetched_at: string;
}

/**
 * Dry-run plan: an enumeration of would-be side effects collected by
 * the verb layer when `--dry-run` is set. The shared reporter
 * (`dry-run.ts`) prints these in a stable, grep-friendly format.
 */
export interface DryRunPlan {
  /** Directories that would be created (mkdir -p). */
  would_create_dir: string[];
  /** Files that would be written (overwrite or fresh). */
  would_write_file: Array<{ path: string; reason: string }>;
  /** External URLs that would be fetched. */
  would_fetch_url: string[];
  /** External commands that would be invoked (with arg array). */
  would_invoke_command: Array<{ command: string; args: string[]; reason: string }>;
  /** Directories that would be removed (rm -rf). */
  would_remove_dir: string[];
  /** Filesystem moves (e.g. core.new → core, core → core.bak). */
  would_rename: Array<{ from: string; to: string; reason: string }>;
  /**
   * Recursive directory copies (e.g. from-source core/ → install root core/).
   * Distinct from `would_rename` — the actual non-dry path uses recursive
   * copy semantics (the source tree is preserved). TD-142.
   */
  would_copy: Array<{ from: string; to: string; reason: string }>;
}
