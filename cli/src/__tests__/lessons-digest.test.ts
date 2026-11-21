/**
 * TD-496 — `igris lessons digest` and `igris lessons audit`.
 *
 * The digest is what `/hunt` pastes into every architect / forger / sentinel /
 * warden delegation, so its bounds are code, not prose: a true UTF-8 byte cap
 * (header and footer included), at most 12 lessons, an exact `role:<agent>`
 * token match, approved + not-deleted + this-project-or-global rows only, a
 * deterministic rank, and a read-only door (`openBrainReadonly`). It never
 * fails a delegation: no rows and no brain both exit 0 with a named line.
 *
 * Fixture: an own `learnings` DDL at the fenced `brainDbPath()` (BR-106 fence +
 * a belt asserting the path is under the fence).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fenceHome, realHome, type HomeFence } from "./home-fence.js";
import { brainDbPath } from "../lib/paths.js";
import { openBrainReadonly } from "../lib/brain-bridge.js";
import {
  ROLE_DIGEST_DEFAULT_BYTES,
  ROLE_DIGEST_MAX_BYTES,
  ROLE_DIGEST_MAX_LESSONS,
  ROLE_TAG_RE,
  auditLedger,
  renderRoleDigest,
  selectRoleLessons,
} from "../lib/lessons.js";
import { runLessons, type LessonsOptions } from "../verbs/lessons.js";
import type { LedgerRow, LessonsAudit, RoleDigest } from "../types.js";

let fence: HomeFence;

interface Lesson {
  project?: string;
  category?: string;
  title: string;
  content?: string;
  tags?: string;
  scope?: string;
  confidence?: number;
  created_at?: string;
  review_status?: string;
  promoted_to_doc?: string | null;
  deleted_at?: string | null;
}

function ddl(withDeletedAt: boolean): string {
  return `CREATE TABLE learnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, category TEXT NOT NULL,
    title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT DEFAULT '', tech_stack TEXT DEFAULT '',
    scope TEXT DEFAULT 'local', source_brief TEXT DEFAULT '', confidence REAL DEFAULT 0.8,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    access_count INTEGER DEFAULT 0, last_accessed_at TEXT,
    review_status TEXT NOT NULL DEFAULT 'approved', provenance TEXT NOT NULL DEFAULT 'observed',
    source_extractor TEXT NOT NULL DEFAULT 'manual', promoted_to_doc TEXT${withDeletedAt ? ", deleted_at TEXT" : ""}
  );`;
}

/** Seed `rows` at the fenced brain path; returns their ids in order. */
function seed(rows: Lesson[], opts: { deletedAt?: boolean } = {}): number[] {
  const withDeleted = opts.deletedAt !== false;
  const path = brainDbPath();
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.exec(ddl(withDeleted));
    const cols = ["project", "category", "title", "content", "tags", "scope", "confidence", "created_at", "review_status", "promoted_to_doc"];
    if (withDeleted) cols.push("deleted_at");
    const ins = db.prepare(`INSERT INTO learnings (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`);
    return rows.map((r) => {
      const row: Record<string, unknown> = {
        project: r.project ?? "demo",
        category: r.category ?? "pattern",
        title: r.title,
        content: r.content ?? "body text",
        tags: r.tags ?? "agent-memory,role:warden",
        scope: r.scope ?? "local",
        confidence: r.confidence ?? 0.8,
        created_at: r.created_at ?? "2026-01-01 00:00:00",
        review_status: r.review_status ?? "approved",
        promoted_to_doc: r.promoted_to_doc ?? null,
      };
      if (withDeleted) row.deleted_at = r.deleted_at ?? null;
      return Number(ins.run(row).lastInsertRowid);
    });
  } finally {
    db.close();
  }
}

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = openBrainReadonly();
  if (db === null) throw new Error("fixture brain did not open");
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Run the verb in process; capture stdout separately from stderr. */
async function run(action: string, opts: LessonsOptions): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const spies = [
    vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => (out.push(String(c)), true)),
    vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => (err.push(String(c)), true)),
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ") + "\n")),
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ") + "\n")),
  ];
  try {
    const code = await runLessons(action, opts);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    for (const s of spies) s.mockRestore();
  }
}

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

beforeEach(() => {
  fence = fenceHome("igris-td496-digest-");
  // Belt: whatever the verb resolves, it resolves INSIDE the fence — never the
  // live brain, which this file never reads.
  expect(brainDbPath().startsWith(fence.home + sep)).toBe(true);
  const real = realHome();
  if (real !== undefined) expect(brainDbPath()).not.toBe(join(real, ".igris", "memory", "knowledge.db"));
});

afterEach(() => {
  fence.release();
});

