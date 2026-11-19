/** FR-276: local recording, readonly HTTP, and an actually correlated local call. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { get, request } from "node:http";
import { fenceHome, type HomeFence } from "./home-fence.js";
import { attentionAction, attentionCall, attentionSnapshot, resetAttentionBridge } from "../lib/attention-bridge.js";
import { closeDb } from "../lib/brain-db.js";
import { resetWriteEngine, writeEngineState } from "../lib/brain-write-bridge.js";
import { brainDbPath } from "../lib/paths.js";
import { startServer, type DashboardServer } from "../lib/dashboard/server.js";
import { runSessionCommand, type SessionOptions } from "../verbs/session.js";
import { runAttention } from "../verbs/attention.js";
import type { AttentionActionResult, AttentionSnapshot, RegisterDigest } from "../types.js";

let fence: HomeFence;
let server: DashboardServer | null = null;
beforeEach(() => {
  fence = fenceHome("igris-attention-");
  fence.assertArmed();
  closeDb(); resetAttentionBridge(); resetWriteEngine();
});
afterEach(async () => {
  await server?.close(); server = null;
  closeDb(); resetAttentionBridge(); resetWriteEngine();
  fence.release();
});
function seed(): void {
  mkdirSync(join(fence.brainDir, "memory"), { recursive: true });
  new Database(brainDbPath()).close();
  mkdirSync(join(fence.brainDir, "core", "os"), { recursive: true });
  writeFileSync(join(fence.brainDir, "core", "os", "INDEX.md"), "# Test index\n");
}
async function begin(): Promise<string> {
  const result = await attentionAction("begin", {}) as AttentionActionResult;
  expect(result.ok, result.reason ?? "begin failed").toBe(true);
  return result.session!.id;
}
async function http(path: string, method = "GET", host?: string): Promise<{status: number; body: string; headers: Record<string, unknown>}> {
  if (!server) throw new Error("server not started");
  return new Promise((resolve, reject) => {
    const req = (method === "GET" ? get : request)({ host: "127.0.0.1", port: server!.port, path, method, agent: false,
      headers: { host: host ?? `127.0.0.1:${server!.port}` } }, res => {
      let body = "";
      res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on("error", reject);
    if (method !== "GET") req.end();
  });
}

describe("FR-276 attention CLI bridge", () => {
  it("never creates a missing brain during writes, reads, or malformed CLI input", async () => {
    expect((await attentionAction("begin", {}) as AttentionActionResult).degraded).toBe(true);
    const missing = await attentionSnapshot({session_id: randomUUID()});
    expect(missing.degraded).not.toBeNull();
    // The degraded fallback carries the brain snapshot's bound fields too (FR-276 F4 shape).
    expect(missing).toMatchObject({ truncated: false, counts: { events_total: 0, events_reduced: 0, nodes_reduced: 0, node_states: 0 } });
    expect(await runAttention({ action: "event", session: "not-an-id" })).toBe(2);
    expect(existsSync(brainDbPath())).toBe(false);
    expect(writeEngineState()).toBe("not-booted");
  });

  it("isolates recordings, binds early evidence, advances explicit epochs and preserves ended history", async () => {
    seed();
    const first = await begin(), second = await begin();
    const node = { type: "os_module", project: null, id: "igris-core:INDEX" };
    const delivered = await attentionAction("read", { session_id: first, node, operation_id: "index-first" });
    expect("content" in delivered && delivered.content).toBe("# Test index\n");
    const binding = await attentionAction("bind", { session_id: first, project: "demo", harness_session_id: "chat-a", instance_id: "instance-a" }) as AttentionActionResult;
    expect(binding.ok).toBe(true);
    const refused = await attentionAction("bind", { session_id: first, harness_session_id: "chat-b" }) as AttentionActionResult;
    expect(refused.ok).toBe(false);
    const read = await attentionSnapshot({ session_id: first });
    expect(read.session!.harness_session_id).toBe("chat-a");
    expect(read.node_states[0].state).toBe("full");
    expect(read.node_states[0].last_event.origin).toBe("loader");
    expect(read.node_states[0].last_event.bytes).toBe(Buffer.byteLength("# Test index\n"));
    expect(read.node_states[0].last_event.source_revision).toBe(createHash("sha256").update("# Test index\n").digest("hex"));
    expect((await attentionSnapshot({ session_id: second })).recent_events).toHaveLength(0);
    await attentionAction("epoch", { session_id: first, operation_id: "compact-1", reason: "observed context reassembly" });
    const after = await attentionSnapshot({ session_id: first });
    expect(after.session!.current_epoch).toBe(1);
    expect(after.node_states[0].historical).toBe(true);
    expect(after.session!.coverage.compaction).toBe("observed");
    await attentionAction("end", { session_id: first });
    expect((await attentionSnapshot({ session_id: first })).session!.status).toBe("ended");
    expect((await attentionSnapshot({ session_id: first })).recent_events.length).toBeGreaterThan(1);
  });

  it("executes a real local gateway tool with this brain's explicit session and rejects a foreign session", async () => {
    seed();
    const id = await begin();
    const argsFile = join(fence.home, "recall-args.json");
    writeFileSync(argsFile, '{"days":7}');
    expect(await runAttention({ action: "call", session: id, operation: "local-call", tool: "igris_session_recall", argsFile })).toBe(0);
    const snapshot = await attentionSnapshot({ session_id: id });
    expect(snapshot.recent_events.filter(e => e.kind === "invocation")).toHaveLength(2);
    expect(snapshot.recent_events.every(e => e.origin === "tool_boundary")).toBe(true);
    expect(writeEngineState()).toBe("not-booted");
    const foreign = await attentionCall({ session_id: randomUUID(), tool: "igris_session_recall", arguments: { days: 7 } });
    expect(foreign.isError).toBe(true);
    expect((await attentionSnapshot({ session_id: id })).recent_events).toHaveLength(snapshot.recent_events.length);
  });
});

describe("selection explanations through the CLI", () => {
  it("does not initialize an existing blank brain through read or call", async () => {
    seed();
    const id = randomUUID();
    const resource = await attentionAction("read", { session_id: id, node: { type: "os_module", project: null, id: "igris-core:INDEX" } });
    expect("result" in resource ? resource.result.ok : resource.ok).toBe(false);
    expect((await attentionCall({ session_id: id, tool: "igris_session_recall", arguments: { days: 7 } })).isError).toBe(true);
    expect(writeEngineState()).toBe("not-booted");
    const db = new Database(brainDbPath(), { readonly: true });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'attention_%'").all()).toEqual([]);
    db.close();
  });

  it("records declared boot selection and preserves legacy receipts through a write upgrade", async () => {
    seed();
    const id = await begin();
    await attentionAction("read", { session_id: id, node: { type: "os_module", project: null, id: "igris-core:INDEX" } });
    closeDb();
    const legacy = new Database(brainDbPath());
    legacy.exec("ALTER TABLE attention_events DROP COLUMN selection");
    legacy.prepare("DELETE FROM engine_migrations WHERE component='attention' AND version=2").run();
    legacy.close();
    const before = await attentionSnapshot({ session_id: id });
    expect(before.recent_events).toHaveLength(2);
    expect(before.recent_events.every(event => event.selection === null)).toBe(true);
    const inspectLegacy = new Database(brainDbPath(), { readonly: true });
    expect(inspectLegacy.prepare("PRAGMA table_info(attention_events)").all().some((row: unknown) => (row as { name: string }).name === "selection")).toBe(false);
    inspectLegacy.close();
    expect(await runAttention({ action: "read", session: id, type: "os_module", id: "igris-core:INDEX", selection: "boot", selectionRef: "boot:index" })).toBe(0);
    const after = await attentionSnapshot({ session_id: id });
    expect(after.recent_events).toHaveLength(4);
    expect(after.recent_events.filter(event => event.sequence > 2).every(event =>
      event.selection?.category === "boot" && event.selection.provenance === "caller_declared" && event.selection.reference === "boot:index"
    )).toBe(true);
    expect(after.recent_events.filter(event => event.sequence <= 2).every(event => event.selection === null)).toBe(true);
  });

  it("passes declared task selection to a real call independently of its arguments", async () => {
    seed();
    const id = await begin();
    const argsFile = join(fence.home, "selection-call.json");
    writeFileSync(argsFile, '{"days":7}');
    expect(await runAttention({ action: "call", session: id, tool: "igris_session_recall", argsFile, selection: "task", selectionRef: "FR-276" })).toBe(0);
    const snapshot = await attentionSnapshot({ session_id: id });
    expect(snapshot.recent_events).toHaveLength(2);
    for (const event of snapshot.recent_events)
      expect(event.selection).toEqual({ category: "task", provenance: "caller_declared", reference: "FR-276" });
  });

  it("rejects unsupported actions, unknown categories, and unsafe references before opening a brain", async () => {
    const base = { action: "read", session: randomUUID(), type: "os_module", id: "igris-core:INDEX" };
    for (const options of [
      { ...base, selection: "observed" },
      { ...base, selectionRef: "boot:index" },
      { ...base, selection: "boot", selectionRef: "private task prose" },
      { ...base, selection: "boot", selectionRef: "boot:index\n" },
      { ...base, selection: "boot", selectionRef: "/Users/private" },
      { ...base, selection: "boot", selectionRef: "x".repeat(129) },
      { ...base, action: "show", selection: "boot" },
      { action: "begin", selection: "boot" },
    ]) expect(await runAttention(options)).toBe(2);
    expect(existsSync(brainDbPath())).toBe(false);
    expect(writeEngineState()).toBe("not-booted");
  });
});

describe("FR-276 R4: attention instance identity uses the register path's rule", () => {
  it("refuses a path-shaped or oversized --instance-id with usage exit 2 before writing", async () => {
    seed();
    const id = await begin();
    for (const bad of ["../../etc", "a/b", "instance a", "x".repeat(257), "inst\n", ""])
      expect(await runAttention({ action: "bind", session: id, instanceId: bad }), JSON.stringify(bad)).toBe(2);
    expect(await runAttention({ action: "begin", instanceId: "../../etc" })).toBe(2);
    expect((await attentionSnapshot({ session_id: id })).session?.instance_id).toBeNull();
    const original = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      expect(await runAttention({ action: "bind", session: id, instanceId: "instance_A-1" })).toBe(0);
    } finally { process.stdout.write = original; }
    expect((await attentionSnapshot({ session_id: id })).session?.instance_id).toBe("instance_A-1");
  });
});

describe("FR-276 R2: show exits by availability, not by size", () => {
  /** Seed through the BUNDLED brain writer so the read path and the seeded rows are the shipped ones. */
  async function bundledStore(): Promise<{ appendEvent: (db: Database.Database, input: Record<string, unknown>) => unknown; COLLECTION_GAP: string; SNAPSHOT_NODE_LIMIT: number }> {
    const { resolveBundleModule } = await import("../lib/brain-bridge.js");
    const { pathToFileURL } = await import("node:url");
    const load = async (rel: string) => import(pathToFileURL(resolveBundleModule(rel)!).href) as Promise<Record<string, unknown>>;
    const [store, types, read] = await Promise.all([load("engine/components/attention/store.js"), load("engine/components/attention/types.js"), load("engine/components/attention/read.js")]);
    return { appendEvent: store.appendEvent as never, COLLECTION_GAP: types.COLLECTION_GAP as string, SNAPSHOT_NODE_LIMIT: read.SNAPSHOT_NODE_LIMIT as number };
  }
  async function seedSession(opts: { nodes: number; gap: boolean }): Promise<string> {
    seed();
    const id = await begin();
    closeDb();
    const { appendEvent, COLLECTION_GAP } = await bundledStore();
    const db = new Database(brainDbPath());
    db.transaction(() => {
      for (let i = 0; i < opts.nodes; i++)
        appendEvent(db, { session_id: id, operation_id: `op-${i}`, event_key: "delivery:0", kind: "delivery", node: { type: "learning", project: "demo", id: String(i) }, outcome: "succeeded", extent: "preview", origin: "tool_boundary" });
      if (opts.gap)
        appendEvent(db, { session_id: id, operation_id: "gap", event_key: "invocation:end", kind: "invocation", node: { type: "tool", project: null, id: "igris-brain:fixture" }, outcome: "succeeded", origin: "tool_boundary", reason: COLLECTION_GAP });
    })();
    db.close();
    return id;
  }
  async function show(id: string): Promise<{ code: number; printed: AttentionSnapshot }> {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stdout.write;
    try {
      const code = await runAttention({ action: "show", session: id });
      return { code, printed: JSON.parse(output) as AttentionSnapshot };
    } finally { process.stdout.write = original; }
  }

  it("exits 0 for a healthy session that is only bounded, and still prints the bound as degraded", async () => {
    const { SNAPSHOT_NODE_LIMIT } = await bundledStore();
    const id = await seedSession({ nodes: SNAPSHOT_NODE_LIMIT + 1, gap: false });
    const { code, printed } = await show(id);
    expect(printed.truncated).toBe(true);
    // The JSON is unchanged: the brain's degraded sentence still reaches readers.
    expect(printed.degraded?.reason).toMatch(/^Snapshot bounded: /);
    expect(code).toBe(0);
  });

  it("exits 3 for a bounded session that also has a capture gap", async () => {
    const { SNAPSHOT_NODE_LIMIT, COLLECTION_GAP } = await bundledStore();
    const id = await seedSession({ nodes: SNAPSHOT_NODE_LIMIT + 1, gap: true });
    const { code, printed } = await show(id);
    expect(printed.truncated).toBe(true);
    expect(printed.degraded?.reason.startsWith(COLLECTION_GAP)).toBe(true);
    expect(code).toBe(3);
  });

  it("exits 3 for a capture gap without truncation (unchanged)", async () => {
    const id = await seedSession({ nodes: 2, gap: true });
    const { code, printed } = await show(id);
    expect(printed.truncated).toBe(false);
    expect(printed.degraded).not.toBeNull();
    expect(code).toBe(3);
  });
});

