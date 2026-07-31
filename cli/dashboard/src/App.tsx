/**
 * FR-238 — the application shell.
 *
 * FR-239 (graph), FR-240 (layer views) and FR-241 (cognition triage) mount
 * INSIDE this. The shell owns: chrome (grain, cursor, nav, palette, live
 * beat), routing, and the degraded/empty/loading states. It owns no domain
 * rendering beyond the Overview counters.
 */
import { useState } from "react";
import { Grain } from "./components/chrome/Grain";
import { Cursor } from "./components/chrome/Cursor";
import { Nav } from "./components/chrome/Nav";
import { StatePage } from "./components/ui/StatePage";
import { Overview } from "./pages/Overview";
import { Graph } from "./pages/Graph";
import { Layers } from "./pages/Layers";
import { Triage } from "./pages/Triage";
import { useLive } from "./lib/useLive";
import { usePalette } from "./lib/usePalette";
import { PENDING_ROUTES, ROUTE_LABELS, useRoute } from "./router";

export function App() {
  const [palette, setPalette] = usePalette();
  const [{ route, layer, address, focus }, navigate] = useRoute();
  const live = useLive();

  /**
   * Search text, owned HERE rather than by `Graph`.
   *
   * dataviz.md §04 requires a Tier C canvas to ship its search control in the
   * SURROUNDING CHROME, and FR-238 reserved the nav slot for exactly this. The
   * control and its consumer therefore sit on opposite sides of the shell, so
   * the state has to live at their common ancestor.
   *
   * FR-240 is the second consumer: on the layers route the same box is a
   * client-side text mute over the loaded rows. Both consumers treat it as a
   * MUTE over data in memory, never as a query — so sharing one state cannot
   * make one of them silently issue a request the other would not.
   */
  const [search, setSearch] = useState("");

  const pendingBrief = PENDING_ROUTES[route];

  return (
    <div className="shell">
      <Grain />
      <Cursor />
      <Nav
        route={route}
        onNavigate={navigate}
        palette={palette}
        onPalette={setPalette}
        live={live}
        search={search}
        onSearch={setSearch}
      />
      <main id="main" className="shell-main">
        {pendingBrief ? (
          <StatePage
            inset
            variant="empty"
            headline={
              <>
                <em>not built yet.</em>
              </>
            }
            message={`${ROUTE_LABELS[route]} ships with ${pendingBrief}. The shell is ready for it.`}
            meta={`${pendingBrief} · pending`}
          />
        ) : route === "graph" ? (
          <Graph search={search} focus={focus} />
        ) : route === "layers" ? (
          <Layers live={live} search={search} layer={layer} address={address} />
        ) : route === "triage" ? (
          /*
           * FR-241. The write affordances inside gate themselves on
           * `live.health.write.available` (see `pages/Triage.tsx#writeState`)
           * rather than being gated here: the READ half of this page is useful
           * on a machine whose write door is unavailable, and hiding the whole
           * tab would turn "the write surface is down" into "the queue does not
           * exist". *Disabled, not broken.*
           */
          <Triage live={live} search={search} />
        ) : (
          <Overview live={live} />
        )}
      </main>
    </div>
  );
}
