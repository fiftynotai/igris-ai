/**
 * persona-canonical-containment.test.ts — TD-406.
 *
 * `applyPersona` writes TWO files: the runtime `~/.igris/core/SOUL.md`, which
 * `IGRIS_BRAIN_DIR` contains, and the canonical `<repoRoot>/core/SOUL.md`, which
 * nothing contained. With `repoRoot` defaulting to `process.cwd()`, a suite that
 * sandboxed the brain perfectly still overwrote the tracked `core/SOUL.md` of the
 * real checkout.
 *
 * The assertions below are on the REAL repo file's sha256, not on a return
 * value: the defect was a write, so only the file can refute it. Each test also
 * asserts the runtime copy WAS written, or a `template_missing` early return
 * would satisfy the sha assertion without exercising the guard at all.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The real igris-ai checkout, resolved from THIS FILE — never from cwd. */
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const REAL_CANONICAL_SOUL = join(REPO_ROOT, "core", "SOUL.md");

const PROFESSIONAL_SOUL = `---
layer: identity
tier: boot
scope: orchestrator
summary: The OS persona — name, voice, traits. Customizable; reskin freely.
---

# SOUL — Persona

- **Voice:** dry, neutral, professional.
`;

const ENV_KEYS = ["IGRIS_BRAIN_DIR", "IGRIS_REPO_DIR", "VITEST", "NODE_ENV"];

let workDir: string;
let brainRoot: string;
const envBackup: Record<string, string | undefined> = {};

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Stage a sandboxed brain whose core carries the professional template. */
function stageBrain(): void {
  const core = join(brainRoot, "core");
  mkdirSync(core, { recursive: true });
  writeFileSync(join(core, "SOUL.professional.md"), PROFESSIONAL_SOUL);
  // Deliberately DIFFERENT from the template so `applyPersona` must write
  // (an already-matching runtime copy returns `unchanged` and writes nothing).
  writeFileSync(join(core, "SOUL.md"), "# not the professional template\n");
}

function runtimeSoul(): string {
  return readFileSync(join(brainRoot, "core", "SOUL.md"), "utf-8");
}

