/**
 * FR-240 D8 — the context-docs layer. ZERO brain work, zero SQL.
 *
 * Context docs are FILES under `~/.igris/projects/<slug>/context/`, not brain
 * rows, and `igris context-docs inventory` already owns the whole
 * exists / applies / missing_applicable / remediation computation as an exported
 * structured-JSON function (`verbs/context-docs.ts#buildContextDocsInventoryDigest`).
 * So this module adds exactly two things: a slug allowlist and a guarded read.
 *
 * `applies_when` IS NOT RE-DERIVED HERE. That evaluation lives in the verb and
 * is owned by the FR-209 catalog. Re-implementing the predicate would create a
 * second answer to "does this doc apply", and the two would diverge the first
 * time the catalog changed.
 *
 * PATH SAFETY — TWO INDEPENDENT PROPERTIES
 * ----------------------------------------
 *  1. The SLUG is validated against `listProjects()`. It is never joined into a
 *     path before that check, so `?project=../../etc` cannot reach the
 *     filesystem: it is not a registered slug, so the request is refused before
 *     `projectContextDir` is called.
 *  2. The TARGET is taken from the digest ROW, never from the query string. The
 *     caller supplies a doc TYPE; this module looks the type up in the digest and
 *     uses that row's `target`. A `?target=../../../.ssh/id_rsa` therefore has
 *     nowhere to land — there is no code path that joins a caller-supplied
 *     filename.
 *
 * A commonpath guard runs anyway, as the third fence: it is the one that still
 * holds if a future caller forgets (1) or (2). Unlike `static.ts#resolveStatic`
 * this guard IS physical where it can be — it `realpath`s the resolved file when
 * it exists, because `~/.igris/projects/**` is a directory the OPERATOR writes,
 * which is exactly the condition `resolveStatic`'s SCOPE LIMIT note says would
 * demand a physical check.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { brainDbPath, projectContextDir } from "../paths.js";
import { listProjects } from "../registry.js";
import { buildContextDocsInventoryDigest } from "../../verbs/context-docs.js";
import type { ContextDocsInventoryDigest } from "../../types.js";

/** Hard ceiling on a served doc body. Docs are prose; 2 MB is already absurd. */
export const MAX_DOC_BYTES = 2 * 1024 * 1024;

/** The result of asking for a project's inventory. */
export type InventoryResult =
  | { ok: true; digest: ContextDocsInventoryDigest }
  | { ok: false; reason: string };

/** The result of asking for one doc's content. */
export type DocResult =
  | {
      ok: true;
      project: string;
      type: string;
      target: string;
      /** Absolute path the bytes came from. Useful in the UI; already vetted. */
      path: string;
      content: string;
      bytes: number;
      /** True when `content` was cut at {@link MAX_DOC_BYTES}. */
      truncated: boolean;
    }
  | { ok: false; reason: string };

/**
 * True when `slug` is a registered project.
 *
 * Registry-backed, not shape-based. A regex allowlist (`/^[a-z0-9-]+$/`) would
 * also stop `../`, but it would let through any well-formed name that happens
 * to exist as a directory under `~/.igris/projects/` — and the surface this
 * feeds is a browser with no auth. Membership in the registry is the narrower
 * and more honest predicate.
 *
 * THE `existsSync` PREFLIGHT IS LOAD-BEARING, NOT DEFENSIVE. `registry.ts`
 * OWNS its `projects` table and therefore CREATES the brain database when it is
 * absent — correct for `igris register`, and a WRITE for a read-only lens. AC #7
 * says nothing in this brief mutates the brain, and materialising a 20 KB
 * SQLite file where the operator had none is a mutation, so the file's absence
 * is answered here rather than by opening a connection. Caught by
 * `dashboard-layers-endpoint.test.ts` T1, where a `/api/context-docs` request
 * conjured the brain and made every later endpoint report
 * "no such table: brief_status" instead of "brain database not found".
 *
 * Returns false (never throws) when the registry itself is unreadable; the
 * caller turns that into a degraded response.
 */
export function isKnownProject(slug: string): boolean {
  if (slug.length === 0) return false;
  if (!existsSync(brainDbPath())) return false;
  try {
    return listProjects().some((p) => p.slug === slug);
  } catch {
    return false;
  }
}

