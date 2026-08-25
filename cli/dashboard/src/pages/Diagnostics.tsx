/**
 * FR-266 — `#/diagnostics`: the spine, plus ONE panel (cognition).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHICH CEILING THIS IS CHARGED AGAINST
 * ─────────────────────────────────────────────────────────────────────────────
 * This file is the SIXTH route and the FIFTH lazy one, so it is charged to
 * `TOTAL_JS_CEILING` only. The EAGER cost of the route is three lines in
 * `App.tsx`, one `ROUTES` member and one nav label — charged to
 * `INITIAL_JS_CEILING` and therefore to both. Static-importing this file
 * anywhere would pull `diagnostics/**` onto the critical path and re-base both
 * ceilings; `cli/src/__tests__/dashboard-chunks.test.ts` is the authority and
 * MAINTAINING row 111 carries the change procedure.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ROSTER IS RENDERED FROM `payload.cognition.instances` AND FROM NOTHING
 * ELSE (AC-3)
 * ─────────────────────────────────────────────────────────────────────────────
 * There is no local list of instance ids in this file, and there must never be
 * one. The cognition registry is OPEN — an instance is a self-describing file in
 * `cognition/extractors/`, discovered rather than enumerated — and the whole
 * reason TD-327 exists is that every health surface built on it so far was
 * HAND-LISTED. `/boot` §4.10 carried embedded SQL for two of seven instances by
 * name; seven existed, five went silent for four weeks, and the outage was found
 * only because an operator ran SQL by hand.
 *
 * A hand-list over an open registry cannot report on the members nobody
 * remembered to list. So: the server derives, this file maps. An instance added
 * next month appears here with zero edit.
 * `dashboard-layers-source.test.ts` asserts mechanically that no shipped client
 * file names any of the seven instance ids.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY `blocked_upstream` IS NOT RED
 * ─────────────────────────────────────────────────────────────────────────────
 * A co-driven instance runs only inside its driver's run; it has no switch and
 * no schedule of its own. `verbs/cognition.ts#classify` exists precisely so the
 * operator is sent to the DRIVER rather than to the instance that merely went
 * quiet behind it. An alarm-coloured row here would re-create that mistake in
 * pixels, so the tone is `attention` and the row carries the classifier's own
 * remedy sentence, which names the driver.
 *
 * Every tone decision lives in `diagnostics/model.ts`, which is pure and
 * unit-tested. This file holds state and markup, and nothing that could be wrong
 * quietly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT DEGRADES TO A STATED UNKNOWN, NEVER TO AN EMPTY PANEL (AC-5, TD-405)
 * ─────────────────────────────────────────────────────────────────────────────
 * Four reachable states, and each renders a sentence:
 *   - the read never settled  -> `useCognition`'s deadline turns the wait into
 *                                `read timed out after Ns`;
 *   - the transport failed    -> the `ApiError` message, verbatim;
 *   - the ENVELOPE degraded   -> the server's reason (no brain on disk);
 *   - the DIGEST degraded     -> the digest's own reason (a brain that has never
 *                                booted a build projecting the roster).
 * The last two are DIFFERENT REMEDIES and are rendered as different sentences.
 * There is no branch that renders a spinner without a successor, and no branch
 * that renders an empty region with no explanation.
 */

import { Badge } from "../components/ui/Badge";
import { StatePage } from "../components/ui/StatePage";
import type { CognitionPayload } from "../lib/api";
import type { Live } from "../lib/useLive";
import { useCognition } from "../diagnostics/useCognition";
import {
  TONES,
  describeInstance,
  toneCounts,
  unknownStatuses,
  type Tone,
} from "../diagnostics/model";

export interface DiagnosticsProps {
  live: Live;
}

/**
 * Everything {@link CognitionPanel} needs, as DATA.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE PANEL IS SPLIT FROM THE ROUTE, AND IT IS NOT FOR TIDINESS
 * ─────────────────────────────────────────────────────────────────────────────
 * `renderToStaticMarkup` runs NO `useEffect`. A panel that fetched its own data
 * would therefore render only its loading state under the node vitest env, and
 * the only way to test its real markup would be to MOCK the hook — i.e. to
 * assert against a fake whose agreement with the endpoint nothing checks.
 *
 * So the route owns the read and the panel owns the markup. The panel is a pure
 * function of this props bag, `diagnostics/__tests__/panel.test.tsx` renders the
 * REAL component over a payload in the endpoint's shape, and no test in this
 * brief mocks anything. Same split `RecordList` already has from the six pages
 * that feed it.
 */
