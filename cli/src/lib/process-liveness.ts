import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { HARNESS_PROCESS_TABLE, inferHarness } from "./detect.js";
import type { InstanceLivenessStatus, InstanceRow } from "../types.js";

export interface OwnerProcess {
  pid: number;
  started_at: string;
}

/** One row of the {@link readProcessTable} snapshot. */
export interface ProcessTableEntry {
  ppid: number;
  comm: string;
}

/**
 * The exact columns {@link classifyInstanceLiveness} reads. Naming them makes
 * the liveness contract's input surface explicit, and lets a WRITER classify a
 * row it is about to insert (which has no id yet) through the same code path
 * every READER uses (TD-411 / D-411-d). A full `InstanceRow` satisfies it.
 */
export type InstanceLivenessInputs = Pick<
  InstanceRow,
  "machine_hostname" | "owner_pid" | "owner_started_at"
>;

export interface InstanceLiveness {
  status: InstanceLivenessStatus;
  checked_at: string;
  method: string;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function getProcessStartTime(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

/**
 * Parse a `ps -Ao pid=,ppid=,comm=` snapshot into a pid-keyed table.
 *
 * PURE and exported so the parse is testable against a LITERAL fixture line
 * instead of against whatever the host happens to be running. That split is
 * not cosmetic: the space-comm property below is an accident of the machine
 * the suite runs on, so a test that iterates the LIVE snapshot cannot fail on
 * a host that has no space-comm row — which is exactly how a truncating
 * parser ships green (found in review, TD-411 round 1).
 *
 * Parsing note (measured, not assumed): on darwin `comm` is frequently an
 * absolute path, and 41 of 610 live rows carried a path containing SPACES. So
 * only the first two whitespace-separated fields are split — the remainder of
 * the line is the comm, verbatim. Both plausible simplifications LOSE those
 * rows: a 3-way `split(/\s+/)` truncates the comm at its first space, and
 * anchoring the third group as `(\S+)$` drops the line entirely. The fixture
 * test in `process-liveness.test.ts` reddens under both.
 *
 * Returns `null` on an empty or wholly unparseable snapshot, so
 * {@link readProcessTable} has exactly one degrade path.
 */
export function parseProcessTable(
  text: string,
): Map<number, ProcessTableEntry> | null {
  const table = new Map<number, ProcessTableEntry>();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (m === null) continue;
    const pid = Number.parseInt(m[1], 10);
    const ppid = Number.parseInt(m[2], 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    table.set(pid, { ppid, comm: m[3].trim() });
  }
  return table.size > 0 ? table : null;
}

/**
 * Snapshot the whole process tree in ONE `ps` call, parsed by
 * {@link parseProcessTable}.
 *
 * One call, not N: an ancestor walk of depth d would otherwise pay d × the 2s
 * timeout. Returns `null` on ANY failure (`ps` absent, non-zero exit, timeout,
 * unparseable output, empty table) so every caller has exactly one degrade
 * path and this never throws.
 */
export function readProcessTable(): Map<number, ProcessTableEntry> | null {
  let out: string;
  try {
    out = execFileSync("ps", ["-Ao", "pid=,ppid=,comm="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }

  return parseProcessTable(out);
}

/**
 * Walk `table` upward from `startPid` and return the pid of the first process
 * at-or-above it whose `comm` matches `matcher` — or `null`.
 *
 * Pure and injectable (the table is a parameter, not a `ps` call) so the walk
 * is unit-testable against a fabricated tree without spawning processes.
 *
 * `startPid` itself is tested. Callers pass the CLI's own pid, which can never
 * match a harness matcher, so this only makes the contract simpler to state.
 *
 * Returns `null` — never a guess — on every terminal condition: reaching pid 1
 * or 0, a pid absent from the table (the process exited between the snapshot
 * and the walk), a parent cycle, or exceeding `maxHops`.
 */
export function findHarnessAncestor(
  table: ReadonlyMap<number, ProcessTableEntry>,
  startPid: number,
  matcher: RegExp,
  maxHops = 12,
): number | null {
  const seen = new Set<number>();
  let pid = startPid;
  for (let hop = 0; hop < maxHops; hop++) {
    if (pid <= 1) return null;
    if (seen.has(pid)) return null;
    seen.add(pid);
    const entry = table.get(pid);
    if (entry === undefined) return null;
    if (matcher.test(entry.comm)) return pid;
    pid = entry.ppid;
  }
  return null;
}

/**
 * Resolve the process that OWNS this session — i.e. the long-lived harness
 * process, NOT the shell that happened to run the CLI.
 *
 * That distinction is the whole of TD-411. Every harness tool call spawns a
 * fresh short-lived shell, so a pid recorded from `process.ppid` is already
 * dead by the time any reader checks it: every instance classified `dead`,
 * including the one actively running.
 *
 * Resolution order. A tier's failure falls to the NEXT tier, never to a guess
 * — with ONE deliberate exception, at tier 1:
 *
 *  1. `IGRIS_INSTANCE_OWNER_PID` — the explicit override. Retained as the
 *     escape hatch for a wrapper or CI that genuinely knows the owning pid.
 *     Nothing in Igris sets it (a hook is a subprocess; its env does not reach
 *     a later tool call), so it is an override, not the mechanism.
 *     Its two failure modes do NOT share a destination. An ABSENT or
 *     UNPARSEABLE value falls through to tier 2 in the ordinary way — there is
 *     no operator intent to honour in a value that does not parse. A value
 *     that PARSES but names a dead pid is THE EXCEPTION: it returns `null`
 *     without running the walk, because substituting a walked pid for an
 *     override the operator deliberately set is itself a wrong-but-plausible
 *     answer. Pinned by the DEAD-pid test in `process-liveness.test.ts`.
 *  2. The harness-ancestor walk — infer the harness from `env`'s markers, look
 *     up its `comm` matcher in {@link HARNESS_PROCESS_TABLE}, snapshot the
 *     process tree once, and walk upward from this process.
 *  3. `null`.
 *
 * A `null` return is a DEFINED unknown, not an error: the caller records no
 * owner metadata, `classifyInstanceLiveness` returns `unknown_no_metadata`, and
 * `buildGatherDigest` routes that to `siblings[]` — noise, never a false crash
 * (D-411-c). Every walk failure lands here: an unmeasured harness (no table
 * entry), a bare-terminal run with no harness markers, `ps` unavailable, a
 * renamed harness process, or a harness that is not an ancestor at all — plus
 * the tier-1 dead-override exception above, which reaches `null` without
 * walking at all.
 *
 * NEVER reintroduce a `process.ppid` fallback. A wrong-but-plausible pid is
 * worse than no pid: it reads as a measurement and fails silently.
 */
export function resolveOwnerProcess(
  env: NodeJS.ProcessEnv = process.env,
): OwnerProcess | null {
  // Tier 1 — the explicit override. Two failure modes, two DIFFERENT
  // destinations (measured against the built dist, not assumed):
  //
  //   - ABSENT or UNPARSEABLE — `parsePositiveInt` returns null, so the guard
  //     below is false and control reaches TIER 2. Verified by comparing the
  //     result against the no-override tier-2 control: identical pid.
  //   - PARSES but names a DEAD pid — `getProcessStartTime` returns null and
  //     this returns null WITHOUT running the walk. An operator who named a
  //     real pid meant it, and silently substituting a walked pid is the
  //     failure mode this brief exists for.
  //
  // `Number.parseInt` is lenient and that leniency is load-bearing here:
  // "<pid>abc" parses to <pid> and is treated as an override, NOT as
  // unparseable. Only a value with no leading digits (or a non-positive one)
  // reaches tier 2.
  const explicit = parsePositiveInt(env.IGRIS_INSTANCE_OWNER_PID);
  if (explicit !== null) {
    const explicitStartedAt = getProcessStartTime(explicit);
    return explicitStartedAt
      ? { pid: explicit, started_at: explicitStartedAt }
      : null;
  }

  // Tier 2 — the harness-ancestor walk.
  const harness = inferHarness(env);
  const entry = HARNESS_PROCESS_TABLE.find(([id]) => id === harness);
  if (entry === undefined) return null;

  const table = readProcessTable();
  if (table === null) return null;

  const pid = findHarnessAncestor(table, process.pid, entry[1]);
  if (pid === null) return null;

  // Read the start time through the SAME helper the classifier uses, so the
  // stored `owner_started_at` is byte-identical to what a reader re-derives —
  // otherwise every row would classify `dead_pid_reused` on a format mismatch.
  const startedAt = getProcessStartTime(pid);
  return startedAt ? { pid, started_at: startedAt } : null;

  // Tier 3 — null, reached by every `return null` above.
}

export function classifyInstanceLiveness(
  row: InstanceLivenessInputs,
  localHostname = hostname(),
): InstanceLiveness {
  const checkedAt = new Date().toISOString().replace("T", " ").substring(0, 19);

  if (row.machine_hostname !== localHostname) {
    return {
      status: "unknown_remote",
      checked_at: checkedAt,
      method: "remote",
    };
  }

  if (
    typeof row.owner_pid !== "number" ||
    !Number.isInteger(row.owner_pid) ||
    row.owner_pid <= 0 ||
    row.owner_started_at === null ||
    row.owner_started_at === undefined
  ) {
    return {
      status: "unknown_no_metadata",
      checked_at: checkedAt,
      method: "none",
    };
  }

  if (!isProcessAlive(row.owner_pid)) {
    return {
      status: "dead",
      checked_at: checkedAt,
      method: "pid_start_time",
    };
  }

  const currentStartedAt = getProcessStartTime(row.owner_pid);
  if (currentStartedAt === null || currentStartedAt !== row.owner_started_at) {
    return {
      status: "dead_pid_reused",
      checked_at: checkedAt,
      method: "pid_start_time",
    };
  }

  return {
    status: "alive",
    checked_at: checkedAt,
    method: "pid_start_time",
  };
}
