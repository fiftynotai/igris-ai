/**
 * FR-239 (T1-T3) — `GET /api/graph`, driven over real HTTP against a real
 * seeded brain.
 *
 * Nothing is mocked, for the same reason `dashboard-server.test.ts` mocks
 * nothing (L-159): the thing under test is the composition of the route, the
 * bridge, the dynamic `import()` of the vendored builder, and a real
 * `better-sqlite3` handle. A stubbed bridge would assert that the handler
 * forwards a fixture — which is the least interesting property it has.
 *
 * The seed below is a REAL two-project brain with real `entity_edges` rows, so
 * T2's boundary-node assertion exercises the builder's actual depth-1 closure
 * rather than a shape we invented.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { get as httpGet } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb as closeBrainDb } from "../lib/brain-db.js";
import { closeDb as closeRegistryDb } from "../lib/registry.js";
import { resetBrainBridge } from "../lib/brain-bridge.js";
import { startServer, type DashboardServer } from "../lib/dashboard/server.js";
import type { BrainGraphPayload } from "../types.js";

let sandbox: string;
let srv: DashboardServer | null = null;
const prevBrain = process.env.IGRIS_BRAIN_DIR;

function req(path: string): Promise<{ status: number; body: string }> {
  const server = srv;
  if (server === null) throw new Error("server not started");
  return new Promise((resolve, reject) => {
    const r = httpGet(
      {
        host: "127.0.0.1",
        port: server.port,
        path,
        agent: false,
        headers: { host: `127.0.0.1:${server.port}` },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    r.on("error", reject);
  });
}

async function graph(path: string): Promise<BrainGraphPayload> {
  const r = await req(path);
  expect(r.status, `${path} must be 200`).toBe(200);
  return JSON.parse(r.body) as BrainGraphPayload;
}

/**
 * A real two-project brain.
 *
 * `alpha` owns FR-1 and FR-2 plus a learning; `beta` owns FR-9. The
 * `FR-2 -> FR-9` edge CROSSES the project boundary, which is what makes the
 * T2 drill-down assertion discriminating: scoping to `alpha` must pull `FR-9`
 * in as a `boundary: true` node rather than dropping the edge.
 */
