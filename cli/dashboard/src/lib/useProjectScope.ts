/**
 * FR-241 — the project scope, LIFTED out of `pages/Layers.tsx` so the triage
 * surface can share it rather than fork it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY EXTRACT INSTEAD OF COPY
 * ─────────────────────────────────────────────────────────────────────────
 * The scope is not four lines of state. It is a THREE-VALUE state machine plus
 * a default-resolution ladder plus a refetch on the beat, and FR-240 already
 * shipped a bug in it (see the `undefined` note below) that cost a browser run
 * to find. A second copy in `Triage.tsx` would be a second chance at the same
 * bug, on the one surface where the scope decides which rows a BULK MUTATION
 * reaches. `architecture_map.md`'s Client Record Tier rule — reuse the shared
 * components, do not fork them — applies to state as much as to markup.
 *
 * THREE STATES, NOT TWO, and the third one is load-bearing:
 *
 *   undefined  no scope has been resolved yet (first load)
 *   "<slug>"   the operator is scoped to one project
 *   null       the operator has EXPLICITLY chosen every project
 *
 * An earlier revision held `string | null` and re-ran the default ladder
 * whenever the value was `null`. Since the effect fires on every `live.tick`,
 * clearing the scope was silently UNDONE within five seconds — measured 3 rows
 * -> 4 rows on the click, then back to 3 rows at t+2 s, with the chip
 * re-checking itself. Keeping "never chosen" distinguishable from "chose
 * everything" is the whole fix.
 */

import { useEffect, useState } from "react";
import { api, ApiError, type ProjectsPayload } from "./api";

export interface ProjectScope {
  projects: ProjectsPayload | null;
  /** The selected project, or `null` for "every project". Never `undefined`. */
  project: string | null;
  /** Passing the currently-active slug CLEARS the scope (clear-by-reclick). */
  choose: (slug: string) => void;
  /** A transport failure reading `/api/projects`. */
  fatal: string | null;
}

export function useProjectScope(tick: number): ProjectScope {
  const [projects, setProjects] = useState<ProjectsPayload | null>(null);
  const [project, setProject] = useState<string | null | undefined>(undefined);
  const [fatal, setFatal] = useState<string | null>(null);

  // Refetched on the beat so a `/register` mid-session appears without a
  // reload. Same ladder as `Overview.tsx`: keep the operator's own choice,
  // otherwise take the server-resolved default.
  useEffect(() => {
    const ctrl = new AbortController();
    api
      .projects(ctrl.signal)
      .then((p) => {
        setProjects(p);
        setFatal(null);
        setProject((cur) => {
          // An explicit "every project" is a CHOICE and is preserved.
          if (cur === null) return null;
          if (cur !== undefined && p.projects.some((r) => r.slug === cur)) return cur;
          if (
            p.default_project !== null &&
            p.projects.some((r) => r.slug === p.default_project)
          ) {
            return p.default_project;
          }
          return p.projects[0]?.slug ?? null;
        });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setFatal(err instanceof ApiError ? err.message : String(err));
      });
    return () => ctrl.abort();
  }, [tick]);

  return {
    projects,
    // `undefined` never leaves this hook: a consumer's contract is "a project,
    // or every project", and "not resolved yet" is this hook's business alone.
    project: project ?? null,
    choose: (slug: string) => setProject((cur) => (cur === slug ? null : slug)),
    fatal,
  };
}