beforeEach(() => {
  for (const k of ENV_KEYS) envBackup[k] = process.env[k];
  workDir = mkdtempSync(join(tmpdir(), "td406-"));
  brainRoot = join(workDir, "brain");
  mkdirSync(brainRoot, { recursive: true });
  process.env.IGRIS_BRAIN_DIR = brainRoot;
  delete process.env.IGRIS_REPO_DIR;
  stageBrain();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe("TD-406 — the canonical SOUL.md write is contained", () => {
  it("ARM: the real checkout carries a core/SOUL.md (else every test below is vacuous)", () => {
    expect(existsSync(REAL_CANONICAL_SOUL)).toBe(true);
  });

  it("refuses the real checkout in a test context, and the FILE is unchanged", async () => {
    const { applyPersona } = await import("../lib/persona.js");
    const before = sha256(REAL_CANONICAL_SOUL);

    const result = applyPersona("professional", REPO_ROOT);

    // The call ran all the way to the write stage — not an early return.
    expect(result.outcome).toBe("applied");
    expect(runtimeSoul()).toBe(PROFESSIONAL_SOUL);
    // ...and the canonical half was refused, with the reason named.
    expect(result.canonicalPath).toBeNull();
    expect(result.canonicalRefusal).toBe("test_context_undeclared");
    // The assertion that matters: the tracked repo file was not touched.
    expect(sha256(REAL_CANONICAL_SOUL)).toBe(before);
  });

  it("still writes the canonical copy inside a declared IGRIS_REPO_DIR", async () => {
    const checkout = join(workDir, "checkout");
    mkdirSync(join(checkout, "core"), { recursive: true });
    writeFileSync(join(checkout, "core", "SOUL.md"), "# stale persona\n");
    process.env.IGRIS_REPO_DIR = checkout;

    const { applyPersona } = await import("../lib/persona.js");
    const before = sha256(REAL_CANONICAL_SOUL);

    const result = applyPersona("professional", checkout);

    expect(result.outcome).toBe("applied");
    expect(result.canonicalRefusal).toBeNull();
    expect(result.canonicalPath).toBe(join(checkout, "core", "SOUL.md"));
    expect(readFileSync(join(checkout, "core", "SOUL.md"), "utf-8")).toBe(
      PROFESSIONAL_SOUL,
    );
    expect(sha256(REAL_CANONICAL_SOUL)).toBe(before);
  });

  it("refuses the real checkout even when IGRIS_REPO_DIR declares somewhere else", async () => {
    const checkout = join(workDir, "checkout");
    mkdirSync(join(checkout, "core"), { recursive: true });
    process.env.IGRIS_REPO_DIR = checkout;

    const { applyPersona } = await import("../lib/persona.js");
    const before = sha256(REAL_CANONICAL_SOUL);

    const result = applyPersona("professional", REPO_ROOT);

    expect(result.outcome).toBe("applied");
    expect(runtimeSoul()).toBe(PROFESSIONAL_SOUL);
    expect(result.canonicalPath).toBeNull();
    expect(result.canonicalRefusal).toBe("outside_declared_root");
    expect(sha256(REAL_CANONICAL_SOUL)).toBe(before);
  });
});

describe("TD-406 — resolveCanonicalRoot containment rules", () => {
  it("a sibling whose path is a string prefix of the declared root is outside it", async () => {
    const root = join(workDir, "root");
    const sibling = join(workDir, "root-evil");
    mkdirSync(root, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    process.env.IGRIS_REPO_DIR = root;

    const { resolveCanonicalRoot } = await import("../lib/canonical-root.js");
    expect(resolveCanonicalRoot(root).allowed).toBe(true);
    expect(resolveCanonicalRoot(join(root, "sub")).allowed).toBe(true);
    expect(resolveCanonicalRoot(sibling)).toEqual({
      allowed: false,
      reason: "outside_declared_root",
      declaredRoot: root,
    });
  });

  it("a symlinked declared root contains its real target (realpath, not lexical)", async () => {
    const real = join(workDir, "real");
    mkdirSync(join(real, "checkout"), { recursive: true });
    const link = join(workDir, "link");
    symlinkSync(real, link);
    process.env.IGRIS_REPO_DIR = link;

    const { resolveCanonicalRoot } = await import("../lib/canonical-root.js");
    // Lexically `relative(<work>/link, <work>/real/checkout)` starts with "..";
    // only realpath resolution makes this the same subtree.
    expect(resolveCanonicalRoot(join(real, "checkout")).allowed).toBe(true);
  });

  it("falls back to lexical resolution when neither path exists yet", async () => {
    const root = join(workDir, "absent-root");
    process.env.IGRIS_REPO_DIR = root;

    const { resolveCanonicalRoot } = await import("../lib/canonical-root.js");
    expect(resolveCanonicalRoot(join(root, "sub")).allowed).toBe(true);
    expect(resolveCanonicalRoot(join(workDir, "absent-other")).allowed).toBe(
      false,
    );
  });

  it("outside a test context an undeclared root is ALLOWED (production is unchanged)", async () => {
    delete process.env.IGRIS_REPO_DIR;
    delete process.env.VITEST;
    process.env.NODE_ENV = "production";

    const { resolveCanonicalRoot, isTestContext } = await import(
      "../lib/canonical-root.js"
    );
    expect(isTestContext()).toBe(false);
    expect(resolveCanonicalRoot(REPO_ROOT)).toEqual({
      allowed: true,
      root: REPO_ROOT,
    });
  });

  it("VITEST and NODE_ENV=test each detect a test context on their own", async () => {
    const { isTestContext } = await import("../lib/canonical-root.js");

    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    expect(isTestContext()).toBe(false);

    process.env.VITEST = "true";
    expect(isTestContext()).toBe(true);

    delete process.env.VITEST;
    process.env.NODE_ENV = "test";
    expect(isTestContext()).toBe(true);
  });
});
