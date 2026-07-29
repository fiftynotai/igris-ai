/**
 * Brain Engine v7.0 — Node → project resolution for graph traversal (BR-078)
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `entity_edges` addresses endpoints as `(type, id)` and carries NO project
 * column. `brief_id` is UNIQUE only per `(project, brief_id)`, so a two-part
 * address fuses every project that happens to use the same id — measured on the
 * live brain: 343 colliding brief ids across 1,297 of 1,726 rows, `BR-001` alone
 * living in 25 projects. `traversal.ts` used to walk that fused graph silently.
 * This module supplies the missing axis: which project(s) a `(type, id)` pair
 * actually lives in, and — given a fixed current node — which project the OTHER
 * end of an edge must be read as.
 *
 * THE RULE IS BORROWED, NOT INVENTED
 * ----------------------------------
 * `whole-graph.ts::resolveEdgeProjects` (FR-237) is the LAW for projecting an
 * `entity_edges` row onto the project axis. Traversal walks the SAME rows, so it
 * must reach the SAME verdict about which projects an edge connects — otherwise
 * `igris_graph_neighbors` and `igris_graph_brain` describe two different graphs.
 * `resolveHopProject` therefore evaluates FR-237's four branches and then asks
 * ONE extra question the whole-graph builder never has to: *is the instance
 * FR-237 resolved this edge onto the one we are standing on?*
 *
 * It reproduces the branch STRUCTURE faithfully but NOT byte-for-byte: there is
 * one deliberate, measured deviation on branch 4's replica cap. See
 * "THE ONE DELIBERATE DEVIATION" below — do not describe this module as
 * reproducing FR-237 verbatim.
 *
 * Let `A = P(near)`, `C = P(far)`, and `Pc` = the already-fixed project of the
 * node we are hopping FROM (`Pc ∈ A` whenever `|A| > 1`, because an ambiguous
 * seed is refused and every hop adopts a member):
 *
 *   | case                                    | FR-237 verdict            | here            |
 *   |-----------------------------------------|---------------------------|-----------------|
 *   | `|A| <= 1` and `|C| <= 1`               | br1: one instance, each   | TRAVERSE, far   |
 *   |                                         | endpoint keeps its own    | project `C[0]`  |
 *   |                                         | project (cross-project    | (or `null`)     |
 *   |                                         | edges are LEGITIMATE)     |                 |
 *   | `|A| <= 1`, `|C| > 1`, `Pc ∈ C`         | br2: adopt `Pc`           | TRAVERSE as `Pc`|
 *   | `|A| <= 1`, `|C| > 1`, `Pc ∉ C`         | br3: emit NOTHING         | UNRESOLVED      |
 *   | `|A| > 1`, `|C| <= 1`, `C[0] ∈ A`       | br2: adopt `C[0]` on BOTH | TRAVERSE if     |
 *   |                                         | sides                     | `Pc == C[0]`,   |
 *   |                                         |                           | else OTHER      |
 *   | `|A| > 1`, `|C| <= 1`, `C[0] ∉ A`/`null`| br3: emit NOTHING         | UNRESOLVED      |
 *   | `|A| > 1`, `|C| > 1`, `A ∩ C = {}`      | br4: dangling             | UNRESOLVED      |
 *   | `|A| > 1`, `|C| > 1`,                   | br4: one intra-project    | TRAVERSE as `Pc`|
 *   | `0 < |A ∩ C| <= maxEdgeReplicas`        | instance per candidate    | if `Pc ∈ A ∩ C`,|
 *   |                                         |                           | else OTHER      |
 *   | `|A| > 1`, `|C| > 1`,                   | br4: `over_replicated`    | TRAVERSE as `Pc`|
 *   | `|A ∩ C| > maxEdgeReplicas` (default 8) | — emits NOTHING, for      | if `Pc ∈ A ∩ C` |
 *   |                                         | ANY project               | **DIVERGES**    |
 *
 * THE ONE DELIBERATE DEVIATION — branch 4's replica cap
 * ------------------------------------------------------
 * `whole-graph.ts` sends branch 4 through `finaliseIntraProjectCandidates`,
 * which DROPS the edge entirely when `|A ∩ C| > maxEdgeReplicas` (default 8,
 * tunable 1..32 via `igris_graph_brain`'s `max_edge_replicas`) and reports it as
 * `over_replicated`. **This module applies no cap.** On such an edge
 * `igris_graph_neighbors` returns a neighbour for which `igris_graph_brain` has
 * no edge at all.
 *
 * DECIDED (BR-078, warden r1): do NOT apply the cap here. The argument:
 *
 *  1. `max_edge_replicas` is a REPLICATION-NOISE control. It bounds how many
 *     instances ONE source row may spawn in a whole-brain payload — a rendering
 *     and payload-size concern for FR-238/FR-239. Traversal emits AT MOST ONE
 *     instance per hop, by construction, so the quantity the cap governs cannot
 *     occur here. Porting it would import a mechanism to bound a number that is
 *     always 1.
 *  2. Applying it produces a perverse rule: *the more projects share an id, the
 *     FEWER neighbours you get* — and past the cap, none. A caller who correctly
 *     qualified their seed would silently lose real intra-project edges for the
 *     sole reason that OTHER projects also use that id. That is the fused-graph
 *     defect's mirror image, not its fix.
 *  3. The cap is CALLER-TUNABLE on the other tool. Honouring it would make a
 *     traversal's result depend on a parameter its own surface does not expose,
 *     and `igris_graph_brain({max_edge_replicas: 32})` would silently change what
 *     `igris_graph_neighbors` is "supposed" to agree with.
 *
 * MEASURED, not assumed: 41 of 427 live brief->brief edges sit in this regime
 * (`|A ∩ C| > 8`; the both-ambiguous population is 288, distribution peaking at
 * `|A ∩ C| = 2` with 177). It is a real divergence on real data, not a
 * hypothetical — which is exactly why it is asserted rather than left implicit.
 * The over-cap disagreement is PINNED BY TEST in
 * `graph-traversal.integration.test.ts` so neither side can be silently
 * "corrected" into the other later.
 *
 * WHY THE NEAR SIDE'S AMBIGUITY MATTERS (the case a `|C|`-only rule misses)
 * -------------------------------------------------------------------------
 * Take the live shape: `BR-001` exists in `proj-a` AND `proj-b`; `BR-009` exists
 * only in `proj-b`; one row says `BR-001 -> BR-009`. Read that row through
 * FR-237 and the far side's REAL column decides it: the edge is `proj-b`'s, on
 * both endpoints (verified against `resolveEdgeProjects` — it returns
 * `fromProject: 'proj-b'`). So standing on **A's** BR-001, this edge is not ours
 * and BR-009 must NOT appear. A rule that looked only at `|C| = 1` and adopted
 * `C[0]` would have traversed it and returned B's BR-009 as A's neighbour — a
 * fabricated cross-project bridge, the exact error class BR-078 exists to
 * remove, and a silent FORK from `igris_graph_brain`.
 *
 * THE THIRD VERDICT — `other_instance` — AND WHY IT IS NOT A LOSS
 * ---------------------------------------------------------------
 * Not traversing has two very different causes, and conflating them would make
 * the loss counter lie:
 *   - `unresolved` — the data genuinely cannot say which instance the edge
 *     meant. FR-237 emits nothing for anyone. A REAL loss; counted in
 *     `unresolved_hops`.
 *   - `other_instance` — the data says precisely which instance the edge meant,
 *     and it is not this one. FR-237 emits it, just elsewhere. NOT a loss, and
 *     NOT counted; counting it would overstate the residual and invite a reader
 *     to "fix" correct behaviour.
 *
 * **Replication cannot happen here.** FR-237's branch 4 replicates over `A ∩ C`;
 * this function picks at most the single candidate equal to `Pc`, so the visited
 * set cannot explode. A `(type, id)` still appears twice in one result if and
 * only if two project contexts were genuinely REACHED (A's BR-002 down A's
 * chain, B's BR-002 through a cross-project learning owned by B) — bounded
 * fan-out over REALISED paths, not replication over CANDIDATE projects. Those
 * two instances are genuinely different entities and each carries its `project`.
 *
 * SOUND, NOT COMPLETE — AND THE LOSS IS REPORTED
 * ----------------------------------------------
 * The `unresolved` verdict drops edges that describe a real relationship,
 * because the row does not say which project it meant. That information was
 * never in the row; the pre-BR-078 code hid the loss by returning ALL candidates
 * as though fused. Every traversal response therefore carries
 * `unresolved_hops`. An unreported loss would reproduce the original
 * `LABEL_SCHEMA` sin — an acknowledged omission with no signal.
 * `igris_graph_brain`'s `edge_resolution.ambiguous_unresolved` + `dangling`
 * measure the same loss brain-wide.
 *
 * WHY NOT IMPORT `resolveEdgeProjects` DIRECTLY
 * ---------------------------------------------
 * Its signature is edge-row-shaped, it requires a `ProjectIndex` that FR-237
 * builds by loading EVERY node row in the brain (absurd for a depth-1 query),
 * and it returns replica instances traversal must never produce. The anti-fork
 * mechanism is therefore a CROSS-TOOL CONSISTENCY TEST
 * (`graph-traversal.integration.test.ts`, BR-078 T7 — plus the two branch-4
 * cases either side of the replica cap in the same file)
 * asserting `igris_graph_neighbors` and `igris_graph_brain` agree on a
 * fabricated collision fixture — an import would not have caught a divergence
 * anyway, since the shapes differ.
 *
 * WHY THIS MODULE MUST NOT IMPORT `db.js`
 * ---------------------------------------
 * It takes a `db` handle as a parameter, copying the `visualization.ts` /
 * `whole-graph.ts` pure-layer precedent. The MCP-facing `getDb()` call stays in
 * `traversal.ts`.
 *
 * MEASURED COST
 * -------------
 * `brief_status`'s PK is `(project, brief_id)`, so `WHERE brief_id = ?` scans the
 * table. Lookups are memoised per call and bounded by `max_nodes <= 100` distinct
 * ids. Measured read-only against the live brain (2026-07-29): one
 * `depth=10, max_nodes=100, direction=both` neighbours traversal seeded on the
 * busiest colliding brief and returning the full 100 nodes runs in a median of
 * 2.57 ms (max 3.83 ms; one warm-up discarded, 9 samples). The stated follow-up
 * trigger is ~50 ms — above that, raise an index brief rather than adding an
 * `edges`-component migration that mutates the `briefs` component's table (a
 * layering violation). See `docs/architecture/graph_traversal.md`
 * §"Project axis & hop resolution" — that doc and this header must quote the
 * SAME run.
 *
 * @module engine/components/edges/node-project
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';

/**
 * DOC-CONSTANT for the reader, NOT a branch condition.
 *
 * Today only `brief` can yield `|P| > 1`: `brief_status` is
 * `UNIQUE(project, brief_id)`, while `learnings.id` / `errors.id` /
 * `sessions.id` are integer PKs, `goals.goal_id` is UNIQUE and `graph_nodes` is
 * `UNIQUE(node_type, node_external_id)` — all unambiguous by construction.
 *
 * `|P|` is nevertheless computed empirically for EVERY type. The logic must not
 * branch on this list, so a future colliding type is handled correctly with no
 * code change.
 */
