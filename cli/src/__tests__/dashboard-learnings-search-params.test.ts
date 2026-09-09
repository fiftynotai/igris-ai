/**
 * BR-085 — **what `/api/learnings/search` actually FORWARDS.**
 *
 * THE DEFECT THIS FILE EXISTS TO MAKE IMPOSSIBLE
 * ----------------------------------------------
 * `learningsSearch` parsed `review_status`, allow-listed it, and then built its
 * reader options without it. Nothing was red: the parameter was present in the
 * handler, present in the filter spec, present in the URL the browser sent — and
 * absent from the only object that had any effect. Meanwhile `Learnings.tsx`
 * bannered "SHOWING PENDING REVIEW ROWS" over `approved` rows, because the
 * banner was sourced from the REQUEST.
 *
 * No test could see it. The endpoint suites assert the RESULT, and the result of
 * dropping a filter is a plausible list. So this file asserts the seam instead:
 * the reader is a RECORDER, and the assertions are about the options object it
 * was handed.
 *
 * WHY IT IS A SEPARATE FILE FROM `dashboard-learnings-search.test.ts`. That
 * suite drives the real HTTP server against the real vendored reader, which is
 * the right shape for its claims and the wrong one for these: `vi.mock` is
 * file-scoped, so mocking the bridge there would blind its bridge-capability
 * gates. It also cannot see this defect for a second reason worth stating —
 * `loadLayerReaders` imports the VENDORED bundle
 * (`cli/dist/brain-mcp-server/dist/`), which is a BUILD ARTIFACT and can predate
 * the reader source in this checkout. An end-to-end assertion that pending rows
 * come back would then be red for a stale artifact rather than a wrong handler.
 * The skew is a real state of this repo, so it is TESTED here (§ "the echo
 * governs") rather than assumed away.
 *
 * WHAT THIS FILE DOES NOT PROVE
 *  - That `hybridSearchLearnings` honours `review_status`. **Sibling:**
 *    `brain-mcp-server/src/tools/__tests__/memory-read.test.ts`, the BR-085
 *    block — both arms, the hydration gate, and the ranks.
 *  - That the browser renders the banner from the payload. **Sibling:** the
 *    `Learnings.tsx` view test.
 *
 * @module __tests__/dashboard-learnings-search-params.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Everything the fake reader saw, in call order. */
interface Recorded {
  opts: Record<string, unknown>;
}
const recorded: Recorded[] = [];

/**
 * What the fake reader ECHOES back as the applied scope.
 *
 * `undefined` models a read layer built before BR-085 — an object with no such
 * key. That is not a hypothetical: the vendored bundle is a build artifact and
 * `routes.ts` is source, so the two versions diverge on every checkout between
 * a source edit and a build.
 */
let echoScope: string | undefined = undefined;
/** Rows the fake reader returns. Empty by default — these tests are about opts. */
let echoRows: unknown[] = [];

vi.mock("../lib/brain-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/brain-bridge.js")>();
  return {
    ...actual,
    lastLayerReadersFailure: () => null,
    openBrainReadonlyWithVec: async () => ({
      db: { close: () => undefined },
      vector_available: true,
      vector_reason: null,
    }),
    loadLayerReaders: async () => ({
      hybridSearchLearnings: async (_db: unknown, opts: Record<string, unknown>) => {
        recorded.push({ opts });
        return {
          rows: echoRows,
          retrieval: {
            mode: "bm25_only",
            vector_available: true,
            embedding_available: false,
            bm25_hits: echoRows.length,
            vector_hits: 0,
            rrf_k: 60,
            weights: { bm25: 0.5, vector: 0.5 },
            reason: null,
          },
          // Spread, so `undefined` means the KEY IS ABSENT rather than present
          // and undefined — which is what an older bundle actually returns, and
          // the difference `routes.ts` has to survive.
          ...(echoScope === undefined ? {} : { review_status: echoScope }),
        };
      },
    }),
  };
});

import { learningsSearch } from "../lib/dashboard/routes.js";
import { LEARNING_FILTERS } from "../lib/dashboard/params.js";

