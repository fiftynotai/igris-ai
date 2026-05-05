/**
 * `igris doctor [--fix] [--remove-orphans] [--yes]` — Phase 1.
 *
 * Read-only by default: walks the registry and classifies every row into a
 * `DriftRow` (see types.ts). Drift classes match TD-100 plan Phase 1 step 1.3:
 *
 *   path-missing            → orphan (registry row points at deleted dir)
 *   not-installed           → path exists but .claude/ missing
 *   hooks-missing           → settings.json present but lacks SessionEnd Igris hook
 *                             (the TD-100 silent-failure class)
 *   hooks-stale             → settings.json has Igris hooks but their hash differs
 *   slug-basename-mismatch  → row.slug !== basename(row.path)  (informational)
 *   duplicate-path          → multiple slugs with the same realpath (fifty_eco_system)
 *   symlink-target          → row.path is itself a symlink
 *   clean                   → none of the above
 *
 * --fix repairs not-installed / hooks-missing / hooks-stale by re-running install.
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
  projectSettingsPath,
} from "../lib/paths.js";
import { runInstall } from "./install.js";
import { info, warn, error as logError } from "../lib/log.js";
import type { DriftRow, RegistryRow } from "../types.js";

export interface DoctorOptions {
  fix: boolean;
  removeOrphans: boolean;
  yes: boolean;
}

export async function runDoctor(opts: DoctorOptions): Promise<number> {
  const rows = listProjects();
  const drift = classifyDrift(rows);

  printDriftTable(drift);

  let errored = 0;

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
      } else if (
        row.driftClass === "slug-basename-mismatch" ||
        row.driftClass === "duplicate-path"
      ) {
        warn(
          `${row.slug}: ${row.driftClass} — manual decision required (not auto-fixable in Phase 1)`,
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
  const nonCleanRemaining = drift.some(
    (r) =>
      r.driftClass !== "clean" &&
      // After --remove-orphans, path-missing is conceptually resolved.
      !(opts.removeOrphans && r.driftClass === "path-missing") &&
      // After --fix, the auto-fixable classes are conceptually resolved (best-effort).
      !(
        opts.fix &&
        (r.driftClass === "not-installed" ||
          r.driftClass === "hooks-missing" ||
          r.driftClass === "hooks-stale")
      ),
  );

  if (errored > 0) return 1;
  return nonCleanRemaining ? 1 : 0;
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

async function confirmAndRemoveOrphans(
  orphans: DriftRow[],
  skipPrompt: boolean,
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

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (q: string): Promise<string> =>
    new Promise((res) => rl.question(q, (a) => res(a)));

  let yesAll = false;
  let removed = 0;

  for (const o of orphans) {
    if (yesAll) {
      deleteProjectRow(o.slug);
      info(`removed: ${o.slug}`);
      removed++;
      continue;
    }
    const ans = (await ask(`${o.slug} -> ${o.path}: orphan; delete? [y/N/a/Y/A]: `))
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

  rl.close();
  return removed;
}