export const PROJECT_SCOPED_TYPES = ['brief'] as const;

/** Per-type lookup plan. `params` is built from `(type, id)` at call time. */
interface LookupPlan {
  sql: string;
  params: (type: string, id: string) => unknown[];
}

/**
 * The one place a type is mapped to its project column.
 *
 * `CAST(id AS TEXT) = ?` for the three integer-PK types is the settled
 * `numericId` convention (MAINTAINING row #104): `entity_edges` stores those ids
 * as `String(id)`.
 *
 * A type absent from this map resolves to `[]` — permissive, never an error.
 */
const LOOKUP_PLANS: Record<string, LookupPlan> = {
  brief: {
    sql: 'SELECT project AS project FROM brief_status WHERE brief_id = ?',
    params: (_t, id) => [id],
  },
  learning: {
    sql: 'SELECT project AS project FROM learnings WHERE CAST(id AS TEXT) = ?',
    params: (_t, id) => [id],
  },
  error: {
    sql: 'SELECT project AS project FROM errors WHERE CAST(id AS TEXT) = ?',
    params: (_t, id) => [id],
  },
  session: {
    sql: 'SELECT project AS project FROM sessions WHERE CAST(id AS TEXT) = ?',
    params: (_t, id) => [id],
  },
  goal: {
    sql: 'SELECT project_slug AS project FROM goals WHERE goal_id = ?',
    params: (_t, id) => [id],
  },
  // Matches whole-graph.ts's concept/decision project source.
  concept: {
    sql: "SELECT json_extract(properties, '$.project') AS project FROM graph_nodes WHERE node_type = ? AND node_external_id = ?",
    params: (t, id) => [t, id],
  },
  decision: {
    sql: "SELECT json_extract(properties, '$.project') AS project FROM graph_nodes WHERE node_type = ? AND node_external_id = ?",
    params: (t, id) => [t, id],
  },
};

