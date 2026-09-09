/**
 * FR-248 — `GET /api/search`, the ONE box over every layer, fused with RRF.
 *
 * Nothing is mocked. The server binds a real loopback port, the brain is a real
 * SQLite file in a sandboxed `IGRIS_BRAIN_DIR`, and the readers are the REAL
 * compiled modules loaded out of the vendored bundle — the same discipline
 * `dashboard-layers-endpoint.test.ts` holds, and for the same reason: a suite
 * that stubbed the bridge would pass with the read layer deleted.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * R0 — THE POSITIVE CONTROL, AND WHY IT IS THE FIRST BLOCK IN THE FILE
 * ─────────────────────────────────────────────────────────────────────────
 * AC-4 is "a layer whose retrieval is unavailable is REPORTED, not silently
 * absent". Every assertion of that form is satisfiable by a build in which the
 * layer never worked at all — an `available: false` on a layer that is always
 * false proves nothing. So the FULL world is asserted FIRST, against the
 * ENDPOINTS FR-246 ALREADY SHIPPED, before a line of fused code exists:
 * `/api/briefs/search` produces brief rows through a LIVE lexical arm, and the
 * three substring surfaces produce rows too. That block is the vacuity guard
 * and it is not optional.
 *
 * Its negative twin is in the same describe: the SAME query, in the SAME
 * fixture with `omit: ["briefs_fts"]`, returns zero brief rows and NAMES the
 * absent table. That is what makes "the briefs layer is unavailable" a fact
 * about the world rather than a property of the assertion.
 *
 * WHY THE OMITTED WORLD IS DETERMINISTIC, which the plan under-stated — and
 * where this file's OWN first draft was then wrong in the other direction.
 *
 * The plan's mechanism was "no `briefs_fts` plus the hermetic no-model guard
 * leaves neither arm". The hermetic guard only blocks a REMOTE fetch, so a warm
 * HuggingFace cache would still embed: that half is machine-dependent. The half
 * that holds everywhere is structural — this fixture creates no `briefs_vec`,
 * so the vector arm cannot produce a hit on any machine.
 *
 * BUT THE REASON STRING IS STILL MACHINE-DEPENDENT, which the first draft of
 * this header claimed it was not, and the AC-4 test went red proving it.
 * `briefVectorArm` embeds the query BEFORE it queries `briefs_vec`, so on a
 * COLD cache it returns the `EmbeddingsUnavailableError` and never reaches the
 * L-133 preflight; only on a WARM cache does it report `brain table absent:
 * briefs_vec`. Three causes, one outcome. So the assertions below pin the
 * OUTCOME — the arm did not run, said why, and contributed nothing — and never
 * the cause's wording.
 *
 * @module __tests__/dashboard-search-fused.test
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { get as httpGet } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb as closeBrainDb } from "../lib/brain-db.js";
import { closeDb as closeRegistryDb } from "../lib/registry.js";
import { resetBrainBridge, resetLayerReaders } from "../lib/brain-bridge.js";
import { startServer, type DashboardServer } from "../lib/dashboard/server.js";
import {
  FIXTURE,
  seedLayerBrain,
  type SeedLayerBrainOptions,
} from "./dashboard-layers-fixture.js";
import {
  armHermeticEmbeddings,
  bundleStaged,
  type HermeticState,
} from "./hermetic-embeddings.js";
import {
  appliedParams,
  fuseLayers,
  fusedScore,
  retrievalAvailability,
  FUSION_RRF_K,
  type FusedRowSeed,
  type LayerRanking,
} from "../lib/dashboard/search-fuse.js";

/**
 * HERMETIC — every path this suite drives embeds its query before it can reach
 * a vector arm, so without this guard the suite downloads ~90 MB from the HF
 * Hub into a build artifact. `armed` is ASSERTED below, not assumed: a guard
 * whose only observed outcome is "pass" is not a guard (learning 1094).
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

/** The token the FR-248 corpus shares across four layers. */
const Q = FIXTURE.fusion.token;

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
  // The degraded contract is 200-always. A non-200 from a path that exists is
  // itself the failure this assertion catches — and it is what keeps a RED in
  // this file about CONTENT rather than about routing.
  expect(r.status, `${path} -> ${r.status}: ${r.body.slice(0, 200)}`).toBe(200);
  return JSON.parse(r.body) as T;
}

/** Seed a world and start the server against it. */
async function world(opts: SeedLayerBrainOptions): Promise<void> {
  seedLayerBrain(join(sandbox, "memory", "knowledge.db"), opts);
  srv = await startServer({ port: 0, cliVersion: "test" });
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "igris-fr248-"));
  process.env.IGRIS_BRAIN_DIR = sandbox;
  closeBrainDb();
  closeRegistryDb();
  resetBrainBridge();
  resetLayerReaders();
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

interface RetrievalBlock {
  mode: string;
  vector_available: boolean;
  embedding_available: boolean;
  bm25_hits: number;
  vector_hits: number;
  rrf_k: number;
  weights: { bm25: number; vector: number };
  reason: string | null;
  bm25_reason?: string | null;
}

interface SearchEnvelope {
  count: number;
  items: unknown[];
  degraded: { reason: string } | null;
}

