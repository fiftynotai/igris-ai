/**
 * TD-338 — the CLI half of the brief-normalize mirror guard.
 *
 * `cli/src/lib/brief-normalize.generated.ts` is written by
 * `brain-mcp-server/scripts/gen-brief-normalize-mirror.ts`. The brain-side
 * parity test proves the committed artifact is byte-identical to a fresh
 * regeneration — i.e. the DATA (canonical sets + fold tables) is current.
 *
 * That is not enough on its own. The normalizer FUNCTION BODIES are authored in
 * the builder's template, so a change to the brain's `normalizePriority` LOGIC
 * is invisible to a byte-parity check. `NORMALIZE_FIXTURES` closes that gap:
 * the generator runs the BRAIN's real normalizers over a corpus at generation
 * time and bakes the input→output pairs into the artifact. This file replays
 * them through the CLI's copy — so the two packages are proven behaviourally
 * equivalent with ZERO cross-imports (coding_guidelines §13).
 *
 * If this fails, the brain's normalizer changed and the mirror's logic template
 * was not updated to match. Fix the template in
 * `brain-mcp-server/src/tools/brief-normalize-mirror.ts`, regenerate, re-run.
 */

import { describe, expect, it } from "vitest";

import {
  CANONICAL_PRIORITIES,
  NORMALIZE_FIXTURES,
  PREDICATE_FIXTURES,
  SYNC_NORMALIZED_FIELDS,
  SYNC_ROW_FIXTURES,
  isCanonicalBriefType,
  isCanonicalPhase,
  isCanonicalPriority,
  normalizeBriefType,
  normalizePhase,
  normalizePriority,
  normalizeSyncRow,
} from "../lib/brief-normalize.generated.js";

function applyByName(normalizer: string, input: string): string | null {
  switch (normalizer) {
    case "priority":
      return normalizePriority(input);
    case "brief_type":
      return normalizeBriefType(input);
    case "phase":
      return normalizePhase(input);
    default:
      throw new Error(`unknown normalizer id: ${normalizer}`);
  }
}

describe("TD-338 — the CLI mirror reproduces the BRAIN's normalizer behaviour", () => {
  it("has a non-trivial fixture corpus (a vacuous replay would prove nothing)", () => {
    expect(NORMALIZE_FIXTURES.length).toBeGreaterThan(50);
    // The corpus must contain at least one case of each outcome class, or a
    // green replay would not discriminate.
    const outcomes = NORMALIZE_FIXTURES.map((f) => ({
      folded: f.expected !== null && f.expected !== f.input,
      nulled: f.expected === null,
      passthrough: f.expected === f.input,
    }));
    expect(outcomes.some((o) => o.folded)).toBe(true);
    expect(outcomes.some((o) => o.nulled)).toBe(true);
    expect(outcomes.some((o) => o.passthrough)).toBe(true);
  });

  it("replays every fixture through the CLI copy", () => {
    for (const f of NORMALIZE_FIXTURES) {
      expect(
        applyByName(f.normalizer, f.input),
        `${f.normalizer}(${JSON.stringify(f.input)}) diverged from the brain`,
      ).toBe(f.expected);
    }
  });

  it("folds the exact bare forms the live VPS still holds", () => {
    expect(normalizePriority("P1")).toBe("P1-High");
    expect(normalizePriority("P2")).toBe("P2-Medium");
    expect(normalizeBriefType("TD")).toBe("Technical Debt");
    expect(normalizeBriefType("Tech Debt")).toBe("Technical Debt");
    expect(normalizePhase("building")).toBe("BUILDING");
  });

  it("never invents a value for an unknown", () => {
    // The reasoning TD-328 used to refuse folding `Spike`, applied to priority.
    expect(normalizePriority("P4-Trivial")).toBe("P4-Trivial");
    expect(normalizeBriefType("Spike")).toBe("Spike");
    expect(normalizeBriefType("Bug/Feature")).toBe("Bug/Feature");
  });

  it("maps the unset family to SQL NULL", () => {
    expect(normalizePriority("")).toBeNull();
    expect(normalizePriority("   ")).toBeNull();
    expect(normalizePriority("Unset")).toBeNull();
  });

  it("is idempotent — f(f(x)) === f(x)", () => {
    for (const f of NORMALIZE_FIXTURES) {
      if (f.expected === null) continue;
      expect(applyByName(f.normalizer, f.expected)).toBe(f.expected);
    }
  });

  it("exposes canonicality predicates that agree with the canonical sets", () => {
    for (const p of CANONICAL_PRIORITIES) expect(isCanonicalPriority(p)).toBe(true);
    expect(isCanonicalPriority("P4-Trivial")).toBe(false);
    expect(isCanonicalPriority(null)).toBe(false); // NULL is *unset*, not canonical
    expect(isCanonicalPhase("building")).toBe(true);
    expect(isCanonicalPhase("Deferred")).toBe(false);
    expect(isCanonicalBriefType("technical debt")).toBe(true);
    expect(isCanonicalBriefType("Spike")).toBe(false);
  });
});

