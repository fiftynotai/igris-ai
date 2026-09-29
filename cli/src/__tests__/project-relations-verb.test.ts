/**
 * FR-273 — `igris project relations` / `igris project kinds list`: the CLI READ
 * verbs over the vendored relations action layer (plan §4.2 V-series).
 *
 * The brain DB is real (fenced HOME). Its relation schema comes from the BRAIN'S
 * OWN compiled `relations/schema.js`, resolved through the bridge's bundle
 * resolver — never hand-written DDL — and the lookup runs the compiled
 * `relations/actions.js`, so this suite exercises the one implementation. The
 * full vendored-engine parity lives in `tests/integration/project-relations.bats`.
 *
 *   - V1 no brain DB → degraded, `line: null`, exit 0 (boot and lookup);
 *   - V2 the module unavailable → degraded with the reason, exit 0;
 *   - V3 a bad `--direction` / a non-integer `--depth` → exit 2, no digest;
 *   - V4 `--depth 9` is clamped to 5 (by the shared action layer);
 *   - V5 exactly one JSON line on stdout;
 *   - V6 `watermark` is unchanged (`project-watermark-verb.test.ts` stays green);
 *   - V7 an unexpected positional (`watermark extra`, `relations extra`) → exit 2;
 *   - plus: the boot line for moca-agent-web, a pre-projects:3 brain degrades
 *     (tables absent), `kinds list` returns the five seeds, and an unknown kinds
 *     sub-action exits 2 (the write sub-actions are `project-relations-write-verb.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fenceHome, type HomeFence } from "./home-fence.js";

const PROJECTS_DDL = `
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    tech_stack TEXT DEFAULT '',
    igris_version TEXT DEFAULT '4.0.0',
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'inactive')),
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_session_at TEXT,
    metadata TEXT DEFAULT '{}',
    archetype TEXT DEFAULT 'unclassified'
  );
  ALTER TABLE projects ADD COLUMN repo_url TEXT;
  ALTER TABLE projects ADD COLUMN knowledge_sha TEXT;
  ALTER TABLE projects ADD COLUMN knowledge_branch TEXT;
  ALTER TABLE projects ADD COLUMN knowledge_recorded_at TEXT;
`;

let fence: HomeFence;

function dbFile(): string {
  return join(fence.brainDir, "memory", "knowledge.db");
}

async function relationsSql(): Promise<string> {
  const { resolveBundleModule } = await import("../lib/brain-bridge.js");
  const p = resolveBundleModule(join("engine", "components", "projects", "relations", "schema.js"));
  if (p === null) throw new Error("relations/schema.js is not built — run `npm run build` in cli/");
  const mod = (await import(pathToFileURL(p).href)) as { relationsMigrationV3: { sql: string } };
  return mod.relationsMigrationV3.sql;
}

async function seedBrain(opts: { relations: boolean }): Promise<void> {
  mkdirSync(join(fence.brainDir, "memory"), { recursive: true });
  const sql = opts.relations ? await relationsSql() : "";
  const db = new Database(dbFile());
  db.pragma("journal_mode = WAL");
  db.exec(PROJECTS_DDL + sql);
  const reg = db.prepare("INSERT INTO projects (slug, name, path, repo_url) VALUES (?, ?, ?, ?)");
  for (const s of ["moca-agent-web", "moca-agent-flutter-client", "moca-ai-agent"]) {
    reg.run(s, s, join(fence.home, "repos", s), `https://github.com/KalvadTech/${s}`);
  }
  if (opts.relations) {
    const edge = db.prepare("INSERT INTO project_relations (from_slug, kind, to_slug, detail) VALUES (?, ?, ?, ?)");
    edge.run("moca-agent-web", "uses_package", "moca-agent-flutter-client", '{"package":"moca_agent_client_ui","ref":"v2.0.0"}');
    edge.run("moca-agent-flutter-client", "calls_service", "moca-ai-agent", '{"protocol":"HTTP/SSE"}');
  }
  db.close();
}

// NOT named `run`: vitest-home-fence's planted-dir scan reads every test file as
// a module, and a `run` that reaches brainDir makes `\brun\s*\(` match every
// `stmt.run(` in the tree — the closure explodes and its controls time out.
interface Run {
  code: number;
  lines: string[];
  digest: Record<string, unknown> | null;
  stderr: string;
}

async function runVerb(action: string, args: string[], opts: Record<string, unknown> = {}): Promise<Run> {
  const { runProjectCommand } = await import("../verbs/project.js");
  const out: string[] = [];
  const err: string[] = [];
  const spyOut = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => { out.push(String(c)); return true; });
  const spyErr = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => { err.push(String(c)); return true; });
  let code: number;
  try {
    code = await runProjectCommand({ action, args, ...opts });
  } finally {
    spyOut.mockRestore();
    spyErr.mockRestore();
  }
  const text = out.join("");
  const lines = text.split("\n").filter((l) => l !== "");
  return { code, lines, digest: lines.length === 1 ? (JSON.parse(lines[0]) as Record<string, unknown>) : null, stderr: err.join("") };
}

beforeEach(() => {
  fence = fenceHome("igris-fr273-verb-");
  fence.assertArmed();
});

afterEach(async () => {
  (await import("../lib/brain-bridge.js")).resetRelationsActions();
  fence.release();
  vi.restoreAllMocks();
  vi.doUnmock("../lib/brain-bridge.js");
  vi.resetModules();
});

describe("igris project relations — the read verb (FR-273)", () => {
  it("the boot line for moca-agent-web, one JSON line, exit 0", async () => {
    await seedBrain({ relations: true });
    const r = await runVerb("relations", [], { project: "moca-agent-web", boot: true });
    expect(r.code).toBe(0);
    expect(r.digest).toEqual({
      degraded: false,
      reason: null,
      project: "moca-agent-web",
      registered: true,
      line: "Connected: uses moca-agent-flutter-client (v2.0.0) → calls moca-ai-agent · more: igris project relations",
      neighbours: 1,
    });
  });

  it("V1: no brain DB → degraded, line null, exit 0 — and no DB file is created", async () => {
    const boot = await runVerb("relations", [], { project: "x", boot: true });
    expect(boot.code).toBe(0);
    expect(boot.digest).toMatchObject({ degraded: true, line: null, reason: "brain db absent" });
    const look = await runVerb("relations", [], { project: "x" });
    expect(look.code).toBe(0);
    expect(look.digest).toMatchObject({ degraded: true, relations: null, reason: "brain db absent" });
    const { existsSync } = await import("node:fs");
    expect(existsSync(dbFile())).toBe(false);
  });

  it("V2: the vendored module unavailable → degraded with the reason, exit 0", async () => {
    await seedBrain({ relations: true });
    vi.resetModules();
    vi.doMock("../lib/brain-bridge.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../lib/brain-bridge.js")>();
      return {
        ...actual,
        loadRelationsActions: async () => null,
        lastRelationsActionsFailure: () => "brain relations module not found: engine/components/projects/relations/actions.js",
      };
    });
    const r = await runVerb("relations", [], { project: "moca-agent-web", boot: true });
    expect(r.code).toBe(0);
    expect(r.digest).toMatchObject({ degraded: true, line: null });
    expect(String(r.digest!.reason)).toMatch(/relations module unavailable: .*actions\.js/);
  });

  it("a brain WITHOUT projects:3 → degraded (tables absent), exit 0, never a throw", async () => {
    await seedBrain({ relations: false });
    const boot = await runVerb("relations", [], { project: "moca-agent-web", boot: true });
    expect(boot.code).toBe(0);
    expect(boot.digest).toMatchObject({ degraded: true, line: null });
    expect(String(boot.digest!.reason)).toMatch(/projects:3/);
    const look = await runVerb("relations", [], { project: "moca-agent-web" });
    expect(look.digest).toMatchObject({ degraded: true, relations: null });
    expect(String(look.digest!.reason)).toMatch(/projects:3/);
  });

  it("V3: a bad --direction or a non-integer --depth → exit 2, no digest", async () => {
    await seedBrain({ relations: true });
    for (const opts of [{ direction: "sideways" }, { depth: "two" }, { depth: "0" }]) {
      const r = await runVerb("relations", [], { project: "moca-agent-web", ...opts });
      expect(r.code, JSON.stringify(opts)).toBe(2);
      expect(r.lines, JSON.stringify(opts)).toEqual([]);
      expect(r.stderr).toMatch(/error:/);
    }
  });

  it("V4: --depth 9 is clamped to 5; the lookup is the action layer's result verbatim", async () => {
    await seedBrain({ relations: true });
    const r = await runVerb("relations", [], { project: "moca-agent-web", depth: "9", direction: "out" });
    expect(r.code).toBe(0);
    const rel = r.digest!.relations as { ok: boolean; action: string; data: { depth: number; neighbours: { slug: string; depth: number }[] } };
    expect(rel).toMatchObject({ ok: true, action: "lookup" });
    expect(rel.data.depth).toBe(5);
    expect(rel.data.neighbours.map((n) => [n.slug, n.depth])).toEqual([["moca-agent-flutter-client", 1], ["moca-ai-agent", 2]]);
  });

  it("V5: stdout is exactly one JSON line; --no-check reaches the action layer", async () => {
    await seedBrain({ relations: true });
    const r = await runVerb("relations", [], { project: "moca-agent-flutter-client", check: false });
    expect(r.lines).toHaveLength(1);
    expect(r.digest).toMatchObject({ degraded: false, reason: null, project: "moca-agent-flutter-client" });
  });

  it("V7: an unexpected positional → exit 2 (watermark and relations)", async () => {
    await seedBrain({ relations: true });
    for (const [action, args] of [["watermark", ["extra-arg"]], ["relations", ["extra"]]] as const) {
      const r = await runVerb(action, [...args], { project: "moca-agent-web" });
      expect(r.code, action).toBe(2);
      expect(r.lines, action).toEqual([]);
    }
  });

  it("kinds list → the five seeds through the action layer; no or an unknown kinds sub-action exits 2", async () => {
    await seedBrain({ relations: true });
    const r = await runVerb("kinds", ["list"]);
    expect(r.code).toBe(0);
    expect(r.digest).toMatchObject({ degraded: false, reason: null, action: "kinds.list", ok: true });
    const kinds = (r.digest!.result as { data: { kinds: { name: string }[] } }).data.kinds.map((k) => k.name);
    expect(kinds).toEqual(["uses_package", "calls_service", "white_label_of", "variant_of", "supersedes"]);
    for (const args of [[], ["bogus"], ["list", "extra"]]) {
      const bad = await runVerb("kinds", args);
      expect(bad.code, JSON.stringify(args)).toBe(2);
      expect(bad.lines).toEqual([]);
    }
  });

  it("an unknown project action → exit 2 naming the valid ones", async () => {
    const r = await runVerb("bogus", []);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown project action 'bogus'.*watermark.*relations.*kinds/);
  });
});
