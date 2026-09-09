/**
 * `igris cognition health` — per-instance health for the cognition subsystem (TD-327).
 *
 * WHY THIS VERB EXISTS. The cognition registry is OPEN (FR-118 M2): an instance
 * is a self-describing file in `cognition/extractors/`, discovered rather than
 * enumerated. Every health surface built on it so far was HAND-LISTED — `/boot`
 * §4.10 carried embedded `sqlite3` for two of seven instances by name — and a
 * hand-list over an open registry cannot report on the members nobody
 * remembered to list. Seven instances existed; five went silent for four weeks
 * and the outage was found only because an operator ran SQL by hand.
 *
 * So the roster here is DERIVED end to end: each instance declares a `health`
 * block (a REQUIRED field on the `CognitionInstance` contract), the brain
 * projects `registry.all()` into `cognition_instances` at every boot, and this
 * verb reads that projection. A new extractor appears in `/boot` and `/scan`
 * with zero edit to either.
 *
 * WHY A CLI VERB AND NOT AN MCP TOOL. `igris_event_log` routes to the REMOTE
 * brain and would miss this machine's local-only runs — the TD-080 finding that
 * both skills already cite. The health question is intrinsically about THIS
 * machine, so it is a local read.
 *
 * WHY NOT THE IN-PROCESS `bootEngine` DOOR (FR-241). That boots a WRITE-capable
 * engine and runs migrations, including `monitoring`'s 30-day `event_log`
 * purge. Asking a question must not mutate the brain — and must certainly not
 * destroy the very evidence it is asking about. Every read here goes through
 * `openBrainReadonly` (`{readonly:true, fileMustExist:true}` + `query_only=ON`).
 *
 * Channel: LOCAL. No network. Exit 0 ALWAYS — a health digest never blocks
 * session start; `degraded` tells the skill whether to render anything.
 */

import { existsSync, readFileSync } from "node:fs";
import { readMachineIdentity, type MachineIdentity } from "../lib/machine-identity.js";
import {
  JUDGED_CHANNELS,
  parseProducedPredicate,
  readChannelTotals,
  readCognitionRoster,
  readEventLogFloor,
  readInstanceRunSignals,
  judgmentModelBound,
  readJudgmentEventCounts,
  readOutputCounts,
  readProducedDisposition,
  readScheduleSignals,
  readUnclaimedDisposition,
  siblingKey,
  type CognitionProducedDisposition,
  type CognitionRosterRow,
  type CognitionScheduleRead,
  type ProducedPredicate,
  type ProducedSiblingLiterals,
} from "../lib/brain-db.js";
import { configJsonPath } from "../lib/paths.js";
import type {
  CognitionHealthDigest,
  CognitionHealthStatus,
  CognitionInstanceHealth,
  CognitionInstanceYield,
  CognitionRate,
  CognitionScheduleSignal,
  CognitionYieldChannelSummary,
  CognitionYieldDigest,
} from "../types.js";

/**
 * The `event_log` retention window `monitoring/index.ts` enforces on every
 * engine init (`DELETE FROM event_log WHERE created_at < datetime('now','-30
 * days')`). Mirrored here as a LITERAL because the digest must state the window
 * a `no_signal` verdict is bounded by — without it, an operator reads
 * "no signal" as "never ran" and retires a working instance.
 */
const EVENT_LOG_RETENTION_DAYS = 30;

export interface CognitionHealthOptions {
  /** Emit JSON to stdout (default ON — this is a machine surface). */
  json?: boolean;
  /** Identity override for tests (BR-100). */
  identity?: MachineIdentity;
}

// ---------------------------------------------------------------------------
// Gate resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a dotted `config.json` path to a value, or `undefined` when any
 * segment is absent.
 *
 * This deliberately does NOT re-implement the brain's config resolvers. The
 * instance DECLARES which key gates it and this reads exactly that key — so
 * when the brain moves a gate, the declaration moves with it and this code does
 * not need to know. It does not reproduce the "an absent key is false"
 * convention either, because that convention has an exception: perception's
 * default is ON, so the instance declares its own `gate_default` and this
 * resolves against it.
 */
