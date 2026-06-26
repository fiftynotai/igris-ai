/**
 * FR-212b / FR-184: unit tests for the Igris-owned no-prompt GRANT module
 * (cli/src/lib/mcp-grant.ts).
 *
 * Posture: real `node:fs` against `mkdtempSync` tmp dirs (no mocks — the module
 * is an fs writer with a no-clobber contract; we exercise it directly against
 * sandboxed config paths, the same model as mcp-register.test.ts). The
 * `configPaths` seam points every harness at a tmp file.
 *
 * Coverage:
 *   1. The grant writer emits the CORRECT per-harness wildcard grammar:
 *      - claude       permissions.allow += "mcp__igris-brain__*"
 *      - antigravity  permissions.allow += "mcp(igris-brain/*)"
 *      - codex        [projects."<folder>"] trust_level = "trusted"
 *      - gemini       { "<folder>": "TRUST_FOLDER" }
 *      - opencode     covered (no file written)
 *   2. verifyBrainGrant detects a MISSING grant (and a PRESENT one).
 *   3. No-clobber: other allow entries / folders / tables preserved; malformed
 *      file refused (never clobbered); idempotent re-write is `unchanged`.
 *   4. removeBrainGrant is the exact inverse (revokes, idempotent-on-absent).
 *   5. Secret hygiene: NO literal secret / ${VAR} appears in any grant file (the
 *      brain is env-free — the grant carries only the wildcard token / trust).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import {
  writeBrainGrant,
  removeBrainGrant,
  verifyBrainGrant,
  writeBrainGrantAcrossHarnesses,
  removeBrainGrantAcrossHarnesses,
  __testing__,
} from "../lib/mcp-grant.js";
import type { McpHarness } from "../lib/mcp-shape.js";

const { GRANT_GRAMMAR, renderTrustTable } = __testing__;

let workDir: string;
/** A fixed folder used as the trust target for folder-scoped grants. */
const FOLDER = "/abs/project/root";

