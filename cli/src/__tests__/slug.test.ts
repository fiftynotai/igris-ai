/**
 * slug.ts tests (TD-118).
 *
 * Exhaustive coverage of the shared SLUG_RE grammar. Both happy and
 * reject branches; both validateSlug and SLUG_RE export.
 */

import { describe, expect, it } from "vitest";
import { SLUG_RE, validateSlug } from "../lib/slug.js";

describe("slug — validateSlug (happy path)", () => {
  it("accepts a normal hyphenated slug", () => {
    expect(() => validateSlug("my-project")).not.toThrow();
  });

  it("accepts uppercase (lifeOS-style)", () => {
    expect(() => validateSlug("lifeOS")).not.toThrow();
  });

  it("accepts mixed alphanumeric + underscore + hyphen + dot", () => {
    expect(() => validateSlug("a_b.c-d")).not.toThrow();
  });

  it("accepts a single alphanumeric char", () => {
    expect(() => validateSlug("a")).not.toThrow();
    expect(() => validateSlug("Z")).not.toThrow();
    expect(() => validateSlug("0")).not.toThrow();
  });

  it("accepts a 64-char slug starting with alphanumeric", () => {
    // 1 leading + 63 trailing = 64 chars total (the regex allows
    // {0,63} after the leading char, hence 64-char max).
    const s = "a" + "x".repeat(63);
    expect(s.length).toBe(64);
    expect(() => validateSlug(s)).not.toThrow();
  });
});

describe("slug — validateSlug (reject path)", () => {
  it("rejects empty string", () => {
    expect(() => validateSlug("")).toThrow(/Invalid slug/);
  });

  it("rejects 65-char slug (over length cap)", () => {
    const s = "a" + "x".repeat(64);
    expect(s.length).toBe(65);
    expect(() => validateSlug(s)).toThrow(/Invalid slug/);
  });

  it("rejects leading hyphen", () => {
    expect(() => validateSlug("-foo")).toThrow(/Invalid slug/);
  });

  it("rejects leading dot", () => {
    expect(() => validateSlug(".foo")).toThrow(/Invalid slug/);
  });

  it("rejects leading underscore", () => {
    expect(() => validateSlug("_foo")).toThrow(/Invalid slug/);
  });

  it("rejects slug containing a space", () => {
    expect(() => validateSlug("a b")).toThrow(/Invalid slug/);
  });

  it("rejects slug containing a slash", () => {
    expect(() => validateSlug("a/b")).toThrow(/Invalid slug/);
  });

  it("rejects unicode (non-ASCII alphanumeric)", () => {
    expect(() => validateSlug("café")).toThrow(/Invalid slug/);
  });
});

describe("slug — SLUG_RE export", () => {
  it("is a RegExp instance", () => {
    expect(SLUG_RE).toBeInstanceOf(RegExp);
  });

  it("is the canonical pattern (sanity check)", () => {
    // Pin the literal pattern so any accidental change to the grammar
    // surfaces here as a red test, not as a silent semantic shift.
    expect(SLUG_RE.source).toBe("^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$");
  });
});
