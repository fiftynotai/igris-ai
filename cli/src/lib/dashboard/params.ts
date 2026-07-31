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

/** `suggestions.status` — a real CHECK constraint (`suggestions` DDL). */
export const SUGGESTION_STATUSES = ["pending", "dismissed", "acted"] as const;

/** `suggestions.priority` — a real CHECK constraint. */
export const SUGGESTION_PRIORITIES = ["high", "medium", "low"] as const;

/**
 * `project_scope` — the NON-project scopes on the project axis (TD-326).
 *
 * A SEPARATE param rather than a reserved `project` value, and the reason is
 * the drop-and-report posture above: `project`'s spec is `allowed: null`, so a
 * magic slug would be accepted verbatim by every OTHER endpoint and silently
 * match no row. An undeclared param IS reported (`unknown filter:
 * project_scope`), so 4 of the 10 OTHER project-bearing endpoints say so —
 * `/api/briefs`, `/api/learnings`, `/api/learnings/search`, `/api/goals`, the
 * ones routing through `parseFilters`. The other 6 are SILENT: `/api/summary`,
 * `/api/graph`, `/api/graph/stats` take `project` as a function argument, and
 * `/api/brief`, `/api/context-docs`, `/api/context-doc` hand-parse it — none
 * carries a `params` field. `/api/learning` and `/api/goal` are `id`-only and
 * not project-bearing at all. Enumerated against the router, endpoint by
 * endpoint. A silent IGNORE is still strictly better than the silent BIND a
 * magic `project` slug would get — that is the argument, and it does not
 * depend on the reporting being total.
 *
 * `brain-level` means `project_slug IS NULL`. It is NOT the unscoped read: that
 * one drops the predicate and is `everything`. Two different sets; a label that
 * picks the wrong one lies.
 */
export const PROJECT_SCOPES = ["brain-level"] as const;

/**
 * The five suggestion filters (FR-241, TD-326).
 *
 * `source_module` is `null` — accept ANY non-empty string. That is not laziness:
 * FR-118 M2 made the vocabulary OPEN (the LLM names the kind), so the brain
 * itself validates only "a non-empty string"
 * (`subconscious/handlers.ts` — "We do NOT reject against a closed enum"). An
 * allowlist here would silently hide every row whose module was invented after
 * this file was last edited. The UI gets its vocabulary from the payload's
 * `facets.source_module`, which is counted from the data (L-967).
 *
 * `status` and `priority` ARE enumerated, because those two are genuine CHECK
 * constraints — a value outside them cannot exist in the table, so dropping it
 * loses nothing and reports a typo.
 *
 * Note the param is named `project` here and mapped to the reader's
 * `project_slug`: every other dashboard endpoint spells it `project`, and a
 * surface where one page's scope param has a different name is a surface where
 * the shared project selector silently stops working on one tab.
 */
export const SUGGESTION_FILTERS: readonly FilterSpec[] = [
  { name: "project", allowed: null },
  { name: "project_scope", allowed: PROJECT_SCOPES },
  { name: "status", allowed: SUGGESTION_STATUSES },
  { name: "priority", allowed: SUGGESTION_PRIORITIES },
  { name: "source_module", allowed: null },
];

// ---------------------------------------------------------------------------
// FR-241 — the triage request body (the ONE mutating endpoint's input)
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on ids per POST.
 *
 * The real backlog is 1,188 pending suggestions across 19 projects. A surface
 * where one request can dismiss all of them, with no undo tool in the brain, is
 * one mis-click from an unrecoverable state — so the ids are clamped and the
 * clamp is REPORTED rather than silently applied.
 */
export const MAX_BULK = 200;

/** The parsed, validated body — or a stated reason it is a 400. */
export type TriageBodyResult =
  | {
      ok: true;
      action: string;
      ids: number[];
      reason?: string;
      brief_id?: string;
      /** Clamp/dedupe notes. Empty when the body was clean. */
      params: string[];
    }
  | { ok: false; reason: string };

/** Max accepted length for the free-text fields. */
const MAX_TEXT = 2000;

