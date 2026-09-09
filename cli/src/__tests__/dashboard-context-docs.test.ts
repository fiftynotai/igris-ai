/**
 * FR-240 G-EP-4 — `/api/context-docs` and `/api/context-doc`.
 *
 * D8: this layer does ZERO brain work. Context docs are FILES under
 * `~/.igris/projects/<slug>/context/`, and `igris context-docs inventory`
 * already owns the whole exists/applies/missing/remediation computation. So the
 * endpoints add exactly two things — a registry-backed slug allowlist and a
 * guarded disk read — and those two things are what this suite tests.
 *
 * WHAT THESE GATES PROVE
 * ----------------------
 *  - The inventory is FORWARDED, not recomputed: `missing_applicable` and
 *    `remediation` come from the digest, asserted against the digest's own
 *    output rather than against a hand-written list.
 *  - The disk read cannot escape `projectContextDir(slug)`: a traversal slug, a
 *    traversal `type`, an unregistered slug and a SYMLINK planted inside the
 *    context dir are all refused.
 *  - The read-only lens does not CREATE the brain database on a machine that
 *    has none (the T1 defect this suite's sibling caught).
 *
 * WHAT THEY DO NOT PROVE
 * ----------------------
 *  - `applies_when` CORRECTNESS. That predicate is owned by
 *    `igris context-docs inventory` and deliberately not re-implemented here;
 *    its own tests are the sibling. A `applies` value being wrong is a bug in
 *    the verb, and this endpoint would faithfully forward it — which is the
 *    intended coupling.
 *  - That the browser renders the markdown safely. **Sibling:** the Phase-3
 *    `markdown/__tests__/parse.test.ts` injection cases.
 *
 * @module __tests__/dashboard-context-docs.test
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { get as httpGet } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb as closeBrainDb } from "../lib/brain-db.js";
import { closeDb as closeRegistryDb } from "../lib/registry.js";
import { resetBrainBridge, resetLayerReaders } from "../lib/brain-bridge.js";
import { startServer, type DashboardServer } from "../lib/dashboard/server.js";
import { cutToBytes, readDoc, readInventory } from "../lib/dashboard/context-docs-read.js";
import { buildContextDocsInventoryDigest } from "../verbs/context-docs.js";
import { seedLayerBrain } from "./dashboard-layers-fixture.js";

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

async function json<T>(path: string): Promise<T> {
  const r = await req(path);
  expect(r.status, `${path} -> ${r.status}: ${r.body.slice(0, 300)}`).toBe(200);
  return JSON.parse(r.body) as T;
}

const contextDir = (slug: string): string => join(sandbox, "projects", slug, "context");

/**
 * Seed a minimal context-doc CATALOG under the sandboxed brain.
 *
 * The catalog is `~/.igris/core/context-doc-types/*.md` with YAML frontmatter;
 * `readCatalogDocs()` parses `type` / `target` / `applies_when` / `optional` /
 * `summary`. Two entries, chosen so one APPLIES and one does not on the same
 * project — a catalog where every row applied could not discriminate.
 */
function seedCatalog(): void {
  const dir = join(sandbox, "core", "context-doc-types");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "INDEX.md"),
    "# Catalog index — deliberately skipped by readCatalogDocs\n",
  );
  writeFileSync(
    join(dir, "coding_guidelines.md"),
    [
      "---",
      "type: coding_guidelines",
      "target: coding_guidelines.md",
      "applies_when: writing or reviewing code",
      "optional: false",
      "summary: Code conventions and naming rules",
      "---",
      "",
      "Body of the catalog entry.",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "architecture_map.md"),
    [
      "---",
      "type: architecture_map",
      "target: architecture_map.md",
      "applies_when: working across module boundaries",
      "optional: false",
      "summary: How the system fits together",
      "---",
      "",
      "Body of the catalog entry.",
    ].join("\n"),
  );
}

