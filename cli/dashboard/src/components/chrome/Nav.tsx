/**
 * FR-238 — the persistent shell nav.
 *
 * The three unshipped routes are RENDERED, disabled, and labelled with the
 * brief that owns them. The shell should read as a product with sections
 * arriving, not as a stub with one page.
 *
 * The SEARCH SLOT is reserved here on purpose. `docs/brand/dataviz.md` requires
 * a Tier-C canvas to ship a real, tap-target-compliant search/filter control in
 * the surrounding chrome; retrofitting nav geometry after the canvas exists is
 * expensive, so the slot (and its 44px min-height) lands now and FR-239 fills
 * it.
 */
import { PaletteSwitcher } from "./PaletteSwitcher";
import { LiveIndicator } from "./LiveIndicator";
import { ROUTES, ROUTE_LABELS, PENDING_ROUTES, type Route } from "../../router";
import type { Palette } from "../../lib/usePalette";
import type { Live } from "../../lib/useLive";

export interface NavProps {
  route: Route;
  onNavigate: (next: Route) => void;
  palette: Palette;
  onPalette: (next: Palette) => void;
  live: Live;
}

export function Nav({ route, onNavigate, palette, onPalette, live }: NavProps) {
  return (
    <nav className="shell-nav" aria-label="Dashboard sections">
      <a className="shell-brand" href="#/overview">
        IGRIS<span>.</span>
      </a>

      <div className="shell-nav-links">
        {ROUTES.map((r) => {
          const pending = PENDING_ROUTES[r];
          if (pending) {
            return (
              <span
                key={r}
                className="shell-nav-link"
                aria-disabled="true"
                title={`${ROUTE_LABELS[r]} — ships with ${pending}`}
              >
                {ROUTE_LABELS[r]}
              </span>
            );
          }
          return (
            <button
              key={r}
              type="button"
              className="shell-nav-link"
              aria-current={route === r ? "page" : undefined}
              onClick={() => onNavigate(r)}
            >
              {ROUTE_LABELS[r]}
            </button>
          );
        })}
      </div>

      <span className="shell-nav-spacer" />

      {/* dataviz.md forward obligation (a) — reserved, filled by FR-239. */}
      <div className="shell-search-slot" data-slot="search" aria-hidden />

      <LiveIndicator live={live} />
      <PaletteSwitcher palette={palette} onChange={onPalette} />
    </nav>
  );
}
