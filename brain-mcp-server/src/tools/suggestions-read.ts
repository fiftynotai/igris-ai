/**
 * Igris Brain — Suggestion READ layer (pure, `db`-param).
 *
 * FR-241 Phase 1. The fourth instance of the pure-layer / MCP-wrapper split
 * that `whole-graph.ts` established (FR-237) and FR-240 made the default shape
 * for any brain read with a second consumer. The rule it exists to hold:
 *
 *   **This file MUST NOT import `../db.js`, and MUST NOT write.**
 *
 * Mechanically enforced by `__tests__/pure-read-purity.test.ts`.
 *
 * WHY THE SPLIT (the FR-241-specific reason)
 * ------------------------------------------
 * The dashboard's triage surface needs the pending-suggestion queue on a
 * `{readonly:true, query_only:ON}` handle. `handleSuggestionList` called
 * `getDb()`, which opens the brain READ-WRITE and migrates — so a *browse* of
 * the queue would have flipped the operator's brain into WAL and run migrations
 * before returning a row. Taking the handle as a parameter lets the FR-240 read
 * door serve this list while the SQL stays defined exactly ONCE.
 *
 * PROVENANCE
 * ----------
 * The SELECT, the `CASE priority` collation and the COUNT were MOVED verbatim
 * from `engine/components/subconscious/handlers.ts:166-216`
 * (`handleSuggestionList`, pre-lift line numbers). Pinned across the move by
 * `engine/components/subconscious/__tests__/suggestion-list-wire-parity.test.ts`,
 * whose snapshots were recorded BEFORE the lift.
 *
 * WHAT STAYED IN THE WRAPPER, and why (the FR-240 split rule)
 * -----------------------------------------------------------
 *  - **Argument validation and every validation MESSAGE.** Those strings are
 *    wire contracts; a reader that validated would be a second error vocabulary.
 *  - **`rowToSuggestion`** — the `evidence` JSON-parse-with-degradation mapping.
 *    It is presentation, and it is why {@link listSuggestions} returns rows with
 *    `evidence` still a raw string.
 *  - **`getDb()`** — the only call site, wrapper-side by definition.
 *  - **`limit` / `offset` clamping.** Callers pre-clamp (the same contract
 *    `goals/read.ts#ListGoalsOptions` states): the MCP wrapper applies its
 *    `min(limit, 1000)` policy, the dashboard applies `params.ts`'s `MAX_LIMIT`.
 *    Re-clamping here would silently change the `limit` the wrapper echoes.
 *
 * THE ONE ADDITION: `facets` (FR-241, L-967)
 * ------------------------------------------
 * `source_module` is an OPEN vocabulary since FR-118 M2 — the LLM names the
 * kind, so `gap`, `missing_followup`, `janitor`, `edge_inference` and whatever
 * comes next all appear in the data and in NO enum. A filter dropdown built from
 * a hand-list is a dropdown that hides rows. So the reader computes the
 * source_module counts FROM THE DATA, over the same WHERE **minus its own
 * clause** (otherwise selecting one module would collapse the dropdown to that
 * one module and strand the operator). The MCP wrapper does NOT emit this field
 * — adding it would break the wire golden — so it is a dashboard-only addition
 * that costs the MCP callers nothing.
 *
 * TD-326 added the second facet, `brain_level`, on the same argument one axis
 * over: `project_slug` is NULLABLE, 377 pending rows carry NULL (synapse's
 * `edge_inference` output), and a project-scoped read can neither list them nor
 * mention them. `project_is_null` makes that population addressable and
 * `facets.brain_level` makes it VISIBLE from inside another project's scope.
 *
 * CONSUMERS (MAINTAINING — the pure `db`-param READ layer row)
 * ------------------------------------------------------------
 * `engine/components/subconscious/handlers.ts#handleSuggestionList` (the MCP
 * wrapper) · `cli/src/lib/brain-bridge.ts` (type facade + runtime import) ·
 * `cli/src/lib/dashboard/routes.ts`. A change to a signature or a returned row
 * shape MUST sweep all of them in the same commit.
 *
 * @module tools/suggestions-read
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import { WhereBuilder } from '../engine/helpers.js';
import {
  likePattern,
  substringReport,
  LIKE_ESCAPE_CLAUSE,
} from '../utils/substring-search.js';
import type { SubstringSearchReport } from '../utils/substring-search.js';

/** The columns FR-246's `q` filter searches. Named once; reported verbatim. */
const SUGGESTION_SEARCH_FIELDS = ['title', 'evidence'];

// ---------------------------------------------------------------------------
// Row and option shapes
// ---------------------------------------------------------------------------

