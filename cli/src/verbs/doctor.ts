/**
 * `igris doctor [--fix] [--remove-orphans] [--yes]` — Phase 1+M5.
 *
 * Read-only by default: walks the registry and classifies every row into a
 * `DriftRow` (see types.ts). Drift classes:
 *
 * Brain-level (synthetic slug "(brain)"):
 *   brain-core-missing      → ~/.igris/core/ absent or empty
 *   brain-core-stale        → ~/.igris/core/ content hash diverges from channel head
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
 *   machine-identity        → (informational, BR-100) hostname outside the minted
 *                             identity's aliases, or NULL-id rows under names the
 *                             aliases do not cover; never --fix'able (an alias is
 *                             an operator claim); lowest brain-level precedence.
 *
 * Per-project:
 *   path-missing            → orphan (registry row points at deleted dir)
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
 * Precedence (high → low): path-missing → brain-core-missing → brain-core-stale →
 * channel-mismatch → bridge-missing → mcp-unregistered → hooks-missing →
 * hooks-stale → secret-perms → skills-pollution → duplicate-path →
 * symlink-target → slug-basename-mismatch → clean.
 * (mcp-unregistered + hooks-missing/hooks-stale + secret-perms + skills-pollution
 *  sit next to bridge-missing — all brain-level, config/state-driven, and
 *  orthogonal to core state. skills-pollution is lowest brain-level precedence
 *  — TD-223.)
 *
 * --fix repairs hooks-missing / hooks-stale by re-merging the GLOBAL Igris hooks
 * (`mergeGlobalCanonicalHooks` — a single brain-level action, no per-project
 * re-install), brain-core-missing by invoking runRefresh(), bridge-missing by
 * invoking partial-mode runInit({ upgrade: true }), mcp-unregistered by calling
 * registerBrainAcrossHarnesses() directly to backfill all Igris harnesses (FR-169;
 * cheap — no need to re-run init), secret-perms by chmod'ing the flagged file
 * to 600 (TD-220; both Igris-owned and harness-owned under the explicit flag —
 * a git-tracked file stays flagged since chmod can't untrack it),
 * skills-pollution by migrating each legacy whole-dir surface root into a REAL
 * dir of per-item symlinks (direct-materialize from the canonical source +
 * personal overlay — NEVER a compile, which would lose every skill + core
 * agent) and cleaning each stray projection symlink leaked into the canonical
 * source (TD-223 RE-SCOPED; backup-not-delete the old root symlink, atomic
 * rename, realpath-contained, refuse-on-unexpected-target, idempotent — a stray
 * that is not a loadout projection stays flagged for manual resolution; --fix
 * prints the before/after enumeration as the no-loss proof).
 * --remove-orphans deletes path-missing rows after per-row confirmation
 * (skip prompt with --yes). A row the brain still references — a project with
 * briefs or sessions — cannot be deleted without orphaning that history, so it
 * is SKIPPED and reported per project and the sweep continues (BR-084); a
 * skipped row is still drift, so the verb exits 1.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  listProjects,
  deleteProjectRow,
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
import { runRefresh } from "./refresh.js";
import { runInit } from "./init.js";
import { detectBrainCoreMissing } from "../lib/drift/brain-core-missing.js";
import { detectBrainCoreStale } from "../lib/drift/brain-core-stale.js";
import { detectChannelMismatch } from "../lib/drift/channel-mismatch.js";
import { detectBridgeMissing } from "../lib/drift/bridge-missing.js";
import { detectAntigravitySkillsLink } from "../lib/drift/antigravity-skills-link.js";
import { linkAntigravitySkills } from "../lib/antigravity-skills.js";
import { readMachineIdentity } from "../lib/machine-identity.js";
import { readConfig } from "../lib/init-config.js";
import { readUnattributedHostnames } from "../lib/brain-db.js";
import { info, warn, error as logError } from "../lib/log.js";
import type { DriftRow, RegistryRow } from "../types.js";

export interface DoctorOptions {
  fix: boolean;
  removeOrphans: boolean;
  yes: boolean;
}

export async function runDoctor(opts: DoctorOptions): Promise<number> {
  const rows = listProjects();
  const drift = await classifyDriftAll(rows);

  printDriftTable(drift);

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

  let errored = 0;
  // TD-122: bridge-missing fix is invocation-bounded — a single partial
  // init resolves all bridge-missing rows in one pass. We track this
  // flag so subsequent bridge-missing rows skip re-invocation, but DO
  // NOT `break` the loop: that would skip other drift classes
  // (hooks-missing / hooks-stale / brain-core-missing / secret-perms /
  // skills-pollution) that come after bridge-missing in `drift`.
  let bridgeFixApplied = false;
  // TD-223: skills-pollution emits a single brain-level row, but guard against
  // a repeated convert pass defensively (mirrors bridgeFixApplied).
  let skillsPollutionFixApplied = false;

  // FR-212d: hooks are global now (ONE block), so the hooks-missing/hooks-stale
  // fix — re-merging `~/.claude/settings.json` — is a single brain-level action.
  // Guard against re-running it per (brain) row defensively (there is only one).
  let globalHooksFixApplied = false;

  if (opts.fix) {
    for (const row of drift) {
      if (
        row.driftClass === "hooks-missing" ||
        row.driftClass === "hooks-stale"
      ) {
        // FR-212d Phase 2: the per-project hooks layer was retired — hooks live
        // in ONE global `~/.claude/settings.json` block. The fix is GLOBAL-only:
        // re-merge the canonical Igris hooks (idempotent + no-clobber +
        // never-throws). There is no per-project materialization to re-run, so
        // this is NOT a per-project re-install — the row is brain-level.
        if (globalHooksFixApplied) {
          continue;
        }
        globalHooksFixApplied = true;
        info("fix: hooks-missing/stale — refreshing the GLOBAL Igris hooks (~/.claude/settings.json)");
        const gh = mergeGlobalCanonicalHooks();
        if (gh.outcome === "failed") {
          errored++;
          logError(`global hooks refresh failed: ${gh.error}`);
        } else {
          info(`  global Igris hooks ${gh.outcome} -> ${gh.path}`);
        }
      } else if (row.driftClass === "brain-core-missing") {
        info(`fix: brain-core-missing — invoking 'igris refresh'`);
        try {
          const code = await runRefresh({});
          if (code !== 0) {
            errored++;
            logError(`brain-core-missing fix: refresh returned exit ${code}`);
          }
        } catch (err) {
          errored++;
          const msg = err instanceof Error ? err.message : String(err);
          logError(`brain-core-missing fix: ${msg}`);
        }
      } else if (row.driftClass === "bridge-missing") {
        // TD-122: a single partial-init resolves all bridge-missing rows
        // in one pass. Subsequent rows are skipped via the flag — but
        // we MUST NOT `break` the outer loop, because other drift classes
        // (hooks-missing / hooks-stale / brain-core-missing / secret-perms /
        // skills-pollution) may still be waiting after the bridge-missing block.
        if (bridgeFixApplied) {
          continue;
        }
        info(`fix: bridge-missing for ${row.path} — invoking partial init (--upgrade)`);
        try {
          // Partial init in upgrade mode re-runs the bridge materialization
          // pass against the current detected set, leaving core/ untouched
          // (atomic-extract is a no-op on identical content). User state
          // (knowledge.db, USER.md, config.json) is preserved by --upgrade.
          const code = await runInit({ upgrade: true, yes: true });
          if (code !== 0) {
            errored++;
            logError(`bridge-missing fix: init returned exit ${code}`);
          }
          bridgeFixApplied = true;
        } catch (err) {
          errored++;
          const msg = err instanceof Error ? err.message : String(err);
          logError(`bridge-missing fix: ${msg}`);
          // Even on error, mark applied so subsequent bridge-missing rows
          // don't re-attempt (init already errored once; re-running won't
          // help and may compound state damage).
          bridgeFixApplied = true;
        }
      } else if (row.driftClass === "mcp-unregistered") {
        // FR-169: register the bundled igris-brain MCP into every descriptor
        // harness directly (the set is descriptor-driven via harnessIds()). Cheap
        // — no need to re-run init. registerBrainAcrossHarnesses never throws; a
        // per-harness failed outcome counts into `errored`. (Detection is still
        // Claude-only via inspectMcpRegistration — the trigger fires on Claude,
        // the fix backfills all harnesses. Broadening detection to all harnesses
        // is a tracked FR-169 follow-up.)
        info("fix: mcp-unregistered — registering igris-brain MCP across all Igris harnesses");
        // FR-212d: doctor backfills the brain MCP via the IN-PROCESS custom
        // merger (deterministic, no `add-mcp` subprocess — same robust posture as
        // `igris init`). The harness-COMPILE projection delegates; this fix does
        // not.
        const results = registerBrainAcrossHarnesses(undefined, {
          engine: "custom",
        });
        for (const { harness, result } of results) {
          if (result.outcome === "failed") {
            errored++;
            logError(`mcp-unregistered fix (${harness}): ${result.error}`);
          } else {
            info(`  igris-brain MCP ${result.outcome} for ${harness} -> ${result.mcpEntryPath}`);
          }
        }
      } else if (row.driftClass === "antigravity-skills-link") {
        // FR-179 Phase C (R2): create-or-repoint the antigravity skills parent
        // symlink directly (the same idempotent-repair install runs — cheap, no
        // need to re-run init). linkAntigravitySkills never throws; a refused
        // (real non-empty dir) or failed outcome counts into `errored` and the
        // row stays non-clean for manual resolution.
        info(
          "fix: antigravity-skills-link — linking ~/.gemini/antigravity-cli/skills -> ~/.agents/skills",
        );
        const link = linkAntigravitySkills();
        if (link.outcome === "refused" || link.outcome === "failed") {
          errored++;
          logError(`antigravity-skills-link fix: ${link.error}`);
        } else {
          info(`  antigravity skills link ${link.outcome} -> ${link.target}`);
        }
      } else if (row.driftClass === "secret-perms") {
        // TD-220: the actual chmod runs in the FINAL re-harden pass below
        // (after the fix loop) — NOT here. Rationale: an mcp-unregistered fix
        // earlier or later in this same loop re-writes a harness config via
        // tmp+renameSync, which adopts the umask-default mode (644) and
        // re-loosens it (Risk R1). Chmod'ing in-loop would race that rewrite.
        // Deferring to a post-loop pass makes the chmod ordering-independent
        // WITHOUT touching the FR-162/163 mergers (R1 stays a deferred
        // follow-up). Here we only announce intent.
        const owner = isIgrisOwnedSecretFile(row.path)
          ? "Igris-owned"
          : "harness-owned";
        info(`fix: secret-perms (${owner}) — will chmod 600 ${row.path}`);
      } else if (row.driftClass === "skills-pollution") {
        // TD-223 (RE-SCOPED): migrate each legacy whole-dir surface root into a
        // REAL dir of per-item symlinks (direct-materialize — never compile),
        // then clean the stray projection symlinks leaked into the canonical
        // source. The migrator backs up the old root symlink (rename, never rm),
        // realpath-contains every mutation, and refuses an unexpected target.
        // The before/after enumeration is PRINTED as the no-loss proof. A stray
        // that is not a loadout projection is left untouched (manual review).
        // There is ONE skills-pollution row, so guard against a repeated pass.
        if (skillsPollutionFixApplied) {
          continue;
        }
        skillsPollutionFixApplied = true;
        errored += fixSkillsPollution();
      } else if (
        row.driftClass === "slug-basename-mismatch" ||
        row.driftClass === "duplicate-path" ||
        row.driftClass === "channel-mismatch" ||
        row.driftClass === "brain-core-stale" ||
        row.driftClass === "machine-identity"
      ) {
        warn(
          `${row.slug}: ${row.driftClass} — ${row.recommendedFix}`,
        );
      }
    }

    // TD-220: FINAL re-harden pass — chmod 600 every flagged secret file AFTER
    // all other fixes have run, so an install/MCP rewrite earlier in this loop
    // (tmp+renameSync re-loosens to 644 — Risk R1) is corrected last. Pure
    // doctor-side, never touches mcp-register.ts. chmod fixes the loose-bit
    // dimension only — a git-tracked file stays flagged (chmod can't untrack).
    for (const row of drift) {
      if (row.driftClass !== "secret-perms") continue;
      const ok = chmodSecretFile(row.path);
      const verdict = checkSecretFilePerms(row.path);
      // A failed chmod on a still-flagged present file is an error; a no-op on
      // an absent/win32 file is NOT (it would already be "ok" and unflagged).
      if (!ok && verdict !== "ok") {
        errored++;
        logError(`secret-perms fix: could not chmod 600 ${row.path}`);
      } else if (verdict !== "ok") {
        // chmod succeeded (or was a no-op) but the file is still flagged —
        // i.e. git-tracked, which chmod cannot untrack.
        warn(
          `${row.path}: still flagged after --fix (git-tracked secret cannot ` +
            `be untracked by chmod — remove it from git).`,
        );
      }
    }
  }

  // BR-084: slugs whose delete the DB REFUSED (still referenced). They are the
  // one class of path-missing row that --remove-orphans does NOT resolve, so
  // they must not be discounted from the exit code below.
  const skippedOrphans = new Set<string>();

  if (opts.removeOrphans) {
    const orphans = drift.filter((r) => r.driftClass === "path-missing");
    if (orphans.length === 0) {
      info("No orphans to remove.");
    } else {
      const sweep = await confirmAndRemoveOrphans(orphans, opts.yes);
      info(`Removed ${sweep.removed} orphan registry row(s).`);
      if (sweep.skipped > 0) {
        for (const r of sweep.results) {
          if (!r.ok) skippedOrphans.add(r.slug);
        }
        // Names the slugs rather than saying "see above": the per-row reasons go
        // to stderr and this line to stdout, so the two can be redirected apart.
        info(
          `Skipped ${sweep.skipped} orphan registry row(s) still referenced by ` +
            `brain rows: ${[...skippedOrphans].join(", ")}. The sweep completed ` +
            `for the rest; each skip's blocking count is in the warnings.`,
        );
      }
    }
  }

  // Exit code: 0 if all clean, 1 if any non-clean drift remains, 1 on fix errors.
  const nonCleanRemaining = drift.some((r) => {
    if (r.driftClass === "clean") return false;
    // After --remove-orphans, path-missing is conceptually resolved — EXCEPT
    // for a row the DB refused to delete (BR-084). That registry row is still
    // there and still drifted, so exiting 0 would be the silent pass-over the
    // per-project reporting exists to prevent.
    //
    // THAT EXCEPTION IS NOT EXHAUSTIVE, AND THIS PREDICATE IS NOT YET HONEST.
    // Three more cases leave a drifted row alive and still return false here,
    // because `attempt` never ran so the slug never entered `skippedOrphans`:
    // the operator answers `n`, the operator aborts with `a`, and piped stdin
    // runs dry (the second `question` never resolves, so the sweep stops after
    // one answer). All three were measured at exit 0 with the row surviving,
    // in BOTH the pre- and post-BR-084 builds — they are pre-existing, and
    // BR-084 narrowed the discount rather than widening it. BR-087 owns them,
    // and its structural fix is to derive this from a RE-READ of the registry
    // rather than from the sweep's own report — which is what the
    // `hooks-missing` branch below already does ("re-check rather than
    // assume"). Until then, read this as "the DB-refusal case is honest", not
    // "the exit code is".
    if (opts.removeOrphans && r.driftClass === "path-missing") {
      return skippedOrphans.has(r.slug);
    }
    if (opts.fix) {
      // After --fix, the auto-fixable classes are conceptually resolved (best-effort).
      if (
        r.driftClass === "brain-core-missing" ||
        r.driftClass === "bridge-missing" ||
        r.driftClass === "mcp-unregistered"
      ) {
        return false;
      }
      // FR-212d: a hooks-missing/hooks-stale row resolves ONLY if a LIVE re-probe
      // of the GLOBAL `~/.claude/settings.json` now finds the canonical Igris
      // hooks present. A failed global-hooks merge (malformed/unwritable target)
      // keeps the row non-clean (exit 1) — re-check rather than assume.
      if (r.driftClass === "hooks-missing" || r.driftClass === "hooks-stale") {
        return detectGlobalHooksDrift() !== null;
      }
      // TD-220: a secret-perms row is resolved by --fix ONLY if the post-fix
      // verdict is "ok". A git-tracked row stays flagged (chmod can't untrack)
      // — re-check the live verdict rather than assuming chmod cleared it.
      if (r.driftClass === "secret-perms") {
        return checkSecretFilePerms(r.path) !== "ok";
      }
      // TD-223 (RE-SCOPED): a skills-pollution row resolves to clean ONLY if a
      // LIVE re-classification finds NO surface root still in the migration
      // condition (or an unexpected-target symlink) AND no removable stray
      // projection symlink remains (re-probe — don't assume --fix cleared
      // everything). An unexpected-target root or a non-projection stray is
      // never auto-fixed, so it keeps the row non-clean (exit 1) until resolved
      // manually.
      if (r.driftClass === "skills-pollution") {
        const post = classifyMigration();
        // Any remaining migration condition, unexpected-target symlink, OR stray
        // projection symlink in the canonical source keeps the row non-clean.
        return (
          post.toMigrate.length > 0 ||
          post.unexpected.length > 0 ||
          post.strays.length > 0
        );
      }
      // FR-179 Phase C: an antigravity-skills-link row resolves ONLY if a LIVE
      // re-probe finds the link now correct. A refused real-non-empty-dir stays
      // flagged (--fix never clobbered it) → keeps the row non-clean (exit 1).
      if (r.driftClass === "antigravity-skills-link") {
        return detectAntigravitySkillsLink() !== null;
      }
    }
    return true;
  });

  if (errored > 0) return 1;
  return nonCleanRemaining ? 1 : 0;
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
 * - path-missing: !existsSync(row.path) — the registry row points at a deleted
 *                 dir (the one genuinely-broken state a register-only project
 *                 can still be in). Resolved via --remove-orphans.
 * - duplicate-path: any other row whose realpath(row.path) is identical.
 * - slug-basename-mismatch: row.slug !== basename(row.path) (informational).
 * - symlink-target: row.path is a symlink (informational).
 * - clean: registered + path exists (the register-only happy path).
 *
 * Precedence: path-missing > duplicate-path > slug-basename-mismatch >
 *             symlink-target > clean.
 * (path-missing wins because if the path is gone, everything else is vacuous.)
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
      out.push({
        slug: r.slug,
        path: r.path,
        driftClass: "path-missing",
        recommendedFix: "run 'igris doctor --remove-orphans' to delete this row",
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
  info(`Drift report: ${drift.length} project(s), ${cleanCount} clean`);
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
 * user's answer (NOT trimmed/lowercased — caller normalizes). Used as the
 * test seam in confirmAndRemoveOrphans so vitest can inject a queue-backed
 * fake without battling Node's readline event timing (TD-111).
 */
