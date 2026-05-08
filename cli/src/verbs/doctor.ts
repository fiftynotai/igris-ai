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
 * channel-mismatch → bridge-missing → duplicate-path → not-installed →
 * hooks-missing → hooks-stale → symlink-target → slug-basename-mismatch → clean.
 *
 * --fix repairs not-installed / hooks-missing / hooks-stale by re-running install,
 * brain-core-missing by invoking runRefresh(), bridge-missing by invoking
 * partial-mode runInit({ upgrade: true }).
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
          r.driftClass === "hooks-stale" ||
          r.driftClass === "brain-core-missing" ||
          r.driftClass === "bridge-missing")
      ),
  );

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