/**
 * Filters and pagination accepted by {@link listSuggestions}.
 *
 * `undefined` means "no filter" for every field — that is `WhereBuilder.add`'s
 * contract (`helpers.ts:54-59`) and it is why the wrapper can forward
 * `args.status` straight through without a presence branch.
 */
export interface ListSuggestionsOptions {
  status?: string;
  project_slug?: string;
  /**
   * TD-326 — match ONLY rows whose `project_slug IS NULL` (the `brain-level`
   * population: synapse's edge inferences belong to the brain, not a project).
   * When true it REPLACES `project_slug`, which cannot express `IS NULL` because
   * `WhereBuilder.add` treats `undefined` as "no filter".
   */
  project_is_null?: boolean;
  /** OPEN vocabulary since FR-118 M2 — any non-empty string is legitimate. */
  source_module?: string;
  priority?: string;
  /**
   * FR-246 — an honest SUBSTRING filter over `title` + `evidence`. Not
   * retrieval; the payload's `search` block says so.
   *
   * Proportionate because the queue is DRAINED, not recalled over: a suggestion
   * is triaged once and then dismissed or acted on. Population measured
   * read-only on the operator brain at **1,246 rows** — note that supersedes
   * the "377 rows brain-wide" figure carried in `routes.ts`'s comment and in
   * the FR-246 plan; the count more than tripled since it was written, which is
   * itself the argument for re-measuring rather than quoting.
   */
  q?: string;
  /** Pre-clamped by the caller. Defaults to 25 (the `igris_suggestion_list` default). */
  limit?: number;
  /** Pre-clamped by the caller. Defaults to 0. */
  offset?: number;
}

/**
 * One `suggestions` row exactly as stored.
 *
 * `evidence` is the RAW JSON string, not a parsed object: the parse-and-degrade
 * step is `rowToSuggestion`'s and lives in the wrapper. Mirrors
 * `engine/components/subconscious/types.ts:104` (`Suggestion`) column for
 * column; duplicated rather than imported so this module has no import edge
 * into the component it serves.
 */
export interface SuggestionRow {
  id: number;
  source_module: string;
  project_slug: string | null;
  title: string;
  /** JSON string in the DB. The wrapper parses it. */
  evidence: string;
  priority: string;
  status: string;
  created_at: string;
  expires_at: string | null;
  dismissed_at: string | null;
  dismissed_reason: string | null;
  acted_at: string | null;
  acted_brief_id: string | null;
  confidence: number | null;
  suggested_action: string | null;
  type_inferred: number;
}

/** Counts computed from the data, never from an enum (L-967). */
export interface SuggestionFacets {
  /**
   * `source_module` -> row count, over the active filters MINUS the
   * `source_module` clause itself. Insertion order is count DESC, then name
   * ASC, so a UI can render it without re-sorting.
   */
  source_module: Record<string, number>;
  /**
   * TD-326 — rows with `project_slug IS NULL`, over the active filters MINUS
   * the PROJECT clause (same minus-its-own-axis rule as `source_module`). So a
   * caller scoped to one project still learns how many rows belong to NO
   * project, which is the count the scoped view structurally cannot list. When
   * `project_is_null` is set this equals `total`.
   */
  brain_level: number;
}

