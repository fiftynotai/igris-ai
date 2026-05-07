/**
 * CLAUDE.md regeneration from template — `igris install` Phase 2 (M2).
 *
 * Replaces the sed/perl two-pass logic in `scripts/igris_install.sh:387-408`.
 * The runtime template lives at `~/.igris/core/templates/CLAUDE.md.tmpl`
 * (relocated from `scripts/templates/CLAUDE.md.template` in M2.1) so it
 * ships with the M1 brain tarball.
 *
 * Substitutions (only two — Phase 1 dropped {{PERSONA_INJECTION}} since it
 * wasn't present in the relocated template):
 *
 *   - `{{IGRIS_VERSION}}` → cliVersion (e.g. "7.0.0")
 *   - `{{INSTALL_DATE}}`  → installDate (ISO date, e.g. "2026-05-07")
 *
 * Determinism contract (L-254 mitigation): same input always produces same
 * content. INSTALL_DATE is intentionally per-call (it IS supposed to bump on
 * each install); IGRIS_VERSION is per-CLI version. No hostname, no module
 * counts, no other host-specific data.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brainDir } from "./paths.js";

export class ClaudeMdTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeMdTemplateError";
  }
}

export interface RegenerateClaudeMdOptions {
  /** CLI version (e.g. "7.0.0") substituted for {{IGRIS_VERSION}}. */
  cliVersion: string;
  /** Override install date (ISO date YYYY-MM-DD). Defaults to today (UTC). */
  installDate?: string;
  /** Override template path. Defaults to runtime brain. Used by tests. */
  templatePath?: string;
}

/** Compute the runtime template path (~/.igris/core/templates/CLAUDE.md.tmpl). */
export function claudeMdTemplatePath(): string {
  return join(brainDir(), "core", "templates", "CLAUDE.md.tmpl");
}

/**
 * Render the CLAUDE.md content for a given CLI version and date.
 * Pure function: no filesystem writes; throws when the template is missing.
 */
export function renderClaudeMd(opts: RegenerateClaudeMdOptions): string {
  const tmplPath = opts.templatePath ?? claudeMdTemplatePath();
  if (!existsSync(tmplPath)) {
    throw new ClaudeMdTemplateError(
      `CLAUDE.md template not found at ${tmplPath}. Run 'igris init' or 'igris refresh' first.`,
    );
  }
  const installDate = opts.installDate ?? new Date().toISOString().slice(0, 10);
  const raw = readFileSync(tmplPath, "utf-8");
  return raw
    .replace(/\{\{IGRIS_VERSION\}\}/g, opts.cliVersion)
    .replace(/\{\{INSTALL_DATE\}\}/g, installDate);
}

/**
 * Regenerate `<projectPath>/CLAUDE.md` from the runtime template.
 *
 * Atomic write via tmp+rename so a partial write never leaves a corrupt
 * file at the project root.
 */
export function regenerateClaudeMd(
  projectPath: string,
  opts: RegenerateClaudeMdOptions,
): string {
  const content = renderClaudeMd(opts);
  const target = join(projectPath, "CLAUDE.md");
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, target);
  return target;
}