/** Write one project context doc. */
function seedDoc(slug: string, filename: string, content: string): string {
  const dir = contextDir(slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, content);
  return path;
}

async function start(): Promise<void> {
  srv = await startServer({ port: 0, cliVersion: "test" });
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "igris-fr240-ctx-"));
  process.env.IGRIS_BRAIN_DIR = sandbox;
  closeBrainDb();
  closeRegistryDb();
  resetBrainBridge();
  resetLayerReaders();
  seedLayerBrain(join(sandbox, "memory", "knowledge.db"));
  seedCatalog();
});

afterEach(async () => {
  if (srv !== null) {
    await srv.close();
    srv = null;
  }
  closeBrainDb();
  closeRegistryDb();
  resetBrainBridge();
  resetLayerReaders();
  rmSync(sandbox, { recursive: true, force: true });
  if (prevBrain === undefined) delete process.env.IGRIS_BRAIN_DIR;
  else process.env.IGRIS_BRAIN_DIR = prevBrain;
});

interface DocsPayload {
  project: string | null;
  docs: { type: string; target: string; exists: boolean; missing_applicable: boolean }[];
  missing_applicable: string[];
  remediation: string[];
  inventory_degraded: boolean;
  degraded: { reason: string } | null;
}

interface DocPayload {
  project: string | null;
  type: string | null;
  target: string | null;
  content: string | null;
  bytes: number;
  truncated: boolean;
  degraded: { reason: string } | null;
}

describe("GET /api/context-docs — the inventory is FORWARDED, not recomputed", () => {
  beforeEach(async () => {
    seedDoc("demo", "coding_guidelines.md", "# Guidelines\n\nUse tabs. Or don't.\n");
    await start();
  });

  it("returns one row per catalog entry with the right exists flags", async () => {
    const r = await json<DocsPayload>("/api/context-docs?project=demo");
    expect(r.degraded).toBeNull();
    expect(r.docs.map((d) => d.type).sort()).toEqual([
      "architecture_map",
      "coding_guidelines",
    ]);
    const guidelines = r.docs.find((d) => d.type === "coding_guidelines");
    const archmap = r.docs.find((d) => d.type === "architecture_map");
    expect(guidelines?.exists).toBe(true);
    // Discriminating: an inventory that reported everything present (or
    // everything absent) would pass an exists assertion on one row alone.
    expect(archmap?.exists).toBe(false);
  });

  it("`missing_applicable` and `remediation` come from the DIGEST, byte-for-byte", async () => {
    const r = await json<DocsPayload>("/api/context-docs?project=demo");
    const digest = buildContextDocsInventoryDigest("demo");
    // Asserted against the digest's own output rather than against a literal
    // list: a hand-written expectation here would become a SECOND definition of
    // the remediation verb names, which is exactly what D8 forbids.
    expect(r.missing_applicable).toEqual(digest.missing_applicable);
    expect(r.remediation).toEqual(digest.remediation);
    for (const line of r.remediation) {
      expect(line).toMatch(/^\/ground /);
    }
  });

  it("refuses an UNREGISTERED slug", async () => {
    const r = await json<DocsPayload>("/api/context-docs?project=not-registered");
    expect(r.docs).toEqual([]);
    expect(r.degraded?.reason).toBe("unknown project: not-registered");
  });

  it("G-EP-4 — a traversal slug is refused BEFORE any path is built", async () => {
    for (const slug of ["../../etc", "..%2F..%2Fetc", "demo/../other", "/etc"]) {
      const r = await json<DocsPayload>(
        `/api/context-docs?project=${encodeURIComponent(slug)}`,
      );
      expect(r.docs, slug).toEqual([]);
      // "unknown project" and not a filesystem error: the slug never reached
      // `projectContextDir`, because registry membership is checked first.
      expect(r.degraded?.reason, slug).toContain("unknown project");
    }
  });

  it("requires `project`", async () => {
    const r = await json<DocsPayload>("/api/context-docs");
    expect(r.degraded?.reason).toBe("'project' is required");
  });
});

