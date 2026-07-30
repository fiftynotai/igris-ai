/**
 * boot-sync.test.ts — FR-195 M3 (the REMOTE channel).
 *
 * Real seeded brain DB (IGRIS_BRAIN_DIR, never a mock — L-159/TD-098) + a real
 * loopback HTTP server for the VPS boundary (makeLoopback, the same convention
 * as sync-data.test.ts). We mock ONLY the HTTP boundary; brain-db.ts (the
 * module under test's local-merge half) runs against a real tmp DB so the
 * "lands LOCALLY, last-write-wins" assertions are genuine.
 *
 * Coverage (the plan's boot-sync scenarios + the directionality proof):
 *   - the queue drain reuses the `sync data` primitive (asserted via a spy on
 *     drainSyncQueueOnly — boot-sync routes through it, never forks the drain);
 *   - each part is independent: a failed pull still lets the drain report (and
 *     vice versa), with per-part ok/fail recorded in the digest;
 *   - remote unconfigured → degraded exit 0 (never blocks);
 *   - the GET fixture asserts the EXACT endpoint path + envelope shape, not
 *     200-any-path (#356): `GET /sync/pull?since_<table>=<ts>`;
 *   - the pull lands in the LOCAL db (a real row appears after the merge) and
 *     is last-write-wins (an OLDER remote row does NOT clobber a NEWER local).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLoopback, mcpOkEnvelope, type CapturedCall } from "./loopback.js";
import type { BootSyncDigest } from "../types.js";

let tmpRoot: string;
let savedEnv: NodeJS.ProcessEnv;

const SLUG = "demo";

// ---------------------------------------------------------------------------
// Brain DB DDL (the boot-sync merge targets). sync_state is the cursor store;
// learnings/session_files/definition_files are merge targets exercised here.
// learnings has NO UNIQUE on its syncKey (project,category,title) — exactly why
// mergeRows does a manual lookup; the DDL mirrors the real schema.
// ---------------------------------------------------------------------------
const LEARNINGS_DDL = `
  CREATE TABLE IF NOT EXISTS learnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT, category TEXT, title TEXT, content TEXT, tags TEXT,
    tech_stack TEXT, scope TEXT, source_brief TEXT, confidence REAL,
    created_at TEXT, updated_at TEXT, access_count INTEGER DEFAULT 0,
    last_accessed_at TEXT, review_status TEXT, provenance TEXT, source_extractor TEXT
  );
`;

const SESSION_FILES_DDL = `
  CREATE TABLE IF NOT EXISTS session_files (
    id TEXT PRIMARY KEY, project TEXT NOT NULL, filename TEXT NOT NULL,
    content TEXT NOT NULL, content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    instance_id TEXT, state TEXT NOT NULL DEFAULT 'live', UNIQUE(project, filename)
  );
`;

const DEFINITION_FILES_DDL = `
  CREATE TABLE IF NOT EXISTS definition_files (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('agent','skill','rule','prompt')),
    name TEXT NOT NULL, filename TEXT NOT NULL, content TEXT NOT NULL,
    content_hash TEXT NOT NULL, version TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(type, name)
  );
`;

const SYNC_STATE_DDL = `
  CREATE TABLE IF NOT EXISTS sync_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT, remote_url TEXT NOT NULL,
    table_name TEXT NOT NULL, last_push_at TEXT, last_pull_at TEXT,
    UNIQUE(remote_url, table_name)
  );
`;

function dbFile(): string {
  return join(tmpRoot, "memory", "knowledge.db");
}

function seedSchema(): void {
  mkdirSync(join(tmpRoot, "memory"), { recursive: true });
  const db = new Database(dbFile());
  db.pragma("journal_mode = WAL");
  db.exec(LEARNINGS_DDL);
  db.exec(SESSION_FILES_DDL);
  db.exec(DEFINITION_FILES_DDL);
  db.exec(SYNC_STATE_DDL);
  db.close();
}

function withDb(fn: (db: Database.Database) => void): void {
  const db = new Database(dbFile());
  fn(db);
  db.close();
}

/** Write a config.json with a remote_brain block pointed at the loopback. */
function writeConfig(remoteUrl: string): void {
  writeFileSync(
    join(tmpRoot, "config.json"),
    JSON.stringify({ remote_brain: { url: remoteUrl, api_key: "k" } }, null, 2) + "\n",
  );
}

/** Seed a local sync_queue.jsonl so the drain has something to replay. */
function writeQueue(lines: string[]): string {
  const dir = join(tmpRoot, "projects", SLUG);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "sync_queue.jsonl");
  writeFileSync(p, lines.join("\n") + (lines.length > 0 ? "\n" : ""));
  return p;
}

async function closeBrainDb(): Promise<void> {
  (await import("../lib/brain-db.js")).closeDb();
}

