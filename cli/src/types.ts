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
  | "antigravity"
  | "cursor";

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
  last_activity_at: string;
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
  harness: "claude" | "codex" | "gemini" | "opencode" | "antigravity" | "cursor" | "unknown";
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
 * FR-235 — first-run onboarding state, persisted under the `config.json`
 * `onboarding` key.
 *
 * `completed` is the shared teach-vs-configure signal (read by `/boot` and
 * `/setup`): the `/setup` teach path is its sole writer, and `init --upgrade`
 * stamps it true for returning users. `boot_welcomed` is the idempotency cap so
 * the `/boot` first-run Welcome renders at most once. A fresh install writes
 * neither key — an absent `onboarding` block reads as `{completed:false,
 * boot_welcomed:false}` (first-run).
 */
export interface OnboardingState {
  completed: boolean;
  boot_welcomed: boolean;
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

/** FR-246 — one grep hit inside a context doc body. */
export interface ContextDocMatchPayload {
  /** 1-based line number in the doc as read. */
  line: number;
  /** Bounded excerpt CENTRED on the hit, elided at either end with `…`. */
  snippet: string;
}

/**
 * FR-246 — an inventory row, plus what a `q` grep found in its body.
 *
 * `matches` is absent (not empty) when no `q` was supplied: an empty array
 * would mean "searched, found nothing", which is a different statement.
 */
export interface ContextDocRowPayload extends ContextDocInventoryRow {
  matches?: ContextDocMatchPayload[];
  /** True when the doc had more hits than the per-doc cap. */
  more_matches?: boolean;
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
 * FR-229 — the `igris export` tier selector.
 *
 * - `core`     = brief_status + brief_files.
 * - `standard` = core + entity_edges(brief↔brief) + goals + context_docs (DEFAULT).
 * - `full`     = standard + learnings(approved) + errors + project concept-graph.
 */
export type ExportTier = "core" | "standard" | "full";

/** FR-229 — options for the `igris export <project>` producer verb. */
export interface ExportOptions {
  /** Project slug to export (the positional `<project>`). */
  project: string;
  /** Output path; default `./<slug>.igris-pack.tar.gz`. */
  out?: string;
  /** Tier; default `standard`. */
  tier?: ExportTier;
  /** Extra store names to include on top of the tier. */
  include?: string[];
  /** Only rows at/after this cutoff (per each store's timestampCol). */
  since?: string;
  /** Emit the JSON digest to stdout (default ON). */
  json?: boolean;
}

/**
 * FR-229 — a per-store descriptor in the `.igris-pack` manifest. Carries the
 * store's own column/syncKey/strategy/timestampCol + `table` (the target DB
 * table) so the FR-230 importer needs no re-derivation. `context_docs` uses the
 * file/hash shape (no columns/syncKey/table).
 */
export interface ExportStoreDescriptor {
  /** Relative path of this store's data file inside the bundle. */
  file?: string;
  /** Row count (data stores) or file count (context_docs). */
  count: number;
  /** Target DB table for the FR-230 importer (absent for context_docs). */
  table?: string;
  columns?: string[];
  syncKey?: string[];
  strategy?: "lww" | "append";
  timestampCol?: string;
  /** brief_files only: per-brief `sha256(content)`. */
  content_hashes?: Record<string, string>;
  /** context_docs only: the raw doc files inside the bundle. */
  files?: string[];
  /** context_docs only: per-file `sha256`. */
  hashes?: Record<string, string>;
}

/** FR-229 — the `.igris-pack/manifest.json` schema (format_version 1). */
export interface ExportManifest {
  format: "igris-pack";
  format_version: 1;
  created_at: string;
  producer: { cli_version: string };
  /** NO absolute path — only the slug (redaction/omission by construction). */
  project: { slug: string };
  tier: ExportTier;
  filters: { since: string | null; include: string[] };
  stores: Record<string, ExportStoreDescriptor>;
  /** Self-describing list of stores that are NEVER exported. */
  excluded: string[];
  redaction: { applied: boolean; cols: Record<string, string[]> };
  /** sha256 over the ordered payload (data files + context docs), NOT the manifest. */
  checksum: string;
}

/** FR-229 — the JSON digest `igris export` prints to stdout on success. */
export interface ExportDigest {
  tier: ExportTier;
  stores: string[];
  counts: Record<string, number>;
  out_path: string;
  checksum: string;
}

// ---------------------------------------------------------------------------
// FR-230 — `igris import` (cross-owner merge ENGINE — the FR-229 ingress twin).
// ---------------------------------------------------------------------------

/**
 * FR-230 — the `--on-conflict` policy. Governs the CONFLICT class ONLY (all
 * other classes resolve deterministically): `ask` (interactive, DEFAULT) ·
 * `theirs` (bundle wins) · `mine` (keep local) · `newer` (LWW by the store's
 * timestampCol, opt-in + reported).
 */
export type OnConflictPolicy = "ask" | "theirs" | "mine" | "newer";

/**
 * FR-230 — the ancestor-based 3-way row classification (NOT timestamp LWW).
 * `H_b` = bundle hash, `H_l` = local hash, `A` = ledger ancestor hash:
 * NEW (no local) · UNCHANGED (H_l==H_b) · INCOMING (H_l==A, H_b!=A → theirs
 * fast-forwards) · LOCAL_ONLY (H_b==A, H_l!=A → mine advanced, theirs stale) ·
 * CONFLICT (both diverged from A, OR no A recorded → conservative).
 */
export type ImportClassification =
  | "NEW"
  | "UNCHANGED"
  | "INCOMING"
  | "LOCAL_ONLY"
  | "CONFLICT";

/** FR-230 — options for the `igris import <bundle>` consumer verb. */
export interface ImportOptions {
  /** Path to the `.igris-pack.tar.gz` bundle (the positional `<bundle>`). */
  bundle: string;
  /** Classify + preview only; write NOTHING to the DB. */
  dryRun?: boolean;
  /** Conflict-resolution policy; default `ask`. */
  onConflict?: OnConflictPolicy;
  /** Rewrite the scope key to this slug before lookup/classify/apply. */
  as?: string;
  /**
   * Absolute/relative path recorded on a freshly auto-registered `projects` row
   * for the target slug (C2). Defaults to `process.cwd()`. Ignored when the
   * project already exists (its real path is preserved).
   */
  projectPath?: string;
  /** Emit the JSON digest to stdout (default ON). */
  json?: boolean;
}

/** FR-230 — one classified bundle row inside an {@link ImportStorePlan}. */
export interface ImportRowPlan {
  /** The syncKey values joined (`NUL`-separated) — the ledger + report key. */
  key: string;
  classification: ImportClassification;
  /** sha256 of the bundle row's semantic columns (content_hashes for brief_files). */
  bundleHash: string;
  /** sha256 of the local row's semantic columns; absent when no local row. */
  localHash?: string;
  /** Ledger ancestor hash for (store,key); absent on first-ever import. */
  ancestorHash?: string;
  /** The slug-rewritten bundle row (the values the writer will apply). */
  row: Record<string, unknown>;
}

/** FR-230 — the per-store classification result. */
export interface ImportStorePlan {
  /** Manifest store NAME (e.g. `concept_edges`, distinct from its `table`). */
  store: string;
  table: string;
  strategy: "lww" | "append";
  rows: ImportRowPlan[];
  counts: Record<ImportClassification, number>;
}

/** FR-230 — the full classification plan (row stores only; context docs are separate). */
export interface ImportPlan {
  stores: ImportStorePlan[];
  totals: Record<ImportClassification, number>;
}

/** FR-230 — the resolution chosen for one CONFLICT row (AC2 per-conflict report). */
export interface ImportConflictResolution {
  store: string;
  key: string;
  classification: ImportClassification;
  chosen: "theirs" | "mine";
}

/** FR-230 — the new ancestor hash to seed for (store,key) after a successful apply. */
export interface ImportAncestorUpdate {
  store: string;
  key: string;
  hash: string;
}

/** FR-230 — per-store apply counts (mirrors {@link MergeRowsResult} in brain-db). */
export interface ImportStoreResult {
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  failures?: { key: string; error: string }[];
}

/** FR-230 — the result of {@link applyImport} (per-store counts + conflict report). */
export interface ImportResult {
  perStore: Record<string, ImportStoreResult>;
  conflicts: ImportConflictResolution[];
  ancestorUpdates: ImportAncestorUpdate[];
  /** True when a `projects` row was auto-registered for the target slug this run (C2). */
  projectRegistered: boolean;
}

/** FR-230 — a per-bundle ledger record (the applied-bundle marker + provenance). */
export interface ImportLedgerRecord {
  checksum: string;
  source_fingerprint: string;
  imported_at: string;
  as_slug: string;
  rows: { store: string; key: string; hash: string }[];
  /**
   * True only when the apply was CLEAN (zero failed rows). Gates the idempotency
   * short-circuit (C3): a PARTIAL apply still records provenance/ancestor for the
   * rows that landed, but is NOT marked applied, so a corrective re-import
   * re-classifies and lands the previously-failed rows.
   */
  clean: boolean;
}

/** FR-230 — a classified context doc (D5 pseudo-store). */
export interface ImportContextDocPlan {
  filename: string;
  classification: "NEW" | "UNCHANGED" | "INCOMING" | "LOCAL_ONLY" | "CONFLICT";
  bundleHash: string;
  localHash?: string;
  ancestorHash?: string;
  content: string;
}

/** FR-230 — the JSON digest `igris import` prints to stdout. */
export interface ImportDigest {
  bundle: string;
  target_slug: string;
  policy: OnConflictPolicy;
  dry_run: boolean;
  already_imported: boolean;
  /**
   * Apply outcome: `full` (every decided row applied cleanly), `partial` (some
   * rows failed — non-zero exit, bundle NOT marked applied), `none` (dry-run /
   * non-TTY ask / aborted / already-imported → zero writes).
   */
  applied: "full" | "partial" | "none";
  /** Total rows that failed to apply across all stores (0 unless `partial`). */
  failed: number;
  /** The target slug if a `projects` row was auto-registered this run, else null (C2). */
  registered_project: string | null;
  totals: Record<ImportClassification, number>;
  per_store: Record<string, Record<ImportClassification, number>>;
  result?: Record<string, ImportStoreResult>;
  conflicts: ImportConflictResolution[];
  context_docs: {
    new: number;
    unchanged: number;
    conflict: number;
    written: string[];
    backed_up: string[];
  };
  source_fingerprint: string;
  reembed_hint: string;
  scope_note: string;
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

// ---------------------------------------------------------------------------
// FR-238 — `igris dashboard` (local server verb + application shell).
//
// These are the SHARED payload interfaces. `cli/dashboard/src/lib/api.ts`
// mirrors them browser-side; a rename here MUST sweep that file, `routes.ts`,
// the tests, and `docs/dashboard.md` in the same commit (MAINTAINING contract).
// ---------------------------------------------------------------------------

/** Flags accepted by `igris dashboard`. */
export interface DashboardOptions {
  /** Exact port. When taken, the verb HARD-FAILS — explicit intent is never silently reassigned. */
  port?: number;
  /** Do not launch a browser. */
  noOpen?: boolean;
  /** Hidden self-check: start, probe `/` + `/api/health`, print a JSON digest, exit. */
  smoke?: boolean;
}

/**
 * The single-instance lockfile written to `~/.igris/dashboard.lock`.
 *
 * `process_start_time` is what makes the guard pid-reuse-proof: a recycled pid
 * belonging to an unrelated process has a different `ps -o lstart=` value, so
 * the lock is correctly classified stale. Same discipline as the FR-190
 * instance-liveness model (`process-liveness.ts`).
 */
export interface DashboardLock {
  pid: number;
  port: number;
  url: string;
  started_at: string;
  /** `ps -p <pid> -o lstart=` at write time; null when unobtainable. */
  process_start_time: string | null;
}

/** Uniform degradation signal. EVERY endpoint carries this; null means healthy. */
export interface DashboardDegraded {
  reason: string;
}

/** `GET /api/health`. */
export interface HealthPayload {
  ok: boolean;
  cli_version: string;
  brain: {
    present: boolean;
    path: string;
  };
  /** R2: a silent bridge degrade is converted into a visible one via this flag. */
  bridge: {
    available: boolean;
    reason: string | null;
  };
  /**
   * FR-241 — the WRITE surface's availability.
   *
   * Separate from `bridge` on purpose: they can disagree. `bridge` reports the
   * pure READ modules; `write` reports the engine module plus a brain on disk.
   * The AC is *disabled, not broken* — when this is false the shell hides the
   * triage affordances rather than offering buttons that will fail.
   *
   * `state` is the lazy-boot fact (`"not-booted"` / `"booted"` /
   * `"unavailable:<kind>"`). `available:true` with `state:"not-booted"` is the
   * NORMAL state of a browsing session and is exactly what FR-241's G-RO-6
   * asserts after the FR-240 read-only request sequence.
   */
  write: {
    available: boolean;
    reason: string | null;
    state: string;
    /** The complete set of mutations this build can perform. */
    actions: string[];
  };
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/** One row of `GET /api/projects`. */
export interface DashboardProject {
  slug: string;
  name: string;
  path: string;
  status: string;
  last_session_at: string;
}

/** `GET /api/projects`. */
export interface ProjectsPayload {
  projects: DashboardProject[];
  /**
   * The slug the shell should select on FIRST load, resolved server-side by
   * `dashboard/default-project.ts`'s ladder (cwd project -> most recently
   * active -> first alphabetically). Server-side because the top rung is the
   * directory the CLI was invoked from, which the browser cannot know. `null`
   * only when the list is empty or the brain is unreachable. It is an INITIAL
   * selection, not a constraint — the browser switches projects freely.
   */
  default_project: string | null;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/** `GET /api/summary[?project=<slug>]`. */
export interface SummaryPayload {
  /**
   * The scope these counts were taken at. `null` means the project predicate
   * was DROPPED (BR-082) — every `brief_status` row and every active instance,
   * including any whose project is NULL or unregistered. It is not "the sum
   * over the registered projects", and it is not a degradation.
   */
  project: string | null;
  briefs: AssessBriefs;
  instances: { active: number };
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/**
 * `GET /api/graph/stats?project=<slug>` — the FR-237 `BrainGraph` payload with
 * `nodes` and `edges` STRIPPED at the route layer.
 *
 * The stripping is a structural fence, not a discipline one (R8): the shell
 * physically cannot render a graph from this, so FR-239's scope cannot leak
 * backwards into FR-238. It also keeps the response a few KB regardless of
 * brain size.
 */
export interface BrainGraphStatsPayload {
  project: string | null;
  /** Mirrors `BrainGraphStats` from `whole-graph.ts`; null when the bridge is unavailable. */
  stats: Record<string, unknown> | null;
  /** Mirrors `EdgeResolutionReport`; null when the bridge is unavailable. */
  edge_resolution: Record<string, unknown> | null;
  truncated: boolean;
  truncation_reason: string | null;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/**
 * `GET /api/graph?project=<slug>` — FR-239. The node/edge arrays `/api/graph/
 * stats` deliberately strips, plus a SERVER-COMPOSED query twin.
 *
 * WHY THIS IS A SECOND ENDPOINT AND NOT A FLAG ON THE FIRST. `/api/graph/stats`
 * is the cheap, always-safe readout the Overview polls every 5 s; this one is a
 * ~1 MB body fetched ONCE per scope (D8). Merging them would either make the
 * Overview's poll expensive or make this one's payload optional — and an
 * optional payload is a shape the browser has to branch on forever.
 *
 * FR-237's own caps (15,000 nodes / 20,000 edges) are the ONLY ceiling. No
 * second render cap is applied here: a second ceiling can silently disagree
 * with `whole_brain_graph.md` §5, and density is a RENDERING concern that the
 * dataviz degradation ladder already owns (D3).
 */
export interface BrainGraphPayload {
  project: string | null;
  /** Mirrors `BrainGraphNode[]` from `whole-graph.ts:117`. Empty when degraded. */
  nodes: BrainGraphNodePayload[];
  /** Mirrors `BrainGraphEdge[]` from `whole-graph.ts:142`. Empty when degraded. */
  edges: BrainGraphEdgePayload[];
  /** Mirrors `BrainGraphStats`; null when the bridge is unavailable. */
  stats: Record<string, unknown> | null;
  truncated: boolean;
  truncation_reason: string | null;
  /**
   * dataviz.md exemption 04 — "the query is the twin". Composed SERVER-side on
   * purpose: a twin the browser assembles is a caption the client invented, not
   * a statement of what produced the node set.
   */
  query: GraphQueryTwin;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/** One node on the wire. Field-for-field `BrainGraphNode` (whole-graph.ts:117). */
export interface BrainGraphNodePayload {
  key: string;
  type: string;
  id: string;
  project: string | null;
  label: string;
  attrs: Record<string, unknown>;
  degree: number;
  boundary?: true;
  phantom?: true;
}

/** One edge on the wire. Field-for-field `BrainGraphEdge` (whole-graph.ts:142). */
export interface BrainGraphEdgePayload {
  id: string;
  source_edge_id: number;
  from: string;
  to: string;
  type: string;
  confidence: number;
  provenance: string;
  resolution: "unique" | "replicated";
}

/**
 * The dataviz exemption-04 twin, and the replacement for diagram rules 06/08:
 * a surface ID, the query that produced the set, and an as-of stamp.
 */
export interface GraphQueryTwin {
  /** Stable surface identifier — the `FIG. N` equivalent. */
  surface: string;
  /** The query, as displayable lines. Mono, rendered verbatim. */
  query: string[];
  /** ISO timestamp the node set was produced at. */
  as_of: string;
  /** `2,422 NODES · 1,003 EDGES`, or the degraded/truncated rendering. */
  scale: string;
}

// ---------------------------------------------------------------------------
// FR-240 — the four layer views (briefs, learnings, context docs, goals).
//
// Nine read-only endpoints. Same rules as the FR-238/239 block above: these are
// the SHARED interfaces, `cli/dashboard/src/lib/api.ts` mirrors them
// browser-side, and a rename here sweeps that file, `routes.ts`, the tests and
// `docs/dashboard.md` in the same commit (MAINTAINING row 108).
//
// EVERY list payload carries the same `{items, count, total, limit, offset}`
// envelope shape borrowed from `igris_brief_list` / `igris_goal_list`, and NONE
// carries body content (D7). Body text is detail-only.
// ---------------------------------------------------------------------------

/**
 * Notes about inputs the endpoint clamped, dropped or did not recognise.
 *
 * Distinct from `degraded`, deliberately. `degraded` means "the DATA is
 * incomplete"; this means "your REQUEST was adjusted". Conflating them would
 * make a mistyped filter look like a broken brain.
 */
export type DashboardParamNotes = string[];

/**
 * FR-246 D3-f — how a `q`-bearing LIST payload reports what it actually did.
 *
 * The four `q` surfaces (goals, context docs, suggestions, candidates) do
 * `LIKE '%q%'` over a named field list. No ranking, no recall. This block says
 * so IN THE PAYLOAD rather than in a sentence hard-coded in the client,
 * because a hard-coded sentence is the claim that goes stale the day someone
 * swaps the implementation and no gate can catch it. `G-BR-13b` asserts that
 * no surface reporting `mode: "substring"` renders a hybrid/recall readout.
 *
 * `null` when no `q` was supplied — distinguishable from an ABSENT key, which
 * would mean "this surface has no search at all".
 *
 * `mode` is a one-member union deliberately: a surface that gains real
 * retrieval returns {@link RetrievalPayload} instead, so there is no way to
 * widen this into a label that lies.
 */
export interface SubstringSearchPayload {
  mode: "substring";
  /** The columns the LIKE was applied to, in SQL order. */
  fields: string[];
}

/** `GET /api/briefs` — one row. Field-for-field `briefs-read.ts` list columns. */
export interface BriefListRowPayload {
  project: string;
  brief_id: string;
  brief_type: string | null;
  title: string;
  status: string;
  priority: string | null;
  effort: string | null;
  phase: string | null;
  updated_at: string;
}

/** `GET /api/briefs?project=&status=&priority=&effort=&brief_type=&limit=&offset=`. */
export interface BriefsPayload {
  items: BriefListRowPayload[];
  count: number;
  total: number;
  limit: number;
  offset: number;
  /** Inputs that were clamped/dropped. Empty when the request was clean. */
  params: DashboardParamNotes;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/**
 * `GET /api/brief?project=<slug>&id=<brief_id>` — mirrors
 * `briefs-read.ts:87#BriefRecord`.
 *
 * BOTH params are REQUIRED (BR-078): `BR-001` names a different brief in 25
 * projects, so an id-only lookup would fuse records across projects. A missing
 * `project` is a REFUSAL, not a first-match.
 */
export interface BriefDetailPayload {
  brief: {
    project: string;
    brief_id: string;
    content: string | null;
    filename: string | null;
    content_hash: string | null;
    title: string | null;
    status: string | null;
    priority: string | null;
    effort: string | null;
    phase: string | null;
    brief_type: string | null;
    updated_at: string | null;
  } | null;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/** `GET /api/learnings` — one row. NO `content` (D7); `content_length` instead. */
export interface LearningListRowPayload {
  id: number;
  project: string;
  category: string;
  title: string;
  tags: string;
  tech_stack: string;
  scope: string;
  source_brief: string;
  confidence: number;
  created_at: string;
  access_count: number;
  provenance: string;
  review_status: string;
  source_extractor: string;
  promoted_to_doc: string | null;
  content_length: number;
  /**
   * FR-241 — how many times perception re-discovered this pattern, and THE
   * DESTRUCTIVENESS DISCRIMINATOR for the triage surface. `> 0` means a reject
   * SOFT-deletes (recoverable); `== 0` means it HARD-deletes the row and its
   * vector entry. A confirmation dialog that cannot tell those apart must
   * either lie ("irreversible" for rows that are not) or under-warn, and the
   * first trains the operator to click through the second.
   */
  seen_again_count: number;
  /** FR-241 — non-null iff the row is already soft-deleted. */
  deleted_at: string | null;
}

/**
 * `GET /api/learnings?project=&category=&scope=&provenance=&review_status=&limit=&offset=`.
 *
 * D9: `review_status` defaults to `approved`. `pending_review` rows are
 * reachable but only when explicitly asked for, and the UI banners them. FR-241
 * owns triage; this brief ships no approve/reject control.
 */
export interface LearningsPayload {
  items: LearningListRowPayload[];
  count: number;
  total: number;
  limit: number;
  offset: number;
  /** Echoed so the UI can banner a non-default value without re-parsing the URL. */
  review_status: string;
  /** FR-246 — what `q` did, or null. */
  search: SubstringSearchPayload | null;
  params: DashboardParamNotes;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/**
 * Which retrieval arms ran on a `/api/learnings/search` call —
 * `memory-read.ts:98#RetrievalReport`, forwarded verbatim.
 *
 * D3, and the thing that makes AC #2 assertable. `mode: "bm25_only"` is a
 * LEGITIMATE state (no sqlite-vec, or a cold/absent HF model cache) and must
 * render as a visible banner. Without this block the degradation is invisible:
 * BM25-only still returns plausible rows.
 */
export interface RetrievalPayload {
  mode: "hybrid" | "bm25_only" | "vector_only" | "none";
  vector_available: boolean;
  embedding_available: boolean;
  bm25_hits: number;
  vector_hits: number;
  rrf_k: number;
  weights: { bm25: number; vector: number };
  /** Why the vector arm degraded, verbatim; null when it ran. */
  reason: string | null;
}

/** One ranked search hit. `rrf_score`/ranks are null on the BM25-only arm. */
export interface LearningSearchRowPayload {
  id: number;
  project: string;
  category: string;
  title: string;
  /** Truncated preview, not the body — full text is `/api/learning`'s job. */
  preview: string;
  tags: string;
  scope: string;
  confidence: number;
  provenance: string;
  created_at: string;
  promoted_to_doc: string | null;
  rrf_score: number | null;
  bm25_rank: number | null;
  vector_rank: number | null;
}

/** `GET /api/learnings/search?q=<query>&project=<slug>&limit=`. */
export interface LearningsSearchPayload {
  query: string;
  items: LearningSearchRowPayload[];
  count: number;
  retrieval: RetrievalPayload;
  params: DashboardParamNotes;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/**
 * FR-246 — `RetrievalPayload` plus the fact briefs have and learnings do not.
 *
 * `learnings_fts` has existed since schema v1, so a learnings search may assume
 * its lexical arm. `briefs_fts` arrives at **v23**, so a brain that has not run
 * the migration has a live vector arm and NO lexical arm — and that has to be
 * REPORTED, for the same reason `vector_available` exists: the alternative is a
 * silently thinner result set that reads like "nothing matched".
 */
export interface BriefRetrievalPayload extends RetrievalPayload {
  /** Why the BM25 arm could not run; null when `briefs_fts` was queryable. */
  bm25_reason: string | null;
}

/**
 * One ranked brief hit.
 *
 * NO `content` (FR-240 D7) — `content_length` instead. Brief bodies average
 * ~3.9 KB, so a ranked list carrying them is the payload term the read layer
 * exists to remove. The body is `/api/brief`'s job.
 */
export interface BriefSearchRowPayload {
  id: number;
  project: string;
  brief_id: string;
  brief_type: string | null;
  title: string;
  status: string;
  priority: string | null;
  effort: string | null;
  phase: string | null;
  updated_at: string;
  content_length: number;
  /** Null on the BM25-only arm, as on the learnings twin. */
  rrf_score: number | null;
  bm25_rank: number | null;
  vector_rank: number | null;
}

/** `GET /api/briefs/search?q=<query>&project=<slug>&limit=` — FR-246. */
export interface BriefsSearchPayload {
  query: string;
  items: BriefSearchRowPayload[];
  count: number;
  retrieval: BriefRetrievalPayload;
  params: DashboardParamNotes;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/** `GET /api/learning?id=<n>` — the full row, body included. */
export interface LearningDetailPayload {
  learning: {
    id: number;
    project: string;
    category: string;
    title: string;
    content: string;
    tags: string;
    tech_stack: string;
    scope: string;
    source_brief: string;
    confidence: number;
    created_at: string;
    access_count: number;
    provenance: string;
  } | null;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/**
 * `GET /api/context-docs?project=<slug>` — the `igris context-docs inventory`
 * digest, forwarded.
 *
 * D8: NO brain involvement. `applies_when` is evaluated by the verb and is
 * deliberately not re-derived server-side.
 */
export interface ContextDocsPayload {
  project: string | null;
  archetype: string | null;
  tech_stack: string | null;
  /** The digest's own degraded flag — profile or catalog data was incomplete. */
  inventory_degraded: boolean;
  /**
   * FR-246: when `q` is supplied this list is FILTERED to the docs whose body
   * matched, each carrying its snippets. `missing_applicable` and
   * `remediation` are deliberately NOT filtered — they are statements about
   * ABSENT docs, and a text filter cannot narrow an absence.
   */
  docs: ContextDocRowPayload[];
  /** Types that apply but are absent. */
  missing_applicable: string[];
  /** `/ground <type>` per missing doc — the DIGEST's array, never hand-written. */
  remediation: string[];
  /** FR-246 — what `q` did, or null. A body GREP, and it says grep. */
  search: SubstringSearchPayload | null;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/**
 * `GET /api/context-doc?project=<slug>&type=<doc type>`.
 *
 * Addressed by catalog TYPE, not by filename. The filename comes from the
 * digest row, which is what makes path traversal unreachable rather than merely
 * filtered (`context-docs-read.ts`).
 */
export interface ContextDocPayload {
  project: string | null;
  type: string | null;
  /** The doc's filename from the digest row, e.g. `coding_guidelines.md`. */
  target: string | null;
  content: string | null;
  bytes: number;
  /** True when the body was cut at the read cap. */
  truncated: boolean;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/** A `goals` row on the wire. Field-for-field `goals/read.ts:43#GoalRow`. */
export interface GoalRowPayload {
  id: number;
  goal_id: string;
  project_slug: string | null;
  title: string;
  description: string | null;
  outcome: string;
  deadline: string | null;
  status: string;
  priority: string;
  created_at: string;
  updated_at: string;
  achieved_at: string | null;
  metadata: string;
}

/**
 * `GET /api/goals` — one row. `goals/read.ts:60#GoalListRow`.
 *
 * `serving_briefs_count` is present on the LIST rows only; the detail endpoint
 * returns the briefs themselves, so a count there would be redundant (and the
 * reader does not compute one).
 */
export interface GoalListRowPayload extends GoalRowPayload {
  serving_briefs_count: number;
}

/** `GET /api/goals?project=&status=&upcoming_days=&limit=&offset=`. */
export interface GoalsPayload {
  items: GoalListRowPayload[];
  count: number;
  total: number;
  limit: number;
  offset: number;
  /** FR-246 — what `q` did, or null. */
  search: SubstringSearchPayload | null;
  params: DashboardParamNotes;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/** `GET /api/goal?id=<GL-XXX>` — `goals/read.ts:97#GoalDetail`. */
export interface GoalDetailPayload {
  goal: GoalRowPayload | null;
  serving_briefs: Array<{
    brief_id: string;
    title: string;
    status: string;
    priority: string;
  }>;
  serving_learnings_count: number;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

// ---------------------------------------------------------------------------
// FR-241 — the triage surface (the first MUTATING endpoint) and its read half
// ---------------------------------------------------------------------------

/**
 * One `suggestions` row on the wire. Field-for-field
 * `suggestions-read.ts:100#SuggestionRow`.
 *
 * `evidence` stays a RAW JSON STRING, exactly as stored. The MCP wrapper parses
 * it (`rowToSuggestion`) because a transcript reader wants an object; a triage
 * row does not render evidence, and parsing it here would put a second copy of
 * that mapping — with its own malformed-JSON behaviour — in the CLI.
 */
export interface SuggestionRowPayload {
  id: number;
  source_module: string;
  project_slug: string | null;
  title: string;
  evidence: string;
  priority: string;
  status: string;
  created_at: string;
  expires_at: string | null;
  dismissed_at: string | null;
  dismissed_reason: string | null;
  acted_at: string | null;
  acted_brief_id: string | null;
  confidence: number | null;
  suggested_action: string | null;
  type_inferred: number;
}

/**
 * `GET /api/suggestions?project=|project_scope=&status=&priority=&source_module=&limit=&offset=`.
 *
 * `facets` is the filter VOCABULARY, counted from the data. `source_module` has
 * been an OPEN vocabulary since FR-118 M2 (the LLM names the kind), so a
 * hand-listed dropdown is a dropdown that hides rows — L-967. The counts are
 * computed over the active filters MINUS `source_module` itself, so selecting
 * one value does not erase the control's own options.
 *
 * TD-326 added the PROJECT axis's third state. `project=<slug>` scopes to one
 * project and `project_scope=brain-level` scopes to `project_slug IS NULL` —
 * two DIFFERENT sets from the unscoped read, which is `everything` (no
 * predicate). `facets.brain_level` counts the `IS NULL` population under the
 * current non-project filters, so a scoped caller can see the population its
 * scope hides without abandoning the scope.
 */
export interface SuggestionsPayload {
  items: SuggestionRowPayload[];
  count: number;
  total: number;
  limit: number;
  offset: number;
  /** `source_module -> count` (count DESC then name ASC) + the `IS NULL` count. */
  facets: { source_module: Record<string, number>; brain_level: number };
  /** FR-246 — what `q` did, or null. */
  search: SubstringSearchPayload | null;
  params: DashboardParamNotes;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/**
 * `POST /api/triage` — the request body.
 *
 * ONE endpoint with an `action` discriminator rather than five verb endpoints
 * (D3). The whole delegation rule is then a single frozen map a
 * reviewer reads in one glance, and "the server layer performs no mutation of
 * its own" is true by construction: there is no other route that can write.
 */
export interface TriageRequest {
  /** One of `brain-write-bridge.ts#TRIAGE_ACTIONS`' keys. */
  action: string;
  /**
   * Positive integers. `apply` accepts exactly one (D4).
   *
   * FR-247: required for a `target: "id"` action and REFUSED for a
   * `target: "brief-ref"` one. Never both `ids` and `refs`.
   */
  ids?: number[];
  /**
   * FR-247 — the BRIEF address. A brief is the `(project, brief_id)` PAIR:
   * `igris_brief_update` declares `required: ['project','brief_id']` and no
   * brain tool accepts `brief_status.id`, so the integer key the other five
   * actions use cannot address one. This widens the BODY, not the path set —
   * `POST /api/triage` is still the only write endpoint.
   */
  refs?: { project: string; brief_id: string }[];
  /**
   * Free-text dismissal/rejection reason. NOT decoration: it feeds
   * `dismissed_patterns` and therefore the suppression loop that stops the
   * backlog re-growing. A blind clear throws that signal away.
   */
  reason?: string;
  /** `acted` only — which brief the operator opened in response. */
  brief_id?: string;
  /**
   * FR-247 `set_priority` only. NOT validated against a vocabulary here: the
   * server allow-lists the KEY, the brain's `normalizePriority` folds the
   * VALUE, and the picker prescribes the CHOICES. Three layers, three jobs.
   */
  priority?: string;
  /** FR-247 `attach_goal` only — an EXISTING `goals.goal_id` (`GL-XXX`). */
  goal_id?: string;
}

/**
 * One item's outcome. `error` is the BRAIN's verbatim message, never a rewrite.
 *
 * FR-247: exactly one of `id` / `ref` is populated, matching the action's
 * target. A client renders whichever is non-null.
 */
export interface TriageItemResultPayload {
  id: number | null;
  ref: { project: string; brief_id: string } | null;
  ok: boolean;
  error: string | null;
}

/**
 * `POST /api/triage` — the response.
 *
 * D6: NO cross-id transaction. Each id is its own handler call and its own
 * transaction, so a partial failure is REPORTED per id rather than rolled back
 * — wrapping N dispatches would mean this tier running `BEGIN` on the brain,
 * which is the raw-SQL mutation it exists to forbid.
 *
 * ALWAYS 200 when the request itself was well-formed, including when the write
 * surface is down (`degraded` set, `applied: 0`). A malformed body is a genuine
 * 400: a client bug is not a degraded brain, and collapsing the two makes both
 * undiagnosable.
 */
export interface TriageResultPayload {
  action: string;
  requested: number;
  applied: number;
  failed: number;
  results: TriageItemResultPayload[];
  params: DashboardParamNotes;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/** What `igris dashboard --smoke` prints to stdout. */
export interface DashboardDigest {
  ok: boolean;
  url: string;
  port: number;
  bundle_dir: string;
  bundle_present: boolean;
  checks: Array<{ path: string; status: number; ok: boolean }>;
  brain_present: boolean;
  bridge_available: boolean;
}
