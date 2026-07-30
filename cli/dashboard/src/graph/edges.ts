/**
 * FR-239 — the four edge types, as `force-graph` accessors.
 *
 * dataviz.md inherits four edge types from diagrams.md — **data · control ·
 * hot · optional** — and rule 04 makes them binding unconditionally. Under
 * `force-graph` they are expressed as accessor FUNCTIONS (`linkColor`,
 * `linkWidth`, `linkLineDash`, `linkDirectionalArrowLength`) rather than as a
 * stylesheet, which is what makes the degradation ladder ours (F1).
 *
 * THE TWO RULES THAT ARE EASY TO GET WRONG
 * -----------------------------------------
 * 1. **`hot` is unreachable at rest.** Exemption 03 turns "one hot path per
 *    figure" into "at most one hot path AT A TIME, and only while an
 *    interaction is active". `roleFor` cannot return `hot` — only the ACTIVE
 *    SET can promote an edge to it, and only for as long as the interaction
 *    lives. That is why the promotion is a separate parameter and not a branch
 *    inside the classifier.
 * 2. **Direction is deferred, never discarded.** At Tier C resting edges render
 *    undirected (`linkDirectionalArrowLength -> 0`). Every edge in the active
 *    set gets its arrowhead back. *"Undirected at rest is permitted;
 *    undirectable is not"* — a canvas that never restores direction fails the
 *    spec, so the restoration path is tested (T20), not assumed.
 */

import type { GraphEdge } from "../lib/api";
import type { DatavizPalette } from "./palette";
import { mix, withAlpha } from "./palette";
import type { TierPolicy } from "./tier";

/** The four inherited edge types. There is no fifth. */
export type EdgeRole = "data" | "control" | "hot" | "optional";

export const EDGE_ROLES: readonly EdgeRole[] = [
  "data",
  "control",
  "hot",
  "optional",
];

/**
 * Edge types that carry CONTROL semantics — one thing governing another.
 *
 * Taken from the live catalog and classified by what the relation DOES, in the
 * same spirit as §07's node procedure: `blocks` and `depends_on` gate work,
 * `supersedes` retires it, `serves_goal` subordinates it. Everything else in
 * the catalog (`parent_of`, `related_to`, `derived_from`, `duplicates`,
 * `recurs_with`, `cluster_member_of`) describes a knowledge relationship, which
 * is `data`.
 */
export const CONTROL_EDGE_TYPES: readonly string[] = [
  "blocks",
  "supersedes",
  "depends_on",
  "serves_goal",
];

/**
 * Classify one edge. **Never returns `hot`** — see rule 1 in the header.
 *
 * Order matters and is D9's, verbatim:
 *   1. `provenance === 'inferred'` -> **optional**
 *   2. type in {blocks, supersedes, depends_on, serves_goal} -> **control**
 *   3. everything else -> **data**
 *
 * Provenance outranks type on purpose. dataviz.md maps *"`suggested`,
 * `inferred`"* to optional, and an inferred `blocks` is still a guess — showing
 * it with the same weight as a human-asserted one would launder a machine's
 * suggestion into a fact. Optional's dashed stroke is the honest rendering.
 */
export function roleFor(edge: GraphEdge): Exclude<EdgeRole, "hot"> {
  if (edge.provenance === "inferred" || edge.provenance === "suggested") {
    return "optional";
  }
  if (CONTROL_EDGE_TYPES.includes(edge.type)) return "control";
  return "data";
}

/** Where an edge sits relative to the current interaction. */
export type EdgeActivity =
  /** Nothing is happening to it. Rung 3 and rung 4 apply. */
  | "rest"
  /** Incident to the focused / filtered / hovered set. Full role, arrowhead. */
  | "active"
  /** On the traced path. The canvas's single hot path, while the trace lives. */
  | "traced";

export interface EdgeStyle {
  /** A `--dataviz-*` role value, possibly alpha-composed. Never a literal. */
  color: string;
  /** Screen-space stroke width in CSS pixels. */
  width: number;
  /** `null` = solid. Optional edges are dashed. */
  lineDash: number[] | null;
  /** `0` = no marker. The Tier C resting carve-out's only expression. */
  arrowLength: number;
}

