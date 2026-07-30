/**
 * FR-240 — **every decision the four layer views make that is worth
 * asserting.** PURE: no React, no DOM, no fetch, no clock.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A MODEL MODULE AT ALL
 * ─────────────────────────────────────────────────────────────────────────
 * Four views, one shared list/detail component family (AC #5). The thing that
 * differs per layer is DATA — which filters exist, which query params they
 * become, how a record is addressed, what "empty" means here. If that data
 * lives inside the components, then testing it means rendering them; if it
 * lives here, it is a table and a few pure functions, and the node vitest env
 * can assert all of it with no browser.
 *
 * So the rule for this file: **anything a reviewer might get wrong lives here,
 * not in a `.tsx`.** The components are arrangement.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * D5 — A RECORD IS ADDRESSED BY THE (type, project, id) TRIPLE
 * ─────────────────────────────────────────────────────────────────────────
 * `#/layers/<layer>/<project>/<id>`, three URL segments, each
 * `encodeURIComponent`-ed. NOT the composite node key.
 *
 * BR-078 is the reason and it is not hypothetical: `BR-001` names a DIFFERENT
 * brief in 25 projects, and 75% of briefs were fusing across projects before it
 * was fixed. An `id`-only route would reintroduce exactly that defect one layer
 * up, in the surface an operator uses to READ their work.
 *
 * And the composite key is deliberately NOT ported here.
 * `graph-keys.ts:26-29` says "Consumers should read the structured fields and
 * treat `key` as an opaque handle", and `node.type` / `node.project` / `node.id`
 * are already in the `/api/graph` payload. Porting `encodeNodeKey` would make a
 * FOURTH mirror of the escaping rules (MAINTAINING row 105) and drag every
 * future route change into that row for no gain. The key is passed around as an
 * opaque string where the graph needs it, and parsed nowhere.
 */

import type {
  ContextDocsPayload,
  GoalListRowPayload,
  GraphNode,
} from "../lib/api";

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export const LAYER_IDS = ["briefs", "learnings", "context-docs", "goals"] as const;
export type LayerId = (typeof LAYER_IDS)[number];

export interface LayerDescriptor {
  id: LayerId;
  /** Nav label. */
  label: string;
  /** The `// EYE` line above the list. */
  eye: string;
  /** One line under the heading, stating what this layer IS. */
  lede: string;
  /**
   * The graph node type this layer's records appear as, or `null`.
   *
   * `null` for context docs: they are FILES on disk (D8 — no brain involvement
   * at all), so they have no node in the brain graph and therefore no
   * LOCATE IN GRAPH action. That absence is a fact about the data model, not a
   * missing feature.
   */
  nodeType: string | null;
  /** Whether a record here is scoped to a project (BR-078) or globally unique. */
  projectScoped: boolean;
}

export const LAYERS: readonly LayerDescriptor[] = [
  {
    id: "briefs",
    label: "Briefs",
    eye: "// BRIEFS",
    lede:
      "Every brief the brain holds, newest first. The body is the filed brief, rendered.",
    nodeType: "brief",
    projectScoped: true,
  },
  {
    id: "learnings",
    label: "Learnings",
    eye: "// LEARNINGS",
    lede:
      "The brain's learnings. Search runs the brain's own hybrid recall — BM25 and vector, merged.",
    nodeType: "learning",
    projectScoped: true,
  },
  {
    id: "context-docs",
    label: "Context",
    eye: "// CONTEXT DOCS",
    lede:
      "Per-project context docs, with the applicable ones that are still missing.",
    nodeType: null,
    projectScoped: true,
  },
  {
    id: "goals",
    label: "Goals",
    eye: "// GOALS",
    lede: "Goals, by deadline. Each one lists the briefs serving it.",
    // Goals ARE in the brain graph, but their id is a brain-allocated global
    // `GL-XXX` sequence, so unlike a brief they are not project-scoped.
    nodeType: "goal",
    projectScoped: false,
  },
];

const BY_ID = new Map<LayerId, LayerDescriptor>(LAYERS.map((l) => [l.id, l]));

