/**
 * FR-239 — the React seam.
 *
 * Owns the container ref, the instance lifecycle, the PRM gate, the palette
 * observer, resize, teardown, and the six interactions' entry/exit points. It
 * holds the ONE mutable render-state object that every accessor reads, which is
 * what makes a bulk change cost one tween instead of N: `filterProgress` is a
 * single scalar, and a thousand edges re-read it on the next paint.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * ------------------------------
 * There is no `live.tick` dependency anywhere in this file (D8). Every other
 * page in the shell refetches on the 5-second beat; this one does not, and the
 * divergence is deliberate: a refetch would re-run the builder AND re-run the
 * force simulation every five seconds — ambient motion dressed as freshness,
 * and precisely the failure AC #5 exists to catch now that stillness is
 * measured rather than structural. Staleness is carried by the AS OF stamp in
 * the query twin and cleared by an explicit REFRESH.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphEdge, GraphNode } from "../lib/api";
import { useReducedMotion } from "../lib/usePalette";
import {
  attachPointerBoundary,
  createGraphInstance,
  type GraphController,
  type GraphDatum,
  type LinkDatum,
  type PositionCache,
} from "./instance";
import { forceGraphFactory } from "./instance-factory";
import {
  currentPalette,
  mix,
  invalidatePalette,
  monoFont,
  observePalette,
  withAlpha,
  type DatavizPalette,
} from "./palette";
import { edgeAccessors, type EdgeActivity } from "./edges";
import {
  captureSizePx,
  drawNode,
  shapeFor,
  tracePath,
  type Chrome,
  type NodeVisual,
} from "./shapes";
import {
  LABEL_GAP_PX,
  LABEL_LINE_PX,
  glyphBox,
  labelText,
  placeLabels,
  type Box,
  type LabelCandidate,
} from "./labels";
import {
  buildAdjacency,
  buildNodeIndex,
  incidentEdgeIds,
  neighboursFrom,
} from "./neighbours";
import { policyFor, shouldAggregate, type TierPolicy } from "./tier";
import {
  INTERACTIONS,
  durationMs,
  moveCamera,
  startTrace,
  tweenScalar,
  type MotionHandle,
} from "./motion";
import { canvasSurface, probe, type StillnessResult } from "./stillness";

/** The live state every accessor reads. Mutated in place — never re-bound. */
interface RenderState {
  policy: TierPolicy;
  palette: DatavizPalette;
  hovered: string | null;
  selected: string | null;
  /** The selected node plus its 1-hop neighbourhood. */
  active: Set<string>;
  /** Edge ids incident to the active set. */
  activeEdges: Set<string>;
  /** Edge ids on the traced path — the canvas's single hot path. */
  traced: Set<string>;
  /** 0..1, tweened by interaction 4. One scalar, N elements. */
  filterProgress: number;
  /** `null` = no filter. Otherwise the matching node keys. */
  matches: Set<string> | null;
  /** 0..1, the hover emphasis tween. */
  emphasis: number;
  /** 0..1, the selection ring's SPRING spawn. Runs backwards on a clear. */
  ring: number;
  /**
   * True while a deselect is easing out. The whole clear is driven by `ring`
   * falling to 0, so this only tells the paint layer to read that scalar
   * backwards.
   */
  clearing: boolean;
  coarsePointer: boolean;
  floorPx: number;
  nodeSizePx: number;
}

export interface GraphSelection {
  node: GraphNode;
  neighbours: GraphNode[];
}

export interface UseGraphOptions {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  /** Entity types to keep. Empty = keep all. A client-side MUTE, not a refetch. */
  typeFilter: ReadonlySet<string>;
  /** Free-text search over labels and ids. A client-side MUTE. */
  search: string;
  /** Seeded positions from a previous scope — D6's back-out. */
  seed?: PositionCache;
  /**
   * How this payload arrived. `"entrance"` runs `// CINE` once on first mount;
   * `"drill"` runs `// SLOW` for a subgraph swap, per dataviz.md's rule that
   * the entrance fires once and never re-fires on a re-layout.
   */
  transition: "entrance" | "drill";
}

