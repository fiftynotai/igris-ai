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
 *
 * Per-project:
 *   path-missing            → orphan (registry row points at deleted dir)
 *   not-installed           → path exists but .claude/ missing
 *   hooks-missing           → settings.json present but lacks SessionEnd Igris hook
 *                             (the TD-100 silent-failure class)
 *   hooks-stale             → settings.json has Igris hooks but their hash differs
 *   channel-mismatch        → installed_features.json#cli_version newer than current CLI
 *   slug-basename-mismatch  → row.slug !== basename(row.path)  (informational)
 *   duplicate-path          → multiple slugs with the same realpath (fifty_eco_system)
 *   symlink-target          → row.path is itself a symlink
 *   clean                   → none of the above
 *
 * Precedence (high → low): path-missing → brain-core-missing → brain-core-stale →
 * channel-mismatch → bridge-missing → mcp-unregistered → secret-perms →
 * duplicate-path → not-installed → hooks-missing → hooks-stale → symlink-target →
 * slug-basename-mismatch → clean.
 * (mcp-unregistered + secret-perms sit next to bridge-missing — all brain-level,
 *  config-driven, and orthogonal to core state.)
 *
 * --fix repairs not-installed / hooks-missing / hooks-stale by re-running install,
 * brain-core-missing by invoking runRefresh(), bridge-missing by invoking
 * partial-mode runInit({ upgrade: true }), mcp-unregistered by calling
 * registerBrainAcrossHarnesses() directly to backfill all 4 harnesses (FR-169;
 * cheap — no need to re-run init), secret-perms by chmod'ing the flagged file
 * to 600 (TD-220; both Igris-owned and harness-owned under the explicit flag —
 * a git-tracked file stays flagged since chmod can't untrack it).
 * --remove-orphans deletes path-missing rows after per-row confirmation
 * (skip prompt with --yes).
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import {
  listProjects,
  deleteProjectRow,
} from "../lib/registry.js";
import {
  computeFeatureHashes,
} from "../lib/installed-features.js";
import {
  claudeJsonPath,
  codexConfigTomlPath,
  configJsonPath,
  geminiSettingsPath,
  opencodeConfigPath,
  projectSettingsPath,
  registryOverlayPath,
  secretsEnvPath,
} from "../lib/paths.js";
import { extractVarName, parseSecretsEnv } from "../lib/secrets.js";
import {
  checkSecretFilePerms,
  chmodSecretFile,
} from "../lib/secret-perms.js";
import {
  inspectMcpRegistration,
  registerBrainAcrossHarnesses,
} from "../lib/mcp-register.js";
import { runInstall } from "./install.js";
import { runRefresh } from "./refresh.js";
import { runInit } from "./init.js";
import { detectBrainCoreMissing } from "../lib/drift/brain-core-missing.js";
import { detectBrainCoreStale } from "../lib/drift/brain-core-stale.js";
import { detectChannelMismatch } from "../lib/drift/channel-mismatch.js";
import { detectBridgeMissing } from "../lib/drift/bridge-missing.js";
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

  // TD-220: in the read pass (no --fix), the 4 harness configs are harness-
  // owned — Igris WARNs but does NOT auto-tighten them ("don't fight the
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
  }

  let errored = 0;
  // TD-122: bridge-missing fix is invocation-bounded — a single partial
  // init resolves all bridge-missing rows in one pass. We track this
  // flag so subsequent bridge-missing rows skip re-invocation, but DO
  // NOT `break` the loop: that would skip per-project drift classes
  // (not-installed / hooks-* / brain-core-missing) that come after
  // bridge-missing in `drift`.
  let bridgeFixApplied = false;

  if (opts.fix) {
    for (const row of drift) {
      if (
        row.driftClass === "not-installed" ||
        row.driftClass === "hooks-missing" ||
        row.driftClass === "hooks-stale"
      ) {
        info(`fix: re-running install for ${row.slug}`);
        try {
          const code = await runInstall({
            path: row.path,
            slug: row.slug,
            installHooks: true,
            skipSymlinkLayer: row.driftClass !== "not-installed",
          });
          if (code !== 0) {
            errored++;
            logError(`${row.slug}: fix returned exit ${code}`);
          }
        } catch (err) {
          errored++;
          const msg = err instanceof Error ? err.message : String(err);
          logError(`${row.slug}: ${msg}`);
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
        // we MUST NOT `break` the outer loop, because per-project drift
        // classes (not-installed / hooks-* / brain-core-missing) may
        // still be waiting after the bridge-missing block.
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
        // FR-169: register the bundled igris-brain MCP into ALL 4 harnesses
        // directly (Claude, Gemini, Codex, OpenCode). Cheap — no need to
        // re-run init. registerBrainAcrossHarnesses never throws; a per-harness
        // failed outcome counts into `errored`. (Detection is still
        // Claude-only via inspectMcpRegistration — the trigger fires on
        // Claude, the fix backfills all 4. Broadening detection to all 4
        // harnesses is a tracked FR-169 follow-up.)
        info("fix: mcp-unregistered — registering igris-brain MCP in all 4 harnesses");
        const results = registerBrainAcrossHarnesses();
        for (const { harness, result } of results) {
          if (result.outcome === "failed") {
            errored++;
            logError(`mcp-unregistered fix (${harness}): ${result.error}`);
          } else {
            info(`  igris-brain MCP ${result.outcome} for ${harness} -> ${result.mcpEntryPath}`);
          }
        }
      } else if (row.driftClass === "secret-perms") {
        // TD-220: the actual chmod runs in the FINAL re-harden pass below
        // (after the fix loop) — NOT here. Rationale: an mcp-unregistered /
        // not-installed fix earlier or later in this same loop re-writes a
        // harness config via tmp+renameSync, which adopts the umask-default
        // mode (644) and re-loosens it (Risk R1). Chmod'ing in-loop would
        // race that rewrite. Deferring to a post-loop pass makes the chmod
        // ordering-independent WITHOUT touching the FR-162/163 mergers
        // (R1 stays a deferred follow-up). Here we only announce intent.
        const owner = isIgrisOwnedSecretFile(row.path)
          ? "Igris-owned"
          : "harness-owned";
        info(`fix: secret-perms (${owner}) — will chmod 600 ${row.path}`);
      } else if (
        row.driftClass === "slug-basename-mismatch" ||
        row.driftClass === "duplicate-path" ||
        row.driftClass === "channel-mismatch" ||
        row.driftClass === "brain-core-stale"
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

  if (opts.removeOrphans) {
    const orphans = drift.filter((r) => r.driftClass === "path-missing");
    if (orphans.length === 0) {
      info("No orphans to remove.");
    } else {
      const removed = await confirmAndRemoveOrphans(orphans, opts.yes);
      info(`Removed ${removed} orphan registry row(s).`);
    }
  }

  // Exit code: 0 if all clean, 1 if any non-clean drift remains, 1 on fix errors.
  const nonCleanRemaining = drift.some((r) => {
    if (r.driftClass === "clean") return false;
    // After --remove-orphans, path-missing is conceptually resolved.
    if (opts.removeOrphans && r.driftClass === "path-missing") return false;
    if (opts.fix) {
      // After --fix, the auto-fixable classes are conceptually resolved (best-effort).
      if (
        r.driftClass === "not-installed" ||
        r.driftClass === "hooks-missing" ||
        r.driftClass === "hooks-stale" ||
        r.driftClass === "brain-core-missing" ||
        r.driftClass === "bridge-missing" ||
        r.driftClass === "mcp-unregistered"
      ) {
        return false;
      }
      // TD-220: a secret-perms row is resolved by --fix ONLY if the post-fix
      // verdict is "ok". A git-tracked row stays flagged (chmod can't untrack)
      // — re-check the live verdict rather than assuming chmod cleared it.
      if (r.driftClass === "secret-perms") {
        return checkSecretFilePerms(r.path) !== "ok";
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

  // secret-perms (TD-220): brain-level, config-driven, sits next to
  // mcp-unregistered (lowest brain-level precedence). Flags Igris-owned
  // config.json/secrets.env + the 4 harness configs when their perms are
  // group/world-readable or they are git-tracked.
  for (const sp of detectSecretFilePerms()) out.push(sp);

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
 * per registry row in the same order the registry returned them. Detects:
 *
 * - path-missing: !existsSync(row.path)
 * - duplicate-path: any other row whose realpath(row.path) is identical to this one's
 * - not-installed: path exists but .claude/ missing
 * - hooks-missing: settings.json exists but no SessionEnd Igris hook
 * - hooks-stale: settings.json has Igris hooks but their hash differs from canonical
 * - slug-basename-mismatch: row.slug !== basename(row.path)
 * - symlink-target: row.path is a symlink (lstat says symlink)
 * - clean: none of the above
 *
 * Precedence: path-missing > duplicate-path > not-installed > hooks-missing
 *           > hooks-stale > symlink-target > slug-basename-mismatch > clean.
 * (path-missing wins because if the path is gone, hooks-* and not-installed are vacuous.)
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
  let canonicalHashes: ReturnType<typeof computeFeatureHashes> | null = null;
  try {
    canonicalHashes = computeFeatureHashes({ includeHooks: true });
  } catch {
    canonicalHashes = null;
  }

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

    const claudeDir = `${r.path}/.claude`;
    if (!existsSync(claudeDir)) {
      out.push({
        slug: r.slug,
        path: r.path,
        driftClass: "not-installed",
        recommendedFix: "run 'igris install <path>' or 'igris doctor --fix'",
        resolvedPath,
      });
      continue;
    }

    const settings = projectSettingsPath(r.path);
    const settingsState = inspectSettings(settings);
    if (settingsState === "hooks-missing") {
      out.push({
        slug: r.slug,
        path: r.path,
        driftClass: "hooks-missing",
        recommendedFix: "run 'igris install <path>' or 'igris doctor --fix'",
        resolvedPath,
      });
      continue;
    }

    if (settingsState === "hooks-present") {
      // Compare against canonical hash; if different, mark stale.
      // We compute the hash by reading just the hooks section out of settings.json
      // and comparing against canonical. For Phase 1, "stale" means the Igris-owned
      // SessionEnd command is present but its hash diverges from the canonical file.
      if (canonicalHashes !== null) {
        const sessionEndCmd = extractSessionEndCommand(settings);
        const canonicalCmd = "$HOME/.igris/core/hooks/shared/session_end.sh";
        if (sessionEndCmd !== null && sessionEndCmd !== canonicalCmd) {
          out.push({
            slug: r.slug,
            path: r.path,
            driftClass: "hooks-stale",
            recommendedFix: "run 'igris doctor --fix' to refresh hooks",
            resolvedPath,
          });
          continue;
        }
      }
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
 * the 4 harness configs into `secret-perms` drift rows. A row is emitted
 * ONLY when the verdict is not "ok" (loose group/other bits, or git-tracked,
 * or both). Absent files and win32 produce "ok" (no row) — see
 * checkSecretFilePerms (never throws).
 *
 * NOTE (Risk R1 — atomic-rename re-loosens harness configs): the FR-162/163
 * mergers in mcp-register.ts write via tmp+renameSync, which adopts the
 * tmp file's umask mode (often 644). So every MCP re-registration re-loosens
 * a harness config — which is exactly why the 4 harness configs are
 * warn/--fix-only (Decision 5) rather than proactively tightened. The clean
 * fix (chmod 600 after the rename inside the mergers) is a DEFERRED follow-up,
 * NOT TD-220 — keeping TD-220 off the FR-162/163 splice path.
 */
function detectSecretFilePerms(): DriftRow[] {
  const out: DriftRow[] = [];
  const igrisOwned = igrisOwnedSecretFiles();
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
    const overlayPath = registryOverlayPath();
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
 * Interactive orphan confirmation flow. Exported for vitest stdin-fixture
 * tests (TD-111): tests inject a synthetic `prompt` function so they can
 * exercise the `[y/N/a/all]` decision tree without monkey-patching
 * `process.stdin` or fighting readline's per-question listener race.
 *
 * @param prompt  Optional async function that returns the user's answer for
 *                a given prompt string. Defaults to a `readline`-backed
 *                prompt reading `process.stdin` for the production path.
 */
export async function confirmAndRemoveOrphans(
  orphans: DriftRow[],
  skipPrompt: boolean,
  prompt?: PromptFn,
): Promise<number> {
  if (skipPrompt) {
    let n = 0;
    for (const o of orphans) {
      deleteProjectRow(o.slug);
      info(`removed: ${o.slug}`);
      n++;
    }
    return n;
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
  let removed = 0;

  for (const o of orphans) {
    if (yesAll) {
      deleteProjectRow(o.slug);
      info(`removed: ${o.slug}`);
      removed++;
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
      deleteProjectRow(o.slug);
      info(`removed: ${o.slug}`);
      removed++;
    } else if (ans === "yes-all" || ans === "all") {
      yesAll = true;
      deleteProjectRow(o.slug);
      info(`removed: ${o.slug}`);
      removed++;
    } else {
      info(`kept: ${o.slug}`);
    }
  }

  // Close the readline interface only if we created it (i.e. production
  // path with no injected prompt). Tests pass their own prompt and have
  // nothing for us to clean up.
  if (rl !== null) {
    (rl as ReturnType<typeof createInterface>).close();
  }
  return removed;
}
