/**
 * FR-240 — the context-docs layer: the per-project inventory, the rendered doc,
 * and the missing-but-applicable block.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * D8 — THIS LAYER TOUCHES NO BRAIN AT ALL
 * ─────────────────────────────────────────────────────────────────────────
 * `/api/context-docs` forwards `buildContextDocsInventoryDigest`, and
 * `/api/context-doc` is a guarded disk read. So this view works on a machine
 * with no brain database — and it is the one layer with no graph node, hence no
 * LOCATE IN GRAPH action. Context docs are FILES; that absence is the data
 * model, not a gap.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE REMEDIATION LINES ARE THE DIGEST'S OWN
 * ─────────────────────────────────────────────────────────────────────────
 * `payload.remediation` is rendered VERBATIM. It is tempting to build
 * `/ground ${type}` in this file from `missing_applicable` — and that would be a
 * second source of truth for the verb name, in a UI, drifting silently the day
 * the verb changes. The digest computes it; this renders it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ADDRESSED BY CATALOG TYPE, NEVER BY FILENAME
 * ─────────────────────────────────────────────────────────────────────────
 * The route carries `type` (`coding_guidelines`), and the server resolves the
 * filename from the digest row. That is what makes path traversal UNREACHABLE
 * rather than filtered: there is no code path where a browser-supplied string is
 * joined onto a directory. This file must never gain one.
 */

import { useEffect, useState } from "react";
import {
  api,
  ApiError,
  type ContextDocPayload,
  type ContextDocsPayload,
} from "../../lib/api";
import { Badge } from "../../components/ui/Badge";
import { RecordList, type RecordListRow } from "../../components/record/RecordList";
import { RecordDetail } from "../../components/record/RecordDetail";
import { Markdown } from "../../markdown/Markdown";
import {
  emptyStateFor,
  layerById,
  layerHash,
  muteRows,
  orderInventory,
  recordHash,
} from "../../layers/model";
import type { LayerViewProps } from "../Layers";

const LAYER = "context-docs" as const;

