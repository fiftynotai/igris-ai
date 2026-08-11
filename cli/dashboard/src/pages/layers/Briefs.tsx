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
  type BriefRef,
  type BriefsPayload,
  type BriefsSearchPayload,
  type GoalListRowPayload,
} from "../../lib/api";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import {
  CANONICAL_PRIORITIES,
  EMPTY_KEY_SELECTION,
  briefWriteCopy,
  confineToKeys,
  outcomeLabel,
  plural,
  priorityChoices,
  refKey,
  selectAllKeys,
  summaryLine,
  toggleSelected,
  type BriefWriteAction,
  type Selection,
  type TriageItemOutcome,
} from "../../triage/model";
import { useTriage } from "../../triage/useTriage";
import { RecordList, type RecordListRow } from "../../components/record/RecordList";
import { RecordBoard } from "../../components/record/RecordBoard";
import {
  RecordDetail,
  RecordNeighbours,
} from "../../components/record/RecordDetail";
import { Markdown } from "../../markdown/Markdown";
import {
  FILTERS,
  briefsSearchQuery,
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
import { SearchReadout } from "../../components/record/SearchReadout";
import type { LayerViewProps } from "../Layers";

const LAYER = "briefs" as const;

/** One ranked page. RRF over two arms has no stable offset semantics. */
const SEARCH_LIMIT = 20;

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
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FR-247 — `affordance` IS A PARAMETER, AND THAT IS THE WHOLE GUARD
 * ─────────────────────────────────────────────────────────────────────────
 * Because this mapper is shared, giving it an unconditional `select` would put
 * checkboxes and a write path on BOARD CARDS as well as list rows. The board's
 * read-only claim is asserted (`browser-gate.mjs` G-BR-12f scopes `draggable` /
 * `ondragstart` / `ondrop` / `form` and a non-GET counter to `.record-board`),
 * and `status` is the canonical build-state source — so a write affordance
 * leaking onto the status board is a write path INTO TD-311's invariant wearing
 * a convenience.
 *
 * So the LIST supplies the builder and the BOARD does not. It is a parameter
 * rather than a flag because a boolean would still have to be threaded through
 * the board's call site, where the honest value is "nothing at all".
 * `br14-affordance-on-board` injects the leak to prove G-BR-14c can fire.
 */
function briefRow(
  row: BriefListRow,
  affordance?: (row: BriefListRow) => RecordListRow["select"],
): RecordListRow {
  return {
    key: `${row.project}|${row.brief_id}`,
    ...(affordance !== undefined ? { select: affordance(row) } : {}),
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
// FR-247 — the two brief writes (LIST ONLY; see `briefRow`'s header)
// ---------------------------------------------------------------------------

/**
 * The write surface's state, read off the shell's 5-second health beat.
 *
 * The same rule and the same wrong-way-to-be-wrong as `Triage.tsx#writeState`:
 * before the first beat lands, assume UNAVAILABLE. Rendering live write
 * controls against a surface whose state is unknown is the failure; a bar that
 * appears 5 seconds late is not.
 *
 * A THIRD copy of this would be a smell, but the second is deliberate: lifting
 * it into `lib/` would put a triage concern in the shared tier for two call
 * sites, and `BRIEF_WRITE_ACTIONS` below is the thing that keeps the two
 * surfaces' vocabularies apart.
 */
function briefWriteState(live: LayerViewProps["live"]): {
  available: boolean;
  reason: string | null;
} {
  const w = live.health?.write;
  if (w === undefined) {
    return { available: false, reason: "waiting for the first /api/health beat" };
  }
  // NOT also checked here: whether `w.actions` contains this surface's two
  // action names. `/api/health` serves the frozen map's keys and the client
  // mirrors the same map from the same installed package, so the two can only
  // disagree if the server is older than the client it is serving — which a
  // single-package install makes unreachable. A check for it would be a claim
  // about a state that cannot exist, paid for in chunk bytes.
  return { available: w.available, reason: w.reason };
}

/**
 * The selection bar for the briefs LIST: set priority, attach to a goal.
 *
 * Deliberately NOT `components/triage/BulkBar.tsx`. That component's whole
 * subject is the DELETE tiering — `destructiveness`, the hard-delete sentence,
 * the typed confirmation — and neither write here can delete anything. Reusing
 * it would mean rendering "there is no un-set_priority tool" in the register
 * reserved for permanent deletion, which is how an irreversible warning stops
 * being read. The copy comes from `model.ts#briefWriteCopy` for the same reason
 * `BulkBar`'s comes from `confirmCopy`: the sentence the operator is shown is a
 * pure function a unit test can pin.
 */
function BriefWriteBar({
  selection,
  rows,
  goals,
  goalsError,
  onSelectAll,
  onClear,
  onApply,
  onCreateGoal,
  scope,
  busy,
  writeAvailable,
  writeReason,
  readout,
  failures,
}: {
  selection: Selection<string>;
  rows: readonly BriefListRow[];
  goals: readonly { goal_id: string; title: string }[];
  goalsError: string | null;
  onSelectAll: () => void;
  onClear: () => void;
  /**
   * FR-249 — create a goal and hand back its id, or `null` if it failed.
   * The PARENT owns the request and the goal-list re-read; this bar owns the
   * selection, because the whole point of the id coming back is that the
   * picker below is already pointing at it when the operator reaches for ATTACH.
   */
  onCreateGoal: (title: string, outcome: string) => Promise<string | null>;
  /** The shell's project scope, or `null` for all projects. Rendered, not guessed. */
  scope: string | null;
  onApply: (
    action: BriefWriteAction,
    refs: BriefRef[],
    extra: { priority?: string; goalId?: string },
  ) => void;
  busy: boolean;
  writeAvailable: boolean;
  writeReason: string | null;
  readout: string | null;
  failures: readonly TriageItemOutcome[];
}) {
  const [pending, setPending] = useState<BriefWriteAction | null>(null);
  const [priority, setPriority] = useState<string>(CANONICAL_PRIORITIES[0]);
  const [goalId, setGoalId] = useState<string>("");
  // FR-249 — the create form. `open` is separate from the two fields so the bar
  // stays one line until an operator asks for it: the common case is attaching
  // to a goal that already exists, and a permanently-expanded form would put
  // two text inputs above the list on every visit.
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newOutcome, setNewOutcome] = useState("");

  const chosen = rows.filter((r) => selection.has(refKey(r)));
  const count = chosen.length;

  // Close the dialog if the selection empties underneath it — the list refetches
  // on the 5-second beat and a dialog whose subject no longer exists is how you
  // write to the wrong batch.
  useEffect(() => {
    if (count === 0) setPending(null);
  }, [count]);

  if (!writeAvailable) {
    // DISABLED, NOT BROKEN — and the affordances DISAPPEAR rather than grey out
    // (AC-7). A button that will certainly fail is worse than no button.
    return (
      <div className="shell-banner" role="status">
        BRIEF WRITES DISABLED — {writeReason ?? "no reason reported"}
      </div>
    );
  }

  /*
   * The picker's CURRENT value: the selection's priority when they agree, else
   * `null`. Only a unanimous selection can surface a non-canonical current
   * value as the disabled `not offerable` entry — with a mixed selection there
   * is no single current value to show, and inventing one would be a claim
   * about rows the operator can see are different.
   */
  const currents = [...new Set(chosen.map((r) => r.priority ?? ""))];
  const current = currents.length === 1 ? (currents[0] ?? "") : null;
  const choices = priorityChoices(current === null || current === "" ? null : current);

  const goal = goals.find((g) => g.goal_id === goalId) ?? null;
  const copy =
    pending === null
      ? null
      : briefWriteCopy(
          pending,
          count,
          pending === "set_priority"
            ? priority
            : goal === null
              ? goalId
              : `${goal.goal_id} — ${goal.title}`,
        );

  const refs = (): BriefRef[] =>
    chosen.map((r) => ({ project: r.project, brief_id: r.brief_id }));

  return (
    <>
      <div className="triage-bulk brief-write" data-selected={count}>
        <span className="record-readout">{plural(count, "brief")} selected</span>
        <button type="button" className="record-filter-run" onClick={onSelectAll}>
          SELECT PAGE
        </button>
        <button
          type="button"
          className="record-filter-run"
          onClick={onClear}
          disabled={count === 0}
        >
          CLEAR
        </button>
        <span className="record-filters-spacer" />

        <label className="brief-write-field">
          <span className="record-readout">priority</span>
          <select
            className="brief-write-select"
            value={priority}
            aria-label="Priority to assign"
            onChange={(e) => setPriority(e.target.value)}
          >
            {choices.map((c) => (
              // A non-canonical CURRENT value is rendered and DISABLED, so a
              // `P4-Trivial` brief never looks unset. TD-338 owns folding it;
              // this picker refuses to mint a ninth value, and refuses to hide
              // the eight that exist.
              <option key={c.value} value={c.value} disabled={!c.offerable}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          variant="primary"
          disabled={count === 0 || busy}
          onClick={() => setPending("set_priority")}
        >
          SET PRIORITY
        </Button>

        <label className="brief-write-field">
          <span className="record-readout">goal</span>
          <select
            className="brief-write-select"
            value={goalId}
            aria-label="Goal to attach to"
            onChange={(e) => setGoalId(e.target.value)}
          >
            <option value="">— choose —</option>
            {goals.map((g) => (
              <option key={g.goal_id} value={g.goal_id}>
                {g.goal_id} · {g.title}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          variant="secondary"
          // Attachment needs an EXISTING goal — FR-249 put the NEW GOAL control
          // next to it, because that is where an operator is standing when they
          // discover the goal they want does not exist yet.
          disabled={count === 0 || busy || goalId.length === 0}
          onClick={() => setPending("attach_goal")}
        >
          ATTACH TO GOAL
        </Button>
        <Button
          size="sm"
          variant="ghost"
          // NOT gated on the selection: creating a goal has NO subject, so a
          // control disabled by an empty selection would be lying about what it
          // needs. It is gated on `busy` like every other write affordance.
          disabled={busy}
          onClick={() => setCreating((v) => !v)}
        >
          {creating ? "CANCEL NEW GOAL" : "NEW GOAL"}
        </Button>
      </div>

      {creating && (
        // NO <form> ELEMENT, and that is deliberate rather than incidental: the
        // board's read-only claim is asserted by `browser-gate.mjs` G-BR-12f,
        // which scopes `form` (with `draggable`, `ondragstart`, `ondrop` and a
        // non-GET counter) to `.record-board`. This panel lives ABOVE the list
        // and never reaches `briefRow`, so it could carry one — but two raw
        // inputs and a button need nothing a form provides, and the cheapest way
        // to keep a write affordance off the status board is not to build one
        // that could travel there.
        <div className="triage-bulk brief-write" data-create="goal">
          <span className="record-readout">new goal</span>
          <input
            className="brief-write-select brief-write-input"
            value={newTitle}
            aria-label="New goal title"
            placeholder="TITLE"
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <input
            className="brief-write-select brief-write-input"
            value={newOutcome}
            aria-label="New goal outcome"
            placeholder="WHAT SUCCESS LOOKS LIKE"
            onChange={(e) => setNewOutcome(e.target.value)}
          />
          <Button
            size="sm"
            variant="primary"
            disabled={busy || newTitle.trim().length === 0 || newOutcome.trim().length === 0}
            onClick={() => {
              void (async () => {
                const id = await onCreateGoal(newTitle, newOutcome);
                // PRESELECTED, and only on success. The failure is already
                // rendered by the shared readout below, and leaving the fields
                // filled is what lets the operator fix a too-long title rather
                // than retype both.
                if (id === null) return;
                setGoalId(id);
                setNewTitle("");
                setNewOutcome("");
                setCreating(false);
              })();
            }}
          >
            {busy ? "…" : "CREATE"}
          </Button>
          <span className="record-readout">
            {/*
              The two fields the operator did NOT choose. `handleGoalCreate`
              defaults them, and a form that stayed silent would let the
              operator believe they had picked `active` / `P2-Medium`.
            */}
            {scope === null ? "cross-project" : scope} · created active ·
            P2-Medium · attach it below
          </span>
        </div>
      )}

      {goalsError !== null && (
        <div className="shell-banner" role="status">
          GOALS UNAVAILABLE — {goalsError}
        </div>
      )}
      {readout !== null && (
        <p className="record-readout" role="status">
          {readout}
        </p>
      )}
      {failures.length > 0 && (
        <div className="shell-banner" role="status">
          {plural(failures.length, "brief")} failed —{" "}
          {failures
            .slice(0, 5)
            .map((f) => `${outcomeLabel(f)}: ${f.error ?? "no message"}`)
            .join(" · ")}
          {failures.length > 5 ? ` · …and ${failures.length - 5} more` : ""}
        </div>
      )}

      {pending !== null && copy !== null && (
        <div
          className="triage-confirm"
          role="alertdialog"
          aria-modal="true"
          aria-label={copy.title}
          data-action={pending}
          data-hard-delete="0"
        >
          <h2 className="triage-confirm-title">{copy.title}</h2>
          {copy.lines.map((line) => (
            <p key={line} className="triage-confirm-line">
              {line}
            </p>
          ))}
          <div className="triage-confirm-actions">
            <Button variant="ghost" size="sm" onClick={() => setPending(null)} disabled={busy}>
              CANCEL
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || count === 0}
              onClick={() => {
                onApply(
                  pending,
                  refs(),
                  pending === "set_priority" ? { priority } : { goalId },
                );
                setPending(null);
              }}
            >
              {busy ? "…" : copy.confirmLabel}
            </Button>
          </div>
        </div>
      )}
    </>
  );
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

  /**
   * FR-246 — the SUBMITTED recall query. `null` = browse mode.
   *
   * Deliberately NOT a `q` filter like the four substring surfaces: this is
   * genuine hybrid retrieval (BM25 + vector, RRF-fused), it returns ONE ranked
   * page with no offset semantics, and it therefore replaces the browse list
   * rather than narrowing it. The `SearchReadout` says which of the two the
   * operator is looking at.
   *
   * Keyed on the SUBMITTED query, not the draft: an embedding cold-start is
   * seconds long, so search-as-you-type would queue a model load per keystroke.
   */
  const [query, setQuery] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [hits, setHits] = useState<BriefsSearchPayload | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    if (query === null) {
      setHits(null);
      return;
    }
    const ctrl = new AbortController();
    setSearching(true);
    setSearchError(null);
    api
      .briefsSearch(
        briefsSearchQuery({ query, project, limit: SEARCH_LIMIT }),
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
  }, [query, project]);

  /*
   * FR-247 — the write half. Everything below is LIST-ONLY; `BriefBoardView`
   * takes none of it (see `briefRow`'s header for why that separation is the
   * guard rather than a preference).
   */
  const [selection, setSelection] = useState<Selection<string>>(EMPTY_KEY_SELECTION);
  const [goals, setGoals] = useState<GoalListRowPayload[]>([]);
  const [goalsError, setGoalsError] = useState<string | null>(null);
  const mutation = useTriage(() => live.refresh());

  /*
   * The goal list, read ONCE per scope through the EXISTING `/api/goals`.
   *
   * No new endpoint — the whole point of FR-247's shape is that it needed no
   * new path. (It left the surface at sixteen GET + one POST; FR-248 has since
   * taken it to seventeen GET with `/api/search`. The principle is unchanged,
   * the count is not this file's to carry.) Not on the 5-second beat either: there are 6
   * goals on the operator brain and they are hand-created, so re-reading them
   * every tick would be four requests a minute for a list that changes monthly.
   *
   * UNSCOPED on purpose. `goals.project_slug` is nullable and a brief may
   * legitimately serve a brain-level goal, so scoping this to the selected
   * project would silently hide exactly the goals that span projects.
   */
  const loadGoals = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const q = new URLSearchParams();
    q.set("status", "active");
    q.set("limit", "100");
    try {
      const p = await api.goals(q, signal);
      if (signal?.aborted === true) return;
      setGoals(p.items);
      setGoalsError(p.degraded?.reason ?? null);
    } catch (err: unknown) {
      if (signal?.aborted === true) return;
      setGoalsError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void loadGoals(ctrl.signal);
    return () => ctrl.abort();
  }, [loadGoals]);

  const browsing = query === null;
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
  const hitRows = muteRows(hits?.items ?? [], search, (r) => [
    r.brief_id,
    r.title,
    r.status,
    r.brief_type,
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

  const degradedReason = browsing
    ? (payload?.degraded?.reason ?? list.error)
    : (hits?.degraded?.reason ?? searchError);

  /*
   * Confine the selection to what is on screen after every re-read.
   *
   * `model.ts#confineToKeys`' safety property, and this is the surface it was
   * generalised for: the key is `"<project>|<brief_id>"`, so a selection made
   * under one project cannot survive a scope change and then be written to. A
   * search submission replaces the browse list entirely, which is why the
   * SUBMITTED-query mode drops the selection too — the hit rows are a different
   * page, not a narrowing of this one.
   */
  const selectableKeys = browsing ? muted.map((r) => refKey(r)) : [];
  useEffect(() => {
    setSelection((cur) => confineToKeys(cur, selectableKeys));
    // The row identity SET is what matters, not the array's identity.
  }, [selectableKeys.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const write = briefWriteState(live);

  return (
    <>
      {/*
        FR-247 — the write bar rides ABOVE the list and only in browse mode.
        A ranked recall page has no stable offset semantics and its rows are a
        different set; offering a bulk write over it would mean acting on a
        selection whose membership the operator cannot page back to.
      */}
      {browsing && (
        <BriefWriteBar
          selection={selection}
          rows={muted}
          goals={goals}
          goalsError={goalsError}
          onSelectAll={() =>
            setSelection((cur) => selectAllKeys(cur, selectableKeys))
          }
          onClear={() => setSelection(EMPTY_KEY_SELECTION)}
          busy={mutation.busy}
          writeAvailable={write.available}
          writeReason={write.reason}
          readout={
            mutation.error !== null
              ? `REQUEST FAILED — ${mutation.error}. Re-read before assuming nothing landed.`
              : mutation.summary !== null && mutation.lastAction !== null
                ? summaryLine(mutation.lastAction, mutation.summary)
                : null
          }
          failures={mutation.summary?.failures ?? []}
          onApply={(action, refs, extra) => {
            setSelection(EMPTY_KEY_SELECTION);
            void mutation.applyRefs(action, refs, extra);
          }}
          scope={project}
          onCreateGoal={async (title, outcome) => {
            // The SCOPE is supplied here, not typed: a dashboard-created goal
            // belongs to whatever the shell is scoped to, and the all-projects
            // scope is the ABSENCE of a project — which the brain stores as
            // `project_slug NULL` and the goals layer renders as
            // "Cross-project".
            const id = await mutation.create(title, outcome, project);
            // RE-READ BEFORE PRESELECTING. The picker renders `goals`, so
            // selecting an id the list does not yet contain would show an empty
            // control for a goal that exists — the one state the result channel
            // was added to avoid.
            if (id !== null) await loadGoals();
            return id;
          }}
        />
      )}
      <RecordList
      eye={descriptor?.eye ?? "// BRIEFS"}
      heading="BRIEFS"
      actions={actions}
      lede={descriptor?.lede}
      loading={browsing ? list.loading : searching && hits === null}
      banners={
        <>
          {degradedReason != null && (
            <div className="shell-banner" role="status">
              {browsing ? "BRIEFS DEGRADED" : "SEARCH DEGRADED"} — {degradedReason}
            </div>
          )}
          {payload !== undefined && payload !== null && payload.params.length > 0 && (
            // NOT a degraded banner: this says the REQUEST was adjusted, which
            // is a different problem with a different fix.
            <div className="shell-banner" role="status">
              REQUEST ADJUSTED — {payload.params.join(" · ")}
            </div>
          )}
          {!browsing && hits !== null && (
            <SearchReadout retrieval={hits.retrieval} />
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
            ? "BM25 over brief TITLES AND BODIES, fused with vector recall. A first search may load the embedding model."
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
            ? `MUTED ${(browsing ? muted : hitRows).length}/${(browsing ? items.length : (hits?.items.length ?? 0))} THIS PAGE`
            : undefined,
      }}
      rows={
        browsing
          ? muted.map((r) =>
              // The LIST supplies the affordance builder. The BOARD does not,
              // and `br14-affordance-on-board` proves the check for that can
              // fire. Gated on `write.available` so the checkboxes DISAPPEAR
              // with the rest of the write surface (AC-7) rather than offering
              // a selection nothing can act on.
              briefRow(
                r,
                write.available
                  ? (row) => ({
                      checked: selection.has(refKey(row)),
                      onToggle: () =>
                        setSelection((cur) => toggleSelected(cur, refKey(row))),
                      label: `Select ${row.brief_id} in ${row.project}`,
                    })
                  : undefined,
              ),
            )
          : hitRows.map(briefHitRow)
      }
      // Search results are ONE ranked page — RRF over two arms has no stable
      // offset semantics, so a second page would not be the continuation of the
      // first. Browse mode paginates; recall does not.
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
        // read as "this project has no briefs".
        filtersActive: hasActiveFilters(LAYER, list.values) || !browsing,
        searchActive: search.trim().length > 0 && items.length > 0,
        project,
      })}
      />
    </>
  );
}

/**
 * A ranked search hit.
 *
 * Separate from {@link briefRow} because the two carry DIFFERENT facts: a
 * browse row shows the brief's place in the workflow, a hit shows why it is
 * here and which arm found it. Merging them would mean a row that renders
 * `rrf — · bm25 — · vector —` on every browse page.
 */
function briefHitRow(row: BriefsSearchPayload["items"][number]): RecordListRow {
  return {
    key: `${row.project}:${row.brief_id}`,
    eye: `// ${row.brief_id} · ${row.brief_type ?? "untyped"}`,
    title: row.title,
    href: recordHash({ layer: LAYER, project: row.project, id: row.brief_id }),
    badges: (
      <>
        <Badge>{row.status}</Badge>
        {/*
          WHICH ARM FOUND THIS ROW. A hit with a vector rank and NO bm25 rank is
          one the lexical arm could not have produced — the evidence AC-1 asks
          for, shown to the operator rather than only asserted in a test.
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
      { k: "chars", v: String(row.content_length) },
    ],
  };
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
      // ONE argument, always. The board passes NO affordance builder, which is
      // what keeps checkboxes and the priority control off `.record-board`
      // (G-BR-12f's subject). `.map(briefRow)` would hand `Array#map`'s INDEX
      // in as the builder — the compiler refuses it, so this call site cannot
      // regress into the leak by tidying.
    ]).map((r) => briefRow(r)),
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
