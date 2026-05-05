/**
 * `igris update [--all|--slug]` — Phase 1.
 *
 * Loops over registered projects (or one slug), compares each project's
 * `installed_features.json` hashes against current canonical hashes, and
 * re-runs the install primitive when stale. Skips projects whose hashes
 * already match, errors are reported per-project but don't abort the loop.
 */

import { existsSync } from "node:fs";
import { listProjects } from "../lib/registry.js";
import {
  computeFeatureHashes,
  readInstalledFeatures,
} from "../lib/installed-features.js";
import { runInstall } from "./install.js";
import { info, warn, error as logError } from "../lib/log.js";

export interface UpdateOptions {
  all: boolean;
  slug?: string;
}

interface UpdateRowResult {
  slug: string;
  outcome: "updated" | "skipped" | "errored" | "missing-path";
  reason?: string;
}

export async function runUpdate(opts: UpdateOptions): Promise<number> {
  if (!opts.all && opts.slug === undefined) {
    logError("update: pass --all or --slug <slug>");
    return 2;
  }

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
  info("Update summary:");
  let updated = 0;
  let skipped = 0;
  let errored = 0;
  let missing = 0;
  for (const r of results) {
    if (r.outcome === "updated") updated++;
    else if (r.outcome === "skipped") skipped++;
    else if (r.outcome === "errored") errored++;
    else if (r.outcome === "missing-path") missing++;
  }
  info(`  updated: ${updated}`);
  info(`  skipped: ${skipped}`);
  info(`  errored: ${errored}`);
  info(`  missing: ${missing}`);

  return errored > 0 ? 1 : 0;
}
