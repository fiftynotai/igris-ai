/**
 * FR-240 — AC #2. `/api/learnings/search` runs hybrid BM25 + vector recall
 * through the bridge's read-only handle, and reports which arms actually ran.
 *
 * THE FAILURE THIS SUITE EXISTS TO CATCH
 * --------------------------------------
 * `isVectorSearchAvailable(db)` is a `SELECT vec_version()` probe on THAT
 * connection. If the bridge's read-only handle never loaded `sqlite-vec`, the
 * reader falls through to its BM25-only arm SILENTLY and returns plausible
 * results — AC #2 would pass review and be false in production. The plan (§4)
 * names this as the brief's single most likely invisible failure.
 *
 * HOW THE AC #2 EVIDENCE IS SPLIT, AND WHY
 * ----------------------------------------
 * The reader ALWAYS embeds the query before it can reach `vectorSearch`, so an
 * end-to-end "mode === hybrid" assertion is transitively a dependency on the
 * ~90 MB MiniLM ONNX model. Two FR-240 drafts tried to make that a routinely-run
 * gate and both were wrong, in instructive ways:
 *
 *   - Draft 1 DOWNLOADED the model into
 *     `cli/dist/brain-mcp-server/node_modules/@huggingface/transformers/.cache/`
 *     — a BUILD ARTIFACT that `copy-templates.sh` wipes on every build. Two
 *     parallel vitest workers writing it concurrently produced a corrupt
 *     `model.onnx` and a red suite.
 *   - Draft 2 gated on "a cache already exists on disk". That passed in
 *     isolation and FAILED in the full run: the precondition is checked at
 *     module load, and `tarball.test.ts` — running in a parallel worker — boots
 *     the vendored brain server, which touches the same cache. A precondition
 *     that another worker can invalidate mid-file is not a precondition.
 *
 * So the end-to-end assertion is deliberately NOT here. The evidence is split by
 * what each layer can prove deterministically and offline:
 *
 *   1. RECALL SEMANTICS — hybrid vs `bm25_only` vs `vector_only`, the
 *      vector-only row a zero-lexical-overlap query cannot reach through BM25,
 *      the RRF merge, and the FR-109/TD-059 gates — are proven against the SAME
 *      reader function in
 *      `brain-mcp-server/src/tools/__tests__/memory-read.test.ts`
 *      (`G-HS-1` / `G-HS-2` there). ONE implementation (D1) is what makes those
 *      assertions transfer: this endpoint calls that exact function, so there is
 *      no second recall path for them to be wrong about.
 *
 *   2. THE BRIDGE'S CAPABILITY — that the CLI's `{readonly:true, query_only:ON}`
 *      handle can genuinely run the vector arm — is proven HERE, offline and
 *      unconditionally: `sqlite-vec` loads on it, `vec_version()` answers,
 *      `learnings_vec` is queryable through it, and the endpoint reports
 *      `vector_available: true`. This is the half that fails SILENTLY in
 *      production, and it needs no model.
 *
 *   3. THE EMBEDDING BACKEND resolving from the vendored `node_modules` in a CLI
 *      process is a step-10 PROBE finding, recorded in `brain-bridge.ts`'s
 *      module header with its measurement (384 dims, ~306 ms warm) and
 *      re-verifiable on demand. It is not a routinely-run gate, because a shared
 *      mutable 90 MB artifact inside `cli/dist/` cannot be a stable test
 *      precondition under parallel workers — and a flaky gate is worse than a
 *      documented measurement, because it teaches the team to re-run reds.
 *
 * WHAT THIS SUITE DOES NOT PROVE
 * ------------------------------
 *  - That `mode === "hybrid"` end-to-end over HTTP on a machine with a warm
 *    model cache. Measured by hand during FR-240 (it does) and covered
 *    structurally by (1) + (2): the only link those two do not jointly assert is
 *    `generateEmbedding` returning a vector, which is (3).
 *  - Ranking QUALITY. RRF weights are unchanged by FR-240.
 *  - That the UI renders the `BM25 ONLY` banner. **Sibling:** the Phase-5 CDP
 *    gate G-BR-3.
 *  - That the MCP wrapper's prose is unchanged. **Sibling:**
 *    `brain-mcp-server/src/tools/__tests__/wrapper-wire-parity.test.ts`.
 *
 * @module __tests__/dashboard-learnings-search.test
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { get as httpGet } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// Environment preconditions, both NAMED rather than silently skipped.
// ---------------------------------------------------------------------------

const vecEntry = join(bundledBrainNodeModulesDir(), "sqlite-vec", "index.mjs");

/**
 * HERMETIC BY CONSTRUCTION — the suite must never reach the network.
 *
 * The hook and the whole argument for it now live in
 * `hermetic-embeddings.ts#armHermeticEmbeddings`, ONE definition shared by
 * every suite that crawls the layer endpoints. It moved there during the FR-240
 * warden pass for the reason a duplicated guard always moves: this file had it
 * and `dashboard-readonly.test.ts` / `dashboard-layers-endpoint.test.ts` did
 * not, and a vitest worker is its own process with its own module registry — so
 * this file's `beforeAll` protected nothing in theirs, and the suite went on
 * downloading 90 MB on every cold run through a path nobody was looking at.
 *
 * `hermetic.armed` is asserted by its own test below rather than assumed.
 */
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