describe("TD-496 — role digest selection", () => {
  it("D1: matches the role:<agent> token exactly (order-free, whitespace-trimmed)", () => {
    const ids = seed([
      { title: "plain match", tags: "agent-memory,role:warden" },
      { title: "spaced match", tags: " role:warden ,x" },
      { title: "suffix", tags: "role:wardenx" },
      { title: "prefix", tags: "xrole:warden" },
      { title: "short", tags: "role:ward" },
    ]);
    const got = withDb((db) => selectRoleLessons(db, { role: "warden", project: "demo" }));
    expect(got.map((r) => r.id).sort()).toEqual([ids[0], ids[1]].sort());
    expect(ROLE_TAG_RE.test("role:warden")).toBe(true);
    expect(ROLE_TAG_RE.test("role:Warden")).toBe(false);
  });

  it("D2: approved, not deleted, this project or global — another project's local rows excluded", () => {
    const ids = seed([
      { title: "ok local" },
      { title: "pending", review_status: "pending_review" },
      { title: "deleted", deleted_at: "2026-02-01 00:00:00" },
      { title: "other local", project: "other" },
      { title: "other global", project: "other", scope: "global" },
    ]);
    const got = withDb((db) => selectRoleLessons(db, { role: "warden", project: "demo" }));
    expect(got.map((r) => r.id).sort()).toEqual([ids[0], ids[4]].sort());
  });

  it("D2b: a brain without learnings.deleted_at still reads (the predicate is skipped)", () => {
    const ids = seed([{ title: "no deleted column" }], { deletedAt: false });
    const got = withDb((db) => selectRoleLessons(db, { role: "warden", project: "demo" }));
    expect(got.map((r) => r.id)).toEqual(ids);
  });

  it("D4: ranks by context overlap, then project-local, confidence, created_at, id — all descending", () => {
    const ids = seed([
      { title: "Ledger sqlite migration rule", confidence: 0.5 },
      { title: "Sqlite pragma note", confidence: 0.9 },
      { title: "Sqlite busy timeout", project: "other", scope: "global", confidence: 0.95 },
      { title: "Unrelated A", confidence: 0.99, created_at: "2026-02-01 00:00:00" },
      { title: "Unrelated B", confidence: 0.99, created_at: "2026-02-01 00:00:00" },
      { title: "Unrelated C", confidence: 0.99, created_at: "2026-03-01 00:00:00" },
    ]);
    const rows = withDb((db) => selectRoleLessons(db, { role: "warden", project: "demo" }));
    const d = renderRoleDigest(rows, { role: "warden", project: "demo", context: "sqlite migration ledger" });
    expect(d.lessons.map((l) => l.id)).toEqual([ids[0], ids[1], ids[2], ids[5], ids[4], ids[3]]);
    // Deterministic: the same input renders byte-identically.
    expect(renderRoleDigest([...rows].reverse(), { role: "warden", project: "demo", context: "sqlite migration ledger" }).markdown).toBe(d.markdown);
  });

  it("D4b: stopwords and the 'Source: agent-memory' footer never count as context overlap", () => {
    const ids = seed([
      {
        title: "Alpha rule",
        content: "The rule is for the team, with this and that.\n\nSource: agent-memory main/warden/alpha.md (sha256 0123456789ab)",
        confidence: 0.99,
      },
      { title: "Beta rule", content: "sqlite busy timeout", confidence: 0.1 },
    ]);
    const rows = withDb((db) => selectRoleLessons(db, { role: "warden", project: "demo" }));
    const context = "Fix the agent memory export for the main warden sqlite path with this and that";
    const d = renderRoleDigest(rows, { role: "warden", project: "demo", context });
    expect(d.lessons.map((l) => l.id)).toEqual([ids[1], ids[0]]);
  });

  it("D5: a promoted row points at its doc instead of a gist", () => {
    seed([{ title: "Promoted rule", content: "the gist that must not print", promoted_to_doc: "coding_guidelines.md#rule" }]);
    const rows = withDb((db) => selectRoleLessons(db, { role: "warden", project: "demo" }));
    const d = renderRoleDigest(rows, { role: "warden", project: "demo" });
    expect(d.markdown).toContain("Promoted rule → coding_guidelines.md#rule");
    expect(d.markdown).not.toContain("the gist that must not print");
  });
});

