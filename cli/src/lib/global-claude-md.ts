/**
 * Global `~/.claude/CLAUDE.md` regeneration — TD-176.
 *
 * THIS MODULE OWNS THE GLOBAL FILE — `~/.claude/CLAUDE.md`. It is distinct
 * from `claude-md.ts`, which owns the PROJECT file `<repo>/CLAUDE.md`. Do not
 * confuse the two: editing the wrong write path is exactly how L-254-style
 * clobber bugs happen.
 *
 *   - Global  CLAUDE.md  (~/.claude/CLAUDE.md)  ← this module
 *   - Project CLAUDE.md  (<repo>/CLAUDE.md)     ← claude-md.ts
 *
 * The global file is orphaned v6 machine state: the retired
 * `igris_brain_init.sh` shell installer was its original (and only) writer.
 * v7 has no shell installer, so the file froze at v6.0.0. This module adds
 * the missing regeneration step back into `igris init`.
 *
 * Determinism contract (L-254 mitigation): regeneration is pure template
 * substitution. `{{IGRIS_VERSION}}` comes from the CLI's package version;
 * `{{INSTALL_DATE}}` is preserved from the existing file when present (else
 * stamped today); `{{SOURCE_REPO}}` is preserved from the existing file when
 * present (else a stable literal). No hostname, no module counts, no
 * per-commit data is ever baked in.
 *
 * Safety guards (see TD-176 plan §"User-customization safety"):
 *   1. Version gate — only rewrite when installed < current (or the file is
 *      absent / malformed / still has placeholders). A current file is a
 *      strict no-op, so even an in-version user edit survives until the next
 *      genuine version bump.
 *   2. Atomic write — tmp + rename, never a partial-write corruption.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export class GlobalClaudeMdTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlobalClaudeMdTemplateError";
  }
}

/** Default `{{SOURCE_REPO}}` substitution when no prior value is preserved. */
const DEFAULT_SOURCE_REPO = "(local install)";

/** Absolute path to the global CLAUDE.md (`~/.claude/CLAUDE.md`). */
export function globalClaudeMdPath(): string {
  return join(homedir(), ".claude", "CLAUDE.md");
}

/**
 * Absolute path to the bundled template (`lib/templates/CLAUDE.global.md.tmpl`).
 *
 * Resolves relative to the compiled output, exactly like `init.ts`'s
 * `templateRoot()`:
 *   dist/lib/global-claude-md.js → ./templates  (next to USER.md.tmpl)
 *   src/lib/global-claude-md.ts  → ./templates
 */
export function globalClaudeMdTemplatePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "templates", "CLAUDE.global.md.tmpl");
}

export interface RenderGlobalClaudeMdOptions {
  /** CLI version (e.g. "7.0.0") substituted for {{IGRIS_VERSION}}. */
  cliVersion: string;
  /**
   * Value substituted for {{INSTALL_DATE}}. Callers preserve this from the
   * existing file. When omitted, today's ISO timestamp is stamped.
   */
  installDate?: string;
  /**
   * Value substituted for {{SOURCE_REPO}}. Callers preserve this from the
   * existing file. When omitted, a stable literal is used (this field is
   * cosmetic — not always meaningful for a generic install).
   */
  sourceRepo?: string;
  /** Override template path. Defaults to the bundled template. Used by tests. */
  templatePath?: string;
}

/**
 * Extract the version from a `- **Version:** X.Y.Z` line.
 *
 * Returns `null` when the line is absent OR when it still carries the
 * unsubstituted `{{IGRIS_VERSION}}` placeholder — both cases mean "needs
 * rewrite".
 */
export function parseInstalledVersion(content: string): string | null {
  const m = content.match(/^- \*\*Version:\*\* (\d+\.\d+\.\d+)\s*$/m);
  return m ? m[1] : null;
}

/** Extract the value of a `- **Installed:** <value>` line, or `null`. */
export function parseInstalledDate(content: string): string | null {
  const m = content.match(/^- \*\*Installed:\*\* (.+?)\s*$/m);
  const value = m ? m[1].trim() : "";
  if (value.length === 0 || value.includes("{{")) return null;
  return value;
}

