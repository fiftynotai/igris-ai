/**
 * FR-238 — palette state, stamped on `<body data-palette>`.
 *
 * The four palettes are BRAND_RULES' four: `blood` (default), `cyber`, `acid`,
 * `mono`. Names and values are upstream's (globals.css:126-149) — see
 * `styles/tokens.css`.
 *
 * The stamp is applied twice, on purpose:
 *   - pre-hydration by the inline script in `index.html` (ported from
 *     `layout.tsx`'s TWEAKS_INIT_SCRIPT), so a reload never flashes the
 *     default palette;
 *   - on every change by this hook.
 * Both read the SAME storage key. Keep them in sync.
 */
import { useCallback, useEffect, useState } from "react";

export const PALETTES = ["blood", "cyber", "acid", "mono"] as const;
export type Palette = (typeof PALETTES)[number];

/** Namespaced so it can never collide with fifty.dev's own `fifty.tweaks`. */
const STORAGE_KEY = "igris.dashboard.tweaks";

function isPalette(value: unknown): value is Palette {
  return (
    typeof value === "string" && (PALETTES as readonly string[]).includes(value)
  );
}

function readStored(): Palette | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const candidate = (parsed as { palette?: unknown } | null)?.palette;
    return isPalette(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function persist(palette: Palette): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const existing: unknown = raw ? JSON.parse(raw) : {};
    const next = {
      ...(typeof existing === "object" && existing !== null ? existing : {}),
      palette,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode / disabled storage — the palette still applies this session */
  }
}

export function usePalette(): [Palette, (next: Palette) => void] {
  const [palette, setPaletteState] = useState<Palette>(() => {
    const stamped = document.body.getAttribute("data-palette");
    if (isPalette(stamped)) return stamped;
    return readStored() ?? "blood";
  });

  useEffect(() => {
    document.body.setAttribute("data-palette", palette);
  }, [palette]);

  const setPalette = useCallback((next: Palette) => {
    setPaletteState(next);
    persist(next);
  }, []);

  return [palette, setPalette];
}

/**
 * BRAND_RULES #7 / R9. The CSS `@media (prefers-reduced-motion: reduce)` block
 * zeroes every duration as a backstop, but a GSAP timeline is JS state that CSS
 * cannot reach. Every timeline in the shell is gated on this hook, so under PRM
 * no timeline is even CREATED.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    } catch {
      return;
    }
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
