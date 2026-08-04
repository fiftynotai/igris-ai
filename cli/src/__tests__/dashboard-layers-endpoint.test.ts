/**
 * FR-240 — the nine layer endpoints, over real HTTP.
 *
 * Nothing is mocked. The server binds a real loopback port, the brain is a real
 * SQLite file in a sandboxed `IGRIS_BRAIN_DIR`, and the readers are the REAL
 * compiled modules loaded out of the vendored bundle. That last part is the
 * point: a suite that stubbed the bridge would pass with the pure read layer
 * deleted.
 *
 * WHAT THESE GATES PROVE (G-EP-1 / G-EP-2 / G-EP-3)
 * ------------------------------------------------
 *  - Filters NARROW, and narrow correctly — every filter test asserts the
 *    EXCLUDED ids as well as the included ones, over a fixture where no two
 *    filter values select the same rows. A filter test that only asserts
 *    inclusions passes with the WHERE clause deleted.
 *  - `(type, project, id)` addressing holds at the wire: `BR-001` in two
 *    projects returns two different bodies, and an id without a project is a
 *    stated refusal rather than a silent first-match.
 *  - Every endpoint inherits the FR-238 degraded contract on four brain shapes.
 *
 * WHAT THEY DO NOT PROVE
 * ----------------------
 *  - That nothing was WRITTEN. **Sibling:** `dashboard-readonly.test.ts`.
 *  - That the search used hybrid recall. **Sibling:**
 *    `dashboard-learnings-search.test.ts`.
 *  - That the BROWSER wires the controls to these endpoints — a claim no
 *    server-side test can make. **Sibling:** the FR-240 Phase-5 CDP gates.
 *
 * @module __tests__/dashboard-layers-endpoint.test
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { get as httpGet } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb as closeBrainDb } from "../lib/brain-db.js";
import { closeDb as closeRegistryDb } from "../lib/registry.js";
import { resetBrainBridge, resetLayerReaders } from "../lib/brain-bridge.js";
import { startServer, type DashboardServer } from "../lib/dashboard/server.js";
import { FIXTURE, LAYER_PATHS, seedLayerBrain } from "./dashboard-layers-fixture.js";
import {
  armHermeticEmbeddings,
  bundleStaged,
  type HermeticState,
} from "./hermetic-embeddings.js";

/**
 * HERMETIC — `LAYER_PATHS` includes `/api/learnings/search`, whose reader embeds
 * the query before it can reach the vector arm, so without this guard the suite
 * downloads ~90 MB from the HF Hub on any freshly built tree. Found during the
 * FR-240 warden pass. See `hermetic-embeddings.ts#armHermeticEmbeddings`.
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
  // The degraded contract is 200-always. A non-200 from an /api/ path that
  // exists is itself the failure this assertion catches.
  expect(r.status, `${path} -> ${r.status}: ${r.body.slice(0, 200)}`).toBe(200);
  return JSON.parse(r.body) as T;
}

async function start(): Promise<void> {
  srv = await startServer({ port: 0, cliVersion: "test" });
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "igris-fr240-ep-"));
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

function seed(): void {
  seedLayerBrain(join(sandbox, "memory", "knowledge.db"));
}

interface ListEnvelope<T> {
  items: T[];
  count: number;
  total: number;
  limit: number;
  offset: number;
  params: string[];
  degraded: { reason: string } | null;
}

// ---------------------------------------------------------------------------
// Sanity: the readers really did load
// ---------------------------------------------------------------------------

describe("the pure read layer resolves from the vendored bundle", () => {
  it("the crawl is HERMETIC — no endpoint here can reach the HuggingFace Hub", () => {
    // Self-negative-control for this file's own setup. `LAYER_PATHS` includes
    // the search path, so a red here means the suite is downloading a ~90 MB
    // model into a build artifact that two parallel workers can corrupt.
    expect(bundleStaged(), "run `npm run build` in cli/ before this suite").toBe(
      true,
    );
    expect(
      hermetic.armed,
      `remote model fetch is NOT blocked: ${hermetic.reason ?? "unknown"}`,
    ).toBe(true);
  });

  it("a populated brain returns rows, not a degraded envelope", async () => {
    seed();
    await start();
    const r = await json<ListEnvelope<unknown>>("/api/briefs");
    // If `loadLayerReaders()` had failed, this would be a degraded envelope with
    // zero rows — a state indistinguishable from "the brain is empty" unless
    // asserted. Naming it here makes a packaging regression loud.
    expect(r.degraded, `readers unavailable: ${r.degraded?.reason ?? ""}`).toBeNull();
    expect(r.count).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Briefs
// ---------------------------------------------------------------------------

interface BriefRow {
  project: string;
  brief_id: string;
  brief_type: string | null;
  status: string;
  priority: string | null;
  effort: string | null;
  title: string;
}

const briefKeys = (r: ListEnvelope<BriefRow>): string[] =>
  r.items.map((b) => `${b.project}/${b.brief_id}`);

describe("GET /api/briefs", () => {
  beforeEach(async () => {
    seed();
    await start();
  });

  it("returns all briefs newest-first with a full envelope", async () => {
    const r = await json<ListEnvelope<BriefRow>>("/api/briefs");
    expect(briefKeys(r)).toEqual([
      "demo/FR-240",
      "demo/TD-312",
      "demo/BR-001",
      "other/BR-001",
    ]);
    expect(r.count).toBe(4);
    expect(r.total).toBe(4);
    expect(r.limit).toBe(50);
    expect(r.offset).toBe(0);
    expect(r.params).toEqual([]);
  });

  it("D7 — list rows carry NO body content", async () => {
    const r = await json<ListEnvelope<Record<string, unknown>>>("/api/briefs");
    for (const row of r.items) {
      expect(Object.keys(row)).not.toContain("content");
    }
  });

  it("project narrows, and the excluded rows are gone", async () => {
    const r = await json<ListEnvelope<BriefRow>>("/api/briefs?project=other");
    expect(briefKeys(r)).toEqual(["other/BR-001"]);
    expect(briefKeys(r)).not.toContain("demo/BR-001");
    expect(r.total).toBe(1);
  });

  it("status narrows", async () => {
    const r = await json<ListEnvelope<BriefRow>>("/api/briefs?status=Pending");
    expect(briefKeys(r)).toEqual(["demo/TD-312", "other/BR-001"]);
    expect(briefKeys(r)).not.toContain("demo/FR-240");
  });

  it("priority narrows", async () => {
    const r = await json<ListEnvelope<BriefRow>>("/api/briefs?priority=P1-High");
    expect(briefKeys(r)).toEqual(["demo/FR-240", "demo/BR-001"]);
    expect(briefKeys(r)).not.toContain("demo/TD-312");
  });

  it("effort narrows — the filter FR-240 added", async () => {
    const r = await json<ListEnvelope<BriefRow>>("/api/briefs?effort=S");
    expect(briefKeys(r)).toEqual(["demo/TD-312", "other/BR-001"]);
    // Discriminating: a no-op `effort` filter would return all four.
    expect(r.count).toBe(2);
  });

  it("brief_type narrows", async () => {
    const r = await json<ListEnvelope<BriefRow>>("/api/briefs?brief_type=bug");
    expect(briefKeys(r)).toEqual(["demo/BR-001", "other/BR-001"]);
  });

  it("filters compose and `total` respects them", async () => {
    const r = await json<ListEnvelope<BriefRow>>(
      "/api/briefs?project=demo&priority=P1-High&effort=XL",
    );
    expect(briefKeys(r)).toEqual(["demo/FR-240"]);
    expect(r.total).toBe(1);
  });

  it("paginates without repeating or losing rows", async () => {
    const p1 = await json<ListEnvelope<BriefRow>>("/api/briefs?limit=2&offset=0");
    const p2 = await json<ListEnvelope<BriefRow>>("/api/briefs?limit=2&offset=2");
    expect(briefKeys(p1)).toEqual(["demo/FR-240", "demo/TD-312"]);
    expect(briefKeys(p2)).toEqual(["demo/BR-001", "other/BR-001"]);
    expect(p1.total).toBe(4);
    expect(p2.total).toBe(4);
  });

  it("clamps a hostile limit and REPORTS it in params, still 200", async () => {
    const r = await json<ListEnvelope<BriefRow>>("/api/briefs?limit=999999");
    expect(r.limit).toBe(200);
    expect(r.params.join(" ")).toContain("clamped down to 200");
    expect(r.degraded).toBeNull();
  });

  it("names an unknown filter instead of ignoring it", async () => {
    const r = await json<ListEnvelope<BriefRow>>("/api/briefs?prioritee=P1-High");
    // Silently returning everything for a typo'd filter is the failure this
    // catches — the caller thinks they filtered.
    expect(r.params).toContain("unknown filter: prioritee");
    expect(r.count).toBe(4);
  });
});

describe("GET /api/brief — G-EP-2, the BR-078 composite key", () => {
  beforeEach(async () => {
    seed();
    await start();
  });

  it("the SAME brief_id in two projects returns two DIFFERENT bodies", async () => {
    const a = await json<{ brief: { title: string; project: string } | null }>(
      "/api/brief?project=demo&id=BR-001",
    );
    const b = await json<{ brief: { title: string; project: string } | null }>(
      "/api/brief?project=other&id=BR-001",
    );
    expect(a.brief?.title).toBe("Demo-project bug");
    expect(b.brief?.title).toBe("Other-project bug");
    expect(a.brief?.title).not.toBe(b.brief?.title);
  });

  it("omitting `project` REFUSES — never a silent first-match", async () => {
    const r = await json<{ brief: unknown; degraded: { reason: string } | null }>(
      "/api/brief?id=BR-001",
    );
    expect(r.brief).toBeNull();
    expect(r.degraded?.reason).toContain("both 'project' and 'id' are required");
    // The refusal must NAME the reason. Returning `demo`'s BR-001 here is the
    // exact defect BR-078 records.
    expect(r.degraded?.reason).toContain("BR-078");
  });

  it("omitting `id` refuses too", async () => {
    const r = await json<{ degraded: { reason: string } | null }>(
      "/api/brief?project=demo",
    );
    expect(r.degraded?.reason).toContain("required");
  });

  it("serves the body on the JOIN path", async () => {
    const r = await json<{ brief: { content: string; filename: string } | null }>(
      "/api/brief?project=demo&id=FR-240",
    );
    expect(r.brief?.content).toContain("Mount four read-only browse views");
    expect(r.brief?.filename).toBe("FR-240.md");
  });

  it("serves metadata with a null body when no brief_files row exists", async () => {
    const r = await json<{ brief: { content: string | null; title: string } | null }>(
      "/api/brief?project=demo&id=TD-312",
    );
    expect(r.brief?.content).toBeNull();
    expect(r.brief?.title).toBe("CI does not run brain vitest");
  });

  it("a missing brief degrades with a reason, not a 404", async () => {
    const r = await json<{ brief: unknown; degraded: { reason: string } | null }>(
      "/api/brief?project=demo&id=NOPE-9",
    );
    expect(r.brief).toBeNull();
    expect(r.degraded?.reason).toContain("brief not found: NOPE-9");
  });
});

// ---------------------------------------------------------------------------
// Learnings
// ---------------------------------------------------------------------------

interface LearningRow {
  id: number;
  project: string;
  category: string;
  scope: string;
  provenance: string;
  review_status: string;
  content_length: number;
}

const learningIds = (r: ListEnvelope<LearningRow>): number[] => r.items.map((l) => l.id);

describe("GET /api/learnings", () => {
  beforeEach(async () => {
    seed();
    await start();
  });

  it("D9 — defaults to approved rows and echoes the filter", async () => {
    const r = await json<ListEnvelope<LearningRow> & { review_status: string }>(
      "/api/learnings",
    );
    expect(r.review_status).toBe("approved");
    expect(learningIds(r)).toEqual([3, 2, 1]);
    // The pending row must NOT be in the default view. FR-109 gates the model's
    // conscious channel; D9 makes the operator's lens default to the same set.
    expect(learningIds(r)).not.toContain(4);
  });

  it("pending_review rows are reachable ONLY when asked for", async () => {
    const r = await json<ListEnvelope<LearningRow> & { review_status: string }>(
      "/api/learnings?review_status=pending_review",
    );
    expect(r.review_status).toBe("pending_review");
    expect(learningIds(r)).toEqual([4]);
    expect(learningIds(r)).not.toContain(1);
  });

  it("D7 — list rows carry no content, only content_length", async () => {
    const r = await json<ListEnvelope<Record<string, unknown>>>("/api/learnings");
    for (const row of r.items) {
      expect(Object.keys(row)).not.toContain("content");
      expect(typeof row.content_length).toBe("number");
      expect(row.content_length as number).toBeGreaterThan(0);
    }
  });

  it("project / category / scope / provenance each narrow", async () => {
    expect(
      learningIds(await json<ListEnvelope<LearningRow>>("/api/learnings?project=other")),
    ).toEqual([3]);
    expect(
      learningIds(
        await json<ListEnvelope<LearningRow>>("/api/learnings?category=mistake"),
      ),
    ).toEqual([2]);
    expect(
      learningIds(await json<ListEnvelope<LearningRow>>("/api/learnings?scope=global")),
    ).toEqual([1]);
    expect(
      learningIds(
        await json<ListEnvelope<LearningRow>>("/api/learnings?provenance=inferred"),
      ),
    ).toEqual([2]);
  });

  it("a non-allowlisted filter value is DROPPED and named, never bound", async () => {
    const r = await json<ListEnvelope<LearningRow>>("/api/learnings?category=poem");
    expect(r.params.join(" ")).toContain('category: "poem" is not one of');
    // Dropped means the query ran unfiltered — 3 approved rows, not 0.
    expect(r.count).toBe(3);
  });
});

describe("GET /api/learning", () => {
  beforeEach(async () => {
    seed();
    await start();
  });

  it("serves the full body (G-BR-5's server-side half: prove ACCESS)", async () => {
    const r = await json<{ learning: { id: number; content: string } | null }>(
      "/api/learning?id=1",
    );
    expect(r.learning?.id).toBe(1);
    expect(r.learning?.content).toBe(
      "The MCP handler becomes a thin wrapper over the pure reader.",
    );
  });

  it("refuses a non-integer id", async () => {
    const r = await json<{ degraded: { reason: string } | null }>(
      "/api/learning?id=abc",
    );
    expect(r.degraded?.reason).toContain("positive integer");
  });

  it("a missing learning degrades with a reason", async () => {
    const r = await json<{ learning: unknown; degraded: { reason: string } | null }>(
      "/api/learning?id=9999",
    );
    expect(r.learning).toBeNull();
    expect(r.degraded?.reason).toContain("learning not found: 9999");
  });
});

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

interface GoalRow {
  goal_id: string;
  status: string;
  deadline: string | null;
  serving_briefs_count: number;
}

const goalIds = (r: ListEnvelope<GoalRow>): string[] => r.items.map((g) => g.goal_id);

describe("GET /api/goals", () => {
  beforeEach(async () => {
    seed();
    await start();
  });

  it("orders deadline ASC with NULLS LAST", async () => {
    const r = await json<ListEnvelope<GoalRow>>("/api/goals");
    expect(goalIds(r)).toEqual(["GL-003", "GL-001", "GL-002"]);
    // SQLite's default `ORDER BY deadline ASC` sorts NULL FIRST, so a leading
    // GL-002 is exactly the regression this pins.
    expect(goalIds(r)[0]).not.toBe("GL-002");
  });

  it("serving_briefs_count excludes soft-deleted edges", async () => {
    const r = await json<ListEnvelope<GoalRow>>("/api/goals");
    const gl1 = r.items.find((g) => g.goal_id === "GL-001");
    // GL-001 has TWO brief edges; one is soft-deleted. A fixture where both
    // were live could not tell the two apart.
    expect(gl1?.serving_briefs_count).toBe(1);
  });

  it("project and status narrow", async () => {
    expect(goalIds(await json<ListEnvelope<GoalRow>>("/api/goals?project=other"))).toEqual([
      "GL-003",
    ]);
    const active = await json<ListEnvelope<GoalRow>>("/api/goals?status=active");
    expect(goalIds(active)).toEqual(["GL-001", "GL-002"]);
    expect(goalIds(active)).not.toContain("GL-003");
  });

  it("a non-allowlisted status is dropped and named", async () => {
    const r = await json<ListEnvelope<GoalRow>>("/api/goals?status=in_progress");
    expect(r.params.join(" ")).toContain('status: "in_progress" is not one of');
    expect(r.count).toBe(3);
  });

  it("upcoming_days narrows to deadlined active goals", async () => {
    const r = await json<ListEnvelope<GoalRow>>("/api/goals?upcoming_days=100000");
    expect(goalIds(r)).toEqual(["GL-001"]);
    // GL-002 has no deadline; GL-003 is achieved. Both must be gone.
    expect(goalIds(r)).not.toContain("GL-002");
    expect(goalIds(r)).not.toContain("GL-003");
  });

  it("a negative upcoming_days is reported, not bound", async () => {
    const r = await json<ListEnvelope<GoalRow>>("/api/goals?upcoming_days=-3");
    expect(r.params.join(" ")).toContain("non-negative");
    expect(r.count).toBe(3);
  });
});

describe("GET /api/goal", () => {
  beforeEach(async () => {
    seed();
    await start();
  });

  it("returns the goal plus its LIVE serving briefs and learning count", async () => {
    const r = await json<{
      goal: { goal_id: string } | null;
      serving_briefs: { brief_id: string }[];
      serving_learnings_count: number;
    }>("/api/goal?id=GL-001");
    expect(r.goal?.goal_id).toBe("GL-001");
    expect(r.serving_briefs.map((b) => b.brief_id)).toEqual(["FR-240"]);
    expect(r.serving_briefs.map((b) => b.brief_id)).not.toContain("TD-312");
    expect(r.serving_learnings_count).toBe(1);
  });

  it("takes NO project — goal ids are globally unique, unlike brief ids", async () => {
    // The asymmetry with `/api/brief` is deliberate and is the BR-078
    // distinction: `GL-XXX` is a brain-allocated global sequence.
    const r = await json<{ goal: { project_slug: string } | null }>(
      "/api/goal?id=GL-003",
    );
    expect(r.goal?.project_slug).toBe("other");
  });

  it("a missing goal degrades with a reason", async () => {
    const r = await json<{ goal: unknown; degraded: { reason: string } | null }>(
      "/api/goal?id=GL-999",
    );
    expect(r.goal).toBeNull();
    expect(r.degraded?.reason).toContain("goal not found: GL-999");
  });
});

// ---------------------------------------------------------------------------
// G-EP-4 — TD-326: the project axis has THREE states on /api/suggestions
// ---------------------------------------------------------------------------

/**
 * TD-326 — the project-less population, over the REAL vendored reader.
 *
 * THE VACUOUS GATE THIS BRIEF NAMES is a test that passes because there
 * happened to be zero project-less rows. So the first test here asserts the
 * population is NON-EMPTY through the endpoint itself, and every later
 * assertion is a number that could not be produced by an empty one.
 *
 * The fixture's project-less rows are `dashboard-layers-fixture.ts`'s three:
 * two `edge_inference` and one `janitor`, all pending, all `project_slug NULL`.
 *
 * PROVES: the endpoint can COUNT the hidden population from inside a project
 * scope, can LIST it as its own population, refuses to intersect the two
 * scopes, and that no OTHER endpoint silently accepts `project_scope`.
 * DOES NOT PROVE: that the UI surfaces any of it — that is the browser gate
 * (G-BR-10) and `Triage.tsx`.
 */