export interface UseGraph {
  containerRef: (el: HTMLDivElement | null) => void;
  selection: GraphSelection | null;
  clearSelection: () => void;
  /** M3 — the inspector's 1-hop buttons were no-ops without this. */
  select: (key: string) => void;
  /** Interaction 5 — path trace from a node. The only source of `hot` edges. */
  trace: (key: string) => void;
  /** Nodes currently matching the filter/search. `null` = everything matches. */
  matchCount: number | null;
  /** Settled at least once — gates the AC-#5 checkpoint. */
  settled: boolean;
  /** Rung 6 fired: the set cannot fit at the floor. */
  aggregating: boolean;
  tier: TierPolicy["tier"];
  /** Snapshot of settled positions, for the caller to cache across a drill. */
  positions: () => PositionCache;
  refit: () => void;
}

/** Reads a `--s-*` token off `<body>`. Node floors are never bare pixels. */
function scalePx(token: string, fallback: number): number {
  try {
    const raw = getComputedStyle(document.body).getPropertyValue(token).trim();
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

/** Chrome level per tier — rung 2's only expression. */
function chromeFor(policy: TierPolicy): Chrome {
  return policy.chrome;
}

export function useGraph(opts: UseGraphOptions): UseGraph {
  const reducedMotion = useReducedMotion();
  const [selection, setSelection] = useState<GraphSelection | null>(null);
  const [settled, setSettled] = useState(false);

  const controller = useRef<GraphController | null>(null);
  const containerEl = useRef<HTMLDivElement | null>(null);
  const tweens = useRef<MotionHandle[]>([]);
  /** Painted frames since mount. Diagnostic only — never a contract. */
  const paints = useRef(0);

  // ---- derived, memoised -------------------------------------------------
  //
  // FR-240 moved these three computations — the index, the adjacency map and
  // the 1-hop hydration below — into `graph/neighbours.ts`, unchanged, so the
  // brief detail view can ask the SAME question of the SAME payload and get the
  // same answer by construction (D6). They are still memoised HERE because
  // their lifetime is the payload's, not the selection's.
  const nodesByKey = useMemo(() => buildNodeIndex(opts.nodes), [opts.nodes]);

  /** Adjacency, built once per payload. The 1-hop reveal reads it per select. */
  const adjacency = useMemo(() => buildAdjacency(opts.edges), [opts.edges]);

  const policy = useMemo(() => policyFor(opts.nodes.length), [opts.nodes.length]);

  /**
   * The filter/search match set. `null` means "no filter is active", which is
   * DIFFERENT from "an empty set matched" — the latter must mute everything.
   */
  const matches = useMemo(() => {
    const q = opts.search.trim().toLowerCase();
    const hasType = opts.typeFilter.size > 0;
    if (q === "" && !hasType) return null;
    const out = new Set<string>();
    for (const n of opts.nodes) {
      if (hasType && !opts.typeFilter.has(n.type)) continue;
      if (
        q !== "" &&
        !n.label.toLowerCase().includes(q) &&
        !n.id.toLowerCase().includes(q)
      ) {
        continue;
      }
      out.add(n.key);
    }
    return out;
  }, [opts.nodes, opts.search, opts.typeFilter]);

  // ---- the mutable render state ------------------------------------------
  const state = useRef<RenderState>({
    policy,
    palette: {
      bone: "transparent",
      accent: "transparent",
      muted: "transparent",
      grid: "transparent",
      edgeDim: "transparent",
    },
    hovered: null,
    selected: null,
    active: new Set(),
    activeEdges: new Set(),
    traced: new Set(),
    filterProgress: 0,
    matches: null,
    emphasis: 0,
    ring: 0,
    clearing: false,
    coarsePointer: false,
    floorPx: 8,
    nodeSizePx: 8,
  });

  const [aggregating, setAggregating] = useState(false);

  // -------------------------------------------------------------------------
  // Paint. Every accessor reads `state.current` on each call, so a palette
  // swap, a tier change or a filter tween lands on the next paint with zero
  // re-binding — the property that makes AC #3 cheap (D1).
  // -------------------------------------------------------------------------
  const paint = useMemo(() => {
    const edgeCtx = () => {
      const s = state.current;
      const activityOf = (edge: GraphEdge): EdgeActivity => {
        if (s.traced.has(edge.id)) return "traced";
        return s.activeEdges.has(edge.id) ? "active" : "rest";
      };
      return {
        policy: s.policy,
        palette: s.palette,
        activityOf,
        filterProgress: s.filterProgress,
        // 1 while selected, falling to 0 as the deselect eases out, so the
        // 1-hop edges return to their resting role together with the node
        // rather than snapping when the tween completes.
        deselectProgress: s.clearing ? s.ring : 1,
        matchesFilter: (e: GraphEdge) =>
          s.matches === null || (s.matches.has(e.from) && s.matches.has(e.to)),
      };
    };
    const acc = edgeAccessors(edgeCtx);

    const visualFor = (node: GraphDatum): NodeVisual => {
      const s = state.current;
      const isActive = s.active.has(node.key);
      const isHovered = s.hovered === node.key;
      const muted =
        s.matches !== null && !s.matches.has(node.key) && s.filterProgress > 0;

      // Interaction 2 — hover-highlight. One scalar, read here.
      const grow = isHovered ? 1 + 0.6 * s.emphasis : 1;
      // While clearing, the active emphasis rides the ring scalar back down so
      // the node arrives at its resting size and colour exactly as the ring
      // disappears. Nothing snaps.
      const emphasis = s.clearing ? s.ring : 1;
      const base = isActive
        ? s.nodeSizePx * (1 + 0.5 * emphasis)
        : s.nodeSizePx;

      let fill =
        isActive || isHovered
          ? s.clearing
            ? mix(s.palette.accent, s.palette.bone, emphasis)
            : s.palette.accent
          : s.palette.bone;
      if (muted) {
        // Rung 3's dimension. HUE untouched — a muted brief is still a brief,
        // and category never lives in hue anyway (dataviz DON'T).
        fill = withAlpha(s.palette.muted, 1 - 0.7 * s.filterProgress);
      }

      return {
        shape: shapeFor(node),
        sizePx: Math.max(s.floorPx, base * grow),
        fill,
        stroke: isActive
          ? s.clearing
            ? mix(s.palette.accent, s.palette.muted, emphasis)
            : s.palette.accent
          : s.palette.muted,
        chrome: chromeFor(s.policy),
        alpha: 1,
      };
    };

    return {
      drawNode: (
        node: GraphDatum,
        ctx: CanvasRenderingContext2D,
        scale: number,
      ) => {
        const s = state.current;
        const visual = visualFor(node);
        drawNode(ctx, visual, node.x ?? 0, node.y ?? 0, scale);

        // The selection ring — the ONE SPRING on this canvas (D7). A spawn, per
        // motion.md, and the only reason SPRING appears at all.
        if (s.selected === node.key && s.ring > 0) {
          const r = ((visual.sizePx * (1.2 + 1.4 * s.ring)) / scale) * 0.5;
          ctx.save();
          // Spawning, the ring expands and settles to full opacity. Clearing,
          // the SAME scalar runs backwards and the alpha follows it to zero —
          // otherwise the ring would still be fully opaque at `ring = 0` and
          // would pop out of existence on the guard above.
          ctx.globalAlpha = s.clearing ? s.ring : 1 - 0.35 * s.ring;
          ctx.lineWidth = Math.max(0.5, 1.5 / scale);
          ctx.strokeStyle = s.palette.accent;
          ctx.beginPath();
          ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      },

      paintPointerArea: (
        node: GraphDatum,
        colour: string,
        ctx: CanvasRenderingContext2D,
        scale: number,
      ) => {
        const s = state.current;
        // Rule 2.4: the capture radius — not the node — is what must meet the
        // 44 px minimum on a coarse pointer.
        const size = captureSizePx(s.nodeSizePx, s.coarsePointer) / scale;
        ctx.fillStyle = colour;
        ctx.beginPath();
        tracePath(ctx, shapeFor(node), node.x ?? 0, node.y ?? 0, size);
        ctx.fill();
      },

      linkColor: (l: LinkDatum) => acc.color(l),
      linkWidth: (l: LinkDatum) => acc.width(l),
      linkLineDash: (l: LinkDatum) => acc.lineDash(l),
      linkArrowLength: (l: LinkDatum) => acc.arrowLength(l),

      /**
       * Labels, drawn last so they sit above every glyph.
       *
       * Placement runs in GRAPH coordinates (the context force-graph hands us
       * is already zoom-transformed) with every metric divided by `scale`.
       * Overlap is invariant under uniform scaling, so the rejection pass means
       * the same thing it would in screen space.
       */
      drawOverlay: (ctx: CanvasRenderingContext2D, scale: number) => {
        const s = state.current;
        const ctrl = controller.current;
        // Painted-frame counter, surfaced through the diagnostic. It is what
        // turns "the pixels changed" into "a frame was drawn", which is the
        // difference between a real motion bug and a readback artifact — and
        // it is how the one late repaint in this brief was tracked down.
        paints.current += 1;
        if (ctrl === null) return;

        // Which nodes carry a label at rest — the tier's whole labels policy.
        const wanted = new Set<string>();
        if (s.policy.labels === "all") {
          for (const n of opts.nodes) wanted.add(n.key);
        } else {
          for (const k of s.active) wanted.add(k);
          if (s.hovered !== null) wanted.add(s.hovered);
          if (s.matches !== null) for (const k of s.matches) wanted.add(k);
        }
        if (wanted.size === 0) return;

        /*
         * LABELS PARTICIPATE IN THE DESELECT TOO.
         *
         * This was the last consumer of `s.active` that did not ride the `ring`
         * scalar. The node fill and size eased, the edges eased, the ring eased
         * — and the labels stayed at full opacity for the whole tween, so
         * `onComplete` dropped `active` and the loop paused with the 1-hop
         * labels still painted. Measured residual: 4 labels, 3,504 of 686,952
         * pixels (0.51%), and the end-of-tween hash differed from the resting
         * frame. That is the original C2 bug at smaller scale, and on a Tier C
         * canvas labels are the most legible thing on screen, so it was the
         * most visible of the three remnants.
         *
         * Only labels the SELECTION put on screen fade. A label that is also a
         * search/filter match, or the one under the pointer, is not part of the
         * deselect and must stay at full opacity.
         */
        const fadingLabel = (key: string): boolean =>
          s.clearing &&
          s.policy.labels !== "all" &&
          s.active.has(key) &&
          s.hovered !== key &&
          !(s.matches !== null && s.matches.has(key));

        const fontPx = LABEL_LINE_PX / scale;
        ctx.save();
        ctx.font = monoFont(fontPx);
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";

        const positions = ctrl.positions();
        const size = s.nodeSizePx / scale;

        const candidates: LabelCandidate[] = [];
        for (const key of wanted) {
          const at = positions[key];
          const node = nodesByKey.get(key);
          if (at === undefined || node === undefined) continue;
          const text = labelText(node.label);
          candidates.push({
            key,
            text,
            cx: at.x,
            cy: at.y,
            nodeSizePx: size,
            textWidth: ctx.measureText(text).width,
            // Degree desc, key asc — the same deterministic ordering
            // `whole-graph.ts` uses for truncation, so "which label survived"
            // is reproducible.
            rank: node.degree,
          });
        }
        if (candidates.length === 0) {
          ctx.restore();
          return;
        }

        // Obstacles: EVERY node's glyph box, not just the labelled ones — a
        // label covering an unlabelled neighbour has still hidden a node.
        // Restricted to the neighbourhood of the candidates so the rejection
        // pass stays O(candidates) rather than O(candidates x 2,422) per frame.
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const c of candidates) {
          minX = Math.min(minX, c.cx);
          maxX = Math.max(maxX, c.cx);
          minY = Math.min(minY, c.cy);
          maxY = Math.max(maxY, c.cy);
        }
        const pad = 240 / scale;
        const obstacles: Box[] = [];
        for (const [key, at] of Object.entries(positions)) {
          if (
            at.x < minX - pad ||
            at.x > maxX + pad ||
            at.y < minY - pad ||
            at.y > maxY + pad
          ) {
            continue;
          }
          void key;
          obstacles.push(glyphBox({ cx: at.x, cy: at.y, nodeSizePx: size }));
        }

        const { placed } = placeLabels(candidates, obstacles, {
          lineHeight: LABEL_LINE_PX / scale,
          gap: LABEL_GAP_PX / scale,
        });

        ctx.fillStyle = s.palette.bone;
        for (const label of placed) {
          // The same scalar that drives the ring, the fill and the edges. At
          // `ring === 0` these labels are fully transparent, so dropping
          // `active` afterwards changes nothing on the canvas.
          const alpha = fadingLabel(label.key) ? s.ring : 1;
          if (alpha <= 0) continue;
          ctx.globalAlpha = alpha;
          ctx.fillText(label.text, label.x, label.y);
        }
        ctx.globalAlpha = 1;
        // Everything not in `placed` DEGRADED (rung 1) rather than overlapping.
        ctx.restore();
      },
    };
  }, [nodesByKey, opts.nodes]);

  // -------------------------------------------------------------------------
  // Interactions
  // -------------------------------------------------------------------------
  const track = useCallback((handle: MotionHandle) => {
    tweens.current.push(handle);
  }, []);

  const onHover = useCallback(
    (node: GraphDatum | null) => {
      const ctrl = controller.current;
      if (ctrl === null) return;
      const s = state.current;
      const nextKey = node?.key ?? null;
      if (nextKey === s.hovered) return;
      s.hovered = nextKey;

      // Interaction 2 — `// INSTANT` / `// STD`.
      ctrl.beginInteraction();
      track(
        tweenScalar(
          "hover-highlight",
          s.emphasis,
          nextKey === null ? 0 : 1,
          (v) => {
            s.emphasis = v;
          },
          { reducedMotion, onComplete: () => ctrl.endInteraction() },
        ),
      );
    },
    [reducedMotion, track],
  );

  const applySelection = useCallback(
    (key: string | null) => {
      const ctrl = controller.current;
      if (ctrl === null) return;
      const s = state.current;
      // NOT assigned for the null case — the clear branch below HOLDS the
      // previous selection until the ring finishes easing out.
      if (key !== null) {
        s.selected = key;
        s.clearing = false;
      }

      if (key === null) {
        /*
         * C2 — CLEARING A SELECTION MUST REPAINT, AND THE RING MUST ACTUALLY
         * EASE OUT.
         *
         * Two bugs lived here in sequence, and the second is the more
         * instructive one.
         *
         * FIRST: this branch mutated `active` / `activeEdges` / `ring` and
         * returned with no `beginInteraction()`. The canvas is paused at rest
         * and the inspector column is size-reserved, so nothing repainted — the
         * last frame kept showing the ring and the accent 1-hop set after the
         * operator had cleared them.
         *
         * SECOND: the fix added a `selection-ring` tween, but still set
         * `s.selected = null` BEFORE this branch. `drawNode` guards the ring on
         * `s.selected === node.key`, so the ring vanished on frame 1 and the
         * 320 ms tween painted no ring at all — measured, 0 `arc()` calls
         * across the whole tween against 22/frame while selected. The repaint
         * was real and the outcome correct, but it was a bolted-on invalidation
         * wearing a tween's clothes, and the comment claimed otherwise.
         *
         * NOW: the whole deselect is driven by the single `ring` scalar falling
         * 1 -> 0. `selected` and the active sets are HELD until it lands, so
         * `drawNode` keeps drawing the ring at a shrinking radius and falling
         * alpha, and the node's accent is mixed back toward bone over the same
         * scalar. When `ring` reaches 0 the node is already at its resting
         * appearance, so dropping the state afterwards is invisible and needs
         * no second repaint.
         */
        // `s.selected` is deliberately NOT touched here — the ring guard in
        // `drawNode` reads it, so it must survive until the tween lands. It is
        // cleared in `onComplete` below. (This used to read
        // `const previous = s.selected; s.selected = previous;`, a no-op
        // round-trip that looked like it was doing something.)
        s.clearing = true;
        s.traced = new Set();
        setSelection(null);

        ctrl.beginInteraction();
        track(
          tweenScalar(
            "selection-ring",
            s.ring > 0 ? s.ring : 1,
            0,
            (v) => {
              s.ring = v;
            },
            {
              reducedMotion,
              onComplete: () => {
                // Only now — and by construction nothing visible changes.
                s.ring = 0;
                s.clearing = false;
                s.selected = null;
                s.active = new Set();
                s.activeEdges = new Set();
                ctrl.endInteraction();
              },
            },
          ),
        );
        return;
      }

      const node = nodesByKey.get(key);
      if (node === undefined) return;

      // The 1-hop neighbourhood — the only nodes regaining labels, full-role
      // edges and arrowheads. ONE definition, shared with the record detail
      // (`graph/neighbours.ts`, D6): the canvas and the detail view cannot
      // disagree about a node's neighbours because there is nothing to disagree
      // with. `__tests__/neighbours.test.ts` pins the extraction against a
      // verbatim copy of the pre-extraction code.
      const { hop, neighbours } = neighboursFrom(nodesByKey, adjacency, key);
      s.active = new Set([key, ...hop]);
      s.activeEdges = incidentEdgeIds(opts.edges, key);

      setSelection({ node, neighbours });

      // Interaction 3 — focus/select on `// STD` (D7: NOT spring; SPRING is an
      // easing and the spec assigns focus STD/STD)...
      ctrl.beginInteraction();
      track(
        tweenScalar(
          "focus-select",
          0,
          1,
          () => undefined,
          { reducedMotion, onComplete: () => ctrl.endInteraction() },
        ),
      );
      // ...and the selection RING is the one SPRING, because a ring appearing
      // is a spawn.
      ctrl.beginInteraction();
      s.ring = 0;
      track(
        tweenScalar(
          "selection-ring",
          0,
          1,
          (v) => {
            s.ring = v;
          },
          { reducedMotion, onComplete: () => ctrl.endInteraction() },
        ),
      );

      // Camera focus. GSAP on a token duration + token easing, driving the
      // INSTANTANEOUS camera setters — F2's workaround, and the only way the
      // camera is ever moved.
      const at = ctrl.positions()[key];
      if (at !== undefined) {
        ctrl.beginInteraction();
        track(
          moveCamera(ctrl.camera, { x: at.x, y: at.y }, "focus-select", {
            reducedMotion,
          }),
        );
        window.setTimeout(
          () => ctrl.endInteraction(),
          durationMs(INTERACTIONS["focus-select"].duration),
        );
      }
    },
    [adjacency, nodesByKey, opts.edges, reducedMotion, track],
  );

  /**
   * Interaction 5 — PATH TRACE. `// SLOW` / `// LINEAR`.
   *
   * M1: this is what makes the **`hot` edge role reachable at runtime.** `hot`
   * is one of the four edge types `dataviz.md` rule 04 binds unconditionally,
   * and exemption 03 makes it per-interaction: *"At most one hot path exists at
   * a time, and only while an interaction is active. At rest the canvas has
   * zero hot edges."* With no trace implemented, `EdgeActivity === "traced"`
   * was unreachable and the role could never occur — the spec's four edge types
   * were three.
   *
   * The chain is the lineage the spec's own worked example names (§08, *"tracing
   * a brief → learning lineage"*): walk OUTGOING edges from the selected node,
   * never revisiting a node, deterministically ordered by edge id so the same
   * selection always traces the same chain.
   *
   * **One continuous tween, capped at `// SLOW` regardless of hop count.** A
   * thirty-hop chain traces *faster*, never *longer* — that cap is what stops
   * per-hop durations from being invented.
   */
  const traceFrom = useCallback(
    (key: string) => {
      const ctrl = controller.current;
      if (ctrl === null) return;
      const s = state.current;
      // FORWARDS ONLY. The composition lives in `motion.ts#startTrace`, where a
      // per-hop chain can be caught by a wall-clock test — a composition built
      // here would be invisible to any test that drives the unit.
      const handle = startTrace(
        opts.edges,
        key,
        {
          onTraced: (ids) => {
            s.traced = ids;
          },
          onStart: () => ctrl.beginInteraction(),
          onEnd: () => ctrl.endInteraction(),
        },
        { reducedMotion },
      );
      if (handle !== null) track(handle);
    },
    [opts.edges, reducedMotion, track],
  );

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  const containerRef = useCallback((el: HTMLDivElement | null) => {
    containerEl.current = el;
  }, []);

  useEffect(() => {
    const el = containerEl.current;
    if (el === null) return;

    const s = state.current;
    s.coarsePointer = window.matchMedia("(pointer: coarse)").matches;
    invalidatePalette();
    s.palette = currentPalette();

    const ctrl = createGraphInstance({
      container: el,
      paint,
      // M1 — a DRILL is a page transition, not a second entrance. dataviz.md
      // assigns a subgraph swap `// SLOW` and says the entrance "fires once. It
      // never re-fires on filter or re-layout." Running a fresh `// CINE` on
      // every scope change is what left the `drill-down` token orphaned.
      entranceMs: durationMs(
        INTERACTIONS[
          opts.transition === "drill" ? "drill-down" : "entrance-settle"
        ].duration,
      ),
      // A debounce, expressed as a token so no free number reaches the canvas.
      // `// STD` is long enough for the library to process a hover-out and for
      // `pointerup` to find a fresh `hoverObj`; anything longer-running holds
      // its own refcount slot and is unaffected by this window.
      pointerIdleMs: durationMs("std"),
      reducedMotion,
      onHover,
      onSelect: (n) => applySelection(n?.key ?? null),
      onSettled: () => {
        setSettled(true);
        /*
         * EXEMPTION 02 — the entry point. "A reader is never dropped into an
         * unanchored field." Highest-degree node, degree descending then key
         * ascending: the same deterministic ordering `whole-graph.ts` uses for
         * truncation, so the canvas opens on the same node for the same payload.
         *
         * Applied HERE rather than from an effect keyed on `settled`. That was
         * tried and it does not work: `settled` is a one-way latch, so an
         * effect depending on it fires at most once for the component, while
         * this callback fires per INSTANCE — which is what a scope change needs.
         * The instance is the right lifetime for the entry point, so the entry
         * point lives on the instance's callback.
         */
        const entry = [...opts.nodes].sort(
          (a, b) => b.degree - a.degree || (a.key < b.key ? -1 : 1),
        )[0];
        if (entry !== undefined) applySelection(entry.key);
      },
      factory: forceGraphFactory,
    });
    controller.current = ctrl;

    /*
     * C1 — THE INTERACTION BOUNDARY, ON THE DOM, OUTSIDE THE LOOP.
     *
     * `instance.ts#attachPointerBoundary` explains why this cannot be a library
     * callback: hit-testing, hover dispatch and the shadow-canvas refresh all
     * live inside the render loop, so once it is halted `onNodeHover` can never
     * fire and therefore can never wake it.
     *
     * The wiring is a NAMED EXPORTED FUNCTION rather than an inline block here,
     * because an inline block could be — and was — deleted wholesale with every
     * test still passing. Both the call below and the boundary's behaviour are
     * now pinned.
     */
    const detachPointerBoundary = attachPointerBoundary(el, ctrl);

    ctrl.resize(el.clientWidth, el.clientHeight);
    ctrl.setData(opts.nodes, opts.edges, opts.seed);

    // Palette: invalidate the memo, then resume the loop just long enough to
    // repaint. No re-binding and no stylesheet re-injection — this is the whole
    // D1 argument, in six lines.
    //
    // The window is `// INSTANT` rather than 0 ms because the render loop is
    // frame-driven: resuming and re-pausing inside the same macrotask can
    // schedule no frame at all, leaving the canvas on the previous palette
    // until the next unrelated interaction. A token-length window guarantees
    // several frames and then returns the canvas to rest.
    const stopPalette = observePalette(() => {
      s.palette = currentPalette();
      ctrl.beginInteraction();
      window.setTimeout(
        () => ctrl.endInteraction(),
        durationMs(INTERACTIONS["hover-highlight"].duration),
      );
    });

    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box === undefined) return;
      ctrl.resize(box.width, box.height);
      setAggregating(
        shouldAggregate({ width: box.width, height: box.height }, opts.nodes.length, s.floorPx),
      );
    });
    ro.observe(el);

    // The AC-#5 diagnostic. `window.__igrisGraphStillness` is DELIBERATELY NOT
    // A CONTRACT (MAINTAINING §9) — it exists for the operator checkpoint and
    // must never acquire an external consumer.
    const diagnostic = {
      probe: async (ms = 3000): Promise<StillnessResult> => {
        const canvas = ctrl.canvas();
        if (canvas === null) throw new Error("stillness: no canvas yet");
        return probe(canvasSurface(canvas), ms);
      },
      state: () => ctrl.state(),
      paints: () => paints.current,
    };
    (window as unknown as Record<string, unknown>).__igrisGraphStillness =
      diagnostic;

    return () => {
      stopPalette();
      ro.disconnect();
      detachPointerBoundary();
      for (const t of tweens.current) t.cancel();
      tweens.current = [];
      ctrl.destroy();
      controller.current = null;
      delete (window as unknown as Record<string, unknown>)
        .__igrisGraphStillness;
    };
    // The payload identity is the mount key: a new scope is a new instance
    // (D6), and a new instance is the only thing that re-runs the entrance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.nodes, opts.edges]);

  // ---- tier + floor, recomputed when the result set changes ---------------
  useEffect(() => {
    const s = state.current;
    s.policy = policy;
    s.floorPx = scalePx(policy.floorToken ?? "--s-3", 8);
    s.nodeSizePx = policy.tier === "A" ? scalePx("--s-3", 24) : s.floorPx;
  }, [policy]);

  // ---- interaction 4 — filter-to-muted ------------------------------------
  useEffect(() => {
    const ctrl = controller.current;
    const s = state.current;
    s.matches = matches;
    if (ctrl === null) return;
    ctrl.beginInteraction();
    // ONE tween on ONE scalar. A bulk change over 2,422 nodes costs one tween,
    // not 2,422 — which is why `// QUICK` is fast enough to be honest.
    track(
      tweenScalar(
        "filter-to-muted",
        s.filterProgress,
        matches === null ? 0 : 1,
        (v) => {
          s.filterProgress = v;
        },
        { reducedMotion, onComplete: () => ctrl.endInteraction() },
      ),
    );
  }, [matches, reducedMotion, track]);

  return {
    containerRef,
    selection,
    clearSelection: () => applySelection(null),
    /** M3 — select a node by key. The inspector's 1-hop list needs this. */
    select: (key: string) => applySelection(key),
    /** Interaction 5 — trace the lineage out of a node. Makes `hot` reachable. */
    trace: traceFrom,
    matchCount: matches === null ? null : matches.size,
    settled,
    aggregating,
    tier: policy.tier,
    positions: () => controller.current?.positions() ?? {},
    refit: () => controller.current?.zoomToFit(),
  };
}
