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
import {
  TRIAGE_ACTIONS,
  TRIAGE_ACTION_NAMES,
  type TriageActionSpec,
} from "../lib/brain-write-bridge.js";

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
  it("params.ts, context-docs-read.ts, search-fuse.ts and cognition-read.ts hold no SQL", () => {
    for (const rel of [
      "../lib/dashboard/params.ts",
      "../lib/dashboard/context-docs-read.ts",
      // FR-248. `search-fuse.ts` is the brief's ONE new server-layer module and
      // it takes no `db` at all — it fuses lists five arms already produced.
      // Naming it here is what keeps the corpus claim ("every server-layer
      // file") true rather than "every server-layer file as of FR-241".
      "../lib/dashboard/search-fuse.ts",
      // FR-266. `cognition-read.ts` is THIS brief's one new server-layer module.
      // It takes no `db` either — it calls an existing VERB's digest builder and
      // wraps the result, exactly as `context-docs-read.ts` two lines up does.
      // The zero-SQL claim is what says the classifier was reused rather than
      // re-implemented one tier out.
      "../lib/dashboard/cognition-read.ts",
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
      "search-fuse.ts", // FR-248 — pure rank arithmetic; takes no `db`
      "cognition-read.ts", // FR-266 — forwards the cognition verb's digest; no `db`
      // Not SQL-scanned above but deliberately so, and named here so the set is
      // a complete accounting rather than a partial one:
      "headers.ts", // constants only
      "lock.ts", // filesystem lockfile; no brain access
      "default-project.ts", // pure function over rows the caller supplies
    ]);
    const present = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(present.length).toBeGreaterThanOrEqual(10);
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
   *
   * TD-434 (2026-08-31): the child is `curl`, no longer a node `fetch` child.
   * The paragraph below the G-SEC-1 test ("`fetch` (undici) behaves like curl
   * here") was measured on a dev machine and REFUTED on the 2-core ubuntu CI
   * runner: with the 1 MB upload still in flight when the server answers,
   * undici raised `TypeError: fetch failed … cause: write EPIPE` and discarded
   * the already-sent 413 (rehearsal run 33398567719, the first time this test
   * ever executed in CI — the cli-bats job never reached its vitest step
   * before TD-434). curl is the instrument the fence's own FR-241 transcript
   * verified against this exact server shape (`CODE=413`, exit 0): it keeps
   * reading the response after a send-side error, on loopback on both OSes.
   */
  async function postFromChild(
    port: number,
    bytes: number,
  ): Promise<{ status: number; body: string }> {
    const dir = mkdtempSync(join(tmpdir(), "gsec1-body-"));
    const bodyFile = join(dir, "body.json");
    writeFileSync(
      bodyFile,
      JSON.stringify({ action: "dismiss", ids: [1], reason: "x".repeat(bytes) }),
    );
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        "curl",
        [
          "--silent",
          "--show-error",
          "--max-time",
          "15",
          "-X",
          "POST",
          "-H",
          "content-type: application/json",
          "--data-binary",
          `@${bodyFile}`,
          "-o",
          "-",
          "-w",
          "|CODE=%{http_code}",
          `http://127.0.0.1:${port}/api/triage`,
        ],
        { encoding: "utf-8", timeout: 20_000 },
      ));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const marker = stdout.lastIndexOf("|CODE=");
    if (marker < 0) throw new Error(`curl probe: no |CODE= marker in: ${stdout}`);
    return {
      status: Number(stdout.slice(marker + "|CODE=".length)),
      body: stdout.slice(0, marker),
    };
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
     * TD-434 (2026-08-31): an earlier revision closed with "`fetch` (undici)
     * behaves like curl here" — true on a dev machine, refuted on the CI
     * runner (write EPIPE, run 33398567719). `postFromChild` IS curl now; see
     * its header.
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

// ---------------------------------------------------------------------------
// FR-247 AC-3(a) — the TD-311 boundary, asserted over the FROZEN OBJECT
// ---------------------------------------------------------------------------

/**
 * STRUCTURAL, AT RUNTIME, OVER THE REAL MAP — not a source grep.
 *
 * The claim is "no dashboard mutation can reach `status`, `phase` or brief
 * content". A grep over `brain-write-bridge.ts` cannot make that claim, for two
 * reasons that matter: a row added by a `as unknown as` cast is invisible to a
 * pattern that looks for literals, and the file's own PROSE names every one of
 * the forbidden fields (it has to — it explains why they are forbidden), so a
 * naive grep would fire on the explanation.
 *
 * Reading the frozen object closes both. What is asserted is a SET
 * intersection over `extra ∪ keys(fixed)`, for every row, plus a set claim
 * about the rows themselves — "the complete set of mutations" is a claim about
 * a set, and a claim about a set needs the set asserted, not sampled.
 *
 * PAIRING (learning 1095): this proves what the MAP permits. It does NOT prove
 * that the code which consumes the map honours it — a builder that ignored
 * `extra` and copied the whole body would pass every assertion here. Its
 * siblings are `dashboard-triage-endpoint.test.ts` G-TR-9 (the builders' output
 * key sets, parser bypassed) and G-TR-10 (the args the brain's own handler
 * actually received, by call trace). All three are required; do not weaken any
 * of them on the assumption another has it covered.
 */
describe("FR-247 AC-3(a) — the frozen delegation map cannot name a build-state field", () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════
   * FR-249 — THE BAN HAS AN ENTITY DIMENSION, AND IT IS A RATIFIED WIDENING
   * ═══════════════════════════════════════════════════════════════════════
   * Until FR-249 this guard banned `status` / `phase` / `content` / `title` /
   * `filename` from EVERY row's argument surface, globally. That was right for
   * the five FR-241 rows and the two FR-247 rows, and it was ENTITY-BLIND: it
   * could not tell `goals.title` from `brief_status.title`, so it refused
   * FR-249's row in all three of the shapes that brief considered.
   *
   * TD-311's invariant is a claim about BRIEFS — `brief_status.status`, `.phase`
   * and a brief's `content`/`title`/`filename`, whose single sanctioned writers
   * are the `/hunt` state machine and the pre-commit phase guard. `goals.title`
   * is a different column on a different table with no state machine over it,
   * and `entity_edges` has no build-state at all. So the ban is applied PER
   * ENTITY, and the entity is resolved from the tool the row dispatches.
   *
   * THE WIDENING IS ONLY AS GOOD AS THE THREE CLAUSES THAT KEEP IT HONEST, and
   * each has its own assertion below:
   *   - TOTAL — every row's tool must appear in `TOOL_WRITES`, or the test reds.
   *     Without this a NEW row with an unclassified tool would be silently
   *     exempt, and the guard would go vacuous exactly where it mattered.
   *   - FAIL-CLOSED — an unclassified tool is nevertheless checked against the
   *     BRIEF ban, so even in the window before someone notices the totality
   *     failure the row is refused rather than admitted.
   *   - A MUST-NOT-FIRE CONTROL — a planted `brief_status.title` write is still
   *     flagged. A control that only proves the predicate FIRES cannot prove it
   *     stopped firing on purpose rather than by accident.
   */
  const TOOL_WRITES = Object.freeze({
    igris_suggestion_dismiss: "suggestion",
    igris_suggestion_acted: "suggestion",
    igris_suggestion_apply_action: "suggestion",
    igris_perception_approve: "learning",
    igris_perception_reject: "learning",
    igris_brief_update: "brief",
    igris_edge_create: "edge",
    igris_goal_create: "goal",
  } as Record<string, string>);

  /**
   * The ban, per entity. THE EMPTY SETS ARE DECISIONS, WITH A REASON EACH, and
   * they are written here rather than left implicit precisely because an empty
   * set is what an oversight also looks like.
   */
  const FORBIDDEN_BY_ENTITY = Object.freeze({
    brief: ["status", "phase", "content", "title", "filename"],
    // No build-state invariant: `/hunt` is not a goal's writer, and a goal's
    // `status` is `VALID_GOAL_STATUSES`, a different vocabulary on a different
    // table. The create row does not offer it anyway — but that is a property
    // of the row, and this is a property of the ENTITY.
    goal: [],
    // Structural. An edge has no columns of a brief; `attach_goal` pins its
    // three enum-ish fields in `fixed`, which the `fixed`-is-a-constant
    // assertion below covers.
    edge: [],
    // Cognition state, FR-241's subject. `suggestions.status` is a triage
    // state, not build state, and it is what the three suggestion tools exist
    // to move.
    suggestion: [],
    learning: [],
  } as Record<string, readonly string[]>);

  /** The brief ban, by name, for the fail-closed default. */
  const FORBIDDEN = FORBIDDEN_BY_ENTITY.brief!;

  /** Every key a row can put in front of a brain tool, from the row itself. */
  const surfaceOf = (row: TriageActionSpec): string[] => [
    ...row.extra,
    ...Object.keys(row.fixed ?? {}),
    ...Object.keys(row.refKeys ?? {}),
  ];

  const violationsIn = (map: Record<string, TriageActionSpec>): string[] => {
    const out: string[] = [];
    for (const [name, row] of Object.entries(map)) {
      const entity = TOOL_WRITES[row.tool];
      // FAIL CLOSED. An unclassified tool is reported AS SUCH — so the failure
      // names the real problem — and is ALSO checked against the brief ban, so
      // it cannot be admitted while nobody is looking.
      if (entity === undefined) out.push(`${name}.tool=UNCLASSIFIED`);
      const banned = entity === undefined ? FORBIDDEN : (FORBIDDEN_BY_ENTITY[entity] ?? FORBIDDEN);
      // A `rename` TARGET is an argument name too, and it is the route a
      // row-adder is most likely to think is permitted, because it names the
      // field on the RIGHT-hand side where a reader's eye does not look.
      for (const key of [...surfaceOf(row), ...Object.values(row.rename ?? {})]) {
        if (banned.includes(key)) out.push(`${name}.${key}`);
      }
      if (row.tool === "igris_brief_sync") out.push(`${name}.tool=igris_brief_sync`);
    }
    return out.sort();
  };

  it("no row names a field forbidden FOR ITS OWN ENTITY", () => {
    expect(
      violationsIn(TRIAGE_ACTIONS as Record<string, TriageActionSpec>),
    ).toEqual([]);
  });

  it("TOOL_WRITES is TOTAL over the map — an unclassified tool cannot slip in", () => {
    // THE CLAUSE THAT STOPS THE WIDENING BEING A HOLE. Without it, adding a row
    // whose tool has no entry would exempt that row from the brief ban entirely
    // and every assertion above would still read `[]`.
    const unclassified = Object.entries(TRIAGE_ACTIONS as Record<string, TriageActionSpec>)
      .filter(([, row]) => TOOL_WRITES[row.tool] === undefined)
      .map(([name, row]) => `${name} -> ${row.tool}`);
    expect(
      unclassified,
      "a map row dispatches a tool with no entity classification — add it to TOOL_WRITES and decide its ban set",
    ).toEqual([]);
    // ...and the table names no tool the map does not dispatch, so it cannot
    // rot into a list of historical names that classify nothing.
    const dispatched = new Set(
      Object.values(TRIAGE_ACTIONS as Record<string, TriageActionSpec>).map((r) => r.tool),
    );
    expect(Object.keys(TOOL_WRITES).filter((t) => !dispatched.has(t))).toEqual([]);
    // Every classification must resolve to a declared ban set — a typo'd
    // entity would otherwise fall through to the fail-closed default and look
    // like a working classification.
    for (const [tool, entity] of Object.entries(TOOL_WRITES)) {
      expect(FORBIDDEN_BY_ENTITY[entity], `${tool} -> ${entity}`).toBeDefined();
    }
  });

  it("MUST-NOT-FIRE CONTROL — the ban on a BRIEF row is untouched by the widening", () => {
    // THE ASSERTION THE WIDENING IS ACCOUNTABLE TO. If the entity dimension had
    // been implemented as "allow `title` everywhere", this is the reading that
    // changes — and nothing else in this file would.
    const planted: Record<string, TriageActionSpec> = {
      brief_title: {
        tool: "igris_brief_update",
        bulk: true,
        target: "brief-ref",
        refKeys: { project: "project", brief_id: "brief_id" },
        extra: ["title"] as unknown as TriageActionSpec["extra"],
      },
      brief_title_by_rename: {
        tool: "igris_brief_update",
        bulk: true,
        target: "brief-ref",
        refKeys: { project: "project", brief_id: "brief_id" },
        extra: ["reason"],
        rename: { reason: "title" },
      },
    };
    expect(violationsIn(planted)).toEqual([
      "brief_title.title",
      "brief_title_by_rename.title",
    ]);
  });

  it("the widening is SCOPED — the same field name on a GOAL row is allowed", () => {
    // The other half of the control, and the one that proves the scoping is
    // INTENTIONAL. A guard that only ever fires is indistinguishable from one
    // that has not been told what it is about.
    const goalRow: Record<string, TriageActionSpec> = {
      make_goal: {
        tool: "igris_goal_create",
        bulk: false,
        target: "none",
        extra: ["title"] as unknown as TriageActionSpec["extra"],
        rename: { title: "title" },
      },
    };
    expect(violationsIn(goalRow)).toEqual([]);
    // ...and the SHIPPED row does not spell it that way anyway: the wire keys
    // are prefixed so `params.ts`' global `KNOWN` set never gains `title`.
    expect(TRIAGE_ACTIONS.create_goal?.extra).not.toContain("title");
    expect(TRIAGE_ACTIONS.create_goal?.extra).toContain("goal_title");
  });

  it("FAIL-CLOSED CONTROL — a tool with NO classification is refused, not exempt", () => {
    const rogue: Record<string, TriageActionSpec> = {
      mystery: {
        tool: "igris_something_new",
        bulk: true,
        target: "brief-ref",
        refKeys: { project: "project", brief_id: "brief_id" },
        extra: ["status"] as unknown as TriageActionSpec["extra"],
      },
    };
    // BOTH readings: the unclassified tool is named, AND the brief ban was
    // still applied to it. Either alone would leave the other half arguable.
    expect(violationsIn(rogue)).toEqual([
      "mystery.status",
      "mystery.tool=UNCLASSIFIED",
    ]);
  });

  it("a `returns` path is a READ, and must never also be an ARGUMENT", () => {
    // FR-249's `returns` declares a dotted path into the tool's own result. If
    // the same name were also in `extra`, a caller could supply a value for
    // something this tier only ever reads back — and the row would be doing two
    // different things through one key.
    for (const [name, row] of Object.entries(
      TRIAGE_ACTIONS as Record<string, TriageActionSpec>,
    )) {
      if (row.returns === undefined) continue;
      expect(row.returns.length, `${name}: an empty returns path`).toBeGreaterThan(0);
      for (const segment of row.returns.split(".")) {
        expect(row.extra as readonly string[], `${name}: ${segment} is both read and written`).not.toContain(segment);
        expect(Object.keys(row.fixed ?? {}), `${name}: ${segment} is fixed AND returned`).not.toContain(segment);
      }
    }
    // SELF-NEGATIVE-CONTROL: exactly one row declares a `returns`, so the loop
    // above has a corpus. A future second one is welcome; zero is not.
    expect(
      Object.values(TRIAGE_ACTIONS as Record<string, TriageActionSpec>).filter(
        (r) => r.returns !== undefined,
      ),
    ).toHaveLength(1);
  });

  it("SELF-NEGATIVE-CONTROL — the predicate fires on a deliberately dirty map", () => {
    // Without this, "[] " is indistinguishable between "the map is clean" and
    // "the predicate is broken" (learning 1094). Both the field ban and the
    // tool ban are planted, so neither half can rot unnoticed.
    const dirty: Record<string, TriageActionSpec> = {
      sneaky_status: {
        tool: "igris_brief_update",
        bulk: true,
        target: "brief-ref",
        refKeys: { project: "project", brief_id: "brief_id" },
        extra: ["status"] as unknown as TriageActionSpec["extra"],
      },
      sneaky_fixed_phase: {
        tool: "igris_brief_update",
        bulk: true,
        target: "brief-ref",
        refKeys: { project: "project", brief_id: "brief_id" },
        extra: [],
        fixed: { phase: "COMMITTING" },
      },
      sneaky_sync: {
        tool: "igris_brief_sync",
        bulk: true,
        target: "brief-ref",
        refKeys: { project: "project", brief_id: "brief_id" },
        extra: [],
      },
    };
    expect(violationsIn(dirty)).toEqual([
      "sneaky_fixed_phase.phase",
      "sneaky_status.status",
      // FR-249: `igris_brief_sync` is not in `TOOL_WRITES` — it is forbidden,
      // so classifying it would be recording an entity for a tool no row may
      // ever dispatch. It is therefore reported TWICE, by two independent
      // clauses, and that is the fail-closed default doing its job on the one
      // planted row that exercises it.
      "sneaky_sync.tool=UNCLASSIFIED",
      "sneaky_sync.tool=igris_brief_sync",
    ]);
    // WHAT THIS CONTROL DOES NOT COVER: a row that reaches a forbidden column
    // through a `rename` whose TARGET is forbidden but whose source key is not
    // (`extra: ["reason"], rename: {reason: "status"}`). The next assertion is
    // the one that covers that, and it is separate on purpose.
  });

  it("no `rename` TARGET is a forbidden field either — the indirect route", () => {
    // Scoped the SAME WAY as `extra` and `fixed`, and it has to be: FR-249's
    // create row reaches the tool's `title` through exactly this route, and the
    // reason that is allowed is the entity, not the route. A rename target that
    // was checked globally while `extra` was checked per entity would refuse
    // the row for a reason the guard no longer holds.
    for (const [name, row] of Object.entries(
      TRIAGE_ACTIONS as Record<string, TriageActionSpec>,
    )) {
      const banned = FORBIDDEN_BY_ENTITY[TOOL_WRITES[row.tool] ?? "brief"] ?? FORBIDDEN;
      for (const t of Object.values(row.rename ?? {})) {
        expect(banned.includes(t), `${name}: rename -> ${t}`).toBe(false);
      }
    }
    // Self-negative-control for THIS assertion: the shipped map does use
    // `rename`, so the corpus above is non-empty and the loop really ran — and
    // it now contains a target that IS in the brief ban, reached by a goal row.
    const targets = Object.values(
      TRIAGE_ACTIONS as Record<string, TriageActionSpec>,
    ).flatMap((r) => Object.values(r.rename ?? {}));
    expect(targets, "no row uses `rename` — this guard has no corpus").toContain("to_id");
    expect(targets).toContain("title");
  });

  it("the row set is EXACTLY the eight expected keys", () => {
    // A claim about a SET. `TRIAGE_ACTION_NAMES` is what `/api/health` serves,
    // so this also pins the vocabulary the client is offered.
    expect([...TRIAGE_ACTION_NAMES].sort()).toEqual([
      "acted",
      "apply",
      "approve",
      "attach_goal",
      "create_goal",
      "dismiss",
      "reject",
      "set_priority",
    ]);
    expect(Object.isFrozen(TRIAGE_ACTIONS)).toBe(true);
    for (const [name, row] of Object.entries(TRIAGE_ACTIONS)) {
      expect(Object.isFrozen(row), `${name} is not frozen`).toBe(true);
    }
  });

  it("FR-247's widening is ADDITIVE — the five FR-241 rows are otherwise unchanged", () => {
    // The regression claim, made mechanical. `target` is the ONE field the five
    // gained; everything else must be byte-for-byte what FR-241 shipped, and
    // none of them may have acquired `fixed`, `refKeys` or `rename`.
    const FR241 = {
      dismiss: { tool: "igris_suggestion_dismiss", bulk: true, idKey: "id", extra: ["reason"] },
      acted: { tool: "igris_suggestion_acted", bulk: true, idKey: "id", extra: ["brief_id"] },
      apply: { tool: "igris_suggestion_apply_action", bulk: false, idKey: "id", extra: [] },
      approve: { tool: "igris_perception_approve", bulk: true, idKey: "learning_id", extra: [] },
      reject: { tool: "igris_perception_reject", bulk: true, idKey: "learning_id", extra: ["reason"] },
    } as const;
    for (const [name, expected] of Object.entries(FR241)) {
      const row = TRIAGE_ACTIONS[name] as TriageActionSpec;
      expect(row, `${name} vanished`).toBeDefined();
      expect({
        tool: row.tool,
        bulk: row.bulk,
        idKey: row.idKey,
        extra: [...row.extra],
      }).toEqual({ ...expected, extra: [...expected.extra] });
      expect(row.target, `${name} lost its target`).toBe("id");
      expect(row.fixed, `${name} acquired a fixed block`).toBeUndefined();
      expect(row.refKeys, `${name} acquired refKeys`).toBeUndefined();
      expect(row.rename, `${name} acquired a rename`).toBeUndefined();
    }
  });

  it("`target` and the addressing fields agree, row by row", () => {
    // The invariant a discriminated union would have carried in the type. It is
    // asserted here instead — which is the stronger instrument, because it also
    // covers a row added through a cast (as the dirty map above is).
    for (const [name, row] of Object.entries(
      TRIAGE_ACTIONS as Record<string, TriageActionSpec>,
    )) {
      if (row.target === "none") {
        // FR-249 — a SUBJECTLESS row addresses nothing, so it must carry
        // NEITHER addressing field. A `none` row with an `idKey` would build an
        // argument object containing `{undefined: ...}` and reach the gateway
        // as a TD-128 rejection naming the wrong problem.
        expect(row.idKey, `${name}: a subjectless row with an idKey`).toBeUndefined();
        expect(row.refKeys, `${name}: a subjectless row with refKeys`).toBeUndefined();
        // ...and it is single-item by construction: there is no set to bulk over.
        expect(row.bulk, `${name}: a subjectless row cannot be bulk`).toBe(false);
        continue;
      }
      if (row.target === "id") {
        expect(row.idKey, `${name}: an id row with no idKey`).toBeDefined();
        expect(row.refKeys, `${name}: an id row with refKeys`).toBeUndefined();
      } else {
        expect(row.target).toBe("brief-ref");
        expect(row.refKeys, `${name}: a brief-ref row with no refKeys`).toBeDefined();
        expect(row.idKey, `${name}: a brief-ref row with an idKey`).toBeUndefined();
        // Every ref key must name a real half of the ref, or the builder would
        // emit `undefined` into a required gateway argument.
        for (const field of Object.values(row.refKeys ?? {})) {
          expect(["project", "brief_id"]).toContain(field);
        }
      }
    }
  });

  it("every `fixed` value is a STRING CONSTANT, never caller-shaped", () => {
    // `fixed` is the only place a map row asserts a brain-side enum value
    // (`edge_type: 'serves_goal'`). If a row ever carried a placeholder there,
    // one map row would silently become many mutations.
    for (const [name, row] of Object.entries(
      TRIAGE_ACTIONS as Record<string, TriageActionSpec>,
    )) {
      for (const [k, v] of Object.entries(row.fixed ?? {})) {
        expect(typeof v, `${name}.fixed.${k} is not a string`).toBe("string");
        expect(v.length, `${name}.fixed.${k} is empty`).toBeGreaterThan(0);
        // ...and it is not a key the caller could also supply.
        expect(row.extra as readonly string[], `${name}: ${k} is both fixed and extra`).not.toContain(k);
      }
    }
  });
});
