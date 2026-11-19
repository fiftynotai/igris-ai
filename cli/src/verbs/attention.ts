/** FR-276: explicit local session identity, resource delivery, and correlated calls. */
import { readFileSync, statSync } from "node:fs";
import { attentionAction, attentionCall, attentionInventory, attentionSessions, attentionSnapshot } from "../lib/attention-bridge.js";
import { readMachineIdentity } from "../lib/machine-identity.js";
import type { AttentionSnapshot } from "../types.js";
export interface AttentionOptions {
  action: string;
  session?: string;
  project?: string;
  instanceId?: string;
  harness?: string;
  harnessSessionId?: string;
  parentSession?: string;
  actor?: string;
  operation?: string;
  eventKey?: string;
  reason?: string;
  selection?: string;
  selectionRef?: string;
  type?: string;
  id?: string;
  kind?: string;
  outcome?: string;
  extent?: string;
  sourceRevision?: string;
  bytes?: string;
  maxBytes?: string;
  status?: string;
  tool?: string;
  argsFile?: string;
  through?: string;
  before?: string;
  limit?: string;
}
export const ATTENTION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** An Igris instance id names a scratchpad file, so it is never path-shaped (session register uses the same rule). */
export const INSTANCE_ID = /^[a-zA-Z0-9_-]{1,256}$/;
export function attentionInteger(value: string | undefined, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined)
    return undefined;
  if (!/^\d+$/.test(value))
    throw new Error("expected an integer");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(`integer outside ${min}–${max}`);
  return n;
}
function print(value: unknown): void { process.stdout.write(JSON.stringify(value) + "\n"); }
/**
 * The brain also states a bounded snapshot as degradation (attention read.ts), so
 * older readers never drop activity silently. A snapshot whose ONLY degradation is
 * that exact sentence is healthy for the exit code; exit 3 means unavailable.
 */
