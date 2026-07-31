/**
 * FR-238 — the Overview page. BR-082 gave it a clearable scope.
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
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SCOPE IS THE SHARED ONE (BR-082)
 * ─────────────────────────────────────────────────────────────────────────
 * This page used to hold its own `useState` plus its own copy of the
 * default-resolution ladder, and its chip strip had NO clear affordance at all:
 * a page called OVERVIEW could only ever show one project. FR-241 had already
 * lifted that state machine into `lib/useProjectScope.ts` +
 * `components/chrome/ProjectScope.tsx` so `Layers` and `Triage` could share it;
 * Overview simply was not migrated, and re-implementing the third state here
 * would have re-created the exact bug the lift exists to prevent — the ladder
 * re-applying on every `live.tick` and silently undoing the clear within five
 * seconds. There is now ONE copy, and this file holds no scope state.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THE UNSCOPED OVERVIEW SHOWS — THE DECISION, AND WHY
 * ─────────────────────────────────────────────────────────────────────────
 * THE SAME FOUR CARDS, each read with its project predicate DROPPED.
 *
 * That was chosen against the two alternatives, on what the reads already did:
 *
 * - `/api/graph/stats` ALREADY answered unscoped. `graphStats(null)` calls
 *   `bridge.buildGraph({})`, which is the whole-brain graph FR-239's canvas
 *   renders; the only thing stopping GRAPH SCALE from showing it was THIS
 *   page's own `selected === null` branch, which blanked both cards.
 * - `/api/summary` required a project only at the ROUTE. Both accessors under
 *   it (`briefStatusSummary`, `listInstances`) already build their WHERE
 *   conditionally, mirroring `handleBriefDashboard`'s own optional
 *   `summaryWhere`. So the unscoped read is an existing branch, not a new
 *   query, and no new SQL entered the server layer (the FR-238 tier rule).
 *
 * REJECTED — per-project rows. A 39-row table of per-project counts is a LIST
 * VIEW, and the list views are `#/layers/*`. Overview is a counter block; the
 * one thing it must not become is a second, worse briefs browser.
 *
 * REJECTED — a reduced card set for the unscoped state. The reduction would
 * have to drop the card whose brain-wide meaning is the LEAST doubtful (GRAPH
 * SCALE is whole-brain by construction), and a page whose card SET changes with
 * scope teaches the operator that the two states are different pages.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * "ALL PROJECTS" AND "EVERYTHING" ARE DIFFERENT SETS. THIS PAGE SHOWS
 * EVERYTHING, AND SAYS SO.
 * ─────────────────────────────────────────────────────────────────────────
 * Dropping a predicate counts EVERY row of the table, including rows that
 * belong to no project or to an unregistered one. That is TD-326's third scope
 * name — `everything` — and NOT its `brain-level` (which means `project IS
 * NULL` specifically). This page offers `everything`; it does not offer
 * `brain-level`, and the label in the BRIEFS footer is the word `everything`
 * rather than "all projects" for exactly that reason.
 *
 * Per card, because the answer is not uniform:
 *
 *   BRIEFS / PRIORITY  the two sets COINCIDE. `brief_status.project` is
 *                      NOT NULL with a declared FK to `projects(slug)`, and
 *                      better-sqlite3 enables `foreign_keys` by DEFAULT on
 *                      every handle — the brain's explicit pragma is
 *                      belt-and-braces, not the thing that makes it hold.
 *                      Deleting a project that still has briefs is BLOCKED,
 *                      measured on the real schema (654 briefs).
 *   INSTANCES          they DIVERGE. `instances.project_slug` is nullable with
 *                      no FK, so an active session belonging to no project is
 *                      in this count and in no project's count.
 *   GRAPH SCALE        they DIVERGE. The whole-brain graph admits
 *                      `node.project === null` for entities that genuinely have
 *                      no owner, and `stats.project_count` counts only the
 *                      NON-null slugs — so `projects` there is already the
 *                      narrower reading of the same picture.
 *
 * Measured on the operator brain, 2026-07-31: `brief_status` 1,803 rows / 0
 * NULL / 35 distinct projects, all registered; `instances` 17 active / 0 NULL;
 * `goals` 6 / 0 NULL and `graph_nodes` 0 rows (the two nullable graph sources).
 * So today every one of those divergences measures ZERO — a reading, not a
 * guarantee, which is why the copy says `everything` rather than a number's
 * worth of reassurance. `dashboard-server.test.ts` seeds a project-less active
 * session and asserts the difference is exactly 1.
 *
 * The table where the divergence is LOUD is `suggestions` — 377 pending rows
 * carry `project_slug = NULL` (TD-326) — and NO CARD ON THIS PAGE COUNTS
 * SUGGESTIONS. If one is ever added, it inherits TD-326's divergence and must
 * say which of the two sets its number is; a suggestions counter labelled
 * `everything` while filtering by project would be off by 377.
 */