describe("TD-496 — the byte cap", () => {
  const long = (i: number): Lesson => ({
    title: `Ünïcødé lesson ${i} — 漢字かな混じり ${"é".repeat(150)}`,
    content: `${"ß漢".repeat(200)}\n\nSource: agent-memory main/warden/x${i}.md`,
    created_at: `2026-01-${String((i % 28) + 1).padStart(2, "0")} 00:00:00`,
  });

  it("D3: 30 long multibyte rows stay within --max-bytes (512 / 4096 / 8192), ≤ 12 lessons", async () => {
    seed(Array.from({ length: 30 }, (_, i) => long(i)));
    for (const max of [512, ROLE_DIGEST_DEFAULT_BYTES, ROLE_DIGEST_MAX_BYTES]) {
      const { code, out } = await run("digest", { role: "warden", project: "demo", maxBytes: String(max), json: true });
      expect(code).toBe(0);
      const d = JSON.parse(out) as RoleDigest;
      expect(Buffer.byteLength(d.markdown, "utf8"), `max ${max}`).toBeLessThanOrEqual(max);
      expect(d.bytes).toBe(Buffer.byteLength(d.markdown, "utf8"));
      expect(d.included).toBeGreaterThanOrEqual(1);
      expect(d.included).toBeLessThanOrEqual(ROLE_DIGEST_MAX_LESSONS);
      expect(d.lessons).toHaveLength(d.included);
      expect(d.available).toBe(30);
      expect(d.truncated).toBe(true);
      expect(d.max_bytes).toBe(max);
      // The text mode prints exactly the markdown — what /hunt pastes is what was capped.
      const text = await run("digest", { role: "warden", project: "demo", maxBytes: String(max) });
      expect(text.out).toBe(d.markdown);
      expect(Buffer.byteLength(text.out, "utf8")).toBeLessThanOrEqual(max);
    }
  });

  it("D3b: the default cap is 4,096 B and 12 lessons", async () => {
    expect(ROLE_DIGEST_DEFAULT_BYTES).toBe(4096);
    expect(ROLE_DIGEST_MAX_BYTES).toBe(8192);
    expect(ROLE_DIGEST_MAX_LESSONS).toBe(12);
    seed(Array.from({ length: 30 }, (_, i) => ({ title: `short ${i}` })));
    const { out } = await run("digest", { role: "warden", project: "demo", json: true });
    const d = JSON.parse(out) as RoleDigest;
    expect(d.max_bytes).toBe(4096);
    expect(d.included).toBe(12);
    expect(d.truncated).toBe(true);
  });

  it("D3c: --max-bytes outside 512..8192, a bad role, or no role exits 2", async () => {
    seed([{ title: "x" }]);
    for (const maxBytes of ["100", "9000", "abc", "4096.5"]) {
      expect((await run("digest", { role: "warden", maxBytes })).code, maxBytes).toBe(2);
    }
    expect((await run("digest", { role: "Warden!" })).code).toBe(2);
    expect((await run("digest", {})).code).toBe(2);
    expect((await run("nonsense", { role: "warden" })).code).toBe(2);
  });
});

describe("TD-496 — empty, degraded, read-only, JSON shape", () => {
  it("D6: no rows prints the none line, exit 0", async () => {
    seed([{ title: "another role", tags: "role:forger" }]);
    const { code, out } = await run("digest", { role: "warden", project: "demo" });
    expect(code).toBe(0);
    expect(out).toBe("Role lessons (warden): none stored.\n");
  });

  it("D6b: a missing brain prints the unavailable line, exit 0, degraded:true", async () => {
    expect(existsSync(brainDbPath())).toBe(false);
    const text = await run("digest", { role: "warden", project: "demo" });
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/^Role lessons \(warden\): unavailable — .+; proceeding without them\.\n$/);
    const { code, out } = await run("digest", { role: "warden", project: "demo", json: true });
    expect(code).toBe(0);
    const d = JSON.parse(out) as RoleDigest;
    expect(d.degraded).toBe(true);
    expect(d.reason).toBeTruthy();
    expect(d.included).toBe(0);
    expect(d.markdown).toBe(text.out);
    expect(existsSync(brainDbPath())).toBe(false);
  });

  it("D6c: a brain with no learnings table degrades instead of throwing", async () => {
    const path = brainDbPath();
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.exec("CREATE TABLE other (x)");
    db.close();
    const { code, out } = await run("digest", { role: "warden", project: "demo", json: true });
    expect(code).toBe(0);
    expect((JSON.parse(out) as RoleDigest).degraded).toBe(true);
  });

  it("D7: the digest and audit are read-only — sha256 and mtime unchanged; a write on the handle throws", async () => {
    seed([{ title: "ro", tags: "agent-memory,role:warden,amx:aaaaaaaaaaaa" }]);
    const path = brainDbPath();
    const before = { sha: sha(path), mtime: statSync(path).mtimeMs };
    expect((await run("digest", { role: "warden", project: "demo", context: "ro" })).code).toBe(0);
    const ledger = join(fence.home, "stored.jsonl");
    writeFileSync(ledger, "");
    await run("audit", { ledger });
    expect({ sha: sha(path), mtime: statSync(path).mtimeMs }).toEqual(before);
    withDb((db) => {
      selectRoleLessons(db, { role: "warden", project: "demo" });
      expect(() => db.prepare("UPDATE learnings SET title = 'x'").run()).toThrow();
    });
  });

  it("D8: --json carries exactly the documented keys", async () => {
    seed([{ title: "keyed" }]);
    const { out } = await run("digest", { role: "warden", project: "demo", json: true });
    const d = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(d).sort()).toEqual(
      ["available", "bytes", "degraded", "included", "lessons", "markdown", "max_bytes", "project", "reason", "role", "truncated"].sort(),
    );
    expect(d.lessons).toEqual([{ id: 1, title: "keyed" }]);
    expect(d.markdown).toMatch(/^Role lessons \(warden\): 1 of 1 for demo\./);
  });
});

