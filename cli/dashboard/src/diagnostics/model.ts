/**
 * FR-266 — the diagnostics model. PURE, node-testable, no React, no browser.
 *
 * Precedent: `layers/model.ts`, `search/model.ts`, `triage/model.ts`. Anything a
 * reviewer could get wrong lives here rather than in a component, so the node
 * vitest env asserts all of it with no DOM.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTHING IN A COMPONENT DECIDES A TONE
 * ─────────────────────────────────────────────────────────────────────────────
 * A tone is a CLAIM ABOUT WHO IS AT FAULT, not a colour choice. Getting it wrong
 * does not look wrong — it sends an operator to the healthy instance. So the map
 * is here, it is total, and `__tests__/model.test.ts` pins it.
 *
 * | status             | tone        | why                                     |
 * |--------------------|-------------|-----------------------------------------|
 * | `ok`               | `ok`        | —                                       |
 * | `failing`          | `alarm`     | it failed and nothing succeeded after    |
 * | `wedged`           | `alarm`     | it cannot fire again until a human acts  |
 * | `blocked_upstream` | `attention` | THE FAULT IS THE DRIVER'S — see below    |
 * | `no_signal`        | `attention` | absence of EVIDENCE inside a 30-day      |
 * |                    |             | purge window, not a fault                |
 * | `disabled`         | `off`       | an operator CHOICE (AC-4)                |
 *
 * `blocked_upstream` IS DELIBERATELY NOT `alarm`. A co-driven instance runs only
 * inside its driver's run and has no switch or schedule of its own;
 * `verbs/cognition.ts#classify` exists precisely so the operator is not sent to
 * it. Painting it red would re-create that mistake one tier up, in pixels.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MAP IS TOTAL OVER `string`, NOT OVER THE UNION
 * ─────────────────────────────────────────────────────────────────────────────
 * The cognition registry is OPEN (an instance is a self-describing file,
 * discovered rather than enumerated) and `cognition_instances` is projected by
 * the BRAIN while this code lives in the CLI — two npm packages that are not
 * upgraded atomically on a running machine. A seventh status can therefore
 * arrive at an older client. `brain-db.ts#readCognitionRoster` already carries a
 * tolerant column read for the same reason one layer down.
 *
 * A `switch` with no default would render a BLANK chip for such a status, which
 * is worse than a wrong one: a blank says nothing is wrong. The rule is
 * **unknown -> `attention`, with the raw string shown verbatim**.
 *
 * @module diagnostics/model
 */

import type { CognitionInstanceHealth } from "../lib/api";

/** The four visual tones. Carried on every row as `data-tone`. */
export type Tone = "ok" | "alarm" | "attention" | "off";

/** Every tone, so `toneCounts` can key on the set rather than on what it saw. */
export const TONES: readonly Tone[] = ["ok", "alarm", "attention", "off"] as const;

/**
 * The statuses THIS BUILD knows about.
 *
 * NOT a claim that the brain emits only these — see the header. It is the set
 * `statusLabel` has a word for and `unknownStatuses` measures against, so a
 * newer brain's verdict is REPORTED as unrecognised rather than silently styled
 * like one of these.
 */
export const KNOWN_STATUSES: readonly string[] = [
  "ok",
  "failing",
  "wedged",
  "blocked_upstream",
  "no_signal",
  "disabled",
] as const;

/**
 * The tone for a status. TOTAL over `string`.
 *
 * A `Record<string, Tone>` lookup with an explicit fallback, rather than a
 * `switch`: the fallback is then a value in the same expression as the map and
 * cannot be forgotten by adding a case.
 */
const TONE_BY_STATUS: Record<string, Tone> = {
  ok: "ok",
  failing: "alarm",
  wedged: "alarm",
  blocked_upstream: "attention",
  no_signal: "attention",
  disabled: "off",
};

export function toneFor(status: string): Tone {
  return TONE_BY_STATUS[status] ?? "attention";
}

/**
 * The chip word. TOTAL, and NEVER empty.
 *
 * An unknown status renders its RAW value (underscores to spaces, uppercased)
 * so the operator can read what the brain actually sent and go looking for it. A
 * blank chip makes that impossible, and an "UNKNOWN" chip throws away the one
 * piece of information that would identify the new status.
 */
export function statusLabel(status: string): string {
  const shown = status.trim().replace(/_/g, " ").toUpperCase();
  // The empty case is real: a roster row projected with an empty verdict would
  // otherwise render a zero-width chip that reads as "no chip".
  return shown.length > 0 ? shown : "NO STATUS REPORTED";
}

/**
 * The gate sentence for a DISABLED instance, or `null`.
 *
 * D4 — WHAT THIS DELIBERATELY CANNOT SAY. `verbs/cognition.ts#evaluateGates`
 * returns the same `disabled_by` for an ABSENT key and an EXPLICIT `false`, and
 * no field of `CognitionInstanceHealth` carries the raw resolved value, so NO
 * render can recover "never enabled" from "deliberately switched off". Deriving
 * it here by re-reading `config.json` would put a SECOND resolver of gate
 * semantics in the dashboard tier. The honest fix is a new digest field, and it
 * is a producer-side brief.
 *
 * What this DOES do, and it is not nothing: it names the failing key verbatim,
 * so `cartographer` reads *"gate cognition.janitor.cluster.enabled is not true
 * in config.json"* rather than a bare `DISABLED`. `cartographer` declares TWO
 * gates and the digest reports the one that FAILED, so the operator is sent to
 * the right toggle rather than to the first one declared.
 */
