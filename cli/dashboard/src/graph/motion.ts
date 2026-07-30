/**
 * FR-239 — the six interactions, and nothing else that moves.
 *
 * dataviz.md's motion contract in one line: *"the canvas animates once on
 * entrance, comes to rest, and every movement after that is triggered by an
 * interaction."* Rule 07: *"Every duration is a `motion.md` token. `// LOOP`
 * never touches the canvas."*
 *
 * EVERY TIMING HERE IS READ FROM A CSS CUSTOM PROPERTY. Not copied from
 * motion.md into a constant — READ, at runtime, from the `--t-*` / `--e-*`
 * tokens `tokens.css` declares. A free number cannot appear in this file
 * because there is nowhere to put one: the resolvers only accept token names,
 * and `motion.test.ts` asserts the token sets are exactly the six and the four.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * F2 — THE ONE PLACE THE LIBRARY'S EASING FIGHTS THE TOKENS
 * ─────────────────────────────────────────────────────────────────────────
 * `force-graph` exposes `centerAt(x, y, ms)` and `zoom(k, ms)`. Both accept a
 * DURATION but apply the library's OWN internal easing, which is not one of
 * motion.md's four. Using them would put an un-named easing on the focus and
 * drill-down moves — a motion.md violation, in exactly two places.
 *
 * **Resolution: we never call their timed form.** Every camera move is a GSAP
 * tween on a token duration and a token easing whose `onUpdate` calls the
 * INSTANTANEOUS `centerAt(x, y)` / `zoom(k)`. `dashboard-graph-source.test.ts`
 * pins it by scanning for a third argument (T8).
 *
 * The easings are honoured exactly rather than approximated: the token's
 * `cubic-bezier(...)` value is parsed and evaluated, and the resulting function
 * is handed to GSAP. So `// STD` on the canvas is bit-for-bit the same curve as
 * `// STD` in the CSS — no plugin, no second definition.
 */

import gsap from "gsap";
import type { GraphEdge } from "../lib/api";
import { buildTraceChain } from "./edges";

// ---------------------------------------------------------------------------
// The tokens
// ---------------------------------------------------------------------------

/**
 * The five duration tokens the canvas may use.
 *
 * `// LOOP` is ABSENT, by name. dataviz.md: *"Anything on `// LOOP` —
 * **Forbidden on the canvas, by name.** ... This includes idling physics."*
 * It has no CSS alias either (see `tokens.css`), so there is nothing to
 * accidentally reference.
 */
export const DURATION_TOKENS = [
  "instant",
  "quick",
  "std",
  "slow",
  "cine",
] as const;
export type DurationToken = (typeof DURATION_TOKENS)[number];

/** The four easings. `// STEP` is permitted on the canvas but unused (§07). */
export const EASING_TOKENS = ["linear", "std", "spring", "step"] as const;
export type EasingToken = (typeof EASING_TOKENS)[number];

/**
 * Fallbacks, used ONLY when the stylesheet has not resolved.
 *
 * These are not a second source of truth — they are motion.md's published
 * values, and `motion.test.ts` asserts they equal what `tokens.css` declares.
 * Without them a token read before first paint would resolve to 0 ms, which
 * would look exactly like reduced motion and hide the real bug.
 */
const DURATION_FALLBACK_MS: Readonly<Record<DurationToken, number>> = {
  instant: 120,
  quick: 180,
  std: 320,
  slow: 600,
  cine: 1400,
};

const EASING_FALLBACK: Readonly<Record<EasingToken, string>> = {
  linear: "linear",
  std: "cubic-bezier(0.4, 0, 0.2, 1)",
  spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  step: "steps(8, end)",
};

/** Read a custom property off `<body>`, where the palette stamp also lives. */
function readToken(property: string): string {
  try {
    return getComputedStyle(document.body).getPropertyValue(property).trim();
  } catch {
    return "";
  }
}

/** `--t-std` -> `320`. In MILLISECONDS, because that is what the token says. */
export function durationMs(token: DurationToken): number {
  const raw = readToken(`--t-${token}`);
  const parsed = parseDuration(raw);
  return parsed ?? DURATION_FALLBACK_MS[token];
}

