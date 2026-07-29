/**
 * FR-238 — the application shell.
 *
 * FR-239 (graph), FR-240 (layer views) and FR-241 (cognition triage) mount
 * INSIDE this. The shell owns: chrome (grain, cursor, nav, palette, live
 * beat), routing, and the degraded/empty/loading states. It owns no domain
 * rendering beyond the Overview counters.
 */
import { Grain } from "./components/chrome/Grain";
import { Cursor } from "./components/chrome/Cursor";
import { Nav } from "./components/chrome/Nav";
import { StatePage } from "./components/ui/StatePage";
import { Overview } from "./pages/Overview";
import { useLive } from "./lib/useLive";
import { usePalette } from "./lib/usePalette";
import { PENDING_ROUTES, ROUTE_LABELS, useRoute } from "./router";

export function App() {
  const [palette, setPalette] = usePalette();
  const [route, navigate] = useRoute();
  const live = useLive();

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
        ) : (
          <Overview live={live} />
        )}
      </main>
    </div>
  );
}
