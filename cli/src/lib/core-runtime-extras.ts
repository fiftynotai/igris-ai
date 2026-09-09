/**
 * Runtime-only files under `~/.igris/core/` and what a core swap does with
 * them (BR-103, AC-6). A swap promotes a freshly staged `core/` over the old
 * one, so anything that lives ONLY in the runtime copy is lost unless it is
 * named here. Two policies, both applied to the STAGED tree before the swap
 * (so the swap stays atomic):
 *
 *   regenerate  — the file has a source OUTSIDE `core/` in the same tree:
 *                 `harness-manifest.json` sits at the repo ROOT (a sibling of
 *                 `core/`), and the bash adapters read the copy under
 *                 `~/.igris/core/`. `copyFromSource` and the GitHub extractor
 *                 both stage it beside `core/`; this module moves it in. A
 *                 stale runtime copy is never carried — no source, no file.
 *   carry-over  — the file has NO source in the staged tree: the prior
 *                 runtime copy is kept as-is, and only when the staged tree
 *                 does not ship one (a shipped file wins).
 *
 * Every OTHER file the prior core had and the staged core lacks is an
 * UNLISTED extra: reported, never carried — otherwise a swap would silently
 * preserve any stale file an upgrade meant to remove.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { debug } from "./log.js";

export type CoreExtraPolicy = "regenerate" | "carry-over";

export interface CoreRuntimeExtra {
  /** path relative to `core/` */
  rel: string;
  policy: CoreExtraPolicy;
  why: string;
}

export const CORE_RUNTIME_EXTRAS: readonly CoreRuntimeExtra[] = [
  {
    rel: "harness-manifest.json",
    policy: "regenerate",
    why: "the repo keeps the harness descriptor at the ROOT (sibling of core/); the bash adapters read the copy under ~/.igris/core/ (FR-217)",
  },
  {
    rel: "docs/component-manifest.md",
    policy: "carry-over",
    why: "FR-252's format spec on this machine's runtime only — its source branch (GL-012) never merged; the source question is TD-433's",
  },
];

export interface CoreExtraEntry {
  rel: string;
  kind: CoreExtraPolicy | "unlisted";
}

/**
 * Every regular file under `priorCore` that `stagedCore` does NOT have,
 * classified by the allowlist above. Symlinks are not files here (neither
 * copier carries them).
 */
export function enumerateCoreExtras(
  priorCore: string,
  stagedCore: string,
): CoreExtraEntry[] {
  const out: CoreExtraEntry[] = [];
  for (const rel of walkFiles(priorCore)) {
    if (existsSync(join(stagedCore, rel))) continue;
    const spec = CORE_RUNTIME_EXTRAS.find((e) => e.rel === rel);
    out.push({ rel, kind: spec === undefined ? "unlisted" : spec.policy });
  }
  return out;
}

export interface ApplyCoreExtrasOptions {
  /** the staging dir that CONTAINS `core/` (and the staged root files) */
  stagedRoot: string;
  /** `<stagedRoot>/core` */
  stagedCore: string;
  /** the runtime `core/` about to be replaced, or null on a fresh install */
  priorCore: string | null;
}

export interface CoreExtrasReport {
  regenerated: string[];
  /** regenerate entries whose source was absent from the staged root */
  regenerateSourceMissing: string[];
  carried: string[];
  /** prior-core files neither shipped nor listed — reported, NOT carried */
  unlisted: string[];
}

export function applyCoreExtras(opts: ApplyCoreExtrasOptions): CoreExtrasReport {
  const report: CoreExtrasReport = {
    regenerated: [],
    regenerateSourceMissing: [],
    carried: [],
    unlisted: [],
  };
  for (const spec of CORE_RUNTIME_EXTRAS) {
    const dest = join(opts.stagedCore, spec.rel);
    if (spec.policy === "regenerate") {
      const src = join(opts.stagedRoot, spec.rel);
      if (!isFile(src)) {
        report.regenerateSourceMissing.push(spec.rel);
        continue;
      }
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      report.regenerated.push(spec.rel);
      continue;
    }
    // carry-over: the shipped file wins; else keep the prior runtime copy.
    if (existsSync(dest) || opts.priorCore === null) continue;
    const prior = join(opts.priorCore, spec.rel);
    if (!isFile(prior)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(prior, dest);
    report.carried.push(spec.rel);
  }
  if (opts.priorCore !== null && existsSync(opts.priorCore)) {
    for (const e of enumerateCoreExtras(opts.priorCore, opts.stagedCore)) {
      if (e.kind === "unlisted") report.unlisted.push(e.rel);
    }
  }
  return report;
}

/** The `--verbose` lines both verbs print (stderr via debug). */
export function reportCoreExtras(report: CoreExtrasReport): void {
  for (const r of report.regenerated) debug(`  core extras — regenerated: ${r} (from the source root)`);
  for (const r of report.regenerateSourceMissing) {
    debug(`  core extras — no source for: ${r} (absent from the staged root; not carried)`);
  }
  for (const r of report.carried) debug(`  core extras — carried over: ${r} (no source in the staged core)`);
  for (const r of report.unlisted) debug(`  core extras — not carried: ${r} (unlisted extra under the prior core)`);
}

function isFile(p: string): boolean {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) out.push(relative(root, abs));
    }
  };
  walk(root);
  return out;
}
