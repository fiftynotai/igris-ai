/**
 * FR-245 — which ARRANGEMENT of a layer the operator is looking at.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * D4 — WHY `sessionStorage`, AND WHY NOT THE THREE ALTERNATIVES
 * ─────────────────────────────────────────────────────────────────────────
 * Component state in `Briefs.tsx`: `router.tsx` UNMOUNTS the page on a route
 * change, so Graph -> Layers would silently drop back to the list. The AC says
 * the choice persists across navigation.
 *
 * The URL: `layerHash()` and `recordHash()` would each have to carry the view
 * or the BACK TO LIST link would drop it, and `dashboard-layers-source.test.ts`
 * pins that NOTHING outside `layers/model.ts` builds a `#/layers/` href — so
 * the viralness lands on the one file whose codec BR-078 makes
 * correctness-critical. `pages/Layers.tsx` also records the deliberate
 * precedent that a FILTER (project scope) is not in the URL, because sharing a
 * link should not force the recipient into the sender's arrangement. A view
 * toggle is the same class of thing.
 *
 * `localStorage`: it would make the board sticky across restarts. The list
 * stays the default until there is reason to change it, and a preference that
 * outlives the session is a different (larger) claim than this brief makes.
 *
 * So: `sessionStorage`, which is scoped to the browsing context. It survives
 * unmount, route changes and a RELOAD — a session is the tab, not the document
 * — and a fresh tab opens on the list. That last property is the one that
 * distinguishes it from `localStorage` observably, and it is what `G-BR-12d`
 * measures.
 *
 * The try/catch is `usePalette.ts`'s, for its reason: storage THROWS in private
 * mode and in a partitioned third-party context, and a view toggle must degrade
 * to "this page only" rather than to a blank page.
 */

import { useCallback, useState } from "react";

export const LAYER_VIEWS = ["list", "board"] as const;
export type LayerView = (typeof LAYER_VIEWS)[number];

/** Namespaced like `igris.dashboard.tweaks`, so it cannot collide with a host page. */
const STORAGE_KEY = "igris.dashboard.layers.view";

/** The list is the default, and stays it. */
const DEFAULT_VIEW: LayerView = "list";

function isView(value: unknown): value is LayerView {
  return typeof value === "string" && (LAYER_VIEWS as readonly string[]).includes(value);
}

function readStored(): LayerView | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return isView(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function useLayersView(): [LayerView, (next: LayerView) => void] {
  const [view, setViewState] = useState<LayerView>(() => readStored() ?? DEFAULT_VIEW);

  const setView = useCallback((next: LayerView) => {
    setViewState(next);
    try {
      sessionStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode / disabled storage — the choice still applies to this page */
    }
  }, []);

  return [view, setView];
}
