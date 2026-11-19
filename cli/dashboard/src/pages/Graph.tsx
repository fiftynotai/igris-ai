/**
 * FR-239 — the whole-brain graph view.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * D8 — THIS PAGE DOES NOT REFETCH ON `live.tick`, AND THAT IS DELIBERATE
 * ─────────────────────────────────────────────────────────────────────────
 * Every other page in this shell keys its reads off `live.tick`, the 5-second
 * `/api/health` beat, so a `/hunt` writing to the brain shows up without a
 * reload. This one does not, and the divergence is a decision rather than an
 * oversight:
 *
 *  - The payload is ~1 MB and the builder takes ~140 ms. A 5-second refetch is
 *    a builder run and a megabyte every five seconds, forever.
 *  - Far worse: a new payload re-runs the FORCE SIMULATION. The canvas would
 *    re-settle every five seconds. dataviz.md forbids an idling simulation by
 *    name — *"A graph that keeps jiggling is a `// LOOP` with extra steps"* —
 *    and with a library whose loop we cannot prove has stopped, an ambient
 *    re-layout is exactly the failure AC #5 is written to catch.
 *
 * So: **fetch once per scope, explicit REFRESH, and staleness carried visibly
 * by the AS OF stamp in the query twin.** The twin is not decoration here; it
 * is the page's freshness indicator.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * D6 — FILTER AND DRILL ARE DIFFERENT OPERATIONS
 * ─────────────────────────────────────────────────────────────────────────
 * A type filter or a search is a CLIENT-SIDE MUTE over the payload already in
 * memory (`// QUICK`). A project drill is a real scope change: a refetch that
 * returns a different node set plus its depth-1 `boundary` nodes (`// SLOW`).
 * Backing out restores the cached whole-brain payload AND its settled
 * positions, so it is a page transition rather than a second entrance.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, type GraphPayload, type ProjectsPayload, type AttentionInventory, type AttentionNodeState, type GraphEdge, type GraphNode } from "../lib/api";
import {
  cachedScope,
  fetchScope,
  rememberPositions,
} from "../lib/graphCache";
import { StatePage } from "../components/ui/StatePage";
import { EmptyState } from "../components/ui/EmptyState";
import { GraphSurface } from "../components/graph/GraphSurface";
import { GraphControls } from "../components/graph/GraphControls";
import { QueryTwin } from "../components/graph/QueryTwin";
import { NodeInspector } from "../components/graph/NodeInspector";
import { useGraph } from "../graph/useGraph";
import { findNode, type NodeTriple } from "../layers/model";
import { useAttention } from "../attention/useAttention";
import { mergeInventory, partitionEvidence } from "../attention/model";
import { SessionPicker } from "../attention/SessionPicker";
import { attentionLens, lensTypes, nodeVisible, type AttentionLens } from "../attention/lens";
import { AttentionLensControls } from "../attention/AttentionLensControls";
import { AttentionPanel } from "../attention/AttentionPanel";

const NO_NODES: GraphNode[] = [];
const NO_EDGES: GraphEdge[] = [];
const NO_STATES: AttentionNodeState[] = [];

export interface GraphProps {
  /** Search text, owned by `App` and shared with the nav's reserved slot. */
  search: string;
  /**
   * FR-240 — a node to select and centre on arrival (`#/graph?focus=…`).
   *
   * The return half of AC #3's cross-link. It carries the STRUCTURED triple, not
   * a composite key: the node is found by matching `type`/`project`/`id`
   * (`layers/model.ts#findNode`), so no key form is ever parsed browser-side
   * (D5) and `BR-001` in two projects focuses two different nodes.
   */
  focus?: NodeTriple | null;
  attentionSession?: string | null;
}