let sandbox: string;
const prevBrain = process.env.IGRIS_BRAIN_DIR;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "igris-br085-"));
  mkdirSync(join(sandbox, "memory"), { recursive: true });
  // `brainPresent()` is an `existsSync` on this path and nothing here opens it —
  // the bridge is the mocked door.
  writeFileSync(join(sandbox, "memory", "knowledge.db"), "");
  process.env.IGRIS_BRAIN_DIR = sandbox;
  recorded.length = 0;
  echoScope = undefined;
  echoRows = [];
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  if (prevBrain === undefined) delete process.env.IGRIS_BRAIN_DIR;
  else process.env.IGRIS_BRAIN_DIR = prevBrain;
});

const call = (qs: string) => learningsSearch(new URLSearchParams(qs));

/** The one call's recorded options. Fails loudly if the reader never ran. */
function onlyOpts(): Record<string, unknown> {
  expect(recorded.length, "the reader was never called").toBe(1);
  return recorded[0].opts;
}

// ---------------------------------------------------------------------------
// The forwarded object
// ---------------------------------------------------------------------------

describe("BR-085 — the options object the handler builds", () => {
  it("FORWARDS review_status — the parameter this brief exists for", async () => {
    echoScope = "pending_review";
    await call("q=wrapper&review_status=pending_review");
    expect(onlyOpts().review_status).toBe("pending_review");
  });

  it("forwards the DEFAULT scope when none is asked for — never `undefined`", async () => {
    // An omitted key would let the reader's own default decide, which is the
    // same value TODAY and is not the point: the payload echo, the banner and
    // this option must all name ONE scope, and a handler that forwards nothing
    // has nothing to echo. `approved` on the wire is what makes the FR-109
    // channel an assertion rather than a coincidence of two defaults agreeing.
    echoScope = "approved";
    await call("q=wrapper");
    expect(onlyOpts().review_status).toBe("approved");
  });

  it("pins the WHOLE key set — a parameter that stops being forwarded fails here", async () => {
    // The blunt instrument, and the one that would have caught BR-085 on the
    // day it landed. `toEqual` on the key set (not `toMatchObject`) is
    // deliberate: a subset assertion is exactly what a dropped key survives.
    echoScope = "pending_review";
    await call("q=wrapper&project=demo&review_status=pending_review&limit=7");
    expect(Object.keys(onlyOpts()).sort()).toEqual([
      "limit",
      "project",
      "query",
      "review_status",
    ]);
    expect(onlyOpts()).toEqual({
      query: "wrapper",
      project: "demo",
      review_status: "pending_review",
      limit: 7,
    });
  });
});

// ---------------------------------------------------------------------------
// The CLASS, not the instance
// ---------------------------------------------------------------------------

