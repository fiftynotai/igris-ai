/**
 * `igris register-project [<path>] [--slug X] [--allow-missing-path]`
 *
 * Inverts `igris install`: writes the brain `projects` registry row only.
 * Does NOT:
 *   - touch <path>/.claude/ (no symlinks, no settings.json merge, no CLAUDE.md)
 *   - write installed_features.json
 *   - merge hooks
 *   - regenerate .igris_version
 *
 * Use cases:
 *   - migrating a manually-tracked project into the registry post-hoc
 *   - registering a deferred-install path (e.g., a project on a remote
 *     workstation whose installed CLI will be configured later)
 *   - re-keying an existing registry row by slug (idempotent re-run)
 *
 * Slug grammar mirrors `igris install`'s validateSlug — duplicated as a
 * private SLUG_RE here to avoid coupling the two verbs at the import level
 * and to keep this verb's scope crisp (registry writer only).
 */

import { existsSync } from "node:fs";
import { basename, resolve as pathResolve } from "node:path";
import { upsertProject } from "../lib/registry.js";
import { info, error as logError } from "../lib/log.js";

export interface RegisterProjectOptions {
  /** Path to the project. Defaults to process.cwd() when undefined. */
  path?: string;
  /** Optional explicit slug. Defaults to basename(path). */
  slug?: string;
  /**
   * When true, register even if path does not exist on disk.
   * Without this flag, a missing path is a hard error (exit 1).
   */
  allowMissingPath?: boolean;
  /** Internal: CLI version stamp; defaults to 7.0.0. */
  cliVersion?: string;
}

// Slug grammar — matches verbs/install.ts SLUG_RE exactly.
// First char alphanumeric; subsequent chars alphanumeric/underscore/hyphen/dot.
// Length cap at 64 chars.
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function validateSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `Invalid slug '${slug}': must match /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/ (alphanumeric start, then alphanumeric/underscore/hyphen/dot, max 64 chars).`,
    );
  }
}

/**
 * Run `igris register-project`. Returns process exit code.
 *
 * Exit codes:
 *   0 — registry row written
 *   1 — path missing (without --allow-missing-path), or registry write failed
 */
export async function runRegisterProject(
  opts: RegisterProjectOptions,
): Promise<number> {
  // 1. Resolve absolute path. cwd() is the default when no path is given.
  const inputPath = opts.path ?? process.cwd();
  const absPath = pathResolve(inputPath);

  // 2. Path-existence gate.
  if (!existsSync(absPath)) {
    if (opts.allowMissingPath !== true) {
      logError(
        `path does not exist: ${absPath}. Pass --allow-missing-path to register anyway.`,
      );
      return 1;
    }
    info(
      `path does not exist (${absPath}); registering anyway per --allow-missing-path.`,
    );
  }

  // 3. Resolve slug: explicit --slug wins, else basename(absPath).
  const slug = (opts.slug ?? basename(absPath)).trim();
  if (slug.length === 0) {
    logError("could not derive a slug; pass --slug explicitly");
    return 1;
  }
  validateSlug(slug);

  const cliVersion = opts.cliVersion ?? "7.0.0";

  // 4. Registry write — the entire scope of this verb.
  try {
    upsertProject({
      slug,
      name: slug,
      path: absPath,
      tech_stack: "",
      igris_version: cliVersion,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`registry upsert failed: ${msg}`);
    return 1;
  }

  info(`Registered project: ${slug} -> ${absPath}`);
  info("");
  info("Note: register-project writes the brain registry row only.");
  info("To install symlinks, hooks, and CLAUDE.md, run: igris install <path>");
  return 0;
}