function seedGraphBrain(dbPath: string): void {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE projects (
      slug TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
      tech_stack TEXT, igris_version TEXT, status TEXT DEFAULT 'active',
      registered_at TEXT, last_session_at TEXT, metadata TEXT
    );
    INSERT INTO projects (slug, name, path, status) VALUES
      ('alpha', 'Alpha', '/tmp/alpha', 'active'),
      ('beta',  'Beta',  '/tmp/beta',  'active');

    CREATE TABLE brief_status (
      brief_id TEXT PRIMARY KEY, project TEXT NOT NULL, brief_type TEXT,
      title TEXT, status TEXT NOT NULL, priority TEXT, effort TEXT,
      phase TEXT, updated_at TEXT
    );
    INSERT INTO brief_status VALUES
      ('FR-1','alpha','Feature','First brief','pending','P1-High','M','BUILDING','2026-07-01'),
      ('FR-2','alpha','Feature','Second brief','in_progress','P2-Medium','S',NULL,'2026-07-02'),
      ('FR-9','beta','Feature','Beta brief','pending','P3-Low',NULL,NULL,'2026-07-03');

    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY, project TEXT, title TEXT, content TEXT,
      category TEXT, scope TEXT, confidence REAL, source_brief TEXT,
      review_status TEXT, updated_at TEXT
    );
    INSERT INTO learnings (id, project, title, content, category, scope, confidence, source_brief, review_status, updated_at)
      VALUES (7,'alpha','A learning','body','pattern','project',0.9,'FR-1','approved','2026-07-04');

    -- Present but EMPTY on purpose. The builder reports every absent table as a
    -- degradation, so a seed that omits them would make a null degraded field
    -- unreachable and quietly weaken every assertion below it.
    CREATE TABLE goals (
      goal_id TEXT PRIMARY KEY, project_slug TEXT, title TEXT, status TEXT,
      priority TEXT, deadline TEXT, achieved_at TEXT
    );
    CREATE TABLE errors (
      id INTEGER PRIMARY KEY, project TEXT, message TEXT,
      occurrence_count INTEGER, scope TEXT, resolved_at TEXT
    );
    CREATE TABLE graph_nodes (
      node_type TEXT, node_external_id TEXT, label TEXT, properties TEXT
    );
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY, project TEXT, summary TEXT, brief_id TEXT,
      phase TEXT, started_at TEXT, ended_at TEXT
    );

    CREATE TABLE entity_edges (
      id INTEGER PRIMARY KEY, from_type TEXT, from_id TEXT, to_type TEXT,
      to_id TEXT, edge_type TEXT, confidence REAL, provenance TEXT,
      metadata TEXT DEFAULT '{}'
    );
    INSERT INTO entity_edges (id, from_type, from_id, to_type, to_id, edge_type, confidence, provenance, metadata) VALUES
      (1,'brief','FR-1','brief','FR-2','parent_of',0.9,'observed','{}'),
      (2,'brief','FR-1','learning','7','derived_from',0.8,'inferred','{}'),
      (3,'brief','FR-2','brief','FR-9','blocks',0.7,'user','{}'),
      -- soft-deleted: must never appear on the wire.
      (4,'brief','FR-1','brief','FR-9','related_to',0.5,'backfill','{"deleted":1}');
  `);
  db.close();
}

async function start(): Promise<void> {
  if (srv !== null) await srv.close();
  srv = await startServer({ port: 0, exactPort: true, cliVersion: "7.2.0-test" });
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "igris-dash-graph-"));
  process.env.IGRIS_BRAIN_DIR = sandbox;
  closeBrainDb();
  closeRegistryDb();
  resetBrainBridge();
});

afterEach(async () => {
  if (srv !== null) {
    await srv.close();
    srv = null;
  }
  closeBrainDb();
  closeRegistryDb();
  resetBrainBridge();
  if (prevBrain === undefined) delete process.env.IGRIS_BRAIN_DIR;
  else process.env.IGRIS_BRAIN_DIR = prevBrain;
  rmSync(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// T1 — the payload shape
// ---------------------------------------------------------------------------

describe("T1 — /api/graph serves node + edge arrays", () => {
  beforeEach(async () => {
    seedGraphBrain(join(sandbox, "memory", "knowledge.db"));
    await start();
  });

  it("returns both arrays — the fence /api/graph/stats holds does NOT apply here", async () => {
    const g = await graph("/api/graph");
    expect(g.degraded).toBeNull();
    expect(Array.isArray(g.nodes)).toBe(true);
    expect(Array.isArray(g.edges)).toBe(true);
    expect(g.nodes.length).toBe(4); // FR-1, FR-2, FR-9, learning 7
    expect(g.edges.length).toBe(3); // edge 4 is soft-deleted
  });

  it("every node matches whole-graph.ts:117 field for field", async () => {
    const g = await graph("/api/graph");
    // The REQUIRED field set, verbatim from the builder's own interface. An
    // extra field is as much a contract break as a missing one: the browser
    // mirror in `dashboard/src/lib/api.ts` would silently not know about it.
    const required = [
      "key",
      "type",
      "id",
      "project",
      "label",
      "attrs",
      "degree",
    ].sort();
    const optional = ["boundary", "phantom"];
    for (const n of g.nodes) {
      const keys = Object.keys(n);
      expect(keys.filter((k) => !optional.includes(k)).sort()).toEqual(required);
      expect(typeof n.key).toBe("string");
      expect(typeof n.degree).toBe("number");
      expect(typeof n.attrs).toBe("object");
    }
  });

  it("every edge matches whole-graph.ts:142 field for field", async () => {
    const g = await graph("/api/graph");
    const required = [
      "id",
      "source_edge_id",
      "from",
      "to",
      "type",
      "confidence",
      "provenance",
      "resolution",
    ].sort();
    for (const e of g.edges) {
      expect(Object.keys(e).sort()).toEqual(required);
      expect(["unique", "replicated"]).toContain(e.resolution);
      expect(typeof e.source_edge_id).toBe("number");
    }
  });

  it("uses the FR-237 composite key, never a bare id", async () => {
    const g = await graph("/api/graph");
    const fr1 = g.nodes.find((n) => n.id === "FR-1");
    expect(fr1?.key).toBe("brief|alpha|FR-1");
    // Edge endpoints reference the same key space, so the browser can index on
    // `key` alone with no second join.
    const keys = new Set(g.nodes.map((n) => n.key));
    for (const e of g.edges) {
      expect(keys.has(e.from), `dangling from: ${e.from}`).toBe(true);
      expect(keys.has(e.to), `dangling to: ${e.to}`).toBe(true);
    }
  });

  it("carries a server-composed query twin (exemption 04)", async () => {
    const g = await graph("/api/graph");
    expect(g.query.surface).toBe("igris-brain-graph");
    expect(g.query.scale).toBe("4 NODES · 3 EDGES");
    expect(g.query.as_of).toBe(g.generated_at);
    expect(g.query.query.length).toBeGreaterThan(0);
  });

  it("never emits a soft-deleted edge", async () => {
    const g = await graph("/api/graph");
    expect(g.edges.some((e) => e.source_edge_id === 4)).toBe(false);
  });

  it("carries stats but NOT edge_resolution — that is the stats endpoint's job", async () => {
    const g = await graph("/api/graph");
    expect(g.stats?.node_count).toBe(4);
    // Keeping the resolution report on ONE endpoint stops two payloads from
    // carrying the same block and drifting apart.
    expect(
      Object.prototype.hasOwnProperty.call(g, "edge_resolution"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T2 — the project drill-down (D6)
// ---------------------------------------------------------------------------

describe("T2 — ?project=<slug> returns the subgraph WITH boundary nodes", () => {
  beforeEach(async () => {
    seedGraphBrain(join(sandbox, "memory", "knowledge.db"));
    await start();
  });

  it("scopes to the project and pulls the depth-1 boundary in", async () => {
    const g = await graph("/api/graph?project=alpha");
    expect(g.project).toBe("alpha");
    const beta = g.nodes.find((n) => n.id === "FR-9");
    // The cross-project `FR-2 blocks FR-9` edge survives, and its far endpoint
    // arrives FLAGGED. Dropping it would silently amputate the edge; including
    // it unflagged would misrepresent alpha's scope.
    expect(beta, "boundary node FR-9 missing").toBeDefined();
    expect(beta?.boundary).toBe(true);
    expect(beta?.project).toBe("beta");
  });

  it("owned nodes are NOT flagged as boundary", async () => {
    const g = await graph("/api/graph?project=alpha");
    for (const n of g.nodes.filter((x) => x.project === "alpha")) {
      expect(n.boundary).toBeUndefined();
    }
  });

  it("an unknown project degrades to an empty set, not an error", async () => {
    const g = await graph("/api/graph?project=nope");
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.query.scale).toBe("0 NODES · 0 EDGES");
  });

  it("the twin names the scope so the drill-down is re-derivable", async () => {
    const g = await graph("/api/graph?project=alpha");
    expect(g.query.surface).toBe("igris-brain-graph/alpha");
    expect(g.query.query.join("\n")).toContain("project = alpha");
  });
});

// ---------------------------------------------------------------------------
// T3 — the FR-238 degraded contract. NEVER a 500.
// ---------------------------------------------------------------------------

describe("T3 — degraded brains return 200 + degraded, never 500", () => {
  const PATHS = ["/api/graph", "/api/graph?project=alpha"];

  async function expectCleanDegrade(): Promise<void> {
    for (const p of PATHS) {
      const r = await req(p);
      expect(r.status, `${p} must be 200`).toBe(200);
      const g = JSON.parse(r.body) as BrainGraphPayload;
      expect(g.degraded, `${p} must report degraded`).not.toBeNull();
      expect(g.nodes).toEqual([]);
      expect(g.edges).toEqual([]);
      expect(g.stats).toBeNull();
      // A twin still ships — a canvas with no twin is unreproducible.
      expect(g.query.surface.startsWith("igris-brain-graph")).toBe(true);
      expect(g.query.scale).toContain("DEGRADED");
      // No stack trace ever reaches the wire.
      expect(r.body).not.toContain("    at ");
      expect(r.body).not.toContain(".ts:");
    }
  }

  it("brain file ABSENT", async () => {
    await start();
    await expectCleanDegrade();
  });

  it("brain file PRESENT but empty", async () => {
    mkdirSync(join(sandbox, "memory"), { recursive: true });
    writeFileSync(join(sandbox, "memory", "knowledge.db"), "");
    await start();
    // An empty file opens cleanly and simply has no tables, so the builder
    // returns an empty graph rather than failing — a valid, non-degraded
    // answer with a `missing_tables` degradation attached.
    const g = await graph("/api/graph");
    expect(g.nodes).toEqual([]);
    expect(g.degraded?.reason).toContain("brain tables absent");
  });

  it("brain file CORRUPT", async () => {
    mkdirSync(join(sandbox, "memory"), { recursive: true });
    writeFileSync(join(sandbox, "memory", "knowledge.db"), "not a sqlite file");
    await start();
    await expectCleanDegrade();
  });

  it("brain present with NO tables — an empty graph, plus a missing-table report", async () => {
    mkdirSync(join(sandbox, "memory"), { recursive: true });
    new Database(join(sandbox, "memory", "knowledge.db")).close();
    await start();
    const g = await graph("/api/graph");
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.degraded?.reason).toContain("brain tables absent");
    // The twin reports the SCALE here, not DEGRADED: the read succeeded and the
    // answer is genuinely "nothing", which is different from "could not ask".
    expect(g.query.scale).toBe("0 NODES · 0 EDGES");
  });
});

// ---------------------------------------------------------------------------
// The endpoint inherits FR-238's posture with no new branch (row 108).
// ---------------------------------------------------------------------------

describe("/api/graph inherits the FR-238 security posture", () => {
  beforeEach(async () => {
    seedGraphBrain(join(sandbox, "memory", "knowledge.db"));
    await start();
  });

  it("emits no-store and the security headers, and no CORS header", async () => {
    const server = srv;
    if (server === null) throw new Error("no server");
    const headers = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const r = httpGet(
        {
          host: "127.0.0.1",
          port: server.port,
          path: "/api/graph",
          agent: false,
          headers: { host: `127.0.0.1:${server.port}` },
        },
        (res) => {
          res.resume();
          resolve(res.headers as unknown as Record<string, unknown>);
        },
      );
      r.on("error", reject);
    });
    expect(headers["cache-control"]).toBe("no-store");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-security-policy"]).toBe("frame-ancestors 'none'");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects a Host outside the allowlist", async () => {
    const server = srv;
    if (server === null) throw new Error("no server");
    const status = await new Promise<number>((resolve, reject) => {
      const r = httpGet(
        {
          host: "127.0.0.1",
          port: server.port,
          path: "/api/graph",
          agent: false,
          headers: { host: "evil.example.com" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      r.on("error", reject);
    });
    expect(status).toBe(403);
  });

  it("`/api/graph/stats` still strips nodes and edges — the fence is intact", async () => {
    const r = await req("/api/graph/stats?project=alpha");
    const s = JSON.parse(r.body) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(s, "nodes")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(s, "edges")).toBe(false);
  });
});