/** Extract the value of a `- **Source Repo:** <value>` line, or `null`. */
export function parseSourceRepo(content: string): string | null {
  const m = content.match(/^- \*\*Source Repo:\*\* (.+?)\s*$/m);
  const value = m ? m[1].trim() : "";
  if (value.length === 0 || value.includes("{{")) return null;
  return value;
}

/**
 * Version-drift gate. Returns `true` when the global file should be rewritten.
 *
 *   - `installedVersion === null` → true (absent / malformed / placeholders).
 *   - installed < current         → true (genuine version bump).
 *   - installed >= current        → false (no-op; never clobber an equal or
 *                                   newer file with an older CLI).
 *
 * Comparison is a dependency-free 3-int tuple compare. The Version line is a
 * strict `X.Y.Z` triple (no pre-release tags in play), so a semver dependency
 * would be unnecessary weight.
 */
export function needsRewrite(
  installedVersion: string | null,
  currentVersion: string,
): boolean {
  if (installedVersion === null) return true;
  return compareVersions(installedVersion, currentVersion) < 0;
}

/** -1 / 0 / 1 tuple compare of two strict `X.Y.Z` version strings. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

/**
 * Render the global CLAUDE.md content from the bundled template.
 *
 * Pure function: no filesystem writes. Throws `GlobalClaudeMdTemplateError`
 * when the template is missing.
 */
export function renderGlobalClaudeMd(
  opts: RenderGlobalClaudeMdOptions,
): string {
  const tmplPath = opts.templatePath ?? globalClaudeMdTemplatePath();
  if (!existsSync(tmplPath)) {
    throw new GlobalClaudeMdTemplateError(
      `Global CLAUDE.md template not found at ${tmplPath}.`,
    );
  }
  const installDate = opts.installDate ?? new Date().toISOString();
  const sourceRepo = opts.sourceRepo ?? DEFAULT_SOURCE_REPO;
  const raw = readFileSync(tmplPath, "utf-8");
  return raw
    .replace(/\{\{IGRIS_VERSION\}\}/g, opts.cliVersion)
    .replace(/\{\{INSTALL_DATE\}\}/g, installDate)
    .replace(/\{\{SOURCE_REPO\}\}/g, sourceRepo);
}

export interface RegenerateGlobalClaudeMdOptions {
  /** CLI version (e.g. "7.0.0") substituted for {{IGRIS_VERSION}}. */
  cliVersion: string;
  /** Override template path. Defaults to the bundled template. Used by tests. */
  templatePath?: string;
}

export interface RegenerateGlobalClaudeMdResult {
  /** True when the file was (re)written; false when it was a version-gated no-op. */
  written: boolean;
  /** Absolute path of the global CLAUDE.md. */
  path: string;
  /** The version parsed from the existing file (null if absent/malformed). */
  previousVersion: string | null;
}

/**
 * Regenerate `~/.claude/CLAUDE.md` when the version has drifted.
 *
 * Reads the existing file (if any), runs the version gate, and on drift
 * renders + atomically writes the refreshed content. The install date and
 * source repo are preserved from the existing file when parseable.
 */
export function regenerateGlobalClaudeMd(
  opts: RegenerateGlobalClaudeMdOptions,
): RegenerateGlobalClaudeMdResult {
  const target = globalClaudeMdPath();
  const existing = existsSync(target)
    ? readFileSync(target, "utf-8")
    : null;

  const installedVersion =
    existing !== null ? parseInstalledVersion(existing) : null;

  if (!needsRewrite(installedVersion, opts.cliVersion)) {
    return { written: false, path: target, previousVersion: installedVersion };
  }

  const preservedDate =
    existing !== null ? parseInstalledDate(existing) : null;
  const preservedRepo =
    existing !== null ? parseSourceRepo(existing) : null;

  const content = renderGlobalClaudeMd({
    cliVersion: opts.cliVersion,
    installDate: preservedDate ?? undefined,
    sourceRepo: preservedRepo ?? undefined,
    templatePath: opts.templatePath,
  });

  // Ensure ~/.claude/ exists, then atomic write (tmp + rename) so a partial
  // write never leaves a corrupt status file.
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, target);

  return { written: true, path: target, previousVersion: installedVersion };
}
