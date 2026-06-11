/**
 * Auto-detect installed CLIs.
 *
 * For a CLI to count as "installed" (and therefore eligible for bridge
 * setup), BOTH must be true:
 *
 *   1. The binary is on `process.env.PATH`. We probe each PATH dir for
 *      a regular file or symlink whose basename matches the CLI's
 *      binary name.
 *   2. The CLI's config dir exists in `homedir()`. e.g. `~/.claude/`
 *      for Claude Code, `~/.codex/` for Codex.
 *
 * The two-signal requirement (Risk #10 mitigation): an unrelated
 * binary called `claude` on PATH (e.g. a system command from another
 * tool) doesn't trigger bridge setup. The user must have actually
 * installed and configured the CLI for it to be considered.
 *
 * Test seam: `homedir()` is read fresh on every call so tests can
 * swap `HOME` env var. PATH stubbing is the standard `process.env.PATH`
 * swap.
 */

import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import type { CLITarget } from "../types.js";

/**
 * The static catalog of CLIs we know how to bridge to.
 * Order is stable for deterministic test snapshots.
 */
interface CLISpec {
  target: CLITarget;
  /** PATH binary name (without extension; we don't probe Windows .exe). */
  binary: string;
  /** Config dir relative to home. */
  configDirRel: string;
}

const CLI_CATALOG: ReadonlyArray<CLISpec> = [
  { target: "claude", binary: "claude", configDirRel: ".claude" },
  { target: "codex", binary: "codex", configDirRel: ".codex" },
  { target: "gemini", binary: "gemini", configDirRel: ".gemini" },
  { target: "opencode", binary: "opencode", configDirRel: ".config/opencode" },
  { target: "antigravity", binary: "agy", configDirRel: ".gemini" },
];

/** Test seam — re-export for adapter scripts that want to enumerate. */
export function knownCLITargets(): readonly CLITarget[] {
  return CLI_CATALOG.map((c) => c.target);
}

export interface DetectionResult {
  /** Set of CLIs that satisfy BOTH PATH and config-dir checks. */
  detected: Set<CLITarget>;
  /** Diagnostic detail per CLI for `igris doctor` and dry-run output. */
  detail: Record<
    CLITarget,
    { onPath: boolean; configDir: boolean; pathHit: string | null }
  >;
}

/**
 * Run detection. Returns a set of CLIs that pass both checks AND the
 * diagnostic detail map for partial-state reporting.
 */
export function detectInstalledCLIs(): DetectionResult {
  const detected = new Set<CLITarget>();
  const detail: DetectionResult["detail"] = {
    claude: { onPath: false, configDir: false, pathHit: null },
    codex: { onPath: false, configDir: false, pathHit: null },
    gemini: { onPath: false, configDir: false, pathHit: null },
    opencode: { onPath: false, configDir: false, pathHit: null },
    antigravity: { onPath: false, configDir: false, pathHit: null },
  };

  const home = homedir();
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);

  for (const spec of CLI_CATALOG) {
    const pathHit = findOnPath(spec.binary, pathDirs);
    const configDirAbs = join(home, spec.configDirRel);
    const hasConfig = existsSync(configDirAbs);
    detail[spec.target] = {
      onPath: pathHit !== null,
      configDir: hasConfig,
      pathHit,
    };
    if (pathHit !== null && hasConfig) {
      detected.add(spec.target);
    }
  }

  return { detected, detail };
}

/**
 * Probe `dirs` for an entry whose basename matches `binary` AND is
 * either a regular file or a symlink. Returns the absolute path of
 * the first hit, or null.
 */
function findOnPath(binary: string, dirs: string[]): string | null {
  for (const d of dirs) {
    const candidate = join(d, binary);
    if (!existsSync(candidate)) continue;
    let st;
    try {
      st = statSync(candidate);
    } catch {
      continue;
    }
    if (st.isFile() || st.isSymbolicLink()) {
      return candidate;
    }
  }
  return null;
}

/**
 * Manual override applied to a detection result. Honors `--cli-bridge=<list>`:
 *
 *   "none"            → empty set (skip all bridges)
 *   "claude,codex"    → only those two; the user explicitly listed them
 *   undefined         → use auto-detected set verbatim
 *
 * Returns a NEW set; does not mutate the input. Throws if the override
 * lists a CLI not in our catalog (so typos surface fast).
 */
export function applyBridgeOverride(
  detected: Set<CLITarget>,
  override: string | undefined,
): Set<CLITarget> {
  if (override === undefined) return new Set(detected);
  if (override === "none") return new Set();
  const items = override
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const known: ReadonlySet<CLITarget> = new Set(knownCLITargets());
  for (const it of items) {
    if (!known.has(it as CLITarget)) {
      throw new Error(
        `--cli-bridge=${override}: unknown target '${it}'. Known: ${[...known].join(",")},none`,
      );
    }
  }
  return new Set(items as CLITarget[]);
}
