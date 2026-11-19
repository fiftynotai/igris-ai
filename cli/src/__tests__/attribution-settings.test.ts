/**
 * attribution-settings.test.ts — TD-470.
 *
 * `applyAttributionDefault` is the pure rule the global settings writer
 * composes after the hooks merge: Claude Code's `attribution` is set to the
 * object form `{ commit: "", pr: "", sessionUrl: false }` ONLY when the user
 * has expressed no posture. A present `attribution` (any value) or the
 * deprecated `includeCoAuthoredBy` (either value) is user-owned and survives
 * untouched — the AC-2 "a project that wants a byline keeps it" rule, applied
 * at user scope.
 *
 * BR-106 triage: pure function, no filesystem — fenced anyway (cheap, and it
 * keeps the file safe if a later case drives the writer).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fenceHome, type HomeFence } from "./home-fence.js";
import {
  applyAttributionDefault,
  attributionAddedNote,
  IGRIS_ATTRIBUTION,
} from "../lib/attribution-settings.js";

let fence: HomeFence;
beforeEach(() => {
  fence = fenceHome("igris-attribution-home-");
});
afterEach(() => {
  fence.release();
});

const OFF = { commit: "", pr: "", sessionUrl: false };

describe("applyAttributionDefault (TD-470)", () => {
  it("T1: an empty settings object gains exactly the object form -> added", () => {
    const { settings, outcome } = applyAttributionDefault({});
    expect(outcome).toBe("added");
    expect(settings).toStrictEqual({ attribution: OFF });
  });

  it("T2: a user-chosen attribution object is kept verbatim -> kept-user", () => {
    const user = {
      attribution: { commit: "Co-authored-by: Pair <pair@example.com>", pr: "", sessionUrl: true },
    };
    const snapshot = JSON.stringify(user);
    const { settings, outcome } = applyAttributionDefault(user);
    expect(outcome).toBe("kept-user");
    expect(settings).toStrictEqual(JSON.parse(snapshot));
  });

  it("T3: the deprecated includeCoAuthoredBy (either value) is user-owned -> no attribution key added", () => {
    for (const v of [true, false]) {
      const { settings, outcome } = applyAttributionDefault({ includeCoAuthoredBy: v });
      expect(outcome).toBe("kept-user");
      expect(Object.prototype.hasOwnProperty.call(settings, "attribution")).toBe(false);
      expect(settings).toStrictEqual({ includeCoAuthoredBy: v });
    }
  });

  it("T4: the Igris object already present (any key order) -> present, unchanged", () => {
    const input = { attribution: { sessionUrl: false, pr: "", commit: "" } };
    const { settings, outcome } = applyAttributionDefault(input);
    expect(outcome).toBe("present");
    expect(settings).toStrictEqual(input);
  });

  it("T4b: attribution:false (the scalar form) -> kept-user, untouched", () => {
    const { settings, outcome } = applyAttributionDefault({ attribution: false });
    expect(outcome).toBe("kept-user");
    expect(settings).toStrictEqual({ attribution: false });
  });

  it("T4c: attribution:{} -> kept-user (nothing filled in)", () => {
    const { settings, outcome } = applyAttributionDefault({ attribution: {} });
    expect(outcome).toBe("kept-user");
    expect(settings).toStrictEqual({ attribution: {} });
  });

  it("T4d: a partial object {commit:'x'} -> kept-user, no sub-key merged in", () => {
    const { settings, outcome } = applyAttributionDefault({ attribution: { commit: "x" } });
    expect(outcome).toBe("kept-user");
    expect(settings).toStrictEqual({ attribution: { commit: "x" } });
  });

  it("T4e: the Igris object plus an extra sub-key is NOT the Igris object -> kept-user", () => {
    const input = { attribution: { ...OFF, extra: 1 } };
    const { settings, outcome } = applyAttributionDefault(input);
    expect(outcome).toBe("kept-user");
    expect(settings).toStrictEqual({ attribution: { ...OFF, extra: 1 } });
  });

  it("T7: attribution is appended LAST and prior key order is preserved", () => {
    const input = { permissions: { allow: [] }, includeGitInstructions: false, hooks: {}, model: "x" };
    const { settings } = applyAttributionDefault(input);
    expect(Object.keys(settings)).toStrictEqual([
      "permissions",
      "includeGitInstructions",
      "hooks",
      "model",
      "attribution",
    ]);
  });

  it("does not mutate its input, and the written value is not the frozen constant", () => {
    const input: Record<string, unknown> = { model: "x" };
    const { settings } = applyAttributionDefault(input);
    expect(input).toStrictEqual({ model: "x" });
    expect(settings).not.toBe(input);
    expect(settings.attribution).not.toBe(IGRIS_ATTRIBUTION);
    expect(Object.isFrozen(settings.attribution)).toBe(false);
  });

  it("the added-note names the path, the precedence rule and the opt-out", () => {
    const note = attributionAddedNote("/fence/.claude/settings.json");
    expect(note).toContain("/fence/.claude/settings.json");
    expect(note).toContain('.claude/settings.json "attribution" still wins');
    expect(note).toContain("keep a byline");
  });

  it("IGRIS_ATTRIBUTION is the documented object form and is frozen", () => {
    expect(IGRIS_ATTRIBUTION).toStrictEqual(OFF);
    expect(Object.isFrozen(IGRIS_ATTRIBUTION)).toBe(true);
  });
});
