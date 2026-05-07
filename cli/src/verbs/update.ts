/**
 * `igris update [--all|--slug] [--self] [--dry-run]` — Phase 1 + M3.
 *
 * Default behavior (no --self):
 *   Loops over registered projects (or one slug), compares each project's
 *   `installed_features.json` hashes against current canonical hashes, and
 *   re-runs the install primitive when stale. Skips projects whose hashes
 *   already match, errors are reported per-project but don't abort the loop.
 *
 * --self (M3):
 *   Short-circuits the per-project loop and instead runs the global
 *   self-upgrade via `runSelfUpdate()` (npm install -g igris-ai@latest).
 *   --self is mutually exclusive with --all and --slug; if any of those
 *   are also passed, --self wins.
 *
 * --dry-run (M3):
 *   Enumerates would-update projects without invoking install. Same diff
 *   logic as a real run; just prints a summary and exits 0.
 */

import { existsSync } from "node:fs";
import { listProjects } from "../lib/registry.js";
import {
  computeFeatureHashes,
  readInstalledFeatures,
} from "../lib/installed-features.js";
import { runInstall } from "./install.js";
import { runSelfUpdate } from "../lib/self-update.js";
import { info, warn, error as logError } from "../lib/log.js";

export interface UpdateOptions {
  all: boolean;
  slug?: string;
  /** When true, run `npm install -g igris-ai@latest` instead of the per-project loop. */
  self?: boolean;
  /** When true, enumerate would-update projects without performing writes. */
  dryRun?: boolean;
}

interface UpdateRowResult {
  slug: string;
  outcome: "updated" | "skipped" | "errored" | "missing-path" | "would-update";
  reason?: string;
}

export async function runUpdate(opts: UpdateOptions): Promise<number> {
  // M3 — `--self` short-circuit. Runs before the --all/--slug gate because
  // self-upgrade has no per-project semantics; the user is upgrading the
  // global CLI binary, not anything in any registered project.
  if (opts.self === true) {
    return await runSelfUpdate();
  }

  if (!opts.all && opts.slug === undefined) {
    logError("update: pass --all or --slug <slug>");
    return 2;
  }

  const dryRun = opts.dryRun === true;
  const allRows = listProjects();
  const targets = opts.slug
    ? allRows.filter((r) => r.slug === opts.slug)
    : allRows;

  if (targets.length === 0) {
    if (opts.slug !== undefined) {
      logError(`no registry row for slug '${opts.slug}'`);
      return 1;
    }
    info("No registered projects.");
    return 0;
  }

  const results: UpdateRowResult[] = [];

  for (const row of targets) {
    if (!existsSync(row.path)) {
      results.push({
        slug: row.slug,
        outcome: "missing-path",
        reason: `path does not exist: ${row.path}`,
      });
      warn(
        `${row.slug}: path missing (${row.path}); skipped — use 'igris doctor --remove-orphans' to clean.`,
      );
      continue;
    }

    const features = readInstalledFeatures(row.slug);
    const previouslyInstalledHooks = features?.hooks_version !== null;
    const wantHooks = previouslyInstalledHooks || features === null;

    const currentHashes = computeFeatureHashes({ includeHooks: wantHooks });
    const upToDate =
      features !== null &&
      features.hooks_version === currentHashes.hooks_version &&
      features.agents_version === currentHashes.agents_version &&
      features.skills_version === currentHashes.skills_version &&
      features.rules_version === currentHashes.rules_version;

    if (upToDate) {
      results.push({ slug: row.slug, outcome: "skipped", reason: "up to date" });
      info(`${row.slug}: skip (up to date)`);
      continue;
    }

    if (dryRun) {
      // Plan-only: enumerate would-update without invoking install.
      results.push({
        slug: row.slug,
        outcome: "would-update",
        reason: "stale or no features file",
      });
      info(`${row.slug}: would update (stale or no features file) [dry-run]`);
      continue;
    }

    info(`${row.slug}: re-running install (stale or no features file)`);
    try {
      // skipSymlinkLayer=true: we trust the existing project install was correct;
      // update only refreshes the materialized layer (hooks + features file).
      const code = await runInstall({
        path: row.path,
        slug: row.slug,
        installHooks: wantHooks,
        skipSymlinkLayer: true,
      });
      if (code === 0) {
        results.push({ slug: row.slug, outcome: "updated" });
      } else {
        results.push({
          slug: row.slug,
          outcome: "errored",
          reason: `install returned exit ${code}`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ slug: row.slug, outcome: "errored", reason: msg });
      logError(`${row.slug}: ${msg}`);
    }
  }

  info("");
  info(dryRun ? "Update plan (dry-run):" : "Update summary:");
  let updated = 0;
  let skipped = 0;
  let errored = 0;
  let missing = 0;
  let wouldUpdate = 0;
  for (const r of results) {
    if (r.outcome === "updated") updated++;
    else if (r.outcome === "skipped") skipped++;
    else if (r.outcome === "errored") errored++;
    else if (r.outcome === "missing-path") missing++;
    else if (r.outcome === "would-update") wouldUpdate++;
  }
  if (dryRun) {
    info(`  would-update: ${wouldUpdate}`);
    info(`  skipped:      ${skipped}`);
    info(`  missing:      ${missing}`);
    info("");
    info("No filesystem writes were performed.");
  } else {
    info(`  updated: ${updated}`);
    info(`  skipped: ${skipped}`);
    info(`  errored: ${errored}`);
    info(`  missing: ${missing}`);
  }

  return errored > 0 ? 1 : 0;
}
