/**
 * TD-223 (RE-SCOPED — corrected root cause): migrate the legacy v6-era
 * WHOLE-DIR symlinks `~/.claude/skills` and `~/.claude/agents` (both pointing
 * AT the canonical source `~/.igris/core/{skills,agents}`) to the per-surface
 * model — a REAL directory of per-item symlinks — and clean the projection
 * symlinks that leaked INTO the canonical source.
 *
 * CORRECTED ROOT CAUSE (verified live; brain #629):
 * `~/.claude/skills` (and `~/.claude/agents`) are v6-era whole-dir symlinks
 * that point at the canonical source. The per-surface model (FR-149 etc.) wants
 * each of `~/.claude/{skills,agents}` to be a REAL dir of per-item symlinks. A
 * live `igris harness compile --surface skills` resolves `~/.claude/skills/<n>`
 * THROUGH the parent symlink and writes the per-item symlink INTO the canonical
 * source (`~/.igris/core/skills/<n>`) — active damage. The verified leaks are
 * `~/.igris/core/skills/content-pipeline` + `~/.igris/core/agents/content-*.md`,
 * each a projection symlink into the registry, not real core content.
 *
 * The PRIOR plan ("21 materialized real-dir COPIES pollute ~/.claude/skills")
 * was a misdiagnosis: the "real dirs" were an artifact of `ls`-through-a-parent-
 * symlink. The classifier's realpath fast-path (entry resolves to the canonical)
 * is exactly what masked the whole-dir-symlink condition as "clean". The fix
 * detects the migration condition on the ROOT (parent symlink-ness) BEFORE
 * iterating children (brain #629).
 *
 * SHAPE: models `secret-perms.ts` — both `igris doctor` (read pass: detect+warn;
 * `--fix`: migrate) import this module so they can never disagree on what the
 * "migration condition" is or how a surface root is migrated.
 *
 * CONTRACT: nothing in this module ever throws. An absent surface root, a
 * Windows host, a missing manifest, an unreadable file, or a race that makes a
 * just-stat'd entry vanish must all degrade to a safe default (clean / no-op) —
 * doctor must never crash on migration work.
 *
 * WHY NOT compile-repopulate (Option 2a — rejected): the live runtime adapter
 * runs under `~/.igris/`, so the TD-224 commonpath gate does NOT union the core
 * skills block from a normal operator project-root (zero core skills projected),
 * and there is NO `claude` target for the 7 core agents at all. Replacing the
 * symlink with an empty real dir + `igris harness compile` would LOSE every
 * skill and every core agent. Therefore `--fix` DIRECTLY MATERIALIZES per-item
 * symlinks from a verified inventory (canonical source walk + personal overlay).
 *
 * SAFETY (the `--fix` path mutates the operator's live `~/.claude` + the
 * canonical `~/.igris/core` source):
 * - Direct-materialize, NOT compile: enumerate the inventory the symlink
 *   currently exposes and recreate it as per-item symlinks; the AFTER resolvable
 *   name set MUST ⊇ the BEFORE set (the before/after enumeration is the proof,
 *   enforced by the test suite and printed by `--fix`).
 * - Backup-not-delete: the old ROOT symlink is renamed to `R.bak-<UTCstamp>`
 *   (records its original target; trivially reversible). NEVER `rm`s the
 *   canonical CONTENT it pointed at.
 * - Atomic, no visibility gap: a sibling staging REAL dir is fully populated,
 *   the old root symlink is renamed to the backup, then the staging dir is
 *   `rename(2)`'d into place (kernel rename REPLACES the now-absent name).
 * - Refuse-on-divergence (L-515): a root that is a symlink to something OTHER
 *   than the canonical source is REFUSED + reported, untouched. A stray source
 *   symlink whose realpath is NOT contained in the registry is report-only.
 * - realpath containment (#515 — two prior warden rejections): EVERY mutation
 *   (staging dir, backup, per-item symlink, stray unlink) is realpath-contained
 *   within the declared root / registry before acting; a symlink-escape refuses.
 * - Idempotent: once a root is a real dir the migration verdict is false, so a
 *   re-run is a no-op (no 2nd `.bak`).
 * - Stray cleanup NEVER `rm`s a real dir or canonical content: it `unlink`s ONLY
 *   a depth-1 SYMLINK whose realpath is contained in `~/.igris/registry/` AND
 *   only after the migrated per-item symlink exists in the real surface dir.
 *
 * Security (§14 / L-515): every diagnostic names a path / item name only —
 * NEVER the contents of a skill or agent file.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { brainDir, registryDirPath, registryOverlayPath } from "./paths.js";
import { debug } from "./log.js";

// ---------------------------------------------------------------------------
// Skip-list parity with the drift tree-hash walker (informational here — TD-223
// no longer content-verifies real-dir copies, but enumerateCanonicalSkills uses
// skippedName to ignore OS cruft / aux files when walking the source). Kept
// aligned with the bash `EXACT` set + prefix/suffix rules.
// ---------------------------------------------------------------------------
const SKIP_EXACT = new Set([
  "MAINTAINING.md",
  ".DS_Store",
  "node_modules",
  ".venv",
  "__pycache__",
  "REGISTRY-NOTICE.md",
]);

function skippedName(name: string): boolean {
  if (SKIP_EXACT.has(name)) return true;
  if (name.startsWith(".git")) return true;
  if (name.endsWith(".pyc")) return true;
  return false;
}

/** Which managed surface a root belongs to — skills vs agents. */
export type SurfaceKind = "skills" | "agents";