async function bootSync(remoteUrl?: string): Promise<BootSyncDigest> {
  if (remoteUrl) writeConfig(remoteUrl);
  const { buildBootSyncDigest } = await import("../verbs/boot-sync.js");
  return buildBootSyncDigest(SLUG);
}

/** A loopback that answers GET /sync/pull with `tables` and 200s any POST. */
function makePullLoopback(
  tables: Record<string, Record<string, unknown>[]>,
): ReturnType<typeof makeLoopback> {
  return makeLoopback((call: CapturedCall) => {
    if (call.httpMethod === "GET" && (call.url ?? "").startsWith("/sync/pull")) {
      return { status: 200, body: JSON.stringify({ tables }) };
    }
    // Any POST (a queue-entry replay or the JSON-RPC sync_queue_drain) → 200
    // carrying a real success envelope. BR-080: the CLI now READS this body —
    // a bare `{ok:true}` is classified INDETERMINATE and a replayed entry is
    // preserved rather than dropped, so the shorthand no longer means success.
    return { status: 200, body: mcpOkEnvelope() };
  });
}

async function listen(lb: ReturnType<typeof makeLoopback>): Promise<void> {
  await new Promise<void>((resolve) => lb.server.listen(0, "127.0.0.1", resolve));
}
async function close(lb: ReturnType<typeof makeLoopback>): Promise<void> {
  await new Promise<void>((resolve) => lb.server.close(() => resolve()));
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-boot-sync-"));
  savedEnv = { ...process.env };
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
  // Clear harness markers so detectCapabilities is deterministic.
  for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "GEMINI_CLI", "CODEX_SESSION", "OPENCODE", "ANTIGRAVITY"]) {
    delete process.env[k];
  }
});

afterEach(async () => {
  await closeBrainDb();
  vi.restoreAllMocks();
  vi.resetModules();
  process.env = savedEnv;
});

describe("boot-sync — degraded (remote unconfigured)", () => {
  it("no remote_brain config → degraded digest, exit 0, both parts skipped", async () => {
    seedSchema();
    // No writeConfig → readRemoteBrainConfig() is null.
    const { runBootSync } = await import("../verbs/boot-sync.js");
    const code = await runBootSync({ project: SLUG, json: false });
    expect(code).toBe(0);

    const d = await bootSync();
    expect(d.degraded).toBe(true);
    expect(d.skipped).toContain("remote unconfigured");
    expect(d.brain_pull.ok).toBe(false);
    expect(d.queue_drain.ok).toBe(false);
    expect(d.session_files_pulled).toBe(0);
    expect(d.definitions_updated).toEqual({ agents: 0, skills: 0, rules: 0, prompts: 0 });
  });
});

describe("boot-sync — queue drain reuses the `sync data` primitive (#253)", () => {
  it("routes the drain through drainSyncQueueOnly (not a fork)", async () => {
    seedSchema();
    const lb = makePullLoopback({});
    await listen(lb);
    const remoteUrl = `http://127.0.0.1:${lb.port()}`;
    writeConfig(remoteUrl);
    writeQueue([
      JSON.stringify({ operation: "brief_sync", project: SLUG, brief_id: "TD-1", title: "t", status: "ACTIVE" }),
    ]);

    // Spy on the SHARED seam — boot-sync MUST call it (the single drain path).
    const dataMod = await import("../lib/sync/data.js");
    const spy = vi.spyOn(dataMod, "drainSyncQueueOnly");

    try {
      const { buildBootSyncDigest } = await import("../verbs/boot-sync.js");
      const d = await buildBootSyncDigest(SLUG);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ projectSlug: SLUG });
      // The drain replayed the one queued entry then called the brain drain → ok.
      expect(d.queue_drain.ok).toBe(true);
      expect(d.queue_drain.drained).toBe(1);
      // The queue file is consumed by the drain primitive (proof it ran).
      expect(existsSync(join(tmpRoot, "projects", SLUG, "sync_queue.jsonl"))).toBe(false);
    } finally {
      await close(lb);
    }
  });

  it("the drain issues the brain-side igris_sync_queue_drain JSON-RPC (the sync-data contract)", async () => {
    seedSchema();
    const lb = makePullLoopback({});
    await listen(lb);
    const remoteUrl = `http://127.0.0.1:${lb.port()}`;
    writeConfig(remoteUrl);
    // Empty queue → drain still calls the brain-side drain (sync-data semantics).

    try {
      const { buildBootSyncDigest } = await import("../verbs/boot-sync.js");
      await buildBootSyncDigest(SLUG);
      // Among the captured calls, exactly one POST is the JSON-RPC drain.
      const drainCalls = lb.calls.filter((c) => c.toolName === "igris_sync_queue_drain");
      expect(drainCalls.length).toBe(1);
      expect(drainCalls[0].jsonrpc).toBe("2.0");
      expect(drainCalls[0].method).toBe("tools/call");
      // The drain MUST NOT pass local_entries (the brain schema rejects it).
      expect(drainCalls[0].args?.local_entries).toBeUndefined();
    } finally {
      await close(lb);
    }
  });
});

