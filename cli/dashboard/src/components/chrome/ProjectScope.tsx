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
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TD-326 — `extra`: SCOPES THAT ARE NOT PROJECTS
 * ─────────────────────────────────────────────────────────────────────────
 * `brain-level` (`project_slug IS NULL`) is a real category on the project
 * axis, not an absence: 377 pending suggestions belong to the brain rather than
 * to any project. It renders as a chip in THIS strip rather than as a second
 * control, because the operator has one scope axis and splitting it across two
 * radiogroups would make "which one is active" a two-place question.
 *
 * It is OPT-IN per page, and that is the whole reason it is a prop. The
 * population is per-TABLE: `suggestions.project_slug` is nullable, while
 * `learnings.project` and `brief_status.project` are `NOT NULL` — so a
 * brain-level chip on `Layers` or `Overview` would offer a scope that is empty
 * by construction on every layer those pages show. Only `Triage`'s Suggestions
 * tab passes it.
 *
 * The chips stay in ONE radiogroup with ONE aria-label, so the FR-240 browser
 * gate's `[role=radiogroup][aria-label="Project scope"]` reader and
 * `dashboard-layers-source.test.ts`'s one-renderer scan both still see exactly
 * this file.
 */

import { Chip } from "../ui/Chip";
import type { ProjectScope as Scope } from "../../lib/useProjectScope";

export function ProjectScope({
  scope,
  extra = [],
}: {
  scope: Scope;
  /** Non-project scope values, rendered after the projects. TD-326. */
  extra?: readonly string[];
}) {
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
      {extra.map((value) => (
        <Chip
          key={value}
          variant="tweak"
          role="radio"
          active={value === scope.project}
          onClick={() => scope.choose(value)}
        >
          {value}
        </Chip>
      ))}
    </div>
  );
}
