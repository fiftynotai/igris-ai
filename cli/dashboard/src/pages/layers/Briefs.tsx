/**
 * FR-240 — the briefs layer. List + detail, through the shared components.
 *
 * The detail's BODY is `brief_files.content`, rendered by `markdown/Markdown.tsx`
 * — React elements, never HTML (D4). This is the surface that makes the AC-#2
 * sibling claim ("prove ACCESS, not bytes", learning 1096) checkable: the
 * operator can READ a brief's text in the browser, not merely observe that an
 * endpoint returned a non-empty payload.
 *
 * ADDRESSING IS THE `(project, brief_id)` PAIR, ALWAYS. `/api/brief` REFUSES an
 * id without a project, because `BR-001` names a different brief in 25 projects
 * (BR-078) — so the row href carries both, and a detail with no project in its
 * address never reaches the endpoint at all.
 */

import { useEffect, useState } from "react";
import {
  api,
  ApiError,
  type BriefDetailPayload,
  type BriefsPayload,
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

const LAYER = "briefs" as const;

export function Briefs(props: LayerViewProps) {
  return props.address !== null ? (
    <BriefDetailView {...props} address={props.address} />
  ) : (
    <BriefListView {...props} />
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function BriefListView({ project, search, live }: LayerViewProps) {
  const list = useLayerList<BriefsPayload>({
    fetch: ({ limit, offset, values }, signal) =>
      api.briefs(listQuery({ layer: LAYER, project, values, limit, offset }), signal),
    deps: [project],
    tick: live.tick,
  });

  const descriptor = layerById(LAYER);
  const payload = list.payload;
  const items = payload?.items ?? [];
  const muted = muteRows(items, search, (r) => [
    r.brief_id,
    r.title,
    r.status,
    r.brief_type,
    r.phase,
  ]);

  /*
   * The `status` / `priority` / `effort` / `brief_type` vocabularies come from
   * THE ROWS, not from a hard-coded list.
   *
   * `brief_status.status` and `.priority` have NO CHECK constraint in the brain
   * and `/hunt` has grown the vocabulary before — so an enumerated allowlist
   * here would silently hide every row carrying a value invented after this file
   * was written. `params.ts` makes the same call for the same reason (its four
   * brief filters are `allowed: null`).
   *
   * Consequence, stated honestly: the options describe the CURRENT PAGE, so a
   * value that exists only on page 7 has no chip until you get there. The
   * alternative — a second query per filter to enumerate the domain — is four
   * more reads per page for a control the operator can reach by paging.
   */
  const controls = (FILTERS[LAYER] ?? []).map((def) => ({
    name: def.name,
    label: def.label,
    options: [
      ...new Set(
        items
          .map((r) => String(r[def.name as "status" | "priority" | "effort" | "brief_type"] ?? ""))
          .filter((v) => v.length > 0),
      ),
    ].sort(),
    value: list.values[def.name] ?? "",
  }));

  return (
    <RecordList
      eye={descriptor?.eye ?? "// BRIEFS"}
      heading="BRIEFS"
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
              BRIEFS DEGRADED — {payload.degraded.reason}
            </div>
          )}
          {payload !== undefined && payload !== null && payload.params.length > 0 && (
            // NOT a degraded banner: this says the REQUEST was adjusted, which
            // is a different problem with a different fix.
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
          key: `${row.project}|${row.brief_id}`,
          eye: `// ${row.brief_id}${row.brief_type !== null ? ` · ${row.brief_type}` : ""}`,
          title: row.title,
          href: recordHash({ layer: LAYER, project: row.project, id: row.brief_id }),
          badges: (
            <>
              <Badge>{row.status}</Badge>
              {row.priority !== null && (
                <Badge variant="muted">{row.priority}</Badge>
              )}
            </>
          ),
          meta: [
            { k: "project", v: row.project },
            { k: "effort", v: row.effort ?? "—" },
            { k: "phase", v: row.phase ?? "—" },
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

function BriefDetailView({
  address,
  project,
}: LayerViewProps & { address: NonNullable<LayerViewProps["address"]> }) {
  const [payload, setPayload] = useState<BriefDetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetched ONCE per address, not on the beat. See `RecordDetail`'s header: a
  // 5-second refetch re-parses and re-renders a whole markdown document
  // forever, and the staleness is carried by the AS OF stamp instead.
  useEffect(() => {
    if (address.project === null) {
      // Unreachable through the UI (every row href carries a project), but a
      // hand-typed `#/layers/briefs//BR-001` lands here. The endpoint would
      // refuse it; saying so locally is clearer than a round trip.
      setError(
        "a brief id alone is ambiguous — this address is missing its project (BR-078)",
      );
      return;
    }
    const ctrl = new AbortController();
    setPayload(null);
    setError(null);
    api
      .brief(address.project, address.id, ctrl.signal)
      .then((p) => {
        if (!ctrl.signal.aborted) setPayload(p);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(err instanceof ApiError ? err.message : String(err));
      });
    return () => ctrl.abort();
  }, [address.project, address.id]);

  const brief = payload?.brief ?? null;
  const neighbours = useNeighbours(
    brief === null
      ? null
      : { type: "brief", project: brief.project, id: brief.brief_id },
    // Scope the graph read to the brief's own project — the whole-brain payload
    // would answer the same question at ten times the size.
    brief?.project ?? project,
  );

  return (
    <RecordDetail
      eye={`// ${address.id}${brief?.brief_type != null ? ` · ${brief.brief_type}` : ""}`}
      title={brief?.title ?? address.id}
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
              BRIEF DEGRADED — {payload.degraded.reason}
            </div>
          )}
        </>
      }
      badges={
        brief === null ? undefined : (
          <>
            {brief.status !== null && <Badge>{brief.status}</Badge>}
            {brief.priority !== null && (
              <Badge variant="muted">{brief.priority}</Badge>
            )}
            {brief.effort !== null && <Badge variant="muted">{brief.effort}</Badge>}
          </>
        )
      }
      meta={[
        { k: "project", v: address.project ?? "—" },
        { k: "brief id", v: address.id },
        { k: "phase", v: brief?.phase ?? "—" },
        { k: "updated", v: brief?.updated_at ?? "—" },
        { k: "file", v: brief?.filename ?? "—" },
        // The content hash, so an operator comparing a brief on disk with the
        // brain's copy can tell whether they are the same bytes.
        { k: "content hash", v: brief?.content_hash ?? "—" },
      ]}
      body={
        brief === null ? undefined : brief.content === null ||
          brief.content.length === 0 ? (
          <p className="record-note">
            This brief has no body in the brain — only its status row. That is
            normal for a brief filed through `igris_brief_create` without a file.
          </p>
        ) : (
          <Markdown source={brief.content} />
        )
      }
      neighbours={
        <RecordNeighbours
          state={brief === null ? "loading" : neighbours.state}
          entries={neighbours.entries}
          note={neighbours.note}
          edgeCount={neighbours.edgeCount}
        />
      }
    />
  );
}
