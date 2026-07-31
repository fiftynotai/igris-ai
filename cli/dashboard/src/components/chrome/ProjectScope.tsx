/**
 * FR-241 — the project-scope chip strip, lifted out of `pages/Layers.tsx`.
 *
 * The markup is BYTE-IDENTICAL to what `Layers.tsx` rendered, deliberately: the
 * FR-240 browser gate reads this control by
 * `[role=radiogroup][aria-label="Project scope"]` and asserts the checked
 * chip's text (`browser-gate.mjs#activeProject`). An extraction that "tidied"
 * the aria-label would have silently disarmed G-BR-2a.
 *
 * Re-clicking the active chip clears the scope to "every project" — the same
 * clear-by-reclick rule `FilterBar` uses, because this IS a filter and behaving
 * differently from the other filters would be a trap.
 */

import { Chip } from "../ui/Chip";
import type { ProjectScope as Scope } from "../../lib/useProjectScope";

export function ProjectScope({ scope }: { scope: Scope }) {
  const list = scope.projects?.projects ?? [];
  if (list.length === 0) return null;
  return (
    <div
      className="tweaks-chips"
      role="radiogroup"
      aria-label="Project scope"
      style={{ marginBottom: 24 }}
    >
      {list.map((p) => (
        <Chip
          key={p.slug}
          variant="tweak"
          role="radio"
          active={p.slug === scope.project}
          onClick={() => scope.choose(p.slug)}
        >
          {p.slug}
        </Chip>
      ))}
    </div>
  );
}
