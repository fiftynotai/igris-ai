/**
 * FR-238 (T1-T4) — the loopback server, the four endpoints, the security
 * posture, and the four degraded-brain shapes.
 *
 * The server is started for real on a loopback port and driven over real HTTP.
 * Nothing is mocked: `better-sqlite3` is the module-under-test's own dependency
 * (L-159), and the security guards (Host allowlist, traversal) are only
 * meaningful against a real socket and a real filesystem.
 *
 * The four degraded brains (T4) are seeded as real sandboxes:
 *   populated / present-but-empty-file / absent-file / present-with-no-tables.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { get as httpGet } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb as closeBrainDb } from "../lib/brain-db.js";
import { closeDb as closeRegistryDb } from "../lib/registry.js";
import { resetBrainBridge } from "../lib/brain-bridge.js";
import {
  isHostAllowed,
  startServer,
  type DashboardServer,
} from "../lib/dashboard/server.js";
import { contentTypeFor, resolveStatic } from "../lib/dashboard/static.js";

let sandbox: string;
let srv: DashboardServer | null = null;
const prevBrain = process.env.IGRIS_BRAIN_DIR;

interface Fetched {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function req(
  path: string,
  headers: Record<string, string> = {},
): Promise<Fetched> {
  const server = srv;
  if (server === null) throw new Error("server not started");
  return new Promise((resolve, reject) => {
    const r = httpGet(
      {
        host: "127.0.0.1",
        port: server.port,
        path,
        // `agent: false` is load-bearing. Node's global agent keeps sockets
        // alive, and each test binds a FRESH ephemeral server; a pooled socket
        // to a torn-down listener surfaces as ECONNRESET rather than as a
        // clean connect. One socket per request keeps the suite honest.
        agent: false,
        headers: { host: `127.0.0.1:${server.port}`, ...headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers }),
        );
      },
    );
    r.on("error", reject);
  });
}

async function json<T>(path: string): Promise<T> {
  const r = await req(path);
  expect(r.status).toBe(200);
  return JSON.parse(r.body) as T;
}

/** Seed the two tables the D3-b1 accessors read. */
function seedBrain(dbPath: string, opts: { tables: boolean }): void {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new Database(dbPath);
  if (opts.tables) {
    db.exec(`
      CREATE TABLE projects (
        slug TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
        tech_stack TEXT, igris_version TEXT, status TEXT DEFAULT 'active',
        registered_at TEXT, last_session_at TEXT, metadata TEXT
      );
      INSERT INTO projects (slug, name, path, status, last_session_at)
        VALUES ('demo', 'Demo', '/tmp/demo', 'active', '2026-07-28 09:00:00');
      -- Sorts BEFORE 'demo' and is a throwaway fixture: the exact shape that
      -- made the dashboard open on AGY-DENY-TEST. Its presence is what makes
      -- the default_project assertions below discriminating.
      INSERT INTO projects (slug, name, path, status, last_session_at)
        VALUES ('aaa-fixture', 'Fixture', '/tmp/aaa-fixture', 'active', '2020-01-01 00:00:00');
      CREATE TABLE brief_status (
        brief_id TEXT PRIMARY KEY, project TEXT NOT NULL,
        status TEXT NOT NULL, priority TEXT
      );
      INSERT INTO brief_status VALUES ('FR-238','demo','in_progress','P1-High');
      INSERT INTO brief_status VALUES ('FR-239','demo','pending','P2-Medium');
      INSERT INTO brief_status VALUES ('TD-001','demo','pending',NULL);
      CREATE TABLE instances (
        id TEXT PRIMARY KEY, machine_hostname TEXT NOT NULL, machine_os TEXT,
        project_slug TEXT, project_path TEXT, current_brief TEXT,
        current_phase TEXT, current_task TEXT,
        status TEXT DEFAULT 'active' CHECK (status IN ('active','idle','stale')),
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
        metadata TEXT DEFAULT '{}'
      );
      INSERT INTO instances (id, machine_hostname, project_slug, status)
        VALUES ('i-1', 'host', 'demo', 'active');
    `);
  }
  db.close();
}