/** Empty-string and non-string project values normalise to `null` (= no owner). */
function normaliseProject(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * True for a SQLite error that means "this brain predates the column/table".
 *
 * BOTH forms must degrade, not throw. `goals` ships with FR-110, so an older
 * brain lacks the TABLE; and the traversal test fixtures create `learnings` /
 * `errors` / `sessions` WITHOUT a `project` COLUMN, which is the same
 * degradation in a different disguise. Anything else re-throws so a real bug
 * still surfaces (same posture as `resolveLabels`).
 */
function isSchemaAbsenceError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('no such table') || msg.includes('no such column');
}

/** Resolves the set of projects a `(type, id)` pair lives in. */
export type ProjectResolver = {
  /**
   * `P(type, id)` — the DISTINCT projects containing this entity, ascending by
   * slug with `null` (no owner) first, matching
   * `whole-graph.ts::buildProjectIndex`'s deterministic ordering.
   *
   * `[]` means the entity has no backing row anywhere (a phantom endpoint —
   * `whole-graph.ts`'s term; TD-310 orphans are the live population) or the
   * brain's schema cannot answer the question. Both are permissive by design.
   */
  projectsFor(type: string, id: string): Array<string | null>;
  /** Test hook: how many SQL lookups actually ran (memoisation evidence). */
  _queryCount(): number;
};

