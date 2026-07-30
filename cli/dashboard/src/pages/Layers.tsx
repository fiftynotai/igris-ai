/**
 * FR-240 — the layers host: the layer switcher, the project scope, and the
 * list/detail routing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT FOLLOWS `Overview.tsx`, NOT `Graph.tsx`
 * ─────────────────────────────────────────────────────────────────────────
 * Every read below keys off `live.tick`, the 5-second `/api/health` beat, so a
 * `/hunt` filing a brief shows up without a reload — the shell's default
 * pattern. `Graph.tsx` diverges from it for two specific reasons (a ~1 MB
 * payload, and a refetch that would re-run a force simulation); neither applies
 * to a 50-row page with no canvas.
 *
 * The ONE exception is a record DETAIL, which is fetched once per address and
 * carries a visible AS OF stamp — see `components/record/RecordDetail.tsx`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE LAYER TABS AND THE RECORD ROWS ARE ANCHORS
 * ─────────────────────────────────────────────────────────────────────────
 * `<a href="#/layers/briefs">`, not `onClick`. The URL is then the whole
 * navigation state: which layer, which project, which record — copyable,
 * back-buttonable, and reload-stable. It also means this component holds NO
 * routing state of its own; `router.tsx` parses the hash and passes the parsed
 * result down, so there is exactly one source of truth for "where am I".
 *
 * The PROJECT scope is the exception: it is a filter, not an address, and it is
 * deliberately not in the URL. Sharing a link to "briefs" should not force the
 * recipient into the sender's project.
 */

import { useEffect, useState } from "react";
import { api, ApiError, type ProjectsPayload } from "../lib/api";
import { Chip } from "../components/ui/Chip";
import { StatePage } from "../components/ui/StatePage";
import { LAYERS, layerById, layerHash, type LayerId, type RecordAddress } from "../layers/model";
import type { Live } from "../lib/useLive";
import { Briefs } from "./layers/Briefs";
import { Learnings } from "./layers/Learnings";
import { ContextDocs } from "./layers/ContextDocs";
import { Goals } from "./layers/Goals";

export interface LayersProps {
  live: Live;
  /** The nav's text mute. A `// QUICK` client-side filter over loaded rows. */
  search: string;
  /** Parsed from the hash by `router.tsx`. */
  layer: LayerId;
  address: RecordAddress | null;
}

/** What every layer view receives. Identical for all four (AC #5). */
export interface LayerViewProps {
  /** The selected project, or `null` for "every project". */
  project: string | null;
  /** The record being read, or `null` for the list. */
  address: RecordAddress | null;
  search: string;
  live: Live;
}

export function Layers({ live, search, layer, address }: LayersProps) {
  const [projects, setProjects] = useState<ProjectsPayload | null>(null);
  /*
   * THREE STATES, NOT TWO — and the third one is load-bearing.
   *
   *   undefined  no scope has been resolved yet (first load)
   *   "<slug>"   the operator is scoped to one project
   *   null       the operator has EXPLICITLY chosen every project
   *
   * An earlier revision held `string | null` and re-ran the default-project
   * ladder whenever the value was `null`. Since that effect fires on every
   * `live.tick`, clearing the scope was silently UNDONE within five seconds:
   * measured 3 rows -> 4 rows on the click, then back to 3 rows at t+2 s, with
   * the chip re-checking itself. The clear-by-reclick affordance this file's own
   * header documents simply did not work.
   *
   * It was invisible to the unit suite (which renders the view with a `project`
   * prop and never runs the beat) and fell out of the FR-240 browser gate in one
   * reading. Keeping "never chosen" distinguishable from "chose everything" is
   * the whole fix; the ladder now runs only for the former.
   */
  const [project, setProject] = useState<string | null | undefined>(undefined);
  const [fatal, setFatal] = useState<string | null>(null);

  // Projects — refetched on the beat so a `/register` mid-session appears
  // without a reload. Same ladder as `Overview.tsx`: keep the operator's own
  // choice, otherwise take the server-resolved default.
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
  }, [live.tick]);

  if (fatal !== null) {
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
        meta={fatal}
      />
    );
  }

  const descriptor = layerById(layer);
  // `undefined` never leaves this component: a view's contract is "a project, or
  // every project", and "not resolved yet" is this component's business alone.
  const view: LayerViewProps = { project: project ?? null, address, search, live };

  return (
    <>
      {/* The layer switcher. Anchors, so each layer is a real address. */}
      <div className="record-tabs" role="navigation" aria-label="Layers">
        {LAYERS.map((l) => (
          <a
            key={l.id}
            className="shell-nav-link"
            href={layerHash(l.id)}
            aria-current={l.id === layer ? "page" : undefined}
            data-cursor="hover"
          >
            {l.label}
          </a>
        ))}
      </div>

      {/*
        Project scope. Re-clicking the active chip clears it to "every project"
        — the same clear-by-reclick rule `FilterBar` uses, because this IS a
        filter and behaving differently from the other filters would be a trap.
        Context docs cannot be read without a project and render an explicit
        `pick a project` state rather than an empty list (AC #6).
      */}
      {projects !== null && projects.projects.length > 0 && (
        <div
          className="tweaks-chips"
          role="radiogroup"
          aria-label="Project scope"
          style={{ marginBottom: 24 }}
        >
          {projects.projects.map((p) => (
            <Chip
              key={p.slug}
              variant="tweak"
              role="radio"
              active={p.slug === project}
              onClick={() => setProject(p.slug === project ? null : p.slug)}
            >
              {p.slug}
            </Chip>
          ))}
        </div>
      )}

      {descriptor?.id === "briefs" && <Briefs {...view} />}
      {descriptor?.id === "learnings" && <Learnings {...view} />}
      {descriptor?.id === "context-docs" && <ContextDocs {...view} />}
      {descriptor?.id === "goals" && <Goals {...view} />}
    </>
  );
}