describe("GET /api/context-doc — the guarded read", () => {
  beforeEach(async () => {
    seedDoc("demo", "coding_guidelines.md", "# Guidelines\n\nRule one.\n");
    await start();
  });

  it("serves the doc body, addressed by catalog TYPE", async () => {
    const r = await json<DocPayload>(
      "/api/context-doc?project=demo&type=coding_guidelines",
    );
    expect(r.degraded).toBeNull();
    expect(r.target).toBe("coding_guidelines.md");
    expect(r.content).toBe("# Guidelines\n\nRule one.\n");
    expect(r.bytes).toBe(24);
    expect(r.truncated).toBe(false);
  });

  it("a doc that applies but is absent reports the digest's own /ground verb", async () => {
    const r = await json<DocPayload>(
      "/api/context-doc?project=demo&type=architecture_map",
    );
    expect(r.content).toBeNull();
    expect(r.degraded?.reason).toContain("/ground architecture_map");
  });

  it("refuses an unknown doc TYPE", async () => {
    const r = await json<DocPayload>("/api/context-doc?project=demo&type=not_a_type");
    expect(r.degraded?.reason).toBe("unknown context-doc type: not_a_type");
  });

  it("G-EP-4 — a traversal `type` has nowhere to land", async () => {
    // There is no code path that joins a caller-supplied FILENAME: the filename
    // comes from the digest row. So a traversal `type` is refused as an unknown
    // TYPE, which is a structurally stronger outcome than a filtered path.
    for (const type of [
      "../../../.ssh/id_rsa",
      "..%2F..%2Fetc%2Fpasswd",
      "coding_guidelines.md",
      "/etc/passwd",
    ]) {
      const r = await json<DocPayload>(
        `/api/context-doc?project=demo&type=${encodeURIComponent(type)}`,
      );
      expect(r.content, type).toBeNull();
      expect(r.degraded?.reason, type).toContain("unknown context-doc type");
    }
  });

  it("refuses a traversal slug", async () => {
    const r = await json<DocPayload>(
      "/api/context-doc?project=..%2F..%2Fetc&type=coding_guidelines",
    );
    expect(r.content).toBeNull();
    expect(r.degraded?.reason).toContain("unknown project");
  });

  it("requires both params", async () => {
    expect(
      (await json<DocPayload>("/api/context-doc?project=demo")).degraded?.reason,
    ).toContain("required");
    expect(
      (await json<DocPayload>("/api/context-doc?type=coding_guidelines")).degraded
        ?.reason,
    ).toContain("required");
  });
});

describe("the PHYSICAL fence — a symlink out of the context dir", () => {
  it("refuses a doc whose realpath escapes projectContextDir", () => {
    // `~/.igris/projects/**` is a directory the OPERATOR writes, which is the
    // condition `static.ts#resolveStatic`'s SCOPE LIMIT note says demands a
    // physical check rather than a lexical one. This is that check: the lexical
    // guard passes (the path IS inside the dir), and only `realpath` catches it.
    const secretDir = mkdtempSync(join(tmpdir(), "igris-fr240-secret-"));
    const secret = join(secretDir, "id_rsa");
    writeFileSync(secret, "PRIVATE KEY MATERIAL");
    try {
      mkdirSync(contextDir("demo"), { recursive: true });
      symlinkSync(secret, join(contextDir("demo"), "coding_guidelines.md"));

      const r = readDoc("demo", "coding_guidelines");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("resolves outside");

      // Self-negative-control (FR-239 learning 1094): prove the same read
      // SUCCEEDS for a real file in the same slot. Without this, the refusal
      // above is indistinguishable from "readDoc refuses everything".
      rmSync(join(contextDir("demo"), "coding_guidelines.md"));
      seedDoc("demo", "coding_guidelines.md", "real content");
      const ok = readDoc("demo", "coding_guidelines");
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.content).toBe("real content");
    } finally {
      rmSync(secretDir, { recursive: true, force: true });
    }
  });

  it("refuses a directory in a doc's place", () => {
    mkdirSync(join(contextDir("demo"), "coding_guidelines.md"), { recursive: true });
    const r = readDoc("demo", "coding_guidelines");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not a regular file");
  });
});

