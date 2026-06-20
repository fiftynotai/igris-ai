/**
 * identity-shape.test.ts — TD-233 (GAP-3 remediation).
 *
 * Pins the TS side of the orchestrator-identity surface:
 *
 *   1. `buildHarnessIdentityFile` per-harness shapes — Model-A self-name
 *      reword ("Not Gemini CLI using Igris AI." / "Not Codex using Igris
 *      AI."); a non-Claude output NEVER says "Claude".
 *   2. **bash↔TS golden-fixture byte-parity (§18.1 / L-554):** rendering the
 *      REAL repo canonical (`core/templates/identity.tmpl`) with the fixed
 *      version `9.9.9` must byte-equal the checked-in golden fixtures
 *      (`fixtures/td233-identity-golden-{gemini,codex}.md`), which were
 *      emitted by the bash `normalize_identity_shape`. The bats `#parity`
 *      test in `test/harness_identity.test.bash` re-derives the SAME fixtures
 *      from bash, so the two implementations cannot silently diverge.
 *   3. `renderClaudeMd` (claude-md.ts) inlines the `{{IGRIS_IDENTITY}}` token
 *      from `identity.tmpl` so the rendered CLAUDE.md is byte-identical to
 *      the pre-TD-233 output; legacy templates without the token pass
 *      through untouched; token-without-identity.tmpl throws.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HARNESS_SELF_NAMES,
  IDENTITY_BEGIN_LINE,
  IDENTITY_BEGIN_PREFIX,
  IDENTITY_END_LINE,
  appendDelegationRecipe,
  buildHarnessIdentityFile,
  renderIdentityBody,
  type IdentityHarness,
} from "../lib/identity-shape.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repo root — cli/src/__tests__ → ../../.. */
const REPO_ROOT = join(HERE, "..", "..", "..");
const CANONICAL_TMPL = join(REPO_ROOT, "core", "templates", "identity.tmpl");
const RECIPE_TMPL = join(REPO_ROOT, "core", "templates", "delegation-recipe.tmpl");
const FIXTURES = join(HERE, "fixtures");

const ALL_HARNESSES: IdentityHarness[] = ["claude", "codex", "gemini", "opencode"];

describe("buildHarnessIdentityFile — per-harness Model-A shapes", () => {
  const tmpl =
    "## Identity\nIgris AI v{{IGRIS_VERSION}} — AI-powered engineering OS, developed by fifty.dev.\nYou ARE Igris AI. Not {{HARNESS_SELF_NAME}} using Igris AI.\n";

  it("rewords the negation line per harness and substitutes the version", () => {
    expect(buildHarnessIdentityFile(tmpl, "gemini", "1.2.3")).toContain(
      "Not Gemini CLI using Igris AI.",
    );
    expect(buildHarnessIdentityFile(tmpl, "codex", "1.2.3")).toContain(
      "Not Codex using Igris AI.",
    );
    expect(buildHarnessIdentityFile(tmpl, "opencode", "1.2.3")).toContain(
      "Not OpenCode using Igris AI.",
    );
    expect(buildHarnessIdentityFile(tmpl, "claude", "1.2.3")).toContain(
      "Not Claude using Igris AI.",
    );
    expect(buildHarnessIdentityFile(tmpl, "gemini", "1.2.3")).toContain(
      "Igris AI v1.2.3",
    );
  });

  it("never says 'Claude' in a non-Claude output (Model-A reword contract)", () => {
    for (const h of ALL_HARNESSES.filter((x) => x !== "claude")) {
      expect(buildHarnessIdentityFile(tmpl, h, "1.2.3")).not.toContain("Claude");
    }
  });

  it("always asserts the Model-A identity ('You ARE Igris AI.') for every harness", () => {
    for (const h of ALL_HARNESSES) {
      expect(buildHarnessIdentityFile(tmpl, h, "1.2.3")).toContain(
        "You ARE Igris AI.",
      );
    }
  });

  it("wraps the body in the delimited region: BEGIN line, body, END line, trailing newline", () => {
    const out = buildHarnessIdentityFile(tmpl, "gemini", "1.2.3");
    const lines = out.split("\n");
    expect(lines[0]).toBe(IDENTITY_BEGIN_LINE);
    expect(lines[0].startsWith(IDENTITY_BEGIN_PREFIX)).toBe(true);
    expect(lines[lines.length - 2]).toBe(IDENTITY_END_LINE);
    expect(out.endsWith(`${IDENTITY_END_LINE}\n`)).toBe(true);
  });

  it("normalizes the rendered body to exactly one trailing newline", () => {
    const noTrailing = tmpl.replace(/\n$/, "");
    const manyTrailing = `${tmpl}\n\n\n`;
    expect(renderIdentityBody(noTrailing, "gemini", "1.2.3")).toBe(
      renderIdentityBody(manyTrailing, "gemini", "1.2.3"),
    );
    expect(renderIdentityBody(tmpl, "gemini", "1.2.3").endsWith("\n")).toBe(true);
    expect(renderIdentityBody(tmpl, "gemini", "1.2.3").endsWith("\n\n")).toBe(false);
  });

  it("rejects an unknown harness", () => {
    expect(() =>
      renderIdentityBody(tmpl, "cursor" as IdentityHarness, "1.2.3"),
    ).toThrow(/unknown harness/);
  });

  it("exposes the self-name map the bash normalizer mirrors", () => {
    expect(HARNESS_SELF_NAMES).toEqual({
      claude: "Claude",
      codex: "Codex",
      gemini: "Gemini CLI",
      opencode: "OpenCode",
    });
  });
});

