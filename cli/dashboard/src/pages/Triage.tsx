/**
 * FR-241 — the cognition triage surface. Two sub-tabs, one bulk bar, one POST.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT REUSES FR-240's SHELL, IT DOES NOT FORK IT
 * ─────────────────────────────────────────────────────────────────────────
 * `RecordList` renders both tabs (its row descriptor GREW a `select` field —
 * see that file), `FilterBar` renders the filters through `RecordList`'s own
 * `filters` prop, `useLayerList` runs the list state machine, `emptyStateFor`
 * picks the empty copy, and `ProjectScope` renders the scope chips. The only
 * new components on this page are the bulk bar and its dialog, because nothing
 * in FR-240 could mutate and so nothing in FR-240 had one.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PROJECT-SCOPED BY DEFAULT (D5), AND THE COUNT IS STATED BEFORE THE ROWS
 * ─────────────────────────────────────────────────────────────────────────
 * The real queue is 1,188 pending suggestions across 19 projects; `igris-ai`
 * alone is 407. A surface whose default selection spans all nineteen is a
 * surface where SELECT PAGE -> DISMISS is one mis-click from a catastrophe with
 * no undo tool. So the page inherits the shell's scope chips, opens on the
 * server-resolved default project like every other page, and when the operator
 * clears the scope it BANNERS the all-projects total before the rows — the
 * number is the warning.
 *
 * The bulk affordance is additionally bounded by the page: `SELECT PAGE` selects
 * the 50 loaded rows, never "all 1,188 matching", and `confineToVisible` drops
 * any id that leaves the page. You may only act on what is on screen.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TD-326 — THE THIRD SCOPE, BECAUSE D5 WAS HIDING A THIRD OF THE QUEUE
 * ─────────────────────────────────────────────────────────────────────────
 * `suggestions.project_slug` is NULLABLE and 377 pending rows carry NULL —
 * synapse's `edge_inference` output (FR-211), which belongs to the brain rather
 * than to any project, so NULL is correct. The scope filter is correct too. The
 * defect was the SILENCE: two correct behaviours intersecting so that the
 * default view could neither list those rows nor mention them.
 *
 * The fix makes them ADDRESSABLE, not merely announced. `(brain-level)` is a
 * chip in the SAME scope strip, and selecting it lists exactly the project-less
 * rows as their own population — so a bulk action there is as explicit as any
 * other and reaches STRICTLY FEWER rows than clearing the scope would. D5 is
 * preserved twice over: the default is still the server-resolved project, and
 * `brain-level` cannot touch a row belonging to a project the operator did not
 * choose, because no such row is in the set.
 *
 * While scoped to a project the count is stated in a BANNER — the same place
 * FR-241 already puts the number that is the warning. A count badge on the chip
 * was rejected: the count lives in the suggestions payload, the chip strip is
 * rendered above the tabs, and lifting the number out of the child to decorate
 * a parent's chip would couple two components to make a number appear 40 px
 * higher up.
 *
 * The CANDIDATES tab has no such population and cannot grow one:
 * `learnings.project` is `NOT NULL` in the brain schema (`db.ts:156`, verified
 * with `PRAGMA table_info` against the operator brain — `notnull: 1`, 0 rows
 * with a NULL or empty project, 13 pending). So brain-level on that tab is an
 * explicitly stated empty category rather than a query, and no request is made.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE TTL DIVERGENCE IS BANNERED, NOT DISCOVERED
 * ─────────────────────────────────────────────────────────────────────────
 * `igris_perception_review_pending` applies a `pending_review_ttl_days` window;
 * `/api/learnings?review_status=pending_review` does not. So this page shows
 * MORE than the MCP tool — including TTL-expired candidates that
 * `igris_perception_expire_stale` has not reaped. For a backlog-clearing
 * surface that is the correct behaviour (hiding rows you must triage is the
 * bug), but an operator who compares the two counts must be told why they
 * differ rather than left to find out.
 */