export function layerById(id: string): LayerDescriptor | null {
  return BY_ID.get(id as LayerId) ?? null;
}

/** The layer that shows a given graph node type, or `null` if none does. */
export function layerForNodeType(type: string): LayerDescriptor | null {
  return LAYERS.find((l) => l.nodeType === type) ?? null;
}

// ---------------------------------------------------------------------------
// D5 — the address codec
// ---------------------------------------------------------------------------

/**
 * A record's address: the layer plus the `(project, id)` half of the triple.
 *
 * `project` is `null` for a globally-addressed record (a goal). It is NOT the
 * empty string, so "global" and "a project literally named nothing" cannot be
 * confused at the type level.
 */
export interface RecordAddress {
  layer: LayerId;
  project: string | null;
  id: string;
}

/** A graph node's identity, as the payload already carries it. */
export interface NodeTriple {
  type: string;
  project: string | null;
  id: string;
}

/**
 * `#/layers/<layer>/<project>/<id>`.
 *
 * A global record encodes an EMPTY middle segment — the same convention the
 * brain's own composite key uses ("empty middle segment = global"), rather than
 * a sentinel like `-` that a real project slug could one day collide with.
 */
export function recordHash(addr: RecordAddress): string {
  return `#/layers/${addr.layer}/${encodeURIComponent(addr.project ?? "")}/${encodeURIComponent(addr.id)}`;
}

/** `#/layers/<layer>` — the list, no record selected. */
export function layerHash(layer: LayerId): string {
  return `#/layers/${layer}`;
}

/**
 * Parse the layers route out of a location hash.
 *
 * Returns the layer (defaulting to the first) and the address if one is
 * present. A malformed tail yields `address: null` rather than a guessed
 * address — an ambiguous identity must not resolve to a first match (BR-078).
 */
export function parseLayersHash(hash: string): {
  layer: LayerId;
  address: RecordAddress | null;
} {
  const path = hash.replace(/^#\/?/, "").split("?")[0] ?? "";
  const segs = path.split("/");
  // segs[0] is "layers" — the caller has already established the route.
  const layer = layerById(segs[1] ?? "")?.id ?? (LAYER_IDS[0] as LayerId);
  if (segs.length < 4) return { layer, address: null };

  const project = safeDecode(segs[2] ?? "");
  const id = safeDecode(segs[3] ?? "");
  if (id === null || project === null || id.length === 0) {
    return { layer, address: null };
  }
  return {
    layer,
    address: { layer, project: project.length > 0 ? project : null, id },
  };
}

/**
 * `#/graph?focus=<type>/<project>/<id>` — the LOCATE IN GRAPH direction.
 *
 * Same triple, same encoding, in a query value rather than a path so the graph
 * route stays a single segment.
 */
export function graphFocusHash(triple: NodeTriple): string {
  return `#/graph?focus=${encodeURIComponent(triple.type)}/${encodeURIComponent(triple.project ?? "")}/${encodeURIComponent(triple.id)}`;
}

/**
 * Read one query parameter's value WITHOUT percent-decoding it.
 *
 * `URLSearchParams.get` decodes, and that is wrong here: the three focus
 * segments are individually `encodeURIComponent`-ed, so a project slug
 * containing a slash arrives as `%2F`. Decoding the whole value first turns
 * that `%2F` back into a `/` — indistinguishable from a segment separator — and
 * a three-part triple silently parses as four parts. Which is to say: decoding
 * too early re-creates the BR-078 fusion in the router.
 */
function rawParam(query: string, name: string): string | null {
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq) === name) return pair.slice(eq + 1);
  }
  return null;
}

/** Parse `focus=` out of a hash. `null` when absent or malformed. */
export function parseGraphFocus(hash: string): NodeTriple | null {
  const q = hash.indexOf("?");
  if (q === -1) return null;
  const raw = rawParam(hash.slice(q + 1), "focus");
  if (raw === null) return null;
  const segs = raw.split("/");
  if (segs.length !== 3) return null;
  const type = safeDecode(segs[0] as string);
  const project = safeDecode(segs[1] as string);
  const id = safeDecode(segs[2] as string);
  if (type === null || project === null || id === null) return null;
  if (type.length === 0 || id.length === 0) return null;
  return { type, project: project.length > 0 ? project : null, id };
}