describe("BR-085 as a class — parsed implies forwarded OR named", () => {
  /**
   * Wire name → the option key it must appear under. Kept here, independently
   * of `routes.ts`'s own map, so the two have to AGREE: a test that imported
   * the handler's map would pass whatever the handler decided to do.
   */
  const BOUND: ReadonlyMap<string, string> = new Map([
    ["project", "project"],
    ["review_status", "review_status"],
    ["q", "query"],
  ]);

  /** A value the allow-list accepts, per filter. */
  const SAMPLE: Record<string, string> = {
    project: "demo",
    category: "pattern",
    scope: "global",
    provenance: "inferred",
    review_status: "pending_review",
    q: "wrapper",
  };

  it("every allow-listed filter is either FORWARDED or NAMED — derived, not hand-listed", async () => {
    // Enumerated from `LEARNING_FILTERS` at runtime. A seventh learning filter
    // added to `params.ts` and forgotten here lands as a silent drop today; with
    // this loop it lands as a red test naming the parameter.
    const qs = new URLSearchParams();
    for (const spec of LEARNING_FILTERS) {
      const sample = SAMPLE[spec.name];
      expect(sample, `no sample value for filter ${spec.name}`).toBeDefined();
      qs.set(spec.name, sample);
    }
    echoScope = "pending_review";
    const payload = await call(qs.toString());
    const opts = onlyOpts();

    for (const spec of LEARNING_FILTERS) {
      const key = BOUND.get(spec.name);
      if (key !== undefined) {
        expect(
          opts[key],
          `${spec.name} is bound to opts.${key} but did not arrive`,
        ).toBe(SAMPLE[spec.name]);
        expect(
          payload.params.some((p) => p.startsWith(`${spec.name}: dropped`)),
          `${spec.name} was forwarded AND reported as dropped — one of the two is a lie`,
        ).toBe(false);
      } else {
        expect(
          payload.params.some((p) => p.startsWith(`${spec.name}: dropped`)),
          `${spec.name} was parsed, not forwarded, and not named — params=${JSON.stringify(payload.params)}`,
        ).toBe(true);
      }
    }
  });

  it("names the THREE unbindable learning filters, and only those", async () => {
    // The count matters: a loop that reported only the first would satisfy the
    // per-filter check above through its own `some()`.
    echoScope = "approved";
    const payload = await call(
      "q=wrapper&category=pattern&scope=global&provenance=inferred",
    );
    expect(payload.params.filter((p) => p.includes(": dropped")).sort()).toHaveLength(3);
    for (const name of ["category", "scope", "provenance"]) {
      expect(payload.params.some((p) => p.startsWith(`${name}: dropped`))).toBe(true);
    }
  });

  it("says nothing at all when every supplied parameter was honoured", async () => {
    // The self-negative-control. Without it, "every unbound filter is named" is
    // satisfiable by naming EVERY filter — including the ones that work, which
    // is a different lie told in the same banner.
    echoScope = "pending_review";
    const payload = await call("q=wrapper&project=demo&review_status=pending_review");
    expect(payload.params).toEqual([]);
  });

  it("names a dropped OFFSET — the same shape with a page control", async () => {
    // RRF over two arms has no stable offset semantics, so `?offset=20` cannot
    // be served and silently returning page one is BR-085 with a different
    // parameter.
    echoScope = "approved";
    const payload = await call("q=wrapper&offset=20");
    expect(payload.params.some((p) => p.startsWith("offset: dropped"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The echo, not the request
// ---------------------------------------------------------------------------

describe("BR-085 — the payload reports what was APPLIED", () => {
  it("echoes the reader's scope", async () => {
    echoScope = "pending_review";
    const payload = await call("q=wrapper&review_status=pending_review");
    expect(payload.review_status).toBe("pending_review");
  });

  it("REFUSES to claim the scope when the loaded reader has no review axis", async () => {
    // The stale-vendored-bundle case, which is BR-085's own defect wearing a
    // version number: the handler asks for pending, an older reader hard-gates
    // approved and says nothing, and the payload must NOT come back saying
    // `pending_review` — that is precisely the banner-over-wrong-rows state this
    // brief removes. It says `approved` (what those rows really are) and names
    // the mismatch so the operator can act on it.
    echoScope = undefined;
    const payload = await call("q=wrapper&review_status=pending_review");
    expect(payload.review_status).toBe("approved");
    expect(
      payload.params.some(
        (p) => p.startsWith("review_status: asked pending_review") && p.includes("applied approved"),
      ),
      `no skew note — params=${JSON.stringify(payload.params)}`,
    ).toBe(true);
  });

  it("says nothing when an older reader is asked for the DEFAULT scope", async () => {
    // The paired control: the skew note must fire on a DISAGREEMENT, not on the
    // absence of the key. An old reader asked for `approved` did apply
    // `approved`, so there is nothing to report and a note here would train the
    // operator to ignore the banner.
    echoScope = undefined;
    const payload = await call("q=wrapper");
    expect(payload.review_status).toBe("approved");
    expect(payload.params).toEqual([]);
  });

  it("claims NO scope on a degraded read — nothing was applied", async () => {
    // No rows were read, so no scope was applied and none may be claimed. The
    // banner keyed on this field must stay silent and let the DEGRADED banner
    // speak. An over-claim here is the empty-list flavour of the same defect.
    rmSync(join(sandbox, "memory"), { recursive: true, force: true });
    const payload = await call("q=wrapper&review_status=pending_review");
    expect(payload.degraded).not.toBeNull();
    expect(payload.review_status).toBe("approved");
    expect(recorded.length).toBe(0);
  });

  it("claims no scope when the query itself was refused", async () => {
    const payload = await call("review_status=pending_review");
    expect(payload.degraded?.reason).toContain("'q' is required");
    expect(payload.review_status).toBe("approved");
    expect(recorded.length).toBe(0);
  });
});