describe("TD-496 — lessons audit", () => {
  const K1 = "amx:111111111111";
  const K2 = "amx:222222222222";

  function seedAudit(extra: Lesson[] = []): number[] {
    return seed([
      { title: "a1", content: "content one", tags: `${K1},agent-memory,role:warden` },
      { title: "a2", content: "content two", tags: `agent-memory,role:forger,${K2}` },
      ...extra,
    ]);
  }

  function ledgerOf(rows: LedgerRow[]): string {
    const p = join(fence.home, "stored.jsonl");
    writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return p;
  }

  const clean = (ids: number[]): LedgerRow[] => [
    { key: K1, id: ids[0], sha256: sha256("content one"), op: "store" },
    { key: K2, id: ids[1], sha256: sha256("content two"), op: "add_tags" },
  ];

  it("A1: a clean ledger exits 0", async () => {
    const ids = seedAudit();
    const { code, out } = await run("audit", { ledger: ledgerOf(clean(ids)), json: true });
    expect(code, out).toBe(0);
    const a = JSON.parse(out) as LessonsAudit;
    expect(a).toMatchObject({ ok: true, ledger_rows: 2, keys: 2, verified: 2, problems: [] });
  });

  it("A2: missing id, sha mismatch, missing token, orphan — each exits 1", async () => {
    const cases: Array<[string, (ids: number[]) => LedgerRow[], Lesson[], string]> = [
      ["missing id", (ids) => [clean(ids)[0], { ...clean(ids)[1], id: 999 }], [], "missing-id"],
      ["sha mismatch", (ids) => [clean(ids)[0], { ...clean(ids)[1], sha256: sha256("other") }], [], "sha-mismatch"],
      ["missing token", (ids) => [...clean(ids), { key: "amx:333333333333", id: ids[2], sha256: sha256("body text"), op: "store" }],
        [{ title: "a3", tags: "agent-memory,amx:333333333333" }], "missing-token"],
      ["orphan", (ids) => clean(ids), [{ title: "a4", tags: "agent-memory,role:warden,amx:444444444444" }], "orphan"],
    ];
    for (const [name, ledger, extra, kind] of cases) {
      fence.release();
      fence = fenceHome("igris-td496-digest-");
      const ids = seedAudit(extra);
      const { code, out } = await run("audit", { ledger: ledgerOf(ledger(ids)), json: true });
      expect(code, name).toBe(1);
      const a = JSON.parse(out) as LessonsAudit;
      expect(a.ok).toBe(false);
      expect(a.problems.map((p) => p.kind), name).toEqual([kind]);
    }
  });

  it("A3: the last ledger row per key wins (a re-store after a lost row)", () => {
    const ids = seedAudit();
    const rows = [{ key: K1, id: 999, sha256: "0".repeat(64), op: "store" as const }, ...clean(ids)];
    const a = withDb((db) => auditLedger(db, rows, {}));
    expect(a.ok).toBe(true);
    expect(a.ledger_rows).toBe(3);
    expect(a.keys).toBe(2);
  });

  it("A4: a malformed ledger or no --ledger exits 2; a missing brain exits 3", async () => {
    const bad = join(fence.home, "bad.jsonl");
    writeFileSync(bad, "{not json\n");
    expect((await run("audit", { ledger: bad })).code).toBe(2);
    writeFileSync(bad, JSON.stringify({ key: "amx:1", id: 1, sha256: "x", op: "store" }) + "\n");
    expect((await run("audit", { ledger: bad })).code).toBe(2);
    expect((await run("audit", {})).code).toBe(2);
    expect((await run("audit", { ledger: join(fence.home, "absent.jsonl") })).code).toBe(2);
    writeFileSync(bad, "");
    expect(existsSync(brainDbPath())).toBe(false);
    expect((await run("audit", { ledger: bad })).code).toBe(3);
    expect(existsSync(brainDbPath())).toBe(false);
  });
});
