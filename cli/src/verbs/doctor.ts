/**
 * `igris doctor [--fix] [--remove-orphans] [--yes]` — Phase 1+M5.
 *
 * Read-only by default: walks the registry and classifies every row into a
 * `DriftRow` (see types.ts). Drift classes:
 *
 * Brain-level (synthetic slug "(brain)"):
 *   brain-core-missing      → ~/.igris/core/ absent or empty
 *   brain-core-stale        → a MUTABLE channel (main/branch) has moved past the
 *                             recorded ref_commit_sha; release/tag are exempt (TD-301)
 *   bridge-missing          → CLI on PATH lacks configured bridge
 *   mcp-unregistered        → ~/.claude.json lacks the igris-brain MCP entry
 *                             (or it points at a missing file) — TD-168
 *   secret-perms            → an Igris-written secret file (config.json,
 *                             secrets.env) OR a harness config is group/world-
 *                             readable or git-tracked — TD-220
 *   skills-pollution        → a managed surface root (~/.claude/skills or
 *                             ~/.claude/agents) is a legacy v6-era WHOLE-DIR
 *                             symlink pointing AT the canonical source
 *                             (~/.igris/core/{skills,agents}), OR a stray
 *                             projection symlink leaked INTO that canonical
 *                             source. The whole-dir symlink makes a live
 *                             `igris harness compile --surface skills` write
 *                             per-item symlinks INTO the canonical source
 *                             (active damage). --fix migrates each root to a
 *                             REAL dir of per-item symlinks (direct-materialize,
 *                             never compile) and cleans the strays — TD-223
 *                             (RE-SCOPED, corrected root cause).
 *
 * Brain-level (continued):
 *   hooks-missing           → the GLOBAL ~/.claude/settings.json lacks the Igris
 *                             SessionEnd hook (or is absent/malformed). FR-212d
 *                             moved hooks global — there is no per-project hooks
 *                             layer anymore, so this is a single (brain) row.
 *   hooks-stale             → the global settings carry the Igris SessionEnd hook
 *                             but at a non-canonical command path.
 *   attribution-missing     → (TD-473) the global settings are PRESENT and
 *                             parseable but carry NEITHER `attribution` NOR the
 *                             deprecated `includeCoAuthoredBy` — the TD-470
 *                             default was never applied on this machine (e.g. it
 *                             ran `init` before TD-470 shipped and never ran
 *                             `update` after). An absent/malformed settings file
 *                             defers entirely to hooks-missing above — no
 *                             duplicate row. --fix reuses the SAME
 *                             `mergeGlobalCanonicalHooks` writer as hooks-missing/
 *                             stale (it already composes `applyAttributionDefault`)
 *                             and prints the same one-line disclosure `init`/
 *                             `update` print, only when the outcome is `added`.
 *   machine-identity        → (informational, BR-100) hostname outside the minted
 *                             identity's aliases, or NULL-id rows under names the
 *                             aliases do not cover; never --fix'able (an alias is
 *                             an operator claim); lowest brain-level precedence.
 *   secret-scan-disarmed    → (informational, FR-243) ≥1 registered project has
 *                             the Igris pre-commit installed AND `gitleaks` is
 *                             not on PATH — every one of those hooks is running
 *                             with `secret-scan=DISARMED`. Detection is PATH
 *                             presence (no spawn). Never --fix'able (a binary
 *                             install is the operator's); beside machine-identity.
 *
 * Per-project:
 *   source-reclaimed        → (FR-265) path missing AND a `repo_url` recorded:
 *                             removed on purpose. EXIT-NEUTRAL (`isNotDrift`),
 *                             printed with a restore line, never deleted.
 *   git-hooks-missing       → (FR-243) `.git` is a directory and pre-commit or
 *                             commit-msg in `.git/hooks/` is absent, a non-symlink
 *                             (foreign), a symlink to somewhere other than the
 *                             canonical source (the runtime mirror
 *                             `~/.igris/core/git-hooks/<name>`, or the repo copy
 *                             when the row IS the igris-ai checkout), dangling,
 *                             or resolves to a NON-EXECUTABLE file (git then
 *                             ignores it with a `hint:` and commits anyway) —
 *                             OR `.git/config` sets `core.hooksPath`, which
 *                             bypasses `.git/hooks/` entirely. The reason text
 *                             names the cause. --fix = installGitHooks()
 *                             (backup-not-clobber; chmod +x only under
 *                             brainDir()) — except the hooksPath case, which is
 *                             reported, never fixed. A `.git` FILE (worktree /
 *                             submodule) yields no row.
 *   path-missing            → orphan (deleted dir, no `repo_url`); shown with
 *                             what it owns and a re-point offer (TD-310)
 *   channel-mismatch        → installed_features.json#cli_version newer than current CLI
 *   slug-basename-mismatch  → row.slug !== basename(row.path)  (informational)
 *   duplicate-path          → multiple slugs with the same realpath (the
 *                             fifty_eco_system triple-slug case was the live
 *                             example until TD-402 folded it on 2026-08-17; the
 *                             class is still live — this detector reads STATE,
 *                             so it reports a duplicate whoever minted it, and
 *                             other writers that can set projects.path
 *                             still do not refuse one. The boot-sync pull merge
 *                             refuses on INSERT since TD-404, but its lww UPDATE
 *                             branch still can, so this class is NOT one-shot
 *                             even after a fold)
 *   symlink-target          → row.path is itself a symlink
 *   clean                   → registered + path exists (the register-only happy path)
 *
 * FR-212d Phase 2: the `not-installed` class (path exists but `.claude/` missing)
 * was RETIRED — `igris install` is register-only and no longer writes a
 * per-project `.claude/` layer, so its absence no longer signals "not installed".
 * A registered project whose path exists is clean.
 *
 * Precedence (high → low): path-missing / source-reclaimed → brain-core-missing →
 * brain-core-stale → channel-mismatch → bridge-missing → mcp-unregistered → hooks-missing →
 * hooks-stale → attribution-missing → secret-perms → skills-pollution →
 * machine-identity → secret-scan-disarmed → duplicate-path → git-hooks-missing →
 * symlink-target → slug-basename-mismatch → clean.
 * (mcp-unregistered + hooks-missing/hooks-stale + attribution-missing +
 *  secret-perms + skills-pollution sit next to bridge-missing — all
 *  brain-level, config/state-driven, and orthogonal to core state.
 *  skills-pollution is lowest brain-level precedence — TD-223.)
 *
 * --fix (BR-103, 2026-09-07) runs every arm in DEPENDENCY order, each in its
 * own try/catch, and prints a per-fix outcome table (`| class | target |
 * action | outcome | now |`, where `now` is a LIVE re-probe):
 *   G1 brain-core-missing — the ONLY wholesale action: `runRefresh()` from
 *      the RECORDED source, guarded by a live `detectBrainCoreMissing()`
 *      re-probe immediately before the call (an absent core is the one case
 *      where replacing core/ cannot poison anything); first because the
 *      per-project git hooks need `~/.igris/core/git-hooks/`.
 *   G2 git-hooks-missing (per project, FR-243) — `installGitHooks(row.path)`;
 *      a refused install (core.hooksPath, worktree, missing mirror) keeps
 *      the row non-clean.
 *   G3 brain-level, config-scoped — hooks-missing/stale/attribution-missing via
 *      `mergeGlobalCanonicalHooks` (one global action; TD-473: attribution-missing
 *      rides the SAME writer, never a second attempt); mcp-unregistered via
 *      `registerBrainAcrossHarnesses()` in-process (FR-169); antigravity-
 *      skills-link; skills-pollution (TD-223 RE-SCOPED: migrate each legacy
 *      whole-dir root into a REAL dir of per-item symlinks, clean strays,
 *      backup-not-delete, print the before/after enumeration); and
 *      bridge-missing — `recordCliTarget(<id>)` into config.json plus ONE
 *      MCP backfill. NEVER `init --upgrade`, NEVER a core/ replace: the old
 *      arm resolved the DEFAULT channel and swapped a release tarball over a
 *      newer from-source core, and it never wrote `cli_targets` anyway.
 *   G4 secret-perms — chmod 600 LAST (TD-220), after every rewrite above.
 * `--fix` never replaces `~/.igris/core/` except through G1's guarded path.
 * The exit code re-probes every fixed class (no blind discount): a row that
 * is still drifted after its fix keeps the verb at exit 1.
 * --remove-orphans deletes path-missing rows (never source-reclaimed ones),
 * showing what each owns first; modes (`--empty-only`, `--yes`
 * [`--include-owning`], `--slug`) are policy in front of ONE delete — see
 * `confirmAndRemoveOrphans`. A row the DB still references (briefs/sessions FK)
 * is SKIPPED and reported (BR-084). The exit code comes from a RE-READ of the
 * registry, never the sweep's report (BR-087): any row still path-missing
 * afterwards keeps exit 1 — dispositions at the exit predicate.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  listProjects,
  deleteProjectRow,
  danglingKnowledge,
  ownsData,
  projectOwnership,
  type DeleteProjectOutcome,
} from "../lib/registry.js";
import {
  claudeJsonPath,
  claudeUserSettingsPath,
  codexConfigTomlPath,
  configJsonPath,
  geminiSettingsPath,
  opencodeConfigPath,
  loadoutOverlayPath,
  secretsEnvPath,
} from "../lib/paths.js";
import { extractVarName, parseSecretsEnv } from "../lib/secrets.js";
import {
  checkSecretFilePerms,
  chmodSecretFile,
} from "../lib/secret-perms.js";
import {
  classifyMigration,
  migrateSurfaceRoot,
  removeStraySourceSymlink,
  coreSkillsSource,
  coreAgentsSource,
} from "../lib/skills-pollution.js";
import {
  inspectMcpRegistration,
  registerBrainAcrossHarnesses,
} from "../lib/mcp-register.js";
import { mergeGlobalCanonicalHooks } from "../lib/global-hooks.js";
import { applyAttributionDefault, attributionAddedNote } from "../lib/attribution-settings.js";
import { runRefresh } from "./refresh.js";
import { detectBrainCoreMissing } from "../lib/drift/brain-core-missing.js";
import { detectBrainCoreStale } from "../lib/drift/brain-core-stale.js";
import { detectChannelMismatch } from "../lib/drift/channel-mismatch.js";
import { detectBridgeMissing } from "../lib/drift/bridge-missing.js";
import { detectAntigravitySkillsLink } from "../lib/drift/antigravity-skills-link.js";
import { linkAntigravitySkills } from "../lib/antigravity-skills.js";
import { readMachineIdentity } from "../lib/machine-identity.js";
import { readConfig, recordCliTarget } from "../lib/init-config.js";
import { knownCLITargets } from "../lib/cli-detect.js";
import { readUnattributedHostnames } from "../lib/brain-db.js";
import {
  gitleaksOnPath,
  inspectGitHooks,
  installGitHooks,
} from "../lib/git-hooks.js";
import { info, warn, error as logError } from "../lib/log.js";
import type { CLITarget, DriftRow, ProjectOwnership, RegistryRow } from "../types.js";

export interface DoctorOptions {
  fix: boolean;
  removeOrphans: boolean;
  yes: boolean;
  /** TD-310 `--empty-only`: non-interactive; remove only the orphans that own nothing. */
  emptyOnly?: boolean;
  /** TD-310 `--slug <slug>`: restrict `--remove-orphans` to one row. */
  slug?: string;
  /** TD-310 `--include-owning`: with `--yes` ONLY — let `--yes` attempt a data-owning row. */
  includeOwning?: boolean;
}

