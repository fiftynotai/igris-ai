/** FR-276: machine-local attention. Pure GETs never boot an engine or migrate. */
import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { brainDir, brainDbPath } from "./paths.js";
import { openBrainReadonly, resolveBundleModule, loadVendoredEmbeddings } from "./brain-bridge.js";
import { withBrainWriteDoor } from "./brain-db.js";
import { bootWriteEngine, shutdownWriteEngine, type ToolResult } from "./brain-write-bridge.js";
import type { AttentionActionResult, AttentionInventory, AttentionSessionList, AttentionSnapshot } from "../types.js";
type Db = Database.Database;
type Input = Record<string, unknown>;
export interface AttentionRuntime {
  initializeAttention(db: Db): void;
  sessionAction(db: Db, input: Input): AttentionActionResult;
  eventAction(db: Db, input: Input): AttentionActionResult;
  readAttentionResource(db: Db, input: Input, options: {
    brain_root: string;
  }): {
    result: AttentionActionResult;
    content: string | null;
    truncated: boolean;
  };
  listAttentionSessions(db: Db, input: Input): AttentionSessionList;
  readAttentionSnapshot(db: Db, input: Input): AttentionSnapshot;
  buildAttentionInventory(db: Db, input: {
    brain_root: string;
    project?: string | null;
  }): AttentionInventory;
}
let runtime: AttentionRuntime | null = null;
let failure: string | null = null;
export function resetAttentionBridge(): void { runtime = null; failure = null; }
export function attentionBridgeFailure(): string | null { return failure; }
export async function loadAttentionRuntime(): Promise<AttentionRuntime | null> {
  if (runtime)
    return runtime;
  const actions = resolveBundleModule("engine/components/attention/actions.js");
  if (!actions) {
    failure = "installed brain bundle has no attention support";
    return null;
  }
  try {
    // One artifact root for all exports: never mix old vendored and new repo modules.
    const root = dirname(actions);
    const modules = await Promise.all(["actions", "read", "inventory"].map(name => import(pathToFileURL(join(root, `${name}.js`)).href)));
    const combined = Object.assign({}, ...modules) as Record<string, unknown>;
    for (const name of ["initializeAttention", "sessionAction", "eventAction", "readAttentionResource", "listAttentionSessions", "readAttentionSnapshot", "buildAttentionInventory"]) {
      if (typeof combined[name] !== "function")
        throw new Error(`missing attention export: ${name}`);
    }
    runtime = combined as unknown as AttentionRuntime;
    failure = null;
    return runtime;
  }
  catch (err) {
    failure = `attention module unavailable: ${err instanceof Error ? err.message : String(err)}`;
    return null;
  }
}
export function unavailableAction(action: string, reason: string): AttentionActionResult {
  return { ok: false, action, session: null, event: null, degraded: true, reason };
}
export async function attentionAction(action: string, input: Input): Promise<AttentionActionResult | {
  result: AttentionActionResult;
  content: string | null;
  truncated: boolean;
}> {
  if (!existsSync(brainDbPath()))
    return unavailableAction(action, "brain database absent");
  const mod = await loadAttentionRuntime();
  if (!mod)
    return unavailableAction(action, failure ?? "attention module unavailable");
  try {
    return await withBrainWriteDoor(action === "begin" ? [] : ["attention_sessions", "attention_events"], db => {
      // Writes upgrade an existing recording schema; GETs remain migration-free.
      // The write door still refuses absent tables except for explicit begin.
      mod.initializeAttention(db);
      if (action === "read")
        return mod.readAttentionResource(db, input, { brain_root: brainDir() });
      if (action === "event")
        return mod.eventAction(db, input);
      return mod.sessionAction(db, { ...input, action });
    });
  }
  catch (err) {
    return unavailableAction(action, err instanceof Error ? err.message : String(err));
  }
}
export async function attentionCall(input: Input): Promise<ToolResult> {
  const fail = (reason: string): ToolResult => ({ isError: true, content: [{ type: "text", text: reason }] });
  // A call must not initialize attention in a pre-attention brain. Pure readers
  // accept v1 ledgers, so an existing recording can proceed to the write upgrade.
  const prior = await attentionSnapshot({ session_id: input.session_id, limit: 1 });
  if (!prior.session || prior.session.status !== "active")
    return fail(prior.degraded?.reason ?? "Unknown or ended attention session on this brain.");
  // This path never invokes the configured remote MCP endpoint.
  const opened = await bootWriteEngine();
  if (!opened.ok)
    return fail(opened.reason);
  try {
    if (!opened.engine.gateway.hasTool("igris_attention_call"))
      return fail("installed local brain engine has no attention call support");
    return await opened.engine.gateway.dispatch("igris_attention_call", input);
  }
  catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  finally {
    const embeddings = await loadVendoredEmbeddings();
    try {
      await embeddings?.disposeEmbeddingPipeline();
    }
    finally {
      shutdownWriteEngine();
    }
  }
}
async function withRead<T>(fn: (m: AttentionRuntime, db: Db) => T, degraded: (reason: string) => T): Promise<T> {
  if (!existsSync(brainDbPath()))
    return degraded("brain database absent");
  const mod = await loadAttentionRuntime();
  if (!mod)
    return degraded(failure ?? "attention module unavailable");
  const db = openBrainReadonly();
  if (!db)
    return degraded("brain database unreadable");
  try {
    return fn(mod, db);
  }
  catch (err) {
    return degraded(err instanceof Error ? err.message : String(err));
  }
  finally {
    db.close();
  }
}
export function attentionSessions(input: Input = {}): Promise<AttentionSessionList> {
  return withRead((m, db) => m.listAttentionSessions(db, input), reason => ({ sessions: [], next_before: null, generated_at: new Date().toISOString(), degraded: { reason } }));
}
export function attentionSnapshot(input: Input): Promise<AttentionSnapshot> {
  return withRead((m, db) => m.readAttentionSnapshot(db, input), reason => ({ session: null, through_sequence: 0, latest_sequence: 0, node_states: [], recent_events: [], next_before: null, generated_at: new Date().toISOString(), degraded: { reason }, truncated: false, counts: { events_total: 0, events_reduced: 0, nodes_reduced: 0, node_states: 0 } }));
}
export function attentionInventory(project?: string): Promise<AttentionInventory> {
  return withRead((m, db) => m.buildAttentionInventory(db, { brain_root: brainDir(), project }), reason => ({ nodes: [], revision: "", sources: [], generated_at: new Date().toISOString(), degraded: { reason } }));
}
