/**
 * Loader for `~/.igris/core/hooks/canonical-settings.json`.
 *
 * Single source of truth for the Igris-managed hooks block. Cached per-process
 * — re-reads only when `clearCache()` is called (used by tests). Throws
 * `CanonicalHooksMissingError` with an actionable message when the file is
 * absent — verb layer surfaces this to the user.
 */

import { existsSync, readFileSync } from "node:fs";
import { canonicalHooksPath } from "./paths.js";
import type { CanonicalHooks } from "../types.js";

export class CanonicalHooksMissingError extends Error {
  constructor(path: string) {
    super(
      `Canonical hooks file not found at ${path}. ` +
        `Run 'igris refresh' to fetch ~/.igris/core/ from the configured channel.`,
    );
    this.name = "CanonicalHooksMissingError";
  }
}

let cache: CanonicalHooks | null = null;
let cachedFor: string | null = null;

/**
 * Load (or return cached) canonical hooks. The cache key is the resolved
 * path — IGRIS_BRAIN_DIR overrides invalidate the cache automatically.
 */
export function loadCanonicalHooks(): CanonicalHooks {
  const path = canonicalHooksPath();
  if (cache !== null && cachedFor === path) return cache;

  if (!existsSync(path)) {
    throw new CanonicalHooksMissingError(path);
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as CanonicalHooks;

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.hooks !== "object" ||
    parsed.hooks === null ||
    Array.isArray(parsed.hooks)
  ) {
    throw new Error(
      `Canonical hooks file at ${path} is malformed: must be an object with a 'hooks' map.`,
    );
  }

  cache = parsed;
  cachedFor = path;
  return parsed;
}

/** Clear the cached canonical hooks. Used by tests. */
export function clearCache(): void {
  cache = null;
  cachedFor = null;
}

/** Read the raw bytes of the canonical hooks file (used for hashing). */
export function readCanonicalHooksRaw(): string | null {
  const path = canonicalHooksPath();
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}