describe("bash↔TS golden-fixture byte-parity (§18.1 / L-554)", () => {
  it("gemini: TS render of the REAL canonical equals the bash-emitted golden fixture", () => {
    const templateRaw = readFileSync(CANONICAL_TMPL, "utf-8");
    const golden = readFileSync(
      join(FIXTURES, "td233-identity-golden-gemini.md"),
      "utf-8",
    );
    expect(buildHarnessIdentityFile(templateRaw, "gemini", "9.9.9")).toBe(golden);
  });

  it("codex: TS render of the REAL canonical equals the bash-emitted golden fixture", () => {
    const templateRaw = readFileSync(CANONICAL_TMPL, "utf-8");
    const golden = readFileSync(
      join(FIXTURES, "td233-identity-golden-codex.md"),
      "utf-8",
    );
    expect(buildHarnessIdentityFile(templateRaw, "codex", "9.9.9")).toBe(golden);
  });

  it("native-static is identity-only — the pre-TD-244 shape (back-compat)", () => {
    // Passing delegation_model=native-static (or omitting it) MUST byte-equal
    // the original identity-only golden — no recipe, no behavior change for the
    // CLAUDE.md inline path / Codex / native gemini.
    const templateRaw = readFileSync(CANONICAL_TMPL, "utf-8");
    const golden = readFileSync(
      join(FIXTURES, "td233-identity-golden-gemini.md"),
      "utf-8",
    );
    expect(buildHarnessIdentityFile(templateRaw, "gemini", "9.9.9", "native-static")).toBe(
      golden,
    );
    expect(buildHarnessIdentityFile(templateRaw, "gemini", "9.9.9")).toBe(golden);
  });
});

describe("TD-244 (BI-3) delegation-recipe region — bash↔TS golden-fixture byte-parity (§18.1 / L-554)", () => {
  it("gemini dynamic-define: TS render of canonical+recipe equals the bash-emitted golden", () => {
    // The golden (td244-identity-golden-gemini-dynamic.md) was emitted by the
    // bash `normalize_identity_shape <tmpl> gemini 9.9.9 dynamic-define <recipe>`.
    // The TS twin MUST reproduce it byte-for-byte (L-554 hash-stable-parity) —
    // a drift here is the exact regression this guard exists for.
    const templateRaw = readFileSync(CANONICAL_TMPL, "utf-8");
    const recipeRaw = readFileSync(RECIPE_TMPL, "utf-8");
    const golden = readFileSync(
      join(FIXTURES, "td244-identity-golden-gemini-dynamic.md"),
      "utf-8",
    );
    expect(
      buildHarnessIdentityFile(templateRaw, "gemini", "9.9.9", "dynamic-define", recipeRaw),
    ).toBe(golden);
  });

  it("the dynamic-define region carries BOTH the identity body and the recipe", () => {
    const templateRaw = readFileSync(CANONICAL_TMPL, "utf-8");
    const recipeRaw = readFileSync(RECIPE_TMPL, "utf-8");
    const out = buildHarnessIdentityFile(
      templateRaw,
      "gemini",
      "9.9.9",
      "dynamic-define",
      recipeRaw,
    );
    expect(out).toContain("You ARE Igris AI. Not Gemini CLI using Igris AI.");
    expect(out).toContain("## Delegation Mechanism (dynamic-define harness)");
    expect(out).toContain("define_subagent");
    // Identity body and recipe are separated by exactly one blank line.
    expect(out).toContain(
      "You ARE Igris AI. Not Gemini CLI using Igris AI.\n\n## Delegation Mechanism",
    );
    // Region still ends with the END marker + one trailing newline.
    expect(out.endsWith(`${IDENTITY_END_LINE}\n`)).toBe(true);
  });

  it("appendDelegationRecipe separates body from recipe by one blank line, one trailing newline", () => {
    const body = "IDENTITY\n";
    expect(appendDelegationRecipe(body, "RECIPE")).toBe("IDENTITY\n\nRECIPE\n");
    // Extra trailing newlines in the recipe are normalized to exactly one.
    expect(appendDelegationRecipe(body, "RECIPE\n\n\n")).toBe("IDENTITY\n\nRECIPE\n");
  });

  it("throws when dynamic-define is requested but no recipe is supplied (never silent strand)", () => {
    const templateRaw = readFileSync(CANONICAL_TMPL, "utf-8");
    expect(() =>
      buildHarnessIdentityFile(templateRaw, "gemini", "9.9.9", "dynamic-define"),
    ).toThrow(/requires a recipe/);
    expect(() => appendDelegationRecipe("X\n", undefined)).toThrow(/requires a recipe/);
  });
});

