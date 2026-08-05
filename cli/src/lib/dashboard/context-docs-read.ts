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
 *  1. The SLUG is validated against `listProjectsReadonly()`. It is never joined into a
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
import { listProjectsReadonly } from "../registry.js";
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
 * SINCE TD-319 THIS READS THROUGH `registry.ts#listProjectsReadonly`, NOT
 * `listProjects`. The distinction is the whole point of that brief:
 * `listProjects` goes through `registry.ts#getDb()`, which opens read-WRITE,
 * sets `journal_mode = WAL` and runs `CREATE TABLE IF NOT EXISTS projects` —
 * correct for `igris register`, a WRITE for a read-only lens. The read-only
 * door opens `{readonly: true}` with `query_only = ON` and PREFLIGHTS the
 * table instead.
 *
 * THE `existsSync` PREFLIGHT SURVIVES THAT, AND IS NOW BELT RATHER THAN
 * BRACES. It used to be the ONLY thing standing between a `/api/context-docs`
 * request and a materialised 20 KB SQLite file where the operator had none —
 * caught by `dashboard-layers-endpoint.test.ts` T1, where such a request
 * conjured the brain and made every later endpoint report "no such table:
 * brief_status" instead of "brain database not found". `openBrainReadonly`'s
 * `fileMustExist: true` now enforces the same thing at the connection, so the
 * two fences are independent: this one keeps the check legible at the call
 * site, and it is what still answers `false` (rather than `[]`) if the reader
 * below is ever swapped back.
 *
 * Returns false (never throws) when the registry itself is unreadable; the
 * caller turns that into a degraded response.
 */
export function isKnownProject(slug: string): boolean {
  if (slug.length === 0) return false;
  if (!existsSync(brainDbPath())) return false;
  try {
    return listProjectsReadonly().some((p) => p.slug === slug);
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

// ---------------------------------------------------------------------------
// FR-246 — the `q` body grep
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on the TOTAL bytes one grep request may read.
 *
 * `readDoc` already bounds each doc at {@link MAX_DOC_BYTES}, but a per-item
 * bound is not a request bound: five registered types at 2 MB each is 10 MB of
 * synchronous `readFileSync` per keystroke-driven request. This is the second
 * fence, on the axis the first one does not cover.
 */
export const MAX_GREP_TOTAL_BYTES = 4 * 1024 * 1024;

/** Matches kept per doc. Beyond this the answer is "yes, and a lot". */
export const MAX_MATCHES_PER_DOC = 5;

/** Characters of context around a hit. */
export const SNIPPET_CHARS = 160;

/** One grep hit: the 1-based line it was on, and a bounded excerpt. */
export interface DocMatch {
  line: number;
  snippet: string;
}

/** What {@link grepDocs} found for one doc type. */
export interface DocGrepHit {
  type: string;
  matches: DocMatch[];
  /** True when the doc had more matches than {@link MAX_MATCHES_PER_DOC}. */
  more: boolean;
}

/**
 * Substring-grep the BODIES of a project's existing context docs.
 *
 * **This is grep, and the payload says grep.** Five registered types of prose
 * on disk is not a retrieval problem — there is no `context_docs` table, no FTS
 * and no embedding, and building any of those to rank five files would be
 * ceremony. What would be dishonest is dressing the result up as recall, which
 * is why the payload carries `search.mode: "substring"` and the UI renders it
 * through the same component that renders a real `RetrievalReport`.
 *
 * EVERY BYTE IS READ THROUGH {@link readDoc}, deliberately, so the three fences
 * it already owns apply unchanged: the registry-validated slug, the target
 * taken from the DIGEST ROW rather than from user input, and the
 * realpath+commonpath guard against a symlink planted in a directory the
 * operator writes. A second read path here would be a second place to get that
 * wrong.
 *
 * Bounded on three axes: EXISTING docs only, {@link MAX_GREP_TOTAL_BYTES}
 * across the request, and {@link MAX_MATCHES_PER_DOC} snippets of
 * {@link SNIPPET_CHARS} each.
 *
 * Never throws: an unreadable doc is skipped, because one bad file must not
 * turn a search into an error page.
 */
export function grepDocs(
  slug: string,
  q: string,
  rows: readonly { type: string; exists: boolean }[],
): DocGrepHit[] {
  const needle = q.toLowerCase();
  if (needle.length === 0) return [];

  const hits: DocGrepHit[] = [];
  let budget = MAX_GREP_TOTAL_BYTES;

  for (const row of rows) {
    if (!row.exists) continue;
    if (budget <= 0) break;

    const doc = readDoc(slug, row.type);
    if (!doc.ok) continue;
    budget -= doc.bytes;

    const matches: DocMatch[] = [];
    let more = false;
    const lines = doc.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const at = lines[i].toLowerCase().indexOf(needle);
      if (at === -1) continue;
      if (matches.length >= MAX_MATCHES_PER_DOC) {
        more = true;
        break;
      }
      // Centre the excerpt on the hit rather than taking the line's head: a
      // match 400 characters into a paragraph would otherwise produce a snippet
      // that does not contain the thing the operator searched for.
      const start = Math.max(0, at - Math.floor(SNIPPET_CHARS / 2));
      const raw = lines[i].slice(start, start + SNIPPET_CHARS);
      matches.push({
        line: i + 1,
        snippet: `${start > 0 ? "…" : ""}${raw.trim()}${
          start + SNIPPET_CHARS < lines[i].length ? "…" : ""
        }`,
      });
    }

    if (matches.length > 0) hits.push({ type: row.type, matches, more });
  }

  return hits;
}