/** GSAP takes SECONDS. This is the only place the conversion happens. */
export function durationSec(token: DurationToken): number {
  return durationMs(token) / 1000;
}

/** `"320ms"` / `"0.32s"` -> `320`. `null` when unparseable. */
export function parseDuration(raw: string): number | null {
  const m = /^([\d.]+)\s*(ms|s)$/.exec(raw.trim());
  if (m === null) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] === "s" ? n * 1000 : n;
}

// ---------------------------------------------------------------------------
// Easing — the token's own curve, evaluated
// ---------------------------------------------------------------------------

/** Solve a cubic bezier `(x1,y1,x2,y2)` for y at progress x. */
export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): (p: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleX = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number): number => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number): number => (3 * ax * t + 2 * bx) * t + cx;

  return (p: number): number => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    // Newton-Raphson, then bisection when the derivative is flat. Standard,
    // and deterministic — a layout that cannot be re-derived violates the
    // spec's determinism limit, and easing is part of the derivation.
    let t = p;
    for (let i = 0; i < 8; i++) {
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      const e = sampleX(t) - p;
      if (Math.abs(e) < 1e-6) return sampleY(t);
      t -= e / d;
    }
    let lo = 0;
    let hi = 1;
    t = p;
    for (let i = 0; i < 24; i++) {
      const x = sampleX(t);
      if (Math.abs(x - p) < 1e-6) break;
      if (x > p) hi = t;
      else lo = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

/** `steps(n, end)` as a function, for completeness. Unused on the canvas. */
function stepsEase(n: number): (p: number) => number {
  return (p) => Math.min(1, Math.floor(p * n) / n);
}

/**
 * Resolve an easing token to a GSAP-compatible function.
 *
 * GSAP accepts a plain `(p) => value` for `ease`, so the token's exact control
 * points are honoured with no `CustomEase` plugin and no second definition of
 * the curve.
 */
export function easing(token: EasingToken): (p: number) => number {
  const raw = readToken(`--e-${token}`) || EASING_FALLBACK[token];
  const bezier = /cubic-bezier\(([^)]+)\)/.exec(raw);
  if (bezier !== null) {
    const parts = bezier[1].split(",").map((s) => Number(s.trim()));
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      return cubicBezier(parts[0], parts[1], parts[2], parts[3]);
    }
  }
  const steps = /steps\(\s*(\d+)/.exec(raw);
  if (steps !== null) return stepsEase(Number(steps[1]));
  return (p) => p; // linear
}

// ---------------------------------------------------------------------------
// The six interactions — the complete vocabulary of this canvas
// ---------------------------------------------------------------------------

export type InteractionName =
  | "entrance-settle"
  | "hover-highlight"
  | "focus-select"
  | "selection-ring"
  | "filter-to-muted"
  | "path-trace"
  | "drill-down";

export interface InteractionTiming {
  duration: DurationToken;
  ease: EasingToken;
}

/**
 * dataviz.md's *"Interaction -> token. Every movement on a canvas is one of
 * these. There are no others."*
 *
 * **D7 — the brief and the spec conflict, and the spec wins.** The brief
 * assigned focus/click `// SPRING`. `// SPRING` is an EASING, not a duration,
 * and dataviz.md's own table assigns focus `// STD` + `// STD` while reserving
 * SPRING for *node spawn*. Focus therefore runs STD/STD; SPRING appears in
 * exactly one place — the selection RING, which is a spawn.
 */
export const INTERACTIONS: Readonly<Record<InteractionName, InteractionTiming>> =
  {
    /** The live simulation IS the entrance. `cooldownTime` = this duration. */
    "entrance-settle": { duration: "cine", ease: "std" },
    /** INSTANT's published use is "hover, focus". */
    "hover-highlight": { duration: "instant", ease: "std" },
    /** STD's published use is "card reveal, expand". D7. */
    "focus-select": { duration: "std", ease: "std" },
    /** The one SPRING on the canvas — a spawn, per motion.md. D7. */
    "selection-ring": { duration: "std", ease: "spring" },
    /** A control-driven bulk state change, not a reveal. */
    "filter-to-muted": { duration: "quick", ease: "std" },
    /** LINEAR because a traversal is a ticker, not a UI response. */
    "path-trace": { duration: "slow", ease: "linear" },
    /** It IS a page transition, and page transitions are capped at SLOW. */
    "drill-down": { duration: "slow", ease: "std" },
  };