/** Base stroke widths, in CSS pixels. Hairlines — BRAND_RULES. */
const WIDTH_REST = 1;
const WIDTH_ACTIVE = 1.5;
const WIDTH_HOT = 2;

/** Arrowhead length in CSS pixels when direction IS shown. */
const ARROW_PX = 4;

/** Optional edges are dashed at every tier — the dash IS the role. */
const OPTIONAL_DASH: readonly number[] = [4, 3];

/**
 * Resolve one edge to its drawn style.
 *
 * The `activity` parameter is what makes exemption 03 structural: `hot` is
 * reachable only through `activity === "traced"`, which only the path-trace
 * interaction sets and only while it is running.
 */
export function styleFor(
  edge: GraphEdge,
  activity: EdgeActivity,
  policy: TierPolicy,
  palette: DatavizPalette,
): EdgeStyle {
  const role: EdgeRole = activity === "traced" ? "hot" : roleFor(edge);
  const dash = role === "optional" ? [...OPTIONAL_DASH] : null;

  // ---- the traced path: the canvas's ONE hot edge, for as long as it lives --
  if (role === "hot") {
    return {
      color: palette.accent,
      width: WIDTH_HOT,
      lineDash: dash,
      // A hot edge is always directed. It is by definition part of the active
      // set, so the Tier C carve-out never reaches it.
      arrowLength: ARROW_PX,
    };
  }

  // ---- the active set: full role colour AND direction, together -------------
  if (activity === "active") {
    return {
      color: roleColour(role, palette),
      width: WIDTH_ACTIVE,
      lineDash: dash,
      // "Direction is restored by the same interaction that returns the edge to
      // full role colour." The two are one branch here so they cannot diverge.
      arrowLength: ARROW_PX,
    };
  }

  // ---- at rest: rungs 3 and 4, per the tier policy -------------------------
  return {
    color: restingColour(role, policy, palette),
    width: WIDTH_REST,
    lineDash: dash,
    arrowLength: policy.arrowheadsAtRest ? ARROW_PX : 0,
  };
}

/** Full role colour. Role semantics never degrade — only opacity does. */
export function roleColour(role: EdgeRole, palette: DatavizPalette): string {
  switch (role) {
    case "data":
      return palette.bone;
    case "control":
      return palette.muted;
    case "optional":
      return palette.accent;
    case "hot":
      return palette.accent;
  }
}

/**
 * Rung 3 — edge opacity. *"Data edges dim before control, hot, or optional."*
 *
 * Tier A: nothing dims. Tier B: data steps down to the MUTED role, the rest
 * keep theirs. Tier C: everything resting renders at `--dataviz-edge-dim`.
 *
 * A hot edge stays ACCENT even when dimmed — role semantics are on the
 * never-degrades list; only the alpha moves.
 */
function restingColour(
  role: EdgeRole,
  policy: TierPolicy,
  palette: DatavizPalette,
): string {
  switch (policy.edgesAtRest) {
    case "role-colour":
      return roleColour(role, palette);
    case "data-dimmed":
      return role === "data" ? palette.muted : roleColour(role, palette);
    case "all-dimmed":
      // The one derived alias, referenced by name (dataviz.md §02). `optional`
      // and `control` keep their identity through the dash and the width; the
      // colour role is what rung 3 is allowed to take.
      return role === "data" || role === "control"
        ? palette.edgeDim
        : withAlpha(roleColour(role, palette), 0.38);
  }
}

// ---------------------------------------------------------------------------
// The accessor factory — the shape `instance.ts` actually wires
// ---------------------------------------------------------------------------

/** Everything the accessors need, re-read per frame from live state. */
export interface EdgeContext {
  policy: TierPolicy;
  palette: DatavizPalette;
  /** Classify one edge's relationship to the current interaction. */
  activityOf: (edge: GraphEdge) => EdgeActivity;
  /**
   * 0..1 — the `filterProgress` scalar interaction 4 tweens. One tween drives
   * a bulk change over N edges, not N tweens (`// QUICK`).
   */
  filterProgress: number;
  /** Does this edge match the active filter? Non-matching drop toward MUTED. */
  matchesFilter: (edge: GraphEdge) => boolean;
  /**
   * 1 while a selection is held, falling to 0 as a deselect eases out.
   *
   * Without it the 1-hop edges would hold full role colour for the whole clear
   * tween and then snap to their resting style when it completed — the node
   * easing while its edges jump.
   */
  deselectProgress: number;
}