/** TD-310: the usage error for an invalid flag combination, or null (checked before any read). */
export function orphanFlagError(opts: DoctorOptions): string | null {
  const emptyOnly = opts.emptyOnly === true;
  const includeOwning = opts.includeOwning === true;
  const hasSlug = opts.slug !== undefined;
  if (!opts.removeOrphans && (emptyOnly || hasSlug || includeOwning)) {
    return "--empty-only, --slug and --include-owning select rows for --remove-orphans; pass --remove-orphans as well.";
  }
  if (hasSlug && (opts.slug ?? "").trim() === "") {
    return "--slug needs a registry slug.";
  }
  if (emptyOnly && includeOwning) {
    return "--empty-only removes only rows that own nothing; it cannot be combined with --include-owning.";
  }
  if (includeOwning && !opts.yes) {
    return "--include-owning only widens --yes; the interactive prompt already asks per row with the counts shown.";
  }
  return null;
}

/**
 * FR-265: clean, or the one non-clean class that is not drift (`source-reclaimed`,
 * recorded data). One predicate for the exit code, the header and the re-read.
 */
export function isNotDrift(cls: DriftRow["driftClass"]): boolean {
  return cls === "clean" || cls === "source-reclaimed";
}

/** TD-310: "briefs N, learnings M" (+ errors/sessions when non-zero). */
export function formatOwnership(o: ProjectOwnership): string {
  const n = (v: number | null): string => (v === null ? "unknown" : String(v));
  const parts = [`briefs ${n(o.briefs)}`, `learnings ${n(o.learnings)}`];
  if (o.errors !== 0) parts.push(`errors ${n(o.errors)}`);
  if (o.sessions !== 0) parts.push(`sessions ${n(o.sessions)}`);
  return parts.join(", ");
}

/** FR-265: a paste-safe restore line — single-quoted args; `--` so a value starting with `-` is never a git option. */
export function restoreCommand(url: string, path: string): string {
  const q = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
  return `git clone -- ${q(url)} ${q(path)}`;
}

export async function runDoctor(opts: DoctorOptions): Promise<number> {
  const usage = orphanFlagError(opts);
  if (usage !== null) {
    logError(`usage: ${usage}`);
    return 1;
  }

  const rows = listProjects();
  const drift = await classifyDriftAll(rows);

  annotateOrphans(drift); // TD-310: counts known before anything is printed

  printDriftTable(drift);
  printOrphanDetails(drift);
  printSourceReclaimed(drift);

  // FR-165: read-only WARNING for MCP env refs whose VAR is resolvable nowhere
  // (neither secrets.env nor process.env). Not a fixable drift-row — the fix is
  // "add it to secrets.env", which doctor cannot do safely. Never echoes a value.
  detectMissingSecrets();

  // TD-220: in the read pass (no --fix), the harness-owned secret configs get a
  // WARN — Igris does NOT auto-tighten them ("don't fight the
  // harness"). The drift table already shows the row; this names it as
  // harness-owned and offers --fix. (Igris-owned config.json/secrets.env are
  // fixed proactively at init + under --fix, so they don't get this warn.)
  if (!opts.fix) {
    for (const row of drift) {
      if (
        row.driftClass === "secret-perms" &&
        !isIgrisOwnedSecretFile(row.path)
      ) {
        warn(
          `harness config '${row.path}' has loose/world-readable or ` +
            `git-tracked perms — run 'igris doctor --fix' to chmod 600 ` +
            `(metadata only; file contents are untouched).`,
        );
      }
    }
    // TD-223: in the read pass, name each polluted skills entry by skill name
    // (NO body bytes — L-515 read-only posture). Divergent entries get an
    // explicit manual-resolution warning since --fix will NEVER touch them.
    if (drift.some((r) => r.driftClass === "skills-pollution")) {
      warnSkillsPollutionEntries();
    }
  }

  // BR-103: every fix arm runs inside runFixes() — dependency-ordered,
  // isolated, tabulated. `errored` counts failed + refused outcomes.
  let errored = 0;
  if (opts.fix) {
    const outcomes = await runFixes(drift);
    errored = outcomes.filter(
      (o) => o.outcome === "failed" || o.outcome === "refused",
    ).length;
    printFixSummary(outcomes);
  }

  let stillDrifted: Set<string> | null = null;
  let targetRefused = false;
  if (opts.removeOrphans) {
    targetRefused = (await sweepOrphans(drift, rows, opts)).targetRefused;
    // BR-087: re-read, never trust the sweep's report (--fix's "re-check rather
    // than assume"). A removed row is absent, hence resolved.
    stillDrifted = new Set(
      classifyDrift(listProjects())
        .filter((r) => !isNotDrift(r.driftClass))
        .map((r) => r.slug),
    );
  }

  // Exit code: 1 if any drift remains, on fix errors, or on a refused --slug.
  const nonCleanRemaining = drift.some((r) => {
    if (isNotDrift(r.driftClass)) return false;
    // BR-087 DISPOSITIONS. A pre-sweep path-missing row is non-clean iff the
    // RE-READ still finds it drifted — the sweep's report is never consulted.
    //  - removed → absent → resolved.
    //  - DB-refused (BR-084), or refused by policy (TD-310: --yes / --empty-only
    //    on a data-owning row) → still there → UNRESOLVED, exit 1.
    //  - declined (`n`) → UNRESOLVED, exit 1: a prompt answer leaves no trace in
    //    the registry, so "clean by consent" would make exit 0 mean "the
    //    operator said so", not "the registry is clean". Keeping a row without
    //    its directory is stated as DATA: a `repo_url` or a re-pointed path (D2).
    //  - aborted (`a`) or input ended (EOF) → UNADJUDICATED, exit 1: nobody
    //    claimed the rest were clean.
    // NO CASE IS CLEAN-BY-CONSENT; the only exit-neutral non-clean state is
    // `source-reclaimed`, which is data, not an answer.
    if (stillDrifted !== null && r.driftClass === "path-missing") {
      return stillDrifted.has(r.slug);
    }
    if (opts.fix) {
      // BR-103: after --fix every auto-fixable class is RE-PROBED live — the
      // same predicate the outcome table's `now` column prints. The old blind
      // discount of brain-core-missing / bridge-missing / mcp-unregistered
      // (O-1, BR-087's class) is gone: a bridge row that did not clear stayed
      // invisible for as long as that discount existed (Finding 2).
      const still = reprobe(r);
      if (still !== null) return still;
    }
    return true;
  });

  if (errored > 0) return 1;
  if (targetRefused) return 1;
  return nonCleanRemaining ? 1 : 0;
}

// --- TD-310 / FR-265: the orphan report (every run) and the --remove-orphans pass

/** TD-310: attach each orphan's ownership; lead its recommended fix with the counts. */
function annotateOrphans(drift: DriftRow[]): void {
  for (const r of drift) {
    if (r.driftClass !== "path-missing") continue;
    r.ownership = projectOwnership(r.slug);
    r.recommendedFix = ownsData(r.ownership)
      ? `${formatOwnership(r.ownership)} — moved? re-point (see below)`
      : "owns nothing — igris doctor --remove-orphans --empty-only";
  }
}

/** Below the table, before any prompt: full counts and the remedies, re-point first (TD-310 AC4). */
function printOrphanDetails(drift: DriftRow[]): void {
  const orphans = drift.filter((r) => r.driftClass === "path-missing");
  if (orphans.length === 0) return;
  info("");
  info("Orphans (path-missing) — what each row owns, and how to resolve it:");
  for (const o of orphans) {
    const owning = o.ownership === undefined || ownsData(o.ownership);
    const owned = o.ownership === undefined ? "ownership unknown" : formatOwnership(o.ownership);
    info(`- ${o.slug} (${o.path}): ${owned}`);
    info(`    moved → igris register-project <new-path> --slug ${o.slug}`);
    info("    source removed on purpose → record its repo URL (igris_project_update repo_url) → source-reclaimed");
    info(`    neither → igris doctor --remove-orphans${owning ? "" : " --empty-only"}`);
  }
}

/** FR-265 AC6: one `restore <slug>: git clone …` line per source-reclaimed row, every run. */
function printSourceReclaimed(drift: DriftRow[]): void {
  const reclaimed = drift.filter((r) => r.driftClass === "source-reclaimed");
  if (reclaimed.length === 0) return;
  info("");
  info("Source reclaimed (not drift) — removed on purpose; restore with:");
  for (const r of reclaimed) {
    info(`restore ${r.slug}: ${restoreCommand(r.repoUrl ?? "", r.path)}`);
  }
}

/** Scope the candidates (`--slug`, never source-reclaimed), run the ONE sweep, report. */
async function sweepOrphans(
  drift: DriftRow[],
  rows: RegistryRow[],
  opts: DoctorOptions,
): Promise<{ targetRefused: boolean }> {
  let orphans = drift.filter((r) => r.driftClass === "path-missing");

  if (opts.slug !== undefined) {
    const slug = opts.slug;
    if (!rows.some((r) => r.slug === slug)) {
      logError(`--slug ${slug}: no registry row has that slug.`);
      return { targetRefused: true };
    }
    const mine = drift.filter((r) => r.slug === slug);
    const reclaimed = mine.find((r) => r.driftClass === "source-reclaimed");
    if (reclaimed !== undefined) {
      logError(
        `refused: ${slug} is source-reclaimed — not an orphan, never removed; ` +
          `restore with: ${restoreCommand(reclaimed.repoUrl ?? "", reclaimed.path)}`,
      );
      return { targetRefused: true };
    }
    const orphan = mine.find((r) => r.driftClass === "path-missing");
    if (orphan === undefined) {
      const classes = mine.map((r) => r.driftClass).join(", ") || "clean";
      logError(`refused: ${slug} is not an orphan (${classes}) — --remove-orphans only removes path-missing rows.`);
      return { targetRefused: true };
    }
    orphans = [orphan];
  } else {
    for (const r of drift) {
      if (r.driftClass === "source-reclaimed") info(`not offered: ${r.slug} (source-reclaimed)`);
    }
  }

  if (orphans.length === 0) {
    info("No orphans to remove.");
  } else {
    const sweep = await confirmAndRemoveOrphans(orphans, opts.yes, undefined, {
      emptyOnly: opts.emptyOnly === true,
      includeOwning: opts.includeOwning === true,
    });
    reportSweep(sweep);
  }
  reportDanglingKnowledge();
  return { targetRefused: false };
}

