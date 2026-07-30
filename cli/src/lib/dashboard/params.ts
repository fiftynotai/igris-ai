/**
 * FR-240 — PURE query-parameter normalisation for the dashboard's layer
 * endpoints.
 *
 * THIS FILE CONTAINS ZERO SQL AND DOES NO I/O. Both are mechanically asserted
 * by `dashboard-server.test.ts`'s scope scan, which FR-240 extends to cover it —
 * a new server-layer file outside that scan is an unguarded file.
 *
 * WHY A SEPARATE MODULE. Nine endpoints each need the same four decisions:
 * clamp `limit`, floor `offset`, accept-or-drop an enum filter, and refuse an
 * unknown one. Inlining that in `routes.ts` would add ~40 branches to a file
 * whose whole justification is that it has none — and none of them would be
 * unit-testable without starting a server. Here they are pure functions over
 * `URLSearchParams`, so the edge cases (`limit=abc`, `limit=-1`,
 * `limit=1e9`, `offset=1.7`, a repeated key) are covered by
 * `dashboard-params.test.ts` with no socket in sight.
 *
 * THE POSTURE IS DROP-AND-REPORT, NOT REJECT. A garbage `limit` clamps to the
 * default and is NAMED in `rejected[]`, rather than 400-ing. Two reasons: the
 * FR-238 degraded contract says an endpoint answers 200 with a stated problem,
 * and a personal lens whose URL bar can 400 is a lens that punishes typing. The
 * ONE exception is a missing REQUIRED identifier (`project`+`id` on a detail
 * route) — see `routes.ts`, where an ambiguous identity must refuse rather than
 * silently first-match (BR-078).
 */

/** Hard ceiling on `limit`. Above this a "page" stops being a page. */
export const MAX_LIMIT = 200;
/** Default page size when `limit` is absent or unusable. */
export const DEFAULT_LIMIT = 50;

/** A normalised page window plus everything that was refused getting there. */
export interface PageParams {
  limit: number;
  offset: number;
  /** Human-readable notes about dropped/clamped inputs. Empty when clean. */
  rejected: string[];
}

/**
 * Parse and clamp `limit` / `offset`.
 *
 * `limit` is clamped to `1..MAX_LIMIT` — note there is deliberately NO
 * "0 means all" escape hatch here, unlike the brain's own `igris_brief_list`
 * (`briefs-read.ts:61`). A browser endpoint that can be asked for 615 briefs
 * with their `brief_files` rows is a denial-of-service on the operator's own
 * loopback, and D7 exists to keep list payloads bounded.
 */
export function parsePageParams(
  search: URLSearchParams,
  defaults: { limit?: number } = {},
): PageParams {
  const rejected: string[] = [];
  const fallbackLimit = defaults.limit ?? DEFAULT_LIMIT;

  let limit = fallbackLimit;
  const rawLimit = search.get("limit");
  // An EMPTY value is "no limit given", not "limit=0" — the same rule
  // `parseFilters` applies to a cleared control below, and for the same reason:
  // `?limit=` is what a UI emits when the field is blanked. Without this,
  // `Number("")` is 0, which clamped to 1 and was REPORTED as rejected, so
  // blanking the box returned one row and blamed the operator for asking.
  if (rawLimit !== null && rawLimit.length > 0) {
    const n = Number(rawLimit);
    if (!Number.isFinite(n)) {
      rejected.push(`limit: not a number (${rawLimit}), using ${fallbackLimit}`);
    } else if (n < 1) {
      limit = 1;
      rejected.push(`limit: clamped up to 1 (asked ${rawLimit})`);
    } else if (n > MAX_LIMIT) {
      limit = MAX_LIMIT;
      rejected.push(`limit: clamped down to ${MAX_LIMIT} (asked ${rawLimit})`);
    } else {
      limit = Math.floor(n);
    }
  }

  let offset = 0;
  const rawOffset = search.get("offset");
  if (rawOffset !== null && rawOffset.length > 0) {
    const n = Number(rawOffset);
    if (!Number.isFinite(n)) {
      rejected.push(`offset: not a number (${rawOffset}), using 0`);
    } else if (n < 0) {
      rejected.push(`offset: clamped up to 0 (asked ${rawOffset})`);
    } else {
      offset = Math.floor(n);
    }
  }

  return { limit, offset, rejected };
}

/** The outcome of allowlisting a single enum-valued filter. */
export interface FilterResult {
  /** Accepted values, keyed by param name. Absent keys were not supplied. */
  values: Record<string, string>;
  /** Human-readable notes about dropped values and unknown params. */
  rejected: string[];
}

/** One filter's name and the exact set of values it accepts. */
export interface FilterSpec {
  name: string;
  /**
   * `null` = accept any non-empty string (used for free-form identifiers like
   * `project`, whose value space is the registry, not a fixed vocabulary).
   */
  allowed: readonly string[] | null;
}

