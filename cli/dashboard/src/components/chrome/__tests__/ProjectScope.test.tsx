/**
 * TD-326 — **the scope control's `extra` chips, RENDERED.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT NEEDS ITS OWN GATE
 * ─────────────────────────────────────────────────────────────────────────────
 * `dashboard-layers-source.test.ts` proves there is exactly ONE file rendering
 * the scope control and that the client's wire literal matches the server's
 * allowlist. Neither is a claim about MARKUP. A control that accepted `extra`
 * and rendered it into a SECOND `<div role="radiogroup">` — or into no element
 * at all — would satisfy both scans while leaving TD-326's population with no
 * affordance, or with two competing "which scope is active" answers.
 *
 * WHAT THIS FILE PROVES
 *   - the extra chip lands INSIDE the one `[aria-label="Project scope"]`
 *     radiogroup, after the projects, and there is still exactly one such group;
 *   - it is `aria-checked` when it is the active scope, and the project chips
 *     are NOT — the two are mutually exclusive on one axis;
 *   - `extra` is OPT-IN: omitting it renders exactly the FR-241 markup, so
 *     `Layers` and `Overview` are byte-unchanged;
 *   - a project chip stays checked when `extra` is present but unselected.
 *
 * WHAT IT DOES **NOT** PROVE
 *   That clicking the chip changes anything. `renderToStaticMarkup` runs no
 *   effects and dispatches no events; `scope.choose` is a stub here.
 *   **Siblings:** `G-BR-10` in `cli/scripts/browser-gate.mjs` (a real click,
 *   against a real brain, surviving the live beat) and
 *   `dashboard-layers-endpoint.test.ts` G-EP-4 (what the resulting request
 *   answers).
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectScope } from "../ProjectScope";
import { BRAIN_LEVEL_SCOPE, type ProjectScope as Scope } from "../../../lib/useProjectScope";

function scope(project: string | null): Scope {
  return {
    projects: {
      projects: [
        { slug: "demo", name: "Demo", path: "/tmp/demo", status: "active", last_session_at: "2026-07-28 09:00:00" },
        { slug: "other", name: "Other", path: "/tmp/other", status: "active", last_session_at: "2026-07-28 09:00:00" },
      ],
      default_project: "demo",
      generated_at: "2026-07-31T00:00:00.000Z",
      degraded: null,
    },
    project,
    choose: () => {},
    fatal: null,
  };
}

const html = (node: React.ReactElement): string => renderToStaticMarkup(node);

/** Every `role="radio"` element's text, in document order. */
function chips(markup: string): string[] {
  return [...markup.matchAll(/role="radio"[^>]*>([^<]*)</g)].map((m) => m[1] ?? "");
}

describe("TD-326 · the brain-level chip is a member of the SAME scope strip", () => {
  it("renders after the projects, inside the one radiogroup", () => {
    const markup = html(
      <ProjectScope scope={scope("demo")} extra={[BRAIN_LEVEL_SCOPE]} />,
    );
    expect(chips(markup)).toEqual(["demo", "other", BRAIN_LEVEL_SCOPE]);
    // ONE group, not two. A second radiogroup would make "which scope is
    // active" a two-place question, and would also give the FR-240 browser
    // gate's `[aria-label="Project scope"]` reader an ambiguous target.
    expect(markup.match(/role="radiogroup"/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="Project scope"');
  });

  it("is CHECKED when it is the active scope, and the projects are not", () => {
    const markup = html(
      <ProjectScope scope={scope(BRAIN_LEVEL_SCOPE)} extra={[BRAIN_LEVEL_SCOPE]} />,
    );
    // The chip carries `aria-checked` through `Chip`'s `active` prop. Read the
    // checked ones rather than counting attributes, so the assertion names WHICH.
    const checked = [...markup.matchAll(/aria-checked="true"[^>]*>([^<]*)</g)].map(
      (m) => m[1] ?? "",
    );
    expect(checked).toEqual([BRAIN_LEVEL_SCOPE]);
    expect(checked).not.toContain("demo");
  });

  it("a project stays checked while the extra chip is merely OFFERED", () => {
    const markup = html(
      <ProjectScope scope={scope("other")} extra={[BRAIN_LEVEL_SCOPE]} />,
    );
    const checked = [...markup.matchAll(/aria-checked="true"[^>]*>([^<]*)</g)].map(
      (m) => m[1] ?? "",
    );
    expect(checked).toEqual(["other"]);
  });

  it("OPT-IN — omitting `extra` renders the FR-241 markup unchanged", () => {
    // `Layers` and `Overview` pass no `extra`, and must not gain a scope whose
    // population is empty by construction on every layer they show
    // (`brief_status.project` and `learnings.project` are both NOT NULL).
    const without = html(<ProjectScope scope={scope("demo")} />);
    expect(chips(without)).toEqual(["demo", "other"]);
    expect(without).not.toContain(BRAIN_LEVEL_SCOPE);
    // ...and it is a PREFIX of the opted-in markup, so `extra` only appends.
    const withExtra = html(
      <ProjectScope scope={scope("demo")} extra={[BRAIN_LEVEL_SCOPE]} />,
    );
    expect(withExtra.startsWith(without.slice(0, without.lastIndexOf("</div>")))).toBe(
      true,
    );
  });

  it("SELF-NEGATIVE-CONTROL — the chip reader really reads, and can report a miss", () => {
    // Every assertion above is over `chips()`/the checked list. A matcher that
    // returned [] would satisfy `not.toContain` and nothing else, but the
    // opt-in test's `toEqual([...])` would still be the only thing standing
    // between a broken reader and a green suite. Prove it both ways.
    expect(chips(html(<ProjectScope scope={scope("demo")} />))).toHaveLength(2);
    expect(chips("<div>no radios here</div>")).toEqual([]);
    // ...and an empty project list renders NOTHING, extra or not — the FR-241
    // rule the extra chips must not smuggle past (a brain with no registered
    // project has no scope strip at all).
    const empty: Scope = {
      ...scope(null),
      projects: {
        projects: [],
        default_project: null,
        generated_at: "2026-07-31T00:00:00.000Z",
        degraded: null,
      },
    };
    expect(html(<ProjectScope scope={empty} extra={[BRAIN_LEVEL_SCOPE]} />)).toBe("");
  });
});