export interface CognitionPanelProps {
  payload: CognitionPayload | null;
  /** True only while there is NOTHING to show. Never true on a beat refetch. */
  loading: boolean;
  /** A TRANSPORT failure, including the read deadline. Not `degraded`. */
  error: string | null;
  /** Where the answer came from, taken from the shell's existing health beat. */
  brainPath: string | null;
}

/**
 * The routed shell: it owns the READ and nothing else.
 *
 * It takes `live` for two reasons — `live.tick` is the beat the panel refetches
 * on, and `live.health.brain.path` is where the footer says the answer came
 * from, read from the shell's EXISTING health poll rather than from a second
 * request for the same fact.
 */
export function Diagnostics({ live }: DiagnosticsProps) {
  const { payload, loading, error } = useCognition(live.tick);
  return (
    <CognitionPanel
      payload={payload}
      loading={loading}
      error={error}
      brainPath={live.health?.brain.path ?? null}
    />
  );
}

/**
 * Tone -> `Badge` variant.
 *
 * The only place the vocabulary of `model.ts` meets the vocabulary of the ported
 * component library, and it is a TOTAL record rather than a chain of ternaries,
 * so adding a tone is a compile error here instead of a blank chip on screen.
 */
const BADGE_VARIANT: Record<Tone, "live" | "alarm" | "warn" | "muted"> = {
  ok: "live",
  alarm: "alarm",
  attention: "warn",
  off: "muted",
};

/** The words the tone counters use. Rendered even at zero — see `toneCounts`. */
const TONE_LABEL: Record<Tone, string> = {
  ok: "healthy",
  alarm: "alarm",
  attention: "attention",
  off: "disabled",
};

