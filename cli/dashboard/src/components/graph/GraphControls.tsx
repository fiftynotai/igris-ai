/**
 * FR-239 — the chrome around the canvas: scope breadcrumb, type filters,
 * REFRESH, and the tier readout.
 *
 * TWO OBLIGATIONS MEET HERE.
 *
 * 1. **dataviz.md §04's Tier C requirement:** *"A Tier C canvas must also ship
 *    a real, tap-target-compliant search or filter control in the surrounding
 *    chrome. Pointing at a specific node is never the only way to reach it."*
 *    The search box lives in the nav's reserved slot; these are the filters.
 *    Every control here is >= 44x44 (coding-guideline Rule 2.4), enforced by
 *    `.graph-control` in `base.css` rather than by per-component styling.
 *
 * 2. **D6 — filtering and drilling are DIFFERENT OPERATIONS**, and the chrome
 *    has to make that legible. A type filter is a client-side MUTE over the
 *    payload already in memory (`// QUICK`); a project drill is a real scope
 *    change that refetches and pulls boundary nodes (`// SLOW`). They are
 *    separated visually and commented as such, because collapsing them is the
 *    single most likely source of a wrong mental model here.
 */

import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";

export interface GraphControlsProps {
  /** `null` = the whole brain. Otherwise the drilled project slug. */
  scope: string | null;
  /** Known project slugs, for the drill menu. */
  projects: readonly string[];
  /** Entity types present in the CURRENT result set, with counts. */
  types: ReadonlyArray<{ type: string; count: number }>;
  active: ReadonlySet<string>;
  onToggleType: (type: string) => void;
  /** SLOW — a real scope change (D6). */
  onDrill: (project: string | null) => void;
  onRefresh: () => void;
  /**
   * Recentre and refit the camera.
   *
   * Exposed as a real control rather than left dangling: with the canvas paused
   * at rest, a pan that carries the graph off-screen has no other recovery.
   */
  onFit: () => void;
  /** `null` when no filter is active. */
  matchCount: number | null;
  tier: "A" | "B" | "C";
  nodeCount: number;
  edgeCount: number;
  busy: boolean;
}

export function GraphControls({
  scope,
  projects,
  types,
  active,
  onToggleType,
  onDrill,
  onRefresh,
  onFit,
  matchCount,
  tier,
  nodeCount,
  edgeCount,
  busy,
}: GraphControlsProps) {
  return (
    <div className="graph-controls">
      {/* ---- SCOPE. A drill is a server refetch, never a client filter. ---- */}
      <nav className="graph-crumbs" aria-label="Graph scope">
        <button
          type="button"
          className="graph-control graph-crumb"
          aria-current={scope === null ? "page" : undefined}
          onClick={() => onDrill(null)}
          disabled={busy}
        >
          WHOLE BRAIN
        </button>
        {scope !== null && (
          <>
            <span className="graph-crumb-sep" aria-hidden>
              /
            </span>
            <span className="graph-control graph-crumb" aria-current="page">
              {scope}
            </span>
          </>
        )}
      </nav>

      <label className="graph-control graph-drill">
        <span className="graph-control-eye">// DRILL</span>
        <select
          value={scope ?? ""}
          disabled={busy}
          onChange={(e) => onDrill(e.target.value === "" ? null : e.target.value)}
          aria-label="Drill into a project"
        >
          <option value="">whole brain</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>

      <span className="graph-controls-spacer" />

      {/* ---- FILTER. Client-side muting over the payload already in memory. */}
      <div
        className="graph-types"
        role="group"
        aria-label="Filter by entity type"
      >
        {types.map(({ type, count }) => (
          <Chip
            key={type}
            variant="tweak"
            className="graph-control"
            active={active.has(type)}
            onClick={() => onToggleType(type)}
          >
            {type} {count}
          </Chip>
        ))}
      </div>

      <span className="graph-readout" aria-live="polite">
        TIER {tier} · {nodeCount.toLocaleString("en-US")} NODES ·{" "}
        {edgeCount.toLocaleString("en-US")} EDGES
        {matchCount !== null && ` · ${matchCount.toLocaleString("en-US")} MATCH`}
      </span>

      {/*
        REFRESH is the ONLY way this surface re-reads the brain (D8). The 5 s
        `live.tick` every other page polls on is deliberately not wired here:
        it would re-run the builder and re-run the force simulation on a timer,
        which is ambient motion dressed as freshness.
      */}
      <Button className="graph-control" variant="ghost" onClick={onFit}>
        FIT
      </Button>

      <Button
        className="graph-control"
        variant="secondary"
        onClick={onRefresh}
        disabled={busy}
      >
        {busy ? "READING…" : "REFRESH"}
      </Button>
    </div>
  );
}
