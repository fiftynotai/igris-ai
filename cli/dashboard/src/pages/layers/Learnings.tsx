/**
 * FR-240 — the learnings layer: browse, HYBRID SEARCH, and detail.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE RETRIEVAL BANNER IS AC #2's OPERATOR-FACING HALF
 * ─────────────────────────────────────────────────────────────────────────
 * `/api/learnings/search` runs the brain's own hybrid recall — BM25 and vector,
 * merged by RRF — through the same `memory-read.ts#hybridSearchLearnings` the
 * MCP tool calls. The failure mode the plan calls "the single most likely
 * invisible failure in the brief" is that the vector arm never loads and the
 * search silently becomes BM25-only: it still returns plausible rows, so nothing
 * looks wrong and half the recall is gone.
 *
 * That is why the payload carries `retrieval` (D3) and why this view renders it
 * as a **banner, not a shrug**:
 *   - `mode: "hybrid"`     → a quiet readout of both arms' hit counts.
 *   - anything else        → a BANNER naming the mode and the REASON verbatim.
 * A `bm25_only` response is a legitimate state (no `sqlite-vec` on the read
 * handle, or an absent/cold HF model cache — the model lives in the one
 * directory `cli/package.json` excludes from the tarball, so a fresh install
 * genuinely has this state until `postinstall` runs). Legitimate is not the same
 * as invisible.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * D9 — `review_status` IS A READ FILTER, AND THAT IS ALL IT IS
 * ─────────────────────────────────────────────────────────────────────────
 * Operator-signed: this lens defaults to `approved`, can show `pending_review`
 * rows behind an explicit banner, and ships **no approve/reject control**.
 * FR-241 owns cognition triage. Note what this makes the lens: the first
 * non-`igris_perception_*` reader of `pending_review` rows. FR-109 gates the
 * MODEL's conscious channel; the operator's own eyes are a different consumer,
 * and the banner is what keeps the distinction visible rather than assumed.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TWO SEARCHES, DELIBERATELY
 * ─────────────────────────────────────────────────────────────────────────
 * The nav box is a client-side MUTE over the loaded page (`// QUICK`, free).
 * The box in this view is the brain's RECALL (`// SLOW`, a real read that may
 * cold-start an embedding model). Merging them would make one of them lie about
 * its cost; the readouts say which is which.
 */

import { useEffect, useState } from "react";
import {
  api,
  ApiError,
  type LearningDetailPayload,
  type LearningsPayload,
  type LearningsSearchPayload,
  type RetrievalReport,
} from "../../lib/api";
import { Badge } from "../../components/ui/Badge";
import { Chip } from "../../components/ui/Chip";
import { RecordList, type RecordListRow } from "../../components/record/RecordList";
import {
  RecordDetail,
  RecordNeighbours,
} from "../../components/record/RecordDetail";
import { Markdown } from "../../markdown/Markdown";
import {
  DEFAULT_REVIEW_STATUS,
  FILTERS,
  SEARCH_LIMIT,
  emptyStateFor,
  graphHrefForRecord,
  hasActiveFilters,
  layerById,
  layerHash,
  listQuery,
  muteRows,
  recordHash,
  searchQuery,
  splitTags,
} from "../../layers/model";
import { useLayerList } from "../../layers/useLayerList";
import { useNeighbours } from "../../layers/useNeighbours";
import type { LayerViewProps } from "../Layers";

const LAYER = "learnings" as const;

export function Learnings(props: LayerViewProps) {
  return props.address !== null ? (
    <LearningDetailView {...props} address={props.address} />
  ) : (
    <LearningListView {...props} />
  );
}

// ---------------------------------------------------------------------------
// The retrieval readout — the whole point of D3
// ---------------------------------------------------------------------------

