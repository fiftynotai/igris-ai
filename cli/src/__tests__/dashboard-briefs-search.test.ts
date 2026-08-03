/**
 * FR-246 — `/api/briefs/search` runs hybrid BM25 + vector recall over BRIEFS
 * through the bridge's read-only handle, and reports which arms actually ran.
 *
 * Cloned from `dashboard-learnings-search.test.ts`, including its split of
 * evidence. Read that file's header for the full argument; the short version is
 * that an end-to-end `mode === "hybrid"` assertion is transitively a dependency
 * on a ~90 MB MiniLM ONNX model living in a BUILD ARTIFACT that
 * `copy-templates.sh` wipes on every build, so it cannot be a stable gate under
 * parallel workers. The evidence is therefore split:
 *
 *   1. RECALL SEMANTICS — hybrid vs `bm25_only` vs `vector_only`, arm
 *      attribution, and the vector-only row a zero-lexical-overlap query cannot
 *      reach through BM25 — are proven against the SAME reader function in
 *      `brain-mcp-server/src/tools/__tests__/briefs-read-search.test.ts`
 *      (`G-BS-0/1/2` there). ONE implementation is what makes them transfer.
 *   2. THE BRIDGE'S CAPABILITY — that the CLI's `{readonly:true,
 *      query_only:ON}` handle can genuinely run the BRIEFS vector arm — is
 *      proven HERE, offline and unconditionally. This is the half that fails
 *      SILENTLY in production, and it needs no model.
 *
 * THE ONE THING THIS SUITE PROVES THAT ITS LEARNINGS TWIN CANNOT
 * --------------------------------------------------------------
 * `briefs_fts` arrives at schema **v23**, where `learnings_fts` has existed
 * since v1. So briefs have a degraded state learnings do not: a live vector arm
 * and NO lexical arm. `bm25_reason` carries it, and the "pre-v23 brain" case
 * below drives it — because the shape a missing-migration ship would produce is
 * an endpoint returning fewer rows while looking perfectly healthy.
 *
 * WHAT THIS SUITE DOES NOT PROVE
 * ------------------------------
 *  - Ranking QUALITY. RRF weights are unchanged.
 *  - That the UI renders the arm badges. **Sibling:** `G-BR-13` in
 *    `cli/scripts/browser-gate.mjs`.
 *  - That `igris_brief_similar`'s prose survived its extraction. **Sibling:**
 *    `brain-mcp-server/src/tools/__tests__/wrapper-wire-parity.test.ts`.
 *
 * @module __tests__/dashboard-briefs-search.test
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { get as httpGet } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb as closeBrainDb } from "../lib/brain-db.js";
import { closeDb as closeRegistryDb } from "../lib/registry.js";
import {
  loadLayerReaders,
  openBrainReadonly,
  openBrainReadonlyWithVec,
  resetBrainBridge,
  resetLayerReaders,
} from "../lib/brain-bridge.js";
import { bundledBrainNodeModulesDir } from "../lib/paths.js";
import { startServer, type DashboardServer } from "../lib/dashboard/server.js";
import { seedLayerBrain } from "./dashboard-layers-fixture.js";
import {
  armHermeticEmbeddings,
  bundleStaged,
  type HermeticState,
} from "./hermetic-embeddings.js";

const vecEntry = join(bundledBrainNodeModulesDir(), "sqlite-vec", "index.mjs");

/** See the learnings twin's header. `armed` is ASSERTED below, never assumed. */
let hermetic: HermeticState = { armed: false, reason: "not attempted" };

beforeAll(async () => {
  if (!bundleStaged()) {
    hermetic = { armed: false, reason: "vendored bundle not staged" };
    return;
  }
  hermetic = await armHermeticEmbeddings();
});

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

interface BriefsSearchPayload {
  query: string;
  items: {
    id: number;
    project: string;
    brief_id: string;
    title: string;
    content_length: number;
    rrf_score: number | null;
    bm25_rank: number | null;
    vector_rank: number | null;
  }[];
  count: number;
  params: string[];
  retrieval: {
    mode: string;
    vector_available: boolean;
    embedding_available: boolean;
    bm25_hits: number;
    vector_hits: number;
    rrf_k: number;
    weights: { bm25: number; vector: number };
    reason: string | null;
    bm25_reason: string | null;
  };
  degraded: { reason: string } | null;
}

/** Matches three of the four fixture briefs by TITLE. */
const QUERY = "bug";

const dbPath = (): string => join(sandbox, "memory", "knowledge.db");

