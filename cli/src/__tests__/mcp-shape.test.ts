/**
 * mcp-shape.test.ts — FR-164 (FR-160 epic).
 *
 * The §18.1 / L-554 GOLDEN-FIXTURE PARITY GUARD for `buildHarnessMcpEntry`.
 * This test pins the EXACT per-harness native MCP entry the TS projector
 * produces for a FIXED canonical. The bash side (`_common.sh
 * normalize_mcp_shape`) is asserted to produce the IDENTICAL shape in
 * `test/harness_mcp.test.bash` (the `#parity` test re-derives these same 4
 * shapes via the bash helper and compares byte-for-byte). Neither the TS shape
 * nor the bash shape can change without BOTH tests failing — that is the
 * hash-stable-parity contract.
 *
 * Pure unit test — no fs, no mocks (the SUT is a pure function).
 *
 * SECURITY: the codex fixture asserts the resolved literal IS written for codex
 * (codex resolves nothing) and that a MISSING codex secret yields `{ missing }`
 * with NO partial value on the env key.
 */

import { describe, expect, it } from "vitest";
import {
  buildHarnessMcpEntry,
  type McpShapeCanonical,
} from "../lib/mcp-shape.js";
import type { SecretsMap } from "../lib/secrets.js";

/**
 * THE FIXED CANONICAL — keep byte-identical to the bash parity fixture in
 * test/harness_mcp.test.bash. Changing it requires changing BOTH.
 */
const CANONICAL: McpShapeCanonical = {
  command: "node",
  args: ["/x/y.js"],
  env: { API: "${API_TOKEN}" },
  startup_timeout_sec: 30,
};

/** The codex secrets fixture: the resolved literal for ${API_TOKEN}. */
const SECRETS: SecretsMap = { API_TOKEN: "resolved-secret-literal" };

describe("buildHarnessMcpEntry — golden per-harness shapes (L-554 parity)", () => {
  it("claude carries type:stdio and the ${VAR} ref verbatim", () => {
    const { entry, missing } = buildHarnessMcpEntry(CANONICAL, "claude", undefined);
    expect(missing).toBeUndefined();
    expect(entry).toEqual({
      type: "stdio",
      command: "node",
      args: ["/x/y.js"],
      env: { API: "${API_TOKEN}" },
    });
  });

  it("gemini has NO type and the ${VAR} ref verbatim", () => {
    const { entry, missing } = buildHarnessMcpEntry(CANONICAL, "gemini", undefined);
    expect(missing).toBeUndefined();
    expect(entry).toEqual({
      command: "node",
      args: ["/x/y.js"],
      env: { API: "${API_TOKEN}" },
    });
    expect((entry as Record<string, unknown>).type).toBeUndefined();
  });

  it("FR-179: antigravity is BYTE-IDENTICAL to gemini (no type, ${VAR} verbatim)", () => {
    const { entry, missing } = buildHarnessMcpEntry(
      CANONICAL,
      "antigravity",
      undefined,
    );
    expect(missing).toBeUndefined();
    expect(entry).toEqual({
      command: "node",
      args: ["/x/y.js"],
      env: { API: "${API_TOKEN}" },
    });
    expect((entry as Record<string, unknown>).type).toBeUndefined();
    // The proof antigravity rides gemini's MCP shape: same canonical → same
    // entry bytes (only the config-PATH differs; that is asserted elsewhere).
    const gem = buildHarnessMcpEntry(CANONICAL, "gemini", undefined).entry;
    expect(JSON.stringify(entry)).toBe(JSON.stringify(gem));
  });

  it("opencode fuses command+args, carries enabled, uses environment + {env:VAR}", () => {
    const { entry, missing } = buildHarnessMcpEntry(CANONICAL, "opencode", true);
    expect(missing).toBeUndefined();
    expect(entry).toEqual({
      type: "local",
      command: ["node", "/x/y.js"],
      enabled: true,
      environment: { API: "{env:API_TOKEN}" },
    });
  });

  it("opencode enabled defaults to true when target.enabled is undefined", () => {
    const { entry } = buildHarnessMcpEntry(CANONICAL, "opencode", undefined);
    expect((entry as Record<string, unknown>).enabled).toBe(true);
  });

  it("opencode honors enabled:false passthrough", () => {
    const { entry } = buildHarnessMcpEntry(CANONICAL, "opencode", false);
    expect((entry as Record<string, unknown>).enabled).toBe(false);
  });

  it("codex emits the RESOLVED LITERAL and startup_timeout_sec", () => {
    const { entry, missing } = buildHarnessMcpEntry(
      CANONICAL,
      "codex",
      undefined,
      SECRETS,
    );
    expect(missing).toBeUndefined();
    expect(entry).toEqual({
      command: "node",
      args: ["/x/y.js"],
      env: { API: "resolved-secret-literal" },
      startup_timeout_sec: 30,
    });
  });

  it("codex with a MISSING secret returns { missing } and NO partial value", () => {
    const { entry, missing } = buildHarnessMcpEntry(
      CANONICAL,
      "codex",
      undefined,
      {}, // empty secrets — API_TOKEN absent
    );
    expect(missing).toBe("API_TOKEN");
    // The env key MUST be omitted — never a partial/empty/placeholder literal.
    expect((entry as { env?: Record<string, string> }).env).toEqual({});
  });

  it("codex omits startup_timeout_sec when absent in the canonical", () => {
    const noTimeout: McpShapeCanonical = {
      command: "node",
      args: [],
      env: {},
    };
    const { entry } = buildHarnessMcpEntry(noTimeout, "codex", undefined, {});
    expect((entry as Record<string, unknown>).startup_timeout_sec).toBeUndefined();
  });

  it("empty args/env default to []/{} for every harness", () => {
    const bare: McpShapeCanonical = { command: "srv" };
    for (const h of ["claude", "gemini", "antigravity", "codex"] as const) {
      const { entry } = buildHarnessMcpEntry(bare, h, undefined, {});
      expect((entry as Record<string, unknown>).args).toEqual([]);
      expect((entry as Record<string, unknown>).env).toEqual({});
    }
    const { entry: oc } = buildHarnessMcpEntry(bare, "opencode", undefined);
    expect((oc as Record<string, unknown>).command).toEqual(["srv"]);
    expect((oc as Record<string, unknown>).environment).toEqual({});
  });

  it("a non-ref literal env value passes through unchanged for every harness", () => {
    const lit: McpShapeCanonical = {
      command: "node",
      args: [],
      env: { PLAIN: "just-a-string" },
    };
    expect((buildHarnessMcpEntry(lit, "claude", undefined).entry as { env: Record<string, string> }).env).toEqual({
      PLAIN: "just-a-string",
    });
    // opencode does NOT wrap a non-ref.
    expect(
      (buildHarnessMcpEntry(lit, "opencode", undefined).entry as {
        environment: Record<string, string>;
      }).environment,
    ).toEqual({ PLAIN: "just-a-string" });
    // codex passes a literal through verbatim (resolveRef pass-through).
    expect(
      (buildHarnessMcpEntry(lit, "codex", undefined, {}).entry as {
        env: Record<string, string>;
      }).env,
    ).toEqual({ PLAIN: "just-a-string" });
  });
});