describe("boot-sync — the VPS→local pull (#356 endpoint shape + #169 directionality)", () => {
  it("GETs the EXACT /sync/pull endpoint with since_ params (not 200-any-path)", async () => {
    seedSchema();
    // Pre-seed a cursor so the since_ param is non-epoch and assertable.
    withDb((db) => {
      db.prepare(
        "INSERT INTO sync_state (remote_url, table_name, last_pull_at) VALUES (?, ?, ?)",
      ).run("http://127.0.0.1:PLACEHOLDER", "learnings", "2026-01-01 00:00:00");
    });

    const lb = makePullLoopback({});
    await listen(lb);
    const remoteUrl = `http://127.0.0.1:${lb.port()}`;
    writeConfig(remoteUrl);

    try {
      const { buildBootSyncDigest } = await import("../verbs/boot-sync.js");
      await buildBootSyncDigest(SLUG);
      const getCalls = lb.calls.filter((c) => c.httpMethod === "GET");
      expect(getCalls.length).toBe(1);
      const url = getCalls[0].url ?? "";
      // EXACT path (not just "got a 200"): the /sync/pull route + since_ params.
      expect(url.startsWith("/sync/pull?")).toBe(true);
      expect(url).toContain("since_learnings=");
      expect(url).toContain("since_session_files=");
      expect(url).toContain("since_definition_files=");
      // POST drain is the OTHER call — the GET is the pull, distinct endpoint.
      const postCalls = lb.calls.filter((c) => c.httpMethod === "POST");
      expect(postCalls.length).toBe(1);
    } finally {
      await close(lb);
    }
  });

  it("upserts the pulled rows into the LOCAL db (the directionally-correct merge)", async () => {
    seedSchema();
    const lb = makePullLoopback({
      learnings: [
        {
          project: SLUG, category: "pattern", title: "remote-learning",
          content: "from the VPS", tags: "a,b", tech_stack: "", scope: "project",
          source_brief: "FR-1", confidence: 0.9,
          created_at: "2026-06-01 00:00:00", updated_at: "2026-06-01 00:00:00",
          access_count: 0, last_accessed_at: null,
          review_status: "approved", provenance: "remote", source_extractor: null,
        },
      ],
      definition_files: [
        {
          type: "agent", name: "remote-agent", filename: "remote-agent.md",
          content: "agent body", content_hash: "h", version: "1",
          updated_at: "2026-06-01 00:00:00",
        },
        {
          type: "rule", name: "remote-rule", filename: "rule.md",
          content: "rule body", content_hash: "h2", version: "1",
          updated_at: "2026-06-01 00:00:00",
        },
      ],
    });
    await listen(lb);
    const remoteUrl = `http://127.0.0.1:${lb.port()}`;
    writeConfig(remoteUrl);

    try {
      const { buildBootSyncDigest } = await import("../verbs/boot-sync.js");
      const d = await buildBootSyncDigest(SLUG);
      expect(d.degraded).toBe(false);
      expect(d.brain_pull.ok).toBe(true);
      expect(d.definitions_updated.agents).toBe(1);
      expect(d.definitions_updated.rules).toBe(1);

      // Proof the merge landed LOCALLY (not a VPS round-trip): the rows now
      // exist in THIS machine's brain DB.
      await closeBrainDb();
      withDb((db) => {
        const l = db.prepare(
          "SELECT content FROM learnings WHERE project = ? AND category = ? AND title = ?",
        ).get(SLUG, "pattern", "remote-learning") as { content: string } | undefined;
        expect(l?.content).toBe("from the VPS");

        const a = db.prepare(
          "SELECT content FROM definition_files WHERE type = ? AND name = ?",
        ).get("agent", "remote-agent") as { content: string } | undefined;
        expect(a?.content).toBe("agent body");

        // The cursor advanced for the merged table.
        const cur = db.prepare(
          "SELECT last_pull_at FROM sync_state WHERE remote_url = ? AND table_name = ?",
        ).get(remoteUrl, "learnings") as { last_pull_at: string } | undefined;
        expect(cur?.last_pull_at).toBeTruthy();
      });
    } finally {
      await close(lb);
    }
  });

  it("is last-write-wins: an OLDER remote row does NOT clobber a NEWER local row", async () => {
    seedSchema();
    // Seed a NEWER local learning.
    withDb((db) => {
      db.prepare(
        `INSERT INTO learnings (project, category, title, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(SLUG, "pattern", "lww-key", "LOCAL NEWER", "2026-06-10 00:00:00", "2026-06-10 00:00:00");
    });

    // Remote sends an OLDER row for the same syncKey (created_at is the
    // learnings timestampCol; older → must be skipped, NOT applied).
    const lb = makePullLoopback({
      learnings: [
        {
          project: SLUG, category: "pattern", title: "lww-key",
          content: "REMOTE OLDER", tags: "", tech_stack: "", scope: "project",
          source_brief: "", confidence: 0.5,
          created_at: "2026-01-01 00:00:00", updated_at: "2026-01-01 00:00:00",
          access_count: 0, last_accessed_at: null,
          review_status: "approved", provenance: "remote", source_extractor: null,
        },
      ],
    });
    await listen(lb);
    const remoteUrl = `http://127.0.0.1:${lb.port()}`;
    writeConfig(remoteUrl);

    try {
      const { buildBootSyncDigest } = await import("../verbs/boot-sync.js");
      await buildBootSyncDigest(SLUG);

      await closeBrainDb();
      withDb((db) => {
        const row = db.prepare(
          "SELECT content FROM learnings WHERE project = ? AND category = ? AND title = ?",
        ).get(SLUG, "pattern", "lww-key") as { content: string } | undefined;
        // The newer local content survived — the older remote row did NOT win.
        expect(row?.content).toBe("LOCAL NEWER");
      });
    } finally {
      await close(lb);
    }
  });

  it("a NEWER remote row DOES win (LWW the other direction)", async () => {
    seedSchema();
    withDb((db) => {
      db.prepare(
        `INSERT INTO learnings (project, category, title, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(SLUG, "pattern", "lww-key", "LOCAL OLDER", "2026-01-01 00:00:00", "2026-01-01 00:00:00");
    });

    const lb = makePullLoopback({
      learnings: [
        {
          project: SLUG, category: "pattern", title: "lww-key",
          content: "REMOTE NEWER", tags: "", tech_stack: "", scope: "project",
          source_brief: "", confidence: 0.5,
          created_at: "2026-12-01 00:00:00", updated_at: "2026-12-01 00:00:00",
          access_count: 0, last_accessed_at: null,
          review_status: "approved", provenance: "remote", source_extractor: null,
        },
      ],
    });
    await listen(lb);
    const remoteUrl = `http://127.0.0.1:${lb.port()}`;
    writeConfig(remoteUrl);

    try {
      const { buildBootSyncDigest } = await import("../verbs/boot-sync.js");
      await buildBootSyncDigest(SLUG);
      await closeBrainDb();
      withDb((db) => {
        const row = db.prepare(
          "SELECT content FROM learnings WHERE project = ? AND category = ? AND title = ?",
        ).get(SLUG, "pattern", "lww-key") as { content: string } | undefined;
        expect(row?.content).toBe("REMOTE NEWER");
      });
    } finally {
      await close(lb);
    }
  });
});

describe("boot-sync — independence + skip-on-fail", () => {
  it("a failed pull does not abort the drain (each part recorded independently)", async () => {
    seedSchema();
    writeQueue([
      JSON.stringify({ operation: "brief_sync", project: SLUG, brief_id: "TD-2", title: "t", status: "ACTIVE" }),
    ]);
    // Loopback: POST (drain) → 200; GET (pull) → 500 (pull fails).
    const lb = makeLoopback((call: CapturedCall) => {
      if (call.httpMethod === "GET" && (call.url ?? "").startsWith("/sync/pull")) {
        return { status: 500, body: JSON.stringify({ error: "boom" }) };
      }
      return { status: 200, body: mcpOkEnvelope() };
    });
    await listen(lb);
    const remoteUrl = `http://127.0.0.1:${lb.port()}`;
    writeConfig(remoteUrl);

    try {
      const { buildBootSyncDigest } = await import("../verbs/boot-sync.js");
      const d = await buildBootSyncDigest(SLUG);
      // Pull failed but the drain still ran + succeeded.
      expect(d.brain_pull.ok).toBe(false);
      expect(d.queue_drain.ok).toBe(true);
      expect(d.queue_drain.drained).toBe(1);
      expect(d.skipped).toContain("remote pull skipped");
    } finally {
      await close(lb);
    }
  });

  it("a remote that is unreachable for the pull still exits 0 (never blocks)", async () => {
    seedSchema();
    // Point at a closed port → the pull GET fails at the network layer.
    const { runBootSync } = await import("../verbs/boot-sync.js");
    writeConfig("http://127.0.0.1:1"); // port 1 is not listening
    const code = await runBootSync({ project: SLUG, json: false });
    expect(code).toBe(0);

    const d = await bootSync();
    expect(d.brain_pull.ok).toBe(false);
    expect(d.brain_pull.summary).toContain("unreachable");
  });
});