/**
 * True when POSIX symlink semantics are meaningful on this host — i.e. NOT
 * win32. On native Windows the compiler does not use symlinks for these
 * surfaces and `lstat`/`symlink` behave differently, so migration detection is
 * a no-op there (mirrors `permsCheckSupported` in secret-perms.ts).
 *
 * @param platform Test seam — defaults to `process.platform`.
 */
export function pollutionCheckSupported(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32";
}

/** realpath if resolvable, else the input path verbatim. NEVER throws. */
function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Resolve a manifest path string the same 3-case way the adapters do
 * (compile_harnesses.sh:1554): a leading `~/` expands against $HOME, an
 * absolute path is verbatim, otherwise it is relative to the brain root's
 * containing dir.
 */
function resolveManifestPath(value: string): string {
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  if (value.startsWith("/")) {
    return value;
  }
  return join(brainDir(), value);
}

/**
 * Absolute path to the core-owned surfaces manifest. Honors IGRIS_BRAIN_DIR via
 * brainDir(), so tests sandbox it through the same seam every other helper uses.
 */
export function surfacesManifestPath(): string {
  return join(
    brainDir(),
    "core",
    "scripts",
    "cli-adapters",
    "surfaces-manifest.json",
  );
}

/** Absolute path to the canonical core skills source root. */
export function coreSkillsSource(): string {
  return join(brainDir(), "core", "skills");
}

/** Absolute path to the canonical core agents source root. */
export function coreAgentsSource(): string {
  return join(brainDir(), "core", "agents");
}

// ===========================================================================
// Surface roots + the migration condition (brain #629: inspect the ROOT first)
// ===========================================================================

/** A declared surface root + its canonical source + which surface it is. */
export interface SurfaceRoot {
  kind: SurfaceKind;
  /** Resolved absolute declared target root (e.g. `~/.claude/skills` → /abs). */
  root: string;
  /** Resolved absolute canonical source root (`~/.igris/core/{skills,agents}`). */
  source: string;
}

/**
 * Read the core surfaces manifest and return the declared `claude/symlink`
 * skills target root(s) plus the canonical agents target root, each paired with
 * its source. NEVER throws — an absent / malformed manifest yields the default
 * pair set so detection still works against a live machine even if the manifest
 * is missing.
 *
 * The skills root is read from the manifest's `surfaces.skills[*].targets[]`
 * (type=claude, method=symlink). The agents root is `~/.claude/agents` — the
 * manifest has no claude agent target (the 7 core agents reach `~/.claude/agents`
 * EXCLUSIVELY through the legacy whole-dir symlink, §1.3), so it is synthesized
 * here against $HOME.
 */
export function declaredSurfaceRoots(
  manifestPath: string = surfacesManifestPath(),
): SurfaceRoot[] {
  const out: SurfaceRoot[] = [];

  // Skills: parse the manifest's claude/symlink skills targets.
  let parsed: unknown = null;
  try {
    if (existsSync(manifestPath)) {
      parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
    }
  } catch {
    parsed = null;
  }
  const skillRoots = new Set<string>();
  // The migration restores each `<root>/<name>` core skill against the CORE
  // block's declared source (the `~/.igris/core/skills` the whole-dir symlink
  // exposes). Default to the canonical `~/.igris/core/skills` (HOME-resolved,
  // matching the manifest's path-resolution semantics), NOT coreSkillsSource()
  // (which uses brainDir() — these diverge when IGRIS_BRAIN_DIR != $HOME/.igris).
  let skillSource = join(homedir(), ".igris", "core", "skills");
  const blocks = (parsed as { surfaces?: { skills?: unknown } } | null)
    ?.surfaces?.skills;
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (block === null || typeof block !== "object") continue;
      const b = block as { source?: unknown; targets?: unknown };
      const sourceRaw =
        typeof b.source === "string" && b.source.length > 0
          ? b.source
          : "~/.igris/core/skills";
      const resolvedSource = resolveManifestPath(sourceRaw);
      const targets = b.targets;
      if (!Array.isArray(targets)) continue;
      for (const t of targets) {
        if (t === null || typeof t !== "object") continue;
        const tt = t as { type?: unknown; method?: unknown; path?: unknown };
        if (tt.type !== "claude" || tt.method !== "symlink") continue;
        if (typeof tt.path !== "string" || tt.path.length === 0) continue;
        const root = resolveManifestPath(tt.path);
        skillRoots.add(root);
        // The CORE block is the one whose declared source path ends in
        // `core/skills` (the source the whole-dir symlink points at); remember
        // its RESOLVED manifest path as the restore source. Personal blocks
        // share the SAME claude root and are added to the inventory separately
        // (enumeratePersonalSkills), so they collapse into the root set.
        const normSource = resolvedSource.replace(/\/+$/, "");
        if (
          normSource.endsWith(`${sep}core${sep}skills`) ||
          normSource.endsWith("/core/skills")
        ) {
          skillSource = resolvedSource;
        }
      }
    }
  }
  if (skillRoots.size === 0) {
    // Manifest absent / no claude skills block — fall back to the canonical
    // `~/.claude/skills` so a live machine with a missing manifest still gets
    // its legacy whole-dir symlink detected.
    skillRoots.add(join(homedir(), ".claude", "skills"));
  }
  for (const root of [...skillRoots].sort()) {
    out.push({ kind: "skills", root, source: skillSource });
  }

  // Agents: synthesized — `~/.claude/agents` ← `~/.igris/core/agents`. Both are
  // HOME-resolved (the legacy whole-dir symlink points at the HOME-rooted
  // source), matching the manifest's path-resolution semantics — NOT
  // coreAgentsSource() (brainDir()), which diverges when
  // IGRIS_BRAIN_DIR != $HOME/.igris.
  out.push({
    kind: "agents",
    root: join(homedir(), ".claude", "agents"),
    source: join(homedir(), ".igris", "core", "agents"),
  });

  return out;
}

