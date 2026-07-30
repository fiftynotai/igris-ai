/**
 * FR-240 — the goals layer: deadline / priority / status, and the briefs
 * serving each goal.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A GOAL ID IS GLOBAL. THAT ASYMMETRY IS THE POINT OF BR-078
 * ─────────────────────────────────────────────────────────────────────────
 * `/api/goal` takes `id` alone, while `/api/brief` REQUIRES `project` + `id`.
 * That is not an inconsistency: `GL-XXX` is a brain-allocated global sequence,
 * whereas `BR-001` names a different brief in 25 projects. So a goal's record
 * address carries an EMPTY project segment (`#/layers/goals//GL-012`), and
 * `model.ts` encodes that from the layer descriptor's `projectScoped: false`
 * rather than from a special case in this file.
 *
 * `project_slug` is still SHOWN and still filterable — a goal usually belongs to
 * a project. It is just not part of its identity.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SERVING BRIEFS ARE CROSS-LINKS
 * ─────────────────────────────────────────────────────────────────────────
 * The detail lists them with `#/layers/briefs/<project>/<brief_id>` hrefs, built
 * from the GOAL's project — because `serving_briefs` rows carry `brief_id`
 * without a project (the reader joins them within the goal's own project). If a
 * goal has no `project_slug`, the link is omitted rather than guessed: a link to
 * the wrong project's `BR-001` is precisely the BR-078 defect.
 */

import { useEffect, useState } from "react";
import {
  api,
  ApiError,
  type GoalDetailPayload,
  type GoalsPayload,
} from "../../lib/api";
import { Badge } from "../../components/ui/Badge";
import { RecordList, type RecordListRow } from "../../components/record/RecordList";
import {
  RecordDetail,
  RecordNeighbours,
} from "../../components/record/RecordDetail";
import { Markdown } from "../../markdown/Markdown";
import {
  FILTERS,
  deadlineLabel,
  emptyStateFor,
  graphHrefForRecord,
  hasActiveFilters,
  layerById,
  layerHash,
  listQuery,
  muteRows,
  recordHash,
} from "../../layers/model";
import { useLayerList } from "../../layers/useLayerList";
import { useNeighbours } from "../../layers/useNeighbours";
import type { LayerViewProps } from "../Layers";

const LAYER = "goals" as const;

