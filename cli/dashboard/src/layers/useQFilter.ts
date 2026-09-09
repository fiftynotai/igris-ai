/**
 * FR-246 — the `q` substring filter's control, in ONE place.
 *
 * Four surfaces (goals, context docs, suggestions, candidates) gained a text
 * filter. Each of them already had a filter bar with a `search` slot, so this
 * hook exists to stop four copies of the same six lines of draft-state
 * bookkeeping from drifting apart — not to introduce a new control.
 *
 * WHY IT SUBMITS RATHER THAN FILTERING AS YOU TYPE. `FilterBar` supports both
 * (omit `onSubmit` and the box filters live), and live filtering here would
 * mean one HTTP round-trip and one `LIKE '%…%'` table scan PER KEYSTROKE.
 * Explicit submit also gives the browser gate something to drive
 * deterministically: `G-BR-13c` compares the rendered count before and after a
 * submitted query, which is only a comparison if there is a discrete moment
 * when the query is applied.
 *
 * The `applied` value is the one the SERVER was asked for. Syncing the draft
 * back to it on change is what makes CLEAR FILTERS (which resets the filter
 * values) also empty the box — without it the box would keep showing a query
 * that is no longer in effect, which is the same class of lie as a stale
 * readout.
 */

import { useEffect, useState } from "react";
import type { FilterSearch } from "../components/record/FilterBar";

/** One line under the box. Says FILTER, and says what it is not. */
export const Q_HELP =
  "Literal substring match, server-side. Not recall — a synonym will not match.";

export function useQFilter(opts: {
  /** The `q` currently in effect, i.e. what the last request actually sent. */
  applied: string;
  onApply: (next: string) => void;
  help?: string;
}): FilterSearch {
  const [draft, setDraft] = useState(opts.applied);

  useEffect(() => {
    setDraft(opts.applied);
  }, [opts.applied]);

  return {
    label: "text filter",
    value: draft,
    placeholder: "FILTER BY TEXT",
    help: opts.help ?? Q_HELP,
    onChange: setDraft,
    onSubmit: () => opts.onApply(draft.trim()),
    onClear: () => {
      setDraft("");
      opts.onApply("");
    },
  };
}