/**
 * The migration verdict for a single surface root (§3.1). NEVER throws.
 *
 * - `migrate`            — R is a symlink AND realpath(R) === realpath(source):
 *                          the legacy whole-dir symlink to the canonical source.
 *                          Migrate to a real dir of per-item symlinks.
 * - `unexpected-symlink` — R is a symlink to something OTHER than the source.
 *                          REFUSE + report; never silently rewrite (L-515).
 * - `real-dir`           — R is already a real dir (per-surface model already in
 *                          place, or absent-but-creatable). Not the migration
 *                          condition; no-op.
 * - `missing`            — R does not exist. Nothing to migrate.
 */
export type SurfaceRootVerdict =
  | "migrate"
  | "unexpected-symlink"
  | "real-dir"
  | "missing";

/**
 * Classify a surface ROOT by inspecting ITS symlink-ness FIRST (brain #629),
 * before any child enumeration. NEVER throws.
 */
export function classifySurfaceRoot(
  root: string,
  source: string,
): SurfaceRootVerdict {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(root);
  } catch {
    return "missing";
  }
  if (st.isSymbolicLink()) {
    // The DECISIVE check: does the root symlink resolve to the canonical
    // source? If so it is the legacy whole-dir symlink → migrate. Anything
    // else is an unexpected target → refuse.
    if (realpathSafe(root) === realpathSafe(source)) {
      return "migrate";
    }
    return "unexpected-symlink";
  }
  // A real dir (or any non-symlink) is the per-surface shape already.
  return "real-dir";
}

// ===========================================================================
// Inventory enumeration — canonical source + personal overlay
// ===========================================================================

/**
 * Enumerate the canonical core skill names under a source root: every `<name>`
 * with a `<source>/<name>/SKILL.md`. NEVER throws — an absent / unreadable
 * source root yields `[]`. A `<name>` that is itself a symlink (a leaked
 * projection stray) is EXCLUDED: it is not a real core skill, so it must not be
 * re-materialized as a core-targeted symlink (its real home is the overlay-
 * sourced personal entry).
 */
export function enumerateCanonicalSkills(source: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    if (!existsSync(source)) return [];
    names = readdirSync(source);
  } catch {
    return [];
  }
  for (const name of names) {
    if (skippedName(name)) continue;
    const child = join(source, name);
    try {
      // Exclude a depth-1 symlink — a leaked projection, not a real core skill.
      if (lstatSync(child).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    const skillMd = join(child, "SKILL.md");
    try {
      if (existsSync(skillMd) && statSync(skillMd).isFile()) {
        out.push(name);
      }
    } catch {
      // Unreadable entry — skip it.
    }
  }
  return out.sort();
}

/**
 * Enumerate the canonical core agent names under a source root: every
 * `<name>.md` regular file. NEVER throws. A `<name>.md` that is itself a symlink
 * (a leaked projection stray) is EXCLUDED (same rationale as the skills walk).
 * `manifest.yaml` is NOT an agent — it is returned separately (see
 * {@link enumerateAgentAuxFiles}) so the real dir can preserve it.
 */
export function enumerateCoreAgents(source: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    if (!existsSync(source)) return [];
    names = readdirSync(source);
  } catch {
    return [];
  }
  for (const name of names) {
    if (skippedName(name)) continue;
    if (!name.endsWith(".md")) continue;
    const child = join(source, name);
    try {
      if (lstatSync(child).isSymbolicLink()) continue; // leaked projection
      if (statSync(child).isFile()) out.push(name);
    } catch {
      // Unreadable entry — skip it.
    }
  }
  return out.sort();
}

