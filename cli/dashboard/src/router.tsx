/**
 * FR-238 — a ~40-line hash router.
 *
 * WHY HASH AND NOT HISTORY: every API call in `lib/api.ts` is a RELATIVE URL
 * (`api/health`), which is what makes AC #4 mechanically greppable in the built
 * bundle. A history router changes `location.pathname`, so a relative fetch
 * from `/graph` would resolve to `/api/health` only by accident of depth — one
 * nested route later it silently breaks. A hash route leaves the pathname at
 * `/` forever, so relative URLs are correct by construction.
 *
 * The server's SPA fallback (`static.ts`) still exists and is still correct —
 * it just means a hand-typed deep path lands on the shell instead of a 404.
 *
 * WHY NOT react-router: four routes, three of which are disabled placeholders.
 * A router dependency here would be ~10 KB packed for a `switch`.
 */
import { useEffect, useState } from "react";

export const ROUTES = ["overview", "graph", "layers", "triage"] as const;
export type Route = (typeof ROUTES)[number];

/** Routes whose owning brief has not shipped yet. Rendered, but not enterable. */
export const PENDING_ROUTES: Partial<Record<Route, string>> = {
  graph: "FR-239",
  layers: "FR-240",
  triage: "FR-241",
};

export const ROUTE_LABELS: Record<Route, string> = {
  overview: "Overview",
  graph: "Graph",
  layers: "Layers",
  triage: "Triage",
};

function parse(hash: string): Route {
  const slug = hash.replace(/^#\/?/, "").split("?")[0];
  return (ROUTES as readonly string[]).includes(slug)
    ? (slug as Route)
    : "overview";
}

export function useRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parse(location.hash));

  useEffect(() => {
    const onHash = (): void => setRoute(parse(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = (next: Route): void => {
    location.hash = `#/${next}`;
  };

  return [route, navigate];
}