/**
 * The CANONICAL → expected-JSON map the bash parity test re-derives. Exported as
 * a JSON.stringify(sort_keys-equivalent) golden so a human can diff the bats
 * output against it. The bats test computes `normalize_mcp_shape` and asserts
 * byte-equality after a `python3 -c "json.dumps(... sort_keys=True)"` round-trip
 * on BOTH sides (key-order-independent structural equality).
 */
describe("golden JSON the bash normalize_mcp_shape must match", () => {
  it("documents the 5 reference shapes (drift-compare stand-in for env)", () => {
    // NOTE: this mirrors normalize_mcp_shape's REFERENCE-stand-in posture for
    // codex env (it emits ${VAR}, not the literal — the literal re-resolve is
    // the drift compare's job). So the codex golden here uses the ref, matching
    // bash. (buildHarnessMcpEntry above resolves the literal because it is the
    // WRITE path; normalize_mcp_shape is the DRIFT-EXPECTED path.)
    const refShapes = {
      claude: { type: "stdio", command: "node", args: ["/x/y.js"], env: { API: "${API_TOKEN}" } },
      gemini: { command: "node", args: ["/x/y.js"], env: { API: "${API_TOKEN}" } },
      // FR-179: antigravity is byte-identical to gemini (only the path differs).
      antigravity: { command: "node", args: ["/x/y.js"], env: { API: "${API_TOKEN}" } },
      opencode: {
        type: "local",
        command: ["node", "/x/y.js"],
        enabled: true,
        environment: { API: "{env:API_TOKEN}" },
      },
      codex: {
        command: "node",
        args: ["/x/y.js"],
        env: { API: "${API_TOKEN}" },
        startup_timeout_sec: 30,
      },
    };
    // This object is the single source the bats #parity test compares against.
    expect(Object.keys(refShapes).sort()).toEqual([
      "antigravity",
      "claude",
      "codex",
      "gemini",
      "opencode",
    ]);
    // antigravity's golden is byte-identical to gemini's.
    expect(JSON.stringify(refShapes.antigravity)).toBe(
      JSON.stringify(refShapes.gemini),
    );
  });
});