export interface EdgeAccessors {
  color: (edge: GraphEdge) => string;
  width: (edge: GraphEdge) => number;
  lineDash: (edge: GraphEdge) => number[] | null;
  arrowLength: (edge: GraphEdge) => number;
}

/**
 * Build the four accessors over a live context getter.
 *
 * The getter is called per invocation rather than captured, so a palette swap,
 * a tier change or a filter tween is picked up on the NEXT PAINT with no
 * re-binding — which is the property that makes AC #3 cheap (D1).
 */
export function edgeAccessors(ctx: () => EdgeContext): EdgeAccessors {
  const style = (edge: GraphEdge): EdgeStyle => {
    const c = ctx();
    const activity = c.activityOf(edge);
    let s = styleFor(edge, activity, c.policy, c.palette);
    if (activity === "active" && c.deselectProgress < 1) {
      // Ease the active treatment back toward rest over the same scalar that
      // drives the ring, so the whole deselect lands together.
      const rest = styleFor(edge, "rest", c.policy, c.palette);
      s = {
        ...s,
        color: mix(s.color, rest.color, c.deselectProgress),
        width: rest.width + (s.width - rest.width) * c.deselectProgress,
        // Direction is restored by the interaction and withdrawn with it. It is
        // a marker, not a continuum — it does not fade.
        arrowLength: c.deselectProgress > 0 ? s.arrowLength : rest.arrowLength,
      };
    }
    if (c.filterProgress > 0 && !c.matchesFilter(edge)) {
      // Rung 3's dimension, driven by the filter tween. The HUE is untouched —
      // a filtered-out control edge is still a control edge.
      return { ...s, color: withAlpha(s.color, 1 - 0.75 * c.filterProgress) };
    }
    return s;
  };

  return {
    color: (e) => style(e).color,
    width: (e) => style(e).width,
    lineDash: (e) => style(e).lineDash,
    arrowLength: (e) => style(e).arrowLength,
  };
}

// ---------------------------------------------------------------------------
// Interaction 5 — the traced path
// ---------------------------------------------------------------------------

/**
 * Hop ceiling for a single trace.
 *
 * The DURATION is capped at `// SLOW` regardless of chain length, so this bound
 * is not about time — a longer walk only makes each hop less legible, and an
 * unbounded walk on a densely linked brain could sweep most of the graph into
 * one hot path, which exemption 03 means to keep narrow.
 *
 * It is exported because a bound nothing exercises is where the next
 * duration-per-hop bug hides: the live brain's longest deterministic outgoing
 * chain is 6 hops across ~2,438 nodes, so nothing real reaches this. The
 * synthetic 50-hop fixture in `edges.test.ts` is what actually drives it.
 */
export const TRACE_MAX_HOPS = 30;

/**
 * Build the chain a trace walks, following OUTGOING edges from `startKey`.
 *
 * Deterministic by edge id and never revisiting a node, so the same selection
 * always traces the same chain — dataviz.md's determinism limit applies to an
 * interaction's result as much as to a layout.
 *
 * Pure: no state, no tween, no clock. That is what lets a 50-hop synthetic
 * chain be driven through it without a browser.
 */
export function buildTraceChain(
  edges: readonly GraphEdge[],
  startKey: string,
  maxHops: number = TRACE_MAX_HOPS,
): GraphEdge[] {
  const outgoing = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const list = outgoing.get(e.from);
    if (list === undefined) outgoing.set(e.from, [e]);
    else list.push(e);
  }

  const chain: GraphEdge[] = [];
  const seen = new Set<string>([startKey]);
  let cursor = startKey;
  for (let hop = 0; hop < maxHops; hop++) {
    const next = (outgoing.get(cursor) ?? [])
      .filter((e) => !seen.has(e.to))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    if (next === undefined) break;
    chain.push(next);
    seen.add(next.to);
    cursor = next.to;
  }
  return chain;
}
