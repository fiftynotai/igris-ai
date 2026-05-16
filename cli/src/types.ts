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
  brain_channel: "release" | "main" | "tag" | null;
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
  /** sha256 of `~/.igris/core/rules/00-igris-universal.md`, or null when not present. */
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
    | "mcp-unregistered";
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
 */
export type Channel = "release" | "main" | "tag";

/**
 * Per-CLI bridge target. Phase 2 supports four CLIs natively; bridges
 * are emitted for any subset. Auto-detection (cli-detect.ts) returns
 * a Set of these values.
 */
export type CLITarget = "claude" | "codex" | "gemini" | "opencode";

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
