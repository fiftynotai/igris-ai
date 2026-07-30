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
import { Input } from "../ui/Input";
import { ROUTES, ROUTE_LABELS, PENDING_ROUTES, type Route } from "../../router";
import type { Palette } from "../../lib/usePalette";
import type { Live } from "../../lib/useLive";

export interface NavProps {
  route: Route;
  onNavigate: (next: Route) => void;
  palette: Palette;
  onPalette: (next: Palette) => void;
  live: Live;
  /** FR-239 — the Tier C search control. State lives in `App`. */
  search: string;
  onSearch: (next: string) => void;
}

export function Nav({
  route,
  onNavigate,
  palette,
  onPalette,
  live,
  search,
  onSearch,
}: NavProps) {
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

      {/*
        dataviz.md §04's Tier C obligation, filled by FR-239: "A Tier C canvas
        must also ship a real, tap-target-compliant search or filter control in
        the surrounding chrome. Pointing at a specific node is never the only
        way to reach it."

        Rendered on the two routes that have something to mute. On every other
        route the slot stays empty and keeps its 44 px min-height, so the nav
        geometry does not shift as the operator navigates — which is why FR-238
        reserved it in the first place.

        FR-240 REUSES THE SAME STATE, WITH DIFFERENT COPY, ON PURPOSE. On both
        routes this control is a CLIENT-SIDE MUTE over data already in memory
        (`// QUICK`) — it never issues a request. The learnings layer's HYBRID
        RECALL is a different operation with a different cost, so it has its own
        box inside the view rather than borrowing this one. Two controls, because
        there are two operations; the placeholders say which is which.
      */}
      <div className="shell-search-slot" data-slot="search">
        {(route === "graph" || route === "layers") && (
          <Input
            type="search"
            value={search}
            placeholder={route === "graph" ? "FIND A NODE" : "FILTER THIS PAGE"}
            aria-label={
              route === "graph"
                ? "Search the graph by label or id"
                : "Filter the loaded rows by text"
            }
            onChange={(e) => onSearch(e.target.value)}
          />
        )}
      </div>

      <LiveIndicator live={live} />
      <PaletteSwitcher palette={palette} onChange={onPalette} />
    </nav>
  );
}
