/**
 * TD-338 — CLI-side replication INGRESS normalization (T2 + T10).
 *
 * `cli/src/lib/brain-db.ts` carries a verbatim port of the brain's `mergeRows`,
 * used by `mergePulledTables` for the awaken / `igris boot-sync` VPS→local pull.
 * **THIS is the ingress door that actually runs on a workstation** — a
 * brain-only fix would have closed the door nobody walks through. These tests
 * drive the REAL merge against a REAL tmp brain DB, fed by a REAL loopback
 * `GET /sync/pull` (the same convention as boot-sync.test.ts). No mock of the
 * code under test (L-159 / TD-098).
 *
 * T2 asserts the two `mergeRows` copies AGREE: the payloads and expected
 * outcomes here mirror `brain-mcp-server/src/tools/__tests__/sync-ingress-normalize.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeLoopback,
  mcpOkEnvelope,
  rpcRequestId,
  type CapturedCall,
} from "./loopback.js";
import type { BootSyncDigest } from "../types.js";

let tmpRoot: string;
let savedEnv: NodeJS.ProcessEnv;

const SLUG = "demo";

const BRIEF_STATUS_DDL = `
  CREATE TABLE IF NOT EXISTS brief_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL, brief_id TEXT NOT NULL, brief_type TEXT,
    title TEXT NOT NULL, status TEXT NOT NULL, priority TEXT, effort TEXT,
    phase TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_brief_status_unique
    ON brief_status(project, brief_id);
`;

const LEARNINGS_DDL = `
  CREATE TABLE IF NOT EXISTS learnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT, category TEXT, title TEXT, content TEXT, tags TEXT,
    tech_stack TEXT, scope TEXT, source_brief TEXT, confidence REAL,
    created_at TEXT, updated_at TEXT, access_count INTEGER DEFAULT 0,
    last_accessed_at TEXT, review_status TEXT, provenance TEXT, source_extractor TEXT
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
  db.exec(BRIEF_STATUS_DDL);
  db.exec(LEARNINGS_DDL);
  db.exec(SYNC_STATE_DDL);
  db.close();
}

function withDb(fn: (db: Database.Database) => void): void {
  const db = new Database(dbFile());
  fn(db);
  db.close();
}

function writeConfig(remoteUrl: string): void {
  writeFileSync(
    join(tmpRoot, "config.json"),
    JSON.stringify({ remote_brain: { url: remoteUrl, api_key: "k" } }, null, 2) + "\n",
  );
}

/** The exact spellings the live VPS still holds for these rows. */
function dirtyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: "moca-ai-agent",
    brief_id: "BR-045",
    brief_type: "TD",
    title: "HR read tools on mocasmart-mcp",
    status: "Done",
    priority: "P2",
    effort: "L-Large",
    phase: "building",
    updated_at: "2026-08-04 00:00:00",
    ...overrides,
  };
}

function makePullLoopback(
  tables: Record<string, Record<string, unknown>[]>,
): ReturnType<typeof makeLoopback> {
  return makeLoopback((call: CapturedCall) => {
    if (call.httpMethod === "GET" && (call.url ?? "").startsWith("/sync/pull")) {
      return { status: 200, body: JSON.stringify({ tables }) };
    }
    return { status: 200, body: mcpOkEnvelope(rpcRequestId(call)) };
  });
}

async function listen(lb: ReturnType<typeof makeLoopback>): Promise<void> {
  await new Promise<void>((resolve) => lb.server.listen(0, "127.0.0.1", resolve));
}
async function close(lb: ReturnType<typeof makeLoopback>): Promise<void> {
  await new Promise<void>((resolve) => lb.server.close(() => resolve()));
}

async function closeBrainDb(): Promise<void> {
  (await import("../lib/brain-db.js")).closeDb();
}