import { useEffect, useState } from "react";
import { Badge } from "../components/ui/Badge";
import { ProjectScope } from "../components/chrome/ProjectScope";
import { StatePage } from "../components/ui/StatePage";
import { BulkBar } from "../components/triage/BulkBar";
import { RecordList, type RecordListRow } from "../components/record/RecordList";
import { SearchReadout } from "../components/record/SearchReadout";
import { useQFilter } from "../layers/useQFilter";
import {
  api,
  type LearningListRow,
  type LearningsPayload,
  type SuggestionRow,
  type SuggestionsPayload,
} from "../lib/api";
import { emptyStateFor, muteRows, recordHash } from "../layers/model";
import { useLayerList } from "../layers/useLayerList";
import {
  BRAIN_LEVEL_PARAM,
  BRAIN_LEVEL_SCOPE,
  useProjectScope,
} from "../lib/useProjectScope";
import type { Live } from "../lib/useLive";
import {
  EMPTY_SELECTION,
  TAB_ACTIONS,
  TRIAGE_TABS,
  confineToVisible,
  selectAll,
  summaryLine,
  toggleSelected,
  type Selection,
  type TriageRow,
  type TriageTab,
} from "../triage/model";
import { useTriage } from "../triage/useTriage";

const TAB_LABEL: Record<TriageTab, string> = {
  suggestions: "Suggestions",
  candidates: "Candidates",
};

export interface TriageProps {
  live: Live;
  /** The nav's `// QUICK` client-side text mute over the loaded page. */
  search: string;
}