export function attentionSnapshotBoundedOnly(snapshot: AttentionSnapshot): boolean {
  if (!snapshot.truncated || !snapshot.degraded)
    return false;
  const c = snapshot.counts;
  return snapshot.degraded.reason === `Snapshot bounded: ${c.node_states} of ${c.nodes_reduced} recorded nodes from the newest ${c.events_reduced} of ${c.events_total} events; older evidence is in history.`;
}
export async function runAttention(opts: AttentionOptions): Promise<number> {
  const actions = ["begin", "bind", "event", "epoch", "end", "show", "sessions", "inventory", "read", "call"];
  let input: Record<string, unknown>;
  try {
    if (!actions.includes(opts.action))
      throw new Error(`unknown action; expected ${actions.join(", ")}`);
    if (!["begin", "sessions", "inventory"].includes(opts.action) && !opts.session)
      throw new Error("--session is required");
    for (const id of [opts.session, opts.parentSession])
      if (id !== undefined && !ATTENTION_UUID.test(id))
        throw new Error("session identity must be a UUID");
    if (opts.project !== undefined && !/^[a-zA-Z0-9_-]+$/.test(opts.project))
      throw new Error("invalid project slug");
    if (opts.instanceId !== undefined && !INSTANCE_ID.test(opts.instanceId))
      throw new Error("--instance-id must be 1–256 letters, digits, underscores or hyphens");
    if (opts.selection !== undefined || opts.selectionRef !== undefined) {
      if (!["read", "call", "event"].includes(opts.action))
        throw new Error("selection flags apply only to read, call or event");
      if (!opts.selection || !["boot", "task", "retrieval", "user_request"].includes(opts.selection))
        throw new Error("--selection must be boot, task, retrieval or user_request");
      if (opts.selectionRef !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(opts.selectionRef) || /[\r\n]/.test(opts.selectionRef)))
        throw new Error("--selection-ref must be an identifier of 1–128 letters, digits, colons, underscores or hyphens");
    }
    const selection = opts.selection === undefined ? undefined : {
      category: opts.selection,
      ...(opts.selectionRef === undefined ? {} : { reference: opts.selectionRef }),
    };
    const limit = attentionInteger(opts.limit, 1, 100), through = attentionInteger(opts.through, 0), before = opts.action === "sessions" ? opts.before : attentionInteger(opts.before, 1);
    input = Object.fromEntries(Object.entries({
      session_id: opts.session, project: opts.project, instance_id: opts.instanceId,
      harness: opts.harness, harness_session_id: opts.harnessSessionId, parent_session_id: opts.parentSession,
      actor_id: opts.actor, operation_id: opts.operation, reason: opts.reason, selection
    }).filter(([, v]) => v !== undefined));
    if (opts.action === "show") {
      const result = await attentionSnapshot({ session_id: opts.session, through_sequence: through, before, limit });
      print(result);
      return result.degraded && !attentionSnapshotBoundedOnly(result) ? 3 : result.session ? 0 : 1;
    }
    if (opts.action === "sessions") {
      if (opts.before && !ATTENTION_UUID.test(opts.before))
        throw new Error("sessions cursor must be a UUID");
      if (opts.before) {
        const cursor = await attentionSnapshot({ session_id: opts.before });
        if (!cursor.session && !cursor.degraded)
          throw new Error("unknown sessions cursor");
      }
      const result = await attentionSessions({ project: opts.project, before, limit });
      print(result);
      return result.degraded ? 3 : 0;
    }
    if (opts.action === "inventory") {
      const result = await attentionInventory(opts.project);
      print(result);
      return result.degraded ? 3 : 0;
    }
    if (opts.action === "begin")
      input.machine_id = readMachineIdentity().machine_id;
    if (opts.action === "end" && opts.status) {
      if (!["ended", "interrupted"].includes(opts.status))
        throw new Error("--status must be ended or interrupted");
      input.status = opts.status;
    }
    if (["read", "event"].includes(opts.action)) {
      if (!opts.type || !opts.id)
        throw new Error("--type and --id are required");
      input.node = { type: opts.type, project: opts.project ?? null, id: opts.id };
      // Project identifies the node here; session identity is already explicit.
      delete input.project;
      if (opts.action === "read")
        input.max_bytes = attentionInteger(opts.maxBytes, 1, 2 * 1024 * 1024);
      else {
        if (!opts.kind || !["delivery", "invocation", "availability"].includes(opts.kind))
          throw new Error("--kind must be delivery, invocation or availability");
        if (!opts.outcome || !["started", "succeeded", "failed", "unknown"].includes(opts.outcome))
          throw new Error("--outcome must be started, succeeded, failed or unknown");
        if (opts.extent && !["full", "preview", "unknown"].includes(opts.extent))
          throw new Error("--extent must be full, preview or unknown");
        Object.assign(input, { event_key: opts.eventKey, kind: opts.kind, outcome: opts.outcome, extent: opts.extent, source_revision: opts.sourceRevision, bytes: attentionInteger(opts.bytes, 0) });
      }
    }
    if (opts.action === "call") {
      if (!opts.tool || !opts.argsFile)
        throw new Error("call requires --tool and --args-file");
      let args: unknown;
      try {
        if (statSync(opts.argsFile).size > 2 * 1024 * 1024)
          throw new Error();
        args = JSON.parse(readFileSync(opts.argsFile, "utf8"));
      }
      catch {
        throw new Error("--args-file must be a readable JSON object of at most 2 MiB");
      }
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error("--args-file must contain a JSON object");
      const callInput = Object.fromEntries(Object.entries({
        session_id: opts.session, actor_id: opts.actor, operation_id: opts.operation,
        tool: opts.tool, arguments: args, selection,
      }).filter(([, value]) => value !== undefined));
      const result = await attentionCall(callInput);
      print(result);
      return result.isError ? 1 : 0;
    }
  }
  catch (err) {
    process.stderr.write(`attention: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const result = await attentionAction(opts.action, input);
  print(result);
  const status = "result" in result ? result.result : result;
  return status.ok ? 0 : status.degraded ? 3 : 1;
}
