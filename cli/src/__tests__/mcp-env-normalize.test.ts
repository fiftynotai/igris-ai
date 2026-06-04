/**
 * FR-165 — per-harness env normalizer tests.
 *
 * `normalizeEnvForHarness` is a PURE function (no fs, no env). Each case pins
 * one of the four per-harness output forms (the FR-160e locked decision):
 *   claude/gemini → `${VAR}` verbatim
 *   opencode      → `{env:VAR}`
 *   codex         → resolved literal (or { value: null, missing } when absent)
 *
 * NO `vi.mock` (L-159) — the function takes secrets as a plain arg.
 */

import { describe, expect, it } from "vitest";
import { normalizeEnvForHarness } from "../lib/mcp-env-normalize.js";

describe("normalizeEnvForHarness — per-harness env-VALUE emit rule", () => {
  it("claude: `${TOK}` → { value: '${TOK}' } verbatim", () => {
    expect(normalizeEnvForHarness("${TOK}", "claude")).toEqual({
      value: "${TOK}",
    });
  });

  it("gemini: `${TOK}` → { value: '${TOK}' } verbatim", () => {
    expect(normalizeEnvForHarness("${TOK}", "gemini")).toEqual({
      value: "${TOK}",
    });
  });

  it("opencode: `${TOK}` → { value: '{env:TOK}' }", () => {
    expect(normalizeEnvForHarness("${TOK}", "opencode")).toEqual({
      value: "{env:TOK}",
    });
  });

  it("codex (present): `${TOK}` + { TOK: 'secret' } → { value: 'secret' }", () => {
    expect(normalizeEnvForHarness("${TOK}", "codex", { TOK: "secret" })).toEqual(
      { value: "secret" },
    );
  });

  it("codex (missing): `${TOK}` + {} → { value: null, missing: 'TOK' }", () => {
    expect(normalizeEnvForHarness("${TOK}", "codex", {})).toEqual({
      value: null,
      missing: "TOK",
    });
  });

  it("codex without `secrets` arg → treated as {} → missing", () => {
    expect(normalizeEnvForHarness("${TOK}", "codex")).toEqual({
      value: null,
      missing: "TOK",
    });
  });

  describe("non-ref pass-through (a literal stays literal)", () => {
    it("claude: literal passes through", () => {
      expect(normalizeEnvForHarness("plain", "claude")).toEqual({
        value: "plain",
      });
    });

    it("gemini: literal passes through", () => {
      expect(normalizeEnvForHarness("plain", "gemini")).toEqual({
        value: "plain",
      });
    });

    it("opencode does NOT wrap a non-ref", () => {
      expect(normalizeEnvForHarness("plain", "opencode")).toEqual({
        value: "plain",
      });
    });

    it("codex: literal passes through (no missing)", () => {
      expect(normalizeEnvForHarness("plain", "codex", {})).toEqual({
        value: "plain",
      });
    });
  });
});
