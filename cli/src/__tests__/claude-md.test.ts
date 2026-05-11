/**
 * claude-md.test.ts — Phase 2 (M2.4).
 *
 * Real fs against tmp dirs. No mocks (per L-159). Four cases:
 *
 *   1. Substitution renders the template with version + date.
 *   2. Missing template surfaces ClaudeMdTemplateError.
 *   3. Idempotent re-write produces stable content for same input
 *      (L-254 mitigation — no host-specific drift).
 *   4. Idempotent re-write to existing CLAUDE.md replaces atomically
 *      (no .tmp.* leftover).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpBrain: string;
let tmpProject: string;

const TEMPLATE = `# Igris AI Project Instructions

Igris v{{IGRIS_VERSION}}
Installed: {{INSTALL_DATE}}

Body content unchanged.
`;

function stageTemplate(): void {
  const tmplDir = join(tmpBrain, "core", "templates");
  mkdirSync(tmplDir, { recursive: true });
  writeFileSync(join(tmplDir, "CLAUDE.md.tmpl"), TEMPLATE);
}

beforeEach(() => {
  tmpBrain = mkdtempSync(join(tmpdir(), "igris-cli-claude-md-brain-"));
  tmpProject = mkdtempSync(join(tmpdir(), "igris-cli-claude-md-proj-"));
  process.env.IGRIS_BRAIN_DIR = tmpBrain;
});

afterEach(() => {
  rmSync(tmpBrain, { recursive: true, force: true });
  rmSync(tmpProject, { recursive: true, force: true });
  delete process.env.IGRIS_BRAIN_DIR;
});

describe("claude-md — render + regenerate", () => {
  it("renders the template with version + date substituted", async () => {
    stageTemplate();
    const m = await import("../lib/claude-md.js");
    const out = m.renderClaudeMd({
      cliVersion: "7.0.0",
      installDate: "2026-05-07",
    });
    expect(out).toContain("Igris v7.0.0");
    expect(out).toContain("Installed: 2026-05-07");
    expect(out).not.toContain("{{IGRIS_VERSION}}");
    expect(out).not.toContain("{{INSTALL_DATE}}");
  });

  it("missing template raises ClaudeMdTemplateError", async () => {
    // Brain root exists but template not staged.
    const m = await import("../lib/claude-md.js");
    const { ClaudeMdTemplateError } = await import("../lib/claude-md.js");
    expect(() =>
      m.renderClaudeMd({ cliVersion: "7.0.0", installDate: "2026-05-07" }),
    ).toThrow(ClaudeMdTemplateError);
  });

  it("idempotent re-render with the same input produces identical content (L-254)", async () => {
    stageTemplate();
    const m = await import("../lib/claude-md.js");
    const opts = { cliVersion: "7.0.0", installDate: "2026-05-07" };
    const a = m.renderClaudeMd(opts);
    const b = m.renderClaudeMd(opts);
    expect(b).toBe(a);
  });

  it("regenerateClaudeMd writes file atomically and idempotently", async () => {
    stageTemplate();
    const m = await import("../lib/claude-md.js");
    const target = m.regenerateClaudeMd(tmpProject, {
      cliVersion: "7.0.0",
      installDate: "2026-05-07",
    });
    expect(target).toBe(join(tmpProject, "CLAUDE.md"));
    expect(existsSync(target)).toBe(true);

    const before = readFileSync(target, "utf-8");
    // Re-write with same input -> same content.
    m.regenerateClaudeMd(tmpProject, {
      cliVersion: "7.0.0",
      installDate: "2026-05-07",
    });
    const after = readFileSync(target, "utf-8");
    expect(after).toBe(before);

    // No .tmp.* leftover (atomic rename completed).
    const stragglers = readdirSync(tmpProject).filter((e) =>
      e.includes(".tmp."),
    );
    expect(stragglers).toEqual([]);
  });
});