export type PromptFn = (question: string) => Promise<string>;

/**
 * What one `--remove-orphans` sweep did. Per-project, never per-batch (BR-084).
 *
 * `results` carries one entry per ATTEMPTED delete, in sweep order — a row the
 * user declined (`n`) or one never reached (`a`) is not an attempt and does not
 * appear. `removed + skipped === results.length` by construction.
 */
export interface OrphanSweepResult {
  removed: number;
  /** Attempts the DB refused. Each carries its reason in `results`. */
  skipped: number;
  results: DeleteProjectOutcome[];
}

/**
 * Interactive orphan confirmation flow. Exported for vitest stdin-fixture
 * tests (TD-111): tests inject a synthetic `prompt` function so they can
 * exercise the `[y/N/a/all]` decision tree without monkey-patching
 * `process.stdin` or fighting readline's per-question listener race.
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
 *     (TD-328), not inside a registry sweep.
 *
 * Skip-and-report is also the only option that leaves the operator's next move
 * intact: the row is still there to delete deliberately once the briefs are
 * dealt with. So the sweep's failure mode is "one row survives, loudly", not
 * "history is gone, quietly" — and NOT (as before BR-084) "every other orphan
 * survives too, because the first refusal threw".
 *
 * @param prompt  Optional async function that returns the user's answer for
 *                a given prompt string. Defaults to a `readline`-backed
 *                prompt reading `process.stdin` for the production path.
 */