/** Sandbox config paths — one tmp file per harness. */
function sandboxPaths(): Partial<Record<McpHarness, string>> {
  return {
    claude: join(workDir, "claude-settings.json"),
    antigravity: join(workDir, "antigravity-settings.json"),
    codex: join(workDir, "config.toml"),
    gemini: join(workDir, "trustedFolders.json"),
    opencode: join(workDir, "opencode.json"),
  };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "igris-mcp-grant-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

describe("mcp-grant — claude (permissions.allow JSON array)", () => {
  it("writes the wildcard `mcp__igris-brain__*` into permissions.allow", () => {
    const cp = sandboxPaths();
    const r = writeBrainGrant("claude", { configPaths: cp, folder: FOLDER });
    expect(r.outcome).toBe("granted");
    const root = readJson(cp.claude!);
    const perms = root.permissions as { allow: string[] };
    expect(perms.allow).toContain("mcp__igris-brain__*");
  });

  it("is idempotent — a second write is `unchanged`, NO duplicate token", () => {
    const cp = sandboxPaths();
    writeBrainGrant("claude", { configPaths: cp });
    const r2 = writeBrainGrant("claude", { configPaths: cp });
    expect(r2.outcome).toBe("unchanged");
    const root = readJson(cp.claude!);
    const allow = (root.permissions as { allow: string[] }).allow;
    expect(allow.filter((x) => x === "mcp__igris-brain__*")).toHaveLength(1);
  });

  it("preserves pre-existing allow entries + other top-level keys (no-clobber)", () => {
    const cp = sandboxPaths();
    writeFileSync(
      cp.claude!,
      JSON.stringify(
        {
          permissions: { allow: ["mcp__pencil", "command(ls)"], defaultMode: "auto" },
          otherTopLevel: { keep: true },
        },
        null,
        2,
      ),
    );
    writeBrainGrant("claude", { configPaths: cp });
    const root = readJson(cp.claude!);
    const perms = root.permissions as { allow: string[]; defaultMode: string };
    expect(perms.allow).toEqual([
      "mcp__pencil",
      "command(ls)",
      "mcp__igris-brain__*",
    ]);
    expect(perms.defaultMode).toBe("auto");
    expect(root.otherTopLevel).toEqual({ keep: true });
  });

  it("refuses to clobber a malformed JSON file (returns failed, file untouched)", () => {
    const cp = sandboxPaths();
    writeFileSync(cp.claude!, "{ this is not json ");
    const before = readFileSync(cp.claude!, "utf-8");
    const r = writeBrainGrant("claude", { configPaths: cp });
    expect(r.outcome).toBe("failed");
    expect(r.error).toMatch(/malformed/);
    expect(readFileSync(cp.claude!, "utf-8")).toBe(before);
  });

  it("removeBrainGrant revokes the token (idempotent on a second remove)", () => {
    const cp = sandboxPaths();
    writeBrainGrant("claude", { configPaths: cp });
    const r1 = removeBrainGrant("claude", { configPaths: cp });
    expect(r1.outcome).toBe("revoked");
    const allow = (readJson(cp.claude!).permissions as { allow: string[] }).allow;
    expect(allow).not.toContain("mcp__igris-brain__*");
    const r2 = removeBrainGrant("claude", { configPaths: cp });
    expect(r2.outcome).toBe("unchanged");
  });
});

describe("mcp-grant — antigravity (permissions.allow, mcp(...) grammar)", () => {
  it("writes the wildcard `mcp(igris-brain/*)` into permissions.allow", () => {
    const cp = sandboxPaths();
    const r = writeBrainGrant("antigravity", { configPaths: cp });
    expect(r.outcome).toBe("granted");
    const allow = (readJson(cp.antigravity!).permissions as { allow: string[] })
      .allow;
    expect(allow).toContain("mcp(igris-brain/*)");
    // NOT the claude grammar.
    expect(allow).not.toContain("mcp__igris-brain__*");
  });

  it("preserves the per-tool enumeration the live file carries (no-clobber)", () => {
    const cp = sandboxPaths();
    writeFileSync(
      cp.antigravity!,
      JSON.stringify(
        {
          permissions: {
            allow: ["mcp(igris-brain/igris_brief_sync)", "command(git commit)"],
          },
        },
        null,
        2,
      ),
    );
    writeBrainGrant("antigravity", { configPaths: cp });
    const allow = (readJson(cp.antigravity!).permissions as { allow: string[] })
      .allow;
    expect(allow).toContain("mcp(igris-brain/igris_brief_sync)");
    expect(allow).toContain("command(git commit)");
    expect(allow).toContain("mcp(igris-brain/*)");
  });
});

describe("mcp-grant — codex (folder-scoped TOML projects table)", () => {
  it("upserts `[projects.\"<folder>\"] trust_level = \"trusted\"`", () => {
    const cp = sandboxPaths();
    const r = writeBrainGrant("codex", { configPaths: cp, folder: FOLDER });
    expect(r.outcome).toBe("granted");
    const parsed = TOML.parse(readFileSync(cp.codex!, "utf-8"));
    const projects = parsed.projects as Record<string, { trust_level: string }>;
    expect(projects[FOLDER].trust_level).toBe("trusted");
  });

  it("preserves OTHER projects + sibling tables byte-for-byte (splice, not re-emit)", () => {
    const cp = sandboxPaths();
    const original = [
      'model = "gpt-5"',
      "",
      '[mcp_servers.igris-brain]',
      'command = "node"',
      'args = ["/abs/x.js"]',
      "",
      '[projects."/some/other/path"]',
      'trust_level = "trusted"',
      "",
    ].join("\n");
    writeFileSync(cp.codex!, original);
    writeBrainGrant("codex", { configPaths: cp, folder: FOLDER });
    const text = readFileSync(cp.codex!, "utf-8");
    // The pre-existing content is still present verbatim.
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain("[mcp_servers.igris-brain]");
    expect(text).toContain('[projects."/some/other/path"]');
    // And the new trust table parses correctly.
    const parsed = TOML.parse(text);
    const projects = parsed.projects as Record<string, { trust_level: string }>;
    expect(projects[FOLDER].trust_level).toBe("trusted");
    expect(projects["/some/other/path"].trust_level).toBe("trusted");
  });

  it("is idempotent when the folder is already trusted", () => {
    const cp = sandboxPaths();
    writeBrainGrant("codex", { configPaths: cp, folder: FOLDER });
    const r2 = writeBrainGrant("codex", { configPaths: cp, folder: FOLDER });
    expect(r2.outcome).toBe("unchanged");
  });

  it("refuses to clobber malformed TOML", () => {
    const cp = sandboxPaths();
    writeFileSync(cp.codex!, "[[[ not valid toml");
    const before = readFileSync(cp.codex!, "utf-8");
    const r = writeBrainGrant("codex", { configPaths: cp, folder: FOLDER });
    expect(r.outcome).toBe("failed");
    expect(readFileSync(cp.codex!, "utf-8")).toBe(before);
  });

  it("removeBrainGrant splices the trust table OUT, leaving siblings intact", () => {
    const cp = sandboxPaths();
    writeFileSync(
      cp.codex!,
      [
        '[projects."/keep/me"]',
        'trust_level = "trusted"',
        "",
        `[projects.${JSON.stringify(FOLDER)}]`,
        'trust_level = "trusted"',
        "",
      ].join("\n"),
    );
    const r = removeBrainGrant("codex", { configPaths: cp, folder: FOLDER });
    expect(r.outcome).toBe("revoked");
    const parsed = TOML.parse(readFileSync(cp.codex!, "utf-8"));
    const projects = parsed.projects as Record<string, unknown>;
    expect(projects[FOLDER]).toBeUndefined();
    expect(projects["/keep/me"]).toBeDefined();
  });

  it("renderTrustTable emits the exact grammar", () => {
    expect(renderTrustTable("/p")).toBe('[projects."/p"]\ntrust_level = "trusted"\n');
  });
});

describe("mcp-grant — gemini-cli (folder-scoped trustedFolders.json)", () => {
  it("sets `{ \"<folder>\": \"TRUST_FOLDER\" }` at the top level", () => {
    const cp = sandboxPaths();
    const r = writeBrainGrant("gemini", { configPaths: cp, folder: FOLDER });
    expect(r.outcome).toBe("granted");
    const root = readJson(cp.gemini!);
    expect(root[FOLDER]).toBe("TRUST_FOLDER");
  });

  it("preserves OTHER trusted folders (no-clobber)", () => {
    const cp = sandboxPaths();
    writeFileSync(
      cp.gemini!,
      JSON.stringify({ "/already/trusted": "TRUST_FOLDER" }, null, 2),
    );
    writeBrainGrant("gemini", { configPaths: cp, folder: FOLDER });
    const root = readJson(cp.gemini!);
    expect(root["/already/trusted"]).toBe("TRUST_FOLDER");
    expect(root[FOLDER]).toBe("TRUST_FOLDER");
  });

  it("removeBrainGrant deletes the folder entry (idempotent on absent)", () => {
    const cp = sandboxPaths();
    writeBrainGrant("gemini", { configPaths: cp, folder: FOLDER });
    const r1 = removeBrainGrant("gemini", { configPaths: cp, folder: FOLDER });
    expect(r1.outcome).toBe("revoked");
    expect(readJson(cp.gemini!)[FOLDER]).toBeUndefined();
    const r2 = removeBrainGrant("gemini", { configPaths: cp, folder: FOLDER });
    expect(r2.outcome).toBe("unchanged");
  });
});

describe("mcp-grant — opencode (covered by agent frontmatter)", () => {
  it("writes NO file — outcome is `covered`", () => {
    const cp = sandboxPaths();
    const r = writeBrainGrant("opencode", { configPaths: cp });
    expect(r.outcome).toBe("covered");
    expect(existsSync(cp.opencode!)).toBe(false);
  });

  it("verifyBrainGrant reports opencode as present (its grant lives elsewhere)", () => {
    expect(verifyBrainGrant("opencode", { configPaths: sandboxPaths() })).toBe(
      true,
    );
  });

  it("removeBrainGrant for opencode is `covered` (no-op)", () => {
    const r = removeBrainGrant("opencode", { configPaths: sandboxPaths() });
    expect(r.outcome).toBe("covered");
  });
});

describe("mcp-grant — verifyBrainGrant (the drift predicate)", () => {
  it("returns FALSE when the grant is missing (every file-backed harness)", () => {
    const cp = sandboxPaths();
    expect(verifyBrainGrant("claude", { configPaths: cp, folder: FOLDER })).toBe(
      false,
    );
    expect(
      verifyBrainGrant("antigravity", { configPaths: cp, folder: FOLDER }),
    ).toBe(false);
    expect(verifyBrainGrant("codex", { configPaths: cp, folder: FOLDER })).toBe(
      false,
    );
    expect(verifyBrainGrant("gemini", { configPaths: cp, folder: FOLDER })).toBe(
      false,
    );
  });

  it("returns TRUE after the grant is written (every file-backed harness)", () => {
    const cp = sandboxPaths();
    for (const h of ["claude", "antigravity", "codex", "gemini"] as McpHarness[]) {
      writeBrainGrant(h, { configPaths: cp, folder: FOLDER });
      expect(verifyBrainGrant(h, { configPaths: cp, folder: FOLDER })).toBe(true);
    }
  });

  it("returns FALSE for a folder-scoped harness when a DIFFERENT folder is trusted", () => {
    const cp = sandboxPaths();
    writeBrainGrant("gemini", { configPaths: cp, folder: "/other/folder" });
    // The grant exists for /other/folder, NOT for FOLDER → drift miss.
    expect(verifyBrainGrant("gemini", { configPaths: cp, folder: FOLDER })).toBe(
      false,
    );
  });

  it("returns FALSE on a malformed file (unverifiable grant treated as absent)", () => {
    const cp = sandboxPaths();
    writeFileSync(cp.claude!, "{ broken ");
    expect(verifyBrainGrant("claude", { configPaths: cp })).toBe(false);
  });
});

describe("mcp-grant — secret hygiene (the grant carries NO secret)", () => {
  it("NO literal secret or ${VAR} ref appears in ANY written grant file", () => {
    const cp = sandboxPaths();
    writeBrainGrantAcrossHarnesses({ configPaths: cp, folder: FOLDER });
    for (const h of ["claude", "antigravity", "codex", "gemini"] as McpHarness[]) {
      const p = cp[h]!;
      if (!existsSync(p)) continue;
      const text = readFileSync(p, "utf-8");
      expect(text).not.toContain("${"); // no ${VAR} indirection ref
      expect(text).not.toMatch(/(?:secret|token|password)\s*[:=]/i);
      expect(text).not.toMatch(/[A-Za-z0-9]{40,}/); // no long token-like blob
    }
  });
});

describe("mcp-grant — across-harness sweep", () => {
  it("writeBrainGrantAcrossHarnesses returns one result per harness (opencode covered)", () => {
    const cp = sandboxPaths();
    const results = writeBrainGrantAcrossHarnesses({ configPaths: cp, folder: FOLDER });
    expect(results).toHaveLength(5);
    const byHarness = Object.fromEntries(results.map((r) => [r.harness, r.outcome]));
    expect(byHarness.claude).toBe("granted");
    expect(byHarness.antigravity).toBe("granted");
    expect(byHarness.codex).toBe("granted");
    expect(byHarness.gemini).toBe("granted");
    expect(byHarness.opencode).toBe("covered");
  });

  it("removeBrainGrantAcrossHarnesses is the inverse sweep", () => {
    const cp = sandboxPaths();
    writeBrainGrantAcrossHarnesses({ configPaths: cp, folder: FOLDER });
    const results = removeBrainGrantAcrossHarnesses({ configPaths: cp, folder: FOLDER });
    const byHarness = Object.fromEntries(results.map((r) => [r.harness, r.outcome]));
    expect(byHarness.claude).toBe("revoked");
    expect(byHarness.gemini).toBe("revoked");
    expect(byHarness.opencode).toBe("covered");
  });

  it("the grant grammar table covers all 5 harnesses", () => {
    expect(Object.keys(GRANT_GRAMMAR).sort()).toEqual(
      ["antigravity", "claude", "codex", "gemini", "opencode"].sort(),
    );
  });
});