describe("FR-276 registration ownership", () => {
  function seedRegistrationTables(): void {
    seed();
    const db = new Database(brainDbPath());
    db.exec(`
      CREATE TABLE instances (
        id TEXT PRIMARY KEY, machine_hostname TEXT NOT NULL, machine_os TEXT,
        project_slug TEXT, project_path TEXT, current_brief TEXT, current_phase TEXT,
        current_task TEXT, status TEXT DEFAULT 'active',
        started_at TEXT DEFAULT (datetime('now')), last_activity_at TEXT DEFAULT (datetime('now')),
        metadata TEXT DEFAULT '{}', harness TEXT, harness_session_id TEXT
      );
      CREATE TABLE session_files (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, filename TEXT NOT NULL,
        content TEXT NOT NULL, content_hash TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')), instance_id TEXT, state TEXT DEFAULT 'live',
        UNIQUE(project, filename)
      );
    `);
    db.close();
  }
  async function register(opts: Omit<SessionOptions, "action">): Promise<{ code: number; digest: RegisterDigest }> {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stdout.write;
    try {
      const code = await runSessionCommand({ action: "register", ...opts });
      return { code, digest: JSON.parse(output) as RegisterDigest };
    } finally { process.stdout.write = original; }
  }

  it("refuses conflicting recording/native identity before changing instance or scratchpad", async () => {
    seedRegistrationTables();
    const first = await begin(), second = await begin();
    const firstRegistration = await register({ project: "demo", attentionSession: first, harnessSessionId: "chat-a" });
    expect(firstRegistration.code).toBe(0);
    expect(firstRegistration.digest.attention_binding?.ok).toBe(true);
    const instance = firstRegistration.digest.instance_id;
    const scratchpad = join(fence.brainDir, "projects", "demo", "session", "instances", instance + ".md");
    const beforeFile = readFileSync(scratchpad, "utf8");
    expect(beforeFile).toContain(`**Attention Session ID:** ${first}`);
    const inspect = new Database(brainDbPath(), { readonly: true });
    const beforeRow = inspect.prepare("SELECT * FROM instances WHERE id=?").get(instance);
    const beforeStored = inspect.prepare("SELECT * FROM session_files").all();
    const conflict = await register({ project: "demo", selfInstanceId: instance, attentionSession: second, harnessSessionId: "chat-b" });
    expect(conflict.code).toBe(1);
    expect(conflict.digest.attention_binding?.ok).toBe(false);
    expect(inspect.prepare("SELECT * FROM instances WHERE id=?").get(instance)).toEqual(beforeRow);
    expect(inspect.prepare("SELECT * FROM session_files").all()).toEqual(beforeStored);
    expect(readFileSync(scratchpad, "utf8")).toBe(beforeFile);
    const same = await register({ project: "demo", selfInstanceId: instance, attentionSession: first, harnessSessionId: "chat-a" });
    expect(same.code).toBe(0); expect(same.digest.attention_binding?.ok).toBe(true);
    expect(readFileSync(scratchpad, "utf8")).toBe(beforeFile);
    expect((await attentionSnapshot({ session_id: second })).session?.instance_id).toBeNull();
    inspect.close();
  });

  it("a recovered instance bound to another chat: the refused register, re-run without --self-instance-id, mints a fresh instance bound to the same recording", async () => {
    // /boot §4.4's recovery step: the refusal names the recovered instance's chat
    // conflict, so boot re-runs the same register without --self-instance-id.
    seedRegistrationTables();
    const earlier = await begin();
    const old = await register({ project: "demo", attentionSession: earlier, harnessSessionId: "chat-a" });
    expect(old.code).toBe(0);
    const oldId = old.digest.instance_id;
    const oldScratchpad = join(fence.brainDir, "projects", "demo", "session", "instances", oldId + ".md");
    const oldFile = readFileSync(oldScratchpad, "utf8");
    const inspect = new Database(brainDbPath(), { readonly: true });
    const oldRow = inspect.prepare("SELECT * FROM instances WHERE id=?").get(oldId);

    const current = await begin();
    const refused = await register({ project: "demo", selfInstanceId: oldId, attentionSession: current, harnessSessionId: "chat-b" });
    expect(refused.code).toBe(1);
    expect(refused.digest.attention_binding?.reason).toBe("instance already belongs to a different native chat");
    expect(inspect.prepare("SELECT COUNT(*) AS n FROM instances").get()).toEqual({ n: 1 });
    expect((await attentionSnapshot({ session_id: current })).session?.instance_id).toBeNull();

    const retried = await register({ project: "demo", attentionSession: current, harnessSessionId: "chat-b" });
    expect(retried.code).toBe(0);
    expect(retried.digest.minted).toBe(true);
    expect(retried.digest.instance_id).not.toBe(oldId);
    expect(retried.digest.attention_binding).toEqual({ ok: true, reason: null });
    const bound = (await attentionSnapshot({ session_id: current })).session;
    expect(bound?.instance_id).toBe(retried.digest.instance_id);
    expect(bound?.harness_session_id).toBe("chat-b");
    const freshScratchpad = join(fence.brainDir, "projects", "demo", "session", "instances", retried.digest.instance_id + ".md");
    expect(readFileSync(freshScratchpad, "utf8")).toContain(`**Attention Session ID:** ${current}`);
    expect((inspect.prepare("SELECT harness_session_id FROM instances WHERE id=?").get(retried.digest.instance_id) as
      { harness_session_id: string }).harness_session_id).toBe("chat-b");
    // The old instance, its chat and its recording are untouched.
    expect(inspect.prepare("SELECT * FROM instances WHERE id=?").get(oldId)).toEqual(oldRow);
    expect(readFileSync(oldScratchpad, "utf8")).toBe(oldFile);
    expect((await attentionSnapshot({ session_id: earlier })).session?.instance_id).toBe(oldId);
    inspect.close();
  });

  it("still checks ownership of a readable recording that is degraded by a collection gap", async () => {
    seedRegistrationTables();
    const id = await begin();
    const bound = await register({ project: "demo", attentionSession: id, harnessSessionId: "chat-a" });
    expect(bound.digest.attention_binding?.ok).toBe(true);
    await attentionAction("event", { session_id: id, kind: "invocation", node: { type: "tool", project: null, id: "native:test" }, outcome: "succeeded" });
    closeDb();
    const flag = new Database(brainDbPath());
    // capture.ts's bounded-collection marker (attention types.ts COLLECTION_GAP).
    flag.prepare("UPDATE attention_events SET origin='tool_boundary', reason=? WHERE session_id=? AND kind='invocation'")
      .run("Observation collection incomplete or bounded at 200 records.", id);
    flag.close();
    const gap = await attentionSnapshot({ session_id: id });
    expect(gap.session?.instance_id).toBe(bound.digest.instance_id);
    expect(gap.degraded).not.toBeNull();
    const inspect = new Database(brainDbPath(), { readonly: true });
    const state = () => JSON.stringify({
      instances: inspect.prepare("SELECT * FROM instances ORDER BY id").all(),
      files: inspect.prepare("SELECT * FROM session_files ORDER BY id").all(),
      scratchpads: readdirSync(join(fence.brainDir, "projects", "demo", "session", "instances")).sort(),
    });
    const before = state();
    const foreign = await register({ project: "demo", attentionSession: id, harnessSessionId: "chat-a" });
    expect(foreign.code).toBe(1);
    expect(foreign.digest.attention_binding?.reason).toMatch(/already bound/);
    expect(state()).toBe(before);
    inspect.close();
  });

  it("registers without a binding when the recording genuinely cannot be read", async () => {
    seedRegistrationTables();
    const result = await register({ project: "demo", attentionSession: randomUUID() });
    expect(result.code).toBe(0);
    expect(result.digest.instance_id).not.toBe("");
    expect(result.digest.attention_binding?.ok).toBe(false);
  });
});