export function Triage({ live, search }: TriageProps) {
  const [tab, setTab] = useState<TriageTab>("suggestions");
  const scope = useProjectScope(live.tick);

  if (scope.fatal !== null) {
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
        meta={scope.fatal}
      />
    );
  }

  return (
    <>
      <div className="record-tabs" role="navigation" aria-label="Triage">
        {TRIAGE_TABS.map((t) => (
          <button
            key={t}
            type="button"
            className="shell-nav-link"
            aria-current={t === tab ? "page" : undefined}
            data-cursor="hover"
            onClick={() => setTab(t)}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      <ProjectScope scope={scope} extra={[BRAIN_LEVEL_SCOPE]} />

      {/*
        Keyed on the tab so switching tabs REMOUNTS the view: the selection,
        the filters and the page offset all belong to one table, and carrying a
        selection of suggestion ids into the candidates tab would be a bulk
        action aimed at rows that happen to share an integer.
      */}
      {tab === "suggestions" ? (
        <SuggestionsTab key="suggestions" live={live} search={search} project={scope.project} />
      ) : scope.project === BRAIN_LEVEL_SCOPE ? (
        <BrainLevelCandidates />
      ) : (
        <CandidatesTab key="candidates" live={live} search={search} project={scope.project} />
      )}
    </>
  );
}

/**
 * The candidates tab under `brain-level`. TD-326.
 *
 * NO FETCH. The alternative — sending the scope to `/api/learnings`, which does
 * not implement `project_scope` — would be reported as `unknown filter` and the
 * page would render the UNSCOPED list under a chip that says `brain-level`,
 * which is the blur between `everything` and `brain-level` that TD-326 exists
 * to prevent.
 *
 * The reason is stated rather than left as an empty list, and it is a SCHEMA
 * reason rather than a reading of today's rows.
 */
function BrainLevelCandidates() {
  return (
    <StatePage
      inset
      variant="empty"
      headline={
        <>
          <em>no brain-level candidates.</em>
        </>
      }
      message="Perception candidates always belong to a project — `learnings.project` is NOT NULL in the brain schema, so this population is empty by construction rather than by today's data. It is the suggestion queue that has project-less rows (synapse's edge inferences). Pick a project above to review candidates."
      meta="learnings.project is NOT NULL · 0 rows possible"
    />
  );
}

interface TabProps {
  live: Live;
  search: string;
  project: string | null;
}

/** The write surface's state, read off the shell's 5-second health beat. */
function writeState(live: Live): { available: boolean; reason: string | null } {
  const w = live.health?.write;
  if (w === undefined) {
    // Before the first beat lands, assume UNAVAILABLE. The other direction
    // would render live DELETE buttons against a surface whose state is
    // unknown, which is the wrong way to be wrong.
    return { available: false, reason: "waiting for the first /api/health beat" };
  }
  return { available: w.available, reason: w.reason };
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

function SuggestionsTab({ live, search, project }: TabProps) {
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);

  const brainLevel = project === BRAIN_LEVEL_SCOPE;

  const list = useLayerList<SuggestionsPayload>({
    fetch: ({ limit, offset, values }, signal) => {
      const q = new URLSearchParams();
      // THREE states on one axis, and only one of them is ever sent (TD-326).
      // `brain-level` rides its OWN param: `project` accepts any string
      // server-side, so a magic slug there would be indistinguishable from a
      // typo'd project on every other endpoint.
      if (brainLevel) q.set("project_scope", BRAIN_LEVEL_PARAM);
      else if (project !== null) q.set("project", project);
      for (const [k, v] of Object.entries(values)) if (v.length > 0) q.set(k, v);
      q.set("limit", String(limit));
      q.set("offset", String(offset));
      return api.suggestions(q, signal);
    },
    deps: [project],
    tick: live.tick,
    // The queue opens on what is still OUTSTANDING. `dismissed`/`acted` rows
    // are reachable through the filter, but a triage surface that opened on
    // 1,188 rows of history would bury the 407 that need a decision.
    initial: { status: "pending" },
  });

  const payload = list.payload;
  const items = payload?.items ?? [];
  const rows = muteRows(items, search, (r) => [
    r.id,
    r.title,
    r.source_module,
    r.project_slug,
  ]);
  const triageRows: TriageRow[] = rows.map((r) => ({ id: r.id }));

  const mutation = useTriage(() => live.refresh());

  // Confine the selection to what is actually on screen after every re-read.
  // See `model.ts#confineToVisible` — this is a safety rule, not tidiness.
  useEffect(() => {
    setSelection((cur) => confineToVisible(cur, triageRows));
    // The row identity set is what matters, not the array's identity.
  }, [rows.map((r) => r.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const write = writeState(live);
  const facets = payload?.facets.source_module ?? {};

  // FR-246 — `q` rides the SAME `values` bag the chip filters use, so the
  // fetch above already forwards it (`for (const [k, v] of …values)`) and
  // `useLayerList` already resets the page offset when it changes. No new
  // state machine; that is D4's whole argument for making `q` a filter.
  const qFilter = useQFilter({
    applied: list.values.q ?? "",
    onApply: (next) => list.setFilter("q", next),
  });

  return (
    <>
      <BulkBar
        actions={TAB_ACTIONS.suggestions}
        selection={selection}
        rows={triageRows}
        onSelectAll={() => setSelection((cur) => selectAll(cur, triageRows))}
        onClear={() => setSelection(EMPTY_SELECTION)}
        busy={mutation.busy}
        writeAvailable={write.available}
        writeReason={write.reason}
        readout={
          mutation.error !== null
            ? `REQUEST FAILED — ${mutation.error}. Re-read the list before assuming nothing landed.`
            : mutation.summary !== null && mutation.lastAction !== null
              ? summaryLine(mutation.lastAction, mutation.summary)
              : null
        }
        failures={mutation.summary?.failures ?? []}
        onApply={(action, ids, extra) => {
          setSelection(EMPTY_SELECTION);
          void mutation.apply(action, ids, extra);
        }}
      />

      <RecordList
        eye="// TRIAGE · SUGGESTIONS"
        heading="SUGGESTION QUEUE"
        lede="The subconscious files these. Dismiss WITH A REASON — the reason feeds the suppression loop that stops the backlog re-growing."
        loading={list.loading}
        banners={
          <>
            {(payload?.degraded?.reason ?? list.error) != null && (
              <div className="shell-banner" role="status">
                SUGGESTIONS DEGRADED — {payload?.degraded?.reason ?? list.error}
              </div>
            )}
            {project === null && payload !== null && (
              // The all-projects warning, with the NUMBER before the rows. D5.
              <div className="shell-banner" role="status">
                ALL PROJECTS — {payload.total} suggestions match across every
                registered project. Bulk actions here span all of them; scope to
                one project above before clearing a cohort.
              </div>
            )}
            {/*
              TD-326. While scoped to a PROJECT, the project-less population is
              unreachable and was also unmentioned — the whole defect. State the
              count and name the chip that reaches it. `data-brain-level` is the
              machine-readable form the browser gate reads.
            */}
            {!brainLevel && project !== null && payload !== null &&
              payload.facets.brain_level > 0 && (
                <div
                  className="shell-banner"
                  role="status"
                  data-brain-level={payload.facets.brain_level}
                >
                  BRAIN-LEVEL — {payload.facets.brain_level} further suggestions
                  match these filters but belong to NO project, so this scope can
                  never list them. They are the brain's own (synapse files edge
                  inferences against the graph, not against a project). Click{" "}
                  <b>{BRAIN_LEVEL_SCOPE}</b> above to work them as their own
                  population.
                </div>
              )}
            {/* `> 0` mirrors the scoped banner's guard. Without it the page
                renders "BRAIN-LEVEL — 0 suggestions that belong to no project",
                a banner announcing an empty set. Unreachable in the fixtures
                because the non-empty guards hold, and unreachable on the real
                brain today (377 rows) — but a banner whose own count is zero is
                noise, and the asymmetry with the scoped branch was accidental. */}
            {brainLevel && payload !== null && payload.total > 0 && (
              <div
                className="shell-banner"
                role="status"
                data-brain-level={payload.total}
              >
                BRAIN-LEVEL — {payload.total} suggestions that belong to no
                project. This is NOT every project: it is the complement of all
                of them, so a bulk action here cannot reach a row owned by any
                project.
              </div>
            )}
            {payload != null && payload.params.length > 0 && (
              <div className="shell-banner" role="status">
                REQUEST ADJUSTED — {payload.params.join(" · ")}
              </div>
            )}
            <SearchReadout substring={payload?.search} />
          </>
        }
        filters={{
          search: qFilter,
          controls: [
            {
              name: "status",
              label: "status",
              options: ["pending", "dismissed", "acted"],
              value: list.values.status ?? "",
            },
            {
              name: "priority",
              label: "priority",
              options: ["high", "medium", "low"],
              value: list.values.priority ?? "",
            },
            {
              name: "source_module",
              label: "module",
              // COUNTED FROM THE DATA, never hand-listed: `source_module` has
              // been an OPEN vocabulary since FR-118 M2 (the LLM names the
              // kind), so an enumerated dropdown hides rows (L-967).
              options: Object.keys(facets),
              value: list.values.source_module ?? "",
            },
          ],
          onChange: list.setFilter,
          onClearAll: list.clearFilters,
          readout:
            search.trim().length > 0
              ? `MUTED ${rows.length}/${items.length} THIS PAGE`
              : undefined,
        }}
        rows={rows.map((row) => toListRow(row, selection, setSelection))}
        page={
          payload !== null
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
          layer: "suggestions",
          total: payload?.total ?? 0,
          degraded: payload?.degraded?.reason ?? list.error,
          filtersActive: (list.values.status ?? "pending") !== "pending" ||
            (list.values.priority ?? "").length > 0 ||
            (list.values.source_module ?? "").length > 0,
          searchActive: search.trim().length > 0,
          project,
        })}
      />
    </>
  );
}

function toListRow(
  row: SuggestionRow,
  selection: Selection,
  setSelection: (fn: (cur: Selection) => Selection) => void,
): RecordListRow {
  return {
    key: String(row.id),
    eye: `// ${row.id} · ${row.source_module}`,
    title: row.title,
    trail: row.suggested_action,
    // NO `href`: there is no suggestion detail route. The row is a selection
    // target, not a link, and `RecordList` renders a button for that case.
    badges: (
      <>
        <Badge variant={row.priority === "high" ? "alarm" : "muted"}>
          {row.priority}
        </Badge>
        {row.status !== "pending" && <Badge variant="muted">{row.status}</Badge>}
      </>
    ),
    meta: [
      { k: "project", v: row.project_slug ?? "—" },
      { k: "created", v: row.created_at },
      {
        k: "confidence",
        v: row.confidence === null ? "—" : row.confidence.toFixed(2),
      },
    ],
    select: {
      checked: selection.has(row.id),
      onToggle: () => setSelection((cur) => toggleSelected(cur, row.id)),
      label: `select suggestion ${row.id}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Candidates (pending_review learnings)
// ---------------------------------------------------------------------------

function CandidatesTab({ live, search, project }: TabProps) {
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);

  const list = useLayerList<LearningsPayload>({
    // ZERO NEW ENDPOINTS. FR-240 shipped both halves and pre-reserved this use:
    // `memory-read.ts:228-230` says in words that the perception-review surface
    // fetches pending rows by id for the approval UI.
    fetch: ({ limit, offset, values }, signal) => {
      const q = new URLSearchParams();
      if (project !== null) q.set("project", project);
      q.set("review_status", "pending_review");
      // FR-246 — a FILTER, not a search, and deliberately so. BR-085 has since
      // made recall's review gate a parameter, so "recall cannot reach pending
      // rows" is no longer the reason and is not asserted here. The reason is
      // that a QUEUE and a RECALL answer different questions: this tab must
      // show every candidate, in a stable order, with an honest `total` and
      // continuous pages, which is what the substring filter preserves. Ranked
      // recall returns one fused page with no stable offset semantics — the
      // right tool for FINDING a candidate (the Learnings lens offers it), the
      // wrong one for CLEARING a queue.
      const text = values.q ?? "";
      if (text.length > 0) q.set("q", text);
      q.set("limit", String(limit));
      q.set("offset", String(offset));
      return api.learnings(q, signal);
    },
    deps: [project],
    tick: live.tick,
  });

  const payload = list.payload;
  const items = payload?.items ?? [];
  const rows = muteRows(items, search, (r) => [r.id, r.title, r.category, r.tags]);
  // `seen_again_count` IS the destructiveness discriminator. It rides the wire
  // from `listLearnings`' projection precisely so this line can exist.
  const triageRows: TriageRow[] = rows.map((r) => ({
    id: r.id,
    seen_again_count: r.seen_again_count,
  }));

  const mutation = useTriage(() => live.refresh());

  useEffect(() => {
    setSelection((cur) => confineToVisible(cur, triageRows));
  }, [rows.map((r) => r.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const write = writeState(live);
  const hardCount = triageRows.filter(
    (r) => (r.seen_again_count ?? 0) === 0,
  ).length;

  const qFilter = useQFilter({
    applied: list.values.q ?? "",
    onApply: (next) => list.setFilter("q", next),
  });

  return (
    <>
      <BulkBar
        actions={TAB_ACTIONS.candidates}
        selection={selection}
        rows={triageRows}
        onSelectAll={() => setSelection((cur) => selectAll(cur, triageRows))}
        onClear={() => setSelection(EMPTY_SELECTION)}
        busy={mutation.busy}
        writeAvailable={write.available}
        writeReason={write.reason}
        readout={
          mutation.error !== null
            ? `REQUEST FAILED — ${mutation.error}. Re-read the list before assuming nothing landed.`
            : mutation.summary !== null && mutation.lastAction !== null
              ? summaryLine(mutation.lastAction, mutation.summary)
              : null
        }
        failures={mutation.summary?.failures ?? []}
        onApply={(action, ids, extra) => {
          setSelection(EMPTY_SELECTION);
          void mutation.apply(action, ids, extra);
        }}
      />

      <RecordList
        eye="// TRIAGE · CANDIDATES"
        heading="PENDING REVIEW"
        lede="Perception files these. Approving one admits it to the model's conscious channel (FR-109)."
        loading={list.loading}
        banners={
          <>
            {(payload?.degraded?.reason ?? list.error) != null && (
              <div className="shell-banner" role="status">
                CANDIDATES DEGRADED — {payload?.degraded?.reason ?? list.error}
              </div>
            )}
            {/*
              The TTL divergence — bannered, not discovered. See the file header.
            */}
            <div className="shell-banner" role="status">
              NO TTL WINDOW — this list is unfiltered by
              `pending_review_ttl_days`, so it shows MORE than
              `igris_perception_review_pending`, including expired candidates
              `igris_perception_expire_stale` has not reaped. That is deliberate
              for a backlog-clearing surface: hiding rows you must triage is the
              bug.
            </div>
            {hardCount > 0 && (
              // The tier-3 population, stated BEFORE any dialog opens, so the
              // hard-delete risk is visible while choosing rows rather than
              // only at the moment of confirming.
              <div className="shell-banner" role="status">
                {hardCount} of {rows.length} rows on this page have never
                recurred (`seen_again_count = 0`). Rejecting one of those is a
                PERMANENT delete, not a soft one.
              </div>
            )}
            {project === null && payload !== null && (
              <div className="shell-banner" role="status">
                ALL PROJECTS — {payload.total} candidates await review across
                every registered project. Scope above before bulk-acting.
              </div>
            )}
            <SearchReadout substring={payload?.search} />
          </>
        }
        filters={{
          controls: [],
          search: qFilter,
          onChange: list.setFilter,
          onClearAll: list.clearFilters,
        }}
        rows={rows.map((row) => toCandidateRow(row, selection, setSelection))}
        page={
          payload !== null
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
          layer: "candidates",
          total: payload?.total ?? 0,
          degraded: payload?.degraded?.reason ?? list.error,
          // A submitted `q` IS a narrowing: "no candidates" must not read as
          // "the queue is clear" when it means "nothing matched that word".
          filtersActive: (list.values.q ?? "").length > 0,
          searchActive: search.trim().length > 0,
          project,
        })}
      />
    </>
  );
}

function toCandidateRow(
  row: LearningListRow,
  selection: Selection,
  setSelection: (fn: (cur: Selection) => Selection) => void,
): RecordListRow {
  const recurring = (row.seen_again_count ?? 0) > 0;
  return {
    key: String(row.id),
    eye: `// ${row.id} · ${row.category}`,
    title: row.title,
    // The record itself stays readable through the FR-240 layer view; this row
    // is a triage target. The address is built by the MODEL (`recordHash`), not
    // interpolated here — BR-078's `(project, id)` pairing has exactly one
    // definition and one round-trip test, and `dashboard-layers-source.test.ts`
    // fails any file that builds the hash inline.
    href: recordHash({ layer: "learnings", project: row.project, id: String(row.id) }),
    badges: (
      <>
        <Badge variant="muted">{row.provenance}</Badge>
        {/*
          THE TIER, ON THE ROW. An operator selecting rows needs to know which
          ones a reject would destroy BEFORE opening the dialog — the dialog
          reports the aggregate, and an aggregate cannot tell you which row to
          untick.
        */}
        {recurring ? (
          <Badge variant="muted">recurring ×{row.seen_again_count}</Badge>
        ) : (
          <Badge variant="alarm">reject = PERMANENT</Badge>
        )}
        {row.deleted_at !== null && <Badge variant="muted">soft-deleted</Badge>}
      </>
    ),
    meta: [
      { k: "project", v: row.project },
      { k: "confidence", v: row.confidence.toFixed(2) },
      { k: "extractor", v: row.source_extractor },
      { k: "created", v: row.created_at },
    ],
    select: {
      checked: selection.has(row.id),
      onToggle: () => setSelection((cur) => toggleSelected(cur, row.id)),
      label: `select candidate ${row.id}`,
    },
  };
}
