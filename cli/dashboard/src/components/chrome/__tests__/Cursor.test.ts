import { afterEach, describe, expect, it } from "vitest";
import gsap from "gsap/gsap-core";
import { followRing } from "../Cursor";

afterEach(() => {
  gsap.globalTimeline.clear();
  gsap.ticker.sleep();
});

describe("cursor scalar motion", () => {
  const ring = () => ({ style: { transform: "" } as CSSStyleDeclaration });

  it("preserves the ring's easing and centring, then releases both tweens", () => {
    const target = ring();
    const position = { x: 0, y: 0 };
    const follower = followRing(target, position, false);
    follower.move(100, 200);
    const tweens = gsap.getTweensOf(position);
    expect(tweens).toHaveLength(2);
    for (const tween of tweens) tween.pause().time(0.175, false);
    expect(target.style.transform).toBe("translate(93.75px, 187.5px) translate(-50%, -50%)");
    follower.move(300, 400);
    for (const tween of tweens) tween.pause().time(0.35, false);
    expect(target.style.transform).toBe("translate(300px, 400px) translate(-50%, -50%)");
    follower.dispose();
    follower.dispose();
    expect(gsap.getTweensOf(position)).toHaveLength(0);
  });

  it("tracks directly under reduced motion without creating a tween", () => {
    const target = ring();
    const position = { x: 25, y: 50 };
    const follower = followRing(target, position, true);
    follower.move(400, 600);
    expect(target.style.transform).toBe("translate(400px, 600px) translate(-50%, -50%)");
    expect(gsap.getTweensOf(position)).toHaveLength(0);
    follower.dispose();
  });
});