export function Goals(props: LayerViewProps) {
  return props.address !== null ? (
    <GoalDetailView {...props} address={props.address} />
  ) : (
    <GoalListView {...props} />
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function GoalListView({ project, search, live }: LayerViewProps) {
  const list = useLayerList<GoalsPayload>({
    fetch: ({ limit, offset, values }, signal) =>
      api.goals(listQuery({ layer: LAYER, project, values, limit, offset }), signal),
    deps: [project],
    tick: live.tick,
  });

  const descriptor = layerById(LAYER);
  const payload = list.payload;
  const items = payload?.items ?? [];
  const muted = muteRows(items, search, (r) => [
    r.goal_id,
    r.title,
    r.outcome,
    r.status,
    r.project_slug,
  ]);

  // A single clock for the whole render, so two rows computed a millisecond
  // apart cannot disagree about what "today" is.
  const now = new Date();

  const controls = (FILTERS[LAYER] ?? []).map((def) => ({
    name: def.name,
    label: def.label,
    options: def.options ?? [],
    value: list.values[def.name] ?? "",
  }));

  return (
    <RecordList
      eye={descriptor?.eye ?? "// GOALS"}
      heading="GOALS"
      lede={descriptor?.lede}
      loading={list.loading}
      banners={
        <>
          {list.error !== null && (
            <div className="shell-banner" role="status">
              TRANSPORT ERROR — {list.error}
            </div>
          )}
          {payload?.degraded != null && (
            <div className="shell-banner" role="status">
              GOALS DEGRADED — {payload.degraded.reason}
            </div>
          )}
          {payload != null && payload.params.length > 0 && (
            <div className="shell-banner" role="status">
              REQUEST ADJUSTED — {payload.params.join(" · ")}
            </div>
          )}
        </>
      }
      filters={{
        controls,
        onChange: list.setFilter,
        onClearAll: list.clearFilters,
        readout:
          search.trim().length > 0
            ? `MUTED ${muted.length}/${items.length} THIS PAGE`
            : undefined,
      }}
      rows={muted.map(
        (row): RecordListRow => ({
          key: row.goal_id,
          eye: `// ${row.goal_id} · ${row.priority}`,
          title: row.title,
          trail: row.outcome.length > 0 ? row.outcome : null,
          href: recordHash({ layer: LAYER, project: null, id: row.goal_id }),
          badges: (
            <>
              <Badge>{row.status}</Badge>
              <Badge
                // An overdue goal is the one thing on this page worth alarming
                // about. Everything else stays quiet.
                variant={
                  row.deadline !== null && deadlineLabel(row, now).startsWith("OVERDUE")
                    ? "alarm"
                    : "muted"
                }
              >
                {deadlineLabel(row, now)}
              </Badge>
            </>
          ),
          meta: [
            { k: "project", v: row.project_slug ?? "global" },
            { k: "deadline", v: row.deadline ?? "—" },
            { k: "serving briefs", v: String(row.serving_briefs_count) },
            { k: "updated", v: row.updated_at },
          ],
        }),
      )}
      page={
        payload === null
          ? undefined
          : {
              limit: payload.limit,
              offset: payload.offset,
              total: payload.total,
              count: payload.count,
              onOffset: list.setOffset,
            }
      }
      empty={emptyStateFor({
        layer: LAYER,
        total: payload?.total ?? 0,
        degraded: payload?.degraded?.reason ?? list.error,
        filtersActive: hasActiveFilters(LAYER, list.values),
        searchActive: search.trim().length > 0 && items.length > 0,
        project,
      })}
    />
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function GoalDetailView({
  address,
}: LayerViewProps & { address: NonNullable<LayerViewProps["address"]> }) {
  const [payload, setPayload] = useState<GoalDetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setPayload(null);
    setError(null);
    api
      .goal(address.id, ctrl.signal)
      .then((p) => {
        if (!ctrl.signal.aborted) setPayload(p);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(err instanceof ApiError ? err.message : String(err));
      });
    return () => ctrl.abort();
  }, [address.id]);

  const goal = payload?.goal ?? null;
  const neighbours = useNeighbours(
    goal === null ? null : { type: "goal", project: null, id: goal.goal_id },
    // A goal's graph scope is its project when it has one; otherwise the whole
    // brain, which is the ~1 MB payload. Documented in `useNeighbours`.
    goal?.project_slug ?? null,
  );

  const now = new Date();

  return (
    <RecordDetail
      eye={`// ${address.id}${goal !== null ? ` · ${goal.priority}` : ""}`}
      title={goal?.title ?? address.id}
      backHref={layerHash(LAYER)}
      locateHref={graphHrefForRecord(address)}
      asOf={payload?.generated_at ?? null}
      loading={payload === null && error === null}
      banners={
        <>
          {error !== null && (
            <div className="shell-banner" role="status">
              READ FAILED — {error}
            </div>
          )}
          {payload?.degraded != null && (
            <div className="shell-banner" role="status">
              GOAL DEGRADED — {payload.degraded.reason}
            </div>
          )}
        </>
      }
      badges={
        goal === null ? undefined : (
          <>
            <Badge>{goal.status}</Badge>
            <Badge variant="muted">{goal.priority}</Badge>
            <Badge
              variant={
                deadlineLabel({ ...goal, serving_briefs_count: 0 }, now).startsWith(
                  "OVERDUE",
                )
                  ? "alarm"
                  : "muted"
              }
            >
              {deadlineLabel({ ...goal, serving_briefs_count: 0 }, now)}
            </Badge>
          </>
        )
      }
      meta={[
        { k: "goal id", v: address.id },
        { k: "project", v: goal?.project_slug ?? "global" },
        { k: "deadline", v: goal?.deadline ?? "—" },
        { k: "achieved", v: goal?.achieved_at ?? "—" },
        { k: "created", v: goal?.created_at ?? "—" },
        {
          k: "serving learnings",
          v: String(payload?.serving_learnings_count ?? "—"),
        },
      ]}
      body={
        goal === null ? undefined : (
          <>
            <span className="shell-eye">// OUTCOME</span>
            <Markdown source={goal.outcome} />
            {goal.description !== null && goal.description.length > 0 && (
              <>
                <span className="shell-eye">// DESCRIPTION</span>
                <Markdown source={goal.description} />
              </>
            )}
          </>
        )
      }
      neighbours={
        <RecordNeighbours
          state={goal === null ? "loading" : neighbours.state}
          entries={neighbours.entries}
          note={neighbours.note}
          edgeCount={neighbours.edgeCount}
        />
      }
    >
      {payload !== null && (
        <section className="record-neighbours" aria-label="Serving briefs">
          <span className="shell-eye">
            // SERVING BRIEFS · {payload.serving_briefs.length}
          </span>
          {payload.serving_briefs.length === 0 ? (
            <p className="record-note">
              No brief is filed against this goal yet. A goal with no briefs is an
              intention, not a plan.
            </p>
          ) : (
            <ul className="record-hops">
              {payload.serving_briefs.map((b) => {
                // Only linkable when the goal names a project — see the header.
                const href =
                  goal?.project_slug != null
                    ? recordHash({
                        layer: "briefs",
                        project: goal.project_slug,
                        id: b.brief_id,
                      })
                    : null;
                return (
                  <li key={b.brief_id}>
                    {href !== null ? (
                      <a className="record-hop" href={href} data-cursor="hover">
                        <b>{b.brief_id}</b>
                        {b.title}
                        <span className="record-filters-spacer" />
                        <Badge variant="muted">{b.status}</Badge>
                      </a>
                    ) : (
                      <span className="record-hop" data-disabled="true">
                        <b>{b.brief_id}</b>
                        {b.title} — this goal names no project, so the brief
                        cannot be addressed unambiguously (BR-078)
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </RecordDetail>
  );
}
