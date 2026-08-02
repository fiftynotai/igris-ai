/**
 * FR-240 — the briefs layer. List + detail, through the shared components.
 * FR-245 — and a BOARD: the same rows, partitioned by `status`.
 *
 * The two views are ARRANGEMENTS of one dataset, not two features. They share
 * the row descriptor (`briefRow` below — one mapper, so a card and a list row
 * cannot drift), the shared record components, the filter strip and the empty
 * states. What differs is the container and, deliberately, the fetch model: the
 * list follows the shell's 5-second beat, the board reads once per scope and
 * carries an AS OF stamp (D5, `useBoardColumns.ts`).
 *
 * The list is the DEFAULT and stays it. The toggle persists in `sessionStorage`
 * (D4, `layers/useLayersView.ts`) — not in the URL, because a filter is not an
 * address, and not in component state, because the router unmounts this page.
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

import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  type BriefDetailPayload,
  type BriefListRow,
  type BriefsPayload,
} from "../../lib/api";
import { Badge } from "../../components/ui/Badge";
import { Chip } from "../../components/ui/Chip";
import { RecordList, type RecordListRow } from "../../components/record/RecordList";
import { RecordBoard } from "../../components/record/RecordBoard";
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
  type FilterValues,
} from "../../layers/model";
import {
  CARD_CAP,
  KNOWN_BRIEF_STATUSES,
  MANY_COLUMNS,
  hasNonStatusFilters,
  listHandoffFor,
} from "../../layers/board";
import { useBoardColumns } from "../../layers/useBoardColumns";
import { LAYER_VIEWS, useLayersView, type LayerView } from "../../layers/useLayersView";
import { useLayerList } from "../../layers/useLayerList";
import { useNeighbours } from "../../layers/useNeighbours";
import type { LayerViewProps } from "../Layers";

const LAYER = "briefs" as const;

export function Briefs(props: LayerViewProps) {
  const [view, setView] = useLayersView();
  /**
   * The board-to-list handoff: the filter values OPEN IN LIST asked for.
   *
   * Held here because the two views are siblings and the list is remounted when
   * the view flips, so `useLayerList` picks these up as its `initial` values on
   * mount. Cleared whenever the operator switches views by the CHIP, so
   * "toggle to list" means the whole layer and "open this column in the list"
   * means that column — two different intents, told apart by which control was
   * used rather than by remembering.
   */
  const [handoff, setHandoff] = useState<FilterValues | null>(null);

  const chooseView = useCallback(
    (next: LayerView) => {
      setHandoff(null);
      setView(next);
    },
    [setView],
  );

  const openInList = useCallback(
    (status: string) => {
      setHandoff(listHandoffFor(status));
      setView("list");
    },
    [setView],
  );

  if (props.address !== null) {
    return <BriefDetailView {...props} address={props.address} />;
  }

  const actions = <ViewToggle view={view} onChange={chooseView} />;

  return view === "board" ? (
    <BriefBoardView {...props} actions={actions} onOpenInList={openInList} />
  ) : (
    <BriefListView {...props} actions={actions} initial={handoff ?? undefined} />
  );
}

/**
 * `VIEW: LIST | BOARD` — the same chip radiogroup idiom as every other control
 * on this page.
 *
 * `FilterBar`'s header warns that a third control vocabulary would make the
 * dashboard look assembled rather than designed, so this is `ui/Chip` in its
 * `tweak` variant, exactly as the filter strip and the project scope are. It
 * differs from `FilterBar`'s groups in ONE way, deliberately: re-clicking the
 * active chip does not clear it, because there is no "no view".
 */
function ViewToggle({
  view,
  onChange,
}: {
  view: LayerView;
  onChange: (next: LayerView) => void;
}) {
  return (
    <div className="tweaks-chips" role="radiogroup" aria-label="Layer view">
      {LAYER_VIEWS.map((v) => (
        <Chip
          key={v}
          variant="tweak"
          role="radio"
          active={view === v}
          onClick={() => onChange(v)}
        >
          {v.toUpperCase()}
        </Chip>
      ))}
    </div>
  );
}

/**
 * ONE row descriptor, built ONCE, consumed by both arrangements.
 *
 * The board is "a different arrangement of the same rows" — and this function
 * is where that stops being a claim and becomes a fact. Two mappers would be
 * two chances for a card to show a different badge set from a list row.
 */
function briefRow(row: BriefListRow): RecordListRow {
  return {
    key: `${row.project}|${row.brief_id}`,
    eye: `// ${row.brief_id}${row.brief_type !== null ? ` · ${row.brief_type}` : ""}`,
    title: row.title,
    href: recordHash({ layer: LAYER, project: row.project, id: row.brief_id }),
    badges: (
      <>
        <Badge>{row.status}</Badge>
        {row.priority !== null && <Badge variant="muted">{row.priority}</Badge>}
      </>
    ),
    meta: [
      { k: "project", v: row.project },
      { k: "effort", v: row.effort ?? "—" },
      { k: "phase", v: row.phase ?? "—" },
      { k: "updated", v: row.updated_at },
    ],
  };
}

/** The four brief filters as `FilterBar` controls, with per-view vocabularies. */
function briefControls(
  values: FilterValues,
  options: (name: string) => readonly string[],
): { name: string; label: string; options: readonly string[]; value: string }[] {
  return (FILTERS[LAYER] ?? []).map((def) => ({
    name: def.name,
    label: def.label,
    options: options(def.name),
    value: values[def.name] ?? "",
  }));
}