export function RetrievalBanner({ retrieval }: { retrieval: RetrievalReport }) {
  const degraded = retrieval.mode !== "hybrid";
  const arms = `bm25 ${retrieval.bm25_hits} · vector ${retrieval.vector_hits} · rrf_k ${retrieval.rrf_k} · weights ${retrieval.weights.bm25}/${retrieval.weights.vector}`;

  if (!degraded) {
    return (
      <p className="record-readout" role="status">
        HYBRID RECALL — {arms}
      </p>
    );
  }

  return (
    <div className="shell-banner" role="status">
      {retrieval.mode.toUpperCase().replace("_", " ")} — this search did not run
      both arms.{" "}
      {retrieval.vector_available
        ? "sqlite-vec loaded"
        : "sqlite-vec NOT loaded on the read handle"}
      ;{" "}
      {retrieval.embedding_available
        ? "embeddings available"
        : "the embedding model is unavailable (a cold or absent HF cache is normal before postinstall)"}
      . {retrieval.reason ?? ""} Results are still real — they are just less
      complete than hybrid recall. · {arms}
    </div>
  );
}

// ---------------------------------------------------------------------------
// List (+ search mode)
// ---------------------------------------------------------------------------

function LearningListView({ project, search, live }: LayerViewProps) {
  const list = useLayerList<LearningsPayload>({
    fetch: ({ limit, offset, values }, signal) =>
      api.learnings(
        listQuery({ layer: LAYER, project, values, limit, offset }),
        signal,
      ),
    deps: [project],
    tick: live.tick,
    // D9: the lens opens on approved rows. Declared as the INITIAL value (and as
    // the filter's `fallback` in model.ts) so `hasActiveFilters` does not read
    // the default as a narrowing and mislabel an empty project as "filtered".
    initial: { review_status: DEFAULT_REVIEW_STATUS },
  });

  /** The submitted recall query. `null` = browse mode. */
  const [query, setQuery] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [hits, setHits] = useState<LearningsSearchPayload | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const reviewStatus = list.values.review_status ?? DEFAULT_REVIEW_STATUS;

  // The recall read. Keyed on the SUBMITTED query, not the draft: an embedding
  // cold-start is seconds long, so a search-as-you-type control here would
  // queue one model load per keystroke.
  useEffect(() => {
    if (query === null) {
      setHits(null);
      return;
    }
    const ctrl = new AbortController();
    setSearching(true);
    setSearchError(null);
    api
      .learningsSearch(
        searchQuery({
          query,
          project,
          values: { review_status: reviewStatus },
          limit: SEARCH_LIMIT,
        }),
        ctrl.signal,
      )
      .then((p) => {
        if (!ctrl.signal.aborted) setHits(p);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setSearchError(err instanceof ApiError ? err.message : String(err));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setSearching(false);
      });
    return () => ctrl.abort();
  }, [query, project, reviewStatus]);

  const descriptor = layerById(LAYER);
  const payload = list.payload;
  const browsing = query === null;

  const browseRows = muteRows(payload?.items ?? [], search, (r) => [
    r.id,
    r.title,
    r.category,
    r.source_brief,
    r.tags,
  ]);
  const searchRows = muteRows(hits?.items ?? [], search, (r) => [
    r.id,
    r.title,
    r.preview,
    r.category,
  ]);

  const controls = (FILTERS[LAYER] ?? []).map((def) => ({
    name: def.name,
    label: def.label,
    // These four ARE closed vocabularies (three CHECK constraints and one
    // handler-enforced enum), so they are enumerated rather than derived from
    // the page — unlike the brief filters. `model.ts` records which is which.
    options: def.options ?? [],
    value: list.values[def.name] ?? "",
  }));

  const rows: RecordListRow[] = browsing
    ? browseRows.map((row) => ({
        key: String(row.id),
        eye: `// ${row.id} · ${row.category}`,
        title: row.title,
        href: recordHash({ layer: LAYER, project: row.project, id: String(row.id) }),
        badges: (
          <>
            <Badge variant="muted">{row.scope}</Badge>
            <Badge variant="muted">{row.provenance}</Badge>
            {row.review_status !== DEFAULT_REVIEW_STATUS && (
              <Badge variant="alarm">{row.review_status}</Badge>
            )}
            {splitTags(row.tags)
              .slice(0, 4)
              .map((t) => (
                <Chip key={t} variant="pill" onClick={undefined}>
                  {t}
                </Chip>
              ))}
          </>
        ),
        meta: [
          { k: "project", v: row.project },
          { k: "confidence", v: row.confidence.toFixed(2) },
          { k: "brief", v: row.source_brief.length > 0 ? row.source_brief : "—" },
          { k: "chars", v: String(row.content_length) },
          { k: "created", v: row.created_at },
        ],
      }))
    : searchRows.map((row) => ({
        key: String(row.id),
        eye: `// ${row.id} · ${row.category}`,
        title: row.title,
        trail: row.preview,
        href: recordHash({ layer: LAYER, project: row.project, id: String(row.id) }),
        badges: (
          <>
            <Badge variant="muted">{row.scope}</Badge>
            {/*
              WHICH ARM FOUND THIS ROW. A row with a vector rank and NO bm25 rank
              is one the lexical arm could not have produced — which is exactly
              the evidence AC #2 asks for, shown to the operator rather than only
              asserted in a test.
            */}
            {row.vector_rank !== null && row.bm25_rank === null && (
              <Badge>vector only</Badge>
            )}
            {row.bm25_rank !== null && row.vector_rank === null && (
              <Badge variant="muted">bm25 only</Badge>
            )}
            {row.bm25_rank !== null && row.vector_rank !== null && (
              <Badge variant="muted">both arms</Badge>
            )}
          </>
        ),
        meta: [
          { k: "project", v: row.project },
          { k: "rrf", v: row.rrf_score === null ? "—" : row.rrf_score.toFixed(4) },
          { k: "bm25", v: row.bm25_rank === null ? "—" : String(row.bm25_rank) },
          { k: "vector", v: row.vector_rank === null ? "—" : String(row.vector_rank) },
          { k: "confidence", v: row.confidence.toFixed(2) },
        ],
      }));

  const degradedReason = browsing
    ? (payload?.degraded?.reason ?? list.error)
    : (hits?.degraded?.reason ?? searchError);

  return (
    <RecordList
      eye={descriptor?.eye ?? "// LEARNINGS"}
      heading="LEARNINGS"
      lede={descriptor?.lede}
      loading={browsing ? list.loading : searching && hits === null}
      banners={
        <>
          {degradedReason != null && (
            <div className="shell-banner" role="status">
              {browsing ? "LEARNINGS DEGRADED" : "SEARCH DEGRADED"} — {degradedReason}
            </div>
          )}
          {reviewStatus !== DEFAULT_REVIEW_STATUS && (
            // D9's explicit banner. It names the boundary as well as the state:
            // this lens READS these rows, and nothing here can approve one.
            <div className="shell-banner" role="status">
              SHOWING {reviewStatus.toUpperCase().replace("_", " ")} ROWS — these
              have not entered the model's conscious channel (FR-109). This view
              is read-only; triage ships with FR-241.
            </div>
          )}
          {!browsing && hits !== null && (
            <RetrievalBanner retrieval={hits.retrieval} />
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
        onClearAll: () => {
          list.clearFilters();
          setQuery(null);
          setDraft("");
        },
        search: {
          label: "hybrid recall",
          value: draft,
          placeholder: "ASK THE BRAIN",
          help: browsing
            ? "Runs the brain's own BM25 + vector recall. A first search may load the embedding model."
            : `Recall for "${query ?? ""}" — ${hits?.count ?? 0} hit(s). CLEAR to browse again.`,
          busy: searching,
          onChange: setDraft,
          onSubmit: () => setQuery(draft.trim().length > 0 ? draft.trim() : null),
          onClear: () => {
            setDraft("");
            setQuery(null);
          },
        },
        readout:
          search.trim().length > 0
            ? `MUTED ${rows.length}/${(browsing ? payload?.items.length : hits?.items.length) ?? 0} THIS PAGE`
            : undefined,
      }}
      rows={rows}
      // Search results are ONE ranked page — RRF over two arms has no stable
      // offset semantics, so paging them would present a second page that is not
      // the continuation of the first. Browse mode paginates; recall does not.
      page={
        browsing && payload !== null
          ? {
              limit: payload.limit,
              offset: payload.offset,
              total: payload.total,
              count: payload.count,
              onOffset: list.setOffset,
            }
          : undefined
      }
      empty={emptyStateFor({
        layer: LAYER,
        total: browsing ? (payload?.total ?? 0) : (hits?.count ?? 0),
        degraded: degradedReason ?? null,
        // A submitted recall query is itself a narrowing — "no hits" must not
        // read as "this project has no learnings".
        filtersActive: hasActiveFilters(LAYER, list.values) || !browsing,
        searchActive: search.trim().length > 0,
        project,
      })}
    />
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function LearningDetailView({
  address,
  project,
}: LayerViewProps & { address: NonNullable<LayerViewProps["address"]> }) {
  const [payload, setPayload] = useState<LearningDetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const id = Number(address.id);

  useEffect(() => {
    if (!Number.isInteger(id) || id < 1) {
      setError(`not a learning id: ${address.id}`);
      return;
    }
    const ctrl = new AbortController();
    setPayload(null);
    setError(null);
    api
      .learning(id, ctrl.signal)
      .then((p) => {
        if (!ctrl.signal.aborted) setPayload(p);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(err instanceof ApiError ? err.message : String(err));
      });
    return () => ctrl.abort();
  }, [id, address.id]);

  const learning = payload?.learning ?? null;
  const neighbours = useNeighbours(
    learning === null
      ? null
      : { type: "learning", project: learning.project, id: String(learning.id) },
    learning?.project ?? project,
  );

  return (
    <RecordDetail
      eye={`// ${address.id}${learning !== null ? ` · ${learning.category}` : ""}`}
      title={learning?.title ?? address.id}
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
              LEARNING DEGRADED — {payload.degraded.reason}
            </div>
          )}
        </>
      }
      badges={
        learning === null ? undefined : (
          <>
            <Badge>{learning.category}</Badge>
            <Badge variant="muted">{learning.scope}</Badge>
            <Badge variant="muted">{learning.provenance}</Badge>
            {splitTags(learning.tags).map((t) => (
              <Chip key={t} variant="pill" onClick={undefined}>
                {t}
              </Chip>
            ))}
          </>
        )
      }
      meta={[
        { k: "project", v: learning?.project ?? address.project ?? "—" },
        { k: "learning id", v: address.id },
        { k: "confidence", v: learning?.confidence.toFixed(2) ?? "—" },
        {
          k: "source brief",
          v:
            learning !== null && learning.source_brief.length > 0
              ? learning.source_brief
              : "—",
        },
        {
          k: "tech stack",
          v:
            learning !== null && learning.tech_stack.length > 0
              ? learning.tech_stack
              : "—",
        },
        // `access_count` is shown, and reading this page does NOT increment it:
        // `memory-read.ts#getLearning` has no UPDATE. TD-092 keeps the bump on
        // `igris_memory_get`/`recall`, where it feeds the ranking boost — a page
        // view is not a recall event, and letting it count would corrupt the
        // very telemetry the bump exists to produce.
        { k: "access count", v: String(learning?.access_count ?? "—") },
        { k: "created", v: learning?.created_at ?? "—" },
      ]}
      body={
        learning === null ? undefined : <Markdown source={learning.content} />
      }
      neighbours={
        <RecordNeighbours
          state={learning === null ? "loading" : neighbours.state}
          entries={neighbours.entries}
          note={neighbours.note}
          edgeCount={neighbours.edgeCount}
        />
      }
    />
  );
}