/**
 * Enumerate agent-dir auxiliary files that are NOT agents but must be preserved
 * in the migrated real dir (notably `manifest.yaml`). NEVER throws. Returns
 * regular-file names only (not dirs, not symlinks). The migrated real dir
 * symlinks each back to `<source>/<name>` so the dir stays content-complete.
 */
export function enumerateAgentAuxFiles(source: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    if (!existsSync(source)) return [];
    names = readdirSync(source);
  } catch {
    return [];
  }
  for (const name of names) {
    if (skippedName(name)) continue;
    if (name.endsWith(".md")) continue; // an agent, handled by enumerateCoreAgents
    const child = join(source, name);
    try {
      if (lstatSync(child).isSymbolicLink()) continue;
      if (statSync(child).isFile()) out.push(name);
    } catch {
      // skip unreadable
    }
  }
  return out.sort();
}

/** One inventory item to materialize: a link `<root>/<linkName>` → `target`. */
export interface InventoryItem {
  /** The basename of the per-item symlink under the surface root. */
  linkName: string;
  /** Absolute path the per-item symlink should point at. */
  target: string;
  /** Provenance, for diagnostics only. */
  origin: "core" | "personal" | "aux";
}

/**
 * Enumerate personal SKILL entries from the overlay's `surfaces.skills[]`. Each
 * block's `source` is the FULL skill dir (e.g.
 * `~/.igris/registry/skills/content-pipeline`), and the per-item symlink lives
 * at `<root>/<linkName>` where `<linkName>` is the basename of the source AND
 * the target is the L-517 nested `<source>/<linkName>` (the directory that
 * actually contains SKILL.md — matches the compile output). NEVER throws.
 *
 * Only blocks that declare a `claude/symlink` target whose resolved path equals
 * the surface root are included (so a project-scoped or other-harness block does
 * not pollute the skills root).
 */
export function enumeratePersonalSkills(
  surfaceRoot: string,
  overlayPath: string = registryOverlayPath(),
): InventoryItem[] {
  const out: InventoryItem[] = [];
  let parsed: unknown;
  try {
    if (!existsSync(overlayPath)) return [];
    parsed = JSON.parse(readFileSync(overlayPath, "utf-8"));
  } catch {
    return [];
  }
  const blocks = (parsed as { surfaces?: { skills?: unknown } } | null)
    ?.surfaces?.skills;
  if (!Array.isArray(blocks)) return [];
  const rootReal = realpathSafe(surfaceRoot);
  for (const block of blocks) {
    if (block === null || typeof block !== "object") continue;
    const b = block as { source?: unknown; targets?: unknown };
    if (typeof b.source !== "string" || b.source.length === 0) continue;
    const sourceDir = resolveManifestPath(b.source);
    const targets = b.targets;
    if (!Array.isArray(targets)) continue;
    // Find a claude/symlink target whose path resolves to this surface root.
    let matchesRoot = false;
    for (const t of targets) {
      if (t === null || typeof t !== "object") continue;
      const tt = t as { type?: unknown; method?: unknown; path?: unknown };
      if (tt.type !== "claude" || tt.method !== "symlink") continue;
      if (typeof tt.path !== "string" || tt.path.length === 0) continue;
      if (realpathSafe(resolveManifestPath(tt.path)) === rootReal) {
        matchesRoot = true;
        break;
      }
    }
    if (!matchesRoot) continue;
    const linkName = basename(sourceDir);
    // L-517 nested layout: the SKILL.md lives at <sourceDir>/<linkName>/SKILL.md
    // (matches TD-218's de-dup'd compile output). Target the nested dir if it
    // exists, else fall back to the source dir itself (defensive).
    const nested = join(sourceDir, linkName);
    const target =
      existsSync(join(nested, "SKILL.md")) && safeIsDir(nested)
        ? nested
        : sourceDir;
    out.push({ linkName, target, origin: "personal" });
  }
  return out;
}

/**
 * Enumerate personal AGENT entries from the overlay's `agents[]`. Each agent
 * with a `claude` target whose resolved path lives directly under `surfaceRoot`
 * is materialized as `<surfaceRoot>/<name>.md` → `<canonical.dir>/harness.claude.md`
 * (matches assembleClaudeHarness / atomic_symlink). NEVER throws.
 */