/**
 * Start on an OS-assigned port (`port: 0` + `exactPort`), never on the real
 * DEFAULT_PORT: a suite that squats 7317 would collide with an operator's
 * running dashboard and with itself under parallel files. The 7317 -> fallback
 * ladder is exercised end-to-end by `dashboard.bats` instead.
 */
async function start(): Promise<void> {
  if (srv !== null) await srv.close();
  srv = await startServer({ port: 0, exactPort: true, cliVersion: "7.2.0-test" });
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "igris-dash-srv-"));
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
// T1 — bind + static
// ---------------------------------------------------------------------------

describe("T1 — server binds loopback and serves the bundle", () => {
  it("binds 127.0.0.1 only", async () => {
    await start();
    const address = srv?.server.address();
    expect(typeof address === "object" && address !== null && address.address).toBe(
      "127.0.0.1",
    );
    expect(srv?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it("serves / as HTML 200", async () => {
    await start();
    const r = await req("/");
    expect(r.status).toBe(200);
    expect(String(r.headers["content-type"])).toContain("text/html");
  });

  it("serves the built asset bundle when present", async () => {
    await start();
    // The bundle is a build artifact; when it exists, `/` must be its index.
    const r = await req("/");
    expect(r.body.length).toBeGreaterThan(0);
  });

  it("unknown non-asset path falls back to the shell (SPA)", async () => {
    await start();
    const r = await req("/some/client/route");
    expect(r.status).toBe(200);
    expect(String(r.headers["content-type"])).toContain("text/html");
  });

  it("unknown path UNDER /assets/ is a genuine 404, not an HTML fallback", async () => {
    await start();
    const r = await req("/assets/does-not-exist.js");
    expect(r.status).toBe(404);
  });

  it("rejects path traversal with 403", async () => {
    await start();
    for (const path of [
      "/../../../etc/passwd",
      "/assets/../../../../etc/passwd",
      "/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    ]) {
      const r = await req(path);
      expect(r.status === 403 || r.status === 404 || r.status === 200).toBe(true);
      // Whatever the verdict, it must never be the contents of /etc/passwd.
      expect(r.body).not.toContain("root:");
    }
  });

  it("resolveStatic refuses traversal and NUL bytes directly", () => {
    expect(resolveStatic("/../../etc/passwd").kind).not.toBe("file");
    expect(resolveStatic("/a\0b").kind).toBe("traversal");
  });

  it("MIME map covers every extension the bundle emits", () => {
    expect(contentTypeFor("x.html")).toContain("text/html");
    expect(contentTypeFor("x.js")).toContain("text/javascript");
    expect(contentTypeFor("x.css")).toContain("text/css");
    expect(contentTypeFor("x.woff2")).toBe("font/woff2");
    // Unknown -> octet-stream (download, never execute).
    expect(contentTypeFor("x.wat")).toBe("application/octet-stream");
  });
});

// ---------------------------------------------------------------------------
// T2 — security posture
// ---------------------------------------------------------------------------

describe("T2 — Host allowlist and CORS absence", () => {
  it("rejects a Host header outside the allowlist with 403", async () => {
    await start();
    const r = await req("/api/health", { host: "evil.example.com" });
    expect(r.status).toBe(403);
  });

  it("rejects a right-hostname / wrong-port Host", async () => {
    await start();
    const r = await req("/api/health", { host: "127.0.0.1:1" });
    expect(r.status).toBe(403);
  });

  it("accepts localhost and 127.0.0.1 on the bound port", async () => {
    await start();
    expect((await req("/api/health", { host: `localhost:${srv?.port}` })).status).toBe(200);
    expect((await req("/api/health", { host: `127.0.0.1:${srv?.port}` })).status).toBe(200);
  });

  it("isHostAllowed unit table", () => {
    expect(isHostAllowed("127.0.0.1:7317", 7317)).toBe(true);
    expect(isHostAllowed("localhost:7317", 7317)).toBe(true);
    expect(isHostAllowed("LOCALHOST:7317", 7317)).toBe(true);
    expect(isHostAllowed("[::1]:7317", 7317)).toBe(true);
    expect(isHostAllowed("127.0.0.1:7318", 7317)).toBe(false);
    expect(isHostAllowed("attacker.test:7317", 7317)).toBe(false);
    expect(isHostAllowed(undefined, 7317)).toBe(false);
    expect(isHostAllowed("", 7317)).toBe(false);
  });

  it("emits the security headers on EVERY response class", async () => {
    seedBrain(join(sandbox, "memory", "knowledge.db"), { tables: true });
    await start();
    // One probe per response CLASS, because each is emitted by a different
    // code path: JSON (sendJson), static file (serveFile), SPA fallback
    // (serveFile on index.html), and a text error (sendText). A header added
    // to one path and forgotten on another is the regression this catches.
    const probes: Array<[string, Record<string, string>]> = [
      ["/api/health", {}],
      ["/", {}],
      ["/some/client/route", {}],
      ["/api/health", { host: "evil.example.com" }], // 403 text path
    ];
    for (const [path, headers] of probes) {
      const r = await req(path, headers);
      expect(r.headers["x-content-type-options"], path).toBe("nosniff");
      expect(r.headers["x-frame-options"], path).toBe("DENY");
      expect(r.headers["content-security-policy"], path).toBe(
        "frame-ancestors 'none'",
      );
      expect(r.headers["referrer-policy"], path).toBe("no-referrer");
    }
  });

  it("emits the security headers on a hashed asset too", async () => {
    await start();
    // Assets go through serveFile's immutable-cache branch, a DIFFERENT
    // writeHead call from the no-cache one. Derive the real asset path from
    // the built index.html rather than pinning a content hash.
    const index = readFileSync(
      join(__dirname, "..", "..", "dist", "dashboard", "index.html"),
      "utf-8",
    );
    const m = /(?:src|href)="\.(\/assets\/[^"]+)"/.exec(index);
    if (m === null) return; // no built bundle in this tree
    const r = await req(m[1]);
    expect(r.status).toBe(200);
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
  });

  it("emits NO CORS headers", async () => {
    await start();
    const r = await req("/api/health");
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    expect(r.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("sets Cache-Control: no-store on every /api/* response", async () => {
    await start();
    // FR-239 added `/api/graph` as the FIFTH endpoint (row 108). It is listed
    // here rather than only in its own file because this is the surface-wide
    // posture assertion — an endpoint that skips it is the regression.
    for (const p of [
      "/api/health",
      "/api/projects",
      "/api/summary",
      "/api/graph/stats",
      "/api/graph",
    ]) {
      const r = await req(p);
      expect(r.headers["cache-control"]).toBe("no-store");
    }
  });

  it("refuses every write method — there are ZERO write endpoints", async () => {
    await start();
    const server = srv;
    if (server === null) throw new Error("no server");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const status = await new Promise<number>((resolve, reject) => {
        const r = httpGet(
          { host: "127.0.0.1", port: server.port, path: "/api/health", method, agent: false },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        r.on("error", reject);
        r.end();
      });
      expect(status).toBe(405);
    }
  });
});

// ---------------------------------------------------------------------------
// T3 — API contract against a POPULATED brain
// ---------------------------------------------------------------------------

describe("T3 — the four endpoints against a populated brain", () => {
  beforeEach(async () => {
    seedBrain(join(sandbox, "memory", "knowledge.db"), { tables: true });
    await start();
  });

  it("/api/health reports a present brain and a bridge probe", async () => {
    const h = await json<{
      ok: boolean;
      cli_version: string;
      brain: { present: boolean; path: string };
      bridge: { available: boolean; reason: string | null };
      generated_at: string;
      degraded: null | { reason: string };
    }>("/api/health");
    expect(h.ok).toBe(true);
    expect(h.cli_version).toBe("7.2.0-test");
    expect(h.brain.present).toBe(true);
    expect(h.brain.path).toBe(join(sandbox, "memory", "knowledge.db"));
    expect(typeof h.bridge.available).toBe("boolean");
    expect(h.degraded).toBeNull();
    expect(new Date(h.generated_at).toString()).not.toBe("Invalid Date");
  });

  it("/api/projects returns the registry rows", async () => {
    const p = await json<{
      projects: Array<{ slug: string; name: string; status: string }>;
      degraded: null;
    }>("/api/projects");
    expect(p.degraded).toBeNull();
    expect(p.projects.map((r) => r.slug).sort()).toEqual(["aaa-fixture", "demo"]);
    const demo = p.projects.find((r) => r.slug === "demo");
    expect(demo?.status).toBe("active");
  });

  it("/api/projects carries a server-resolved default_project", async () => {
    // End-to-end wiring of the ladder. `demo` has the newer `last_session_at`,
    // so rung 2 must beat the alphabetically-first `aaa-fixture` — which is
    // exactly the bug the ladder fixes, asserted through the real HTTP payload
    // rather than against the pure function.
    const p = await json<{
      projects: Array<{ slug: string }>;
      default_project: string | null;
    }>("/api/projects");
    expect(p.default_project).toBe("demo");
    expect(p.default_project).not.toBe("aaa-fixture");
    // And it must name a project that is actually in the list.
    expect(p.projects.some((r) => r.slug === p.default_project)).toBe(true);
  });

  it("/api/summary returns brief counts + active instances", async () => {
    const s = await json<{
      project: string;
      briefs: { total: number; by_status: Record<string, number>; by_priority: Record<string, number> };
      instances: { active: number };
      degraded: null;
    }>("/api/summary?project=demo");
    expect(s.project).toBe("demo");
    expect(s.briefs.total).toBe(3);
    expect(s.briefs.by_status.pending).toBe(2);
    expect(s.briefs.by_status.in_progress).toBe(1);
    // A null priority is labelled "Unset" by the pinned accessor.
    expect(s.briefs.by_priority.Unset).toBe(1);
    expect(s.instances.active).toBe(1);
    expect(s.degraded).toBeNull();
  });

  it("/api/summary with no project degrades rather than guessing", async () => {
    const s = await json<{ project: null; degraded: { reason: string } }>("/api/summary");
    expect(s.project).toBeNull();
    expect(s.degraded.reason).toContain("no project selected");
  });

  it("/api/graph/stats NEVER returns nodes or edges (R8 structural fence)", async () => {
    const raw = await req("/api/graph/stats?project=demo");
    expect(raw.status).toBe(200);
    const g = JSON.parse(raw.body) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(g, "nodes")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(g, "edges")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(g, "stats")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(g, "edge_resolution")).toBe(true);
  });

  it("an unknown /api/* path is a 404 with a JSON body", async () => {
    const r = await req("/api/nope");
    expect(r.status).toBe(404);
    expect(String(r.headers["content-type"])).toContain("application/json");
  });
});

// ---------------------------------------------------------------------------
// T4 — degraded brains. NEVER a 500, NEVER a stack trace.
// ---------------------------------------------------------------------------

const ALL_ENDPOINTS = [
  "/api/health",
  "/api/projects",
  "/api/summary?project=demo",
  "/api/graph/stats?project=demo",
  "/api/graph?project=demo", // FR-239 — the fifth endpoint (row 108)
];

async function expectAllDegradeCleanly(): Promise<void> {
  for (const path of ALL_ENDPOINTS) {
    const r = await req(path);
    expect(r.status, `${path} must be 200`).toBe(200);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(body, "degraded")).toBe(true);
    // No stack trace ever reaches the wire.
    expect(r.body).not.toContain("    at ");
    expect(r.body).not.toContain(".ts:");
  }
}

describe("T4 — degraded brain: DB file ABSENT", () => {
  it("every endpoint returns 200 + degraded, and data is empty", async () => {
    await start();
    await expectAllDegradeCleanly();

    const h = await json<{ brain: { present: boolean }; degraded: { reason: string } }>(
      "/api/health",
    );
    expect(h.brain.present).toBe(false);
    expect(h.degraded.reason).toContain("brain database not found");

    const p = await json<{
      projects: unknown[];
      default_project: string | null;
      degraded: { reason: string };
    }>("/api/projects");
    expect(p.projects).toEqual([]);
    expect(p.default_project).toBeNull();
    expect(p.degraded.reason).toContain("brain database not found");

    const s = await json<{ briefs: { total: number }; instances: { active: number } }>(
      "/api/summary?project=demo",
    );
    expect(s.briefs.total).toBe(0);
    expect(s.instances.active).toBe(0);

    const g = await json<{ stats: null; degraded: { reason: string } }>(
      "/api/graph/stats?project=demo",
    );
    expect(g.stats).toBeNull();
  });
});

describe("T4 — degraded brain: DB file PRESENT but EMPTY", () => {
  it("every endpoint returns 200 + empty data", async () => {
    mkdirSync(join(sandbox, "memory"), { recursive: true });
    writeFileSync(join(sandbox, "memory", "knowledge.db"), "");
    await start();
    await expectAllDegradeCleanly();

    const s = await json<{ briefs: { total: number } }>("/api/summary?project=demo");
    expect(s.briefs.total).toBe(0);
  });
});

describe("T4 — degraded brain: DB present with NO tables", () => {
  it("the L-133 preflight yields empty counts, never a throw", async () => {
    seedBrain(join(sandbox, "memory", "knowledge.db"), { tables: false });
    await start();
    await expectAllDegradeCleanly();

    const s = await json<{ briefs: { total: number }; instances: { active: number } }>(
      "/api/summary?project=demo",
    );
    expect(s.briefs.total).toBe(0);
    expect(s.instances.active).toBe(0);
  });
});

describe("T4 — degraded brain: a corrupt DB file", () => {
  it("does not 500 — the route catches and reports", async () => {
    mkdirSync(join(sandbox, "memory"), { recursive: true });
    writeFileSync(join(sandbox, "memory", "knowledge.db"), "this is not a sqlite file");
    await start();
    await expectAllDegradeCleanly();
  });
});

// ---------------------------------------------------------------------------
// Scope guard — routes.ts must contain ZERO SQL.
// ---------------------------------------------------------------------------

describe("scope — the server layer holds zero SQL (brief scope item 2)", () => {
  it("routes.ts contains no SQL keyword in code", () => {
    const src = readFileSync(
      new URL("../lib/dashboard/routes.ts", import.meta.url),
      "utf-8",
    );
    // Strip block + line comments so the prose explaining the rule cannot
    // trip the rule.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const kw of [
      /\bSELECT\s/i,
      /\bINSERT\s+INTO\b/i,
      /\bUPDATE\s+\w+\s+SET\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bCREATE\s+TABLE\b/i,
      /\.prepare\s*\(/,
      /\bnew Database\b/,
    ]) {
      expect(kw.test(code), `routes.ts must not match ${kw}`).toBe(false);
    }
  });

  it("graph-query.ts holds no SQL and does no I/O (FR-239 — it is PURE)", () => {
    const src = readFileSync(
      new URL("../lib/dashboard/graph-query.ts", import.meta.url),
      "utf-8",
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const kw of [
      /\bSELECT\s/i,
      /\.prepare\s*\(/,
      /\bnew Database\b/,
      // Purity, not just SQL-freedom: the twin composer must be reachable from
      // a unit test with no brain, no clock and no filesystem. `generatedAt` is
      // a parameter for exactly this reason.
      /\bnew Date\b/,
      /\bDate\.now\b/,
      /\bnode:fs\b/,
      /\bexistsSync\b/,
    ]) {
      expect(kw.test(code), `graph-query.ts must not match ${kw}`).toBe(false);
    }
  });

  it("server.ts and static.ts hold no SQL either", () => {
    for (const rel of ["../lib/dashboard/server.ts", "../lib/dashboard/static.ts"]) {
      const src = readFileSync(new URL(rel, import.meta.url), "utf-8");
      expect(/\.prepare\s*\(/.test(src)).toBe(false);
      expect(/\bnew Database\b/.test(src)).toBe(false);
    }
  });
});
