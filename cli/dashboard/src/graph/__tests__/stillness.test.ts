/**
 * FR-239 (T6) — **the anti-fake test.**
 *
 * This file does not test the canvas. It tests the INSTRUMENT that tests the
 * canvas, and it is the layer that stops AC #5 from existing, passing, and
 * proving nothing (R2).
 *
 * The failure mode being defended against is specific and cheap to fall into: a
 * probe that returns `identical: true` unconditionally would make the AC-#5
 * checkpoint green forever. Three of the four cases below fail such a probe.
 *
 * Collection of this directory by `cd cli && npm test` was verified empirically
 * before this file was written (plan phase 1.9, `npx vitest list`) — a test that
 * does not run is worse than no test.
 */

import { describe, expect, it } from "vitest";
import {
  SAMPLE_INTERVAL_MS,
  fnv1a,
  probe,
  type StillnessClock,
  type StillnessSurface,
} from "../stillness.js";

/**
 * A virtual clock. Real time would make this file take 12+ seconds for four
 * assertions, and a slow test is a test people stop running.
 *
 * `sleep` advances the clock by exactly the requested interval, so the sample
 * COUNT the probe takes here is the same count it would take in a browser.
 */
function fakeClock(): StillnessClock {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

/** ~8 M bytes — the order of a 1400x900 canvas at DPR 2 (2800*1626*4 ≈ 18 M). */
const BIG = 8_000_000;

function buffer(size = BIG): Uint8ClampedArray {
  const b = new Uint8ClampedArray(size);
  // Non-uniform, so a hash of it is not trivially the hash of zeroes.
  for (let i = 0; i < size; i += 997) b[i] = (i % 251) + 1;
  return b;
}

describe("T6 — the instrument detects what it must detect", () => {
  it("STATIC surface -> identical: true, samples: 1", async () => {
    const buf = buffer();
    const surface: StillnessSurface = { read: () => buf };

    const r = await probe(surface, 3000, fakeClock());

    expect(r.identical).toBe(true);
    expect(r.samples).toBe(1);
    expect(r.hashA).toBe(r.hashB);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(3000);
    // 3000 / 250 + 1 = 13 captures. Pinned so a silent change to the sampling
    // strategy cannot quietly turn this into an endpoints-only probe.
    expect(r.captures).toBe(3000 / SAMPLE_INTERVAL_MS + 1);
  });

  it("MUTATING surface -> identical: FALSE", async () => {
    const buf = buffer();
    let n = 0;
    const surface: StillnessSurface = {
      read: () => {
        n += 1;
        if (n === 4) buf[1234] = (buf[1234] + 1) & 0xff;
        return buf;
      },
    };

    const r = await probe(surface, 3000, fakeClock());

    // THE load-bearing assertion of this file. A probe hard-coded to `true`
    // dies here.
    expect(r.identical).toBe(false);
    expect(r.samples).toBeGreaterThan(1);
  });

  it("MUTATE-AND-RESTORE -> identical: FALSE, even though hashA === hashB", async () => {
    const buf = buffer();
    const original = buf[4242];
    let elapsed = 0;
    const surface: StillnessSurface = {
      read: () => {
        // Changes at ~500 ms, restored by ~2500 ms — entirely inside the window.
        if (elapsed >= 500 && elapsed < 2500) buf[4242] = (original + 7) & 0xff;
        else buf[4242] = original;
        elapsed += SAMPLE_INTERVAL_MS;
        return buf;
      },
    };

    const r = await probe(surface, 3000, fakeClock());

    // This is precisely why `identical` is `samples === 1` and not
    // `hashA === hashB`. An endpoints-only probe reports TRUE here and misses a
    // canvas that visibly moved for two full seconds.
    expect(r.hashA).toBe(r.hashB);
    expect(r.identical).toBe(false);
    expect(r.samples).toBe(2);
  });

  it("ONE BYTE of ~8 M -> identical: FALSE (there is no tolerance)", async () => {
    const buf = buffer();
    let n = 0;
    const surface: StillnessSurface = {
      read: () => {
        n += 1;
        // A single byte, once, out of eight million — one sub-pixel channel.
        if (n === 7) buf[BIG - 3] = (buf[BIG - 3] + 1) & 0xff;
        return buf;
      },
    };

    const r = await probe(surface, 3000, fakeClock());

    expect(r.identical).toBe(false);
    // The flip is permanent, so the window holds exactly two states.
    expect(r.samples).toBe(2);
    expect(r.hashA).not.toBe(r.hashB);
  });
});

describe("T6 — the probe has no way to be told to look away", () => {
  it("exposes no tolerance, region or ignore-list parameter", () => {
    // `probe(surface, windowMs, clock = DEFAULT)`. `Function.length` counts
    // parameters BEFORE the first default, so 2 is the required arity — the
    // surface and the window, and nothing that could tell it what to overlook.
    expect(probe.length).toBe(2);
    // Belt: the signature itself must not grow a tolerance-shaped word. This
    // reads the module source because the point is to catch the parameter
    // being ADDED, which a behavioural test by definition cannot.
    const src = probe.toString();
    for (const word of ["tolerance", "threshold", "epsilon", "ignore", "fuzz"]) {
      expect(src.toLowerCase(), `probe mentions "${word}"`).not.toContain(word);
    }
  });

  it("the clock is injectable but defaults to real time", async () => {
    // Guards against the inverse fake: a probe that only ever runs on a fake
    // clock proves nothing about a real 3-second window. The default path must
    // work, so this one really does wait.
    const buf = buffer(1024);
    const r = await probe({ read: () => buf }, 40);
    expect(r.identical).toBe(true);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(40);
  });
});

describe("T6 — FNV-1a behaves like a change detector", () => {
  it("is stable for identical input", () => {
    expect(fnv1a(buffer(10_000))).toBe(fnv1a(buffer(10_000)));
  });

  it("changes when any single byte changes", () => {
    const a = buffer(10_000);
    const b = buffer(10_000);
    b[9_999] = (b[9_999] + 1) & 0xff;
    expect(fnv1a(a)).not.toBe(fnv1a(b));
  });

  it("distinguishes a transposition (order-sensitive, not a checksum)", () => {
    const a = new Uint8ClampedArray([1, 2, 3, 4]);
    const b = new Uint8ClampedArray([1, 3, 2, 4]);
    expect(fnv1a(a)).not.toBe(fnv1a(b));
  });

  it("emits a fixed-width lowercase hex digest", () => {
    expect(fnv1a(buffer(1000))).toMatch(/^[0-9a-f]{8}$/);
  });
});