/** Deterministic synthetic vectors for `briefs_vec`. NO MODEL, NO NETWORK. */
async function seedVectorIndex(): Promise<void> {
  const vec = (await import(vecEntry)) as { load: (db: Database.Database) => void };
  const db = new Database(dbPath());
  try {
    vec.load(db);
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS briefs_vec USING vec0(embedding float[384])",
    );
    const ids = (db.prepare("SELECT id FROM brief_status").all() as { id: number }[]).map(
      (r) => r.id,
    );
    const ins = db.prepare(
      "INSERT OR REPLACE INTO briefs_vec(rowid, embedding) VALUES (?, ?)",
    );
    for (const id of ids) {
      const v = new Float32Array(384);
      let norm = 0;
      for (let i = 0; i < 384; i++) {
        v[i] = Math.sin((id + 1) * (i + 1) * 0.017);
        norm += v[i] * v[i];
      }
      norm = Math.sqrt(norm);
      for (let i = 0; i < 384; i++) v[i] /= norm;
      ins.run(BigInt(id), Buffer.from(v.buffer, v.byteOffset, v.byteLength));
    }
  } finally {
    db.close();
  }
}

/** Drop `briefs_fts` — the pre-v23 brain, which is a state that WILL ship. */
function dropFts(): void {
  const db = new Database(dbPath());
  try {
    db.exec("DROP TABLE briefs_fts");
  } finally {
    db.close();
  }
}

async function start(): Promise<void> {
  srv = await startServer({ port: 0, cliVersion: "test" });
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "igris-fr246-search-"));
  process.env.IGRIS_BRAIN_DIR = sandbox;
  closeBrainDb();
  closeRegistryDb();
  resetBrainBridge();
  resetLayerReaders();
  seedLayerBrain(dbPath());
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

// ---------------------------------------------------------------------------
// (2) THE BRIDGE'S CAPABILITY
// ---------------------------------------------------------------------------