interface SearchPayload {
  query: string;
  items: {
    id: number;
    title: string;
    preview: string;
    rrf_score: number | null;
    bm25_rank: number | null;
    vector_rank: number | null;
  }[];
  count: number;
  retrieval: {
    mode: string;
    vector_available: boolean;
    embedding_available: boolean;
    bm25_hits: number;
    vector_hits: number;
    rrf_k: number;
    weights: { bm25: number; vector: number };
    reason: string | null;
  };
  degraded: { reason: string } | null;
}

const QUERY = "wrapper";
/** Learning 3 shares no token with "wrapper" — see the shared fixture. */
const ZERO_OVERLAP_ID = 3;

const dbPath = (): string => join(sandbox, "memory", "knowledge.db");

/**
 * Populate `learnings_vec` with DETERMINISTIC synthetic 384-dim vectors.
 *
 * NO MODEL, NO NETWORK. The vectors' semantics are irrelevant to every
 * assertion below: `vectorSearch` is a KNN over a four-row index with a
 * `limit * 2` fetch, so all four rows are returned whatever the query vector is.
 * What matters is that the index EXISTS and is readable through the bridge's
 * handle — which is the capability claim this suite owns. Semantic recall
 * quality is not a claim any of these tests make.
 */
async function seedVectorIndex(): Promise<void> {
  const vec = (await import(vecEntry)) as { load: (db: Database.Database) => void };
  const db = new Database(dbPath());
  try {
    vec.load(db);
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS learnings_vec USING vec0(embedding float[384])",
    );
    const ids = (db.prepare("SELECT id FROM learnings").all() as { id: number }[]).map(
      (r) => r.id,
    );
    const ins = db.prepare(
      "INSERT OR REPLACE INTO learnings_vec(rowid, embedding) VALUES (?, ?)",
    );
    for (const id of ids) {
      const v = new Float32Array(384);
      // Deterministic and normalised, so the index is well-formed rather than
      // degenerate (an all-zero vector makes L2 distance meaningless).
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

async function start(): Promise<void> {
  srv = await startServer({ port: 0, cliVersion: "test" });
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "igris-fr240-search-"));
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
// (2) THE BRIDGE'S CAPABILITY — unconditional, offline, and the half that fails
//     silently in production.
// ---------------------------------------------------------------------------

describe.skipIf(!bundleStaged())(
  "AC #2 (bridge capability) — the read-only handle can run the vector arm; requires `npm run build` in cli/",
  () => {
    it("the HERMETIC guard is actually armed (self-negative-control for this file's own setup)", () => {
      // If this is red, every assertion below may be silently reaching the HF
      // Hub for ~90 MB. An early draft of this hook swallowed its own import
      // error and nothing said so. A guard whose only observed output is "pass"
      // is indistinguishable from a broken one, so it gets its own assertion —
      // demonstrated red during the warden pass by pointing the shared hook at a
      // nonexistent entry file, which turned all three suites' copies of this
      // check red and nothing else.
      expect(
        hermetic.armed,
        `remote model fetch is NOT blocked: ${hermetic.reason ?? "unknown"}`,
      ).toBe(true);
    });

    it("sqlite-vec loads on the bridge's read-only handle and vec_version() answers", async () => {
      const handle = await openBrainReadonlyWithVec();
      expect(handle).not.toBeNull();
      if (handle === null) return;
      try {
        // THE silent-failure guard. A `vector_available:false` here means every
        // search silently degrades to BM25 while looking healthy.
        expect(
          handle.vector_available,
          `sqlite-vec did not load: ${handle.vector_reason ?? "(no reason given)"}`,
        ).toBe(true);
        expect(handle.vector_reason).toBeNull();
        expect(handle.db.prepare("SELECT vec_version() AS v").get()).toHaveProperty("v");
        // And the posture survived the extension load (step-10 probe (a)).
        expect(handle.db.pragma("query_only", { simple: true })).toBe(1);
      } finally {
        handle.db.close();
      }
    });

    it("SELF-NEGATIVE-CONTROL — a plain handle does NOT have the extension", () => {
      // Without this, "vec_version() answered" is indistinguishable from
      // "sqlite-vec is compiled into this SQLite build and the bridge's load()
      // was irrelevant". The plain handle is the same file, same driver, same
      // process — the only difference is the load call.
      const db = openBrainReadonly();
      expect(db).not.toBeNull();
      if (db === null) return;
      try {
        expect(() => db.prepare("SELECT vec_version()").get()).toThrow();
      } finally {
        db.close();
      }
    });

    it("the vector INDEX is readable through that handle", async () => {
      await seedVectorIndex();
      const handle = await openBrainReadonlyWithVec();
      expect(handle).not.toBeNull();
      if (handle === null) return;
      try {
        const row = handle.db
          .prepare("SELECT COUNT(*) AS n FROM learnings_vec")
          .get() as { n: number };
        // Four fixture learnings. Asserting the COUNT (not merely "no throw")
        // distinguishes a queryable index from an empty virtual table.
        expect(row.n).toBe(4);
      } finally {
        handle.db.close();
      }
    });

    it("`vector_available` reports the CONNECTION, independently of whether the arm contributed", async () => {
      // THE FIELD-SEPARATION CONTRACT (D3). The index IS present here, so the
      // only remaining variable downstream is the embedding — and either way the
      // assertion is the same one, which is what makes it the load-bearing one:
      // `vector_available` must be TRUE because the EXTENSION is fine,
      // regardless of `mode`. An implementation
      // that AND-ed this with "the arm contributed" would report `false` on a
      // machine with no model cache and send the operator hunting for a
      // packaging problem that does not exist.
      await seedVectorIndex();
      await start();
      const r = await json<SearchPayload>(
        `/api/learnings/search?q=${encodeURIComponent(QUERY)}`,
      );
      expect(r.retrieval.vector_available).toBe(true);
      if (r.retrieval.embedding_available) {
        expect(r.retrieval.mode).toBe("hybrid");
      } else {
        // A legitimate degraded state — and it must be LOUD, while still
        // reporting the extension as available.
        expect(r.retrieval.mode).toBe("bm25_only");
        expect(r.retrieval.reason).not.toBeNull();
        expect(r.retrieval.vector_hits).toBe(0);
        expect(r.items.map((i) => i.id).sort()).toEqual([1, 2]);
      }
    });

    it("with NO vector index: mode is bm25_only, the reason names the table, and vector_available stays TRUE", async () => {
      // No `seedVectorIndex()`. The extension loaded, so this is the
      // never-embedded-brain state — the common one on a fresh install. It
      // exercises the SAME field-separation contract through a different
      // downstream failure, and unlike the test above its branch is not
      // conditional on the machine's model cache.
      await start();
      const r = await json<SearchPayload>(
        `/api/learnings/search?q=${encodeURIComponent(QUERY)}`,
      );
      expect(r.retrieval.mode).toBe("bm25_only");
      expect(r.retrieval.vector_hits).toBe(0);
      expect(r.retrieval.reason).not.toBeNull();
      // The extension IS loaded — only `learnings_vec` is absent. Reporting
      // `false` here would misdirect the diagnosis.
      expect(r.retrieval.vector_available).toBe(true);
      expect(r.items.map((i) => i.id)).not.toContain(ZERO_OVERLAP_ID);
      expect(r.items.map((i) => i.id).sort()).toEqual([1, 2]);
    });

    it("SELF-NEGATIVE-CONTROL for that field — a plain handle DOES report vector_available:false", async () => {
      // Without this, "vector_available is true" could be a constant. The only
      // difference between this reader call and the endpoint's is the handle.
      const readers = await loadLayerReaders();
      if (readers === null) return;
      const plain = openBrainReadonly();
      if (plain === null) return;
      try {
        const r = await readers.hybridSearchLearnings(plain, { query: QUERY });
        expect(r.retrieval.vector_available).toBe(false);
      } finally {
        plain.close();
      }
    });

    it("the reader takes bm25_only on a handle WITHOUT the extension (the D3 premise)", async () => {
      // The paired control for the first test in this block, one level down:
      // the SAME reader, the SAME corpus, two handles. This is why the bridge
      // has to load the extension at all.
      await seedVectorIndex();
      const readers = await loadLayerReaders();
      expect(readers).not.toBeNull();
      if (readers === null) return;

      const plain = openBrainReadonly();
      expect(plain).not.toBeNull();
      if (plain === null) return;
      try {
        const r = await readers.hybridSearchLearnings(plain, { query: QUERY });
        expect(r.retrieval.mode).toBe("bm25_only");
        expect(r.retrieval.vector_available).toBe(false);
        expect(r.retrieval.reason).toBe("sqlite-vec not loaded on this connection");
        expect(r.rows.map((e) => e.id)).not.toContain(ZERO_OVERLAP_ID);
      } finally {
        plain.close();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// The endpoint's contract — unconditional, no extension and no model needed.
// ---------------------------------------------------------------------------

describe("the search endpoint's contract", () => {
  it("pending_review rows never surface through search (FR-109)", async () => {
    await start();
    const r = await json<SearchPayload>(
      `/api/learnings/search?q=${encodeURIComponent(QUERY)}`,
    );
    // Self-negative-control: learning 4 IS lexically matchable, so its absence
    // is attributable to the gate rather than to the index.
    const db = new Database(dbPath(), { readonly: true });
    try {
      const ungated = db
        .prepare(
          `SELECT l.id FROM learnings_fts fts JOIN learnings l ON l.id = fts.rowid
           WHERE learnings_fts MATCH ?`,
        )
        .all(QUERY) as { id: number }[];
      expect(ungated.map((x) => x.id)).toContain(4);
    } finally {
      db.close();
    }
    expect(r.items.map((i) => i.id)).not.toContain(4);
  });

  it("project filter narrows the search", async () => {
    await start();
    const r = await json<SearchPayload>(
      `/api/learnings/search?q=${encodeURIComponent(QUERY)}&project=demo`,
    );
    expect(r.items.map((i) => i.id)).not.toContain(ZERO_OVERLAP_ID);
    expect(r.items.map((i) => i.id).sort()).toEqual([1, 2]);
  });

  it("REFUSES a missing q rather than returning the whole corpus", async () => {
    await start();
    const r = await json<SearchPayload>("/api/learnings/search");
    expect(r.items).toEqual([]);
    expect(r.degraded?.reason).toContain("'q' is required");
    // A search that silently matched everything is worse than one that refuses:
    // the operator cannot tell it from a very broad query.
    expect(r.count).toBe(0);
  });

  it("refuses an over-long q with the brain's own limit", async () => {
    await start();
    const r = await req(`/api/learnings/search?q=${"a".repeat(10001)}`);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as SearchPayload;
    expect(body.degraded?.reason).toContain("1-10000");
  });

  it("a pure-punctuation query returns nothing and reports mode none", async () => {
    await start();
    const r = await json<SearchPayload>("/api/learnings/search?q=%3F%3F%3F");
    expect(r.items).toEqual([]);
    expect(r.retrieval.mode).toBe("none");
  });

  it("previews are truncated — a search result is not a body dump (D7)", async () => {
    await start();
    const r = await json<SearchPayload>(
      `/api/learnings/search?q=${encodeURIComponent(QUERY)}`,
    );
    expect(r.items.length).toBeGreaterThan(0);
    for (const item of r.items) {
      expect(item.preview.length).toBeLessThanOrEqual(303);
    }
  });

  it("the retrieval block echoes the knobs it used", async () => {
    await start();
    const r = await json<SearchPayload>(
      `/api/learnings/search?q=${encodeURIComponent(QUERY)}`,
    );
    expect(r.retrieval.rrf_k).toBe(60);
    expect(r.retrieval.weights).toEqual({ bm25: 0.5, vector: 0.5 });
  });

  it("degrades cleanly with no brain at all", async () => {
    rmSync(join(sandbox, "memory"), { recursive: true, force: true });
    await start();
    const r = await json<SearchPayload>("/api/learnings/search?q=wrapper");
    expect(r.degraded?.reason).toContain("brain database not found");
    expect(r.items).toEqual([]);
  });
});
