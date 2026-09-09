import { basenameOfCwd } from "../lib/sync/util.js";
import { detectCapabilities } from "../lib/detect.js";
import {
  instanceRemove,
  instanceStateUpdate,
  listInstances,
} from "../lib/brain-db.js";
import { classifyInstanceLiveness } from "../lib/process-liveness.js";

export type InstanceAction = "list" | "state" | "deregister";

export interface InstanceOptions {
  action: InstanceAction;
  project?: string;
  instanceId?: string;
  currentBrief?: string;
  currentPhase?: string;
  currentTask?: string;
  leaseMinutes?: number;
  json?: boolean;
}

const VALID_ACTIONS: ReadonlySet<string> = new Set([
  "list",
  "state",
  "deregister",
]);

function leaseExpiry(minutes: number | undefined): string | null | undefined {
  if (minutes === undefined) return undefined;
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return new Date(Date.now() + minutes * 60_000)
    .toISOString()
    .replace("T", " ")
    .substring(0, 19);
}

export function runInstance(opts: InstanceOptions): number {
  if (!VALID_ACTIONS.has(opts.action)) {
    process.stderr.write(
      `error: unknown instance action '${opts.action}'. Valid: list, state, deregister.\n`,
    );
    return 2;
  }

  const caps = detectCapabilities();
  if (!caps.brain_db) {
    const out = { degraded: true, instances: [], updated: false, removed: false };
    process.stdout.write(JSON.stringify(out) + "\n");
    return 0;
  }

  const slug = opts.project ?? basenameOfCwd();

  if (opts.action === "list") {
    // D-411-d, producer side. The three `liveness_*` COLUMNS are a
    // last-observed stamp; `classifyInstanceLiveness` is the answer. Spreading
    // the row and merely ADDING `liveness` would emit both — a payload that
    // carries the stale `liveness_status` beside the fresh `liveness.status`,
    // which is a wrong-but-plausible answer sitting one key away from the right
    // one. `core/skills/hunt/SKILL.md` step 6 renders `{liveness_status}` by
    // exactly that name, so the leak was reachable: an exited harness could be
    // advertised as a live sibling holding a brief.
    //
    // OVERWRITE rather than omit, deliberately. Omitting the stored keys would
    // also make the payload self-consistent, but it would leave every consumer
    // that names `liveness_status` resolving nothing — and a template with an
    // unresolvable slot is filled by improvisation, which is the same failure
    // class in a new costume. Overwriting makes the key MEAN what its readers
    // already assume it means, so no skill, dashboard or downstream reader
    // needs an edit, present or future. The stamp keys stay in the payload
    // shape (a superset of `InstanceRow`) and `liveness` remains the explicit,
    // structured form for a reader that wants to be unambiguous.
    //
    // The overrides MUST stay after the spread. Re-ordering them restores the
    // defect, and TWO independent guards catch it. `tsc` is the first and is
    // unconditional: `InstanceRow` declares all three stamp fields
    // (`cli/src/types.ts:187-189`), so overrides placed above `...row` would be
    // overwritten by the spread and the compiler reports TS2783 — measured, not
    // assumed. `instance-verb.test.ts` is the second and is independent of the
    // first: it reds if either the values or the `liveness_*` key SET stops
    // matching the derived classification, and it would still catch the
    // re-order if the type ever stopped declaring those fields.
    const rows = listInstances({
      project: slug,
      status: "all",
      includeStale: true,
    }).map((row) => {
      const liveness = classifyInstanceLiveness(row);
      return {
        ...row,
        liveness_status: liveness.status,
        liveness_method: liveness.method,
        liveness_checked_at: liveness.checked_at,
        liveness,
      };
    });
    process.stdout.write(JSON.stringify({ degraded: false, instances: rows }) + "\n");
    return 0;
  }

  if (!opts.instanceId) {
    process.stderr.write(`error: instance ${opts.action} requires --instance-id.\n`);
    return 2;
  }

  if (opts.action === "deregister") {
    const removed = instanceRemove(opts.instanceId);
    process.stdout.write(JSON.stringify({ degraded: false, removed }) + "\n");
    return 0;
  }

  const updated = instanceStateUpdate({
    instance_id: opts.instanceId,
    project_slug: slug,
    current_brief: opts.currentBrief,
    current_phase: opts.currentPhase,
    current_task: opts.currentTask,
    lease_expires_at: leaseExpiry(opts.leaseMinutes),
    status: "active",
  });
  process.stdout.write(JSON.stringify({ degraded: false, updated }) + "\n");
  return 0;
}