/** One summary line per sweep outcome. */
function reportSweep(sweep: OrphanSweepResult): void {
  info(`Removed ${sweep.removed} orphan registry row(s).`);
  if (sweep.skipped > 0) {
    const skipped = sweep.results.filter((r) => !r.ok).map((r) => r.slug);
    // Named here: the per-row reasons went to stderr, this line goes to stdout.
    info(
      `Skipped ${sweep.skipped} orphan registry row(s) still referenced by ` +
        `brain rows: ${skipped.join(", ")}. The sweep completed ` +
        `for the rest; each skip's blocking count is in the warnings.`,
    );
  }
  if (sweep.refused.length > 0) {
    info(
      `Kept ${sweep.refused.length} data-owning orphan row(s), not attempted: ` +
        `${sweep.refused.map((r) => r.slug).join(", ")}. Re-point a moved project ` +
        `(igris register-project <new-path> --slug <slug>); to remove one anyway, ` +
        `answer 'y' at its prompt or pass --yes --include-owning.`,
    );
  }
  if (sweep.declined.length > 0) {
    info(
      `Kept ${sweep.declined.length} declined orphan row(s): ${sweep.declined.join(", ")} — ` +
        `still drift until re-pointed, given a repo_url, or removed.`,
    );
  }
  if (sweep.unadjudicated.length > 0) {
    info(
      `Not adjudicated: ${sweep.unadjudicated.length} orphan row(s): ` +
        `${sweep.unadjudicated.join(", ")} — the sweep ended (abort, or end of input) ` +
        `before they were answered.`,
    );
  }
}