describe.skipIf(!bundleStaged())(
  "FR-246 (bridge capability) — the read-only handle can run the BRIEFS vector arm; requires `npm run build` in cli/",
  () => {
    it("the HERMETIC guard is actually armed (self-negative-control for this file's own setup)", () => {
      // A vitest worker is its own process with its own module registry, so the
      // sibling suites' copies of this hook protect nothing here. If this is
      // red, every assertion below may be reaching the HF Hub for ~90 MB.
      expect(
        hermetic.armed,
        `remote model fetch is NOT blocked: ${hermetic.reason ?? "unknown"}`,
      ).toBe(true);
    });

    it("the briefs_vec INDEX is readable through the read-only handle", async () => {
      await seedVectorIndex();
      const handle = await openBrainReadonlyWithVec();
      expect(handle).not.toBeNull();
      if (handle === null) return;
      try {
        expect(
          handle.vector_available,
          `sqlite-vec did not load: ${handle.vector_reason ?? "(no reason given)"}`,
        ).toBe(true);
        const row = handle.db
          .prepare("SELECT COUNT(*) AS n FROM briefs_vec")
          .get() as { n: number };
        // FOUR fixture briefs. Asserting the COUNT (not merely "no throw")
        // distinguishes a queryable index from an empty virtual table.
        expect(row.n).toBe(4);
        // The read-only posture survived the extension load.
        expect(handle.db.pragma("query_only", { simple: true })).toBe(1);
      } finally {
        handle.db.close();
      }
    });

    it("SELF-NEGATIVE-CONTROL — a plain handle cannot read briefs_vec at all", async () => {
      // Without this, "briefs_vec was queryable" could mean sqlite-vec is
      // compiled into this SQLite build and the bridge's `load()` was
      // irrelevant. Same file, same driver, same process — the only difference
      // is the load call.
      await seedVectorIndex();
      const db = openBrainReadonly();
      expect(db).not.toBeNull();
      if (db === null) return;
      try {
        expect(() => db.prepare("SELECT COUNT(*) FROM briefs_vec").get()).toThrow();
      } finally {
        db.close();
      }
    });

    it("`vector_available` reports the CONNECTION, independently of whether the arm contributed", async () => {
      // THE FIELD-SEPARATION CONTRACT. `vector_available` must be TRUE because
      // the EXTENSION is fine, whatever `mode` says. An implementation that
      // AND-ed it with "the arm contributed" would report `false` on a machine
      // with no model cache and send the operator hunting a packaging problem
      // that does not exist.
      //
      // The branch is EXPLICIT rather than assumed because the gate world is
      // hermetic: with no model cache this run takes the `bm25_only` arm, and
      // an unconditional `mode === "hybrid"` here would be the vacuous form of
      // this test.
      await seedVectorIndex();
      await start();
      const r = await json<BriefsSearchPayload>(
        `/api/briefs/search?q=${encodeURIComponent(QUERY)}`,
      );
      expect(r.retrieval.vector_available).toBe(true);
      // Either way the LEXICAL arm ran, because `briefs_fts` is in the fixture.
      expect(r.retrieval.bm25_reason).toBeNull();
      expect(r.retrieval.bm25_hits).toBeGreaterThan(0);
      if (r.retrieval.embedding_available) {
        expect(r.retrieval.mode).toBe("hybrid");
        expect(r.retrieval.vector_hits).toBeGreaterThan(0);
      } else {
        expect(r.retrieval.mode).toBe("bm25_only");
        expect(r.retrieval.reason).not.toBeNull();
        expect(r.retrieval.vector_hits).toBe(0);
      }
    });

    it("the reader takes bm25_only on a handle WITHOUT the extension", async () => {
      await seedVectorIndex();
      const readers = await loadLayerReaders();
      expect(readers).not.toBeNull();
      if (readers === null) return;
      const plain = openBrainReadonly();
      expect(plain).not.toBeNull();
      if (plain === null) return;
      try {
        const r = await readers.hybridSearchBriefs(plain, { query: QUERY });
        expect(r.retrieval.mode).toBe("bm25_only");
        expect(r.retrieval.vector_available).toBe(false);
        expect(r.retrieval.reason).toBe("sqlite-vec not loaded on this connection");
        // ...and the LEXICAL arm still delivered, which is the whole point of
        // building it: this state returns rows where a vector-only briefs search
        // would return nothing at all.
        expect(r.rows.length).toBeGreaterThan(0);
      } finally {
        plain.close();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// The endpoint's contract — unconditional, no extension and no model needed.
// ---------------------------------------------------------------------------

describe("the briefs search endpoint's contract", () => {
  it("returns ranked briefs and reaches the BODY, which no other arm can", async () => {
    await start();
    // "shell" appears in `bf-1`'s CONTENT and in no brief TITLE — asserted, not
    // assumed, because that is the entire claim.
    const db = new Database(dbPath(), { readonly: true });
    try {
      const titles = db.prepare("SELECT title FROM brief_status").all() as {
        title: string;
      }[];
      expect(titles.every((t) => !t.title.toLowerCase().includes("shell"))).toBe(true);
    } finally {
      db.close();
    }
    const r = await json<BriefsSearchPayload>("/api/briefs/search?q=shell");
    expect(r.items.map((i) => i.brief_id)).toEqual(["FR-240"]);
    expect(r.retrieval.bm25_hits).toBe(1);
  });

  it("ships NO body — content_length instead (FR-240 D7)", async () => {
    await start();
    const r = await json<BriefsSearchPayload>("/api/briefs/search?q=shell");
    const item = r.items[0] as unknown as Record<string, unknown>;
    expect(item).not.toHaveProperty("content");
    expect(item).not.toHaveProperty("preview");
    expect(r.items[0].content_length).toBeGreaterThan(0);
  });

  it("the project filter narrows the search across BOTH arms", async () => {
    await start();
    // `BR-001` exists in demo AND other (the BR-078 collision the fixture keeps
    // on purpose), so an unscoped search returns both.
    const all = await json<BriefsSearchPayload>(
      `/api/briefs/search?q=${encodeURIComponent(QUERY)}`,
    );
    expect(all.items.filter((i) => i.brief_id === "BR-001").length).toBe(2);
    const scoped = await json<BriefsSearchPayload>(
      `/api/briefs/search?q=${encodeURIComponent(QUERY)}&project=demo`,
    );
    expect(scoped.items.every((i) => i.project === "demo")).toBe(true);
  });

  it("a PRE-v23 brain reports bm25_reason rather than a silently thinner list", async () => {
    // The state a missing-migration ship produces. Without `bm25_reason` this
    // is indistinguishable from "your query matched nothing".
    dropFts();
    await start();
    const r = await json<BriefsSearchPayload>("/api/briefs/search?q=shell");
    expect(r.retrieval.bm25_reason).toBe(
      "brain table absent: briefs_fts (schema v23 not applied)",
    );
    expect(r.retrieval.bm25_hits).toBe(0);
    expect(r.items).toEqual([]);
    // It is a DEGRADE, not an error: the endpoint still answers 200 with a
    // stated reason, exactly as the vector arm's absence does.
    expect(r.degraded).toBeNull();
  });

  it("SELF-NEGATIVE-CONTROL for that state — the SAME query WITH the index returns rows", async () => {
    // Without this, "the pre-v23 case returned nothing" is indistinguishable
    // from "the query was wrong". Same query, same corpus, one table.
    await start();
    const withFts = await json<BriefsSearchPayload>("/api/briefs/search?q=shell");
    expect(withFts.items.length).toBeGreaterThan(0);
    expect(withFts.retrieval.bm25_reason).toBeNull();
  });

  it("REFUSES a missing q rather than returning the whole corpus", async () => {
    await start();
    const r = await json<BriefsSearchPayload>("/api/briefs/search");
    expect(r.items).toEqual([]);
    expect(r.degraded?.reason).toContain("'q' is required");
    expect(r.count).toBe(0);
  });

  it("refuses an over-long q with the brain's own limit", async () => {
    await start();
    const r = await req(`/api/briefs/search?q=${"a".repeat(10001)}`);
    expect(r.status).toBe(200);
    expect((JSON.parse(r.body) as BriefsSearchPayload).degraded?.reason).toContain(
      "1-10000",
    );
  });

  it("a pure-punctuation query returns nothing, reports mode none, and NAMES why bm25 found nothing", async () => {
    await start();
    const r = await json<BriefsSearchPayload>("/api/briefs/search?q=%3F%3F%3F");
    expect(r.items).toEqual([]);
    expect(r.retrieval.mode).toBe("none");
    // Distinguished from the pre-v23 case above: the index is fine, the QUERY
    // had nothing to match with. Two empty results, two different reasons.
    expect(r.retrieval.bm25_reason).toBe(
      "query has no searchable tokens after FTS5 sanitisation",
    );
  });

  it("the retrieval block echoes the knobs it used", async () => {
    await start();
    const r = await json<BriefsSearchPayload>("/api/briefs/search?q=shell");
    expect(r.retrieval.rrf_k).toBe(60);
    expect(r.retrieval.weights).toEqual({ bm25: 0.5, vector: 0.5 });
  });

  it("rejects an unknown filter instead of ignoring it", async () => {
    await start();
    const r = await json<BriefsSearchPayload>("/api/briefs/search?q=shell&prjoect=demo");
    expect(r.params).toContain("unknown filter: prjoect");
  });

  /**
   * The FR-246 sign-off's rule, on the one endpoint this brief adds: **a
   * parameter this path parses must be forwarded, or must not be parsed.**
   *
   * `BRIEF_FILTERS` is shared with `/api/briefs`, so `?status=Ready` is
   * RECOGNISED here — and recognising it is exactly what makes it dangerous:
   * without the drop-and-report loop, sharing the spec list converts a visible
   * `unknown filter: status` note into a SILENT drop. The four below are
   * allow-listed, unbindable by `hybridSearchBriefs`, and must therefore be
   * named.
   *
   * This is BR-085's shape (`/api/learnings/search` parsing `review_status` and
   * dropping it while the UI bannered otherwise), which FR-246 was told not to
   * reproduce.
   */
  it("NAMES every allow-listed filter it cannot bind — BR-085's shape, refused", async () => {
    await start();
    const r = await json<BriefsSearchPayload>(
      "/api/briefs/search?q=wrapper&status=Ready&priority=P1-High&effort=M&brief_type=Feature",
    );
    for (const name of ["status", "priority", "effort", "brief_type"]) {
      expect(
        r.params.some((p) => p.startsWith(`${name}: dropped`)),
        `${name} was parsed and dropped without a note — params=${JSON.stringify(r.params)}`,
      ).toBe(true);
    }
    // FOUR filters, FOUR notes: a loop that reported only the first would
    // satisfy a `length > 0` check.
    expect(r.params.filter((p) => p.includes(": dropped")).length).toBe(4);
  });

  it("does NOT report a drop for a filter that WAS forwarded", async () => {
    // The self-negative-control. Without it, "every unbound filter is named" is
    // satisfiable by naming EVERY filter — including `project`, which this
    // endpoint really does bind, which would be a different lie.
    await start();
    const r = await json<BriefsSearchPayload>("/api/briefs/search?q=wrapper&project=demo");
    expect(r.params.filter((p) => p.includes(": dropped"))).toEqual([]);
    expect(r.items.every((i) => i.project === "demo")).toBe(true);
  });

  it("says nothing at all when no unbindable filter was supplied", async () => {
    await start();
    const r = await json<BriefsSearchPayload>("/api/briefs/search?q=wrapper");
    expect(r.params).toEqual([]);
  });

  it("degrades cleanly with no brain at all", async () => {
    rmSync(join(sandbox, "memory"), { recursive: true, force: true });
    await start();
    const r = await json<BriefsSearchPayload>("/api/briefs/search?q=shell");
    expect(r.degraded?.reason).toContain("brain database not found");
    expect(r.items).toEqual([]);
  });
});