/** The vocabulary a filter can offer, read from the rows actually loaded. */
function optionsFromRows(rows: readonly BriefListRow[], name: string): string[] {
  return [
    ...new Set(
      rows
        .map((r) => String(r[name as "status" | "priority" | "effort" | "brief_type"] ?? ""))
        .filter((v) => v.length > 0),
    ),
  ].sort();
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function BriefListView({
  project,
  search,
  live,
  actions,
  initial,
}: LayerViewProps & { actions?: React.ReactNode; initial?: FilterValues }) {
  const list = useLayerList<BriefsPayload>({
    fetch: ({ limit, offset, values }, signal) =>
      api.briefs(listQuery({ layer: LAYER, project, values, limit, offset }), signal),
    deps: [project],
    tick: live.tick,
    // FR-245 — the board-to-list handoff. `useLayerList` reads this once, at
    // mount, and CLEAR FILTERS returns to it: arriving from a column's
    // OPEN IN LIST means that status IS the starting point, not an accident to
    // be cleared away by the first clear.
    initial,
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
  const controls = briefControls(list.values, (name) => optionsFromRows(items, name));

  return (
    <RecordList
      eye={descriptor?.eye ?? "// BRIEFS"}
      heading="BRIEFS"
      actions={actions}
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
      rows={muted.map(briefRow)}
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
// Board (FR-245)
// ---------------------------------------------------------------------------

function BriefBoardView({
  project,
  search,
  actions,
  onOpenInList,
}: LayerViewProps & {
  actions?: React.ReactNode;
  onOpenInList: (status: string) => void;
}) {
  /*
   * The board's own filter values. Not `useLayerList`'s — that hook owns a page
   * WINDOW and a refetch on the beat, and the board has neither (D5). What it
   * does share is the semantics: an empty value clears, and every value goes
   * into every column's query through the one pure builder.
   */
  const [values, setValues] = useState<FilterValues>({});
  const setFilter = useCallback((name: string, value: string) => {
    setValues((cur) => {
      const next = { ...cur };
      if (value.length === 0) delete next[name];
      else next[name] = value;
      return next;
    });
  }, []);
  const clearFilters = useCallback(() => setValues({}), []);

  const board = useBoardColumns({ project, values });
  const descriptor = layerById(LAYER);

  const loadedRows = board.columns.flatMap((c) => c.rows);
  const controls = briefControls(values, (name) =>
    // The STATUS vocabulary is the board's own axis — the complete derived set,
    // not the loaded rows — so every column is selectable even though each
    // column only loaded twelve cards. It is left in the DERIVED order rather
    // than sorted alphabetically, so the chips read in the same order as the
    // columns they select. The other three come from the rows, the same
    // honest-about-its-limits rule the list follows.
    name === "status" ? board.allStatuses : optionsFromRows(loadedRows, name),
  );

  const filtersActive = hasActiveFilters(LAYER, values);
  const searchActive = search.trim().length > 0;
  const failed = board.degraded ?? board.error;
  // The board shows a "nothing to show" state INSTEAD of columns only when
  // there is nothing behind them: a degraded read (D9 — and it never falls back
  // to rendering the six known statuses, because a hand-listed column set is
  // exactly what this brief forbids) or a scope with no briefs at all. A
  // filtered-to-zero board still renders its columns, each showing 0.
  const nothing =
    failed !== null || (board.scopeTotal !== null && board.scopeTotal === 0);

  const columns = board.columns.map((col) => ({
    status: col.status,
    label: col.label,
    total: col.total,
    loading: col.loading,
    error: col.error,
    degraded: col.degraded,
    rows: muteRows(col.rows, search, (r) => [
      r.brief_id,
      r.title,
      r.status,
      r.brief_type,
      r.phase,
    ]).map(briefRow),
  }));

  const unmerged = board.columns.length > KNOWN_BRIEF_STATUSES.length;

  return (
    <RecordBoard
      eye={descriptor?.eye ?? "// BRIEFS"}
      heading="BRIEFS"
      actions={actions}
      lede="The same briefs, partitioned by status. Every value the brain holds gets a column."
      loading={board.loading}
      banners={
        <>
          {board.error !== null && (
            <div className="shell-banner" role="status">
              TRANSPORT ERROR — {board.error}
            </div>
          )}
          {board.degraded !== null && (
            <div className="shell-banner" role="status">
              BRIEFS DEGRADED — {board.degraded}
            </div>
          )}
          {board.columns.length > MANY_COLUMNS && (
            // INFORMATION, never a cap. A board that hid columns past a
            // threshold would be hiding exactly the values worth seeing.
            <div className="shell-banner" role="status">
              {board.columns.length} STATUS VALUES IN THIS SCOPE — SCROLL FOR ALL OF THEM
            </div>
          )}
        </>
      }
      filters={{
        controls,
        onChange: setFilter,
        onClearAll: clearFilters,
        readout: searchActive
          ? `MUTED — ${loadedRows.length} CARDS LOADED, COUNTS UNAFFECTED`
          : undefined,
      }}
      columns={columns}
      cardCap={CARD_CAP}
      asOf={board.generatedAt}
      onRefresh={board.refresh}
      onOpenInList={onOpenInList}
      scopeTotal={board.scopeTotal}
      filtered={hasNonStatusFilters(values) || searchActive}
      empty={
        nothing
          ? emptyStateFor({
              layer: LAYER,
              total: board.scopeTotal ?? 0,
              degraded: failed,
              filtersActive,
              searchActive: searchActive && loadedRows.length > 0,
              project,
            })
          : undefined
      }
      note={
        unmerged
          ? "Near-duplicate statuses each get their own column — the board folds nothing. TD-333 owns the status vocabulary; this view reports it."
          : undefined
      }
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