async function bootSync(remoteUrl: string): Promise<BootSyncDigest> {
  writeConfig(remoteUrl);
  const { buildBootSyncDigest } = await import("../verbs/boot-sync.js");
  return buildBootSyncDigest(SLUG);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-td338-"));
  savedEnv = { ...process.env };
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
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

// ---------------------------------------------------------------------------
// T2 — AC-2 PROOF (CLI). Identical outcome to the brain-side T1.
// ---------------------------------------------------------------------------

describe("TD-338 T2 — AC-2: the CLI pull door folds inbound rows", () => {
  it("folds priority/brief_type/phase on a real boot-sync pull (INSERT branch)", async () => {
    seedSchema();
    const lb = makePullLoopback({ brief_status: [dirtyRow()] });
    await listen(lb);
    try {
      const d = await bootSync(`http://127.0.0.1:${lb.port()}`);
      expect(d.brain_pull.ok).toBe(true);

      withDb((db) => {
        const row = db
          .prepare("SELECT * FROM brief_status WHERE brief_id = 'BR-045'")
          .get() as Record<string, unknown>;
        // The same three assertions the brain-side T1 makes.
        expect(row.priority).toBe("P2-Medium");
        expect(row.brief_type).toBe("Technical Debt");
        expect(row.phase).toBe("BUILDING");
        // Untouched columns survive verbatim.
        expect(row.title).toBe("HR read tools on mocasmart-mcp");
        expect(row.status).toBe("Done");
      });
    } finally {
      await close(lb);
    }
  });

  it("folds on the LWW-UPDATE branch too", async () => {
    seedSchema();
    withDb((db) => {
      db.prepare(
        `INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority, phase, updated_at)
         VALUES ('moca-ai-agent','BR-045','Feature','old','Ready','P3-Low','INIT','2026-01-01 00:00:00')`,
      ).run();
    });
    const lb = makePullLoopback({ brief_status: [dirtyRow()] });
    await listen(lb);
    try {
      await bootSync(`http://127.0.0.1:${lb.port()}`);
      withDb((db) => {
        const row = db
          .prepare("SELECT * FROM brief_status WHERE brief_id = 'BR-045'")
          .get() as Record<string, unknown>;
        expect(row.priority).toBe("P2-Medium");
        expect(row.brief_type).toBe("Technical Debt");
      });
    } finally {
      await close(lb);
    }
  });

  // T3's no-bump invariant, on the CLI door.
  it("stores the INBOUND updated_at byte-for-byte (no bump ⇒ no fight)", async () => {
    seedSchema();
    const lb = makePullLoopback({
      brief_status: [dirtyRow({ updated_at: "2026-08-04 11:22:33" })],
    });
    await listen(lb);
    try {
      await bootSync(`http://127.0.0.1:${lb.port()}`);
      withDb((db) => {
        const row = db
          .prepare("SELECT updated_at FROM brief_status WHERE brief_id = 'BR-045'")
          .get() as { updated_at: string };
        expect(row.updated_at).toBe("2026-08-04 11:22:33");
      });
    } finally {
      await close(lb);
    }
  });

  it("does not fold a row that loses LWW (T5)", async () => {
    seedSchema();
    withDb((db) => {
      db.prepare(
        `INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority, phase, updated_at)
         VALUES ('moca-ai-agent','BR-045','Feature','current','Ready','P3-Low','INIT','2026-08-04 00:00:00')`,
      ).run();
    });
    const lb = makePullLoopback({
      brief_status: [dirtyRow({ updated_at: "2020-01-01 00:00:00" })],
    });
    await listen(lb);
    try {
      const d = await bootSync(`http://127.0.0.1:${lb.port()}`);
      // Nothing merged ⇒ nothing folded ⇒ the digest stays silent.
      expect(d.brain_pull.normalization).toBeUndefined();
      withDb((db) => {
        const row = db
          .prepare("SELECT * FROM brief_status WHERE brief_id = 'BR-045'")
          .get() as Record<string, unknown>;
        expect(row.priority).toBe("P3-Low");
        expect(row.title).toBe("current");
      });
    } finally {
      await close(lb);
    }
  });

  it("leaves an unmapped table (learnings) byte-identical (T6)", async () => {
    seedSchema();
    const lb = makePullLoopback({
      learnings: [
        {
          project: "igris-ai",
          category: "pattern",
          title: "P2", // a string the priority fold WOULD have rewritten
          content: "TD",
          tags: "b,a",
          scope: "project",
          confidence: 0.8,
          created_at: "2026-08-04 00:00:00",
          updated_at: "2026-08-04 00:00:00",
        },
      ],
    });
    await listen(lb);
    try {
      const d = await bootSync(`http://127.0.0.1:${lb.port()}`);
      expect(d.brain_pull.normalization).toBeUndefined();
      withDb((db) => {
        const row = db.prepare("SELECT * FROM learnings").get() as Record<string, unknown>;
        expect(row.title).toBe("P2");
        expect(row.content).toBe("TD");
      });
    } finally {
      await close(lb);
    }
  });
});

// ---------------------------------------------------------------------------
// T10 — the report reaches the boot-sync digest, and is silent when clean
// ---------------------------------------------------------------------------

describe("TD-338 T10 — the ingress report reaches the digest", () => {
  it("names every fold and every non-canonical passthrough", async () => {
    seedSchema();
    const lb = makePullLoopback({
      brief_status: [
        dirtyRow(),
        dirtyRow({ brief_id: "TD-002", priority: "P4-Trivial", brief_type: "Spike", phase: "COMPLETE" }),
      ],
    });
    await listen(lb);
    try {
      const d = await bootSync(`http://127.0.0.1:${lb.port()}`);
      const n = d.brain_pull.normalization;
      expect(n).toBeDefined();
      expect(n?.normalized).toBe(1); // only BR-045 folded
      expect(n?.folds).toEqual(
        expect.arrayContaining([
          'brief_status moca-ai-agent|BR-045: brief_type "TD" -> "Technical Debt"',
          'brief_status moca-ai-agent|BR-045: priority "P2" -> "P2-Medium"',
          'brief_status moca-ai-agent|BR-045: phase "building" -> "BUILDING"',
        ]),
      );
      // The unknowns were STORED VERBATIM and REPORTED — never folded.
      expect(n?.non_canonical).toEqual(
        expect.arrayContaining([
          'brief_status moca-ai-agent|TD-002: brief_type="Spike"',
          'brief_status moca-ai-agent|TD-002: priority="P4-Trivial"',
        ]),
      );
      withDb((db) => {
        const row = db
          .prepare("SELECT * FROM brief_status WHERE brief_id = 'TD-002'")
          .get() as Record<string, unknown>;
        expect(row.priority).toBe("P4-Trivial");
        expect(row.brief_type).toBe("Spike");
      });
    } finally {
      await close(lb);
    }
  });

  it("is OMITTED ENTIRELY on a clean pull (no new noise)", async () => {
    seedSchema();
    const lb = makePullLoopback({
      brief_status: [
        dirtyRow({ priority: "P1-High", brief_type: "Feature", phase: "COMPLETE" }),
      ],
    });
    await listen(lb);
    try {
      const d = await bootSync(`http://127.0.0.1:${lb.port()}`);
      expect(d.brain_pull.ok).toBe(true);
      expect(d.brain_pull.normalization).toBeUndefined();
      expect(Object.keys(d.brain_pull).sort()).toEqual(["ok", "summary"]);
    } finally {
      await close(lb);
    }
  });
});

// ---------------------------------------------------------------------------
// TD-333 T7 — `status` folds at the CLI door too, and the two copies AGREE.
// The payloads and outcomes here mirror the brain-side T6/T8 one-for-one.
// ---------------------------------------------------------------------------

describe("TD-333 T7 — the CLI pull door folds `status`", () => {
  it("folds Completed -> Done and InProgress -> In Progress on a real pull", async () => {
    seedSchema();
    const lb = makePullLoopback({
      brief_status: [
        // hold the other three fields canonical so `status` is the only mover
        dirtyRow({
          brief_id: "BR-045",
          status: "Completed",
          brief_type: "Feature",
          priority: "P1-High",
          phase: "COMPLETE",
        }),
        dirtyRow({
          brief_id: "BR-002",
          status: "InProgress",
          brief_type: "Feature",
          priority: "P1-High",
          phase: "BUILDING",
        }),
      ],
    });
    await listen(lb);
    try {
      const d = await bootSync(`http://127.0.0.1:${lb.port()}`);
      expect(d.brain_pull.ok).toBe(true);

      withDb((db) => {
        const rows = db
          .prepare("SELECT brief_id, status, updated_at FROM brief_status ORDER BY brief_id")
          .all() as Record<string, unknown>[];
        expect(rows).toEqual([
          { brief_id: "BR-002", status: "In Progress", updated_at: "2026-08-04 00:00:00" },
          { brief_id: "BR-045", status: "Done", updated_at: "2026-08-04 00:00:00" },
        ]);
      });

      const n = d.brain_pull.normalization;
      expect(n?.normalized).toBe(2);
      expect(n?.folds).toEqual(
        expect.arrayContaining([
          'brief_status moca-ai-agent|BR-045: status "Completed" -> "Done"',
          'brief_status moca-ai-agent|BR-002: status "InProgress" -> "In Progress"',
        ]),
      );
      expect(n?.non_canonical ?? []).toEqual([]);
    } finally {
      await close(lb);
    }
  });

  it("stores a SENTENCE status VERBATIM and reports it (the fold never invents)", async () => {
    seedSchema();
    const sentence = "Split (see FR-161, FR-162, FR-163, FR-164, FR-165, FR-166, FR-167)";
    const lb = makePullLoopback({
      brief_status: [
        dirtyRow({
          brief_id: "FR-160",
          status: sentence,
          brief_type: "Feature",
          priority: "P1-High",
          phase: "COMPLETE",
        }),
      ],
    });
    await listen(lb);
    try {
      const d = await bootSync(`http://127.0.0.1:${lb.port()}`);

      withDb((db) => {
        const row = db
          .prepare("SELECT * FROM brief_status WHERE brief_id = 'FR-160'")
          .get() as Record<string, unknown>;
        // Byte-for-byte: no fold, no truncation, no "cleanup".
        expect(row.status).toBe(sentence);
      });

      const n = d.brain_pull.normalization;
      expect(n?.normalized).toBe(0);
      expect(n?.folds ?? []).toEqual([]);
      expect(n?.non_canonical).toEqual([
        `brief_status moca-ai-agent|FR-160: status="${sentence}"`,
      ]);
    } finally {
      await close(lb);
    }
  });

  it("reports the three MISSING STATES rather than folding them (TD-311)", async () => {
    seedSchema();
    const lb = makePullLoopback({
      brief_status: ["Cancelled", "Superseded", "Deferred"].map((status, i) =>
        dirtyRow({
          brief_id: `TD-10${i}`,
          status,
          brief_type: "Feature",
          priority: "P1-High",
          phase: "COMPLETE",
        }),
      ),
    });
    await listen(lb);
    try {
      const d = await bootSync(`http://127.0.0.1:${lb.port()}`);

      withDb((db) => {
        const rows = db
          .prepare("SELECT status FROM brief_status ORDER BY brief_id")
          .all() as Record<string, unknown>[];
        expect(rows.map((r) => r.status)).toEqual(["Cancelled", "Superseded", "Deferred"]);
      });

      const n = d.brain_pull.normalization;
      expect(n?.normalized).toBe(0);
      expect(n?.non_canonical).toEqual([
        'brief_status moca-ai-agent|TD-100: status="Cancelled"',
        'brief_status moca-ai-agent|TD-101: status="Superseded"',
        'brief_status moca-ai-agent|TD-102: status="Deferred"',
      ]);
    } finally {
      await close(lb);
    }
  });
});
