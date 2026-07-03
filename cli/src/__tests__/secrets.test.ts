/**
 * FR-165 — secrets library tests.
 *
 * Exercises `parseSecretsEnv` (the shell-sourceable parser) + `resolveRef`
 * (the canonical-ref → literal resolver) against real `node:fs` tmp files.
 * NO `vi.mock` (L-159) — these are pure helpers; the only seam is the
 * `path` arg + `IGRIS_BRAIN_DIR` for the default-path case.
 *
 * Includes the SECRET-HYGIENE assertion: a resolved literal value must NEVER
 * appear in any captured log output (the library must not log values).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSecretsEnv,
  resolveRef,
  secretsEnvPath,
} from "../lib/secrets.js";

let sandbox: string;
const prevBrain = process.env.IGRIS_BRAIN_DIR;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "igris-secrets-"));
  process.env.IGRIS_BRAIN_DIR = sandbox;
});

afterEach(() => {
  if (prevBrain === undefined) {
    delete process.env.IGRIS_BRAIN_DIR;
  } else {
    process.env.IGRIS_BRAIN_DIR = prevBrain;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

/** Write a secrets.env file into the sandbox and return its path. */
function writeSecrets(content: string): string {
  const p = join(sandbox, "secrets.env");
  writeFileSync(p, content);
  return p;
}

describe("parseSecretsEnv", () => {
  it("absent file → {}", () => {
    // The default secretsEnvPath() under the sandbox does not exist yet.
    expect(parseSecretsEnv(secretsEnvPath())).toEqual({});
    expect(parseSecretsEnv(join(sandbox, "nope.env"))).toEqual({});
  });

  it("`export VAR=value` → { VAR: 'value' }", () => {
    const p = writeSecrets("export VAR=value\n");
    expect(parseSecretsEnv(p)).toEqual({ VAR: "value" });
  });

  it("`VAR=value` (no export) → { VAR: 'value' }", () => {
    const p = writeSecrets("VAR=value\n");
    expect(parseSecretsEnv(p)).toEqual({ VAR: "value" });
  });

  it("double-quoted value → strips ONE quote pair", () => {
    const p = writeSecrets('VAR="a b"\n');
    expect(parseSecretsEnv(p)).toEqual({ VAR: "a b" });
  });

  it("single-quoted value → strips ONE quote pair", () => {
    const p = writeSecrets("VAR='a b'\n");
    expect(parseSecretsEnv(p)).toEqual({ VAR: "a b" });
  });

  it("comment + blank lines skipped; malformed line ignored; siblings still parsed", () => {
    const p = writeSecrets(
      [
        "# a comment",
        "",
        "   ",
        "GOOD=ok",
        "this-line-has-no-equals",
        "export ALSO=fine",
      ].join("\n") + "\n",
    );
    expect(parseSecretsEnv(p)).toEqual({ GOOD: "ok", ALSO: "fine" });
  });

  it("value containing '=' → split on FIRST '=' only", () => {
    const p = writeSecrets("VAR=a=b\n");
    expect(parseSecretsEnv(p)).toEqual({ VAR: "a=b" });
  });

  it("empty key (`=value`) → malformed, ignored", () => {
    const p = writeSecrets("=orphan\nVAR=ok\n");
    expect(parseSecretsEnv(p)).toEqual({ VAR: "ok" });
  });

  it("default path honors IGRIS_BRAIN_DIR (no arg)", () => {
    writeSecrets("DEF=defaulted\n");
    expect(parseSecretsEnv()).toEqual({ DEF: "defaulted" });
  });
});

describe("resolveRef", () => {
  it("`${TOK}` present → { resolved: 'secret' }", () => {
    expect(resolveRef("${TOK}", { TOK: "secret" })).toEqual({
      resolved: "secret",
    });
  });

  it("`{env:TOK}` OpenCode token form accepted → { resolved: 'secret' }", () => {
    expect(resolveRef("{env:TOK}", { TOK: "secret" })).toEqual({
      resolved: "secret",
    });
  });

  it("`${MISSING}` absent → { resolved: null, missing: 'MISSING' } (no throw)", () => {
    expect(() => resolveRef("${MISSING}", {})).not.toThrow();
    expect(resolveRef("${MISSING}", {})).toEqual({
      resolved: null,
      missing: "MISSING",
    });
  });

  it("non-ref literal → pass-through verbatim", () => {
    expect(resolveRef("plain-literal", {})).toEqual({
      resolved: "plain-literal",
    });
  });

  it("SECRET HYGIENE: a resolved literal never appears in any logged line", () => {
    const SECRET = "super-secret-token-value-9f3a";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const outSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const res = resolveRef("${TOK}", { TOK: SECRET });
      expect(res.resolved).toBe(SECRET);
      const allOutput = [
        ...logSpy.mock.calls,
        ...errSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...outSpy.mock.calls,
        ...stderrSpy.mock.calls,
      ]
        .flat()
        .map((a) => String(a))
        .join("\n");
      expect(allOutput).not.toContain(SECRET);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      warnSpy.mockRestore();
      outSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
