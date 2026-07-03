/**
 * FR-209 — context-docs inventory tests.
 *
 * Uses a real sandboxed brain root (`IGRIS_BRAIN_DIR`) with fake runtime
 * catalog docs, fake project context docs, and tiny `projects` tables. No core
 * files are touched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;
let savedEnv: NodeJS.ProcessEnv;

const SLUG = "demo";

function catalogDir(): string {
  return join(tmpRoot, "core", "context-doc-types");
}

function contextDir(): string {
  return join(tmpRoot, "projects", SLUG, "context");
}

function projectPath(): string {
  return join(tmpRoot, "workspace", SLUG);
}

function writeCatalogDoc(input: {
  type: string;
  target?: string;
  applies_when: string;
  optional?: boolean;
  summary?: string;
}): void {
  mkdirSync(catalogDir(), { recursive: true });
  writeFileSync(
    join(catalogDir(), `${input.type}.md`),
    [
      "---",
      `type: ${input.type}`,
      `target: ${input.target ?? `${input.type}.md`}`,
      `applies_when: "${input.applies_when}"`,
      `optional: ${input.optional ?? true}`,
      `summary: "${input.summary ?? input.type}"`,
      "---",
      "",
      `# ${input.type}`,
      "",
    ].join("\n"),
    "utf-8",
  );
}

function writeContextDoc(target: string): void {
  mkdirSync(contextDir(), { recursive: true });
  writeFileSync(join(contextDir(), target), `# ${target}\n`, "utf-8");
}

function seedProject(input: {
  archetype?: string | null;
  tech_stack?: string | null;
  path?: string;
}): void {
  const dbDir = join(tmpRoot, "memory");
  mkdirSync(dbDir, { recursive: true });
  const db = new Database(join(dbDir, "knowledge.db"));
  db.exec(`
    CREATE TABLE projects (
      slug TEXT PRIMARY KEY,
      path TEXT,
      archetype TEXT,
      tech_stack TEXT
    );
  `);
  db.prepare(
    "INSERT INTO projects (slug, path, archetype, tech_stack) VALUES (?, ?, ?, ?)",
  ).run(
    SLUG,
    input.path ?? projectPath(),
    input.archetype ?? null,
    input.tech_stack ?? null,
  );
  db.close();
}

async function closeBrainDb(): Promise<void> {
  (await import("../lib/brain-db.js")).closeDb();
}

async function inventory() {
  const { buildContextDocsInventoryDigest } = await import(
    "../verbs/context-docs.js"
  );
  return buildContextDocsInventoryDigest(SLUG);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-context-docs-"));
  savedEnv = { ...process.env };
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
});

afterEach(async () => {
  await closeBrainDb();
  process.env = savedEnv;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("context-docs inventory", () => {
  it("reports missing applicable docs and remediation", async () => {
    writeCatalogDoc({
      type: "coding_guidelines",
      applies_when: "all projects (every project has code conventions)",
      optional: false,
    });
    writeCatalogDoc({
      type: "test_standards",
      applies_when: "testable projects (has automated tests or a test harness)",
    });
    writeContextDoc("coding_guidelines.md");
    mkdirSync(join(projectPath(), "tests"), { recursive: true });
    writeFileSync(join(projectPath(), "tests", "inventory.test.ts"), "test();\n");
    seedProject({
      archetype: "node-cli",
      tech_stack: "typescript, node",
    });

    const digest = await inventory();

    expect(digest.degraded).toBe(false);
    expect(digest.archetype).toBe("node-cli");
    expect(digest.tech_stack).toBe("typescript, node");
    expect(digest.missing_applicable).toEqual(["test_standards"]);
    expect(digest.remediation).toEqual(["/ground test_standards"]);
    expect(
      digest.docs.find((doc) => doc.type === "test_standards"),
    ).toMatchObject({
      applies: "yes",
      exists: false,
      missing_applicable: true,
    });
  });

  it("returns no missing docs for a fully grounded applicable project", async () => {
    writeCatalogDoc({
      type: "coding_guidelines",
      applies_when: "all projects (every project has code conventions)",
      optional: false,
    });
    writeCatalogDoc({
      type: "api_pattern",
      applies_when:
        "API-bearing projects (exposes or consumes an API — endpoints, RPC, or a typed client)",
    });
    writeContextDoc("coding_guidelines.md");
    writeContextDoc("api_pattern.md");
    mkdirSync(projectPath(), { recursive: true });
    writeFileSync(
      join(projectPath(), "package.json"),
      JSON.stringify({ dependencies: { express: "^4.0.0" } }),
      "utf-8",
    );
    seedProject({
      archetype: "backend-service",
      tech_stack: "typescript",
    });

    const digest = await inventory();

    expect(digest.degraded).toBe(false);
    expect(digest.missing_applicable).toEqual([]);
    expect(digest.docs.map((doc) => [doc.type, doc.applies, doc.exists])).toEqual([
      ["api_pattern", "yes", true],
      ["coding_guidelines", "yes", true],
    ]);
  });

  it("keeps unrecognized applies_when predicates unknown, not missing-applicable", async () => {
    writeCatalogDoc({
      type: "security_model",
      applies_when: "projects with bespoke compliance models",
    });
    seedProject({
      archetype: "backend-service",
      tech_stack: "typescript, express, api",
    });

    const digest = await inventory();

    expect(digest.docs).toHaveLength(1);
    expect(digest.docs[0]).toMatchObject({
      type: "security_model",
      applies: "unknown",
      exists: false,
      missing_applicable: false,
    });
    expect(digest.missing_applicable).toEqual([]);
  });

  it("does not infer UI-bearing from build scripts in a non-UI Node CLI", async () => {
    writeCatalogDoc({
      type: "design_system",
      applies_when: "UI-bearing projects (has a frontend / visual or design surface)",
    });
    mkdirSync(projectPath(), { recursive: true });
    writeFileSync(
      join(projectPath(), "package.json"),
      JSON.stringify({
        scripts: {
          build: "tsc",
        },
        dependencies: {
          commander: "^12.0.0",
        },
      }),
      "utf-8",
    );
    seedProject({
      archetype: "cli",
      tech_stack: "typescript, node",
    });

    const digest = await inventory();

    expect(digest.docs[0]).toMatchObject({
      type: "design_system",
      applies: "no",
      exists: false,
      missing_applicable: false,
    });
    expect(digest.missing_applicable).toEqual([]);
  });

  it("degrades gracefully when the brain DB is absent", async () => {
    writeCatalogDoc({
      type: "coding_guidelines",
      applies_when: "all projects (every project has code conventions)",
      optional: false,
    });
    // Intentionally do not create memory/knowledge.db.

    const digest = await inventory();

    expect(digest.degraded).toBe(true);
    expect(digest.project).toBe(SLUG);
    expect(digest.archetype).toBeNull();
    expect(digest.tech_stack).toBeNull();
    expect(digest.docs[0]).toMatchObject({
      type: "coding_guidelines",
      applies: "yes",
      exists: false,
      missing_applicable: true,
    });
  });
});