/**
 * Cut a string to at most `max` BYTES of UTF-8, never mid-character.
 *
 * `String.prototype.slice` counts UTF-16 code units, which is a different unit
 * from the one {@link MAX_DOC_BYTES} is expressed in. Decoding the truncated
 * buffer with a fatal-less TextDecoder would leave a U+FFFD where the cut landed
 * inside a sequence; walking back to the last continuation-byte boundary drops
 * the partial character instead, which is the honest rendering of an already
 * incomplete document.
 */
export function cutToBytes(raw: string, max: number): string {
  const buf = Buffer.from(raw, "utf-8");
  if (buf.length <= max) return raw;
  let end = max;
  // 0b10xxxxxx is a UTF-8 continuation byte: back up off it to the lead byte.
  while (end > 0 && (buf[end] ?? 0) >= 0x80 && (buf[end] ?? 0) < 0xc0) end--;
  return buf.subarray(0, end).toString("utf-8");
}

/**
 * Build the inventory digest for a registered project.
 *
 * Never throws: an unreadable profile or catalog already surfaces through the
 * digest's own `degraded` flag, and anything below that becomes an `ok:false`.
 */
export function readInventory(slug: string): InventoryResult {
  if (!existsSync(brainDbPath())) {
    // Distinguished from "unknown project": with no brain there is no registry
    // to be unknown TO, and the two send an operator to different places.
    return { ok: false, reason: `brain database not found at ${brainDbPath()}` };
  }
  if (!isKnownProject(slug)) {
    return { ok: false, reason: `unknown project: ${slug}` };
  }
  try {
    return { ok: true, digest: buildContextDocsInventoryDigest(slug) };
  } catch (err) {
    return {
      ok: false,
      reason: `context-docs inventory failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Read one context doc's content, addressed by its catalog TYPE.
 *
 * `type` — not a filename. The filename comes from the digest row, which is
 * what makes the traversal class unreachable rather than merely filtered.
 */
export function readDoc(slug: string, type: string): DocResult {
  const inventory = readInventory(slug);
  if (!inventory.ok) return { ok: false, reason: inventory.reason };

  const row = inventory.digest.docs.find((d) => d.type === type);
  if (row === undefined) {
    return { ok: false, reason: `unknown context-doc type: ${type}` };
  }
  if (!row.exists) {
    return {
      ok: false,
      // Actionable rather than bare: the remediation verb IS the digest's own
      // (`/ground <type>`), never a hand-written string.
      reason: `context doc not present for ${slug}: ${row.target} (run /ground ${row.type})`,
    };
  }

  const root = resolve(projectContextDir(slug));
  const target = resolve(join(root, row.target));

  // Fence 3 — lexical commonpath. `target !== root` because a doc is a FILE
  // inside the dir, never the dir itself; the `+ sep` defeats the
  // sibling-prefix case (`/x/context-evil` vs `/x/context`).
  if (!target.startsWith(root + sep)) {
    return { ok: false, reason: `refused: resolved path escapes ${root}` };
  }

  try {
    // PHYSICAL fence — the operator writes this directory, so a symlink planted
    // in it is a realistic shape, not a theoretical one. `resolveStatic` can
    // skip this (build artifact); here it would be negligent.
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(target);
    if (!realTarget.startsWith(realRoot + sep)) {
      return {
        ok: false,
        reason: `refused: ${row.target} resolves outside ${realRoot}`,
      };
    }
    if (!statSync(realTarget).isFile()) {
      return { ok: false, reason: `refused: ${row.target} is not a regular file` };
    }
    // NOTE for a future editor: there is deliberately no `existsSync(realTarget)`
    // here. `realpathSync` above already throws ENOENT for a path that does not
    // resolve, so the branch was unreachable — a guard that can only ever be
    // true reads as coverage and provides none.

    const raw = readFileSync(realTarget, "utf-8");
    const bytes = Buffer.byteLength(raw, "utf-8");
    const truncated = bytes > MAX_DOC_BYTES;
    return {
      ok: true,
      project: slug,
      type: row.type,
      target: row.target,
      path: realTarget,
      // Cut in BYTES, matching the bound. `raw.slice(MAX_DOC_BYTES)` cuts UTF-16
      // code units, so a doc of multibyte prose was over-delivered by up to ~3x
      // the ceiling. `subarray` + `toString` can split a multibyte sequence at
      // the boundary, so the trailing partial character is dropped rather than
      // emitted as U+FFFD — the body is prose and the `truncated` flag already
      // says it is incomplete.
      content: truncated ? cutToBytes(raw, MAX_DOC_BYTES) : raw,
      bytes,
      truncated,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `context doc read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
