/**
 * FR-238 — the Overview page.
 *
 * Three reads: `/api/projects` (the scope selector), `/api/summary` (brief
 * counts + active instances), `/api/graph/stats` (the graph-scale readout).
 *
 * The graph readout is deliberately a COUNTER BLOCK, not a picture. It is the
 * visible proof that the FR-237 bridge works end to end — and `nodes`/`edges`
 * are stripped server-side (R8), so this page physically cannot become the
 * graph view that FR-239 owns.
 *
 * Every read re-runs on `live.tick`, so the AC "restarting a hunt and reloading
 * shows new state with no regeneration step" holds without even a reload.
 */
import { useEffect, useState } from "react";
import {
  api,
  ApiError,
  type GraphStatsPayload,
  type ProjectsPayload,
  type SummaryPayload,
} from "../lib/api";
import { Card, CardBody, CardEye, CardFooter, CardTitle } from "../components/ui/Card";
import { Chip } from "../components/ui/Chip";
import { EmptyState } from "../components/ui/EmptyState";
import { StatePage } from "../components/ui/StatePage";
import type { Live } from "../lib/useLive";

function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="shell-skel" style={{ width: `${90 - i * 18}%` }} />
      ))}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string | number }) {
  return (
    <div className="shell-kv">
      <span>{k}</span>
      <b>{v}</b>
    </div>
  );
}

export function Overview({ live }: { live: Live }) {
  const [projects, setProjects] = useState<ProjectsPayload | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [summary, setSummary] = useState<SummaryPayload | null>(null);
  const [graph, setGraph] = useState<GraphStatsPayload | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  // Projects — refetched on every live tick so a `/register` mid-session shows
  // up without a reload.
  useEffect(() => {
    const ctrl = new AbortController();
    api
      .projects(ctrl.signal)
      .then((p) => {
        setProjects(p);
        setFatal(null);
        setSelected((cur) => {
          // Keep the operator's own choice across refetches — this only ever
          // picks a default when nothing valid is selected yet.
          if (cur !== null && p.projects.some((r) => r.slug === cur)) return cur;
          // Server-resolved ladder (cwd project -> most recently active ->
          // alphabetical). `p.projects[0]` remains as a last resort for a
          // payload from an older server that has no `default_project`.
          if (
            p.default_project !== null &&
            p.projects.some((r) => r.slug === p.default_project)
          ) {
            return p.default_project;
          }
          return p.projects[0]?.slug ?? null;
        });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setFatal(err instanceof ApiError ? err.message : String(err));
      });
    return () => ctrl.abort();
  }, [live.tick]);

  useEffect(() => {
    if (selected === null) {
      setSummary(null);
      setGraph(null);
      return;
    }
    const ctrl = new AbortController();
    void api.summary(selected, ctrl.signal).then(setSummary).catch(() => undefined);
    void api.graphStats(selected, ctrl.signal).then(setGraph).catch(() => undefined);
    return () => ctrl.abort();
  }, [selected, live.tick]);

  if (fatal !== null) {
    return (
      <StatePage
        inset
        variant="error"
        headline={<><em>server unreachable.</em></>}
        message="The dashboard server stopped answering. Restart it with `igris dashboard`."
        meta={fatal}
      />
    );
  }

  const brainMissing = live.health?.brain.present === false;
  const bridgeDown =
    live.health !== null && live.health.bridge.available === false;

  return (
    <>
      <span className="shell-eye">// LENS</span>
      <h1 className="shell-h1 glitch">OVERVIEW</h1>
      <p className="shell-lede">
        A live read over the brain. Nothing here is regenerated — every counter
        is the state on disk at the moment it was fetched.
      </p>

      {brainMissing && (
        <div className="shell-banner" role="status">
          BRAIN DATABASE NOT FOUND — {live.health?.brain.path}
        </div>
      )}
      {!brainMissing && bridgeDown && (
        <div className="shell-banner" role="status">
          BRAIN ENGINE UNAVAILABLE — graph stats degraded ·{" "}
          {live.health?.bridge.reason ?? "unknown cause"}
        </div>
      )}

      {projects === null ? (
        <Skeleton rows={2} />
      ) : projects.projects.length === 0 ? (
        <EmptyState
          meta={
            projects.degraded
              ? projects.degraded.reason
              : "no registered projects"
          }
          headline={<><em>no projects yet.</em></>}
          message="Register one with `igris install <path>` and it will appear here."
        />
      ) : (
        <>
          <div
            className="tweaks-chips"
            role="radiogroup"
            aria-label="Project scope"
            style={{ marginBottom: 24 }}
          >
            {projects.projects.map((p) => (
              <Chip
                key={p.slug}
                variant="tweak"
                role="radio"
                active={p.slug === selected}
                onClick={() => setSelected(p.slug)}
              >
                {p.slug}
              </Chip>
            ))}
          </div>

          <div className="shell-grid">
            <Card>
              <CardEye>// BRIEFS</CardEye>
              {summary === null ? (
                <Skeleton />
              ) : (
                <>
                  <CardTitle className="shell-metric">
                    {summary.briefs.total}
                  </CardTitle>
                  <div>
                    {Object.entries(summary.briefs.by_status).map(([k, v]) => (
                      <KV key={k} k={k} v={v} />
                    ))}
                  </div>
                  <CardFooter>
                    <span>{summary.project ?? "—"}</span>
                    <span>
                      {summary.degraded ? "DEGRADED" : "OK"}
                    </span>
                  </CardFooter>
                </>
              )}
            </Card>

            <Card>
              <CardEye>// PRIORITY</CardEye>
              {summary === null ? (
                <Skeleton />
              ) : Object.keys(summary.briefs.by_priority).length === 0 ? (
                <CardBody>No priority data for this project.</CardBody>
              ) : (
                <div>
                  {Object.entries(summary.briefs.by_priority).map(([k, v]) => (
                    <KV key={k} k={k} v={v} />
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <CardEye>// INSTANCES</CardEye>
              {summary === null ? (
                <Skeleton rows={1} />
              ) : (
                <>
                  <CardTitle className="shell-metric">
                    {summary.instances.active}
                  </CardTitle>
                  <CardBody>Active sessions on this project.</CardBody>
                </>
              )}
            </Card>

            {/* The FR-237 bridge proof. Counters only — never a canvas (R8). */}
            <Card>
              <CardEye>// GRAPH SCALE</CardEye>
              {graph === null ? (
                <Skeleton />
              ) : graph.stats === null ? (
                <CardBody>
                  {graph.degraded?.reason ?? "graph stats unavailable"}
                </CardBody>
              ) : (
                <>
                  <CardTitle className="shell-metric">
                    {graph.stats.node_count}
                  </CardTitle>
                  <div>
                    <KV k="nodes" v={graph.stats.node_count} />
                    <KV k="edges" v={graph.stats.edge_count} />
                    <KV k="projects" v={graph.stats.project_count} />
                    <KV k="boundary" v={graph.stats.boundary_node_count} />
                  </div>
                  <CardFooter>
                    <span>{graph.truncated ? "TRUNCATED" : "COMPLETE"}</span>
                    <span>FR-237</span>
                  </CardFooter>
                </>
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}