/**
 * Build a memoised project resolver over one `db` handle.
 *
 * Statements are prepared lazily, once per type, and cached; a type whose table
 * or project column is absent is marked unavailable and never re-prepared.
 * Results are memoised per `(type, id)` for the resolver's lifetime, which is
 * one tool call — so a `max_nodes = 100` traversal issues at most 100 lookups.
 */
export function createProjectResolver(db: Database.Database): ProjectResolver {
  const statements = new Map<string, Database.Statement | null>();
  const memo = new Map<string, Array<string | null>>();
  let queryCount = 0;

  /** `null` = this type cannot be resolved on this brain (absent table/column). */
  function statementFor(type: string): Database.Statement | null {
    if (statements.has(type)) return statements.get(type) ?? null;
    const plan = LOOKUP_PLANS[type];
    if (!plan) {
      statements.set(type, null);
      return null;
    }
    try {
      const stmt = db.prepare(plan.sql);
      statements.set(type, stmt);
      return stmt;
    } catch (err) {
      if (isSchemaAbsenceError(err)) {
        statements.set(type, null);
        return null;
      }
      throw err;
    }
  }

  return {
    projectsFor(type: string, id: string): Array<string | null> {
      // Memo key. The separator is an explicit ESCAPED NUL, never a literal
      // control byte: a literal one makes this file non-text, so `grep` and
      // `file` classify it as binary and SILENTLY skip it in drift sweeps (it
      // evaded exactly that during BR-078). Entity types and ids cannot contain
      // NUL, so `type\u0000id` is collision-free.
      const memoKey = `${type}\u0000${id}`;
      const cached = memo.get(memoKey);
      if (cached) return cached;

      const stmt = statementFor(type);
      if (!stmt) {
        memo.set(memoKey, []);
        return [];
      }

      const plan = LOOKUP_PLANS[type];
      let rows: Array<{ project: unknown }>;
      try {
        queryCount += 1;
        rows = stmt.all(...plan.params(type, id)) as Array<{ project: unknown }>;
      } catch (err) {
        if (!isSchemaAbsenceError(err)) throw err;
        statements.set(type, null);
        memo.set(memoKey, []);
        return [];
      }

      const seen = new Set<string | null>();
      const out: Array<string | null> = [];
      for (const r of rows) {
        const p = normaliseProject(r.project);
        if (seen.has(p)) continue;
        seen.add(p);
        out.push(p);
      }
      // Deterministic ordering: nulls first, then ascending by slug. Keeps the
      // ambiguity error message stable across runs.
      out.sort((a, b) => {
        if (a === b) return 0;
        if (a === null) return -1;
        if (b === null) return 1;
        return a < b ? -1 : 1;
      });

      memo.set(memoKey, out);
      return out;
    },

    _queryCount(): number {
      return queryCount;
    },
  };
}