/**
 * Apply an allowlist to the supplied query params.
 *
 * A value outside the allowlist is DROPPED and named — never passed through.
 * That is the property that keeps a filter value from reaching a SQL
 * parameter position with an unvetted vocabulary, and it is why the brain-side
 * readers can bind these directly.
 *
 * `ignore` names params the caller handles itself (`limit`, `offset`, `q`, …).
 * Anything else present in the query string is reported as unknown, so a
 * mistyped `?catgory=pattern` surfaces instead of silently returning
 * everything — the exact failure a permissive parser hides.
 */
export function parseFilters(
  search: URLSearchParams,
  specs: readonly FilterSpec[],
  ignore: readonly string[] = [],
): FilterResult {
  const values: Record<string, string> = {};
  const rejected: string[] = [];
  const known = new Set<string>([...specs.map((s) => s.name), ...ignore]);

  for (const spec of specs) {
    const raw = search.get(spec.name);
    if (raw === null) continue;
    if (raw.length === 0) {
      // An empty value is "no filter", not "match the empty string". A cleared
      // UI control emits exactly this.
      continue;
    }
    if (spec.allowed !== null && !spec.allowed.includes(raw)) {
      rejected.push(
        `${spec.name}: "${raw}" is not one of ${spec.allowed.join(", ")}`,
      );
      continue;
    }
    values[spec.name] = raw;
  }

  for (const key of new Set(search.keys())) {
    if (!known.has(key)) rejected.push(`unknown filter: ${key}`);
  }

  return { values, rejected };
}

// ---------------------------------------------------------------------------
// Filter vocabularies
//
// These are DISPLAY-LAYER allowlists, not schema mirrors. `brief_status.status`
// and `.priority` have no CHECK constraint in the brain, and `/hunt` has grown
// the vocabulary before — so an allowlist that claimed to be canonical would
// silently hide rows the moment a new value appeared. Instead the two free-form
// ones are `null` (accept anything non-empty) and only the genuinely closed
// vocabularies are enumerated.
// ---------------------------------------------------------------------------

/** `learnings.category` — a real CHECK constraint in the brain schema. */
export const LEARNING_CATEGORIES = [
  "pattern",
  "decision",
  "discovery",
  "mistake",
  "optimization",
] as const;

/** `learnings.scope` — a real CHECK constraint. */
export const LEARNING_SCOPES = ["local", "global"] as const;

/**
 * `learnings.provenance` — enforced at the handler layer
 * (`memory.ts` `VALID_LEARNING_PROVENANCE`, FR-107).
 */
export const LEARNING_PROVENANCE = [
  "observed",
  "inferred",
  "synthesized",
  "ambiguous",
  "human_asserted",
] as const;

/**
 * `learnings.review_status` — FR-109's perception gate
 * (`memory.ts` `VALID_REVIEW_STATUS`).
 *
 * D9: the lens exposes this as a READ filter defaulting to `approved`. FR-241
 * owns triage; there is no approve/reject control on this surface.
 */
export const LEARNING_REVIEW_STATUS = ["pending_review", "approved"] as const;

/** `goals.status` — mirrors `VALID_GOAL_STATUSES` (goals/handlers.ts:42). */
export const GOAL_STATUSES = ["active", "achieved", "abandoned", "deferred"] as const;

/** The four brief filters. `status`/`priority`/`effort`/`brief_type` are open. */
export const BRIEF_FILTERS: readonly FilterSpec[] = [
  { name: "project", allowed: null },
  { name: "status", allowed: null },
  { name: "priority", allowed: null },
  { name: "effort", allowed: null },
  { name: "brief_type", allowed: null },
];

/** The five learning filters. */
export const LEARNING_FILTERS: readonly FilterSpec[] = [
  { name: "project", allowed: null },
  { name: "category", allowed: LEARNING_CATEGORIES },
  { name: "scope", allowed: LEARNING_SCOPES },
  { name: "provenance", allowed: LEARNING_PROVENANCE },
  { name: "review_status", allowed: LEARNING_REVIEW_STATUS },
];

/** The two goal filters. */
export const GOAL_FILTERS: readonly FilterSpec[] = [
  { name: "project", allowed: null },
  { name: "status", allowed: GOAL_STATUSES },
];

/**
 * Max accepted search-query length. Mirrors `MAX_QUERY_LENGTH`
 * (`brain-mcp-server/src/tools/memory.ts:39`) so the endpoint refuses exactly
 * what the brain would refuse, instead of forwarding a 10 001-character query
 * and surfacing the brain's validation string as a mystery.
 */
export const MAX_QUERY_LENGTH = 10000;

/** The outcome of validating a search `q`. */
export type QueryResult =
  | { ok: true; query: string }
  | { ok: false; reason: string };

/**
 * Validate the search query.
 *
 * This one DOES refuse rather than degrade: a search with no query is not a
 * search with a default, and silently returning the unfiltered corpus for
 * `?q=` would look exactly like a search that matched everything.
 */
export function parseQuery(search: URLSearchParams): QueryResult {
  const raw = search.get("q");
  if (raw === null || raw.length === 0) {
    return { ok: false, reason: "query parameter 'q' is required" };
  }
  if (raw.length > MAX_QUERY_LENGTH) {
    return {
      ok: false,
      reason: `query must be 1-${MAX_QUERY_LENGTH} characters (got ${raw.length})`,
    };
  }
  return { ok: true, query: raw };
}