export function Graph({ search, focus = null, attentionSession = null }: GraphProps) {
  const [scope, setScope] = useState<string | null>(null);
  const [payload, setPayload] = useState<GraphPayload | null>(null);
  const [projects, setProjects] = useState<ProjectsPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<ReadonlySet<string>>(new Set());
  const [nonce, setNonce] = useState(0);
  const [inventory, setInventory] = useState<AttentionInventory | null>(null);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [evidenceKey, setEvidenceKey] = useState<string | null>(null);
  const attention = useAttention(attentionSession);
  // A newly selected chat always starts focused; toggling does not edit its URL.
  const [view, setView] = useState<{ session: string | null; lens: AttentionLens; neighbours: boolean }>({ session: attentionSession, lens: "chat", neighbours: false });
  const lens: AttentionLens = attentionSession === null ? "brain" : view.session === attentionSession ? view.lens : "chat";
  const includeNeighbours = view.session === attentionSession && view.neighbours;
  useEffect(() => { setView({ session: attentionSession, lens: "chat", neighbours: false }); setTypeFilter(new Set()); }, [attentionSession]);
  const setLens = (next: AttentionLens) => setView({ session: attentionSession, lens: next, neighbours: includeNeighbours });
  /**
   * How the CURRENT payload arrived. A first load runs the `// CINE` entrance
   * once; a scope change is a page transition on `// SLOW` (M1). dataviz.md:
   * the entrance "fires once. It never re-fires on filter or re-layout."
   */
  const [transition, setTransition] = useState<"entrance" | "drill">("entrance");

  /*
   * SCOPE CACHE — cached scopes, so backing out of a drill is instant and does
   * not re-enter the entrance. Keyed by scope; `""` is the whole brain.
   *
   * It used to be a `useRef<Map<...>>` right here. FR-240 hoisted the store to
   * `lib/graphCache.ts` — same key, same entry shape, same reset-on-fetch rule —
   * so the record detail view shares this page's fetch instead of paying for a
   * second ~1 MB payload (D6). The logic below is unchanged; only the Map moved,
   * and with it the LIFETIME: the cache now outlives this component, which is
   * the whole point of sharing it.
   */

  // Projects list — cheap, and the ONE thing here that may follow the beat.
  useEffect(() => {
    const ctrl = new AbortController();
    void api
      .projects(ctrl.signal)
      .then(setProjects)
      .catch(() => undefined);
    return () => ctrl.abort();
  }, []);

  // The payload. Keyed on scope + an explicit REFRESH nonce, and on NOTHING
  // else — in particular not on `live.tick`. See the header.
  useEffect(() => {
    const ctrl = new AbortController();
    setBusy(true);
    // `force` on an explicit REFRESH only. The signal is the ABANDONMENT check,
    // not a cancellation: the request is shared with the record detail, so
    // aborting it here would cancel someone else's read (`graphCache.ts` header).
    // Commit one topology after both reads finish. Activity never enters this
    // dependency list and cannot replace node/edge arrays or restart layout.
    Promise.all([
      fetchScope(scope, { force: nonce > 0 }),
      api.attentionInventory(scope, ctrl.signal).then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error: String(error) }),
      ),
    ]).then(([p, discovered]) => {
        if (ctrl.signal.aborted) return;
        setPayload(p);
        setInventory(discovered.value);
        setInventoryError(discovered.error);
        setFatal(null);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setFatal(err instanceof ApiError ? err.message : String(err));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setBusy(false);
      });
    return () => ctrl.abort();
  }, [scope, nonce]);

  const topology = useMemo(() => mergeInventory(payload?.nodes ?? NO_NODES, inventory?.nodes ?? NO_NODES), [payload, inventory]);
  const nodes = topology.nodes;
  const edges = payload?.edges ?? NO_EDGES;
  const evidence = useMemo(() => partitionEvidence(nodes, attention.snapshot?.node_states ?? NO_STATES), [nodes, attention.snapshot?.node_states]);

  // The seed for a back-out: the positions this scope settled at last time.
  const seed = useMemo(
    () => cachedScope(scope)?.positions,
    // Read at mount of each payload; `nodes` identity is the payload identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes],
  );

  const map = useMemo(() => attentionLens(nodes, edges, evidence.onMap, lens, includeNeighbours), [nodes, edges, evidence.onMap, lens, includeNeighbours]);
  const fitKey = attentionSession === null ? null : attention.snapshot?.session?.id === attentionSession
    ? `${attentionSession}:${lens}:${includeNeighbours}:${scope}:${nonce}` : null;
  const graph = useGraph({ nodes, edges, typeFilter, search, seed, transition, attention: evidence.onMap, visibleKeys: map.visible, fitKey });
  useEffect(() => { setEvidenceKey(graph.selection?.node.key ?? null); }, [graph.selection?.node.key]);

  // Persist settled positions so backing out restores the layout rather than
  // paying a second entrance for a payload we already have.
  useEffect(() => {
    if (!graph.settled) return;
    rememberPositions(scope, graph.positions());
  }, [graph.settled, graph, scope]);

  /**
   * FR-240 — the focus target, resolved against the payload in memory.
   *
   * `null` while there is no focus; `undefined`-free by construction. When a
   * focus is asked for and the node is NOT in this payload, `focusNode` stays
   * null and the banner below says so — most often because the operator arrived
   * from a record in a project while the canvas is truncated, or scoped
   * elsewhere. Silently doing nothing would look like a broken link.
   */
  const focusNode = useMemo(
    () => (focus === null ? null : findNode(nodes, focus)),
    [focus, nodes],
  );

  const focusVisible = focusNode !== null && nodeVisible(map.visible, focusNode.key);

  // Select and centre it once the simulation has positions to centre on.
  // `graph.select` moves the camera only if the node has settled coordinates
  // (`useGraph`'s `ctrl.positions()[key]` guard), so this waits for `settled`
  // rather than firing at mount and losing the camera move.
  useEffect(() => {
    if (focusNode === null || !focusVisible) return;
    if (!graph.settled) return;
    graph.select(focusNode.key);
    // Only explicit focus/view/session intent or layout settlement may move
    // the camera. A poll can make a hidden focus visible, but must not select
    // it automatically. The reveal action changes `lens` and retries here.
    // `graph.select` and `focusVisible` deliberately are not dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNode?.key, graph.settled, lens, includeNeighbours, attentionSession]);

  const types = useMemo(() => lensTypes(nodes, map.visible, typeFilter), [nodes, map.visible, typeFilter]);

  const toggleType = useCallback((type: string) => {
    setTypeFilter((cur) => {
      const next = new Set(cur);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const drill = useCallback((project: string | null) => {
    // A REAL scope change (D6). Filters are cleared: they were expressed over a
    // node set that no longer exists, and silently reapplying them to a
    // different one would mute nodes the operator never chose to mute.
    setTypeFilter(new Set());
    setTransition("drill");
    setScope(project);
    setNonce(0);
  }, []);

  if (fatal !== null) {
    return (
      <StatePage
        inset
        variant="error"
        headline={
          <>
            <em>server unreachable.</em>
          </>
        }
        message="The dashboard server stopped answering. Restart it with `igris dashboard`."
        meta={fatal}
      />
    );
  }

  if (payload === null) {
    return (
      <StatePage
        inset
        variant="loading"
        headline={
          <>
            <em>reading the brain.</em>
          </>
        }
        message="Assembling every node and edge across every project."
        meta={scope === null ? "whole brain" : `scope · ${scope}`}
      />
    );
  }

  const attentionPanel = <AttentionPanel sessionId={attentionSession} snapshot={attention.snapshot} error={attention.error} loading={attention.loading}
    inventory={inventory} inventoryError={inventoryError} selectedKey={evidenceKey} neighbour={map.neighbours.get(evidenceKey ?? "") ?? null} offMap={evidence.offMap} sessions={attention.sessions}
    through={attention.through} before={attention.before} onReplay={attention.replay} onPage={attention.page}
    onSelect={(key) => { setEvidenceKey(key); if (evidence.onMap.has(key)) graph.select(key); }} onRefresh={attention.refresh} />;

  return (
    /*
     * FR-244 — `.graph-page` is a FLEX COLUMN whose min-height is the viewport
     * minus the shell's own chrome, so `.graph-layout` can take everything the
     * headline, the banners and the controls leave. Before this the canvas was
     * pinned at `clamp(420px, 62vh, 900px)` and the page scrolled at 1440x900.
     * The wrapper is what makes the column exist; without it these children are
     * block-flow items in a `.shell-main` shared with every other page, and the
     * canvas has nothing to stretch against.
     */
    <div className="graph-page">
      <span className="shell-eye">// GRAPH</span>
      <h1 className="shell-h1 glitch">{lens === "chat" ? "THIS CHAT" : "WHOLE BRAIN"}</h1>
      <SessionPicker selected={attentionSession} payload={attention.sessions} error={attention.sessionsError}
        older={attention.listBefore !== null} onPage={attention.pageSessions} onRefresh={attention.refreshSessions} />
      {attentionSession !== null && <AttentionLensControls lens={lens} neighbours={includeNeighbours} recordedCount={evidence.onMap.size} neighbourCount={map.neighbours.size}
        onLens={setLens} onNeighbours={(include) => setView({ session: attentionSession, lens, neighbours: include })} />}
      {topology.conflicts.length > 0 && <div className="shell-banner" role="status">INVENTORY IDENTITY CONFLICT — {topology.conflicts.length} references could not be merged.</div>}
      {inventoryError !== null && <div className="shell-banner" role="status">CAPABILITY INVENTORY UNAVAILABLE — the knowledge map is still shown. {inventoryError}</div>}

      {payload.degraded !== null && (
        <div className="shell-banner" role="status">
          GRAPH DEGRADED — {payload.degraded.reason}
        </div>
      )}
      {focusNode !== null && !focusVisible && <div className="shell-banner" role="status">
        {focusNode.label} is outside this chat’s view. <button type="button" className="graph-control" onClick={() => setLens("brain")}>Show in Whole brain</button>
      </div>}
      {focus !== null && focusNode === null && (
        <div className="shell-banner" role="status">
          FOCUS NODE NOT IN THIS SCOPE — {focus.type} {focus.id}
          {focus.project !== null ? ` (${focus.project})` : " (global)"} is not in
          the payload on screen.{" "}
          {payload.truncated
            ? "This payload is truncated; drill into the project to reach it."
            : "Drill into its project to reach it."}
        </div>
      )}
      {payload.truncated && (
        <div className="shell-banner" role="status">
          TRUNCATED — {payload.truncation_reason ?? "builder cap reached"}
        </div>
      )}
      <GraphControls
        scope={scope}
        projects={(projects?.projects ?? []).map((p) => p.slug)}
        types={types}
        active={typeFilter}
        onToggleType={toggleType}
        onDrill={drill}
        onRefresh={() => setNonce((n) => n + 1)}
        onFit={graph.refit}
        matchCount={graph.matchCount}
        tier={graph.tier}
        nodeCount={map.nodeCount}
        edgeCount={map.edgeCount}
        busy={busy}
      />

      {nodes.length === 0 ? (
        <>
          <EmptyState
            meta={payload.query.scale}
            headline={
              <>
                <em>no nodes in this scope.</em>
              </>
            }
            message={
              scope === null
                ? "The brain has no entities yet. Register a project and file a brief."
                : `Nothing is filed under ${scope}. Back out to the whole brain.`
            }
          />
          {/*
            Exemption 04's obligation, in the branch that has no side column to
            put it in. The twin is "adjacent to the canvas, in mono, ALWAYS" —
            and "always" includes the scope that produced no canvas at all,
            which is exactly the case whose provenance a reader most needs.
          */}
          <QueryTwin twin={payload.query} />
          {attentionPanel}
        </>
      ) : (
        <div className="graph-layout">
          <GraphSurface ref={graph.containerRef} label={lens === "chat" ? "This chat attention map" : "Whole-brain graph"}>
            {map.nodeCount === 0 && <p className="attention-empty" role="status">{attention.loading ? "Reading this chat’s recorded activity…" : attention.error !== null ? "This chat’s activity could not be read. See the session details." : "No recorded nodes in this map. Evidence outside the current scope remains in the list."}</p>}
            {graph.aggregating && (
              <div className="shell-banner graph-density" role="status">
                {/*
                  M2 — THIS BANNER MUST DESCRIBE WHAT ACTUALLY HAPPENS.

                  It used to read "nodes below the size floor are drawn as
                  counted clusters", which asserted ladder rung 6. Rung 6 is NOT
                  implemented: `tier.ts` ships and tests the `fitsAtFloor`
                  predicate, but nothing aggregates and no cluster node is ever
                  drawn. When the banner fired it told the operator something
                  false.

                  What actually happens at this density is that silhouettes
                  overlap. Nothing vanishes — so the spec's "a node never
                  silently disappears" still holds — but the set is past the
                  legible floor and the honest remedy is to narrow it. The gap
                  is recorded in `docs/dashboard.md`.

                  FR-244 MOVED IT INSIDE THE SURFACE, AS AN OVERLAY. It is the
                  ONLY banner on this page whose visibility is computed from the
                  canvas's own measured box (`graph.aggregating` comes from the
                  ResizeObserver), so it is the only one that can form a
                  feedback loop with the canvas's height — and a full-column
                  canvas is what closes that loop. Out of flow, the loop cannot
                  start: the observed box does not depend on the banner. The
                  other three banners are payload-driven and stable for the
                  lifetime of a payload, so they stay page rows.
                */}
                DENSITY — this set is past the legible size floor and
                silhouettes overlap. Filter by type or drill into a project to
                narrow it.
              </div>
            )}
          </GraphSurface>
          {/*
            THE INSPECTOR COLUMN IS ALWAYS RENDERED, EVEN WITH NOTHING SELECTED.

            This is an AC #5 fix, not a layout preference. Exemption 02 requires
            the canvas to expose an entry point, so `useGraph` auto-selects the
            highest-degree node the moment the entrance settles. When the
            inspector only existed while something was selected, that selection
            MOUNTED a 300 px column, which shrank the canvas, which resized the
            backing store, which repainted — roughly 600 ms AFTER the graph had
            been declared still.

            Measured: a pixel-hash series with NO pointer input at all showed two
            distinct hashes, the change landing at t=585 ms with the loop state
            reporting `still` throughout. Reserving the column makes the canvas
            the same size at first paint and forever after.

            FR-238 reserved the nav's search slot for precisely this reason and
            wrote down why. Same rule, one layer in.
          */}
          {/*
            FR-244 — the side column. It holds the reserved inspector AND the
            query twin, which used to be a full-width block BELOW this row.

            The move is what frees the vertical column: as a sibling of
            `.graph-layout` the twin was a second vertical consumer, so the
            canvas had to be clamped to leave room for it and the page scrolled
            anyway (measured: scrollHeight 1164 at innerHeight 900). FR-250 gave
            the SCROLL back deliberately — the column is doubled and the page
            scrolls by a bounded amount — but not the CLAMP, which is what this
            paragraph is about and which stays retired. Exemption
            04 asks for the twin to be *"adjacent to the canvas, in mono,
            always"* — adjacency is a relationship, not a particular edge, and
            beside the canvas is at least as adjacent as beneath it.
          */}
          <div className="graph-side attention-side">
            {attentionPanel}
            {graph.selection !== null ? (
              <NodeInspector
                node={graph.selection.node}
                neighbours={graph.selection.neighbours}
                onSelect={graph.select}
                onTrace={graph.trace}
                onClose={graph.clearSelection}
              />
            ) : (
              <aside className="graph-inspector" aria-label="Selected entity">
                <span className="graph-inspector-eye">// NOTHING SELECTED</span>
                <p className="graph-inspector-hint">
                  Click a node to reveal its attributes and its 1-hop
                  neighbourhood.
                </p>
              </aside>
            )}
            <QueryTwin twin={payload.query} />
          </div>
        </div>
      )}
    </div>
  );
}