/**
 * Validate a `POST /api/triage` body. PURE — no I/O, no brain, no clock.
 *
 * THIS ONE REFUSES RATHER THAN DEGRADES, unlike every query-param parser above,
 * and the asymmetry is deliberate. A garbage `?limit=abc` is a browsing typo and
 * the right answer is to show the page. A garbage MUTATION body is a client bug,
 * and the right answer is to refuse — because the degrade-shaped alternative
 * ("drop the bad ids and apply the rest") would silently mutate a set the caller
 * did not ask for. A 400 here and a `degraded` 200 for a down brain keep those
 * two failures distinguishable, which is the whole point of having both.
 *
 * The ONE degrade-shaped behaviour is the `MAX_BULK` clamp, and it is NAMED in
 * `params` so the client can tell the operator that 250 became 200.
 *
 * @param body the parsed JSON body, or `undefined` when it did not parse
 * @param isKnownAction membership test over the frozen delegation map. Injected
 *   rather than imported so this module keeps its zero-dependency, zero-I/O
 *   property — and so the allowlist has exactly ONE definition, in the map.
 */
export function parseTriageBody(
  body: unknown,
  isKnownAction: (action: string) => boolean,
  opts: { bulkAllowed?: (action: string) => boolean } = {},
): TriageBodyResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  const action = b.action;
  if (typeof action !== "string" || action.length === 0) {
    return { ok: false, reason: "'action' is required and must be a string" };
  }
  if (!isKnownAction(action)) {
    return {
      ok: false,
      // The valid set is NOT interpolated here: it lives in the frozen map and
      // `/api/health` serves it. Two lists of the actions is one list too many.
      reason: `unknown action: ${action} — see /api/health write.actions for the accepted set`,
    };
  }

  const rawIds = b.ids;
  if (!Array.isArray(rawIds)) {
    return { ok: false, reason: "'ids' is required and must be an array" };
  }
  if (rawIds.length === 0) {
    // An empty batch is REFUSED rather than treated as a no-op success. A UI
    // that can fire an empty bulk action is a UI whose selection state is
    // wrong, and a 200/applied:0 would hide that — this is also the shape of
    // the vacuous "bulk-act on zero items" gate, so the server refuses to
    // participate in it.
    return { ok: false, reason: "'ids' must not be empty" };
  }

  const params: string[] = [];
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const raw of rawIds) {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
      return {
        ok: false,
        reason: `'ids' must contain only positive integers (got ${JSON.stringify(raw)})`,
      };
    }
    // Dedupe: dismissing the same id twice in one batch would report one
    // success and one "already dismissed" failure, and a `failed: 1` on a
    // request that fully succeeded is a lie the operator has to decode.
    if (seen.has(raw)) {
      params.push(`ids: dropped a duplicate id (${raw})`);
      continue;
    }
    seen.add(raw);
    ids.push(raw);
  }

  if (opts.bulkAllowed !== undefined && !opts.bulkAllowed(action) && ids.length > 1) {
    return {
      ok: false,
      reason: `action '${action}' is single-item only; got ${ids.length} ids`,
    };
  }

  if (ids.length > MAX_BULK) {
    params.push(
      `ids: clamped to ${MAX_BULK} (asked ${ids.length}); the rest were NOT applied`,
    );
    ids.length = MAX_BULK;
  }

  const text = (key: "reason" | "brief_id"): TriageBodyResult | string | undefined => {
    const v = b[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string") return { ok: false, reason: `'${key}' must be a string` };
    if (v.length > MAX_TEXT) {
      return { ok: false, reason: `'${key}' must be at most ${MAX_TEXT} characters` };
    }
    return v;
  };

  const reason = text("reason");
  if (typeof reason === "object") return reason;
  const briefId = text("brief_id");
  if (typeof briefId === "object") return briefId;

  // Unknown top-level keys are REFUSED, mirroring the gateway's TD-128 posture
  // one layer out: a client that sends `{action, ids, resaon}` has a typo whose
  // symptom would otherwise be a silently reason-less dismissal, and the
  // dismiss reason is the signal that stops the backlog re-growing.
  const KNOWN = new Set(["action", "ids", "reason", "brief_id"]);
  for (const key of Object.keys(b)) {
    if (!KNOWN.has(key)) {
      return {
        ok: false,
        reason: `unknown field: ${key}. Accepted: ${[...KNOWN].join(", ")}`,
      };
    }
  }

  return {
    ok: true,
    action,
    ids,
    ...(reason !== undefined ? { reason } : {}),
    ...(briefId !== undefined ? { brief_id: briefId } : {}),
    params,
  };
}

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