export function gateLine(row: CognitionInstanceHealth): string | null {
  if (row.disabled_by === null) return null;
  // The ONE case that IS distinguishable today. `(no gate declared)` is not a
  // config key at all — it is an instance that declared no gate, which is a
  // DEFECT in the instance rather than a choice by the operator. Sending
  // someone to `config.json` to look for a key by that name is the failure this
  // branch prevents.
  if (row.disabled_by === "(no gate declared)") {
    return "this instance declares no gate, so it can never be reported as enabled — a contract defect, not a setting";
  }
  return `gate ${row.disabled_by} is not true in config.json`;
}

/** The row view the panel renders. Every field is a string it can print as-is. */
export interface InstanceView {
  id: string;
  /** The RAW status, for `data-status` and for the reader. */
  status: string;
  tone: Tone;
  /** The chip word. */
  label: string;
  /** The classifier's own operator-readable sentence, VERBATIM. */
  reason: string;
  /** `driver` and, when there is one, its ref. Never "manual · null". */
  driver: string;
  /** The gate sentence, or `null` when the instance is enabled. */
  gate: string | null;
  /** The last terminal event, or a STATED unknown. */
  lastRun: string;
  /** The schedule cross-check, or `null` when the driver is not a schedule. */
  schedule: string | null;
  /** Where the output lands, with a count when one is countable. */
  output: string;
  /** True when THIS build has no word for the status — rendered as a note. */
  unrecognised: boolean;
}

/**
 * Turn one digest row into the strings the panel prints.
 *
 * EVERY UNKNOWN IS STATED. `last_run_at: null` becomes a sentence, not an empty
 * cell; `output_rows: null` is NOT rendered as `0`, because `null` means "the
 * declared expression is not countable" while `0` means "it has produced
 * nothing" — two different and non-interchangeable claims.
 */
export function describeInstance(row: CognitionInstanceHealth): InstanceView {
  const driver =
    row.driver_ref === null || row.driver_ref.length === 0
      ? row.driver
      : `${row.driver} · ${row.driver_ref}`;

  const lastRun =
    row.last_run_at === null || row.last_outcome === null
      ? row.last_run_any_host === null
        ? "no terminal event on any host inside the retained window"
        : `no terminal event on this host — last seen elsewhere at ${row.last_run_any_host}`
      : `${row.last_outcome} at ${row.last_run_at}`;

  let schedule: string | null = null;
  if (row.schedule !== null) {
    const s = row.schedule;
    const parts = [`${s.name}`, s.enabled ? "enabled" : "disabled"];
    if (s.rows !== 1) parts.push(`${s.rows} rows with this name`);
    parts.push(s.next_run_at === null ? "no next run" : `next ${s.next_run_at}`);
    if (s.overdue) parts.push("OVERDUE");
    if (s.open_run_id !== null) {
      const age = s.open_run_age_days === null ? "unknown" : `${s.open_run_age_days}`;
      parts.push(`OPEN RUN ${s.open_run_id} (${age}d)`);
    }
    schedule = parts.join(" · ");
  }

  const output =
    row.output_rows === null
      ? `${row.output} — not a countable expression`
      : `${row.output} — ${row.output_rows} row(s)`;

  return {
    id: row.id,
    status: row.status,
    tone: toneFor(row.status),
    label: statusLabel(row.status),
    reason: row.reason,
    driver,
    gate: gateLine(row),
    lastRun,
    schedule,
    output,
    unrecognised: !KNOWN_STATUSES.includes(row.status),
  };
}

/**
 * How many instances sit at each tone.
 *
 * KEYED ON `TONES`, not on what was seen, so a tone with zero members renders as
 * a zero rather than being absent. An absent key reads as "not applicable",
 * which is a different statement from "none".
 */
export function toneCounts(
  instances: readonly CognitionInstanceHealth[],
): Record<Tone, number> {
  const counts = Object.fromEntries(TONES.map((t) => [t, 0])) as Record<Tone, number>;
  for (const row of instances) counts[toneFor(row.status)] += 1;
  return counts;
}

/**
 * The statuses this build has no word for, deduplicated, in first-seen order.
 *
 * Surfaced by the panel as a note. A client that silently styled an unrecognised
 * verdict like a known one would be lying about how much it understood.
 */
export function unknownStatuses(
  instances: readonly CognitionInstanceHealth[],
): string[] {
  const seen: string[] = [];
  for (const row of instances) {
    if (!KNOWN_STATUSES.includes(row.status) && !seen.includes(row.status)) {
      seen.push(row.status);
    }
  }
  return seen;
}
