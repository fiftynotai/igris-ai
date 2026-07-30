/**
 * FR-239 — the AC #5 instrument.
 *
 * > *"Nothing moves visibly at rest. After the entrance settles, no node or edge
 * > changes position or appearance without pointer input. Verified by capturing
 * > the canvas twice at least 3 seconds apart with no interaction and diffing —
 * > the two captures must be identical."*
 *
 * WHY THIS FILE EXISTS AT ALL, STATED HONESTLY
 * --------------------------------------------
 * The original design for this brief was a bespoke renderer with exactly one
 * `requestAnimationFrame` call site, so "nothing can move at rest" was a
 * STRUCTURAL property provable by a source scan. The operator chose a library
 * instead. That trade is recorded in the brief; its consequence is here:
 * stillness is no longer *proved*, it is **measured**. A library that repaints
 * byte-identical pixels forever now passes — which is what the restated AC
 * says, and the honest limit of this method.
 *
 * THE THREE PROPERTIES THAT KEEP THIS FROM BEING THEATRE
 * ------------------------------------------------------
 * 1. **No tolerance parameter.** Byte equality over an FNV-1a hash of the whole
 *    backing store. A `tolerance` argument is how an AC like this gets quietly
 *    faked, so the function does not have one and must never grow one.
 * 2. **Sampled across the window, not at its endpoints.** A repaint that moves
 *    and moves back between two endpoint captures would report `true`. Sampling
 *    every 250 ms makes `identical` a statement about the whole window.
 *    `identical` is therefore `distinctHashes === 1`, NOT `hashA === hashB` —
 *    those disagree exactly in the mutate-and-restore case, which is the case
 *    that matters.
 * 3. **Pure over an injected surface.** No DOM, no real clock. `probe()` is
 *    driven directly by vitest against four synthetic surfaces (T6), including
 *    one that flips a single byte of ~8 M. A probe that always returns `true`
 *    fails three of those four.
 *
 * SCOPE. The probe reads the CANVAS and nothing else. The grain, the cursor
 * ring and the live dot are separate DOM elements outside it, so the chrome's
 * permitted `// LOOP` motion cannot pollute a capture.
 */

/** One capture's worth of bytes. Whatever produced them is the caller's problem. */
export interface StillnessSurface {
  /**
   * Read the full backing store, once. For a canvas this is
   * `getImageData(0, 0, canvas.width, canvas.height).data` — the DPR-SCALED
   * buffer, not the CSS-pixel one, because a sub-CSS-pixel repaint is still a
   * repaint.
   */
  read(): ArrayLike<number>;
}

export interface StillnessResult {
  /** Hash of the FIRST capture. */
  hashA: string;
  /** Hash of the LAST capture, chronologically. */
  hashB: string;
  /** `true` iff every capture in the window hashed identically. */
  identical: boolean;
  /** Count of DISTINCT hashes seen. `1` is the only passing value. */
  samples: number;
  /** Wall time the window actually covered. Always >= the requested window. */
  elapsedMs: number;
  /** How many captures were taken. Diagnostic only. */
  captures: number;
}

/** Injected so the unit tests do not have to wait three real seconds. */
export interface StillnessClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_CLOCK: StillnessClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Interval between captures.
 *
 * 250 ms over a 3 s window is 13 captures. Fine enough that a
 * settle-drift-resettle cycle cannot hide between two of them, coarse enough
 * that hashing ~18 MB per capture (2800x1626 at DPR 2) does not itself become
 * the thing perturbing the frame budget.
 */
export const SAMPLE_INTERVAL_MS = 250;

/**
 * FNV-1a, 32-bit, over raw bytes.
 *
 * Chosen over a cryptographic hash because this is a CHANGE detector, not a
 * security boundary, and it has to run over ~18 MB inside a 250 ms budget. A
 * 32-bit digest has a ~1 in 4.3 billion chance of colliding on any given pair;
 * across 13 captures that risk is negligible against the alternative of a
 * probe too slow to sample at all.
 */
export function fnv1a(bytes: ArrayLike<number>): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    // h *= 16777619, via shifts — the 32-bit multiply overflows a JS number.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Capture the surface repeatedly across `windowMs` and report whether anything
 * changed.
 *
 * There is deliberately NO tolerance, NO region-of-interest and NO ignore-list.
 * Every one of those would be a place to hide a moving pixel.
 */
export async function probe(
  surface: StillnessSurface,
  windowMs: number,
  clock: StillnessClock = DEFAULT_CLOCK,
): Promise<StillnessResult> {
  const t0 = clock.now();
  const seen = new Set<string>();
  let hashA = "";
  let hashB = "";
  let captures = 0;

  for (;;) {
    const h = fnv1a(surface.read());
    captures += 1;
    if (captures === 1) hashA = h;
    hashB = h;
    seen.add(h);
    if (clock.now() - t0 >= windowMs) break;
    await clock.sleep(SAMPLE_INTERVAL_MS);
  }

  return {
    hashA,
    hashB,
    // NOT `hashA === hashB`. A canvas that drifts and returns would satisfy
    // that and still have moved — which is the exact failure the 250 ms
    // sampling exists to catch.
    identical: seen.size === 1,
    samples: seen.size,
    elapsedMs: Math.round(clock.now() - t0),
    captures,
  };
}

/**
 * Adapt a real `<canvas>` into a `StillnessSurface`.
 *
 * The only DOM-touching function in this module, and it touches it lazily so
 * the node-environment vitest run can import everything above without a DOM.
 *
 * `willReadFrequently` matters: without it a repeated `getImageData` on a
 * GPU-backed canvas forces a readback each call and can itself cost more than
 * the sample interval.
 */
export function canvasSurface(canvas: HTMLCanvasElement): StillnessSurface {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx === null) {
    throw new Error("stillness: canvas has no 2d context");
  }
  return {
    read: () => ctx.getImageData(0, 0, canvas.width, canvas.height).data,
  };
}