export function enumeratePersonalAgents(
  surfaceRoot: string,
  overlayPath: string = registryOverlayPath(),
): InventoryItem[] {
  const out: InventoryItem[] = [];
  let parsed: unknown;
  try {
    if (!existsSync(overlayPath)) return [];
    parsed = JSON.parse(readFileSync(overlayPath, "utf-8"));
  } catch {
    return [];
  }
  const agents = (parsed as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(agents)) return [];
  const rootReal = realpathSafe(surfaceRoot);
  for (const agent of agents) {
    if (agent === null || typeof agent !== "object") continue;
    const a = agent as {
      name?: unknown;
      canonical?: { dir?: unknown };
      targets?: unknown;
    };
    if (typeof a.name !== "string" || a.name.length === 0) continue;
    const canonicalDir =
      a.canonical && typeof a.canonical === "object"
        ? (a.canonical as { dir?: unknown }).dir
        : undefined;
    if (typeof canonicalDir !== "string" || canonicalDir.length === 0) continue;
    const targets = a.targets;
    if (!Array.isArray(targets)) continue;
    let claudeTargetPath: string | null = null;
    for (const t of targets) {
      if (t === null || typeof t !== "object") continue;
      const tt = t as { type?: unknown; path?: unknown };
      if (tt.type !== "claude") continue;
      if (typeof tt.path !== "string" || tt.path.length === 0) continue;
      claudeTargetPath = resolveManifestPath(tt.path);
      break;
    }
    if (claudeTargetPath === null) continue;
    // The claude target must live directly under this surface root.
    if (realpathSafe(dirname(claudeTargetPath)) !== rootReal) continue;
    const linkName = basename(claudeTargetPath);
    const target = join(resolveManifestPath(canonicalDir), "harness.claude.md");
    out.push({ linkName, target, origin: "personal" });
  }
  return out;
}

/** lstat-safe directory test. NEVER throws. */
function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Build the full per-item inventory for a surface root: the canonical core items
 * (skills or agents + aux files) PLUS the personal overlay items. The list is
 * de-duplicated by `linkName` (core wins on a name collision — a personal block
 * should never shadow a core item, but de-dupe defensively). NEVER throws.
 */
export function buildSurfaceInventory(
  surface: SurfaceRoot,
  overlayPath: string = registryOverlayPath(),
): InventoryItem[] {
  const items: InventoryItem[] = [];
  if (surface.kind === "skills") {
    for (const name of enumerateCanonicalSkills(surface.source)) {
      items.push({
        linkName: name,
        target: join(surface.source, name),
        origin: "core",
      });
    }
    for (const it of enumeratePersonalSkills(surface.root, overlayPath)) {
      items.push(it);
    }
  } else {
    for (const name of enumerateCoreAgents(surface.source)) {
      items.push({
        linkName: name,
        target: join(surface.source, name),
        origin: "core",
      });
    }
    for (const name of enumerateAgentAuxFiles(surface.source)) {
      items.push({
        linkName: name,
        target: join(surface.source, name),
        origin: "aux",
      });
    }
    for (const it of enumeratePersonalAgents(surface.root, overlayPath)) {
      items.push(it);
    }
  }
  // De-dupe by linkName, first-wins (core/aux precede personal in the order
  // above, so a name collision keeps the canonical item).
  const seen = new Set<string>();
  const deduped: InventoryItem[] = [];
  for (const it of items) {
    if (seen.has(it.linkName)) continue;
    seen.add(it.linkName);
    deduped.push(it);
  }
  return deduped;
}

// ===========================================================================
// The migration converter (§3.3) + the before/after enumeration
// ===========================================================================

/** Outcome of a single {@link migrateSurfaceRoot} call. */
export type MigrateOutcome =
  | "migrated" // root converted to a real dir of per-item symlinks
  | "skipped-not-migratable" // not the migration condition at fix time (real dir / missing)
  | "refused-unexpected-target" // root is a symlink to a NON-canonical target
  | "refused-containment" // a staging/backup/per-item path escaped the root
  | "error"; // unexpected failure during mutation (logged at debug)

/** A name resolvable under a surface root, for the before/after proof. */
export interface ResolvableName {
  name: string;
  /** Absolute path the name resolves to (the canonical/overlay target). */
  target: string;
}

/** Result of a {@link migrateSurfaceRoot} call. */
export interface MigrateResult {
  outcome: MigrateOutcome;
  /** The backup path created (`R.bak-<UTCstamp>`), when outcome=migrated. */
  backupPath?: string;
  /** Names resolvable BEFORE migration (via the whole-dir symlink). */
  before: ResolvableName[];
  /** Names materialized AFTER migration (the per-item symlinks created). */
  after: ResolvableName[];
}

/**
 * UTC timestamp suffix `YYYYMMDDTHHMMSSZ` — sortable, filesystem-safe, and
 * collision-free across idempotent re-runs.
 */
