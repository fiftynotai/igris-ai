/**
 * FR-240 (D6) — the record detail's 1-hop neighbourhood, from the EXISTING
 * `/api/graph` payload.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THERE IS NO `/api/neighbours`
 * ─────────────────────────────────────────────────────────────────────────
 * `igris_graph_neighbors` would have been the obvious source, but
 * `traversal.ts` imports `getDb()` and all three of its handlers call it — which
 * opens the brain READ-WRITE and runs `migrateSchema`. AC #7 says nothing
 * mutates the brain, so that door is closed without a second contract-heavy
 * extraction (MAINTAINING row 106, the BR-078 seed ladder).
 *
 * So: the graph payload the canvas already fetches, through the SHARED cache
 * (`lib/graphCache.ts`), computed by the SHARED function
 * (`graph/neighbours.ts#neighboursOf`) that `useGraph` itself calls. Zero new
 * brain surface, zero new endpoint, and the canvas and the detail cannot
 * disagree about a neighbourhood because there is one implementation.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE COST, STATED
 * ─────────────────────────────────────────────────────────────────────────
 * Opening a record WARMS a project-scoped graph fetch. That is the trade D6
 * names explicitly. It is paid once per project per session (the cache outlives
 * every component), and it is the same fetch the graph page would pay — so
 * visiting a record and then the graph now costs one payload instead of two.
 *
 * A record with NO project falls back to the whole-brain payload, which is the
 * ~1 MB one. Only globally-addressed records (a goal with no `project_slug`) can
 * do that, and there are few of them.
 */

import { useEffect, useState } from "react";
import { fetchScope } from "../lib/graphCache";
import { incidentEdgeIds, neighboursOf } from "../graph/neighbours";
import { findNode, recordHrefForNode, type NodeTriple } from "./model";
import type { NeighbourEntry } from "../components/record/RecordDetail";

export interface NeighboursState {
  /** `absent` = no node in the graph; `unavailable` = the graph read failed. */
  state: "loading" | "ready" | "unavailable" | "absent";
  entries: NeighbourEntry[];
  note?: string;
  edgeCount?: number;
}

/** How many neighbours to render. The rest are counted, never hidden silently. */
const MAX_ENTRIES = 40;

export function useNeighbours(
  triple: NodeTriple | null,
  /** The graph scope to read. `null` means the whole brain. */
  scope: string | null,
): NeighboursState {
  const [result, setResult] = useState<NeighboursState>({
    state: "loading",
    entries: [],
  });

  const key = triple === null ? null : `${triple.type}|${triple.project ?? ""}|${triple.id}`;

  useEffect(() => {
    if (triple === null) {
      setResult({ state: "loading", entries: [] });
      return;
    }
    const ctrl = new AbortController();
    setResult({ state: "loading", entries: [] });

    fetchScope(scope)
      .then((payload) => {
        if (ctrl.signal.aborted) return;

        // Found by MATCHING THE STRUCTURED TRIPLE — no key form is constructed
        // browser-side (D5), and `BR-001` in two projects resolves to two
        // different nodes (BR-078).
        const node = findNode(payload.nodes, triple);
        if (node === null) {
          setResult({
            state: "absent",
            entries: [],
            note:
              payload.truncated
                ? "This record has no node in the graph payload, which is truncated — it may exist outside the cap."
                : "This record has no node in the brain graph yet. Edges appear once something links to it.",
          });
          return;
        }

        const { neighbours } = neighboursOf(payload.nodes, payload.edges, node.key);
        const entries: NeighbourEntry[] = neighbours
          .slice(0, MAX_ENTRIES)
          .map((n) => ({
            key: n.key,
            label: n.label,
            type: n.type,
            // `null` for a type no layer shows — rendered, not hidden.
            href: recordHrefForNode(n),
          }));

        setResult({
          state: "ready",
          entries,
          edgeCount: incidentEdgeIds(payload.edges, node.key).size,
          note:
            neighbours.length > MAX_ENTRIES
              ? `Showing ${MAX_ENTRIES} of ${neighbours.length} neighbours, highest degree first.`
              : undefined,
        });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        // A failed graph read is NOT an empty neighbourhood. Conflating them
        // would tell the operator a well-connected record is isolated.
        setResult({
          state: "unavailable",
          entries: [],
          note: `The graph could not be read, so the neighbourhood is unknown: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      });

    return () => ctrl.abort();
    // Keyed on the record's identity and the scope. NOT on `live.tick`: this is
    // the ~1 MB payload, and re-reading it every five seconds is the exact
    // failure `Graph.tsx`'s D8 header argues against.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, scope]);

  return result;
}
