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
import { hostname } from "node:os";
import {
  readCognitionRoster,
  readEventLogFloor,
  readInstanceRunSignals,
  readOutputCounts,
  readScheduleSignals,
  type CognitionRosterRow,
  type CognitionScheduleRead,
} from "../lib/brain-db.js";
import { configJsonPath } from "../lib/paths.js";
import type {
  CognitionHealthDigest,
  CognitionHealthStatus,
  CognitionInstanceHealth,
  CognitionScheduleSignal,
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
  /** Hostname override, for tests. Default `os.hostname()`. */
  hostname?: string;
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
  /** The verdict already computed for this instance's `driver_ref`, if any. */
  upstream: { id: string; status: CognitionHealthStatus } | null;
  retentionFloor: string | null;
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
      return {
        status: "failing",
        reason: `latest terminal event on this host is ${input.last_terminal_name} at ${input.last_terminal_at}, with no later success`,
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
  const host = opts.hostname ?? hostname();
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
      signals: readInstanceRunSignals(row.component, row.event_prefix, host),
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

/** The verb's action set. Unknown action → exit 2 (the `session` precedent). */
export type CognitionAction = "health";

export interface CognitionOptions extends CognitionHealthOptions {
  action: string;
}

/**
 * Run the cognition verb. Exit 0 for a successful digest (degraded or not);
 * exit 2 for an unknown action.
 */
export function runCognition(opts: CognitionOptions): number {
  if (opts.action !== "health") {
    process.stderr.write(
      `error: unknown cognition action "${opts.action}" (expected: health)\n`,
    );
    return 2;
  }

  const digest = buildCognitionHealthDigest(opts);
  if (opts.json !== false) {
    process.stdout.write(JSON.stringify(digest) + "\n");
  }
  return 0;
}
