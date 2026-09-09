/**
 * PORTED from fifty_dev's `<Cursor />` chrome component — the ring + dot
 * pointer (BRAND_RULES "custom cursor (dot/ring)").
 *
 * Two motion paths, deliberately:
 *  - GSAP `quickTo` for the ring, which is the whole reason GSAP is in the
 *    bundle at FR-238 scale (D2: keep it, FR-239's canvas needs it two briefs
 *    later, and two motion implementations is the anti-pattern);
 *  - a direct transform write for the dot, which must track the pointer with
 *    zero lag.
 *
 * R9: under `prefers-reduced-motion` NO GSAP timeline is created at all — the
 * ring is positioned directly. The CSS PRM block is the backstop, this is the
 * gate.
 *
 * Bails entirely on a coarse pointer (touch): a custom cursor on a device with
 * no cursor is dead weight and `cursor: none` there would be actively hostile.
 */
import { useEffect, useRef } from "react";
import gsap from "gsap";
import { useReducedMotion } from "../../lib/usePalette";

export function Cursor() {
  const dotRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const dot = dotRef.current;
    const ring = ringRef.current;
    if (!dot || !ring) return;

    const coarse = window.matchMedia("(pointer: coarse)").matches;
    if (coarse) {
      document.body.setAttribute("data-cursor", "default");
      return;
    }
    document.body.setAttribute("data-cursor", "dot");

    let moveRing: (x: number, y: number) => void;
    if (reduced) {
      moveRing = (x, y) => {
        ring.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      };
    } else {
      const toX = gsap.quickTo(ring, "x", { duration: 0.35, ease: "power3" });
      const toY = gsap.quickTo(ring, "y", { duration: 0.35, ease: "power3" });
      gsap.set(ring, { xPercent: -50, yPercent: -50 });
      moveRing = (x, y) => {
        toX(x);
        toY(y);
      };
    }

    const onMove = (e: PointerEvent): void => {
      dot.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -50%)`;
      moveRing(e.clientX, e.clientY);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      gsap.killTweensOf(ring);
    };
  }, [reduced]);

  return (
    <>
      <div ref={dotRef} className="cur-dot" aria-hidden />
      <div ref={ringRef} className="cur-ring" aria-hidden />
    </>
  );
}