import { useEffect, useState } from "react";
import {
  api,
  type GraphStatsPayload,
  type SummaryPayload,
} from "../lib/api";
import { Card, CardBody, CardEye, CardFooter, CardTitle } from "../components/ui/Card";
import { ProjectScope } from "../components/chrome/ProjectScope";
import { EmptyState } from "../components/ui/EmptyState";
import { StatePage } from "../components/ui/StatePage";
import type { Live } from "../lib/useLive";
import { useProjectScope } from "../lib/useProjectScope";

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
  /*
   * The three-value scope machine (`undefined` = unresolved, `"<slug>"` = one
   * project, `null` = explicitly every project) and its default ladder live in
   * `lib/useProjectScope.ts`. Nothing about them is re-declared here — see this
   * file's header, and that file's, for why a second copy is the bug.
   */
  const scope = useProjectScope(live.tick);
  const { project, projects, fatal } = scope;
  const [summary, setSummary] = useState<SummaryPayload | null>(null);
  const [graph, setGraph] = useState<GraphStatsPayload | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    // `project` is `string | null` and BOTH are requests: `null` omits the
    // query param, and the server answers with the predicate dropped. There is
    // deliberately no early return for `null` any more — that branch is what
    // blanked the cards on the state this page now exists to show.
    //
    // Both catches stay silent, unchanged from FR-238: every endpoint here
    // answers 200 with a `degraded` field for a brain problem (which the cards
    // render), so a THROW means the transport died — and the same tick's
    // `/api/projects` inside `useProjectScope` reports that as `fatal` below.
    void api.summary(project, ctrl.signal).then(setSummary).catch(() => undefined);
    void api.graphStats(project, ctrl.signal).then(setGraph).catch(() => undefined);
    return () => ctrl.abort();
  }, [project, live.tick]);

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
  const everything = project === null;

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
          {/*
            The SHARED control — byte-identical markup to what `Layers` and
            `Triage` render, including the `Project scope` aria-label the
            browser gate reads. Re-clicking the active chip clears the scope.
          */}
          <ProjectScope scope={scope} />

          {/*
            The scope, in words, because a page that silently changes what it
            is counting is worse than one that never widened. `data-scope` is
            the stable machine-readable form of the same statement.
          */}
          <p className="shell-lede" data-scope={project ?? "everything"}>
            {everything
              ? "SCOPE — everything. No project filter: every brief, every active session, and the whole graph, including anything that belongs to no project. Click a project to narrow."
              : `SCOPE — ${project}. Click the checked chip again to clear it and read the whole brain.`}
          </p>

          <div className="shell-grid">
            <Card data-card="briefs">
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
                    {/*
                      `everything`, not "all projects": the count includes any
                      row whose project is NULL or unregistered. See the header.
                    */}
                    <span>{summary.project ?? "everything"}</span>
                    <span>
                      {summary.degraded ? "DEGRADED" : "OK"}
                    </span>
                  </CardFooter>
                </>
              )}
            </Card>

            <Card data-card="priority">
              <CardEye>// PRIORITY</CardEye>
              {summary === null ? (
                <Skeleton />
              ) : Object.keys(summary.briefs.by_priority).length === 0 ? (
                <CardBody>
                  {everything
                    ? "No priority data anywhere in the brain."
                    : "No priority data for this project."}
                </CardBody>
              ) : (
                <div>
                  {Object.entries(summary.briefs.by_priority).map(([k, v]) => (
                    <KV key={k} k={k} v={v} />
                  ))}
                </div>
              )}
            </Card>

            <Card data-card="instances">
              <CardEye>// INSTANCES</CardEye>
              {summary === null ? (
                <Skeleton rows={1} />
              ) : (
                <>
                  <CardTitle className="shell-metric">
                    {summary.instances.active}
                  </CardTitle>
                  <CardBody>
                    {everything
                      ? "Active sessions, brain-wide — including any that belong to no project."
                      : "Active sessions on this project."}
                  </CardBody>
                </>
              )}
            </Card>

            {/* The FR-237 bridge proof. Counters only — never a canvas (R8). */}
            <Card data-card="graph">
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