/** TD-310 item 5: knowledge whose project row is gone — report only, never deletes. */
function reportDanglingKnowledge(): void {
  let dangling: ReturnType<typeof danglingKnowledge>;
  try {
    dangling = danglingKnowledge();
  } catch (err) {
    warn(`dangling-knowledge report unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (dangling.length === 0) return;
  for (const d of dangling) {
    info(`dangling knowledge (no registry row): ${d.project} — briefs ${d.briefs}, learnings ${d.learnings}`);
  }
  info(
    "  (report only — nothing was deleted; registering the slug again " +
      "(igris register-project <path> --slug <slug>) makes it reachable.)",
  );
}

// ---------------------------------------------------------------------------
// BR-103: the --fix engine — ordered, isolated, tabulated, re-probed.
// ---------------------------------------------------------------------------

type FixOutcomeKind = "applied" | "refused" | "failed" | "skipped";

interface FixOutcome {
  row: DriftRow;
  /** what the row names: a slug, a harness id, a path, or "(brain)" */
  target: string;
  action: string;
  outcome: FixOutcomeKind;
  detail: string;
}

/**
 * Run every `--fix` arm in dependency order (G1 → G4, see the header), each
 * inside its own try/catch: an exception becomes a `failed` outcome and the
 * loop continues, so one brain-level failure cannot poison the per-project
 * fixes after it. Returns one outcome per fix attempted; classes that are
 * never auto-fixed are WARNed as before and do not appear in the table.
 */
async function runFixes(drift: DriftRow[]): Promise<FixOutcome[]> {
  const out: FixOutcome[] = [];
  type Result = { outcome: FixOutcomeKind; detail: string };
  const byClass = (c: DriftRow["driftClass"]): DriftRow[] =>
    drift.filter((r) => r.driftClass === c);
  const attempt = async (
    row: DriftRow,
    target: string,
    action: string,
    fn: () => Promise<Result> | Result,
  ): Promise<void> => {
    try {
      const r = await fn();
      out.push({ row, target, action, outcome: r.outcome, detail: r.detail });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`${row.driftClass} fix (${target}): ${msg}`);
      out.push({ row, target, action, outcome: "failed", detail: msg });
    }
  };

  // --- G1: brain-core-missing — the only wholesale action, guarded --------
  for (const row of byClass("brain-core-missing")) {
    await attempt(row, "(brain)", "igris refresh from the recorded source", async () => {
      if (detectBrainCoreMissing() === null) {
        return { outcome: "skipped", detail: "core/ present at the re-probe; nothing to replace" };
      }
      info("fix: brain-core-missing — invoking 'igris refresh' (the recorded source; a channel switch needs --yes)");
      const code = await runRefresh({});
      if (code !== 0) {
        logError(`brain-core-missing fix: refresh returned exit ${code}`);
        return { outcome: "failed", detail: `refresh exit ${code}` };
      }
      return { outcome: "applied", detail: "refresh exit 0" };
    });
  }

  // --- G2: per-project git-hooks-missing (FR-243) --------------------------
  for (const row of byClass("git-hooks-missing")) {
    await attempt(row, row.slug, `installGitHooks ${row.path}/.git/hooks/`, () => {
      info(`fix: git-hooks-missing for ${row.slug} — installing the Igris git hooks into ${row.path}/.git/hooks/`);
      const gh = installGitHooks(row.path);
      if (gh.outcome === "refused") {
        logError(`git-hooks-missing fix (${row.slug}): ${gh.reason}`);
        return { outcome: "refused", detail: gh.reason };
      }
      const bad: string[] = [];
      const good: string[] = [];
      for (const h of gh.hooks) {
        if (h.outcome === "refused" || h.outcome === "failed") {
          logError(`git-hooks-missing fix (${row.slug}) ${h.name}: ${h.reason ?? h.outcome}`);
          bad.push(`${h.name}: ${h.reason ?? h.outcome}`);
        } else {
          info(`  ${h.name}: ${h.outcome} -> ${h.source}${h.backup !== undefined ? ` (previous hook preserved at ${h.backup})` : ""}`);
          good.push(`${h.name}: ${h.outcome}`);
        }
      }
      if (bad.length > 0) return { outcome: "refused", detail: bad.join("; ") };
      return { outcome: "applied", detail: good.join("; ") };
    });
  }

  // --- G3: brain-level, config-scoped --------------------------------------
  // FR-212d: hooks are global now (ONE block) — a single brain-level action.
  // TD-473: attribution-missing rides the SAME writer (`mergeGlobalCanonicalHooks`
  // composes `applyAttributionDefault` after the hooks merge), so it joins this
  // one action rather than getting a second `attempt()` — running the writer
  // twice would double-write the same file.
  const globalHooksRows = [...byClass("hooks-missing"), ...byClass("hooks-stale"), ...byClass("attribution-missing")];
  if (globalHooksRows.length > 0) {
    await attempt(globalHooksRows[0], "(brain)", "mergeGlobalCanonicalHooks ~/.claude/settings.json", () => {
      info("fix: hooks-missing/stale — refreshing the GLOBAL Igris hooks (~/.claude/settings.json)");
      const gh = mergeGlobalCanonicalHooks();
      if (gh.outcome === "failed") {
        logError(`global hooks refresh failed: ${gh.error}`);
        return { outcome: "failed", detail: String(gh.error) };
      }
      info(`  global Igris hooks ${gh.outcome} -> ${gh.path}`);
      // TD-473: the same one-line disclosure `init`/`update` print, printed ONLY
      // when the writer actually added the default — silent on `present`/`kept-user`.
      if (gh.attribution === "added") info(attributionAddedNote(gh.path));
      return { outcome: "applied", detail: `${gh.outcome} -> ${gh.path}` };
    });
  }

  // FR-169 / FR-212d: the brain MCP backfill is ONE in-process action for all
  // harnesses (custom merger, no `add-mcp` subprocess). It runs at most once
  // per pass — the mcp-unregistered arm and the bridge-missing arm share it.
  let mcpBackfilled = false;
  const backfillMcp = (): {
    failed: number;
    results: ReturnType<typeof registerBrainAcrossHarnesses>;
  } => {
    const results = registerBrainAcrossHarnesses(undefined, { engine: "custom" });
    let failed = 0;
    for (const { harness, result } of results) {
      if (result.outcome === "failed") {
        failed++;
        logError(`igris-brain MCP backfill (${harness}): ${result.error}`);
      } else {
        info(`  igris-brain MCP ${result.outcome} for ${harness} -> ${result.mcpEntryPath}`);
      }
    }
    mcpBackfilled = true;
    return { failed, results };
  };
  for (const row of byClass("mcp-unregistered")) {
    await attempt(row, "(brain)", "registerBrainAcrossHarnesses (in-process)", () => {
      info("fix: mcp-unregistered — registering igris-brain MCP across all Igris harnesses");
      const { failed, results } = backfillMcp();
      if (failed > 0) return { outcome: "failed", detail: `${failed} of ${results.length} harness(es) failed` };
      return { outcome: "applied", detail: `${results.length} harness(es)` };
    });
  }

  // FR-179 Phase C (R2): create-or-repoint the antigravity skills parent
  // symlink. A refused (real non-empty dir) outcome stays for manual resolution.
  for (const row of byClass("antigravity-skills-link")) {
    await attempt(row, "(brain)", "linkAntigravitySkills ~/.gemini/antigravity-cli/skills", () => {
      info("fix: antigravity-skills-link — linking ~/.gemini/antigravity-cli/skills -> ~/.agents/skills");
      const link = linkAntigravitySkills();
      if (link.outcome === "refused" || link.outcome === "failed") {
        logError(`antigravity-skills-link fix: ${link.error}`);
        return { outcome: link.outcome, detail: String(link.error) };
      }
      info(`  antigravity skills link ${link.outcome} -> ${link.target}`);
      return { outcome: "applied", detail: `${link.outcome} -> ${link.target}` };
    });
  }

  // TD-223 (RE-SCOPED): ONE skills-pollution row; the migrator prints the
  // before/after enumeration as the no-loss proof and returns its error count.
  const pollution = byClass("skills-pollution");
  if (pollution.length > 0) {
    await attempt(pollution[0], "(brain)", "migrate surface roots + clean stray projections", () => {
      const errs = fixSkillsPollution();
      return errs > 0
        ? { outcome: "failed", detail: `${errs} error(s); see the warnings above` }
        : { outcome: "applied", detail: "migrated" };
    });
  }

  // bridge-missing: the row names ONE harness that is installed but absent
  // from config.json#cli_targets. The repair is that record — the only
  // config write doctor performs — plus the MCP backfill above (once).
  for (const row of byClass("bridge-missing")) {
    const target = row.path;
    await attempt(row, target, `recordCliTarget ${target} + igris-brain MCP backfill`, () => {
      const known = knownCLITargets() as readonly string[];
      if (!known.includes(target)) {
        return { outcome: "refused", detail: `unknown target '${target}' (known: ${known.join(", ")})` };
      }
      info(`fix: bridge-missing for ${target} — recording cli_targets.${target} in config.json (never init, never a core/ replace)`);
      const rec = recordCliTarget(target as CLITarget);
      if (rec !== "written") {
        logError(`bridge-missing fix (${target}): config.json ${rec}`);
        return { outcome: "failed", detail: `config.json ${rec}` };
      }
      let detail = `cli_targets.${target} recorded`;
      if (!mcpBackfilled) {
        const { failed, results } = backfillMcp();
        const mine = results.find((r) => String(r.harness) === target);
        detail += `; MCP ${mine !== undefined ? mine.result.outcome : "n/a"} for ${target}`;
        if (mine !== undefined && mine.result.outcome === "failed") {
          return { outcome: "failed", detail };
        }
        if (failed > 0) detail += `; ${failed} other harness(es) failed`;
      } else {
        detail += "; MCP backfilled earlier in this pass";
      }
      return { outcome: "applied", detail };
    });
  }

  // --- G4: secret-perms — chmod 600 LAST (TD-220) ---------------------------
  // Every rewrite above (tmp+renameSync at the umask default) can re-loosen a
  // harness config (Risk R1); running the chmod after all of them makes it
  // ordering-independent. chmod fixes the loose-bit dimension only — a
  // git-tracked file stays flagged (chmod cannot untrack).
  for (const row of byClass("secret-perms")) {
    const owner = isIgrisOwnedSecretFile(row.path) ? "Igris-owned" : "harness-owned";
    await attempt(row, row.path, `chmod 600 (${owner})`, () => {
      info(`fix: secret-perms (${owner}) — chmod 600 ${row.path}`);
      const ok = chmodSecretFile(row.path);
      const verdict = checkSecretFilePerms(row.path);
      if (!ok && verdict !== "ok") {
        logError(`secret-perms fix: could not chmod 600 ${row.path}`);
        return { outcome: "failed", detail: "chmod failed" };
      }
      if (verdict !== "ok") {
        warn(
          `${row.path}: still flagged after --fix (git-tracked secret cannot ` +
            `be untracked by chmod — remove it from git).`,
        );
        return { outcome: "applied", detail: "chmod ok; still flagged (git-tracked)" };
      }
      return { outcome: "applied", detail: "mode 600" };
    });
  }

  // Classes --fix never touches: say so, per row, as before.
  for (const row of drift) {
    if (
      row.driftClass === "slug-basename-mismatch" ||
      row.driftClass === "duplicate-path" ||
      row.driftClass === "channel-mismatch" ||
      row.driftClass === "brain-core-stale" ||
      row.driftClass === "machine-identity" ||
      row.driftClass === "secret-scan-disarmed"
    ) {
      warn(`${row.slug}: ${row.driftClass} — ${row.recommendedFix}`);
    }
  }
  return out;
}

/**
 * LIVE re-probe of one row's class after --fix: true = still drifted,
 * false = clean now, null = no re-probe exists for this class (it is never
 * auto-fixed, so it stays non-clean). Shared by the outcome table's `now`
 * column and the exit predicate, so the two cannot disagree.
 */
function reprobe(row: DriftRow): boolean | null {
  switch (row.driftClass) {
    case "brain-core-missing":
      return detectBrainCoreMissing() !== null;
    case "bridge-missing":
      return detectBridgeMissing().some((b) => b.path === row.path);
    case "mcp-unregistered": {
      const m = inspectMcpRegistration();
      return !m.registered || !m.pathExists;
    }
    case "hooks-missing":
    case "hooks-stale":
      return detectGlobalHooksDrift() !== null;
    case "attribution-missing":
      return detectAttributionMissing() !== null;
    case "secret-perms":
      return checkSecretFilePerms(row.path) !== "ok";
    case "skills-pollution": {
      // TD-223 (RE-SCOPED): any remaining migration condition, unexpected-
      // target symlink, OR stray projection symlink keeps the row non-clean.
      const post = classifyMigration();
      return (
        post.toMigrate.length > 0 ||
        post.unexpected.length > 0 ||
        post.strays.length > 0
      );
    }
    case "antigravity-skills-link":
      return detectAntigravitySkillsLink() !== null;
    case "git-hooks-missing":
      return detectGitHooksMissing(row.slug, row.path) !== null;
    default:
      return null;
  }
}

/** The per-fix outcome table — every fix attempted, its result, the live state. */
function printFixSummary(outcomes: FixOutcome[]): void {
  info("");
  if (outcomes.length === 0) {
    info("Fix summary: No fixes attempted (no auto-fixable row in the drift table).");
    return;
  }
  const n = (k: FixOutcomeKind): number => outcomes.filter((o) => o.outcome === k).length;
  info(
    `Fix summary: ${outcomes.length} fix(es) attempted — ${n("applied")} applied, ` +
      `${n("refused")} refused, ${n("failed")} failed, ${n("skipped")} skipped`,
  );
  info("| class | target | action | outcome | now |");
  info("|-------|--------|--------|---------|-----|");
  const cell = (t: string): string => t.replace(/\|/g, "/");
  for (const o of outcomes) {
    const still = reprobe(o.row);
    const now = still === null ? "n/a" : still ? o.row.driftClass : "clean";
    const action = o.detail.length > 0 ? `${o.action} (${o.detail})` : o.action;
    info(`| ${o.row.driftClass} | ${cell(o.target)} | ${cell(action)} | ${o.outcome} | ${now} |`);
  }
}

/**
 * Classify all drift: brain-level synthetic rows + per-project rows.
 * Brain-level rows come first (precedence). Per-project channel-mismatch
 * is folded into the per-project pass.
 */
export async function classifyDriftAll(rows: RegistryRow[]): Promise<DriftRow[]> {
  const out: DriftRow[] = [];

  // Brain-level synthetic rows (highest precedence after path-missing,
  // which only applies per-project).
  const missing = detectBrainCoreMissing();
  if (missing !== null) {
    out.push(missing);
    // When core is missing, brain-core-stale is vacuous (we have no
    // baseline to compare against). Skip the network probe.
  } else {
    try {
      const stale = await detectBrainCoreStale();
      if (stale !== null) out.push(stale);
    } catch {
      // Network failures are non-fatal — staleness is best-effort.
    }
  }

  // Bridge-missing is brain-level too (config-driven), and orthogonal to
  // core-missing — even with a missing core, the user might benefit from
  // knowing a CLI on PATH lacks a bridge entry.
  const bridges = detectBridgeMissing();
  for (const b of bridges) out.push(b);

  // mcp-unregistered (TD-168): brain-level, config-driven, sits next to
  // bridge-missing. Flagged when ~/.claude.json lacks the igris-brain MCP
  // entry OR the entry points at a missing file — in either case Claude
  // Code serves zero brain tools.
  const mcp = inspectMcpRegistration();
  if (!mcp.registered || !mcp.pathExists) {
    out.push({
      slug: "(brain)",
      path: claudeJsonPath(),
      driftClass: "mcp-unregistered",
      recommendedFix:
        "run 'igris init --upgrade' or 'igris doctor --fix' to register the igris-brain MCP",
    });
  }

  // hooks-missing / hooks-stale (FR-212d): brain-level, config-driven, sits
  // next to mcp-unregistered. Under the global-projection model the Igris hooks
  // are ONE block in `~/.claude/settings.json` (not per-project), so global
  // hooks drift is a SINGLE `(brain)`-slug row — fired when the global settings
  // lack the Igris SessionEnd hook (hooks-missing) or carry it at a non-canonical
  // command path (hooks-stale).
  const globalHooks = detectGlobalHooksDrift();
  if (globalHooks !== null) out.push(globalHooks);

  // attribution-missing (TD-473): brain-level, config-driven, sits right after
  // hooks-missing/hooks-stale — same target file, independent gap. A machine
  // whose hooks are already canonical but never ran `update` post-TD-470 needs
  // its own row; an absent/malformed settings file defers to hooks-missing
  // above (see the detector's own docblock).
  const attributionMissing = detectAttributionMissing();
  if (attributionMissing !== null) out.push(attributionMissing);

  // secret-perms (TD-220): brain-level, config-driven, sits next to
  // mcp-unregistered. Flags Igris-owned config.json/secrets.env + the 4
  // harness configs when their perms are group/world-readable or git-tracked.
  for (const sp of detectSecretFilePerms()) out.push(sp);

  // skills-pollution (TD-223 RE-SCOPED): brain-level, state-driven, LOWEST
  // brain-level precedence (sits after secret-perms). Flagged when a managed
  // surface root (~/.claude/skills or ~/.claude/agents) is a legacy v6-era
  // WHOLE-DIR symlink pointing at the canonical source, OR a stray projection
  // symlink leaked into that canonical source.
  const sp = detectSkillsPollution();
  if (sp !== null) out.push(sp);

  // antigravity-skills-link (FR-179 Phase C, R2): brain-level, CLI-detection-
  // driven, sits next to bridge-missing. Fires when `agy` is detected but
  // ~/.gemini/antigravity-cli/skills does NOT resolve to ~/.agents/skills, so
  // antigravity loads zero Igris skills (the R2 silent gap).
  const agSkills = detectAntigravitySkillsLink();
  if (agSkills !== null) out.push(agSkills);

  // machine-identity (BR-100): informational, read-only, lowest precedence.
  const mi = detectMachineIdentity();
  if (mi !== null) out.push(mi);

  // secret-scan-disarmed (FR-243): informational, read-only, beside
  // machine-identity. Fires when at least one registered project has the
  // Igris pre-commit installed and `gitleaks` is not on PATH.
  const ssd = detectSecretScanDisarmed(rows);
  if (ssd !== null) out.push(ssd);

  // Per-project: channel-mismatch + the existing classifyDrift output.
  // channel-mismatch sits BEFORE the existing per-project chain in
  // precedence, so we add its rows first and skip those slugs in the
  // existing chain.
  const channelMismatched = detectChannelMismatch();
  const channelMismatchSlugs = new Set(channelMismatched.map((r) => r.slug));
  for (const c of channelMismatched) out.push(c);

  const perProject = classifyDrift(rows);
  for (const r of perProject) {
    // If a row already got flagged as channel-mismatch, skip its lower-
    // precedence per-project classification. The mismatched row is the
    // one that surfaces.
    if (channelMismatchSlugs.has(r.slug)) continue;
    out.push(r);
  }

  return out;
}

/**
 * Classify every registry row into a single drift class. Returns one DriftRow
 * per registry row in the same order the registry returned them.
 *
 * FR-212d Phase 2 (register-only / global surfaces): `igris install` no longer
 * materializes a per-project `.claude/` layer (no symlinks, no per-project
 * `settings.json`, no `.igris_version`) — every surface projects GLOBALLY at
 * `igris init`, and the Igris hooks live in ONE global `~/.claude/settings.json`
 * block. So the per-project "install integrity" is reduced to: the registry row
 * exists AND its path still exists on disk. The `not-installed` /
 * `hooks-missing` / `hooks-stale` classes (which keyed on the now-deleted
 * per-project `.claude/` layer) were RETIRED from the per-project pass. The
 * global-hooks drift check moved to a single brain-level row in
 * `classifyDriftAll` (`detectGlobalHooksDrift`), since hooks are global now.
 *
 * Detects (per-project):
 * - source-reclaimed (FR-265): !existsSync(row.path) AND a non-empty
 *                 `repo_url` — removed on purpose, recoverable; exit-neutral.
 * - path-missing: !existsSync(row.path) with no `repo_url` — the registry row
 *                 points at a deleted dir (the one genuinely-broken state a
 *                 register-only project can still be in). Resolved by a
 *                 re-point, a recorded `repo_url`, or --remove-orphans.
 * - duplicate-path: any other row whose realpath(row.path) is identical.
 * - git-hooks-missing (FR-243): `.git/` is a directory and the Igris git hooks
 *                 are absent / foreign / dangling / not executable, or
 *                 core.hooksPath bypasses `.git/hooks/`. Resolved via --fix.
 * - slug-basename-mismatch: row.slug !== basename(row.path) (informational).
 * - symlink-target: row.path is a symlink (informational).
 * - clean: registered + path exists (the register-only happy path).
 *
 * Precedence: path-missing / source-reclaimed > duplicate-path >
 *             git-hooks-missing > slug-basename-mismatch > symlink-target > clean.
 * (a missing path wins because if the path is gone, everything else is vacuous.)
 */
export function classifyDrift(rows: RegistryRow[]): DriftRow[] {
  // Pre-pass: build realpath -> slugs map for duplicate-path detection.
  const realpathMap = new Map<string, string[]>();
  for (const r of rows) {
    if (!existsSync(r.path)) continue;
    let rp: string;
    try {
      rp = realpathSync(r.path);
    } catch {
      continue;
    }
    const list = realpathMap.get(rp) ?? [];
    list.push(r.slug);
    realpathMap.set(rp, list);
  }

  const out: DriftRow[] = [];

  for (const r of rows) {
    if (!existsSync(r.path)) {
      // FR-265: a recorded repo_url turns a missing path into a deliberate,
      // recoverable state. An empty string counts as absent.
      const repoUrl = typeof r.repo_url === "string" ? r.repo_url.trim() : "";
      if (repoUrl !== "") {
        out.push({
          slug: r.slug,
          path: r.path,
          driftClass: "source-reclaimed",
          recommendedFix: "source removed on purpose — restore: see below",
          repoUrl,
        });
        continue;
      }
      out.push({
        slug: r.slug,
        path: r.path,
        driftClass: "path-missing",
        recommendedFix: "moved? re-point (see below), else --remove-orphans",
      });
      continue;
    }

    let resolvedPath: string | undefined;
    let isSymlink = false;
    try {
      isSymlink = lstatSync(r.path).isSymbolicLink();
      if (isSymlink) {
        resolvedPath = realpathSync(r.path);
      }
    } catch {
      // ignore — already covered by existsSync above
    }

    const dupSlugs = realpathMap.get(realpathSyncSafe(r.path)) ?? [];
    if (dupSlugs.length > 1) {
      out.push({
        slug: r.slug,
        path: r.path,
        driftClass: "duplicate-path",
        recommendedFix: `multiple slugs share path: ${dupSlugs.join(", ")} — pick one canonically and remove the others manually`,
        resolvedPath,
      });
      continue;
    }

    // FR-212d: a registered project whose path exists IS installed (register-
    // only model). The old `.claude/`-presence + per-project `settings.json`
    // hooks checks were deleted — they reflected a per-project layer `igris
    // install` no longer writes. Global-hooks drift is a brain-level row.

    // FR-243: the GIT-level gates are a per-project property again — a
    // symlink chain from `.git/hooks/` to the canonical hook. Broken-tier, so
    // it sits above the two informational classes below.
    const gitHooks = detectGitHooksMissing(r.slug, r.path, resolvedPath);
    if (gitHooks !== null) {
      out.push(gitHooks);
      continue;
    }

    if (basename(r.path) !== r.slug) {
      out.push({
        slug: r.slug,
        path: r.path,
        driftClass: "slug-basename-mismatch",
        recommendedFix:
          "informational — basename != slug. If unintended, re-install with the desired slug.",
        resolvedPath,
      });
      continue;
    }

    if (isSymlink) {
      out.push({
        slug: r.slug,
        path: r.path,
        driftClass: "symlink-target",
        recommendedFix: `informational — registered path is a symlink to ${resolvedPath ?? "?"}`,
        resolvedPath,
      });
      continue;
    }

    out.push({
      slug: r.slug,
      path: r.path,
      driftClass: "clean",
      recommendedFix: "",
      resolvedPath,
    });
  }

  return out;
}

function realpathSyncSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * TD-220: the Igris-OWNED secret files. Igris authored these, so it owns
 * their perms outright — proactively tightened at init AND fixed by doctor
 * in the read pass (well, flagged in read; chmod'd under --fix). The 4
 * harness configs are harness-owned: WARN-only in the read pass, chmod ONLY
 * under --fix ("don't fight the harness").
 */
function igrisOwnedSecretFiles(): string[] {
  return [configJsonPath(), secretsEnvPath()];
}

/** True when `path` is one of the Igris-owned secret files. */
function isIgrisOwnedSecretFile(path: string): boolean {
  return igrisOwnedSecretFiles().includes(path);
}

/**
 * TD-220: classify the perms of every Igris-written secret-bearing file +
 * the harness-owned secret configs into `secret-perms` drift rows. A row is emitted
 * ONLY when the verdict is not "ok" (loose group/other bits, or git-tracked,
 * or both). Absent files and win32 produce "ok" (no row) — see
 * checkSecretFilePerms (never throws).
 *
 * NOTE (Risk R1 — atomic-rename re-loosens harness configs): the FR-162/163
 * mergers in mcp-register.ts (and the mcp-grant.ts grant writers) write via
 * tmp+renameSync, which adopts the tmp file's umask mode (often 644). The clean
 * fix — chmod 600 after the rename, reusing TD-220's `chmodSecretFile` — has now
 * SHIPPED on both Igris-owned writer paths: **TD-221** hardened the mergers and
 * **TD-232** hardened the grant writers (notably the codex `~/.codex/config.toml`
 * grant, which shares this secret-perms scope). These harness configs stay
 * warn/--fix-only here (Decision 5) since doctor doesn't own them, but the Igris
 * writers no longer re-loosen them on-write.
 */
function detectSecretFilePerms(): DriftRow[] {
  const out: DriftRow[] = [];
  const igrisOwned = igrisOwnedSecretFiles();
  // TD-283: antigravity + cursor are intentionally NOT here — Igris writes only
  // the env-free brain MCP entry to their config (no secret, L-588; nothing to
  // chmod). See secret-perms.ts "Files in scope".
  const harnessOwned = [
    claudeJsonPath(),
    geminiSettingsPath(),
    codexConfigTomlPath(),
    opencodeConfigPath(),
  ];

  for (const p of [...igrisOwned, ...harnessOwned]) {
    const verdict = checkSecretFilePerms(p);
    if (verdict === "ok") continue;

    const owned = igrisOwned.includes(p);
    const ownerTag = owned ? "Igris-owned" : "harness-owned";
    // git-tracked is NOT resolved by chmod — name it explicitly so the
    // operator knows --fix alone won't clear the row.
    const tracked = verdict === "git-tracked" || verdict === "loose+git-tracked";
    const recommendedFix = tracked
      ? `${ownerTag} secret file is git-tracked — remove it from git (chmod alone won't untrack); 'igris doctor --fix' chmods 600`
      : `${ownerTag} secret file has loose perms — run 'igris doctor --fix' to chmod 600`;

    out.push({
      slug: "(brain)",
      path: p,
      driftClass: "secret-perms",
      recommendedFix,
    });
  }

  return out;
}

/**
 * TD-223 (RE-SCOPED): classify the managed surface roots (~/.claude/skills,
 * ~/.claude/agents) + the canonical-source strays into a SINGLE brain-level
 * `skills-pollution` row. The row is emitted ONLY when ≥1 root is in the
 * migration condition (legacy whole-dir symlink), OR a root is a symlink to an
 * unexpected target, OR a stray projection symlink leaked into the canonical
 * source. A pure per-surface-model machine (real dirs, no strays) produces no
 * row. The row.path is the first affected root/source (for the table) and
 * `recommendedFix` summarizes what --fix will migrate/clean. Never throws
 * (classifyMigration degrades to an empty report on any error / win32).
 */
function detectSkillsPollution(): DriftRow | null {
  const report = classifyMigration();
  if (
    report.toMigrate.length === 0 &&
    report.unexpected.length === 0 &&
    report.strays.length === 0
  ) {
    return null;
  }
  const parts: string[] = [];
  if (report.toMigrate.length > 0) {
    const roots = report.toMigrate.map((s) => s.kind).join("+");
    parts.push(
      `${report.toMigrate.length} legacy whole-dir symlink root(s) [${roots}] ` +
        `to migrate (fixable via 'igris doctor --fix')`,
    );
  }
  if (report.unexpected.length > 0) {
    parts.push(
      `${report.unexpected.length} root(s) symlinked to an UNEXPECTED target ` +
        `(resolve manually — never auto-rewritten)`,
    );
  }
  const removableStrays = report.strays.filter((s) => s.isLoadoutProjection);
  const unknownStrays = report.strays.filter((s) => !s.isLoadoutProjection);
  if (removableStrays.length > 0) {
    parts.push(
      `${removableStrays.length} stray projection symlink(s) in the canonical ` +
        `source (fixable via 'igris doctor --fix')`,
    );
  }
  if (unknownStrays.length > 0) {
    parts.push(
      `${unknownStrays.length} non-projection stray symlink(s) (resolve ` +
        `manually — never auto-removed)`,
    );
  }
  const affectedRoot =
    report.toMigrate[0]?.root ??
    report.unexpected[0]?.root ??
    report.strays[0]?.path ??
    "~/.claude/skills";
  return {
    slug: "(brain)",
    path: affectedRoot,
    driftClass: "skills-pollution",
    recommendedFix: parts.join(", "),
  };
}

/**
 * machine-identity (BR-100): (b) minted but the live hostname is not in the
 * persisted aliases; (c) NULL-id local rows under names outside the aliases.
 * An unminted identity is not drift (a fresh init stays clean). Never writes.
 */
function detectMachineIdentity(): DriftRow | null {
  const me = readMachineIdentity();
  const cfg = readConfig();
  const raw = cfg !== null ? cfg.machine : undefined;
  const block =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  const persisted = Array.isArray(block?.aliases)
    ? (block!.aliases as unknown[]).filter((a): a is string => typeof a === "string")
    : [];
  const parts: string[] = [];
  if (me.machine_id !== null && !persisted.includes(me.hostname)) {
    parts.push(
      `hostname changed since the last writer ran: now '${me.hostname}', ` +
        `aliases [${persisted.join(", ")}] (the next writer appends it)`,
    );
  }
  const seen = readUnattributedHostnames(me);
  if (seen.length > 0) {
    parts.push(
      `seen locally, unattributed (machine_id NULL): ` +
        seen.map((s) => `'${s.hostname}' (${s.rows})`).join(", ") +
        ` — add to config.json machine.aliases ONLY names this machine has used` +
        (me.machine_id === null ? `; identity not yet minted (the next writer mints it)` : ""),
    );
  }
  if (parts.length === 0) return null;
  return {
    slug: "(brain)",
    path: configJsonPath(),
    driftClass: "machine-identity",
    recommendedFix: `informational — ${parts.join("; ")}`,
  };
}

/**
 * git-hooks-missing (FR-243): per-project, read-only. Null when the path is not
 * a git repository or `.git` is a file (worktree / submodule — no row), or when
 * both hooks are installed and executable.
 */
export function detectGitHooksMissing(
  slug: string,
  path: string,
  resolvedPath?: string,
): DriftRow | null {
  const insp = inspectGitHooks(path);
  if (insp.kind === "not-git" || insp.kind === "worktree") return null;
  if (insp.kind === "hooks-path-bypass") {
    return {
      slug,
      path,
      driftClass: "git-hooks-missing",
      recommendedFix:
        `core.hooksPath=${insp.hooksPath} bypasses .git/hooks — not auto-fixed; ` +
        `add ~/.igris/core/git-hooks/{pre-commit,commit-msg} to that pipeline`,
      resolvedPath,
    };
  }
  const broken = insp.hooks.filter((h) => h.state !== "installed");
  if (broken.length === 0) return null;
  const fixable = broken.every((h) => h.state !== "source-missing");
  return {
    slug,
    path,
    driftClass: "git-hooks-missing",
    recommendedFix:
      broken.map((h) => h.reason).join("; ") +
      (fixable
        ? " — run 'igris doctor --fix' (or 'igris install <path>')"
        : " — run 'igris refresh', then 'igris doctor --fix'"),
    resolvedPath,
  };
}

/**
 * secret-scan-disarmed (FR-243): brain-level, informational. ≥1 registered
 * project with the Igris pre-commit INSTALLED (symlink resolving to the
 * canonical source, executable) while `gitleaks` is not resolvable on PATH.
 * A machine with no installed hook has nothing disarmed — no row. Never
 * --fix'able: the binary is the operator's to install.
 */
export function detectSecretScanDisarmed(rows: RegistryRow[]): DriftRow | null {
  if (gitleaksOnPath()) return null;
  const armed: string[] = [];
  for (const r of rows) {
    if (!existsSync(r.path)) continue;
    const insp = inspectGitHooks(r.path);
    if (insp.kind !== "ok") continue;
    const pre = insp.hooks.find((h) => h.name === "pre-commit");
    if (pre !== undefined && pre.state === "installed") armed.push(r.slug);
  }
  if (armed.length === 0) return null;
  return {
    slug: "(brain)",
    path: "PATH",
    driftClass: "secret-scan-disarmed",
    recommendedFix:
      `informational — install gitleaks (brew install gitleaks); every installed ` +
      `Igris pre-commit is running with secret-scan=DISARMED (${armed.length} ` +
      `project(s): ${armed.join(", ")})`,
  };
}

/**
 * TD-223 (RE-SCOPED): read-pass WARN — name each surface root to migrate, each
 * unexpected-target root, and each stray projection symlink by PATH ONLY (NEVER
 * file contents — L-515). Unexpected-target roots + non-projection strays get an
 * explicit "resolve manually" warning since --fix will never touch them.
 */
function warnSkillsPollutionEntries(): void {
  const report = classifyMigration();
  for (const s of report.toMigrate) {
    warn(
      `skills-pollution: ${s.kind} surface root '${s.root}' is a legacy ` +
        `whole-dir symlink → '${s.source}'. 'igris doctor --fix' will migrate ` +
        `it to a REAL dir of per-item symlinks (the old symlink is backed up).`,
    );
  }
  for (const s of report.unexpected) {
    warn(
      `skills-pollution: ${s.kind} surface root '${s.root}' is a symlink to an ` +
        `UNEXPECTED target (not the canonical source '${s.source}') — NOT ` +
        `auto-fixable. Resolve manually before recompiling.`,
    );
  }
  for (const stray of report.strays) {
    if (stray.isLoadoutProjection) {
      warn(
        `skills-pollution: stray projection symlink '${stray.path}' leaked into ` +
          `the canonical source — 'igris doctor --fix' will unlink it (it is a ` +
          `loadout projection, not core content).`,
      );
    } else {
      warn(
        `skills-pollution: stray symlink '${stray.path}' in the canonical source ` +
          `does NOT resolve into the loadout — NOT auto-removed. Resolve ` +
          `manually (verify it is not hand-authored, then remove).`,
      );
    }
  }
}

/**
 * TD-223 (RE-SCOPED) `--fix` worker: migrate each legacy whole-dir surface root
 * to a REAL dir of per-item symlinks, then clean each stray projection symlink
 * leaked into the canonical source. PRINTS the before/after enumeration as the
 * no-loss proof. Returns the number of errors encountered (for the exit code).
 *
 * Order matters: migrate the roots FIRST so the personal per-item symlinks
 * exist in the real surface dir, THEN clean the strays (removeStraySourceSymlink
 * refuses until the migrated home exists — its precondition #3).
 */
function fixSkillsPollution(): number {
  let errs = 0;
  info(
    "fix: skills-pollution — migrating legacy whole-dir surface roots to " +
      "per-item symlinks (direct-materialize; never compile)",
  );

  // Re-classify LIVE at fix time (the read-pass report may be stale).
  const report = classifyMigration();

  // 1. Migrate each surface root in the migration condition.
  for (const sr of report.toMigrate) {
    const result = migrateSurfaceRoot({
      kind: sr.kind,
      root: sr.root,
      source: sr.source,
    });
    if (result.outcome === "migrated") {
      info(
        `  migrated ${sr.kind} root '${sr.root}' -> REAL dir; old symlink ` +
          `backed up to ${result.backupPath}`,
      );
      // The before/after enumeration is the no-loss safety proof (print names
      // only — never contents). AFTER must ⊇ BEFORE.
      const beforeNames = result.before.map((b) => b.name).sort();
      const afterNames = result.after.map((a) => a.name).sort();
      info(`    before (${beforeNames.length}): ${beforeNames.join(", ")}`);
      info(`    after  (${afterNames.length}): ${afterNames.join(", ")}`);
      const lost = beforeNames.filter((n) => !afterNames.includes(n));
      if (lost.length > 0) {
        // Should never happen — the inventory is the source walk + overlay. If
        // it does, surface it loudly (the operator can restore from .bak).
        errs++;
        logError(
          `skills-pollution fix: ${sr.kind} migration would lose name(s): ` +
            `${lost.join(", ")} — old symlink preserved at ${result.backupPath}.`,
        );
      }
    } else if (result.outcome === "refused-unexpected-target") {
      errs++;
      logError(
        `skills-pollution fix: refused ${sr.kind} root '${sr.root}' — it is a ` +
          `symlink to an UNEXPECTED target (not the canonical source). ` +
          `Resolve manually.`,
      );
    } else if (result.outcome === "refused-containment") {
      errs++;
      logError(
        `skills-pollution fix: refused ${sr.kind} root '${sr.root}' — a ` +
          `staging/backup path escaped containment (#515).`,
      );
    } else if (result.outcome === "skipped-not-migratable") {
      // No longer the migration condition at fix time (TOCTOU / already real
      // dir) — informational, not an error.
      info(
        `  skipped ${sr.kind} root '${sr.root}' — no longer a whole-dir ` +
          `symlink at fix time (already migrated).`,
      );
    } else {
      errs++;
      logError(`skills-pollution fix: failed to migrate ${sr.kind} root '${sr.root}'.`);
    }
  }

  // Name unexpected-target roots that --fix deliberately leaves untouched (the
  // read-pass WARN is gated behind !opts.fix). NEVER logs contents.
  for (const sr of report.unexpected) {
    warn(
      `skills-pollution: ${sr.kind} root '${sr.root}' is a symlink to an ` +
        `UNEXPECTED target — left untouched. Resolve manually.`,
    );
  }

  // 2. Clean the stray projection symlinks AFTER migration (so the per-item
  // home exists). Map each stray's source to the matching migrated surface root.
  for (const stray of report.strays) {
    const surfaceRoot = surfaceRootForStray(stray.path, report);
    const outcome = removeStraySourceSymlink(stray.path, surfaceRoot);
    if (outcome === "removed") {
      info(`  removed stray projection symlink '${stray.path}'`);
    } else if (outcome === "skipped-not-projection") {
      warn(
        `skills-pollution: stray '${stray.path}' is NOT a loadout projection ` +
          `— left untouched. Resolve manually.`,
      );
    } else if (outcome === "skipped-no-migrated-target") {
      // The migrated per-item home does not exist (e.g. the overlay does not
      // declare this name) — leave the stray and tell the operator.
      warn(
        `skills-pollution: stray '${stray.path}' left in place — no migrated ` +
          `per-item symlink at '${join(surfaceRoot, basename(stray.path))}'.`,
      );
    } else if (outcome === "skipped-not-symlink") {
      info(`  skipped stray '${stray.path}' — no longer a symlink at fix time.`);
    } else {
      errs++;
      logError(`skills-pollution fix: failed to remove stray '${stray.path}'.`);
    }
  }

  return errs;
}

/**
 * Map a stray symlink path (inside a canonical source) to the migrated surface
 * root that should hold its per-item home. The stray lives in
 * `~/.igris/core/skills` (→ `~/.claude/skills`) or `~/.igris/core/agents`
 * (→ `~/.claude/agents`). Resolved from the report's surface list by matching
 * the stray's parent dir against each surface's source. Falls back to
 * `coreSkillsSource` vs `coreAgentsSource` lexical comparison.
 */
function surfaceRootForStray(
  strayPath: string,
  report: ReturnType<typeof classifyMigration>,
): string {
  const parent = dirname(strayPath);
  for (const sr of report.surfaces) {
    if (samePath(sr.source, parent)) return sr.root;
  }
  // Fallback: lexical match on the known source roots.
  if (samePath(parent, coreAgentsSource())) {
    const agents = report.surfaces.find((s) => s.kind === "agents");
    if (agents) return agents.root;
  }
  const skills = report.surfaces.find((s) => s.kind === "skills");
  if (skills) return skills.root;
  // Last resort — derive `~/.claude/<kind>` from the source basename.
  return samePath(parent, coreAgentsSource())
    ? coreAgentsSource()
    : coreSkillsSource();
}

/** realpath-equality of two paths (verbatim fallback when unresolvable). */
function samePath(a: string, b: string): boolean {
  return realpathSyncSafe(a) === realpathSyncSafe(b);
}

/**
 * FR-165: read-only WARNING path for MCP env-var indirection refs that resolve
 * NOWHERE — i.e. a `${VAR}` in some `surfaces.mcp_servers[*].canonical.env`
 * that is absent from BOTH `~/.igris/secrets.env` AND `process.env`. claude /
 * gemini / opencode resolve the ref + inherit exported env at launch, and the
 * Codex compile (FR-164) reads `secrets.env` for the literal — so an unresolved
 * VAR means that server will launch with an empty/missing value on at least one
 * harness.
 *
 * This is a WARN, NOT a fixable drift-row: the fix is "add it to secrets.env",
 * which doctor cannot do safely (it would be writing a secret). The warning
 * names the VAR + the server only — there is NO value to log (the VAR is, by
 * definition, missing), and we never echo a resolved env value either.
 *
 * Read-only: parses the overlay + secrets.env without writing anything.
 * Servers with no `canonical.env` (e.g. igris-brain) never trip this — the
 * natural iteration over `canonical.env` entries already scopes it correctly.
 */
function detectMissingSecrets(): void {
  // Parse the personal overlay defensively — a malformed/absent overlay must
  // not break doctor (it is best-effort advisory).
  let mcpBlocks: Array<{
    name?: unknown;
    canonical?: { env?: unknown };
  }> = [];
  try {
    const overlayPath = loadoutOverlayPath();
    if (!existsSync(overlayPath)) {
      return;
    }
    const parsed = JSON.parse(readFileSync(overlayPath, "utf-8")) as {
      surfaces?: { mcp_servers?: unknown };
    };
    const blocks = parsed.surfaces?.mcp_servers;
    if (Array.isArray(blocks)) {
      mcpBlocks = blocks as typeof mcpBlocks;
    }
  } catch {
    // Malformed overlay → skip the advisory check silently.
    return;
  }

  if (mcpBlocks.length === 0) {
    return;
  }

  const secrets = parseSecretsEnv();
  for (const block of mcpBlocks) {
    const env = block.canonical?.env;
    if (env === null || typeof env !== "object" || Array.isArray(env)) {
      continue;
    }
    const serverName = typeof block.name === "string" ? block.name : "(unnamed)";
    for (const value of Object.values(env as Record<string, unknown>)) {
      if (typeof value !== "string") {
        continue;
      }
      const varName = extractVarName(value);
      if (varName === null) {
        continue; // not a ref (write-guard should prevent this, but be safe)
      }
      const inSecrets = Object.prototype.hasOwnProperty.call(secrets, varName);
      const inProcessEnv = Object.prototype.hasOwnProperty.call(
        process.env,
        varName,
      );
      if (!inSecrets && !inProcessEnv) {
        // Name the VAR + server ONLY — never a value (there is none to leak).
        warn(
          `MCP secret '${varName}' (server '${serverName}') is not set in ` +
            `~/.igris/secrets.env or the environment. Add 'export ${varName}=...' ` +
            `to ~/.igris/secrets.env (chmod 600) so Codex can resolve it and ` +
            `claude/gemini/opencode inherit it at launch.`,
        );
      }
    }
  }
}

/**
 * FR-212d: classify the GLOBAL Igris hooks block (`~/.claude/settings.json`)
 * into a single brain-level drift row, or null when it is present + canonical.
 *
 * Under the global-projection model the Igris hooks fire for EVERY project on
 * the machine via ONE user-level settings block (`igris init` merges it; the
 * per-project `_gate.sh` de-no-ops them outside a registered project). There is
 * no per-project hooks layer anymore, so this is the ONE place hooks drift is
 * detected:
 *   - hooks-missing: the global settings exist but lack the Igris SessionEnd
 *                    hook (or the file is absent/malformed).
 *   - hooks-stale:   the Igris SessionEnd hook is present but at a non-canonical
 *                    command path.
 *
 * Both are repaired by the `--fix` global-hooks refresh (mergeGlobalCanonicalHooks).
 * Read-only + never throws. `opts.settingsPath` overrides the target (tests
 * sandbox HOME). When the canonical-hooks source can't be read (e.g. brain core
 * missing), we skip the stale comparison but still flag a genuinely-absent hook.
 */
function detectGlobalHooksDrift(opts?: {
  settingsPath?: string;
}): DriftRow | null {
  const target = opts?.settingsPath ?? claudeUserSettingsPath();
  const canonicalCmd = "$HOME/.igris/core/hooks/shared/session_end.sh";

  const state = inspectSettings(target);
  if (state === "missing" || state === "malformed" || state === "hooks-missing") {
    return {
      slug: "(brain)",
      path: target,
      driftClass: "hooks-missing",
      recommendedFix:
        "run 'igris init' or 'igris doctor --fix' to merge the global Igris hooks",
    };
  }

  // hooks-present: flag stale only when the SessionEnd command diverges from
  // the canonical path.
  const sessionEndCmd = extractSessionEndCommand(target);
  if (sessionEndCmd !== null && sessionEndCmd !== canonicalCmd) {
    return {
      slug: "(brain)",
      path: target,
      driftClass: "hooks-stale",
      recommendedFix: "run 'igris doctor --fix' to refresh the global hooks",
    };
  }

  return null;
}

/**
 * TD-473: classify the GLOBAL Claude Code `attribution` default gap into a
 * single brain-level drift row, or null when it is set/user-owned. Read-only +
 * never throws.
 *
 * Absent or malformed settings defer ENTIRELY to `hooks-missing`/`malformed`
 * (`detectGlobalHooksDrift`, above) — a settings file that does not exist or
 * does not parse is already flagged there, and flagging it again here would be
 * a duplicate row for the same underlying fix (`igris init`/`igris doctor
 * --fix`, which repairs both in one write). Only a PRESENT, PARSEABLE settings
 * file is inspected, by calling the EXISTING pure `applyAttributionDefault`
 * read-only (its return is discarded, never written) and reading its outcome:
 * `added` means neither `attribution` nor `includeCoAuthoredBy` was present —
 * the exact AC-1 gap; `present`/`kept-user` mean the file already carries an
 * attribution posture (Igris's own default, or a user-authored one) and is
 * clean. `opts.settingsPath` overrides the target (tests sandbox HOME).
 */
function detectAttributionMissing(opts?: { settingsPath?: string }): DriftRow | null {
  const target = opts?.settingsPath ?? claudeUserSettingsPath();
  if (!existsSync(target)) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(target, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const { outcome } = applyAttributionDefault(parsed);
  if (outcome !== "added") return null;
  return {
    slug: "(brain)",
    path: target,
    driftClass: "attribution-missing",
    recommendedFix: "run 'igris doctor --fix' (or 'igris update') to set the Claude Code attribution default",
  };
}

type SettingsState = "missing" | "hooks-missing" | "hooks-present" | "malformed";

function inspectSettings(filePath: string): SettingsState {
  if (!existsSync(filePath)) return "missing";
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8")) as {
      hooks?: { SessionEnd?: unknown[] };
    };
    const arr = data.hooks?.SessionEnd;
    if (!Array.isArray(arr) || arr.length === 0) return "hooks-missing";
    // any group whose first hook command starts with the Igris prefix counts
    for (const group of arr) {
      const sub = (group as { hooks?: unknown[] }).hooks;
      if (Array.isArray(sub)) {
        for (const h of sub) {
          const cmd = (h as { command?: string }).command;
          if (typeof cmd === "string" && cmd.startsWith("$HOME/.igris/core/hooks/")) {
            return "hooks-present";
          }
        }
      }
    }
    return "hooks-missing";
  } catch {
    return "malformed";
  }
}

function extractSessionEndCommand(filePath: string): string | null {
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8")) as {
      hooks?: { SessionEnd?: unknown[] };
    };
    const arr = data.hooks?.SessionEnd;
    if (!Array.isArray(arr)) return null;
    for (const group of arr) {
      const sub = (group as { hooks?: unknown[] }).hooks;
      if (Array.isArray(sub)) {
        for (const h of sub) {
          const cmd = (h as { command?: string }).command;
          if (typeof cmd === "string" && cmd.startsWith("$HOME/.igris/core/hooks/")) {
            return cmd;
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function printDriftTable(drift: DriftRow[]): void {
  if (drift.length === 0) {
    info("Registry is empty.");
    return;
  }
  const cleanCount = drift.filter((r) => r.driftClass === "clean").length;
  // FR-265: the one exit-neutral non-clean class gets its own count (printed
  // only when present, so a registry without one keeps its header unchanged).
  const reclaimedCount = drift.filter(
    (r) => isNotDrift(r.driftClass) && r.driftClass !== "clean",
  ).length;
  info(
    `Drift report: ${drift.length} project(s), ${cleanCount} clean` +
      (reclaimedCount > 0 ? `, ${reclaimedCount} source-reclaimed` : ""),
  );
  info("");
  info("| slug | path | drift-class | recommended-fix |");
  info("|------|------|-------------|-----------------|");
  for (const r of drift) {
    const fix = r.recommendedFix.length > 60 ? r.recommendedFix.slice(0, 57) + "..." : r.recommendedFix;
    info(`| ${r.slug} | ${r.path} | ${r.driftClass} | ${fix} |`);
  }
}

/**
 * Async prompt function — accepts the question string, resolves with the
 * user's answer (NOT trimmed/lowercased — caller normalizes), or `null` when
 * the input has ENDED (EOF): there is no answer and there will be none. Used as
 * the test seam in confirmAndRemoveOrphans so vitest can inject a scripted
 * reader without driving real stdin (TD-111). A reader that only ever returns
 * strings still satisfies this type.
 */
export type PromptFn = (question: string) => Promise<string | null>;

/**
 * What one `--remove-orphans` sweep did. Per-project, never per-batch (BR-084).
 *
 * `results` carries one entry per ATTEMPTED delete, in sweep order — a row the
 * user declined (`n`), one never reached (`a` / EOF), and one a mode refused on
 * ownership are not attempts and do not appear. `removed + skipped ===
 * results.length` by construction. Every candidate lands in exactly one of
 * `results`, `declined`, `unadjudicated` or `refused` (BR-087 AC4: a reader
 * can tell "the operator said no" from "nobody was asked").
 */
export interface OrphanSweepResult {
  removed: number;
  /** Attempts the DB refused. Each carries its reason in `results`. */
  skipped: number;
  results: DeleteProjectOutcome[];
  /** BR-087: answered `n` (or anything that is not y/a/all) — kept, still drift. */
  declined: string[];
  /** BR-087: never answered — the operator aborted (`a`) or the input ended (EOF) first. */
  unadjudicated: string[];
  /** TD-310: data-owning rows the mode refused to attempt (`--yes` without `--include-owning`, or `--empty-only`). */
  refused: Array<{ slug: string; reason: string }>;
}

/** TD-310: which non-interactive policy governs a sweep. */
export interface OrphanSweepOptions {
  /** `--empty-only`: never prompt; attempt only rows that own nothing. */
  emptyOnly?: boolean;
  /** `--include-owning` (with `--yes`): attempt data-owning rows too. */
  includeOwning?: boolean;
}

/**
 * BR-087: the production reader — every `'line'` is buffered from the moment
 * the ONE interface exists and answers the asks in order (a per-row
 * `rl.question` dropped lines piped in one burst and hung after EOF, draining
 * to exit 0); `'close'` resolves the pending ask and every later one `null`.
 */
class LineQueue {
  private readonly lines: string[] = [];
  private ended = false;
  private waiting: ((line: string | null) => void) | null = null;

  push(line: string): void {
    const w = this.waiting;
    if (w !== null) {
      this.waiting = null;
      w(line);
    } else {
      this.lines.push(line);
    }
  }

  end(): void {
    this.ended = true;
    const w = this.waiting;
    if (w !== null) {
      this.waiting = null;
      w(null);
    }
  }

  /** The input is over AND nothing is buffered: no later ask can be answered. */
  exhausted(): boolean {
    return this.ended && this.lines.length === 0;
  }

  isOpen(): boolean {
    return !this.ended;
  }

  next(): Promise<string | null> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.ended) return Promise.resolve(null);
    return new Promise((res) => {
      this.waiting = res;
    });
  }
}

/**
 * Orphan confirmation flow. Exported for vitest (TD-111): tests inject a
 * scripted `prompt` instead of driving `process.stdin`.
 *
 * MODES (TD-310), decided by each row's ownership:
 *   - `emptyOnly`: never prompts; removes only rows that own nothing.
 *   - `skipPrompt` (`--yes`): never prompts; REFUSES a data-owning row unless
 *     `includeOwning` (`learnings`/`errors` have no FK to stop a delete).
 *   - interactive: counts in every prompt; `y` attempts any row (per-row
 *     consent, FR-265 AC4); `all` auto-confirms only rows that own NOTHING;
 *     `a` or end of input leaves this row and the rest NOT ADJUDICATED (rows
 *     an earlier `all` covers are still removed after end of input).
 *
 * BR-084 — WHAT HAPPENS TO A PROJECT THAT STILL HAS BRIEFS, and why.
 *
 * Its registry row is KEPT and the project is REPORTED as skipped, with the
 * dependent count as the reason. The two alternatives were considered and
 * rejected:
 *
 *   - *delete the dependents too* (cascade, or an extra prompt). This destroys
 *     brief history — the brain's build record — to tidy a registry row, and it
 *     is offered by a verb whose whole contract is "diagnose and repair drift".
 *     The blast radius is unbounded (654 briefs on the operator's own brain) and
 *     irreversible, and a `--yes` sweep would take it WITHOUT asking. A doctor
 *     verb must not be the loudest destructive path in the CLI.
 *   - *re-point the briefs at another slug*. That is a data migration with no
 *     obvious target slug, and it belongs with the brief/project coupling work
 *     (TD-328), not inside a registry sweep. (TD-310 offers the opposite: re-point
 *     the ROW's path, keeping the slug the briefs already name.)
 *
 * Skip-and-report is also the only option that leaves the operator's next move
 * intact: the row is still there to delete deliberately once the briefs are
 * dealt with. So the sweep's failure mode is "one row survives, loudly", not
 * "history is gone, quietly" — and NOT (as before BR-084) "every other orphan
 * survives too, because the first refusal threw".
 *
 * @param prompt     Reader: the answer, or `null` at end of input. Defaults to
 *                   the `LineQueue` reader over `process.stdin`.
 * @param sweepOpts  TD-310 policy (`emptyOnly`, `includeOwning`).
 */
export async function confirmAndRemoveOrphans(
  orphans: DriftRow[],
  skipPrompt: boolean,
  prompt?: PromptFn,
  sweepOpts: OrphanSweepOptions = {},
): Promise<OrphanSweepResult> {
  const results: DeleteProjectOutcome[] = [];
  const declined: string[] = [];
  const unadjudicated: string[] = [];
  const refused: Array<{ slug: string; reason: string }> = [];

  // The ONLY route to deleteProjectRow in this function — one guard rather than
  // four. NB this closure constrains nothing outside this function, and since
  // BR-084 made deleteProjectRow NON-THROWING, a new caller that drops the
  // returned outcome compiles clean and fails SILENTLY (pre-BR-084 it crashed).
  // So the "only route" is pinned by a source scan in registry.test.ts, not by
  // this comment — a claim of the form "there is only one X" needs a mechanism,
  // which is the FR-247 / FR-240 precedent in this repo. TD-310's modes are
  // policy in front of this call, never a second one.
  const attempt = (o: DriftRow): void => {
    const outcome = deleteProjectRow(o.slug);
    results.push(outcome);
    if (outcome.ok) {
      info(`removed: ${o.slug}`);
    } else {
      warn(`skipped: ${o.slug} — ${outcome.error ?? "unknown reason"}`);
    }
  };
  const ownershipOf = (o: DriftRow): ProjectOwnership => o.ownership ?? projectOwnership(o.slug);
  const notAdjudicated = (o: DriftRow): void => {
    unadjudicated.push(o.slug);
    info(`not adjudicated: ${o.slug}`);
  };
  const summarize = (): OrphanSweepResult => ({
    removed: results.filter((r) => r.ok).length,
    skipped: results.filter((r) => !r.ok).length,
    results,
    declined,
    unadjudicated,
    refused,
  });

  // Non-interactive: the mode decides, nothing is asked.
  if (sweepOpts.emptyOnly === true || skipPrompt) {
    for (const o of orphans) {
      const own = ownershipOf(o);
      if (!ownsData(own)) {
        attempt(o);
        continue;
      }
      if (sweepOpts.emptyOnly === true) {
        refused.push({
          slug: o.slug,
          reason: `owns ${formatOwnership(own)} — --empty-only removes only rows that own nothing`,
        });
        info(`kept: ${o.slug} (owns ${formatOwnership(own)})`);
        continue;
      }
      if (sweepOpts.includeOwning === true) {
        attempt(o);
        continue;
      }
      const reason =
        `owns ${formatOwnership(own)} — --yes does not remove a data-owning row; ` +
        "re-point it, or pass --include-owning";
      refused.push({ slug: o.slug, reason });
      warn(`refused: ${o.slug} — ${reason}`);
    }
    return summarize();
  }

  // Interactive. `rl` is assigned BEFORE its listeners are attached, so the
  // `finally` closes it even if subscribing throws.
  const queue = new LineQueue();
  let rl: ReturnType<typeof createInterface> | null = null;
  const ask: PromptFn =
    prompt ??
    ((q: string): Promise<string | null> => {
      if (rl === null) {
        const created = createInterface({ input: process.stdin, output: process.stdout });
        rl = created;
        created.on("line", (line: string) => queue.push(line));
        created.on("close", () => queue.end());
        // Ctrl-C at a TTY prompt ends the input: the rest are not adjudicated.
        created.on("SIGINT", () => {
          info("");
          info("interrupted");
          created.close();
        });
      }
      if (queue.exhausted()) return Promise.resolve(null); // no answer is coming
      if (queue.isOpen()) {
        const live = rl as ReturnType<typeof createInterface>;
        live.setPrompt(q);
        live.prompt();
      } else {
        process.stdout.write(q); // closed with answers buffered: readline refuses prompt()
      }
      return queue.next();
    });

  let yesAll = false;
  let inputEnded = false;

  // BR-084: `finally`, not a trailing statement. `attempt` no longer throws, but
  // `ask` still can (a closed or erroring stdin), and the pre-BR-084 shape left
  // the readline interface — and with it the process's hold on stdin — open on
  // every throwing path. Cleanup belongs to the scope that created it.
  try {
    for (let i = 0; i < orphans.length; i++) {
      const o = orphans[i];
      const own = ownershipOf(o);
      if (yesAll && !ownsData(own)) { // TD-310: `all` never covers an owner
        attempt(o);
        continue;
      }
      if (inputEnded) {
        notAdjudicated(o);
        continue;
      }
      // TD-111: `[y/N/a/all]` are the accepted tokens (input is lowercased;
      // `yes-all` also works). TD-310: the counts are IN the prompt.
      const raw = await ask(
        `${o.slug} -> ${o.path}: orphan (${formatOwnership(own)}); delete? [y/N/a/all]: `,
      );
      if (raw === null) { // BR-087: end of input is not a decision
        inputEnded = true;
        notAdjudicated(o);
        continue;
      }
      const ans = raw.trim().toLowerCase();
      if (ans === "a") {
        info("aborted by user");
        for (const rest of orphans.slice(i)) notAdjudicated(rest);
        break;
      }
      if (ans === "y") {
        attempt(o);
      } else if (ans === "yes-all" || ans === "all") {
        yesAll = true;
        attempt(o);
      } else {
        declined.push(o.slug);
        info(`kept (declined): ${o.slug}`);
      }
    }
  } finally {
    // Close the readline interface only if we created it (i.e. production
    // path with no injected prompt). Tests pass their own prompt and have
    // nothing for us to clean up.
    if (rl !== null) {
      (rl as ReturnType<typeof createInterface>).close();
    }
  }
  return summarize();
}