/**
 * Why an edge was or was not walked from the current instance.
 *
 * - `traverse`      — this edge belongs to the instance we are standing on.
 * - `other_instance`— FR-237 resolves this edge onto a DIFFERENT instance of the
 *                     same `(type, id)`. Correctly not ours; NOT a loss.
 * - `unresolved`    — the data cannot say which instance it meant; FR-237 emits
 *                     nothing for anyone. A real loss — count it.
 */
export type HopVerdict = 'traverse' | 'other_instance' | 'unresolved';

/** Outcome of resolving the far side of one edge. */
export interface HopResolution {
  verdict: HopVerdict;
  /** The project to attribute the far endpoint to. Meaningful only on `traverse`. */
  project: string | null;
}

/** Set-membership over a candidate list (`null` is a legitimate member). */
function contains(set: Array<string | null>, value: string | null): boolean {
  return set.includes(value);
}

/**
 * Decide whether — and as which project — to walk one edge from a FIXED near end.
 *
 * FR-237's `resolveEdgeProjects` verdict, plus the "is that instance us?" test.
 * See the module header's branch table for the full case analysis and for why
 * the near endpoint's own ambiguity is load-bearing. Total; never throws.
 *
 * @param curProject      - The already-resolved project of the node we are
 *                          hopping FROM. `null` is legitimate (a phantom or
 *                          genuinely ownerless node) and satisfies no owner hint.
 * @param nearCandidates  - `P(curType, curId)` — the near endpoint's own
 *                          candidate set. Required because FR-237's verdict
 *                          depends on whether the near side is ambiguous, not
 *                          just on the far side.
 * @param farCandidates   - `P(otherType, otherId)`.
 */
export function resolveHopProject(
  curProject: string | null,
  nearCandidates: Array<string | null>,
  farCandidates: Array<string | null>,
): HopResolution {
  const nearAmbiguous = nearCandidates.length > 1;
  const farAmbiguous = farCandidates.length > 1;
  const farFixed = farCandidates.length === 1 ? farCandidates[0] : null;

  // --- Branch 1: neither endpoint ambiguous. --------------------------------
  // One instance, each endpoint keeping its OWN project. A cross-project edge is
  // legitimate here (a learning owned by B linked to A's brief) and is
  // deliberately NOT forced intra-project. `|C| = 0` is a phantom far endpoint:
  // traverse with `null`, the pre-BR-078 behaviour.
  if (!nearAmbiguous && !farAmbiguous) {
    return { verdict: 'traverse', project: farFixed };
  }

  // --- Branch 2/3: exactly one endpoint ambiguous. --------------------------
  if (nearAmbiguous !== farAmbiguous) {
    if (farAmbiguous) {
      // The near side is fixed and its project is the hint.
      if (curProject !== null && contains(farCandidates, curProject)) {
        return { verdict: 'traverse', project: curProject }; // branch 2
      }
      return { verdict: 'unresolved', project: null }; // branch 3
    }

    // The NEAR side is the ambiguous one; the far side's REAL column is the
    // hint, and FR-237 adopts it on BOTH endpoints. So the edge belongs to
    // exactly one instance of the near id — ours only if we ARE that instance.
    if (farFixed !== null && contains(nearCandidates, farFixed)) {
      return curProject === farFixed
        ? { verdict: 'traverse', project: farFixed }
        : { verdict: 'other_instance', project: null };
    }
    return { verdict: 'unresolved', project: null }; // branch 3
  }

  // --- Branch 4: both ambiguous — intersect. --------------------------------
  // FR-237 emits one strictly intra-project instance per candidate in `A ∩ C`.
  // We walk at most the one equal to `Pc`, so this never replicates.
  const farLookup = new Set(farCandidates);
  const intersects = nearCandidates.some((p) => farLookup.has(p));
  if (!intersects) return { verdict: 'unresolved', project: null }; // dangling
  return curProject !== null && farLookup.has(curProject)
    ? { verdict: 'traverse', project: curProject }
    : { verdict: 'other_instance', project: null };
}