/**
 * `decodeURIComponent` that answers `null` instead of throwing.
 *
 * A hand-edited or truncated URL (`%`, `%zz`) is a `URIError`, and an
 * unhandled throw inside a router turns a typo in the address bar into a blank
 * page.
 */
function safeDecode(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** The `LOCATE IN GRAPH` href for a record, or `null` if it has no node. */
export function graphHrefForRecord(addr: RecordAddress): string | null {
  const layer = layerById(addr.layer);
  if (layer === null || layer.nodeType === null) return null;
  return graphFocusHash({
    type: layer.nodeType,
    project: addr.project,
    id: addr.id,
  });
}

/**
 * The `OPEN RECORD` href for a graph node, or `null` if no layer shows it.
 *
 * `null` is the common case and must render as an explicit "no detail view"
 * state rather than a dead control: session, concept, decision and cluster
 * nodes are all real graph nodes with no FR-240 view. Saying so is information;
 * a blank panel is a bug report.
 */
export function recordHrefForNode(node: NodeTriple): string | null {
  const layer = layerForNodeType(node.type);
  if (layer === null) return null;
  return recordHash({
    layer: layer.id,
    project: layer.projectScoped ? node.project : null,
    id: node.id,
  });
}

/**
 * Find a node in a graph payload by its STRUCTURED triple.
 *
 * This is the D5 pay-off: the record view holds `(type, project, id)` and needs
 * the node's opaque `key` to ask `neighboursOf` about it. It gets there by
 * MATCHING FIELDS, so no key form is ever constructed browser-side.
 */
export function findNode(
  nodes: readonly GraphNode[],
  triple: NodeTriple,
): GraphNode | null {
  return (
    nodes.find(
      (n) =>
        n.type === triple.type &&
        n.id === triple.id &&
        // A global node's `project` is null on both sides; a project-scoped one
        // must match exactly. This is the comparison BR-078 exists to enforce.
        (n.project ?? null) === (triple.project ?? null),
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Filters
//
// MIRROR CONTRACT: the vocabularies below mirror
// `cli/src/lib/dashboard/params.ts`. That file is the ENFORCING copy — it drops
// a value outside its allowlist before it reaches a SQL parameter position.
// This copy exists only so the UI can render the right controls. A vocabulary
// change sweeps BOTH in the same commit; if they ever disagree, the server wins
// and the extra chip silently returns nothing (which is why they are annotated
// rather than "kept in sync by memory").
// ---------------------------------------------------------------------------

export interface FilterDef {
  /** Query-param name — identical to the server's. */
  name: string;
  /** Control label. */
  label: string;
  /**
   * The values this filter offers. `null` means "supplied at runtime" (the
   * project list comes from `/api/projects`; brief status/priority/effort come
   * from the rows the server returned, because the brain has no CHECK
   * constraint on them and `/hunt` has grown that vocabulary before).
   */
  options: readonly string[] | null;
  /** The value that is NOT a narrowing — omitted from the request. */
  fallback?: string;
}

/** `learnings.category` — a real CHECK constraint (params.ts:165). */
export const LEARNING_CATEGORIES = [
  "pattern",
  "decision",
  "discovery",
  "mistake",
  "optimization",
] as const;

/** `learnings.scope` — a real CHECK constraint (params.ts:174). */
export const LEARNING_SCOPES = ["local", "global"] as const;

/** `learnings.provenance` — FR-107, handler-enforced (params.ts:180). */
export const LEARNING_PROVENANCE = [
  "observed",
  "inferred",
  "synthesized",
  "ambiguous",
  "human_asserted",
] as const;

/**
 * `learnings.review_status` — FR-109's perception gate (params.ts:195).
 *
 * D9, operator-signed: this lens exposes it as a READ filter defaulting to
 * `approved`. Selecting `pending_review` shows those rows BEHIND A BANNER and
 * ships **no** approve/reject control — FR-241 owns triage. The default is
 * declared here as `fallback` so `hasActiveFilters` does not read the default
 * as a narrowing and show "no rows match this filter" for an untouched view.
 */
export const LEARNING_REVIEW_STATUS = ["approved", "pending_review"] as const;
export const DEFAULT_REVIEW_STATUS = "approved";

/** `goals.status` — mirrors `VALID_GOAL_STATUSES` (params.ts:198). */
export const GOAL_STATUSES = ["active", "achieved", "abandoned", "deferred"] as const;

/** `upcoming_days` — a UI convenience over the numeric filter routes.ts parses. */
export const GOAL_HORIZONS = ["7", "30", "90"] as const;

export const FILTERS: Record<LayerId, readonly FilterDef[]> = {
  briefs: [
    { name: "status", label: "status", options: null },
    { name: "priority", label: "priority", options: null },
    { name: "effort", label: "effort", options: null },
    { name: "brief_type", label: "type", options: null },
  ],
  learnings: [
    { name: "category", label: "category", options: LEARNING_CATEGORIES },
    { name: "scope", label: "scope", options: LEARNING_SCOPES },
    { name: "provenance", label: "provenance", options: LEARNING_PROVENANCE },
    {
      name: "review_status",
      label: "review",
      options: LEARNING_REVIEW_STATUS,
      fallback: DEFAULT_REVIEW_STATUS,
    },
  ],
  // The inventory is a complete per-project list from one digest call — there is
  // nothing to filter server-side, and inventing a client-side filter over 12
  // rows would be a control that looks like the others but means something else.
  "context-docs": [],
  goals: [
    { name: "status", label: "status", options: GOAL_STATUSES },
    { name: "upcoming_days", label: "due within", options: GOAL_HORIZONS },
  ],
};

/** Filter values, keyed by param name. An absent key is "not filtering". */
export type FilterValues = Readonly<Record<string, string>>;

/**
 * Is any filter narrowing the result set?
 *
 * A value equal to a filter's `fallback` is NOT narrowing. This is what keeps
 * the learnings view — which always sends `review_status=approved` — from
 * reporting "no rows match this filter" when the project simply has no
 * learnings. AC #6 hinges on that distinction.
 */
export function hasActiveFilters(layer: LayerId, values: FilterValues): boolean {
  return (FILTERS[layer] ?? []).some((def) => {
    const v = values[def.name];
    if (v === undefined || v.length === 0) return false;
    return v !== def.fallback;
  });
}

/**
 * Build the query string for a list request.
 *
 * Every filter value goes through `URLSearchParams`, so it is encoded, and only
 * KNOWN filter names are emitted — the server reports an unknown param in its
 * `params` array, and a UI that generated one would be reporting its own bug to
 * the operator.
 */
export function listQuery(input: {
  layer: LayerId;
  project: string | null;
  values: FilterValues;
  limit: number;
  offset: number;
}): URLSearchParams {
  const q = new URLSearchParams();
  if (input.project !== null && input.project.length > 0) {
    q.set("project", input.project);
  }
  for (const def of FILTERS[input.layer] ?? []) {
    const v = input.values[def.name];
    if (v !== undefined && v.length > 0) q.set(def.name, v);
  }
  q.set("limit", String(input.limit));
  q.set("offset", String(input.offset));
  return q;
}

/** Build the query string for `/api/learnings/search`. */
export function searchQuery(input: {
  query: string;
  project: string | null;
  values: FilterValues;
  limit: number;
}): URLSearchParams {
  const q = new URLSearchParams();
  q.set("q", input.query);
  if (input.project !== null && input.project.length > 0) {
    q.set("project", input.project);
  }
  // Only the filters the search endpoint accepts. `review_status` is one of
  // them; `category`/`scope`/`provenance` are dropped because the reader's
  // recall path does not bind them, and sending them would have the server
  // report them back as unknown.
  const review = input.values.review_status;
  if (review !== undefined && review.length > 0) q.set("review_status", review);
  q.set("limit", String(input.limit));
  return q;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** Page size. Mirrors `params.ts` `DEFAULT_LIMIT`; the server clamps anyway. */
export const PAGE_LIMIT = 50;
/** Search hits per request. Mirrors `routes.ts`'s search default. */
export const SEARCH_LIMIT = 20;

export interface PageState {
  limit: number;
  offset: number;
  total: number;
  count: number;
}

/** `SHOWING 51-100 OF 615` — computed once, rendered by every layer. */
export function pageLabel(page: PageState): string {
  if (page.total === 0) return "0 OF 0";
  const first = page.offset + 1;
  const last = page.offset + page.count;
  return `${first}-${last} OF ${page.total}`;
}

export function hasPrev(page: PageState): boolean {
  return page.offset > 0;
}

export function hasNext(page: PageState): boolean {
  return page.offset + page.count < page.total;
}

/** Clamped so a stale NEXT click cannot walk past the end. */
export function nextOffset(page: PageState): number {
  return Math.min(page.offset + page.limit, Math.max(page.total - 1, 0));
}

export function prevOffset(page: PageState): number {
  return Math.max(page.offset - page.limit, 0);
}

// ---------------------------------------------------------------------------
// AC #6 — the empty states, and the three cases they must tell apart
// ---------------------------------------------------------------------------

/**
 * Which "nothing to show" this is.
 *
 * The AC is explicit that ONE state for all of these is a fail, and the reason
 * is diagnostic: each one has a different next action. `degraded` means fix the
 * brain; `filtered` means widen the filter; `empty` means do the work; and
 * `no-project` means pick a scope. A single "nothing here" tells the operator
 * none of that and — worse — makes a broken brain look like an empty one.
 */
export type EmptyKind = "degraded" | "filtered" | "empty" | "no-project";

export interface EmptyCopy {
  kind: EmptyKind;
  /** Plain text; the caller wraps the `<em>` accent. */
  headline: string;
  message: string;
  /** The mono footer line. Carries the degraded reason VERBATIM when there is one. */
  meta: string;
}

/** Per-layer copy for the genuinely-empty case, naming the command that fills it. */
const NOTHING_YET: Record<LayerId, string> = {
  briefs: "No briefs filed for this project yet. `/hunt` files the first one.",
  learnings:
    "No learnings recorded for this project yet. `/harvest` extracts them from a session.",
  "context-docs":
    "No context docs exist for this project yet. `/ground <type>` writes the first one.",
  goals: "No goals filed yet. Goals are created through the brain's goal tools.",
};

export function emptyStateFor(input: {
  layer: LayerId;
  /** Rows the server reported for the CURRENT request. */
  total: number;
  /** The server's `degraded.reason`, verbatim, or `null`. */
  degraded: string | null;
  /** Any narrowing filter is set (see `hasActiveFilters`). */
  filtersActive: boolean;
  /** The nav's client-side text mute is non-empty. */
  searchActive: boolean;
  /** The selected project, or `null` when none is selected yet. */
  project: string | null;
  /** True when this layer cannot be read without a project (context docs). */
  projectRequired?: boolean;
}): EmptyCopy {
  // 1. DEGRADED FIRST, unconditionally. A degraded brain that also has no rows
  //    is a degraded brain — reporting "nothing here yet" would be a lie with a
  //    reassuring tone, which is the worst of the four.
  if (input.degraded !== null) {
    return {
      kind: "degraded",
      headline: "the brain did not answer.",
      message:
        "This view is showing nothing because the read failed, not because there is nothing to show.",
      meta: input.degraded,
    };
  }

  if (input.projectRequired === true && input.project === null) {
    return {
      kind: "no-project",
      headline: "pick a project.",
      message:
        "Context docs live per project, on disk. Choose one above to read its inventory.",
      meta: "no project selected",
    };
  }

  // 2. FILTERED — the rows may well exist; this request excluded them.
  if (input.filtersActive || input.searchActive) {
    return {
      kind: "filtered",
      headline: "nothing matches this filter.",
      message:
        input.searchActive && !input.filtersActive
          ? "The text filter matched no row on this page. Clear it, or page through."
          : "Rows may exist outside this filter. Clear it to see the whole layer.",
      meta: input.searchActive
        ? "filtered · text mute active"
        : "filtered · no rows returned",
    };
  }

  // 3. GENUINELY EMPTY.
  return {
    kind: "empty",
    headline: "nothing here yet.",
    message: NOTHING_YET[input.layer],
    meta:
      input.project === null
        ? "0 rows · all projects"
        : `0 rows · ${input.project}`,
  };
}

// ---------------------------------------------------------------------------
// The nav's client-side text mute
// ---------------------------------------------------------------------------

/**
 * Filter the LOADED PAGE by substring, the way the graph's search mutes nodes.
 *
 * This is a `// QUICK` client-side mute over rows already in memory, NOT a
 * server query — and callers must label it as such, because it only sees the
 * current page. A control that looked like a search but silently searched 50 of
 * 615 rows would be worse than no control; the readout says
 * `MUTED n/m THIS PAGE` for exactly that reason.
 */
export function muteRows<T>(
  rows: readonly T[],
  search: string,
  fields: (row: T) => readonly (string | number | null | undefined)[],
): T[] {
  const q = search.trim().toLowerCase();
  if (q.length === 0) return [...rows];
  return rows.filter((row) =>
    fields(row).some(
      (f) => f !== null && f !== undefined && String(f).toLowerCase().includes(q),
    ),
  );
}

// ---------------------------------------------------------------------------
// Small per-layer readers, kept here so the views stay arrangement
// ---------------------------------------------------------------------------

/**
 * Split a comma-or-JSON tag string into chips.
 *
 * `learnings.tags` is TEXT in the brain and has been written both as a JSON
 * array and as a comma-separated list over the project's life. Rendering the
 * raw column would show `["a","b"]` to the operator, and guessing wrong would
 * show one chip called `["a"`.
 */
export function splitTags(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  const s = raw.trim();
  if (s.length === 0) return [];
  if (s.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(s);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v).trim()).filter((v) => v.length > 0);
      }
    } catch {
      /* not JSON after all — fall through to the comma split */
    }
  }
  return s
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** Days until a deadline; negative when overdue. `null` with no deadline. */
export function daysUntil(deadline: string | null, now: Date): number | null {
  if (deadline === null || deadline.length === 0) return null;
  const then = Date.parse(deadline);
  if (Number.isNaN(then)) return null;
  const MS_PER_DAY = 86_400_000;
  // Whole days, floored towards the past, so "today" is 0 and yesterday is -1.
  return Math.floor((then - now.getTime()) / MS_PER_DAY);
}

/** `OVERDUE 3d` / `DUE TODAY` / `IN 12d` / `NO DEADLINE`. */
export function deadlineLabel(goal: GoalListRowPayload, now: Date): string {
  const d = daysUntil(goal.deadline, now);
  if (d === null) return "NO DEADLINE";
  if (d < 0) return `OVERDUE ${Math.abs(d)}d`;
  if (d === 0) return "DUE TODAY";
  return `IN ${d}d`;
}

/**
 * The rows a context-doc inventory should show, and in what order.
 *
 * EXISTING docs first (they are readable), then applicable-but-missing (they are
 * the actionable gap), then the rest. Within each group, by type. The order is
 * here rather than in the view because "which docs matter" is a judgement and a
 * judgement should be assertable.
 */
export function orderInventory(
  payload: ContextDocsPayload,
): ContextDocsPayload["docs"] {
  const rank = (d: ContextDocsPayload["docs"][number]): number => {
    if (d.exists) return 0;
    if (d.missing_applicable) return 1;
    return 2;
  };
  return [...payload.docs].sort(
    (a, b) => rank(a) - rank(b) || (a.type < b.type ? -1 : 1),
  );
}
