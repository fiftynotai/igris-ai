/**
 * sync/util.ts tests (TD-121).
 *
 * Exercises the basenameOfCwd helper. We spy on process.cwd() rather
 * than chdir'ing to avoid leaking state across the suite.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { basenameOfCwd } from "../lib/sync/util.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sync/util — basenameOfCwd", () => {
  it("returns the last path segment when cwd is /foo/bar/baz", () => {
    vi.spyOn(process, "cwd").mockReturnValue("/foo/bar/baz");
    expect(basenameOfCwd()).toBe("baz");
  });

  it("returns empty string when cwd is /", () => {
    vi.spyOn(process, "cwd").mockReturnValue("/");
    // "/" → idx=0 → slice(1) = ""
    expect(basenameOfCwd()).toBe("");
  });
});