describe("TD-338 — the mirrored isCanonical* predicates", () => {
  it("has a discriminating predicate corpus", () => {
    expect(PREDICATE_FIXTURES.length).toBeGreaterThan(50);
    expect(PREDICATE_FIXTURES.some((f) => f.expected === true)).toBe(true);
    expect(PREDICATE_FIXTURES.some((f) => f.expected === false)).toBe(true);
  });

  it("replays every predicate fixture through the CLI copy", () => {
    for (const f of PREDICATE_FIXTURES) {
      const actual =
        f.normalizer === "priority"
          ? isCanonicalPriority(f.input)
          : f.normalizer === "brief_type"
            ? isCanonicalBriefType(f.input)
            : isCanonicalPhase(f.input);
      expect(
        actual,
        `isCanonical(${f.normalizer}, ${JSON.stringify(f.input)}) diverged from the brain`,
      ).toBe(f.expected);
    }
  });
});

describe("TD-338 — the mirrored normalizeSyncRow", () => {
  // `normalizeSyncRow` is the function BOTH mergeRows copies call, and it is
  // authored template text in the builder — a brain-side edit to it regenerates
  // a byte-identical artifact, so the parity test cannot see it. These fixtures
  // are computed by running the BRAIN's real normalizeSyncRow at generation
  // time, which is the only thing that makes the mirror behavioural HERE.
  it("has a corpus that covers every outcome class (a vacuous replay proves nothing)", () => {
    expect(SYNC_ROW_FIXTURES.length).toBeGreaterThan(8);
    expect(SYNC_ROW_FIXTURES.some((f) => f.expectedFolds.length > 0)).toBe(true);
    expect(SYNC_ROW_FIXTURES.some((f) => f.expectedNonCanonical.length > 0)).toBe(true);
    expect(SYNC_ROW_FIXTURES.some((f) => f.expectedSameObject)).toBe(true);
    expect(SYNC_ROW_FIXTURES.some((f) => !f.expectedSameObject)).toBe(true);
    expect(SYNC_ROW_FIXTURES.some((f) => f.table !== "brief_status")).toBe(true);
  });

  it("carries a row whose updated_at is a FOLDABLE-LOOKING string", () => {
    // Without this the fold-plus-bump mutation is invisible: a timestamp-shaped
    // updated_at folds to itself, so the expectation would not move.
    const armed = SYNC_ROW_FIXTURES.filter(
      (f) => f.table === "brief_status" && f.row.updated_at === "P2",
    );
    expect(armed.length).toBeGreaterThan(0);
    // ...and the brain left every one of them alone.
    for (const f of armed) expect(f.expectedRow.updated_at).toBe("P2");
  });

  it("replays every row fixture through the CLI copy", () => {
    for (const f of SYNC_ROW_FIXTURES) {
      const label = `${f.table} ${JSON.stringify(f.row)}`;
      const out = normalizeSyncRow(f.table, f.row);
      expect(out.row, `stored row diverged from the brain for ${label}`).toEqual(f.expectedRow);
      expect(out.folds, `folds diverged from the brain for ${label}`).toEqual(f.expectedFolds);
      expect(
        out.nonCanonical,
        `nonCanonical diverged from the brain for ${label}`,
      ).toEqual(f.expectedNonCanonical);
      // Identity is contract (the allocation-light path), and invisible to a
      // value comparison.
      expect(out.row === f.row, `same-object identity diverged for ${label}`).toBe(
        f.expectedSameObject,
      );
    }
  });

  it("never mutates the inbound row", () => {
    for (const f of SYNC_ROW_FIXTURES) {
      const before = JSON.stringify(f.row);
      normalizeSyncRow(f.table, f.row);
      expect(JSON.stringify(f.row)).toBe(before);
    }
  });

  it("maps exactly the brief_status fields, and never updated_at", () => {
    expect(SYNC_NORMALIZED_FIELDS.brief_status).toEqual({
      brief_type: "brief_type",
      priority: "priority",
      phase: "phase",
    });
    expect(Object.keys(SYNC_NORMALIZED_FIELDS.brief_status)).not.toContain("updated_at");
  });
});