export async function confirmAndRemoveOrphans(
  orphans: DriftRow[],
  skipPrompt: boolean,
  prompt?: PromptFn,
): Promise<OrphanSweepResult> {
  const results: DeleteProjectOutcome[] = [];

  // The ONLY route to deleteProjectRow in this function — one guard rather than
  // four. NB this closure constrains nothing outside this function, and since
  // BR-084 made deleteProjectRow NON-THROWING, a new caller that drops the
  // returned outcome compiles clean and fails SILENTLY (pre-BR-084 it crashed).
  // So the "only route" is pinned by a source scan in registry.test.ts, not by
  // this comment — a claim of the form "there is only one X" needs a mechanism,
  // which is the FR-247 / FR-240 precedent in this repo.
  const attempt = (o: DriftRow): void => {
    const outcome = deleteProjectRow(o.slug);
    results.push(outcome);
    if (outcome.ok) {
      info(`removed: ${o.slug}`);
    } else {
      warn(`skipped: ${o.slug} — ${outcome.error ?? "unknown reason"}`);
    }
  };
  const summarize = (): OrphanSweepResult => ({
    removed: results.filter((r) => r.ok).length,
    skipped: results.filter((r) => !r.ok).length,
    results,
  });

  if (skipPrompt) {
    for (const o of orphans) attempt(o);
    return summarize();
  }

  // Production prompt: spin up a readline interface against process.stdin.
  // Tests bypass this entirely by passing their own prompt function.
  let rl: ReturnType<typeof createInterface> | null = null;
  const ask: PromptFn =
    prompt ??
    ((q: string): Promise<string> => {
      if (rl === null) {
        rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
      }
      return new Promise((res) => rl!.question(q, (a) => res(a)));
    });

  let yesAll = false;

  // BR-084: `finally`, not a trailing statement. `attempt` no longer throws, but
  // `ask` still can (a closed or erroring stdin), and the pre-BR-084 shape left
  // the readline interface — and with it the process's hold on stdin — open on
  // every throwing path. Cleanup belongs to the scope that created it.
  try {
    for (const o of orphans) {
      if (yesAll) {
        attempt(o);
        continue;
      }
      // TD-111: prompt label was `[y/N/a/Y/A]` but the handler always lowercases
      // the input, so `Y`/`A` were never reachable as distinct shortcuts (they
      // collapsed to `y`/`a` and re-prompted on the next orphan). Relabel to
      // `[y/N/a/all]` to match the actual accepted tokens. Behavior unchanged:
      // the handler still accepts `y`, `n`, `a`, `all`, and `yes-all`.
      const ans = (await ask(`${o.slug} -> ${o.path}: orphan; delete? [y/N/a/all]: `))
        .trim()
        .toLowerCase();
      if (ans === "a") {
        info("aborted by user");
        break;
      }
      if (ans === "y") {
        attempt(o);
      } else if (ans === "yes-all" || ans === "all") {
        yesAll = true;
        attempt(o);
      } else {
        info(`kept: ${o.slug}`);
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
