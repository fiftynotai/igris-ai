/**
 * FR-238 — a hash router. FR-240 gave it sub-paths; it is still a `switch`.
 *
 * WHY HASH AND NOT HISTORY: every API call in `lib/api.ts` is a RELATIVE URL
 * (`api/health`), which is what makes AC #4 mechanically greppable in the built
 * bundle. A history router changes `location.pathname`, so a relative fetch
 * from `/graph` would resolve to `/api/health` only by accident of depth — one
 * nested route later it silently breaks. A hash route leaves the pathname at
 * `/` forever, so relative URLs are correct by construction.
 *
 * FR-240 makes that argument load-bearing rather than theoretical: its routes
 * are FOUR segments deep (`#/layers/briefs/igris-ai/BR-001`). Under a history
 * router every relative fetch on that page would resolve against
 * `/layers/briefs/igris-ai/`, and the whole dashboard would 404 on a deep link.
 *
 * The server's SPA fallback (`static.ts`) still exists and is still correct —
 * it just means a hand-typed deep path lands on the shell instead of a 404.
 *
 * WHY NOT react-router: four routes and one sub-path grammar. A router
 * dependency would be ~10 KB packed against a cumulative ceiling FR-239 has
 * already spent 71% of.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SUB-PATH GRAMMAR LIVES IN `layers/model.ts`, NOT HERE
 * ─────────────────────────────────────────────────────────────────────────
 * `#/layers/<layer>/<project>/<id>` is the D5 record address, and BR-078 makes
 * the `(project, id)` pairing a correctness property rather than a formatting
 * choice — `BR-001` names a different brief in 25 projects. Its codec is
 * therefore a PURE, UNIT-TESTED module (`layers/model.ts#parseLayersHash` /
 * `#recordHash` / `#parseGraphFocus`) and this file calls it. A second parser
 * here would be a second chance to drop the project segment.
 */
import { useEffect, useState } from "react";
import {
  LAYER_IDS,
  parseGraphFocus,
  parseLayersHash,
  type LayerId,
  type NodeTriple,
  type RecordAddress,
} from "./layers/model";

export const ROUTES = ["overview", "graph", "layers", "triage"] as const;
export type Route = (typeof ROUTES)[number];

/**
 * Routes whose owning brief has not shipped yet. Rendered, but not enterable.
 *
 * `graph` left this map when FR-239 shipped and `layers` left it when FR-240
 * did — one line deleted and a page mounted, which is the whole pattern FR-241
 * inherits.
 */
export const PENDING_ROUTES: Partial<Record<Route, string>> = {
  triage: "FR-241",
};

export const ROUTE_LABELS: Record<Route, string> = {
  overview: "Overview",
  graph: "Graph",
  layers: "Layers",
  triage: "Triage",
};

/** Everything the shell needs to know about the current location. */
export interface RouteState {
  route: Route;
  /** The selected layer. Meaningful on `layers` only; defaulted elsewhere. */
  layer: LayerId;
  /** The record being read, or `null` for the list. */
  address: RecordAddress | null;
  /** `#/graph?focus=<type>/<project>/<id>` — the LOCATE IN GRAPH target. */
  focus: NodeTriple | null;
}

function parse(hash: string): RouteState {
  // The FIRST segment is the route. FR-238 compared the whole hash, which was
  // correct while every route was one segment; a four-segment layers address
  // would have fallen through to `overview`.
  const path = hash.replace(/^#\/?/, "").split("?")[0] ?? "";
  const head = path.split("/")[0] ?? "";
  const route: Route = (ROUTES as readonly string[]).includes(head)
    ? (head as Route)
    : "overview";

  const layers = parseLayersHash(hash);

  return {
    route,
    layer: route === "layers" ? layers.layer : (LAYER_IDS[0] as LayerId),
    address: route === "layers" ? layers.address : null,
    focus: route === "graph" ? parseGraphFocus(hash) : null,
  };
}

export function useRoute(): [RouteState, (next: Route) => void] {
  const [state, setState] = useState<RouteState>(() => parse(location.hash));

  useEffect(() => {
    const onHash = (): void => setState(parse(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = (next: Route): void => {
    location.hash = `#/${next}`;
  };

  return [state, navigate];
}
