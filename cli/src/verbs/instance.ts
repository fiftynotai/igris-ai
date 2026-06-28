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
    const rows = listInstances({
      project: slug,
      status: "all",
      includeStale: true,
    }).map((row) => ({
      ...row,
      liveness: classifyInstanceLiveness(row),
    }));
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