function resolveDottedKey(
  config: Record<string, unknown>,
  dotted: string,
): unknown {
  let cursor: unknown = config;
  for (const segment of dotted.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** Read `~/.igris/config.json`; an absent/unparseable file is an empty config. */
function readConfig(): Record<string, unknown> {
  const path = configJsonPath();
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Evaluate an instance's declared gate CONJUNCTION.
 *
 * Every declared key must resolve to `true`. Returns the FIRST key that did
 * not, which is what lets the digest say *"cartographer is off because
 * `cognition.janitor.cluster.enabled` is false"* rather than the useless
 * *"cartographer is off"* — the cartographer's two gates mean two very
 * different remedies.
 */
function evaluateGates(
  config: Record<string, unknown>,
  gateKeys: string[],
  gateDefault: boolean,
): { enabled: boolean; disabled_by: string | null } {
  // An instance that declares NO gate cannot be reported as disabled and would
  // render permanently green. The contract test rejects that shape brain-side;
  // here it degrades to "not enabled" rather than to a false all-clear.
  if (gateKeys.length === 0) {
    return { enabled: false, disabled_by: "(no gate declared)" };
  }
  for (const key of gateKeys) {
    const value = resolveDottedKey(config, key);
    // An ABSENT key falls back to the instance's DECLARED default; a PRESENT
    // key must be the boolean `true`. A present-but-wrong-typed value (the
    // string "yes") is not a gate that is on — it is a config error, and
    // treating it as on would silently honour a typo.
    const on = value === undefined ? gateDefault : value === true;
    if (!on) {
      return { enabled: false, disabled_by: key };
    }
  }
  return { enabled: true, disabled_by: null };
}

// ---------------------------------------------------------------------------
// Signal shaping
// ---------------------------------------------------------------------------

/** Whole days between `iso` and now, one decimal. Null when unparseable. */
function ageInDays(iso: string | null, now: number): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.round(((now - t) / 86_400_000) * 10) / 10;
}

/** True when `iso` is a parseable timestamp strictly in the past. */
function isPast(iso: string | null, now: number): boolean {
  if (iso === null) return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t < now;
}

/** Shape the raw schedule read into the digest's schedule block. */
function shapeSchedule(
  name: string,
  read: CognitionScheduleRead,
  now: number,
): CognitionScheduleSignal {
  return {
    name,
    rows: read.rows,
    enabled: read.enabled,
    next_run_at: read.next_run_at,
    overdue: isPast(read.next_run_at, now),
    open_run_id: read.open_run_id,
    open_run_started_at: read.open_run_started_at,
    open_run_age_days: ageInDays(read.open_run_started_at, now),
  };
}

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

/** The inputs one instance's verdict is computed from. */
interface ClassifierInput {
  enabled: boolean;
  disabled_by: string | null;
  driver: string;
  schedule: CognitionScheduleSignal | null;
  last_terminal_name: string | null;
  last_terminal_at: string | null;
  /** TD-447 — the latest terminal row's `payload.reason` / `payload.detail`, when it carries them. */
  last_terminal_reason: string | null;
  last_terminal_detail: string | null;
  /** The verdict already computed for this instance's `driver_ref`, if any. */
  upstream: { id: string; status: CognitionHealthStatus } | null;
  retentionFloor: string | null;
}

/**
 * The first sentence of `s` — a terminal mark followed by whitespace or the end,
 * so a dotted hostname (`status.claude.com`) does not split it — with the mark
 * stripped, capped at 160 chars. `/boot` renders "the first sentence of reason",
 * so what this returns is what the operator reads (TD-447).
 */
function firstSentence(s: string): string {
  const m = /^(.*?[.!?])(?:\s|$)/.exec(s);
  return (m ? m[1] : s).replace(/[.!?]$/, "").slice(0, 160);
}

/**
 * Classify ONE instance. Precedence order is the table in
 * `types.ts:CognitionHealthStatus` and it matters: a co-driven instance whose
 * driver is wedged must read `blocked_upstream`, not `no_signal`. Reporting it
 * as `no_signal` is the brief's own original mistake — it points an operator at
 * the silent instance instead of at the one thing actually broken.
 */
function classify(input: ClassifierInput): {
  status: CognitionHealthStatus;
  reason: string;
} {
  if (!input.enabled) {
    return {
      status: "disabled",
      reason: `gate ${input.disabled_by} is not true in config.json`,
    };
  }

  if (input.driver === "schedule" && input.schedule !== null) {
    const s = input.schedule;
    if (s.rows === 0) {
      return {
        status: "no_signal",
        reason: `no schedules row named ${s.name} — the bootstrap has not run on this machine`,
      };
    }
    if (s.enabled && s.open_run_id !== null) {
      const age =
        s.open_run_age_days === null ? "unknown" : `${s.open_run_age_days}`;
      const overdue = s.overdue ? `, next_run_at ${s.next_run_at} is in the past` : "";
      return {
        status: "wedged",
        reason:
          `${s.name} has an OPEN run ${s.open_run_id} ${age} days old${overdue}. ` +
          "The daemon's overlap guard refuses to fire while any run is 'running', " +
          "so this schedule cannot fire again until the row reaches a terminal status.",
      };
    }
  }

  if (input.driver === "co_driven" && input.upstream !== null) {
    const up = input.upstream;
    if (up.status === "wedged" || up.status === "disabled" || up.status === "failing") {
      return {
        status: "blocked_upstream",
        reason:
          `runs only inside a ${up.id} run, and ${up.id} is ${up.status}. ` +
          "It has no switch or schedule of its own — fix the driver, not this instance.",
      };
    }
  }

  if (input.last_terminal_name !== null && input.last_terminal_at !== null) {
    if (input.last_terminal_name.endsWith(".run_failed")) {
      // TD-447: lead with the failure's own class and the first sentence of its
      // detail (`api_error: API Error: 529 Overloaded. `), so the render rule
      // "first sentence of reason" shows the CAUSE. Generic — a `timeout` row
      // reads `timeout: timeout after 300000ms. ` the same way. The legacy
      // sentence follows verbatim; a row with no payload reason renders it alone.
      const head =
        input.last_terminal_reason === null
          ? ""
          : `${input.last_terminal_reason}${
              input.last_terminal_detail === null ? "" : `: ${firstSentence(input.last_terminal_detail)}`
            }. `;
      return {
        status: "failing",
        reason: `${head}latest terminal event on this host is ${input.last_terminal_name} at ${input.last_terminal_at}, with no later success`,
      };
    }
    return {
      status: "ok",
      reason: `latest terminal event on this host is ${input.last_terminal_name} at ${input.last_terminal_at}`,
    };
  }

  // NOT "never ran". `event_log` is purged at 30 days, so absence of a row is
  // absence of EVIDENCE. The reason names the window and the floor so nobody
  // retires a working instance on this verdict.
  const floor =
    input.retentionFloor === null
      ? "the retained window"
      : `${input.retentionFloor} (the oldest retained row)`;
  return {
    status: "no_signal",
    reason:
      `enabled, but no terminal event on this host since ${floor}. ` +
      `event_log is purged at ${EVENT_LOG_RETENTION_DAYS} days, so this means ` +
      "'silent for at least that long' — NOT 'never ran'.",
  };
}

// ---------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------

/**
 * Build the health digest.
 *
 * Two passes over the roster, deliberately: the second pass needs the FIRST
 * pass's verdicts to resolve `blocked_upstream`. A co-driven instance's driver
 * is named by `driver_ref` (an instance id), so the lookup is derived — no
 * `if (id === 'arbiter')` anywhere.
 */
export function buildCognitionHealthDigest(
  opts: CognitionHealthOptions = {},
): CognitionHealthDigest {
  const me = opts.identity ?? readMachineIdentity();
  const host = me.hostname;
  const now = Date.now();
  const warnings: string[] = [];

  const roster = readCognitionRoster();
  if (roster.degraded) {
    return {
      degraded: true,
      degraded_reason: roster.reason,
      hostname: host,
      event_log_retention_days: EVENT_LOG_RETENTION_DAYS,
      event_log_oldest_at: null,
      instances: [],
      warnings,
    };
  }

  // A READABLE roster can still carry a fidelity note (e.g. it was projected by
  // a brain build predating a column this CLI knows about). That is a WARNING,
  // not a degradation: every verdict below is still computed, but the operator
  // is told which input was reduced. Folding it into `degraded` would suppress
  // the whole surface over a partial loss.
  if (roster.reason !== null) warnings.push(roster.reason);

  const config = readConfig();
  const retentionFloor = readEventLogFloor();

  // --- Pass 1: everything that does not depend on another instance's verdict.
  interface Partial1 {
    row: CognitionRosterRow;
    enabled: boolean;
    disabled_by: string | null;
    schedule: CognitionScheduleSignal | null;
    signals: ReturnType<typeof readInstanceRunSignals>;
  }

  const pass1: Partial1[] = roster.rows.map((row) => {
    const { enabled, disabled_by } = evaluateGates(
      config,
      row.gate_keys,
      row.gate_default,
    );

    let schedule: CognitionScheduleSignal | null = null;
    if (row.driver === "schedule" && row.driver_ref !== null) {
      const read = readScheduleSignals(row.driver_ref);
      schedule = shapeSchedule(row.driver_ref, read, now);
      if (schedule.rows > 1) {
        warnings.push(
          `duplicate schedule rows named ${schedule.name} (${schedule.rows}) — ` +
            "the bootstrap de-duplicates by NAME while the table syncs by a " +
            "per-machine random id, so each brain keeps its own row",
        );
      }
    }

    return {
      row,
      enabled,
      disabled_by,
      schedule,
      // The LITERALS out of the roster — never `cognition.${row.id}`.
      signals: readInstanceRunSignals(row.component, row.event_prefix, me),
    };
  });

  // Provisional verdicts, so pass 2 can resolve upstream state.
  const provisional = new Map<string, CognitionHealthStatus>();
  for (const p of pass1) {
    provisional.set(
      p.row.id,
      classify({
        enabled: p.enabled,
        disabled_by: p.disabled_by,
        driver: p.row.driver,
        schedule: p.schedule,
        last_terminal_name: p.signals.last_terminal_name,
        last_terminal_at: p.signals.last_terminal_at,
        last_terminal_reason: p.signals.last_terminal_reason,
        last_terminal_detail: p.signals.last_terminal_detail,
        upstream: null,
        retentionFloor,
      }).status,
    );
  }

  // --- Pass 2: final verdicts, with upstream state available.
  //
  // STATED BOUND: this resolves ONE hop. Pass 1 computes provisional verdicts
  // with `upstream: null`, so an instance whose driver_ref is ITSELF
  // `blocked_upstream` would not be matched — it would see the upstream's
  // provisional verdict, not its final one. Vacuous today: `janitor` is the
  // only `driver_ref` and it is schedule-driven, so the chain is never deeper
  // than one. A future co-driven-by-a-co-driven instance needs a fixpoint loop
  // here, or it will silently report the wrong reason. Named so the next
  // instance author meets the limit instead of discovering it.
  const instances: CognitionInstanceHealth[] = pass1.map((p) => {
    const upstreamId = p.row.driver === "co_driven" ? p.row.driver_ref : null;
    const upstreamStatus =
      upstreamId !== null ? provisional.get(upstreamId) : undefined;

    const verdict = classify({
      enabled: p.enabled,
      disabled_by: p.disabled_by,
      driver: p.row.driver,
      schedule: p.schedule,
      last_terminal_name: p.signals.last_terminal_name,
      last_terminal_at: p.signals.last_terminal_at,
      last_terminal_reason: p.signals.last_terminal_reason,
      last_terminal_detail: p.signals.last_terminal_detail,
      upstream:
        upstreamId !== null && upstreamStatus !== undefined
          ? { id: upstreamId, status: upstreamStatus }
          : null,
      retentionFloor,
    });

    return {
      id: p.row.id,
      component: p.row.component,
      event_prefix: p.row.event_prefix,
      gate_keys: p.row.gate_keys,
      gate_default: p.row.gate_default,
      enabled: p.enabled,
      disabled_by: p.disabled_by,
      driver: p.row.driver,
      driver_ref: p.row.driver_ref,
      status: verdict.status,
      reason: verdict.reason,
      last_run_at: p.signals.last_terminal_at,
      last_outcome: p.signals.last_terminal_name,
      last_run_any_host: p.signals.last_terminal_any_host_at,
      runs_today: p.signals.runs_today,
      output: p.row.output,
      output_rows: readOutputCounts(p.row.output),
      schedule: p.schedule,
    };
  });

  return {
    degraded: false,
    degraded_reason: null,
    hostname: host,
    event_log_retention_days: EVENT_LOG_RETENTION_DAYS,
    event_log_oldest_at: retentionFloor,
    instances,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// TD-423 — `igris cognition yield`
// ---------------------------------------------------------------------------

/**
 * Channels whose verdict path can HARD-delete, making `produced` a SURVIVING-row
 * count. `learnings` qualifies: the common perception reject removes the row.
 * See {@link CognitionInstanceYield.produced_is_surviving_count}.
 */
const HARD_DELETING_CHANNELS = new Set(["learnings"]);

/** What `distinct_label_values` counts, and what it is not. */
const DISTINCT_LABEL_NOTE =
  "DISTINCT values of this channel's free-text label column across the rows this " +
  "instance produced. A LABEL-DRIFT / emission-cadence proxy, NOT a count of " +
  "distinct findings: the dedup signature that would answer that lives inside the " +
  "brain package and already ran on these rows. A high number means the instance " +
  "minted many labels, not that it found many things.";

/** The bounds every `event_log` judgment count carries. */
function judgmentEventNote(windowFloor: string | null, channel: string | null): string {
  const floor =
    windowFloor === null ? "the retained window" : `${windowFloor} (the oldest retained row)`;
  const hardDelete =
    channel !== null && HARD_DELETING_CHANNELS.has(channel)
      ? " And this channel HARD-deletes on its common reject path, so a rejection event can outnumber the surviving rejected rows."
      : "";
  return (
    `A LOWER BOUND, not a population. event_log is purged at ${EVENT_LOG_RETENTION_DAYS} days ` +
    `so nothing before ${floor} is knowable, and these emits went nowhere before ` +
    "FR-241 Phase 6b — nobody was listening, so the record starts when the listener did. " +
    "Reported ALONGSIDE the row-state counts and never reconciled into one number." +
    hardDelete
  );
}

/** Build a rate object — see {@link CognitionRate}. */
function rate(numerator: number, denominator: number, label: string): CognitionRate {
  return {
    numerator,
    denominator,
    denominator_label: label,
    value: denominator === 0 ? null : numerator / denominator,
  };
}

/** The yield shape for a row that could not be measured at all. */
function unmeasuredYield(
  id: string,
  instanceId: string | null,
  predicate: string,
  channel: string | null,
  reason: string,
): CognitionInstanceYield {
  return {
    id,
    instance_id: instanceId,
    produced_predicate: predicate,
    channel,
    measured: false,
    unmeasured_reason: reason,
    // NEVER 0 — "could not look" must stay distinct from "found none".
    produced_rows: null,
    produced_is_surviving_count:
      channel !== null && HARD_DELETING_CHANNELS.has(channel),
    kept: null,
    rejected_judged: null,
    judged: null,
    pending_live: null,
    pending_expired: null,
    expired_not_judged: null,
    first_produced_at: null,
    last_produced_at: null,
    distinct_label_values: null,
    distinct_label_note: null,
    judged_share_of_produced: null,
    keep_rate_of_judged: null,
    pending_share_of_queue: null,
    queue_table: null,
    expiry_share_of_produced: null,
    judgment_events: null,
  };
}

/** Shape one disposition read into the digest's per-instance yield block. */
function shapeYield(
  id: string,
  instanceId: string | null,
  predicate: string,
  channel: string,
  d: CognitionProducedDisposition,
  queuePending: number | null,
): CognitionInstanceYield {
  if (d.produced === null) {
    return unmeasuredYield(
      id,
      instanceId,
      predicate,
      channel,
      d.reason ?? `${channel} could not be read`,
    );
  }

  const judged = d.kept + d.rejected_judged;
  const pending = d.pending_live + d.pending_expired;
  const lapsed = d.expired + d.pending_expired;

  return {
    id,
    instance_id: instanceId,
    produced_predicate: predicate,
    channel,
    // AC-7. Zero verdicts is UNMEASURED, not a zero score; the reason names the
    // population so it reads as a denominator problem, not a quality verdict.
    measured: judged > 0,
    unmeasured_reason:
      judged > 0
        ? null
        : `no row this instance produced carries a verdict yet (${d.produced} produced, ${pending} still pending, ${lapsed} lapsed unjudged) — absence of verdicts is not a verdict`,
    produced_rows: d.produced,
    produced_is_surviving_count: HARD_DELETING_CHANNELS.has(channel),
    kept: d.kept,
    rejected_judged: d.rejected_judged,
    judged,
    pending_live: d.pending_live,
    pending_expired: d.pending_expired,
    expired_not_judged: d.expired,
    first_produced_at: d.first_produced_at,
    last_produced_at: d.last_produced_at,
    distinct_label_values: d.distinct_label_values,
    distinct_label_note: d.distinct_label_values === null ? null : DISTINCT_LABEL_NOTE,
    judged_share_of_produced: rate(
      judged,
      d.produced,
      HARD_DELETING_CHANNELS.has(channel)
        ? `rows this instance produced that SURVIVE in ${channel} (the common reject path hard-deletes)`
        : `rows this instance produced in ${channel}`,
    ),
    keep_rate_of_judged: rate(
      d.kept,
      judged,
      "rows this instance produced that carry a HUMAN verdict — a judged-subset rate, NOT a population rate",
    ),
    pending_share_of_queue: rate(
      pending,
      queuePending ?? 0,
      `all rows still awaiting a verdict in ${channel}, brain-wide`,
    ),
    queue_table: channel,
    expiry_share_of_produced: rate(
      lapsed,
      d.produced,
      `rows this instance produced in ${channel} — the share that LAPSED instead of being judged (never counted as a rejection)`,
    ),
    judgment_events: null,
  };
}

/**
 * Build the yield digest. THE DERIVATION SEAM IS STEP 2 — see
 * {@link CognitionYieldDigest}. Nothing here names an instance id.
 */
export function buildCognitionYieldDigest(
  opts: CognitionHealthOptions = {},
): CognitionYieldDigest {
  const host = (opts.identity ?? readMachineIdentity()).hostname;
  const warnings: string[] = [];

  const roster = readCognitionRoster();
  if (roster.degraded) {
    return {
      degraded: true,
      degraded_reason: roster.reason,
      hostname: host,
      event_log_retention_days: EVENT_LOG_RETENTION_DAYS,
      event_log_oldest_at: null,
      judged_channels: JUDGED_CHANNELS,
      channels: [],
      instances: [],
      warnings,
    };
  }
  if (roster.reason !== null) warnings.push(roster.reason);

  const retentionFloor = readEventLogFloor();

  // --- Step 1: parse every declaration. A parse failure is carried, not thrown.
  interface Parsed {
    row: CognitionRosterRow;
    predicate: ProducedPredicate | null;
    reason: string | null;
  }
  const parsed: Parsed[] = roster.rows.map((row) => {
    const expr = row.produced.trim();
    if (expr.length === 0) {
      return {
        row,
        predicate: null,
        reason:
          "this instance declares no `produced` predicate — either its roster row predates TD-423's cognition migration v2, or the instance shipped without the REQUIRED declaration",
      };
    }
    const p = parseProducedPredicate(expr);
    if (p === null) {
      // Two different failures, and the operator's next move differs: an
      // unknown table is a MODEL gap (add a judgment model), an unparseable
      // expression is a DECLARATION defect (fix the extractor).
      const table = /^([a-z_]+)\[/.exec(expr)?.[1] ?? null;
      const known = table !== null && JUDGED_CHANNELS.includes(table);
      return {
        row,
        predicate: null,
        reason: known
          ? `\`${expr}\` is not a parseable produced predicate — expected table[col='literal'] or table[col=literal, col2=OTHER]`
          : `\`${expr}\` names no output table this reader carries a judgment model for. The roster derivation is TOTAL over instances; the judgment model is a CLOSED set over tables (${JUDGED_CHANNELS.join(", ")}). Adding a table costs one reader edit; until then this is unmeasured, never zero.`,
      };
    }
    return { row, predicate: p, reason: null };
  });

  // --- Step 2 (THE AC-2 / AC-5 SEAM): resolve `OTHER` from the roster itself.
  // Collect every LITERAL any row declares per (table, column); a row declaring
  // `OTHER` is the complement of everyone else's — computed here, never listed.
  const siblings: ProducedSiblingLiterals = new Map();
  for (const p of parsed) {
    if (p.predicate === null) continue;
    for (const clause of p.predicate.clauses) {
      if (clause.kind !== "literal") continue;
      const key = siblingKey(p.predicate.table, clause.column);
      const bucket = siblings.get(key) ?? [];
      if (!bucket.includes(clause.value as string | number)) {
        bucket.push(clause.value as string | number);
      }
      siblings.set(key, bucket);
    }
  }

  // Two rows claiming the complement of the SAME pair would both count the same
  // rows, which breaks the reconciliation invariant. Say so rather than let the
  // sum quietly exceed the table.
  const otherClaims = new Map<string, string[]>();
  for (const p of parsed) {
    if (p.predicate === null) continue;
    for (const clause of p.predicate.clauses) {
      if (clause.kind !== "other") continue;
      const key = siblingKey(p.predicate.table, clause.column);
      otherClaims.set(key, [...(otherClaims.get(key) ?? []), p.row.id]);
    }
  }
  for (const [key, ids] of otherClaims) {
    if (ids.length > 1) {
      warnings.push(
        `${ids.join(" and ")} each declare OTHER on ${key} — they claim the SAME complement, so their produced counts overlap and the channel will not reconcile`,
      );
    }
  }

  // --- Step 3: per-instance dispositions, in registry order.
  const claimed: ProducedPredicate[] = parsed
    .map((p) => p.predicate)
    .filter((p): p is ProducedPredicate => p !== null);

  // The channels any instance actually declares AND this reader models — NOT
  // every allowlisted table. An `(unclaimed)` bucket for a table nothing in the
  // roster targets would be an invented finding; a channel summary for a table
  // with no judgment model would report `total_rows: null` and read as "not
  // readable in this brain", which is a wrong-but-plausible reason for a table
  // that reads fine and simply has no model yet.
  const declaredChannels = [...new Set(claimed.map((p) => p.table))];
  const activeChannels = declaredChannels.filter((tbl) => JUDGED_CHANNELS.includes(tbl));
  for (const tbl of declaredChannels) {
    if (!activeChannels.includes(tbl)) {
      warnings.push(
        `${tbl} is declared as an output table but this reader carries no judgment model for it — the derivation is total over instances, the judgment model is a CLOSED set over tables (${JUDGED_CHANNELS.join(", ")}). Every instance targeting it reports unmeasured until a model is added.`,
      );
    }
  }
  const totals = new Map(activeChannels.map((t) => [t, readChannelTotals(t)]));

  const instances: CognitionInstanceYield[] = [];
  const claimedRows = new Map<string, number>();

  for (const p of parsed) {
    if (p.predicate === null) {
      instances.push(
        unmeasuredYield(p.row.id, p.row.id, p.row.produced, null, p.reason as string),
      );
      continue;
    }
    const disposition = readProducedDisposition(p.predicate, siblings);
    const channel = p.predicate.table;
    const entry = shapeYield(
      p.row.id,
      p.row.id,
      p.row.produced,
      channel,
      disposition,
      totals.get(channel)?.pending ?? null,
    );

    // D6 — the parallel record, keyed on the roster's DECLARED literals. Never
    // `cognition.${id}`: perception writes under the bare `perception`, and a
    // derived namespace reports the one instance with a real review path as
    // having no judgments at all (the L-857 trap).
    const events = readJudgmentEventCounts(p.row.component, p.row.event_prefix);
    entry.judgment_events = {
      component: p.row.component,
      approved_event: events.approved_event,
      rejected_event: events.rejected_event,
      approved: events.approved,
      rejected: events.rejected,
      last_at: events.last_at,
      window_days: EVENT_LOG_RETENTION_DAYS,
      window_floor: retentionFloor,
      note: judgmentEventNote(retentionFloor, channel),
    };

    // The two records are never reconciled, but a DIVERGENCE is surfaced per
    // half, in the one direction no stated bound explains. `row-state > events`
    // is EXPECTED (30-day purge, and nobody listened before FR-241 Phase 6b) so
    // it is silent; `events > row-state` means a verdict was made that the row
    // does not show, and the warning names the cause or names its absence.
    const because = HARD_DELETING_CHANNELS.has(channel)
      ? `the common reject path on ${channel} HARD-deletes its row, so those verdicts survive only in event_log`
      : `${channel} does not hard-delete, so this is NOT explained by any stated bound — investigate before reading either number as a population`;
    if (events.rejected > (entry.rejected_judged ?? 0)) {
      warnings.push(
        `${p.row.id}: ${events.rejected} ${events.rejected_event} events but only ${entry.rejected_judged ?? 0} rejected row(s) survive in ${channel} — ${because}`,
      );
    }
    if (events.approved > (entry.kept ?? 0)) {
      warnings.push(
        `${p.row.id}: ${events.approved} ${events.approved_event} events but only ${entry.kept ?? 0} kept row(s) survive in ${channel} — ${because}`,
      );
    }

    if (!disposition.buckets_reconcile) {
      warnings.push(
        `${p.row.id}: the ${channel} disposition buckets do not sum to its produced count — some row carries a status outside the judgment model's vocabulary`,
      );
    }
    if (disposition.produced !== null) {
      claimedRows.set(channel, (claimedRows.get(channel) ?? 0) + disposition.produced);
    }
    instances.push(entry);
  }

  // --- Step 4: the unclaimed bucket per active channel, DERIVED as "rows no
  // roster predicate selects". No list of retired detector names lives here.
  const channels: CognitionYieldChannelSummary[] = [];
  for (const table of activeChannels) {
    const unclaimed = readUnclaimedDisposition(table, claimed, siblings);
    const total = totals.get(table) ?? { total: null, pending: null };
    const claimedCount = claimedRows.get(table) ?? null;

    if (unclaimed.produced !== null && unclaimed.produced > 0) {
      instances.push(
        shapeYield(
          `(unclaimed:${table})`,
          null,
          `${table}[NOT any registered instance's produced predicate]`,
          table,
          unclaimed,
          total.pending,
        ),
      );
    }

    const reconciled =
      total.total !== null &&
      claimedCount !== null &&
      unclaimed.produced !== null &&
      claimedCount + unclaimed.produced === total.total;

    channels.push({
      table,
      total_rows: total.total,
      claimed_rows: claimedCount,
      unclaimed_rows: unclaimed.produced,
      pending_rows: total.pending,
      reconciled,
    });

    if (!reconciled) {
      warnings.push(
        `${table} does not reconcile: claimed ${claimedCount ?? "?"} + unclaimed ${unclaimed.produced ?? "?"} != total ${total.total ?? "?"}. Every row must be attributable to exactly one bucket or the shares below are computed over a population that is not the table.`,
      );
    }
    if (total.total === null) {
      warnings.push(
        `${table} is declared as an output channel but is not readable in this brain — every instance targeting it reports unmeasured`,
      );
    }

    // The channel's STANDING bound, from the judgment model itself. Not an
    // anomaly — a rate on this channel means something specific and reading it
    // as something else is the whole failure class this brief is about.
    const bound = judgmentModelBound(table);
    if (bound !== null) warnings.push(bound);
  }

  // --- Step 5: the CONFIG-dependent bound — see `truthyAutoApplyKeys`.
  for (const key of truthyAutoApplyKeys(readConfig())) {
    warnings.push(
      `${key} is true — that instance applies its output DIRECTLY instead of writing a reviewable row, so its produced count UNDER-reports and its keep rate is computed over the reviewed remainder only`,
    );
  }

  return {
    degraded: false,
    degraded_reason: null,
    hostname: host,
    event_log_retention_days: EVENT_LOG_RETENTION_DAYS,
    event_log_oldest_at: retentionFloor,
    judged_channels: JUDGED_CHANNELS,
    channels,
    instances,
    warnings,
  };
}

/**
 * Every truthy `auto_*` leaf under the config's `cognition` subtree, as dotted
 * keys. An auto-apply switch bypasses the review queue, so the instance behind
 * it writes fewer reviewable rows than it produced. DERIVED, not hand-listed:
 * three such switches exist today and a fourth is covered for free.
 */
export function truthyAutoApplyKeys(config: Record<string, unknown>): string[] {
  const found: string[] = [];
  const walk = (node: unknown, path: string[]): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key.startsWith("auto_")) {
        if (value === true) found.push([...path, key].join("."));
        continue;
      }
      walk(value, [...path, key]);
    }
  };
  walk(config.cognition, ["cognition"]);
  return found.sort();
}

/** The verb's action set. Unknown action → exit 2 (the `session` precedent). */
export type CognitionAction = "health" | "yield";

/** The actions `runCognition` dispatches, in the order the error message lists. */
const COGNITION_ACTIONS: CognitionAction[] = ["health", "yield"];

export interface CognitionOptions extends CognitionHealthOptions {
  action: string;
}

/**
 * Run the cognition verb. Exit 0 for a successful digest (degraded or not);
 * exit 2 for an unknown action. `yield` is a separate ACTION, not a `--yield`
 * flag — see {@link CognitionYieldDigest} for the blast-radius argument.
 */
export function runCognition(opts: CognitionOptions): number {
  if (!(COGNITION_ACTIONS as string[]).includes(opts.action)) {
    process.stderr.write(
      `error: unknown cognition action "${opts.action}" (expected: ${COGNITION_ACTIONS.join(", ")})\n`,
    );
    return 2;
  }

  const digest =
    opts.action === "yield"
      ? buildCognitionYieldDigest(opts)
      : buildCognitionHealthDigest(opts);
  if (opts.json !== false) {
    process.stdout.write(JSON.stringify(digest) + "\n");
  }
  return 0;
}