// ---------------------------------------------------------------------------
// R0 — the positive control. Written and green BEFORE any fused code existed.
// ---------------------------------------------------------------------------

describe("R0 — the arms produce rows in the FULL world (the vacuity guard)", () => {
  it("the suite is HERMETIC and the vendored bundle is staged", () => {
    expect(bundleStaged(), "run `npm run build` in cli/ before this suite").toBe(
      true,
    );
    expect(
      hermetic.armed,
      `remote model fetch is NOT blocked: ${hermetic.reason ?? "unknown"}`,
    ).toBe(true);
  });

  it("/api/briefs/search finds the corpus through a LIVE lexical arm", async () => {
    await world({ fusion: true });
    const r = await json<SearchEnvelope & { retrieval: RetrievalBlock }>(
      `/api/briefs/search?q=${Q}`,
    );
    expect(r.degraded, `degraded: ${r.degraded?.reason ?? ""}`).toBeNull();
    // BOTH halves. `count > 0` alone would stay green if the rows arrived from
    // some other arm; `bm25_reason === null` is the claim that the arm the
    // omitted world removes is the arm that is working here.
    expect(r.count).toBe(FIXTURE.fusion.rowsPerLayer);
    expect(r.retrieval.bm25_reason ?? null).toBeNull();
    expect(r.retrieval.bm25_hits).toBeGreaterThan(0);
  });

  it("/api/learnings/search finds the corpus", async () => {
    await world({ fusion: true });
    const r = await json<SearchEnvelope>(`/api/learnings/search?q=${Q}`);
    expect(r.degraded).toBeNull();
    expect(r.count).toBe(FIXTURE.fusion.rowsPerLayer);
  });

  it("the three substring surfaces find the corpus", async () => {
    await world({ fusion: true });
    // Goals and suggestions carry rows. Context docs are asserted separately:
    // this sandbox has no catalog on disk, which is itself a state the fused
    // surface has to report rather than render as "nothing matched".
    for (const path of [`/api/goals?q=${Q}`, `/api/suggestions?q=${Q}`]) {
      const r = await json<SearchEnvelope & { search: unknown }>(path);
      expect(r.degraded, `${path} degraded`).toBeNull();
      expect(r.count, `${path} count`).toBe(FIXTURE.fusion.rowsPerLayer);
      expect(r.search, `${path} search block`).toEqual({
        mode: "substring",
        fields: expect.any(Array),
      });
    }
  });

  it("R0's NEGATIVE twin — omit:[briefs_fts] really does disable the arm", async () => {
    await world({ fusion: true, omit: ["briefs_fts"] });
    const r = await json<SearchEnvelope & { retrieval: RetrievalBlock }>(
      `/api/briefs/search?q=${Q}`,
    );
    // Same endpoint, same query, same corpus — and now nothing. If this went
    // green in the full world too, every AC-4 assertion below would be vacuous.
    expect(r.count).toBe(0);
    expect(r.retrieval.mode).toBe("none");
    expect(r.retrieval.bm25_reason).toContain("briefs_fts");
    // The OTHER arm, named rather than assumed. This is the half the plan left
    // to the hermetic guard; it is structural instead — the fixture creates no
    // `briefs_vec`, so the vector arm is out on a machine with a warm model
    // cache as surely as on one without.
    expect(r.retrieval.reason).not.toBeNull();
  });

  it("R1 — /api/search is ROUTED, so every RED below is about content", async () => {
    await world({ fusion: true });
    // The TRANSPORT proof, kept as its own named case rather than left implicit
    // in the content assertions. `/api/nope` answers 404 through the `/api/`
    // catch-all, so a fused path that was never wired into `server.ts` would
    // fail EVERY assertion in this file with the same unhelpful message —
    // proving the router instead of the check.
    expect((await req(`/api/search?q=${Q}`)).status).toBe(200);
    expect((await req("/api/nope")).status).toBe(404);
    // ...and with no `q` it REFUSES rather than answering the unfiltered
    // corpus — the `parseQuery` contract `/api/briefs/search` already holds.
    const bare = await json<{ degraded: { reason: string } | null }>(
      "/api/search",
    );
    expect(bare.degraded?.reason).toContain("'q' is required");
  });

  it("the omit is SCOPED — the other layers are untouched by it", async () => {
    await world({ fusion: true, omit: ["briefs_fts"] });
    // Without this, "briefs is unavailable" could be true because the whole
    // fixture failed to seed.
    for (const path of [
      `/api/learnings/search?q=${Q}`,
      `/api/goals?q=${Q}`,
      `/api/suggestions?q=${Q}`,
    ]) {
      const r = await json<SearchEnvelope>(path);
      expect(r.count, `${path} must still return rows`).toBe(
        FIXTURE.fusion.rowsPerLayer,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// search-fuse.ts — the PURE half, driven with rows no reader could produce.
// ---------------------------------------------------------------------------

const seed = (id: string, score: number | null): FusedRowSeed => ({
  ref: { project: null, id },
  title: id,
  subtitle: null,
  updated_at: null,
  rrf_score: score,
});

describe("search-fuse.ts — rank fusion, driven directly", () => {
  it("AC-2 PROPER — a 10^6 score gap changes NOTHING about the order", () => {
    // The endpoint cannot build this case: no reader emits a score of 100. It
    // is the whole reason the fusion is a pure function — the contrapositive of
    // "fusion is RRF over ranks, no ad-hoc score normalisation" is only
    // observable when the scores DISAGREE violently with the ranks.
    const fused = fuseLayers(
      [
        {
          layer: "briefs",
          rank_basis: "rrf",
          rows: [seed("tiny-1", 0.0001), seed("tiny-2", 0.00009)],
        },
        {
          layer: "learnings",
          rank_basis: "rrf",
          rows: [seed("huge-1", 100), seed("huge-2", 90)],
        },
      ],
      10,
    );
    // Interleaved. Under ANY score-based fusion the learnings block would take
    // both top slots — its smallest score is a million times the other's
    // largest.
    expect(fused.map((r) => r.key)).toEqual([
      "briefs::tiny-1",
      "learnings::huge-1",
      "briefs::tiny-2",
      "learnings::huge-2",
    ]);
  });

  it("a SCORELESS layer is not sunk by one that carries scores", () => {
    const fused = fuseLayers(
      [
        { layer: "briefs", rank_basis: "rrf", rows: [seed("b1", 0.0166), seed("b2", 0.0163)] },
        { layer: "goals", rank_basis: "substring", rows: [seed("g1", null), seed("g2", null)] },
      ],
      10,
    );
    expect(fused.map((r) => r.key)).toEqual([
      "briefs::b1",
      "goals::g1",
      "briefs::b2",
      "goals::g2",
    ]);
    // ...and the seed's score survives to the wire UNREAD — it is diagnosis,
    // not an input.
    expect(fused[0]?.rrf_score).toBe(0.0166);
    expect(fused[1]?.rrf_score).toBeNull();
  });

  it("the tie-break is DETERMINISTIC — input order cannot move the output", () => {
    const a: LayerRanking = { layer: "suggestions", rank_basis: "substring", rows: [seed("s1", null)] };
    const b: LayerRanking = { layer: "briefs", rank_basis: "rrf", rows: [seed("b1", null)] };
    const c: LayerRanking = { layer: "goals", rank_basis: "substring", rows: [seed("g1", null)] };
    // Three permutations, one answer. Without an explicit tie-break the sort's
    // stability would leak the arms' completion order into the visible list,
    // which `Promise.allSettled` makes non-deterministic.
    for (const order of [[a, b, c], [c, a, b], [b, c, a]]) {
      expect(fuseLayers(order, 10).map((r) => r.layer)).toEqual([
        "briefs",
        "goals",
        "suggestions",
      ]);
    }
  });

  it("the fused cap falls on the FUSED order, not on whichever arm was first", () => {
    const fused = fuseLayers(
      [
        { layer: "briefs", rank_basis: "rrf", rows: [seed("b1", null), seed("b2", null), seed("b3", null)] },
        { layer: "goals", rank_basis: "substring", rows: [seed("g1", null), seed("g2", null)] },
      ],
      3,
    );
    // A cap applied per-arm would have kept b1,b2,b3 and lost the goals layer
    // entirely — a silent whole-layer drop introduced by a truncation.
    expect(fused.map((r) => r.key)).toEqual([
      "briefs::b1",
      "goals::g1",
      "briefs::b2",
    ]);
  });

  it("fusedScore is weight / (k + rank), with k = 60", () => {
    expect(FUSION_RRF_K).toBe(60);
    expect(fusedScore(1)).toBeCloseTo(1 / 61, 15);
    expect(fusedScore(2)).toBeCloseTo(1 / 62, 15);
    expect(fusedScore(1)).toBeGreaterThan(fusedScore(2));
  });

  it("retrievalAvailability — 'nothing matched' is NOT 'unavailable'", () => {
    // Both arms ran, nothing came back. AVAILABLE.
    expect(retrievalAvailability({ reason: null, bm25_reason: null })).toEqual({
      available: true,
      reason: null,
    });
    // Vector out, lexical live — the ordinary offline/no-model state.
    expect(
      retrievalAvailability({ reason: "sqlite-vec not loaded", bm25_reason: null }).available,
    ).toBe(true);
    // Lexical out, vector live — a pre-v23 brain with a warm model.
    expect(
      retrievalAvailability({ reason: null, bm25_reason: "briefs_fts absent" }).available,
    ).toBe(true);
    // BOTH out. Unavailable, and the reason names both.
    const dead = retrievalAvailability({
      reason: "brain table absent: briefs_vec",
      bm25_reason: "brain table absent: briefs_fts",
    });
    expect(dead.available).toBe(false);
    expect(dead.reason).toContain("briefs_fts");
    expect(dead.reason).toContain("briefs_vec");
    // The LEARNINGS shape: no `bm25_reason` field at all. An absent field means
    // "this layer's lexical arm cannot be missing", so a dead vector arm alone
    // leaves the layer available.
    expect(retrievalAvailability({ reason: "no model" }).available).toBe(true);
  });

  it("appliedParams reports what the OPTIONS OBJECT carries, not what a list claims", () => {
    const opts = { query: "x", project: undefined as string | undefined, limit: 20 };
    const map: ReadonlyMap<string, keyof typeof opts> = new Map([
      ["q", "query"],
      ["project", "project"],
      ["limit", "limit"],
    ]);
    // `project` is undefined on the options object, so it is NOT claimed —
    // which is the whole of BR-085 at one call site.
    expect(appliedParams(opts, map)).toEqual(["limit", "q"]);
    expect(appliedParams({ ...opts, project: "demo" }, map)).toEqual([
      "limit",
      "project",
      "q",
    ]);
  });
});

// ---------------------------------------------------------------------------
// R2 — the fused surface itself.
// ---------------------------------------------------------------------------

interface LayerReport {
  layer: string;
  requested: boolean;
  available: boolean;
  reason: string | null;
  rank_basis: string;
  hits: number;
  contributed: number;
  retrieval: RetrievalBlock | null;
  search: { mode: string; fields: string[] } | null;
  applied: string[];
}

interface FusedRow {
  layer: string;
  rank_basis: string;
  layer_rank: number;
  fused_score: number;
  key: string;
  ref: { project: string | null; id: string };
  title: string;
  subtitle: string | null;
  updated_at: string | null;
  rrf_score: number | null;
}

interface Fused {
  query: string;
  items: FusedRow[];
  count: number;
  layers: LayerReport[];
  fusion: {
    rrf_k: number;
    weights: Record<string, number>;
    substring_layers: string[];
  };
  params: string[];
  generated_at: string;
  degraded: { reason: string } | null;
}

/**
 * The declared layer set, WRITTEN OUT rather than imported from the
 * implementation.
 *
 * A test that derived this from `search-fuse.ts#DECLARED_LAYERS` would assert
 * that the payload agrees with itself: deleting a layer from the module would
 * move the expectation with it and stay green. The whole of invariant 1 is that
 * this set is fixed, so the set is spelled out here, once, by hand.
 */
const DECLARED = [
  "briefs",
  "learnings",
  "goals",
  "suggestions",
  "context-docs",
] as const;

/** The three layers FR-246 built as `LIKE '%q%'`, measured from its code. */
const SUBSTRING_LAYERS = ["goals", "suggestions", "context-docs"] as const;

const layerOf = (p: Fused, id: string): LayerReport => {
  const found = p.layers.find((l) => l.layer === id);
  if (found === undefined) {
    throw new Error(
      `layer '${id}' is ABSENT from layers[] — the silent drop AC-4 forbids. Present: ${JSON.stringify(p.layers.map((l) => l.layer))}`,
    );
  }
  return found;
};

describe("invariants 1-5 — the shape that makes a silent drop unrepresentable", () => {
  it("INVARIANT 1 — layers[] has all five, in the FULL world", async () => {
    await world({ fusion: true });
    const p = await json<Fused>(`/api/search?q=${Q}`);
    expect(p.layers.map((l) => l.layer)).toEqual([...DECLARED]);
  });

  it("INVARIANT 1 — ...and on EVERY degraded path, which is the hard half", async () => {
    // A payload that carries the block only when the read succeeded would
    // satisfy the test above and still drop layers exactly when it matters. All
    // three of these return BEFORE any arm runs.
    await world({ fusion: true });
    const noQuery = await json<Fused>("/api/search");
    expect(noQuery.layers.map((l) => l.layer)).toEqual([...DECLARED]);
    expect(noQuery.degraded).not.toBeNull();

    // A brain that is not on disk. Same server, brain removed underneath it —
    // the FR-238 degraded contract's own case.
    rmSync(join(sandbox, "memory"), { recursive: true, force: true });
    const noBrain = await json<Fused>(`/api/search?q=${Q}`);
    expect(noBrain.layers.map((l) => l.layer)).toEqual([...DECLARED]);
    expect(noBrain.degraded).not.toBeNull();
    // ...and each entry is a STATED unavailability, not a default-shaped one.
    for (const l of noBrain.layers) {
      expect(l.available, `${l.layer} cannot be available with no brain`).toBe(
        false,
      );
      expect(l.reason, `${l.layer} owes a reason`).not.toBeNull();
    }
  });

  it("INVARIANT 2 — available === false ⟺ reason !== null, BOTH directions", async () => {
    await world({ fusion: true, omit: ["briefs_fts"] });
    const p = await json<Fused>(`/api/search?q=${Q}`);
    for (const l of p.layers) {
      expect(
        l.reason === null,
        `${l.layer}: available=${l.available} reason=${JSON.stringify(l.reason)}`,
      ).toBe(l.available);
    }
    // The biconditional is only interesting over a population containing BOTH
    // values. Without this the loop is satisfiable by five available layers.
    expect(p.layers.some((l) => l.available)).toBe(true);
    expect(p.layers.some((l) => !l.available)).toBe(true);
  });

  it("INVARIANT 3 — retrieval XOR search, per layer", async () => {
    await world({ fusion: true });
    const p = await json<Fused>(`/api/search?q=${Q}`);
    // SELF-ARMING. Every `for (const l of p.layers)` below is satisfied by an
    // EMPTY block — which is precisely the defect invariant 1 exists to
    // forbid, so a loop over `layers[]` that does not first assert the
    // population is a check that goes green on the failure it is guarding.
    expect(p.layers).toHaveLength(DECLARED.length);
    for (const l of p.layers) {
      expect(
        (l.retrieval === null) !== (l.search === null),
        `${l.layer}: retrieval=${l.retrieval === null ? "null" : "set"} search=${l.search === null ? "null" : "set"}`,
      ).toBe(true);
      // ...and the one that IS set is the one the basis names. FR-246's pin,
      // lifted per-layer: a `retrieval` block on a substring layer is exactly
      // how a filter starts being read as recall.
      if (l.rank_basis === "substring") {
        expect(l.retrieval, `${l.layer} must carry no retrieval`).toBeNull();
        expect(l.search?.mode).toBe("substring");
      } else {
        expect(l.rank_basis).toBe("rrf");
        expect(l.search, `${l.layer} must carry no search block`).toBeNull();
        expect(l.retrieval).not.toBeNull();
      }
    }
  });

  it("INVARIANT 4 — a row cannot claim a basis its layer does not have (AC-5)", async () => {
    await world({ fusion: true });
    const p = await json<Fused>(`/api/search?q=${Q}`);
    expect(p.items.length).toBeGreaterThan(0);
    for (const row of p.items) {
      expect(DECLARED as readonly string[]).toContain(row.layer);
      expect(row.rank_basis, `row ${row.key}`).toBe(
        layerOf(p, row.layer).rank_basis,
      );
    }
    // AC-5's real teeth: at least one row from a substring layer is IN the
    // fused list AND says so. An all-`rrf` list would pass the loop above.
    const substringRows = p.items.filter((r) => r.rank_basis === "substring");
    expect(substringRows.length).toBeGreaterThan(0);
    for (const row of substringRows) {
      expect(SUBSTRING_LAYERS as readonly string[]).toContain(row.layer);
      // A substring layer has no relevance score to carry, and carrying a
      // number here would be the laundering scope item 5 names.
      expect(row.rrf_score, `${row.key} must carry no score`).toBeNull();
    }
  });

  it("INVARIANT 5 — Σ contributed === items.length; no orphan rows, no lost rows", async () => {
    await world({ fusion: true });
    const p = await json<Fused>(`/api/search?q=${Q}`);
    // SELF-ARMING — `0 === 0` is the emptiest way to balance a ledger.
    expect(p.layers).toHaveLength(DECLARED.length);
    expect(p.items.length).toBeGreaterThan(0);
    const summed = p.layers.reduce((n, l) => n + l.contributed, 0);
    expect(summed).toBe(p.items.length);
    expect(p.count).toBe(p.items.length);
    // ...and per layer, `contributed` is the number of rows actually carrying
    // that layer. A total that balances while individual entries are wrong is
    // the arithmetic accident this second check removes.
    for (const l of p.layers) {
      expect(
        p.items.filter((r) => r.layer === l.layer).length,
        `${l.layer} contributed`,
      ).toBe(l.contributed);
      expect(l.contributed, `${l.layer} cannot contribute more than it hit`).toBeLessThanOrEqual(
        l.hits,
      );
    }
  });
});

describe("AC-1 / AC-3 — one ranked list, every row naming its layer", () => {
  it("one query returns rows from MORE THAN ONE layer in a single list", async () => {
    await world({ fusion: true });
    const p = await json<Fused>(`/api/search?q=${Q}`);
    const layers = new Set(p.items.map((r) => r.layer));
    expect(layers.size).toBeGreaterThan(1);
    // The corpus seeds four layers; asserting the exact set is what turns
    // "more than one" from a floor into a reading.
    expect([...layers].sort()).toEqual([
      "briefs",
      "goals",
      "learnings",
      "suggestions",
    ]);
  });

  it("every row carries a layer, a within-layer rank and an address", async () => {
    await world({ fusion: true });
    const p = await json<Fused>(`/api/search?q=${Q}`);
    // SELF-ARMING — an empty `items` satisfies every per-row claim below.
    expect(p.items.length).toBeGreaterThan(0);
    for (const row of p.items) {
      expect(row.layer.length, JSON.stringify(row)).toBeGreaterThan(0);
      expect(row.layer_rank).toBeGreaterThanOrEqual(1);
      expect(row.title.length).toBeGreaterThan(0);
      expect(row.ref.id.length).toBeGreaterThan(0);
      // BR-078, learned FROM the code while implementing: `BR-001` names a
      // DIFFERENT brief in 25 projects and `briefs_fts` indexes the id, so one
      // query can return two rows with the same `ref.id`. The key therefore
      // composes layer + project + id; `layer:id` would collide and a UI
      // keying on it would render one row where there are two.
      expect(row.key).toBe(`${row.layer}:${row.ref.project ?? ""}:${row.ref.id}`);
    }
    // Keys are UNIQUE across the fused list, or "contributed" is countable and
    // the list is still ambiguous to a UI keying on it.
    expect(new Set(p.items.map((r) => r.key)).size).toBe(p.items.length);
  });

  it("BR-078 — two briefs with the SAME id keep DISTINCT keys", async () => {
    await world({ fusion: true });
    // The uniqueness check above runs over a corpus with no duplicate ids, so
    // it is vacuous for the one case that can actually collide. `BR-001` names
    // a different brief in `demo` and in `other`, `briefs_fts` indexes the id,
    // and one query returns BOTH — measured, not supposed.
    const p = await json<Fused>("/api/search?q=BR-001");
    const briefs = p.items.filter((r) => r.layer === "briefs");
    expect(briefs.map((r) => r.ref.id)).toEqual(["BR-001", "BR-001"]);
    expect(briefs.map((r) => r.ref.project).sort()).toEqual(["demo", "other"]);
    // A key of `layer:id` would collapse these two rows into one for any UI
    // keying its list on it — a silent drop introduced by the identity
    // function. The project segment is what prevents it.
    expect(new Set(briefs.map((r) => r.key)).size).toBe(2);
    expect(briefs.map((r) => r.key).sort()).toEqual([
      "briefs:demo:BR-001",
      "briefs:other:BR-001",
    ]);
  });
});

describe("AC-2 — RRF over RANKS, and the scale-invariance that proves it", () => {
  it("the fused order is a deterministic round-robin by within-layer rank", async () => {
    await world({ fusion: true });
    const p = await json<Fused>(`/api/search?q=${Q}`);
    // Four layers × two rows. Under rank fusion with uniform weights every
    // layer's rank-1 row scores identically, so the list interleaves and the
    // documented tie-break (layer name ASC) fixes the order. Under ANY
    // score-based fusion the two substring layers — which have no score at all
    // — would sink to the bottom as a block.
    expect(p.items.map((r) => r.layer)).toEqual([
      "briefs",
      "goals",
      "learnings",
      "suggestions",
      "briefs",
      "goals",
      "learnings",
      "suggestions",
    ]);
    expect(p.items.map((r) => r.layer_rank)).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
  });

  it("a SCORELESS substring row outranks a lower-ranked SCORED retrieval row", async () => {
    await world({ fusion: true });
    const p = await json<Fused>(`/api/search?q=${Q}`);
    const firstGoal = p.items.findIndex((r) => r.layer === "goals");
    const lastBrief = p.items.map((r) => r.layer).lastIndexOf("briefs");
    expect(firstGoal).toBeGreaterThanOrEqual(0);
    expect(lastBrief).toBeGreaterThanOrEqual(0);
    // This is the assertable contrapositive of "no ad-hoc score normalisation".
    // The goals row carries `rrf_score: null`; the brief row it beats carries a
    // real number. Any fusion that read the scores would order these the other
    // way round.
    expect(firstGoal).toBeLessThan(lastBrief);
    expect(p.items[firstGoal]?.rrf_score ?? null).toBeNull();
  });

  it("fused_score is weight / (k + rank) — the arithmetic, said out loud", async () => {
    await world({ fusion: true });
    const p = await json<Fused>(`/api/search?q=${Q}`);
    // SELF-ARMING — the arithmetic below is vacuous over an empty list.
    expect(p.items.length).toBeGreaterThan(0);
    for (const row of p.items) {
      const w = p.fusion.weights[row.layer];
      expect(w, `no weight for ${row.layer}`).toBeDefined();
      expect(row.fused_score).toBeCloseTo(
        (w as number) / (p.fusion.rrf_k + row.layer_rank),
        12,
      );
    }
    // Every fused row belongs to exactly ONE layer, so there is no summation
    // term. That looks like a bug to a reader expecting RRF to "do something",
    // which is why the property is pinned here as well as commented in
    // `search-fuse.ts`.
    expect(p.items.map((r) => r.fused_score)).toEqual(
      [...p.items].map((r) => r.fused_score).sort((a, b) => b - a),
    );
  });
});

describe("D2 — the INTER-layer parameters, distinct from every layer's own", () => {
  it("rrf_k is 60 with uniform per-layer weights, over all five layers", async () => {
    await world({ fusion: true });
    const p = await json<Fused>(`/api/search?q=${Q}`);
    expect(p.fusion.rrf_k).toBe(60);
    expect(p.fusion.weights).toEqual({
      briefs: 1,
      learnings: 1,
      goals: 1,
      suggestions: 1,
      "context-docs": 1,
    });
  });

  it("it is NOT caller-tunable — ?rrf_k= is refused, not honoured", async () => {
    await world({ fusion: true });
    const p = await json<Fused>(`/api/search?q=${Q}&rrf_k=1&bm25_weight=9`);
    expect(p.fusion.rrf_k).toBe(60);
    expect(p.params).toContain("unknown filter: rrf_k");
    expect(p.params).toContain("unknown filter: bm25_weight");
  });

  it("the fused k is STRUCTURALLY separate from a layer's own retrieval.rrf_k", async () => {
    await world({ fusion: true });
    const p = await json<Fused>(`/api/search?q=${Q}`);
    const briefs = layerOf(p, "briefs");
    // They happen to be the same NUMBER today and are two different decisions:
    // one fuses BM25 against vector inside a layer, the other fuses layers
    // against each other. The gate is that both are present and separately
    // addressable, so a future change to one cannot silently move the other.
    expect(briefs.retrieval?.rrf_k).toBe(60);
    expect(p.fusion).not.toHaveProperty("weights.bm25");
    expect(briefs.retrieval?.weights).toEqual({ bm25: 0.5, vector: 0.5 });
  });

  it("D1's mandatory readout is DATA: which layers ranked by list order", async () => {
    await world({ fusion: true });
    const p = await json<Fused>(`/api/search?q=${Q}`);
    // Contributing substring layers only — a layer that returned nothing has
    // nothing to warn about, and listing it would train the reader to ignore
    // the warning.
    expect(p.fusion.substring_layers).toEqual(["goals", "suggestions"]);
  });
});

describe("AC-4 — a dead layer is REPORTED, not silently absent", () => {
  it("PRIMARY — omit:[briefs_fts] leaves briefs unavailable AND named", async () => {
    await world({ fusion: true, omit: ["briefs_fts"] });
    const p = await json<Fused>(`/api/search?q=${Q}`);
    const briefs = layerOf(p, "briefs");
    expect(briefs.available).toBe(false);
    expect(briefs.reason).not.toBeNull();
    // The reason must NAME the cause. "unavailable" alone sends an operator
    // nowhere; `briefs_fts` sends them to the migration.
    expect(briefs.reason).toContain("briefs_fts");
    // BOTH arms are named, because a layer reported out on one arm while the
    // other is live would be a lie in the other direction.
    //
    // THE VECTOR HALF IS ASSERTED STRUCTURALLY, NOT BY ITS TEXT, and that is a
    // correction this test made to its own author. `briefVectorArm` embeds the
    // query BEFORE it touches `briefs_vec`, so the vector arm is out for one of
    // THREE causes depending on the machine: sqlite-vec not loaded, the HF
    // model not cached (this machine — `EmbeddingsUnavailableError`), or
    // `briefs_vec` absent (a machine with a warm cache). The first draft
    // asserted the third string and went RED here on a cold cache. What holds
    // on EVERY machine is that the arm did not run and SAID why — so that is
    // what is asserted.
    expect(briefs.reason).toMatch(/vector: \S/);
    expect(briefs.retrieval?.mode).toBe("none");
    expect(briefs.retrieval?.vector_hits).toBe(0);
    expect(briefs.hits).toBe(0);
    expect(briefs.contributed).toBe(0);
  });

  it("...and the fused list STILL SERVES the other four — not merely fewer rows", async () => {
    await world({ fusion: true, omit: ["briefs_fts"] });
    const p = await json<Fused>(`/api/search?q=${Q}`);
    // This is the clause that separates AC-4 from "the response got shorter".
    expect(p.items.length).toBeGreaterThan(0);
    expect(p.layers.filter((l) => l.available).length).toBeGreaterThan(0);
    expect(p.items.some((r) => r.layer === "briefs")).toBe(false);
    expect(new Set(p.items.map((r) => r.layer))).toEqual(
      new Set(["goals", "learnings", "suggestions"]),
    );
    // The whole response is NOT degraded: four working layers is a working
    // search. Collapsing one dead layer into a whole-response degrade is the
    // exact opposite of AC-4.
    expect(p.degraded).toBeNull();
  });

  it("the SAME query in the FULL world reports briefs AVAILABLE and contributing", async () => {
    // The pair. Run back to back, the two cases differ in exactly one fixture
    // option, so "briefs is unavailable" cannot be a property of the build.
    await world({ fusion: true });
    const p = await json<Fused>(`/api/search?q=${Q}`);
    const briefs = layerOf(p, "briefs");
    expect(briefs.available).toBe(true);
    expect(briefs.reason).toBeNull();
    expect(briefs.contributed).toBeGreaterThan(0);
  });

  it("SECONDARY — context docs are addressed per project and say so", async () => {
    await world({ fusion: true });
    const p = await json<Fused>(`/api/search?q=${Q}`);
    const docs = layerOf(p, "context-docs");
    // An independent second control, free of fixture surgery: `readInventory`
    // cannot answer without a slug. Kept as the SECOND control because it is
    // arguably "not applicable" rather than "unavailable".
    expect(docs.available).toBe(false);
    expect(docs.reason).toContain("project");
  });

  it("a per-layer failure does not become a whole-response failure", async () => {
    await world({ fusion: true, omit: ["briefs_fts"] });
    const p = await json<Fused>(`/api/search?q=${Q}`);
    // `Promise.allSettled` over five arms rather than one outer try/catch. An
    // outer catch degrades the WHOLE response, which is the failure mode AC-4
    // exists to forbid — and it is invisible unless asserted, because a
    // degraded envelope is also a 200.
    expect(p.degraded).toBeNull();
    expect(p.count).toBeGreaterThan(0);
  });
});

describe("BR-085 — bound or named, per LAYER", () => {
  it("every layer's `applied` is what ITS arm was given, not a response-wide claim", async () => {
    await world({ fusion: true });
    const p = await json<Fused>(`/api/search?q=${Q}&project=demo`);
    // SELF-ARMING, and doubly so: the loop `continue`s on an unavailable
    // layer, so an empty block AND an all-unavailable block both satisfy it.
    expect(p.layers).toHaveLength(DECLARED.length);
    expect(p.layers.filter((l) => l.available).length).toBeGreaterThanOrEqual(3);
    for (const l of p.layers) {
      if (!l.available) continue;
      // `q` and `project` bind on all five arms; `limit` on all five.
      expect(l.applied, `${l.layer} applied`).toContain("q");
      expect(l.applied, `${l.layer} applied`).toContain("project");
      expect(l.applied, `${l.layer} applied`).toContain("limit");
    }
  });

  it("the unscoped read does NOT claim a project it was not given", async () => {
    await world({ fusion: true });
    const p = await json<Fused>(`/api/search?q=${Q}`);
    expect(p.layers).toHaveLength(DECLARED.length);
    // ...and the layers DO claim something, or "does not claim project" is
    // satisfied by an `applied` that is empty everywhere.
    //
    // ARMED, because the obvious form is vacuous: `every()` over a block where
    // no layer is available returns true without inspecting anything, which is
    // precisely the shape this suite already had to fix seven times against the
    // Phase-2 stub. Assert the POPULATION first, then the property.
    const live = p.layers.filter((l) => l.available);
    expect(live.length, "no live layer — the property below is vacuous")
      .toBeGreaterThanOrEqual(3);
    expect(live.every((l) => l.applied.includes("q"))).toBe(true);
    for (const l of p.layers) {
      expect(l.applied, `${l.layer} must not claim project`).not.toContain(
        "project",
      );
    }
  });

  it("a filter this surface cannot bind is NAMED, never swallowed", async () => {
    await world({ fusion: true });
    const p = await json<Fused>(
      `/api/search?q=${Q}&review_status=pending_review&status=Pending&category=pattern`,
    );
    // BR-085's exact shape: `review_status` binds on the learnings arm alone,
    // `status` exists on briefs AND goals with DIFFERENT vocabularies. Binding
    // either would make the fused response's scope true on average.
    expect(p.params).toContain("unknown filter: review_status");
    expect(p.params).toContain("unknown filter: status");
    expect(p.params).toContain("unknown filter: category");
  });

  it("TD-326 — scoping to a project HIDES the brain-level suggestions, and says so", async () => {
    await world({ fusion: true });
    const scoped = await json<Fused>(`/api/search?q=gap&project=demo`);
    expect(
      scoped.params.some(
        (n) => n.includes("suggestions") && n.includes("brain-level"),
      ),
      `params: ${JSON.stringify(scoped.params)}`,
    ).toBe(true);
    // ...and the note is absent when there is no project to hide anything.
    const unscoped = await json<Fused>(`/api/search?q=gap`);
    expect(
      unscoped.params.some((n) => n.includes("brain-level")),
    ).toBe(false);
  });
});

describe("the vector arm, and the handle it degrades on", () => {
  it("each retrieval layer reports its OWN vector availability", async () => {
    await world({ fusion: true });
    const p = await json<Fused>(`/api/search?q=${Q}`);
    for (const id of ["briefs", "learnings"]) {
      const l = layerOf(p, id);
      expect(l.retrieval, `${id} retrieval`).not.toBeNull();
      // `openBrainReadonlyWithVec()` is the ONLY correct handle here: the probe
      // is `SELECT vec_version()` on THAT connection, so a plain
      // `openBrainReadonly` would make both arms take their BM25-only path
      // SILENTLY. `true` is the reading on a staged bundle; a red here means
      // the handle regressed, not that the test is wrong.
      expect(
        l.retrieval?.vector_available,
        `${id}: sqlite-vec did not load on the fused handle`,
      ).toBe(true);
    }
  });
});

describe("?layers= — narrowing, without conflating it with a fault", () => {
  it("a narrowed request marks the others NOT REQUESTED, and still lists five", async () => {
    await world({ fusion: true });
    const p = await json<Fused>(`/api/search?q=${Q}&layers=goals,briefs`);
    expect(p.layers.map((l) => l.layer)).toEqual([...DECLARED]);
    expect(
      p.layers.filter((l) => l.requested).map((l) => l.layer).sort(),
    ).toEqual(["briefs", "goals"]);
    expect(new Set(p.items.map((r) => r.layer))).toEqual(
      new Set(["briefs", "goals"]),
    );
    const learnings = layerOf(p, "learnings");
    expect(learnings.requested).toBe(false);
    // "You excluded this" is reported as its own sentence. Reusing the
    // fault reason here would make an operator hunt a broken index.
    expect(learnings.reason).toContain("not requested");
  });

  it("an unknown layer name is reported and dropped, not silently ignored", async () => {
    await world({ fusion: true });
    const p = await json<Fused>(`/api/search?q=${Q}&layers=goals,candidates`);
    expect(
      p.params.some((n) => n.includes("candidates")),
      `params: ${JSON.stringify(p.params)}`,
    ).toBe(true);
    expect(p.layers.filter((l) => l.requested).map((l) => l.layer)).toEqual([
      "goals",
    ]);
  });
});