describe("G-EP-4 — TD-326: brain-level scope on /api/suggestions", () => {
  interface SuggestionsEnvelope extends ListEnvelope<{
    id: number;
    project_slug: string | null;
    source_module: string;
    title: string;
  }> {
    facets: { source_module: Record<string, number>; brain_level: number };
  }

  beforeEach(async () => {
    seed();
    await start();
  });

  it("the population is NON-EMPTY — the reading every assertion below rests on", async () => {
    const all = await json<SuggestionsEnvelope>("/api/suggestions?status=pending");
    const projectLess = all.items.filter((s) => s.project_slug === null);
    expect(
      projectLess.length,
      "the fixture seeds no project-less row — every gate below would be vacuous",
    ).toBe(FIXTURE.suggestions.brainLevelPendingCount);
    expect(all.total).toBe(FIXTURE.suggestions.pendingCount);
  });

  it("scoped to a project: the rows are ABSENT and the count is PRESENT", async () => {
    // The defect, and the fix, in one payload. `demo` cannot list them...
    const scoped = await json<SuggestionsEnvelope>(
      "/api/suggestions?project=demo&status=pending",
    );
    expect(scoped.total).toBe(FIXTURE.suggestions.demoPendingCount);
    expect(scoped.items.some((s) => s.project_slug === null)).toBe(false);
    // ...and now says how many it cannot list.
    expect(scoped.facets.brain_level).toBe(
      FIXTURE.suggestions.brainLevelPendingCount,
    );
    // The count is NOT the same number as the unscoped total, which is the
    // reading a "just banner the all-projects total" implementation would give.
    expect(scoped.facets.brain_level).not.toBe(FIXTURE.suggestions.pendingCount);
  });

  it("project_scope=brain-level lists EXACTLY the project-less rows", async () => {
    const r = await json<SuggestionsEnvelope>(
      "/api/suggestions?project_scope=brain-level&status=pending",
    );
    expect(r.total).toBe(FIXTURE.suggestions.brainLevelPendingCount);
    expect(r.count).toBe(FIXTURE.suggestions.brainLevelPendingCount);
    // EVERY row, not a sample.
    expect(r.items.every((s) => s.project_slug === null)).toBe(true);
    expect(r.params).toEqual([]);
    // Under this scope the facet IS the total — the stated identity.
    expect(r.facets.brain_level).toBe(r.total);
  });

  it("`brain-level` and the unscoped read are DIFFERENT sets, by exactly 3", async () => {
    // The vocabulary error TD-326 exists to prevent, asserted as a number.
    // `everything` drops the predicate; `brain-level` is `project IS NULL`.
    const everything = await json<SuggestionsEnvelope>("/api/suggestions?status=pending");
    const brain = await json<SuggestionsEnvelope>(
      "/api/suggestions?project_scope=brain-level&status=pending",
    );
    expect(everything.total - brain.total).toBe(
      FIXTURE.suggestions.pendingCount - FIXTURE.suggestions.brainLevelPendingCount,
    );
    expect(everything.total).toBeGreaterThan(brain.total);
  });

  it("the other filters still narrow it, and the facet follows them", async () => {
    const r = await json<SuggestionsEnvelope>(
      "/api/suggestions?project_scope=brain-level&status=pending&source_module=edge_inference",
    );
    expect(r.total).toBe(FIXTURE.suggestions.brainLevelEdgeInferenceCount);
    // Discriminating: an ignored `source_module` would return all three.
    expect(r.total).toBeLessThan(FIXTURE.suggestions.brainLevelPendingCount);
    // ...and the same narrowing applies to the facet from inside a project.
    const scoped = await json<SuggestionsEnvelope>(
      "/api/suggestions?project=demo&status=pending&source_module=edge_inference",
    );
    expect(scoped.facets.brain_level).toBe(
      FIXTURE.suggestions.brainLevelEdgeInferenceCount,
    );
  });

  it("both scopes at once: `project` is DROPPED and NAMED, never intersected", async () => {
    // The intersection is empty by definition. Silently returning zero rows is
    // the failure mode `params` exists to make impossible.
    const r = await json<SuggestionsEnvelope>(
      "/api/suggestions?project=demo&project_scope=brain-level&status=pending",
    );
    expect(r.total).toBe(FIXTURE.suggestions.brainLevelPendingCount);
    expect(r.params.join(" · ")).toContain("project: dropped");
    expect(r.params.join(" · ")).toContain("belong to NO project");
  });

  it("an unknown project_scope VALUE is dropped and named, not bound", async () => {
    const r = await json<SuggestionsEnvelope>(
      "/api/suggestions?project_scope=everything&status=pending",
    );
    // Dropped -> the read is unscoped, and the operator is told why.
    expect(r.total).toBe(FIXTURE.suggestions.pendingCount);
    expect(r.params.join(" · ")).toContain('project_scope: "everything" is not one of');
  });

  it("NO OTHER endpoint HONOURS project_scope; the parseFilters ones report it", async () => {
    // The reason `project_scope` is its own param rather than a magic `project`
    // value: `project`'s spec accepts any string, so a sentinel there would be
    // bound verbatim by every other project-bearing endpoint and match nothing,
    // silently. As an UNDECLARED param it is instead dropped, and REPORTED by the
    // 4 of the 10 others that route through `parseFilters` (this test drives 3 of
    // those 4); the other 6 hand-parse or take `project` as an argument and are
    // silent — an ignore, never a bind. The safety does not depend on the
    // reporting being total.
    for (const path of [
      "/api/briefs?project_scope=brain-level",
      "/api/learnings?project_scope=brain-level",
      "/api/goals?project_scope=brain-level",
    ]) {
      const r = await json<ListEnvelope<unknown>>(path);
      expect(r.params, path).toContain("unknown filter: project_scope");
      // ...and the read is NOT narrowed by it.
      expect(r.total, path).toBeGreaterThan(0);
    }
  });

  it("SELF-NEGATIVE-CONTROL — the endpoint really can report brain_level 0", async () => {
    // Every assertion above is a non-zero count, which a facet hard-wired to
    // `total` would also produce. A filter that excludes every project-less row
    // must drive it to zero.
    const r = await json<SuggestionsEnvelope>(
      "/api/suggestions?project=demo&status=pending&source_module=gap",
    );
    expect(r.total).toBeGreaterThan(0);
    expect(r.facets.brain_level).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// G-EP-3 — the degraded contract, four brain shapes
// ---------------------------------------------------------------------------

/**
 * The generous timeouts in this block are not padding. `LAYER_PATHS` includes
 * `/api/learnings/search`, and the FIRST such request in a worker process either
 * loads a ~90 MB MiniLM ONNX model or spends its time discovering it cannot.
 * Both are legitimate production states — `EmbeddingsUnavailableError` latches,
 * so only the first call pays — and the search path must stay INSIDE the
 * degraded crawl: excluding the most complex reader from the contract gate would
 * be exactly the coverage hole this block exists to close.
 */
describe("G-EP-3 — every layer endpoint inherits the FR-238 degraded contract", () => {
  async function expectAllDegradeCleanly(): Promise<void> {
    for (const path of LAYER_PATHS) {
      const r = await req(path);
      expect(r.status, `${path} must answer 200`).toBe(200);
      const body = JSON.parse(r.body) as Record<string, unknown>;
      // Never a stack trace. A leaked `at Object.<anonymous>` is the shape this
      // catches — it means an exception escaped into the response.
      expect(r.body, `${path} leaked a stack trace`).not.toMatch(/\n\s+at /);
      expect(body, `${path} has no degraded field`).toHaveProperty("degraded");
    }
  }

  it("T1 — brain file absent", { timeout: 180_000 }, async () => {
    await start();
    await expectAllDegradeCleanly();
    const r = await json<ListEnvelope<BriefRow>>("/api/briefs");
    expect(r.degraded?.reason).toContain("brain database not found");
    expect(r.items).toEqual([]);
  });

  it("T2 — brain file present but EMPTY (zero bytes)", { timeout: 180_000 }, async () => {
    mkdirSync(join(sandbox, "memory"), { recursive: true });
    writeFileSync(join(sandbox, "memory", "knowledge.db"), "");
    await start();
    await expectAllDegradeCleanly();
  });

  it("T3 — brain present with NO tables (the L-133 case)", { timeout: 180_000 }, async () => {
    mkdirSync(join(sandbox, "memory"), { recursive: true });
    const db = new Database(join(sandbox, "memory", "knowledge.db"));
    db.exec("CREATE TABLE placeholder (a INT);");
    db.close();
    await start();
    await expectAllDegradeCleanly();

    // `listLearnings` carries its own L-133 preflight, so the learnings list
    // degrades with a NAMED table rather than a raw SQLite error.
    const r = await json<ListEnvelope<LearningRow>>("/api/learnings");
    expect(r.degraded?.reason).toContain("learnings");
    expect(r.items).toEqual([]);
  });

  it("T4 — a corrupt brain file", { timeout: 180_000 }, async () => {
    mkdirSync(join(sandbox, "memory"), { recursive: true });
    writeFileSync(join(sandbox, "memory", "knowledge.db"), "this is not a sqlite file");
    await start();
    await expectAllDegradeCleanly();
  });

  it("an unknown /api/ path still 404s — the layer routes did not swallow it", async () => {
    seed();
    await start();
    const r = await req("/api/learnings/nope");
    expect(r.status).toBe(404);
  });

  it("/api/learnings/search is NOT shadowed by /api/learnings", async () => {
    seed();
    await start();
    const r = await json<{ query: string; retrieval: { mode: string } }>(
      "/api/learnings/search?q=wrapper",
    );
    // Exact-match routing: if `/api/learnings` matched by prefix, this would
    // return a list envelope with no `query` field.
    expect(r.query).toBe("wrapper");
    expect(r.retrieval).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// FR-246 — the four `q` SUBSTRING surfaces
// ---------------------------------------------------------------------------

/**
 * These four are NOT retrieval, and the test's job is to prove they SAY so.
 *
 * The brief's named trap is four `filter(includes)` boxes shipping alongside
 * one real hybrid search and looking identical. The defence is a PAYLOAD field
 * (`search.mode`) rather than a sentence in the UI, because a sentence in the
 * UI is a claim no gate can check. So every case below asserts both halves: the
 * filter narrowed the list, AND the payload admits how.
 */
describe("FR-246 — the `q` substring surfaces declare their own mode", () => {
  interface WithSearch {
    items: unknown[];
    total?: number;
    search: { mode: string; fields: string[] } | null;
    degraded: { reason: string } | null;
  }

  beforeEach(async () => {
    seed();
    await start();
  });

  it("/api/goals?q= filters and reports substring over title+description", async () => {
    const all = await json<WithSearch>("/api/goals");
    const filtered = await json<WithSearch>("/api/goals?q=lens");
    expect(filtered.items.length).toBeLessThan(all.items.length);
    expect(filtered.items.length).toBeGreaterThan(0);
    expect(filtered.search).toEqual({ mode: "substring", fields: ["title", "description"] });
    // No `q` means no claim at all — distinguishable from "searched, matched
    // everything", which is what an always-present block would say.
    expect(all.search).toBeNull();
  });

  it("/api/suggestions?q= filters and reports substring over title+evidence", async () => {
    const all = await json<WithSearch>("/api/suggestions");
    const filtered = await json<WithSearch>("/api/suggestions?q=gap");
    // STRICTLY less, matching the goals case above. `toBeLessThanOrEqual` was
    // the first form and it is satisfied by a `q` that filtered NOTHING —
    // which is the precise failure this whole block exists to catch.
    expect(all.items.length).toBeGreaterThan(0);
    expect(filtered.items.length).toBeGreaterThan(0);
    expect(filtered.items.length).toBeLessThan(all.items.length);
    expect(filtered.search).toEqual({ mode: "substring", fields: ["title", "evidence"] });
    expect(all.search).toBeNull();
  });

  it("/api/suggestions?q= matches EVIDENCE, not only the title", async () => {
    // `gap` appears in two rows' `evidence` JSON and in NO row's title, so the
    // hit is attributable to the second column rather than to the first.
    const all = await json<WithSearch & { items: { title: string }[] }>("/api/suggestions");
    expect(all.items.every((i) => !i.title.toLowerCase().includes("gap"))).toBe(true);
    const filtered = await json<WithSearch>("/api/suggestions?q=gap");
    expect(filtered.items.length).toBeGreaterThan(0);
  });

  it("/api/learnings?q= filters the CANDIDATES browse, including pending rows", async () => {
    // The D3 argument, driven — with its premise RETIRED by BR-085. It used to
    // read "`hybridSearchLearnings` structurally cannot return a
    // `pending_review` row (FR-109 gates both arms)"; that gate is now a
    // PARAMETER defaulting to `approved`, so recall can. The surviving half of
    // D3 is the one that still holds: the triage queue wants a substring
    // FILTER over the whole pending set, not ranked recall over part of it —
    // different shapes for different jobs. Here it gets the filter.
    const pending = await json<WithSearch>(
      "/api/learnings?review_status=pending_review&q=wrapper",
    );
    expect(pending.items.length).toBeGreaterThan(0);
    expect(pending.search).toEqual({ mode: "substring", fields: ["title", "content"] });
  });

  it("/api/context-docs?q= greps BODIES and says `body`, not a column name", async () => {
    const r = await json<
      WithSearch & { docs: { type: string; matches?: { line: number; snippet: string }[] }[] }
    >("/api/context-docs?project=demo&q=zzzznomatchterm");
    // The sandbox may or may not have doc files; either way the CLAIM is the
    // assertable part, and it must name `body` rather than a column — there is
    // no table here at all.
    expect(r.search).toEqual({ mode: "substring", fields: ["body"] });
  });

  it("a substring surface NEVER emits a retrieval block — that is the trap", async () => {
    // The server-side twin of `G-BR-13b`. A `retrieval` key on one of these
    // payloads is exactly how a filter starts being read as recall.
    for (const path of [
      "/api/goals?q=lens",
      "/api/suggestions?q=gap",
      "/api/learnings?q=wrapper",
      "/api/context-docs?project=demo&q=guideline",
    ]) {
      const body = await json<Record<string, unknown>>(path);
      expect(
        Object.prototype.hasOwnProperty.call(body, "retrieval"),
        `${path} must not carry a retrieval block`,
      ).toBe(false);
      expect((body.search as { mode: string }).mode).toBe("substring");
    }
    // ...and the SELF-NEGATIVE-CONTROL: the one surface that IS retrieval does
    // carry it, and carries no `search` block. Without this pair the assertion
    // above is satisfied by a payload with neither field.
    const real = await json<Record<string, unknown>>("/api/briefs/search?q=dashboard");
    expect(Object.prototype.hasOwnProperty.call(real, "retrieval")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(real, "search")).toBe(false);
  });

  it("`?q=%` does not match everything — the LIKE wildcard is escaped end to end", async () => {
    // The whole-stack form of the reader-level case: a filter that silently
    // matches every row is worse than one that errors, because the operator
    // reads the full list as a result.
    const all = await json<WithSearch>("/api/goals");
    const pct = await json<WithSearch>("/api/goals?q=%25");
    expect(all.items.length).toBeGreaterThan(0);
    expect(pct.items.length).toBe(0);
  });
});