describe("renderClaudeMd — {{IGRIS_IDENTITY}} include (TD-233)", () => {
  let tmpBrain: string;

  beforeEach(() => {
    tmpBrain = mkdtempSync(join(tmpdir(), "igris-cli-identity-brain-"));
    process.env.IGRIS_BRAIN_DIR = tmpBrain;
  });

  afterEach(() => {
    rmSync(tmpBrain, { recursive: true, force: true });
    delete process.env.IGRIS_BRAIN_DIR;
  });

  function stage(tmplContent: string, identityContent?: string): string {
    const dir = join(tmpBrain, "core", "templates");
    mkdirSync(dir, { recursive: true });
    const tmplPath = join(dir, "CLAUDE.md.tmpl");
    writeFileSync(tmplPath, tmplContent);
    if (identityContent !== undefined) {
      writeFileSync(join(dir, "identity.tmpl"), identityContent);
    }
    return tmplPath;
  }

  it("renders byte-identically to the pre-TD-233 inline identity block", async () => {
    // The REAL repo templates: CLAUDE.md.tmpl carries the include token,
    // identity.tmpl carries the canonical block. Rendering must reproduce the
    // exact pre-extraction lines.
    const tmplPath = stage(
      readFileSync(join(REPO_ROOT, "core", "templates", "CLAUDE.md.tmpl"), "utf-8"),
      readFileSync(CANONICAL_TMPL, "utf-8"),
    );
    const m = await import("../lib/claude-md.js");
    const out = m.renderClaudeMd({
      cliVersion: "7.0.0",
      installDate: "2026-05-05",
      templatePath: tmplPath,
    });
    expect(out).toContain(
      "# Igris AI - Project Instructions\n" +
        "\n" +
        "## Identity\n" +
        "Igris AI v7.0.0 — AI-powered engineering OS, developed by fifty.dev.\n" +
        "You ARE Igris AI. Not Claude using Igris AI.\n" +
        "Installed: 2026-05-05\n",
    );
    expect(out).not.toContain("{{IGRIS_IDENTITY}}");
    expect(out).not.toContain("{{HARNESS_SELF_NAME}}");
    expect(out).not.toContain("{{IGRIS_VERSION}}");
    expect(out).not.toContain("{{INSTALL_DATE}}");
  });

  it("passes a legacy template WITHOUT the token through untouched (back-compat)", async () => {
    const legacy = "# Legacy\n\nIgris v{{IGRIS_VERSION}}\nInstalled: {{INSTALL_DATE}}\n";
    const tmplPath = stage(legacy); // no identity.tmpl staged — must not be needed
    const m = await import("../lib/claude-md.js");
    const out = m.renderClaudeMd({
      cliVersion: "1.0.0",
      installDate: "2026-01-01",
      templatePath: tmplPath,
    });
    expect(out).toBe("# Legacy\n\nIgris v1.0.0\nInstalled: 2026-01-01\n");
  });

  it("throws ClaudeMdTemplateError when the token is present but identity.tmpl is missing", async () => {
    const tmplPath = stage("# X\n\n{{IGRIS_IDENTITY}}\n"); // no identity.tmpl
    const m = await import("../lib/claude-md.js");
    expect(() =>
      m.renderClaudeMd({
        cliVersion: "1.0.0",
        installDate: "2026-01-01",
        templatePath: tmplPath,
      }),
    ).toThrow(m.ClaudeMdTemplateError);
  });
});