/**
 * Stagger between siblings in a reveal.
 *
 * dataviz.md: *"Stagger between siblings is **inherited from signature
 * interaction `05 · Reveal`** — reference that interaction; do not restate its
 * interval."* Code cannot reference a document, so the value is carried once,
 * here, named for its source. It is NOT a duration token and must never be
 * used as one.
 *
 * Source: motion.md, signature interaction 05 · Reveal.
 */
export const REVEAL_STAGGER_MS = 150;

// ---------------------------------------------------------------------------
// The camera — F2's workaround, in one place
// ---------------------------------------------------------------------------

/** The instantaneous camera surface. Deliberately has NO duration parameter. */
export interface Camera {
  /** Current centre. */
  centre: () => { x: number; y: number };
  /** Set the centre. INSTANTANEOUS — no duration argument exists. */
  setCentre: (x: number, y: number) => void;
  /** Current zoom. */
  scale: () => number;
  /** Set the zoom. INSTANTANEOUS. */
  setScale: (k: number) => void;
}

export interface CameraTarget {
  x?: number;
  y?: number;
  k?: number;
}

/** Cancellable handle for a running camera move. */
export interface MotionHandle {
  cancel: () => void;
}

const NOOP_HANDLE: MotionHandle = { cancel: () => undefined };

/**
 * Move the camera on a TOKEN duration and a TOKEN easing.
 *
 * This is the F2 workaround and the ONLY way the camera is ever moved. It
 * tweens plain scalars and pushes each frame through the instantaneous
 * setters, so the library never sees a duration and never applies its own
 * easing.
 *
 * Under reduced motion the target is applied in one write and NO GSAP TIMELINE
 * IS CREATED — the FR-238 `Cursor.tsx` pattern (R9). The CSS PRM block can zero
 * a transition; it cannot reach a JS timeline.
 */
export function moveCamera(
  camera: Camera,
  target: CameraTarget,
  interaction: InteractionName,
  opts: { reducedMotion: boolean; onUpdate?: () => void } = {
    reducedMotion: false,
  },
): MotionHandle {
  const centre = camera.centre();
  const from = { x: centre.x, y: centre.y, k: camera.scale() };
  const to = {
    x: target.x ?? from.x,
    y: target.y ?? from.y,
    k: target.k ?? from.k,
  };

  if (opts.reducedMotion) {
    camera.setCentre(to.x, to.y);
    camera.setScale(to.k);
    opts.onUpdate?.();
    return NOOP_HANDLE;
  }

  const timing = INTERACTIONS[interaction];
  const state = { ...from };
  const tween = gsap.to(state, {
    x: to.x,
    y: to.y,
    k: to.k,
    duration: durationSec(timing.duration),
    ease: easing(timing.ease),
    onUpdate: () => {
      // The instantaneous forms. Never `centerAt(x, y, ms)`, never
      // `zoom(k, ms)` — that is F2, and T8 scans for it.
      camera.setCentre(state.x, state.y);
      camera.setScale(state.k);
      opts.onUpdate?.();
    },
  });

  return { cancel: () => tween.kill() };
}

/**
 * Tween a bare scalar on a token timing — emphasis, filter progress, trace
 * position, ring radius.
 *
 * One tween drives a bulk change over N elements because the ACCESSORS read the
 * scalar; a thousand-node filter costs one tween, not a thousand.
 */
export function tweenScalar(
  interaction: InteractionName,
  from: number,
  to: number,
  onUpdate: (value: number) => void,
  opts: { reducedMotion: boolean; onComplete?: () => void } = {
    reducedMotion: false,
  },
): MotionHandle {
  if (opts.reducedMotion) {
    onUpdate(to);
    opts.onComplete?.();
    return NOOP_HANDLE;
  }
  const timing = INTERACTIONS[interaction];
  const state = { v: from };
  const tween = gsap.to(state, {
    v: to,
    duration: durationSec(timing.duration),
    ease: easing(timing.ease),
    onUpdate: () => onUpdate(state.v),
    onComplete: () => opts.onComplete?.(),
  });
  return { cancel: () => tween.kill() };
}

