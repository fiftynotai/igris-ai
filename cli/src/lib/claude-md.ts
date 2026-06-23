/**
 * CLAUDE.md regeneration from template — `igris install` Phase 2 (M2).
 *
 * Replaces the sed/perl two-pass logic in `scripts/igris_install.sh:387-408`.
 * The runtime template lives at `~/.igris/core/templates/CLAUDE.md.tmpl`
 * (relocated from `scripts/templates/CLAUDE.md.template` in M2.1) so it
 * ships with the M1 brain tarball.
 *
 * Substitutions (Phase 1 dropped {{PERSONA_INJECTION}} since it wasn't
 * present in the relocated template):
 *
 *   - `{{IGRIS_IDENTITY}}`  → the canonical identity block inlined from the
 *                             sibling `identity.tmpl` with
 *                             {{HARNESS_SELF_NAME}} → "Claude". (FR-202 M4 retired
 *                             the `os_identity` projection surface that once shared
 *                             this template; the CLAUDE.md render path survives
 *                             until the FR-187 cutover's identity-denial sweep.)
 *                             Legacy templates without the token pass through.
 *   - `{{IGRIS_VERSION}}`   → cliVersion (e.g. "7.0.0")
 *   - `{{INSTALL_DATE}}`    → installDate (ISO date, e.g. "2026-05-07")
 *
 * Determinism contract (L-254 mitigation): same input always produces same
 * content. INSTALL_DATE is intentionally per-call (it IS supposed to bump on
 * each install); IGRIS_VERSION is per-CLI version. No hostname, no module
 * counts, no other host-specific data.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { brainDir } from "./paths.js";
import { HARNESS_SELF_NAMES } from "./identity-shape.js";

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
 * Compute the runtime canonical-identity template path
 * (~/.igris/core/templates/identity.tmpl) — the single authored copy of the
 * orchestrator identity block used by the CLAUDE.md render. (FR-202 M4 retired
 * the `os_identity` projection surface that once also consumed this template;
 * this CLAUDE.md path survives until the FR-187 cutover.)
 */
export function identityTemplatePath(): string {
  return join(brainDir(), "core", "templates", "identity.tmpl");
}

/**
 * Inline the canonical identity block into a raw CLAUDE.md template (TD-233).
 *
 * `CLAUDE.md.tmpl` carries an `{{IGRIS_IDENTITY}}` include token where its
 * `## Identity` block used to live; the identity text itself is authored ONCE
 * in the sibling `identity.tmpl`. (FR-202 M4 retired the `os_identity` projection
 * surface that once also consumed this template; this CLAUDE.md render path
 * survives until the FR-187 cutover.) This inlines that template with
 * `{{HARNESS_SELF_NAME}}` → "Claude" and leaves `{{IGRIS_VERSION}}` /
 * `{{INSTALL_DATE}}` for the caller's existing substitutions, so the rendered
 * CLAUDE.md stays byte-identical to the pre-retirement output.
 *
 * A legacy template WITHOUT the token passes through untouched (back-compat
 * for runtime brains whose templates predate TD-233).
 */
function inlineIdentityBlock(raw: string, tmplPath: string): string {
  if (!raw.includes("{{IGRIS_IDENTITY}}")) {
    return raw;
  }
  const identityPath = join(dirname(tmplPath), "identity.tmpl");
  if (!existsSync(identityPath)) {
    throw new ClaudeMdTemplateError(
      `CLAUDE.md template at ${tmplPath} references {{IGRIS_IDENTITY}} but the canonical identity template is missing at ${identityPath}. Run 'igris init' or 'igris refresh' first.`,
    );
  }
  const identityRaw = readFileSync(identityPath, "utf-8")
    .replace(/\n+$/, "")
    .replace(/\{\{HARNESS_SELF_NAME\}\}/g, () => HARNESS_SELF_NAMES.claude);
  return raw.replace(/\{\{IGRIS_IDENTITY\}\}/g, () => identityRaw);
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
  // TD-233: inline the canonical identity block FIRST (it carries
  // {{IGRIS_VERSION}}, resolved by the substitutions below).
  const raw = inlineIdentityBlock(readFileSync(tmplPath, "utf-8"), tmplPath);
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