function utcStamp(date: Date = new Date()): string {
  const iso = date.toISOString();
  return iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/**
 * Enumerate the names currently resolvable under a surface root (the BEFORE
 * proof). While the root is the legacy whole-dir symlink, `readdir` lists the
 * canonical source's children THROUGH the symlink. NEVER throws. Excludes the
 * surface's own backup/staging artifacts and OS cruft.
 */
function enumerateResolvableThroughRoot(
  root: string,
  kind: SurfaceKind,
): ResolvableName[] {
  const out: ResolvableName[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of names) {
    if (skippedName(name)) continue;
    if (name.includes(".bak-") || name.includes(".migrate-")) continue;
    if (name.includes(".tmp-")) continue;
    const abs = join(root, name);
    if (kind === "skills") {
      // A skill resolves iff it (or its nested child) has a SKILL.md.
      const direct = join(abs, "SKILL.md");
      const nested = join(abs, name, "SKILL.md");
      if (
        (existsSync(direct) && safeIsFile(direct)) ||
        (existsSync(nested) && safeIsFile(nested))
      ) {
        out.push({ name, target: realpathSafe(abs) });
      }
    } else {
      // An agent resolves iff it is an `.md` file (real or symlinked) — the 7
      // core agents + 3 personal harness.claude.md symlinks. The aux
      // `manifest.yaml` is ALSO kept in the BEFORE set so the ⊇ invariant
      // covers the preserved auxiliary file. Other shapes (dirs like the
      // registry's `routing/`) are not surface items and are not counted.
      const keep =
        name.endsWith(".md") || enumerateAgentAuxNamesSet(root).has(name);
      if (keep) out.push({ name, target: realpathSafe(abs) });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Aux-file name set under `dir` (regular non-`.md` files that are not agents,
 * e.g. `manifest.yaml`). Computed against the dir actually being read (the
 * surface root, which while a whole-dir symlink exposes the source's aux
 * files through it). NEVER throws.
 */
function enumerateAgentAuxNamesSet(dir: string): Set<string> {
  return new Set(enumerateAgentAuxFiles(dir));
}

/** statSync-safe regular-file test. NEVER throws. */
function safeIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Migrate ONE surface root from the legacy whole-dir symlink into a REAL dir of
 * per-item symlinks (§3.3). Guarded, atomic, backup-not-delete, idempotent.
 * NEVER throws.
 *
 * Steps:
 * 1. Verdict gate (TOCTOU): re-classify the root live. Only `migrate` proceeds;
 *    `unexpected-symlink` refuses+reports; `real-dir`/`missing` is a no-op.
 * 2. Enumerate BEFORE (resolvable-through-symlink) + the materialization
 *    inventory (canonical source + overlay).
 * 3. realpath-contain the parent of the root (so a symlinked grandparent can't
 *    redirect the backup/staging writes outside the intended dir).
 * 4. Build a sibling staging REAL dir `R.migrate-<UTCstamp>/` of per-item
 *    symlinks; every per-item link path is contained within the staging dir.
 * 5. Backup the old root symlink: `rename R → R.bak-<UTCstamp>` (records the old
 *    target; never touches the canonical CONTENT).
 * 6. Atomic `rename` staging → R. On a race that leaves R present, abort +
 *    restore the backup.
 *
 * @param now Test seam for the backup/staging timestamp.
 */
export function migrateSurfaceRoot(
  surface: SurfaceRoot,
  overlayPath: string = registryOverlayPath(),
  now: Date = new Date(),
): MigrateResult {
  const { kind, root, source } = surface;
  const empty: ResolvableName[] = [];

  // 1. Verdict gate.
  const verdict = classifySurfaceRoot(root, source);
  if (verdict === "unexpected-symlink") {
    debug(
      `skills-pollution: refusing migrate of '${root}' — symlink target ` +
        `'${realpathSafe(root)}' is NOT the canonical source '${realpathSafe(source)}'.`,
    );
    return { outcome: "refused-unexpected-target", before: empty, after: empty };
  }
  if (verdict !== "migrate") {
    return {
      outcome: "skipped-not-migratable",
      before: empty,
      after: empty,
    };
  }

  // 2. Enumerate BEFORE + the materialization inventory.
  const before = enumerateResolvableThroughRoot(root, kind);
  const inventory = buildSurfaceInventory(surface, overlayPath);

  // 3. Containment: the staging dir + backup are siblings of the root under its
  // parent. A pre-existing staging/backup path that resolves OUTSIDE the parent
  // (e.g. a planted symlink) is refused before any write. The per-item link
  // containment (within the staging dir) is asserted again per-link in step 4.
  const parent = dirname(root);
  const parentReal = realpathSafe(parent);
  const stamp = utcStamp(now);
  const stagingDir = join(parent, `${basename(root)}.migrate-${stamp}`);
  const backupPath = join(parent, `${basename(root)}.bak-${stamp}`);
  for (const p of [stagingDir, backupPath]) {
    // realpathSafe returns the path verbatim when it does not yet exist (the
    // normal case); a PRE-EXISTING planted symlink resolves elsewhere and is
    // caught here.
    if (existsSync(p) && !isContained(realpathSafe(p), parentReal)) {
      debug(
        `skills-pollution: refusing migrate of '${root}' — '${p}' escapes parent.`,
      );
      return { outcome: "refused-containment", before, after: empty };
    }
  }

  // 4. Build the staging real dir of per-item symlinks. The staging dir is
  // freshly created (clean), so a plain symlinkSync per item is safe — there is
  // nothing to clobber. The atomicity guarantee comes from step 6: the WHOLE
  // populated staging dir is `rename(2)`'d into place after the old root symlink
  // is backed up, so there is no window where the live root is half-built.
  const after: ResolvableName[] = [];
  try {
    mkdirSync(stagingDir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug(`skills-pollution: cannot create staging dir '${stagingDir}': ${msg}`);
    return { outcome: "error", before, after: empty };
  }
  const stagingReal = realpathSafe(stagingDir);
  try {
    for (const item of inventory) {
      const linkPath = join(stagingDir, item.linkName);
      // #515: each per-item link path must be contained within the staging dir
      // (a `linkName` with path separators / `..` would escape).
      if (!isContained(realpathSafe(dirname(linkPath)), stagingReal)) {
        debug(
          `skills-pollution: refusing per-item link '${item.linkName}' — ` +
            `escapes staging dir.`,
        );
        cleanupStaging(stagingDir);
        return { outcome: "refused-containment", before, after: empty };
      }
      // Skip an item whose target does not exist (a stale overlay entry) — do
      // not materialize a dangling symlink; it would not count toward AFTER.
      if (!existsSync(item.target)) {
        debug(
          `skills-pollution: skipping inventory item '${item.linkName}' — ` +
            `target missing.`,
        );
        continue;
      }
      symlinkSync(item.target, linkPath);
      after.push({ name: item.linkName, target: realpathSafe(linkPath) });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug(`skills-pollution: staging population failed for '${root}': ${msg}`);
    cleanupStaging(stagingDir);
    return { outcome: "error", before, after: empty };
  }

  // 5. Backup the old root symlink (rename — never touches canonical content).
  try {
    renameSync(root, backupPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug(`skills-pollution: backup rename failed for '${root}': ${msg}`);
    cleanupStaging(stagingDir);
    return { outcome: "error", before, after: empty };
  }

  // 6. Atomic rename staging → R. On failure, restore the backup so the
  // operator is never left without the surface root.
  try {
    if (existsSync(root)) {
      // Race: something recreated R after the backup rename. Abort + restore.
      throw new Error(`'${root}' reappeared after backup`);
    }
    renameSync(stagingDir, root);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug(`skills-pollution: final rename failed for '${root}': ${msg}`);
    cleanupStaging(stagingDir);
    try {
      if (!existsSync(root)) renameSync(backupPath, root);
    } catch {
      // Could not restore — the old symlink is still safe under backupPath.
    }
    return { outcome: "error", before, after: empty };
  }

  return { outcome: "migrated", backupPath, before, after };
}

/** Best-effort removal of a staging dir + its per-item symlinks. NEVER throws. */
function cleanupStaging(stagingDir: string): void {
  try {
    if (!existsSync(stagingDir)) return;
    for (const name of readdirSync(stagingDir)) {
      try {
        unlinkSync(join(stagingDir, name));
      } catch {
        // best-effort
      }
    }
    rmdirSync(stagingDir);
  } catch {
    // best-effort — leave any residue rather than throw
  }
}

// ===========================================================================
// Stray source-symlink finder + cleaner (§3.4)
// ===========================================================================

/** A depth-1 symlink found inside the canonical source. */
export interface StraySymlink {
  /** Absolute path of the stray symlink (e.g. `~/.igris/core/skills/content-pipeline`). */
  path: string;
  /** The resolved realpath the stray points at. */
  resolved: string;
  /**
   * True iff the stray's realpath is contained in `~/.igris/registry/` — i.e. it
   * is a leaked PROJECTION (removable). False → report-only (could be a hand-
   * authored symlink; never auto-remove).
   */
  isRegistryProjection: boolean;
}

/**
 * Find every depth-1 SYMLINK inside a canonical source root (skills or agents).
 * NEVER throws. These are leaked projections from a compile that wrote through
 * the legacy whole-dir symlink. Each is classified as a registry-projection
 * (removable) vs unknown (report-only) by realpath-containment in the registry.
 */
export function findStraySourceSymlinks(coreSource: string): StraySymlink[] {
  const out: StraySymlink[] = [];
  let names: string[];
  try {
    if (!existsSync(coreSource)) return [];
    names = readdirSync(coreSource);
  } catch {
    return [];
  }
  const registryReal = realpathSafe(registryDirPath());
  for (const name of names) {
    if (skippedName(name)) continue;
    const p = join(coreSource, name);
    let isLink = false;
    try {
      isLink = lstatSync(p).isSymbolicLink();
    } catch {
      continue;
    }
    if (!isLink) continue;
    const resolved = realpathSafe(p);
    out.push({
      path: p,
      resolved,
      isRegistryProjection: isContained(resolved, registryReal),
    });
  }
  return out;
}

/** Outcome of a single {@link removeStraySourceSymlink} call. */
export type StrayRemoveOutcome =
  | "removed" // the stray projection symlink was unlinked
  | "skipped-not-projection" // not contained in the registry → report-only
  | "skipped-not-symlink" // no longer a symlink at fix time (TOCTOU)
  | "skipped-no-migrated-target" // the migrated per-item symlink does not exist yet
  | "error";

/**
 * Remove ONE stray projection symlink from the canonical source (§3.4).
 * Guarded — NEVER `rm`s a real dir or canonical content. NEVER throws.
 *
 * Preconditions (ALL must hold before unlink):
 * 1. The path is STILL a symlink (TOCTOU re-check).
 * 2. Its realpath is contained in `~/.igris/registry/` (a projection).
 * 3. The migrated per-item symlink exists in the real surface dir
 *    (`<surfaceRoot>/<name>`) — so the personal entry has a proper home before
 *    we remove the leaked copy.
 *
 * @param strayPath   the depth-1 symlink in the source (e.g. core/skills/<name>).
 * @param surfaceRoot the migrated REAL surface dir (e.g. ~/.claude/skills).
 */
export function removeStraySourceSymlink(
  strayPath: string,
  surfaceRoot: string,
): StrayRemoveOutcome {
  // 1. TOCTOU re-check: still a symlink?
  let isLink = false;
  try {
    isLink = lstatSync(strayPath).isSymbolicLink();
  } catch {
    return "skipped-not-symlink";
  }
  if (!isLink) return "skipped-not-symlink";

  // 2. Registry-projection containment.
  const registryReal = realpathSafe(registryDirPath());
  if (!isContained(realpathSafe(strayPath), registryReal)) {
    debug(
      `skills-pollution: leaving stray '${strayPath}' — its target is not a ` +
        `registry projection (report-only; never auto-removed).`,
    );
    return "skipped-not-projection";
  }

  // 3. The migrated per-item symlink must exist in the real surface dir.
  const name = basename(strayPath);
  const migrated = join(surfaceRoot, name);
  let migratedIsSymlink = false;
  try {
    migratedIsSymlink = lstatSync(migrated).isSymbolicLink();
  } catch {
    migratedIsSymlink = false;
  }
  if (!migratedIsSymlink) {
    debug(
      `skills-pollution: leaving stray '${strayPath}' — its migrated home ` +
        `'${migrated}' does not exist yet.`,
    );
    return "skipped-no-migrated-target";
  }

  // All preconditions hold — unlink ONLY the symlink (never the content).
  try {
    unlinkSync(strayPath);
    return "removed";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug(`skills-pollution: failed to unlink stray '${strayPath}': ${msg}`);
    return "error";
  }
}

// ===========================================================================
// Aggregate report — drives the doctor row + read-pass WARN
// ===========================================================================

/** One classified surface root in the aggregate report. */
export interface SurfaceRootReport {
  kind: SurfaceKind;
  root: string;
  source: string;
  verdict: SurfaceRootVerdict;
}

/** Aggregate migration report across both surfaces + the source strays. */
export interface MigrationReport {
  /** Per-surface root classification. */
  surfaces: SurfaceRootReport[];
  /** Roots in the migration condition (the legacy whole-dir symlink). */
  toMigrate: SurfaceRootReport[];
  /** Roots that are symlinks to an UNEXPECTED (non-canonical) target. */
  unexpected: SurfaceRootReport[];
  /** Stray projection symlinks found in the canonical source(s). */
  strays: StraySymlink[];
}

/**
 * Build the aggregate migration report across both surface roots + the strays
 * leaked into each canonical source. NEVER throws. win32 → empty report.
 *
 * @param platform     Test seam — defaults to `process.platform`.
 * @param manifestPath Test seam — defaults to {@link surfacesManifestPath}.
 */
export function classifyMigration(
  platform: NodeJS.Platform = process.platform,
  manifestPath: string = surfacesManifestPath(),
): MigrationReport {
  const surfaces: SurfaceRootReport[] = [];
  const toMigrate: SurfaceRootReport[] = [];
  const unexpected: SurfaceRootReport[] = [];
  let strays: StraySymlink[] = [];

  if (!pollutionCheckSupported(platform)) {
    return { surfaces, toMigrate, unexpected, strays };
  }

  const roots = declaredSurfaceRoots(manifestPath);
  const sourcesSeen = new Set<string>();
  for (const sr of roots) {
    const verdict = classifySurfaceRoot(sr.root, sr.source);
    const report: SurfaceRootReport = {
      kind: sr.kind,
      root: sr.root,
      source: sr.source,
      verdict,
    };
    surfaces.push(report);
    if (verdict === "migrate") toMigrate.push(report);
    if (verdict === "unexpected-symlink") unexpected.push(report);
    // Collect strays from each distinct canonical source.
    const srcReal = realpathSafe(sr.source);
    if (!sourcesSeen.has(srcReal)) {
      sourcesSeen.add(srcReal);
      strays = strays.concat(findStraySourceSymlinks(sr.source));
    }
  }

  return { surfaces, toMigrate, unexpected, strays };
}

/**
 * True when `child` is `parent` or strictly contained beneath it (both already
 * realpath'd). Uses `path.relative` so a sibling like `/a/skills-evil` is NOT
 * mistaken for being inside `/a/skills` (a naive `startsWith` would). NEVER
 * throws.
 */
function isContained(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  // Inside iff rel does not climb out (`..`) and is not absolute (different
  // root / drive).
  return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(sep);
}