// ---------------------------------------------------------------------------
// Interaction 5 — the path trace, with an OBSERVABLE duration
// ---------------------------------------------------------------------------

/** A running trace. `durationMs` is what makes the `// SLOW` cap measurable. */
export interface TraceHandle extends MotionHandle {
  /**
   * The tween's total duration in milliseconds.
   *
   * ONE value, computed from the token and NOT from the hop count. It is
   * exposed so a test can drive a 3-hop and a 30-hop chain and compare the
   * OBSERVED durations, instead of reading a constant twice and calling that a
   * cap. A timing bound you cannot observe is not a bound.
   */
  durationMs: number;
}

/**
 * Run the path trace: ONE continuous tween over normalised path position.
 *
 * dataviz.md: *"One continuous tween, capped at SLOW regardless of path
 * length — long paths trace FASTER, they do not take LONGER. That cap is what
 * stops per-hop durations from being invented."*
 *
 * **The cap is structural here, not merely intended.** `hopCount` is used only
 * to map progress onto a hop index; it never reaches the duration. There is
 * exactly one `tweenScalar` call and its `onComplete` does not re-enter — a
 * per-hop chain (tween hop 1, then hop 2 from its `onComplete`, …) would make a
 * 30-hop trace take 18 seconds while every duration in the file still read
 * `// SLOW`. That mutation was written and it passed the whole suite, which is
 * why this function exists rather than the loop living inline in `useGraph`.
 */
export function runPathTrace(
  hopCount: number,
  onReached: (reached: number) => void,
  opts: { reducedMotion: boolean; onComplete?: () => void },
): TraceHandle {
  const ms = durationMs(INTERACTIONS["path-trace"].duration);
  const handle = tweenScalar(
    "path-trace",
    0,
    1,
    (v) => onReached(Math.ceil(v * hopCount)),
    { reducedMotion: opts.reducedMotion, onComplete: opts.onComplete },
  );
  return { cancel: handle.cancel, durationMs: ms };
}

/** What a running trace reports back to the canvas. */
export interface TraceHooks {
  /** The traced edge ids so far. These are the canvas's only `hot` edges. */
  onTraced: (ids: Set<string>) => void;
  /** Interaction entry — the caller resumes the render loop here. */
  onStart: () => void;
  /** Interaction exit. `hot` must be gone by the time this returns. */
  onEnd: () => void;
}

/**
 * Build the chain and run it. **The whole trace composition, in one place.**
 *
 * WHY THIS EXISTS RATHER THAN LIVING IN `useGraph.traceFrom`:
 *
 * `runPathTrace` is a single tween and is wall-clock tested, but a unit test on
 * the unit says nothing about how the CALLER composes it. A per-hop chain
 * written in the caller — `runPathTrace(1, …)` once per hop, chained through
 * `onComplete` — makes a 30-hop trace take 18 seconds while satisfying every
 * structural ban: no `"path-trace"` literal in the caller, `runPathTrace`'s own
 * body untouched, no `hops *` term anywhere. It was written, and it passed
 * 237/237.
 *
 * So the composition moved here, where it can be driven directly and timed at 3
 * hops and at 30. `useGraph` now only forwards. Two guards cover the family
 * rather than the instance: this function calls `runPathTrace` EXACTLY ONCE and
 * passes `chain.length` — never a literal — and the source scan pins both.
 *
 * Returns `null` when there is nothing to trace. That is the common case, not
 * an edge case: 1,780 of 2,438 live nodes have no outgoing chain.
 */
export function startTrace(
  edges: readonly GraphEdge[],
  startKey: string,
  hooks: TraceHooks,
  opts: { reducedMotion: boolean },
): TraceHandle | null {
  const chain = buildTraceChain(edges, startKey);
  if (chain.length === 0) return null;

  hooks.onStart();
  hooks.onTraced(new Set());
  return runPathTrace(
    chain.length,
    (reached) => hooks.onTraced(new Set(chain.slice(0, reached).map((e) => e.id))),
    {
      reducedMotion: opts.reducedMotion,
      onComplete: () => {
        // Hot exists only WHILE the interaction is active.
        hooks.onTraced(new Set());
        hooks.onEnd();
      },
    },
  );
}