/** The {@link listSuggestions} payload. */
export interface ListSuggestionsResult {
  suggestions: SuggestionRow[];
  count: number;
  total: number;
  limit: number;
  offset: number;
  facets: SuggestionFacets;
  /** Set when the `suggestions` table is absent (L-133); the arrays are empty. */
  degraded: string | null;
  /**
   * FR-246 D3-f — what the `q` filter actually did, or `null` when no `q` was
   * supplied. A PAYLOAD field, not a UI sentence, so a gate can assert it.
   * Appended LAST, leaving the pre-FR-246 key order untouched.
   */
  search: SubstringSearchReport | null;
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/**
 * L-133 preflight — same shape `memory-read.ts` uses. A brain DB where the
 * subconscious migration never ran must yield an empty result, never a throw,
 * and NEVER a `CREATE TABLE`.
 */
function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

/**
 * List suggestions with optional filters, priority-collated, with a `total`.
 *
 * SQL moved verbatim from `subconscious/handlers.ts:166-216`. The ordering is
 * `CASE priority` (high > medium > low) then `created_at DESC` — the collation
 * that makes `/awaken` pick up the most actionable items first, and the reason
 * this cannot be a plain `ORDER BY priority` (which would sort alphabetically:
 * high, low, medium).
 *
 * @param db - A connection. May be read-only; this function never writes.
 * @param opts - Filters + pre-clamped pagination.
 */
export function listSuggestions(
  db: Database.Database,
  opts: ListSuggestionsOptions = {},
): ListSuggestionsResult {
  const limit = opts.limit ?? 25;
  const offset = opts.offset ?? 0;

  if (!tableExists(db, 'suggestions')) {
    return {
      suggestions: [],
      count: 0,
      total: 0,
      limit,
      offset,
      facets: { source_module: {}, brain_level: 0 },
      degraded: 'brain table absent: suggestions',
      search: substringReport(opts.q, SUGGESTION_SEARCH_FIELDS),
    };
  }

  /** The project axis, in exactly one place. TD-326 gave it three states. */
  const scope = (b: WhereBuilder): WhereBuilder =>
    opts.project_is_null === true
      ? b.addAlways('project_slug IS NULL')
      : b.add('project_slug = ?', opts.project_slug);

  /**
   * FR-246 — the substring predicate, in exactly one place because THREE
   * queries need it (the page, the `source_module` facet and the `brain_level`
   * facet). Bound params + an explicit ESCAPE so `?q=%` matches a literal
   * per-cent sign instead of matching everything while looking like a filter.
   */
  const withQ = (b: WhereBuilder): WhereBuilder => {
    if (!opts.q || opts.q.trim() === '') return b;
    const pattern = likePattern(opts.q);
    return b.addAlways(
      `(LOWER(title) LIKE ? ${LIKE_ESCAPE_CLAUSE}` +
        ` OR LOWER(COALESCE(evidence, '')) LIKE ? ${LIKE_ESCAPE_CLAUSE})`,
      pattern,
      pattern,
    );
  };

  const where = withQ(
    scope(new WhereBuilder().add('status = ?', opts.status))
      .add('source_module = ?', opts.source_module)
      .add('priority = ?', opts.priority),
  );

  const rows = db
    .prepare(
      `SELECT * FROM suggestions
       ${where.toSQL()}
       ORDER BY
         CASE priority
           WHEN 'high' THEN 0
           WHEN 'medium' THEN 1
           ELSE 2
         END ASC,
         created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...where.values(), limit, offset) as SuggestionRow[];

  const countRow = db
    .prepare(`SELECT COUNT(*) AS total FROM suggestions ${where.toSQL()}`)
    .get(...where.values()) as { total: number };

  // The facet WHERE deliberately OMITS `source_module` — see the module header.
  //
  // `q` IS applied to both facets below, and that is a DELIBERATE DIVERGENCE
  // from the FR-246 plan, which asked for `q` to be excluded from
  // `brain_level` "for the same reason the project axis is". That reason does
  // not transfer, and the divergence is recorded rather than made quietly. The
  // existing rule is *each facet omits ITS OWN axis and keeps every other
  // filter*: `source_module` omits `source_module`, `brain_level` omits the
  // project axis because it REPLACES it with `IS NULL`. `q` is neither of those
  // axes. Excluding it would make `brain_level` read "40 brain-level rows
  // hidden by this scope" while the operator is looking at a list filtered to
  // three — a number about a population they are not looking at. Applying it
  // answers the question the badge actually poses: how many rows MATCHING WHAT
  // I TYPED is the project scope hiding.
  const facetWhere = withQ(
    scope(new WhereBuilder().add('status = ?', opts.status)).add(
      'priority = ?',
      opts.priority,
    ),
  );

  // ...and the brain-level facet omits the PROJECT axis instead, replacing it
  // with `IS NULL`. Same rule, other axis: a count that also applied the
  // caller's `project_slug` would be 0 for every scoped read and would tell the
  // operator nothing about the population the scope is hiding.
  const brainWhere = withQ(
    new WhereBuilder()
      .add('status = ?', opts.status)
      .addAlways('project_slug IS NULL')
      .add('source_module = ?', opts.source_module)
      .add('priority = ?', opts.priority),
  );
  const brainLevel = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM suggestions ${brainWhere.toSQL()}`)
      .get(...brainWhere.values()) as { n: number }
  ).n;

  const facetRows = db
    .prepare(
      `SELECT source_module AS name, COUNT(*) AS n
         FROM suggestions
         ${facetWhere.toSQL()}
        GROUP BY source_module
        ORDER BY n DESC, name ASC`,
    )
    .all(...facetWhere.values()) as { name: string | null; n: number }[];

  const sourceModule: Record<string, number> = {};
  for (const r of facetRows) {
    // `source_module` is NOT NULL in the schema, but a facet map is a display
    // surface and a NULL would render as the string "null" in a dropdown.
    sourceModule[r.name ?? ''] = r.n;
  }

  return {
    suggestions: rows,
    count: rows.length,
    total: countRow.total,
    limit,
    offset,
    facets: { source_module: sourceModule, brain_level: brainLevel },
    degraded: null,
    search: substringReport(opts.q, SUGGESTION_SEARCH_FIELDS),
  };
}