export function CognitionPanel({
  payload,
  loading,
  error,
  brainPath,
}: CognitionPanelProps) {
  /*
   * LOADING IS THE ONLY STATE WITHOUT A SENTENCE, and it is bounded: `loading`
   * is `busy && payload === null`, and `busy` cannot outlive
   * `READ_DEADLINE_MS`. So this branch always has a successor — which is the
   * property TD-405's eternal loader did not have.
   */
  if (loading) {
    return (
      <StatePage
        inset
        variant="loading"
        headline={
          <>
            <em>reading</em> cognition health.
          </>
        }
        message="One in-process read of the local brain, through the read-only door."
        meta="diagnostics · cognition"
      />
    );
  }

  // A TRANSPORT failure — including the deadline. Distinct from `degraded`,
  // which is the server successfully reporting that something is wrong.
  if (payload === null) {
    return (
      <StatePage
        inset
        variant="error"
        headline={
          <>
            <em>diagnostics unavailable.</em>
          </>
        }
        message={
          error ??
          "The dashboard server stopped answering. Restart it with `igris dashboard`."
        }
        meta={`diagnostics · ${error ?? "no response"}`}
      />
    );
  }

  const digest = payload.cognition;
  const instances = digest?.instances ?? [];
  const counts = toneCounts(instances);
  const unknown = unknownStatuses(instances);

  return (
    <section className="diag" data-diag-panel="cognition">
      <header className="diag-head">
        <span className="diag-eye">// DIAGNOSTICS</span>
        <h1 className="diag-title">COGNITION</h1>
        <p className="diag-lede">
          What is quietly broken. Every registered instance, its verdict, and the
          sentence the classifier gave for it.
        </p>
      </header>

      {/*
        THE ENVELOPE'S degradation: there is no brain file at all. The server's
        own sentence, verbatim — it names the path, which is the operator's next
        step.
      */}
      {payload.degraded !== null && (
        <div className="shell-banner" role="status" data-diag-degraded="envelope">
          COGNITION UNAVAILABLE — {payload.degraded.reason}
        </div>
      )}

      {/*
        THE DIGEST'S degradation: the brain is readable but has never booted a
        build that projects the roster. A DIFFERENT REMEDY from the banner above,
        so a different sentence — collapsing the two would hide which one applies.
      */}
      {digest !== null && digest.degraded && (
        <div className="shell-banner" role="status" data-diag-degraded="digest">
          ROSTER UNAVAILABLE — {digest.degraded_reason ?? "no reason reported"}
        </div>
      )}

      {/* The digest's own anomalies (duplicate schedule rows, reduced columns). */}
      {(digest?.warnings ?? []).map((w) => (
        <div className="shell-banner" role="status" key={w} data-diag-warning="">
          {w}
        </div>
      ))}

      {/*
        A status this build has no word for. Rendered rather than styled away:
        the client and the brain are separate packages, so an unrecognised
        verdict means this page understood less than it displayed, and saying so
        is the whole posture of the surface.
      */}
      {unknown.length > 0 && (
        <div className="shell-banner" role="status" data-diag-unknown="">
          {unknown.length} UNRECOGNISED STATUS VALUE(S) — {unknown.join(", ")}. This
          build has no rule for them; they are shown as reported and treated as
          needing attention.
        </div>
      )}

      {/*
        THE TONE COUNTERS. Every tone renders, including the zeroes — an absent
        counter reads as "not applicable", which is not the same claim as "none".
      */}
      <div className="diag-counts" data-diag-counts="">
        {TONES.map((tone) => (
          <span className="diag-count" key={tone} data-tone={tone}>
            <b>{counts[tone]}</b> {TONE_LABEL[tone]}
          </span>
        ))}
        <span className="diag-count" data-tone-total="">
          <b>{instances.length}</b> registered
        </span>
      </div>

      {instances.length === 0 ? (
        /*
         * AN EMPTY ROSTER IS ALSO A STATED UNKNOWN. It is reachable without any
         * degradation — a brain whose projection ran and found nothing — and a
         * blank region here would read as "everything is fine".
         */
        <StatePage
          inset
          variant="empty"
          headline={
            <>
              <em>no instances registered.</em>
            </>
          }
          message="The roster projection is readable and contains no rows. Boot a brain build that registers cognition extractors, then reload."
          meta="diagnostics · cognition · 0 instances"
        />
      ) : (
        <ul className="diag-rows">
          {instances.map((row) => {
            const view = describeInstance(row);
            return (
              /*
                `data-tone` and `data-status` make "visually distinct" MACHINE
                ASSERTABLE rather than eyeballed — `panel.test.tsx` and the
                browser gate both read them. `data-status` carries the RAW value,
                so an unrecognised one is still identifiable in the markup.
              */
              <li
                className="diag-row"
                key={view.id}
                data-instance-row={view.id}
                data-tone={view.tone}
                data-status={view.status}
              >
                <div className="diag-row-head">
                  <span className="diag-row-id">{view.id}</span>
                  <Badge variant={BADGE_VARIANT[view.tone]}>{view.label}</Badge>
                  {view.unrecognised && (
                    <span className="diag-row-flag">not recognised by this build</span>
                  )}
                </div>

                {/*
                  The classifier's OWN sentence, verbatim and NOT uppercased. It
                  carries real table names, real run ids and real gate keys, and
                  shouting it would make it harder to read at the exact moment it
                  matters. Same rule `.search-layer-reason` follows.
                */}
                <p className="diag-row-reason">{view.reason}</p>

                {/*
                  THE GATE, VERBATIM (D4). This is what turns a bare `DISABLED`
                  into something an operator can act on. This build CANNOT tell
                  "never enabled" from "deliberately switched off" — the digest
                  reports the same `disabled_by` for an absent key and an explicit
                  `false` — so it shows the key and lets the operator look.
                */}
                {view.gate !== null && (
                  <p className="diag-row-gate" data-diag-gate="">
                    {view.gate}
                  </p>
                )}

                <dl className="diag-row-meta">
                  <div className="diag-kv">
                    <dt>driver</dt>
                    <dd>{view.driver}</dd>
                  </div>
                  <div className="diag-kv">
                    <dt>last run</dt>
                    <dd>{view.lastRun}</dd>
                  </div>
                  {view.schedule !== null && (
                    <div className="diag-kv">
                      <dt>schedule</dt>
                      <dd>{view.schedule}</dd>
                    </div>
                  )}
                  <div className="diag-kv">
                    <dt>output</dt>
                    <dd>{view.output}</dd>
                  </div>
                </dl>
              </li>
            );
          })}
        </ul>
      )}

      {/*
        THE FOOTER IS PART OF THE HONESTY, not decoration. `no_signal` is bounded
        by the `event_log` retention window, so a reader who does not know the
        floor reads "no signal" as "never ran" and retires a working instance.
        The host matters for the same reason: every `last_run_at` is scoped to it,
        because `event_log` syncs and a VPS-born success must not render a
        locally-wedged instance green.
      */}
      {digest !== null && (
        <p className="diag-foot" data-diag-foot="">
          host {digest.hostname} · event_log retained {digest.event_log_retention_days}{" "}
          days
          {digest.event_log_oldest_at === null
            ? " · no retained events, so a NO SIGNAL verdict is bounded by nothing observable"
            : ` · oldest retained event ${digest.event_log_oldest_at}, so NO SIGNAL means "silent since at least then", never "never ran"`}
        </p>
      )}

      {/*
        The brain path, from the shell's existing health beat rather than from a
        second read. Names where the answer came from, which is the first thing
        an operator checks when a verdict surprises them.
      */}
      {brainPath !== null && (
        <p className="diag-foot" data-diag-source="">
          read from {brainPath}
        </p>
      )}
    </section>
  );
}