describe("FR-276 attention HTTP contract", () => {
  it("degrades without creating a missing brain and enforces identity, method, host and no-store fences", async () => {
    server = await startServer({ port: 0, exactPort: true, cliVersion: "attention-test" });
    for (const path of ["/api/attention/sessions", `/api/attention/session?session=${randomUUID()}`, "/api/attention/inventory"]) {
      const res = await http(path);
      expect(res.status).toBe(200); expect(JSON.parse(res.body).degraded).not.toBeNull();
      expect(res.headers["cache-control"]).toBe("no-store");
      expect((await http(path, "POST")).status).toBe(405);
      expect((await http(path, "GET", "untrusted.test")).status).toBe(403);
    }
    for (const path of ["/api/attention/session", "/api/attention/sessions?before=invalid", "/api/attention/sessions?limit=1x", "/api/attention/inventory?project=../x"]) {
      expect((await http(path)).status).toBe(400);
    }
    expect(existsSync(brainDbPath())).toBe(false);
    expect(writeEngineState()).toBe("not-booted");
  });

  it("serves only the selected session, validates unknown cursors, and never mutates the recording", async () => {
    seed();
    const first = await begin(), second = await begin();
    await attentionAction("event", { session_id: first, kind: "invocation", node: { type: "tool", project: null, id: "native:test" }, outcome: "succeeded" });
    closeDb();
    const before = readFileSync(brainDbPath());
    const inspect = new Database(brainDbPath(), { readonly: true });
    const rows = () => JSON.stringify({
      sessions: inspect.prepare("SELECT * FROM attention_sessions ORDER BY id").all(),
      events: inspect.prepare("SELECT * FROM attention_events ORDER BY id").all(),
      schema: inspect.prepare("SELECT * FROM sqlite_schema ORDER BY name").all(),
    });
    const beforeRows = rows();
    server = await startServer({ port: 0, exactPort: true, cliVersion: "attention-test" });
    const snap = JSON.parse((await http(`/api/attention/session?session=${first}`)).body) as AttentionSnapshot;
    expect(snap.session!.id).toBe(first); expect(snap.recent_events).toHaveLength(1);
    expect(JSON.parse((await http(`/api/attention/session?session=${second}`)).body).recent_events).toHaveLength(0);
    expect((await http(`/api/attention/session?session=${randomUUID()}`)).status).toBe(404);
    expect((await http(`/api/attention/sessions?before=${randomUUID()}`)).status).toBe(400);
    expect((await http("/api/attention/sessions?limit=1")).status).toBe(200);
    expect((await http("/api/attention/inventory")).status).toBe(200);
    expect(readFileSync(brainDbPath())).toEqual(before);
    expect(rows()).toBe(beforeRows);
    inspect.close();
    expect(writeEngineState()).toBe("not-booted");
  });
});
