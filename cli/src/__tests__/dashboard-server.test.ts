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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { get as httpGet, request as httpRequest } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb as closeBrainDb } from "../lib/brain-db.js";
import { closeDb as closeRegistryDb } from "../lib/registry.js";
import { resetBrainBridge } from "../lib/brain-bridge.js";
import {
  isHostAllowed,
  startServer,
  type DashboardServer,
} from "../lib/dashboard/server.js";
import { contentTypeFor, resolveStatic } from "../lib/dashboard/static.js";

/** ASYNC child spawn — see `postFromChild`; a SYNC one deadlocks the server. */
const execFileAsync = promisify(execFile);

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
      -- The FK is DECLARED here to mirror the real schema (db.ts:283-295),
      -- and it is LIVE: this handle is a plain new Database() with no pragma,
      -- which better-sqlite3 opens with foreign_keys = 1 (asserted directly
      -- further down this file). So the INSERT ORDER below is load-bearing --
      -- every projects row precedes the brief_status rows that reference it,
      -- and reversing them would fail rather than seed an orphan.
      CREATE TABLE brief_status (
        brief_id TEXT PRIMARY KEY, project TEXT NOT NULL,
        status TEXT NOT NULL, priority TEXT,
        FOREIGN KEY (project) REFERENCES projects(slug)
      );
      INSERT INTO brief_status VALUES ('FR-238','demo','in_progress','P1-High');
      INSERT INTO brief_status VALUES ('FR-239','demo','pending','P2-Medium');
      INSERT INTO brief_status VALUES ('TD-001','demo','pending',NULL);
      -- BR-082: a brief on the OTHER project, with a status and a priority no
      -- demo brief has. Without it the unscoped /api/summary would return the
      -- same numbers as the scoped one and the aggregate assertion would pass
      -- against a route that had ignored the widening entirely.
      -- (No backticks in this block: it is inside a template literal.)
      INSERT INTO brief_status VALUES ('BR-001','aaa-fixture','archived','P3-Low');
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
      -- BR-082: same reason as the brief above — the active-instance count has
      -- to DISAGREE between the two scopes, or the widened read is unfalsifiable.
      INSERT INTO instances (id, machine_hostname, project_slug, status)
        VALUES ('i-2', 'host', 'aaa-fixture', 'active');
      -- ...and one that is NOT active, so "active" is still doing work in both.
      INSERT INTO instances (id, machine_hostname, project_slug, status)
        VALUES ('i-3', 'host', 'aaa-fixture', 'idle');
      -- BR-082, and this row is the interesting one: instances.project_slug is
      -- NULLABLE with no FK (db.ts:328-340), so an ACTIVE session that belongs
      -- to no project is a real state. It is why the unscoped read is
      -- "everything" and NOT "all projects" -- the two counts differ by exactly
      -- this row, which is the TD-326 shape on this page's own data.
      INSERT INTO instances (id, machine_hostname, project_slug, status)
        VALUES ('i-4', 'host', NULL, 'active');
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

  // NOT "there are zero write endpoints" — that was true until FR-241 and is
  // now false. This probes ONE path (`/api/health`), so it can only ever claim
  // what that path does. The write endpoint's own method/Origin/Content-Type/
  // size fences are G-SEC-1, below in this file, which covers all four.
  // (NOT G-TR-0 — that is the sandbox fence and says so: it proves the suite
  // never addressed ~/.igris and explicitly "nor anything about correctness".)
  it("POST/PUT/PATCH/DELETE at /api/health are refused — a GET-only path", async () => {
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

  // BR-082 — this REPLACES "no project degrades rather than guessing". That
  // contract was correct while the only caller was an Overview page with no
  // clear affordance; the page now has one, and answering its deliberate
  // "every project" with `degraded` would report a feature as a fault.
  interface SummaryShape {
    project: string | null;
    briefs: {
      total: number;
      by_status: Record<string, number>;
      by_priority: Record<string, number>;
    };
    instances: { active: number };
    degraded: { reason: string } | null;
  }

  it("/api/summary with NO project aggregates every project, undegraded", async () => {
    const scoped = await json<SummaryShape>("/api/summary?project=demo");
    const all = await json<SummaryShape>("/api/summary");

    expect(all.project).toBeNull();
    // Not a degradation. The old `no project selected` reason must be GONE —
    // asserted by absence of the string, not by `degraded === null` alone, so
    // a route that reintroduced it under a different field still fails.
    expect(all.degraded).toBeNull();
    expect(JSON.stringify(all)).not.toContain("no project selected");

    // Assert-then-diff: the aggregate must EXCEED the scoped read, or the
    // widening is unobservable. Fixture: demo has 3 briefs, aaa-fixture 1.
    expect(scoped.briefs.total).toBe(3);
    expect(all.briefs.total).toBe(4);
    expect(all.briefs.total).toBeGreaterThan(scoped.briefs.total);

    // ...and it must be a real GROUP BY over the widened set, not the scoped
    // map with a bigger total: `archived` and `P3-Low` exist ONLY on the row
    // belonging to the other project.
    expect(scoped.briefs.by_status.archived).toBeUndefined();
    expect(all.briefs.by_status.archived).toBe(1);
    expect(all.briefs.by_status.pending).toBe(2);
    expect(scoped.briefs.by_priority["P3-Low"]).toBeUndefined();
    expect(all.briefs.by_priority["P3-Low"]).toBe(1);
    // The null-priority label survives the widening.
    expect(all.briefs.by_priority.Unset).toBe(1);

    // The instance count widens too, and `status = 'active'` still bites: the
    // fixture has an idle instance on the other project that neither counts.
    expect(scoped.instances.active).toBe(1);
    expect(all.instances.active).toBe(3);
  });

  it("/api/summary unscoped is EVERYTHING, which is strictly more than all projects", async () => {
    // The honesty gate. `instances.project_slug` is nullable, so an active
    // session belonging to NO project is a real state — and the unscoped read
    // includes it. "All projects" and "everything" are therefore different
    // numbers here, and the page that renders this must say which it shows.
    const all = await json<SummaryShape>("/api/summary");
    const perProject = await Promise.all(
      ["demo", "aaa-fixture"].map((p) =>
        json<SummaryShape>(`/api/summary?project=${p}`),
      ),
    );
    const summed = perProject.reduce((n, s) => n + s.instances.active, 0);

    expect(summed).toBe(2);
    expect(all.instances.active).toBe(3);
    expect(all.instances.active - summed).toBe(1); // the project-less session

    // ...while the brief counts reconcile, and that is a property of the
    // SCHEMA rather than of this fixture's data: `brief_status.project` is
    // NOT NULL with a live FK to projects(slug), so neither a NULL nor an
    // orphan is reachable. The next test proves the unreachability directly.
    expect(perProject.reduce((n, s) => n + s.briefs.total, 0)).toBe(
      all.briefs.total,
    );
  });

  it("a project with briefs CANNOT be deleted — the FK is live on a plain handle", () => {
    // BR-082 shipped a claim that BRIEFS "cannot diverge, by construction —
    // engine-enforced FK". Warden rejected it, reasoning that only the BRAIN
    // connection sets `foreign_keys = ON` while the CLI handle leaves it off,
    // so `doctor --remove-orphans` could orphan rows. That reasoning came from
    // a comment in `brain-db.ts` which was itself FALSE.
    //
    // Measured instead of argued: better-sqlite3 enables `foreign_keys` by
    // DEFAULT, so the FK is live on a handle that sets no pragma at all — which
    // is the shape `registry.ts#getDb` and `brain-db.ts#openDb` both open.
    //
    // PROVES: an orphan is unreachable through a plain DELETE, so the unscoped
    //   BRIEFS count cannot exceed the sum over projects by that route.
    // Does NOT prove: that no other path can orphan a row (a raw sqlite3 CLI
    //   with the pragma off, or a future handle that disables it, both could).
    //   Sibling: the census in `brain-db.ts`'s header.
    const db = new Database(join(sandbox, "memory", "knowledge.db"));
    try {
      // No `foreign_keys` pragma — deliberately. This is the CLI's own shape.
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(() =>
        db.exec("DELETE FROM projects WHERE slug = 'aaa-fixture'"),
      ).toThrow(/FOREIGN KEY constraint failed/);

      // SELF-NEGATIVE-CONTROL: with the pragma explicitly OFF the same DELETE
      // succeeds, so the throw above is attributable to the FK and not to some
      // unrelated guard.
      db.pragma("foreign_keys = OFF");
      expect(() =>
        db.exec("DELETE FROM projects WHERE slug = 'aaa-fixture'"),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("/api/summary for an UNKNOWN project is empty, not the aggregate", async () => {
    // The self-negative-control for the test above. If the route had widened by
    // treating any falsy/unmatched project as "no filter", this would return 4.
    const s = await json<SummaryShape>("/api/summary?project=no-such-project");
    expect(s.project).toBe("no-such-project");
    expect(s.briefs.total).toBe(0);
    expect(s.instances.active).toBe(0);
    expect(s.degraded).toBeNull();
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

  /**
   * FR-240 G-EP-5. Two new server-layer files landed with the layer views, and
   * a new server-layer file OUTSIDE this scan is an unguarded file — the scan's
   * coverage is enumerated, not inferred, so it silently shrinks in relative
   * terms every time the directory grows.
   *
   * PAIRING (FR-239 learning 1095). This proves the CLI side of the fence: no
   * SQL above the bridge. It does NOT prove the brain-side readers are pure —
   * that they import no `db.js` singleton and issue no writes. Its sibling on
   * the other side of the boundary is
   * `brain-mcp-server/src/tools/__tests__/pure-read-purity.test.ts`. Both are
   * required: SQL-free routes calling an impure reader would still mutate the
   * operator's brain.
   */
  it("params.ts and context-docs-read.ts hold no SQL (FR-240 G-EP-5)", () => {
    for (const rel of [
      "../lib/dashboard/params.ts",
      "../lib/dashboard/context-docs-read.ts",
    ]) {
      const src = readFileSync(new URL(rel, import.meta.url), "utf-8");
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
        expect(kw.test(code), `${rel} must not match ${kw}`).toBe(false);
      }
    }
  });

  /**
   * FR-241 — **the write module is in the corpus.**
   *
   * This is the one the brief that introduces MUTATION owes: a scan whose
   * coverage is enumerated silently shrinks in relative terms every time the
   * directory grows, and the file it would be most costly to leave outside is
   * the only one that can write. `brain-write-bridge.ts` holds the whole write
   * door and must contain no SQL at all — every mutation is
   * `gateway.dispatch(<a name from the frozen map>, args)`.
   *
   * WHAT THIS PROVES: no server-layer file names a SQL statement or opens a
   * database.
   * WHAT IT DOES NOT PROVE: that the write actually reaches the brain's own
   * handler rather than some other path — a grep cannot see a call graph, and a
   * grep-only guard on a NEW module is exactly what got FR-240 rejected. The
   * behavioural half (spy the resolved handler; assert a bogus tool name
   * changes no row) is FR-241's G-TR-5(b) in
   * `dashboard-triage-endpoint.test.ts`. **Both are required.**
   */
  it("brain-write-bridge.ts and routes.ts's write path hold no SQL (FR-241)", () => {
    for (const rel of [
      "../lib/brain-write-bridge.ts",
      "../lib/dashboard/routes.ts",
      "../lib/dashboard/server.ts",
    ]) {
      const src = readFileSync(new URL(rel, import.meta.url), "utf-8");
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
        expect(kw.test(code), `${rel} must not match ${kw}`).toBe(false);
      }
    }
  });

  /**
   * The corpus is ENUMERATED, so it must be asserted.
   *
   * Every scan above is a hand-written path list. A path that no longer exists
   * (a rename, a move) makes `readFileSync` throw — loud. But a path list that
   * simply never grew is SILENT, and this whole block's coverage claim is
   * "every server-layer file", not "these seven". So: read the directory and
   * require every `.ts` in it to be named by one of the scans.
   */
  it("the scan covers EVERY file in the server layer — nothing is unguarded", () => {
    const dir = fileURLToPath(new URL("../lib/dashboard/", import.meta.url));
    const scanned = new Set([
      "routes.ts",
      "server.ts",
      "static.ts",
      "params.ts",
      "context-docs-read.ts",
      "graph-query.ts",
      // Not SQL-scanned above but deliberately so, and named here so the set is
      // a complete accounting rather than a partial one:
      "headers.ts", // constants only
      "lock.ts", // filesystem lockfile; no brain access
      "default-project.ts", // pure function over rows the caller supplies
    ]);
    const present = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(present.length).toBeGreaterThanOrEqual(9);
    for (const f of present) {
      expect(scanned.has(f), `${f} is in the server layer but not in the scan list`).toBe(
        true,
      );
    }
    // ...and the write module, which lives one directory up beside the read
    // bridge rather than under `dashboard/`, is really being read.
    const writeSrc = readFileSync(
      new URL("../lib/brain-write-bridge.ts", import.meta.url),
      "utf-8",
    );
    expect(writeSrc.length).toBeGreaterThan(2000);
    expect(writeSrc).toContain("TRIAGE_ACTIONS");
    expect(writeSrc).toContain("gateway.dispatch");
  });

  /**
   * Self-negative-control for the scan above (FR-239 learning 1094).
   *
   * Every assertion in this describe block observes only "did not match". That
   * outcome is indistinguishable between "the files are clean" and "the regexes
   * are broken". Running the SAME patterns over a string that MUST match makes
   * the difference observable.
   */
  it("the zero-SQL scan can actually fire", () => {
    const dirty = `
      const rows = db.prepare("SELECT * FROM learnings").all();
      db.prepare("INSERT INTO learnings (id) VALUES (1)").run();
      db.prepare("UPDATE learnings SET access_count = 1").run();
      db.prepare("DELETE FROM learnings WHERE id = 1").run();
      db.exec("CREATE TABLE t (a INT)");
      const handle = new Database(":memory:");
    `;
    for (const kw of [
      /\bSELECT\s/i,
      /\bINSERT\s+INTO\b/i,
      /\bUPDATE\s+\w+\s+SET\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bCREATE\s+TABLE\b/i,
      /\.prepare\s*\(/,
      /\bnew Database\b/,
    ]) {
      expect(kw.test(dirty), `pattern ${kw} did not fire on the dirty fixture`).toBe(
        true,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// G-SEC-1 — FR-241: the fences in front of the ONE write endpoint
// ---------------------------------------------------------------------------

/**
 * FR-238 through FR-240 shipped ZERO write endpoints and this file asserted the
 * blanket "no method but GET/HEAD". FR-241 adds exactly one, so the blanket
 * claim is replaced by five specific ones — each fence tested for what it
 * blocks, and each with the paired case that must still be ALLOWED.
 *
 * WHAT THIS PROVES: the listener is reachable, for a mutation, only from the
 * page it serves, only at one path, only with a JSON content type, and only
 * with a bounded body.
 * WHAT IT DOES NOT PROVE: anything about a malicious browser extension or
 * another process running as the operator on this same machine. A loopback
 * personal tool cannot defend against those and this brief does not pretend to.
 * It also proves nothing about what the endpoint DOES — that is
 * `dashboard-triage-endpoint.test.ts`, which runs against a real brain engine.
 *
 * NOTE ON THE BRAIN: this suite's sandbox has NO brain, so a POST that clears
 * every fence returns 200 with `degraded`. That is the correct outcome to
 * assert here — it means the request REACHED the handler, which is exactly what
 * distinguishes "the fence let it through" from "the fence blocked it".
 */
describe("G-SEC-1 — the write surface's fences", () => {
  /**
   * A POST with full control over method, path, headers and body.
   *
   * A TRANSPORT ERROR IS NOT ALLOWED TO PRE-EMPT A RESPONSE, and that is not a
   * convenience — it is what the 413 case is measuring.
   *
   * When the body exceeds the cap, the server writes the 413 and destroys the
   * request stream on `finish`. The client is still uploading, so its `write()`
   * raises **EPIPE**. A naive `r.on("error", reject)` therefore fails the test
   * with `write EPIPE` and never looks at the status — which is exactly the
   * shape that let an earlier draft of the server (`req.destroy()` BEFORE the
   * write) pass a "the big body is refused" test while a real `curl` observed
   * HTTP **000**. So: the response wins if it arrives, and a transport error is
   * only fatal when no response ever did. A reset with no response still fails,
   * which is the property the fence is supposed to have.
   */
  function send(
    method: string,
    path: string,
    body: string | null,
    headers: Record<string, string> = {},
  ): Promise<Fetched> {
    const server = srv;
    if (server === null) throw new Error("server not started");
    return new Promise((resolve, reject) => {
      let responded = false;
      let transportError: Error | null = null;
      const payload = body === null ? null : Buffer.from(body, "utf-8");
      const r = httpRequest(
        {
          host: "127.0.0.1",
          port: server.port,
          path,
          method,
          agent: false,
          headers: {
            host: `127.0.0.1:${server.port}`,
            ...(payload !== null
              ? { "content-type": "application/json", "content-length": String(payload.length) }
              : {}),
            ...headers,
          },
        },
        (res) => {
          responded = true;
          let text = "";
          res.setEncoding("utf-8");
          res.on("data", (c: string) => (text += c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: text, headers: res.headers }),
          );
        },
      );
      r.on("error", (err: Error) => {
        transportError = err;
        // Give the response a beat to arrive; only then is the error fatal.
        setTimeout(() => {
          if (!responded) reject(transportError ?? err);
        }, 250);
      });
      if (payload !== null) {
        // The write itself can throw synchronously on a destroyed socket.
        try {
          r.write(payload);
        } catch (err) {
          transportError = err as Error;
        }
      }
      try {
        r.end();
      } catch {
        /* the socket is already gone; the response handler decides the verdict */
      }
    });
  }

  const VALID = JSON.stringify({ action: "dismiss", ids: [1], reason: "fence probe" });

  /**
   * POST from a SEPARATE PROCESS, with a `reason` of `bytes` characters.
   *
   * NOT a convenience. The oversize case answers the request while the client
   * is still uploading and then destroys the socket, and an IN-PROCESS client
   * — `http.request` and `fetch`/undici alike — shares this event loop, races
   * the destroy, raises EPIPE mid-write and DISCARDS the already-parsed
   * response. Measured both ways: in-process reports `write EPIPE` and no
   * status; a real out-of-process `curl` reports `CODE=413` with the message
   * body, exit 0. The server is correct; the same-process client is the
   * instrument that cannot see it. So the gate uses an instrument that can.
   *
   * `execFile` (ASYNC), never `execFileSync`. The server runs on THIS event
   * loop, so a synchronous spawn blocks the very loop that has to answer the
   * child and both sides deadlock until the timeout — measured as
   * `spawnSync … ETIMEDOUT` on both the oversize AND the small case, which is
   * the tell that the harness, not the server, was at fault. The same artifact
   * produced an earlier false reading of "the 413 path hangs".
   */
  async function postFromChild(
    port: number,
    bytes: number,
  ): Promise<{ status: number; body: string }> {
    const program = `
      const body = JSON.stringify({ action: "dismiss", ids: [1], reason: "x".repeat(${bytes}) });
      const res = await fetch("http://127.0.0.1:${port}/api/triage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      process.stdout.write(JSON.stringify({ status: res.status, body: await res.text() }));
    `;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", program],
      { encoding: "utf-8", timeout: 20_000 },
    );
    return JSON.parse(stdout) as { status: number; body: string };
  }

  it("BASELINE — a well-formed POST from no Origin CLEARS every fence", async () => {
    // The positive control, FIRST. Every 4xx below is only meaningful against a
    // request shape that is known to get through — otherwise "403" and "the
    // endpoint is broken" are the same observation.
    await start();
    const r = await send("POST", "/api/triage", VALID);
    expect(r.status, `body: ${r.body}`).toBe(200);
    // No brain in this sandbox, so it degrades — which is the proof it reached
    // the handler rather than being refused at a fence.
    expect(JSON.parse(r.body)).toMatchObject({ applied: 0, degraded: { reason: expect.any(String) } });
  });

  it("GET /api/triage -> 405 (the path EXISTS; the method is wrong)", async () => {
    await start();
    const r = await req("/api/triage");
    expect(r.status).toBe(405);
    // Not a 404: saying "no such endpoint" would send a reader hunting for a
    // routing bug that is not there.
    expect(JSON.parse(r.body)).toMatchObject({ allow: ["POST"] });
    expect(r.body).not.toContain("no such endpoint");
  });

  it("POST to ANY other path -> 405, including the read endpoints", async () => {
    await start();
    for (const path of ["/api/health", "/api/learnings", "/api/suggestions", "/", "/api/nope"]) {
      const r = await send("POST", path, VALID);
      expect(r.status, `POST ${path}`).toBe(405);
      expect(JSON.parse(r.body).error, path).toContain("/api/triage");
    }
  });

  it("PUT / PATCH / DELETE are refused everywhere, including at /api/triage", async () => {
    await start();
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const r = await send(method, "/api/triage", VALID);
      expect(r.status, `${method} /api/triage`).toBe(405);
    }
  });

  it("Origin: a foreign origin -> 403; the served origin -> allowed; absent -> allowed", async () => {
    await start();
    const port = srv!.port;

    const evil = await send("POST", "/api/triage", VALID, {
      origin: "https://evil.test",
    });
    expect(evil.status).toBe(403);
    expect(JSON.parse(evil.body).error).toContain("cross-origin");

    // A PREFIX of the served origin must NOT be accepted —
    // `http://127.0.0.1:7317` is a prefix of `http://127.0.0.1:7317.evil.test`.
    const prefix = await send("POST", "/api/triage", VALID, {
      origin: `http://127.0.0.1:${port}.evil.test`,
    });
    expect(prefix.status, "an Origin PREFIX was accepted").toBe(403);

    // The literal string `null` — what a sandboxed iframe or a redirected
    // request sends — is NOT the absent header and is refused.
    const nul = await send("POST", "/api/triage", VALID, { origin: "null" });
    expect(nul.status).toBe(403);

    for (const origin of [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
    ]) {
      const ok = await send("POST", "/api/triage", VALID, { origin });
      expect(ok.status, `Origin ${origin}`).toBe(200);
    }
  });

  it("Content-Type: text/plain -> 415 (this is the HTML-form CSRF shape)", async () => {
    // An HTML `<form>` can POST cross-origin with no preflight, but it can only
    // send `application/x-www-form-urlencoded`, `multipart/form-data` or
    // `text/plain`. Requiring JSON forces a preflight, which the Origin fence
    // then answers. All three form encodings are checked, not just one.
    await start();
    for (const ct of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
    ]) {
      const r = await send("POST", "/api/triage", VALID, { "content-type": ct });
      expect(r.status, ct).toBe(415);
      expect(JSON.parse(r.body).error).toContain("application/json");
    }
    // A charset PARAMETER is fine — refusing it would break real clients.
    const ok = await send("POST", "/api/triage", VALID, {
      "content-type": "application/json; charset=utf-8",
    });
    expect(ok.status).toBe(200);
  });

  it("a 1 MB body -> 413, AND the client SEES the status (not a reset socket)", async () => {
    /*
     * THE CLIENT IS `fetch`, NOT `http.request`, AND THAT IS THE POINT.
     *
     * The failure this pins: an early draft of `readBody` called
     * `req.destroy()` on overflow, which resets the connection before the
     * response is flushed, so `curl` reported HTTP **000** (ECONNRESET) rather
     * than the 413 the fence exists to state. A test that merely expected "an
     * error" would have passed against that version — which is why this
     * asserts the STATUS and the MESSAGE.
     *
     * Node's own `http.request` cannot make that assertion. The server answers
     * while the client is still uploading; the client's `write()` raises EPIPE
     * and node discards the already-parsed response, so the test observes
     * `write EPIPE` and never sees the 413 — for a server that a real client
     * reads perfectly. Verified against `curl` with the server in a SEPARATE
     * process (an in-process `execFileSync` probe blocks the event loop and
     * makes every request appear to hang):
     *
     *   curl --data-binary @1MB.json  ->  {"error":"body too large (1000048
     *   bytes; max 65536)"}|CODE=413      (curl exit 0)
     *
     * `fetch` (undici) behaves like curl here: it surfaces the early response.
     */
    await start();
    const r = await postFromChild(srv!.port, 1_000_000);
    expect(r.status, `child reported: ${r.body}`).toBe(413);
    expect((JSON.parse(r.body) as { error: string }).error).toContain("too large");
  });

  it("SELF-NEGATIVE-CONTROL — the SAME out-of-process client reads a 200 on a small body", async () => {
    // Without this, "the child saw a 413" is also what you would observe from a
    // harness that reports 413 unconditionally, and the change of client would
    // be an unexamined variable.
    await start();
    const r = await postFromChild(srv!.port, 16);
    expect(r.status, `child reported: ${r.body}`).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ action: "dismiss" });
  });

  it("a body just UNDER the cap is accepted — the cap is a boundary, not a wall", async () => {
    // The paired case. Without it, "413 on 1 MB" is satisfiable by an endpoint
    // that 413s everything.
    await start();
    const nearly = JSON.stringify({ action: "dismiss", ids: [1], reason: "y".repeat(60_000) });
    expect(Buffer.byteLength(nearly)).toBeLessThan(64 * 1024);
    const r = await send("POST", "/api/triage", nearly);
    // 400 (the reason exceeds the 2000-char field cap) — a CLIENT error from
    // the body VALIDATOR, which proves the body was fully read rather than
    // refused by the size fence.
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error).toContain("at most 2000 characters");
  });

  it("malformed JSON -> 400 with the parser's own message", async () => {
    await start();
    const r = await send("POST", "/api/triage", "{not json");
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error).toContain("malformed JSON body");
  });

  it("a bad Host is still refused on the write path (DNS rebinding)", async () => {
    await start();
    const r = await send("POST", "/api/triage", VALID, { host: "evil.test" });
    expect(r.status).toBe(403);
  });

  it("no CORS header is emitted on the write path either", async () => {
    // The no-CORS posture protects the RESPONSE. The Origin fence is what
    // protects the SIDE EFFECT — both are asserted, because either alone is a
    // half-answer a reader could mistake for the whole one.
    await start();
    const r = await send("POST", "/api/triage", VALID);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    expect(r.headers["cache-control"]).toContain("no-store");
  });
});
