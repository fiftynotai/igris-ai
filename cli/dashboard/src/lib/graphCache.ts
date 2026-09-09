/**
 * FR-240 (D6) — the scope→payload cache, hoisted out of `pages/Graph.tsx`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT MOVED, AND WHAT DID NOT
 * ─────────────────────────────────────────────────────────────────────────
 * FR-239 kept this cache in a `useRef<Map<string, ScopeCache>>` private to the
 * graph page. Its LOGIC is unchanged here — same key (`""` is the whole brain),
 * same entry shape (`{payload, positions}`), same rule that a fresh fetch resets
 * `positions` to `{}` and a settle writes them back.
 *
 * What changed is the LIFETIME, and that is the entire point of the move. A
 * brief detail view wants the same project-scoped `/api/graph` payload the graph
 * page wants (D6: the neighbours come from the existing endpoint, not a new
 * traversal one). With the cache private to a page, opening a brief and then
 * opening the graph paid for that ~1 MB payload twice, and — worse — the two
 * surfaces could be looking at two different generations of the graph while
 * claiming to show the same neighbourhood.
 *
 * A module-level store is therefore not laziness about React state; it is the
 * requirement. The cache outlives every component precisely so two components
 * can share one fetch.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE FETCH IS MODULE-OWNED AND NOT CANCELLABLE. DELIBERATE.
 * ─────────────────────────────────────────────────────────────────────────
 * `Graph.tsx` used to pass its own `AbortSignal` into `api.graph`, so unmounting
 * mid-fetch cancelled it. It cannot here: two consumers share one in-flight
 * promise, and letting either of them abort it would cancel the OTHER's read.
 *
 * So the in-flight fetch runs to completion and lands in the cache, and each
 * CALLER still passes its signal — used to decide whether to apply the result,
 * never to cancel the request. The abandoned work is not wasted: it populates
 * the cache the next mount reads. Over loopback, at ~140 ms of builder time,
 * that is the right trade; if this were a remote API it would not be.
 */

import { api, type GraphPayload } from "./api";
import type { PositionCache } from "../graph/instance";

/** One fetched scope, plus the positions it settled at. Moved verbatim. */
export interface ScopeCache {
  payload: GraphPayload;
  positions: PositionCache;
}

/** `null` (the whole brain) collapses to `""`, exactly as FR-239 keyed it. */
export function scopeKey(scope: string | null): string {
  return scope ?? "";
}

const entries = new Map<string, ScopeCache>();
const inflight = new Map<string, Promise<GraphPayload>>();

/** The cached entry for a scope, or `undefined`. */
export function cachedScope(scope: string | null): ScopeCache | undefined {
  return entries.get(scopeKey(scope));
}

/**
 * Store a freshly fetched payload, resetting `positions`.
 *
 * The reset is FR-239's behaviour and it is load-bearing: positions belong to a
 * node set, and a new payload may not contain the same nodes. Seeding a new
 * layout from a previous payload's coordinates is how a graph ends up with
 * nodes stacked at the origin.
 */
export function putScope(scope: string | null, payload: GraphPayload): ScopeCache {
  const entry: ScopeCache = { payload, positions: {} };
  entries.set(scopeKey(scope), entry);
  return entry;
}

/** Record the positions a settled simulation reached, for a later back-out. */
export function rememberPositions(
  scope: string | null,
  positions: PositionCache,
): void {
  const entry = entries.get(scopeKey(scope));
  if (entry !== undefined) entry.positions = positions;
}

/**
 * Fetch a scope, sharing one request across every caller.
 *
 * `force` is the graph page's explicit REFRESH: it bypasses the cache but still
 * shares an in-flight request, so double-clicking refresh is one fetch.
 */
export async function fetchScope(
  scope: string | null,
  opts: { force?: boolean } = {},
): Promise<GraphPayload> {
  const key = scopeKey(scope);

  if (opts.force !== true) {
    const hit = entries.get(key);
    if (hit !== undefined) return hit.payload;
  }

  const pending = inflight.get(key);
  if (pending !== undefined) return pending;

  // No signal is passed to `api.graph` — see the header. The promise is stored
  // BEFORE the await so a second caller in the same tick joins this one.
  const p = api
    .graph(scope)
    .then((payload) => {
      putScope(scope, payload);
      return payload;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/**
 * Drop everything. **Tests only** — and the one seam that makes this module's
 * module-level state assertable rather than a hidden global.
 */
export function resetGraphCache(): void {
  entries.clear();
  inflight.clear();
}