export function ContextDocs(props: LayerViewProps) {
  return props.address !== null ? (
    <DocDetailView {...props} address={props.address} />
  ) : (
    <InventoryView {...props} />
  );
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

function InventoryView({ project, search, live }: LayerViewProps) {
  const [payload, setPayload] = useState<ContextDocsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Follows the beat, like every other list in the shell: `/ground` writing a
  // doc mid-session should appear without a reload. The digest is cheap — a
  // catalog read plus one `existsSync` per row, no brain and no SQL.
  useEffect(() => {
    if (project === null) {
      setPayload(null);
      setError(null);
      return;
    }
    const ctrl = new AbortController();
    api
      .contextDocs(project, ctrl.signal)
      .then((p) => {
        if (ctrl.signal.aborted) return;
        setPayload(p);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(err instanceof ApiError ? err.message : String(err));
      });
    return () => ctrl.abort();
  }, [project, live.tick]);

  const descriptor = layerById(LAYER);
  const ordered = payload === null ? [] : orderInventory(payload);
  const muted = muteRows(ordered, search, (r) => [r.type, r.target, r.summary]);

  return (
    <RecordList
      eye={descriptor?.eye ?? "// CONTEXT DOCS"}
      heading="CONTEXT"
      lede={descriptor?.lede}
      loading={project !== null && payload === null && error === null}
      banners={
        <>
          {error !== null && (
            <div className="shell-banner" role="status">
              READ FAILED — {error}
            </div>
          )}
          {payload?.degraded != null && (
            <div className="shell-banner" role="status">
              INVENTORY DEGRADED — {payload.degraded.reason}
            </div>
          )}
          {payload !== null && (
            <p className="record-readout" role="status">
              {payload.project ?? "—"} · {payload.archetype ?? "no archetype"} ·{" "}
              {payload.tech_stack ?? "no stack"}
            </p>
          )}
        </>
      }
      filters={
        search.trim().length > 0
          ? {
              controls: [],
              onChange: () => undefined,
              readout: `MUTED ${muted.length}/${ordered.length}`,
            }
          : undefined
      }
      rows={muted.map(
        (row): RecordListRow => ({
          key: row.type,
          eye: `// ${row.type}`,
          title: row.target,
          trail: row.summary.length > 0 ? row.summary : null,
          // Only an EXISTING doc has content to read. A missing one is a row
          // that states its own absence — `disabled`, not hidden, because the
          // gap is the information.
          href: row.exists
            ? recordHash({ layer: LAYER, project: project ?? "", id: row.type })
            : null,
          disabled: !row.exists,
          badges: (
            <>
              {row.exists ? (
                <Badge>exists</Badge>
              ) : row.missing_applicable ? (
                <Badge variant="alarm">missing · applicable</Badge>
              ) : (
                <Badge variant="muted">absent</Badge>
              )}
              <Badge variant="muted">applies: {row.applies}</Badge>
              {row.optional && <Badge variant="muted">optional</Badge>}
            </>
          ),
          meta: [{ k: "applies when", v: row.applies_when }],
        }),
      )}
      empty={emptyStateFor({
        layer: LAYER,
        total: ordered.length,
        degraded: payload?.degraded?.reason ?? error,
        filtersActive: false,
        searchActive: search.trim().length > 0 && ordered.length > 0,
        project,
        projectRequired: true,
      })}
    >
      {/*
        The actionable gap. Rendered from the digest's OWN `remediation` array —
        see the header. `missing_applicable` names WHICH docs; `remediation` says
        what to run, in the verb's own words.
      */}
      {payload !== null && payload.missing_applicable.length > 0 && (
        <section className="record-neighbours" aria-label="Missing context docs">
          <span className="shell-eye">
            // MISSING · APPLICABLE · {payload.missing_applicable.length}
          </span>
          <p className="record-note">
            These doc types apply to this project and do not exist yet. Each line
            below is the digest's own remediation — run it in the project's
            harness.
          </p>
          <ul className="record-hops">
            {payload.remediation.map((line) => (
              <li key={line}>
                <span className="record-hop">
                  <b>run</b>
                  <code className="record-md-code">{line}</code>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </RecordList>
  );
}

// ---------------------------------------------------------------------------
// One doc
// ---------------------------------------------------------------------------

function DocDetailView({
  address,
}: LayerViewProps & { address: NonNullable<LayerViewProps["address"]> }) {
  const [payload, setPayload] = useState<ContextDocPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (address.project === null) {
      setError("a context doc is addressed per project — this address has none");
      return;
    }
    const ctrl = new AbortController();
    setPayload(null);
    setError(null);
    api
      .contextDoc(address.project, address.id, ctrl.signal)
      .then((p) => {
        if (!ctrl.signal.aborted) setPayload(p);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(err instanceof ApiError ? err.message : String(err));
      });
    return () => ctrl.abort();
  }, [address.project, address.id]);

  return (
    <RecordDetail
      eye={`// ${address.id}`}
      title={payload?.target ?? address.id}
      backHref={layerHash(LAYER)}
      // D8 — no graph node exists for a file on disk. Stated, not omitted.
      locateHref={null}
      locateNote="NOT IN THE GRAPH — CONTEXT DOCS ARE FILES"
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
              DOC DEGRADED — {payload.degraded.reason}
            </div>
          )}
          {payload?.truncated === true && (
            <div className="shell-banner" role="status">
              TRUNCATED — this doc is larger than the server's read cap
              ({payload.bytes} bytes on disk). What follows is the first part.
            </div>
          )}
        </>
      }
      meta={[
        { k: "project", v: address.project ?? "—" },
        { k: "type", v: address.id },
        { k: "file", v: payload?.target ?? "—" },
        { k: "bytes", v: String(payload?.bytes ?? "—") },
      ]}
      body={
        payload === null ? undefined : payload.content === null ||
          payload.content.length === 0 ? (
          <p className="record-note">
            This doc exists but is empty. `/ground {address.id}` rewrites it.
          </p>
        ) : (
          <Markdown source={payload.content} />
        )
      }
    />
  );
}
