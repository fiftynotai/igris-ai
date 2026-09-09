/**
 * FR-240 — the ONE filter control strip, shared by every layer (AC #5).
 *
 * Composed from the PORTED primitives (`Chip`, `Input`, `Button`) — no new
 * control vocabulary. A layer that needs a different filter supplies a
 * different `controls` array; it does not fork this file.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY CHIPS AND NOT `<select>`
 * ─────────────────────────────────────────────────────────────────────────
 * `Overview.tsx` already established the chip radiogroup for project scope, and
 * `GraphControls` uses it for type filters. A third idiom for the same job
 * would make the dashboard look assembled rather than designed. Chips also make
 * the CURRENT filter state readable without opening anything, which matters on
 * a lens whose whole job is telling you what state your work is in.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CLICKING THE ACTIVE CHIP CLEARS IT
 * ─────────────────────────────────────────────────────────────────────────
 * There is no "ALL" chip. A radiogroup with an explicit ALL option means every
 * filter row carries a control whose meaning is "no control", and it puts the
 * cleared state one row further from the eye. Re-clicking the active value is
 * the clear — announced through `aria-pressed`, which the ported `Chip` already
 * emits.
 *
 * READ-ONLY (AC #7): every control here narrows a READ. Nothing in this file
 * can write; FR-241 owns the write path, including the review triage that the
 * `review_status` filter deliberately only READS (D9).
 */

import { Chip } from "../ui/Chip";
import { Input } from "../ui/Input";

/** One filter: its param name, its label, its options and its current value. */
export interface FilterControl {
  name: string;
  label: string;
  /** The values on offer. An empty array renders nothing — not an empty row. */
  options: readonly string[];
  /** The selected value. `""` means "not filtering". */
  value: string;
}

/** The optional search box at the head of the bar. */
export interface FilterSearch {
  /** Visible label, e.g. `hybrid recall`. */
  label: string;
  value: string;
  placeholder?: string;
  onChange: (next: string) => void;
  /** Enter, or the RUN button. Absent means the input filters as you type. */
  onSubmit?: () => void;
  onClear?: () => void;
  busy?: boolean;
  /** One line under the box — what this search actually does. */
  help?: string;
}

export interface FilterBarProps {
  controls: readonly FilterControl[];
  onChange: (name: string, value: string) => void;
  search?: FilterSearch;
  /** Mono readout, right-aligned: the page window, the mute count. */
  readout?: string;
  /** Clears every control at once. Rendered only when something is set. */
  onClearAll?: () => void;
}

export function FilterBar({
  controls,
  onChange,
  search,
  readout,
  onClearAll,
}: FilterBarProps) {
  const anySet = controls.some((c) => c.value.length > 0);
  const visible = controls.filter((c) => c.options.length > 0);

  return (
    <div className="record-filters">
      {search !== undefined && (
        <form
          className="record-search"
          onSubmit={(e) => {
            // A form so Enter submits — and `preventDefault` so it never
            // navigates. There is no form ACTION anywhere in this app.
            e.preventDefault();
            search.onSubmit?.();
          }}
        >
          <Input
            label={search.label}
            value={search.value}
            placeholder={search.placeholder}
            onChange={(e) => search.onChange(e.target.value)}
            help={search.help}
            // `search` rather than `text`: the browser offers a clear affordance
            // and announces the role.
            type="search"
            inputMode="search"
          />
          {search.onSubmit !== undefined && (
            <button
              type="submit"
              className="record-filter-run"
              disabled={search.busy === true || search.value.trim().length === 0}
            >
              {search.busy === true ? "…" : "RUN"}
            </button>
          )}
          {search.onClear !== undefined && search.value.length > 0 && (
            <button
              type="button"
              className="record-filter-run"
              onClick={search.onClear}
            >
              CLEAR
            </button>
          )}
        </form>
      )}

      {visible.map((control) => (
        <div key={control.name} className="record-filter">
          <span className="record-filter-label">{control.label}</span>
          <div
            className="tweaks-chips"
            role="radiogroup"
            aria-label={control.label}
          >
            {control.options.map((option) => {
              const active = control.value === option;
              return (
                <Chip
                  key={option}
                  variant="tweak"
                  role="radio"
                  active={active}
                  // Re-clicking the active chip clears the filter. See header.
                  onClick={() => onChange(control.name, active ? "" : option)}
                >
                  {option}
                </Chip>
              );
            })}
          </div>
        </div>
      ))}

      <span className="record-filters-spacer" />

      {readout !== undefined && (
        <span className="record-readout">{readout}</span>
      )}

      {anySet && onClearAll !== undefined && (
        <button type="button" className="record-filter-run" onClick={onClearAll}>
          CLEAR FILTERS
        </button>
      )}
    </div>
  );
}
