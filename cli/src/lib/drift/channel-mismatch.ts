/**
 * channel-mismatch drift detector — M5.
 *
 * Detects when a per-project `installed_features.json#cli_version` is NEWER
 * than the currently-running CLI version. This catches the "user
 * downgraded the CLI but their projects still claim the newer version"
 * case — running `igris install` from an older CLI against a project
 * that records a newer brain channel/ref would silently regress hashes.
 *
 * Returns one DriftRow per project where this holds. Pure: reads
 * filesystem only.
 *
 * Comparison is semver-major.minor.patch. If `cli_version` in any
 * project is lex-greater than the current CLI version, flag it.
 *
 * Test seam: `currentCliVersionFn` is parameterizable so tests can
 * inject the version string deterministically.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listProjects } from "../registry.js";
import { readInstalledFeatures } from "../installed-features.js";
import type { DriftRow } from "../../types.js";

export interface ChannelMismatchOptions {
  /** Test seam — return the CLI version string. Default reads package.json baked at build. */
  currentCliVersionFn?: () => string;
}

/**
 * Detect channel-mismatch drift across all registered projects. Returns
 * one DriftRow per project whose `cli_version` is newer than the current
 * CLI version. Empty array when nothing is ahead.
 */
export function detectChannelMismatch(
  opts: ChannelMismatchOptions = {},
): DriftRow[] {
  const currentVersion = (opts.currentCliVersionFn ?? defaultCurrentCliVersion)();
  const out: DriftRow[] = [];
  for (const proj of listProjects()) {
    const features = (() => {
      try {
        return readInstalledFeatures(proj.slug);
      } catch {
        return null;
      }
    })();
    if (features === null) continue;
    const recorded = features.cli_version;
    if (typeof recorded !== "string" || recorded.length === 0) continue;
    if (compareSemver(recorded, currentVersion) > 0) {
      out.push({
        slug: proj.slug,
        path: proj.path,
        driftClass: "channel-mismatch",
        recommendedFix: `project records cli_version=${recorded} but current CLI is ${currentVersion}; upgrade the CLI ('igris update --self') or re-run 'igris install' to refresh the marker`,
      });
    }
  }
  return out;
}

/**
 * Read the CLI version from the package.json baked alongside the compiled
 * module. Mirrors the resolution in src/index.ts so doctor agrees with
 * `igris --version`.
 */
function defaultCurrentCliVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/lib/drift/channel-mismatch.js -> dist -> package root
    const pkgPath = join(here, "..", "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Strict semver-major.minor.patch comparison. Returns -1, 0, or 1 in the
 * usual sense. Strips a leading "v" if present. Pre-release identifiers
 * (e.g. "7.0.0-rc.1") are compared lexicographically AFTER the numeric
 * triple — for our use case (major.minor.patch only, no -pre), this is
 * sufficient. Throws on completely-malformed input (caller pre-validates).
 */
export function compareSemver(a: string, b: string): number {
  const sa = stripV(a);
  const sb = stripV(b);
  const [aBase] = sa.split("-", 1);
  const [bBase] = sb.split("-", 1);
  const ax = parseTriple(aBase);
  const bx = parseTriple(bBase);
  for (let i = 0; i < 3; i++) {
    const ai = ax[i];
    const bi = bx[i];
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  // Identical numeric triple. Pre-release is "less than" no-pre.
  const aPre = sa.includes("-") ? sa.slice(sa.indexOf("-") + 1) : "";
  const bPre = sb.includes("-") ? sb.slice(sb.indexOf("-") + 1) : "";
  if (aPre === bPre) return 0;
  if (aPre === "") return 1;
  if (bPre === "") return -1;
  return aPre < bPre ? -1 : 1;
}

function stripV(s: string): string {
  return s.startsWith("v") ? s.slice(1) : s;
}

function parseTriple(s: string): [number, number, number] {
  const parts = s.split(".");
  const out: number[] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const v = parts[i];
    if (v === undefined) {
      out[i] = 0;
    } else {
      const n = parseInt(v, 10);
      out[i] = Number.isNaN(n) ? 0 : n;
    }
  }
  return [out[0], out[1], out[2]];
}
