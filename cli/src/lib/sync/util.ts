/**
 * Shared utilities for `igris sync` sub-verbs (TD-121).
 *
 * Lifted from sync/data.ts and sync/status.ts where the same private
 * helper was defined twice. Future doctor-related sync sub-verbs (e.g.
 * sync code/all/--debug) will consume this same surface.
 */

/**
 * Return the basename of `process.cwd()`.
 *
 * Used to derive the project slug for sync-queue path resolution when
 * no explicit slug is passed. Mirrors the legacy /sync skill convention.
 *
 * Implemented via `lastIndexOf("/")` rather than `path.basename` to
 * preserve byte-exact parity with the two prior private copies (which
 * the brief flagged for consolidation; behavior preservation is the
 * AC).
 */
export function basenameOfCwd(): string {
  const cwd = process.cwd();
  const idx = cwd.lastIndexOf("/");
  return idx === -1 ? cwd : cwd.slice(idx + 1);
}
