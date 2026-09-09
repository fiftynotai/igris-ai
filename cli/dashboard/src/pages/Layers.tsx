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

import { ProjectScope } from "../components/chrome/ProjectScope";
import { StatePage } from "../components/ui/StatePage";
import { LAYERS, layerById, layerHash, type LayerId, type RecordAddress } from "../layers/model";
import type { Live } from "../lib/useLive";
import { useProjectScope } from "../lib/useProjectScope";
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
  /*
   * The three-value scope state machine and its default-resolution ladder live
   * in `lib/useProjectScope.ts` — FR-241 lifted them there so the triage
   * surface shares this control rather than growing a second copy of the
   * `undefined`-vs-`null` bug the FR-240 browser gate found. See that file.
   */
  const scope = useProjectScope(live.tick);
  const { project, fatal } = scope;

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
  const view: LayerViewProps = { project, address, search, live };

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
        Project scope — the SHARED control (`components/chrome/ProjectScope`).
        Context docs cannot be read without a project and render an explicit
        `pick a project` state rather than an empty list (AC #6).
      */}
      <ProjectScope scope={scope} />

      {descriptor?.id === "briefs" && <Briefs {...view} />}
      {descriptor?.id === "learnings" && <Learnings {...view} />}
      {descriptor?.id === "context-docs" && <ContextDocs {...view} />}
      {descriptor?.id === "goals" && <Goals {...view} />}
    </>
  );
}