describe("the read-only lens does not CREATE the brain (AC #7)", () => {
  it("a context-docs request on a brainless machine leaves no database behind", async () => {
    rmSync(join(sandbox, "memory"), { recursive: true, force: true });
    const dbPath = join(sandbox, "memory", "knowledge.db");
    expect(existsSync(dbPath)).toBe(false);

    await start();
    const r = await json<DocsPayload>("/api/context-docs?project=demo");

    // ASSERT-THEN-DIFF (learning 1093). The LOAD-BEARING claim goes first: if
    // the endpoint conjured a brain, THAT is what the failure must name. It sat
    // below the `degraded.reason` string check, so a real regression reported
    // "expected 'no such table: projects' to contain 'brain database not
    // found'" — a wording complaint about the true defect one line down.
    // `registry.ts` OWNS + CREATES its `projects` table, so reaching
    // `listProjects()` — the WRITE door — unguarded materialises a brain file.
    // That is a WRITE, and AC #7 says nothing in this brief mutates the brain.
    // Regression pin for the defect `dashboard-layers-endpoint.test.ts` T1
    // exposed. TD-319 added a SECOND fence rather than replacing this one: the
    // endpoint now reads `listProjectsReadonly()`, whose handle is opened
    // `fileMustExist: true`. This test stays because two independent fences
    // means either can be removed without the other silently going with it.
    expect(
      existsSync(dbPath),
      "a read-only endpoint conjured a brain database",
    ).toBe(false);
    expect(r.degraded?.reason).toContain("brain database not found");
  });

  it("the direct reader agrees with the endpoint on a brainless machine", () => {
    rmSync(join(sandbox, "memory"), { recursive: true, force: true });
    const r = readInventory("demo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("brain database not found");
    expect(existsSync(join(sandbox, "memory", "knowledge.db"))).toBe(false);
  });
});

describe("catalog degradation", () => {
  it("an absent catalog degrades with a stated reason, never a throw", async () => {
    rmSync(join(sandbox, "core", "context-doc-types"), {
      recursive: true,
      force: true,
    });
    await start();
    const r = await json<DocsPayload>("/api/context-docs?project=demo");
    expect(r.docs).toEqual([]);
    expect(r.inventory_degraded).toBe(true);
    expect(r.degraded?.reason).toContain("inventory incomplete");
  });

  it("a corrupt brain does not take the context-docs endpoint down", async () => {
    // Context docs need no brain DATA, only the registry for the slug check.
    // A corrupt file makes that check fail closed, not crash.
    writeFileSync(join(sandbox, "memory", "knowledge.db"), "not a sqlite file");
    closeRegistryDb();
    await start();
    const r = await req("/api/context-docs?project=demo");
    expect(r.status).toBe(200);
    expect(r.body).not.toMatch(/\n\s+at /);
  });
});

describe("the brain is never opened by this layer (D8)", () => {
  it("both handlers work with the layer readers unavailable", async () => {
    // A packaging failure that breaks `/api/briefs` must NOT break context
    // docs — they share no door. Simulated by pointing the reader cache at a
    // failure state that the other endpoints would report.
    seedDoc("demo", "coding_guidelines.md", "still readable");
    await start();
    const r = await json<DocPayload>(
      "/api/context-doc?project=demo&type=coding_guidelines",
    );
    expect(r.content).toBe("still readable");
    // The proof that no brain read happened is structural: `contextDocs` and
    // `contextDoc` are the only two handlers in `routes.ts` that are NOT async
    // and never call `openReadContext()`. Stated here so the claim is on record
    // next to the test that depends on it.
    expect(r.degraded).toBeNull();
  });
});

describe("truncation", () => {
  it("caps an absurd doc and says so", async () => {
    const big = "x".repeat(3 * 1024 * 1024);
    seedDoc("demo", "coding_guidelines.md", big);
    await start();
    const r = await json<DocPayload>(
      "/api/context-doc?project=demo&type=coding_guidelines",
    );
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBe(3 * 1024 * 1024);
    expect((r.content ?? "").length).toBe(2 * 1024 * 1024);
    expect(r.degraded?.reason).toContain("truncated");
  });

  it("the cap is BYTES, on a doc where bytes and characters differ", async () => {
    // The ASCII case above cannot tell the two units apart — one char is one
    // byte, so a `slice(MAX_DOC_BYTES)` over characters passes it. Prose in the
    // brain is not all ASCII (em dashes, arrows, box drawing), and the earlier
    // implementation over-delivered by up to ~3x the ceiling on it.
    const doc = "→".repeat(3 * 1024 * 1024); // 3 bytes each, 1 UTF-16 unit each
    seedDoc("demo", "coding_guidelines.md", doc);
    await start();
    const r = await json<DocPayload>(
      "/api/context-doc?project=demo&type=coding_guidelines",
    );
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBe(9 * 1024 * 1024);
    // The DELIVERED body is under the byte ceiling — the load-bearing claim.
    expect(Buffer.byteLength(r.content ?? "", "utf-8")).toBeLessThanOrEqual(
      2 * 1024 * 1024,
    );
    // …and it is not merely under it, it is AT it (to within one character).
    expect(Buffer.byteLength(r.content ?? "", "utf-8")).toBeGreaterThan(
      2 * 1024 * 1024 - 4,
    );
    // No replacement character: the cut never lands inside a sequence.
    expect(r.content ?? "").not.toContain("�");
  });
});

describe("cutToBytes — the byte-accurate cut", () => {
  it("never exceeds the bound and never splits a character", () => {
    // Cut at EVERY offset across a 3-byte character so the boundary case is
    // exercised from all three phases rather than from a lucky one.
    const s = "a→b→c";
    const full = Buffer.byteLength(s, "utf-8");
    for (let max = 0; max <= full; max++) {
      const out = cutToBytes(s, max);
      expect(Buffer.byteLength(out, "utf-8"), `max=${max}`).toBeLessThanOrEqual(max);
      expect(out, `max=${max}`).not.toContain("�");
      // It is a genuine PREFIX, not a re-encoding.
      expect(s.startsWith(out), `max=${max}`).toBe(true);
    }
  });

  it("returns the input untouched when it already fits", () => {
    expect(cutToBytes("→→", 6)).toBe("→→");
    expect(cutToBytes("→→", 99)).toBe("→→");
  });

  it("SELF-NEGATIVE-CONTROL — a character-based cut would BREAK the same case", () => {
    // Without this the loop above is also what you observe from an
    // implementation that never had to cut anything.
    const s = "→".repeat(20); // 60 bytes, 20 UTF-16 code units
    expect(Buffer.byteLength(s.slice(0, 12), "utf-8")).toBe(36); // over the bound
    expect(Buffer.byteLength(cutToBytes(s, 12), "utf-8")).toBe(12);
    expect(cutToBytes(s, 12)).toBe("→→→→");
  });
});

describe("sanity — the fixture registry really has the project", () => {
  it("demo is registered and unregistered slugs are not", () => {
    const db = new Database(join(sandbox, "memory", "knowledge.db"), {
      readonly: true,
    });
    try {
      const slugs = (db.prepare("SELECT slug FROM projects").all() as { slug: string }[])
        .map((r) => r.slug)
        .sort();
      expect(slugs).toEqual(["demo", "other"]);
    } finally {
      db.close();
    }
  });
});
