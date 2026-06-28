/**
 * `igris context-docs inventory` — FR-209 CLI primitive.
 *
 * Reads the runtime context-doc catalog from
 * `<brain>/core/context-doc-types/*.md`, joins it to a project's existing
 * `<brain>/projects/<slug>/context/` docs, and emits a deterministic inventory.
 * Applicability stays local to this verb: the shipped catalog predicates are
 * matched by explicit heuristics, while unrecognized predicates return
 * `unknown` rather than guessing.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { readProjectProfile } from "../lib/brain-db.js";
import { contextDocTypesDir, projectContextDir } from "../lib/paths.js";
import type {
  ContextDocApplies,
  ContextDocInventoryRow,
  ContextDocsInventoryDigest,
  ProjectProfile,
} from "../types.js";

export type ContextDocsAction = "inventory";

export interface ContextDocsOptions {
  action: ContextDocsAction;
  project?: string;
  json?: boolean;
}

interface CatalogDoc {
  type: string;
  target: string;
  applies_when: string;
  optional: boolean;
  summary: string;
}

interface ProjectEvidence {
  text: string;
  structural: boolean;
  api: boolean;
  ui: boolean;
  testable: boolean;
}

const YES_MARKERS = new Set(["true", "yes", "1"]);
const NO_MARKERS = new Set(["false", "no", "0"]);
const MAX_PROJECT_SCAN_ENTRIES = 2_000;
const MAX_PROJECT_SCAN_DEPTH = 4;

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---", 4);
  if (end === -1) return {};

  const raw = text.slice(4, end);
  const fields: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf(":");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = stripQuotes(trimmed.slice(separator + 1));
    if (key.length > 0) fields[key] = value;
  }
  return fields;
}

function parseOptional(value: string | undefined): boolean {
  if (value === undefined) return true;
  const normalized = value.trim().toLowerCase();
  if (YES_MARKERS.has(normalized)) return true;
  if (NO_MARKERS.has(normalized)) return false;
  return true;
}

function readCatalogDocs(): { degraded: boolean; docs: CatalogDoc[] } {
  const dir = contextDocTypesDir();
  if (!existsSync(dir)) return { degraded: true, docs: [] };

  const docs: CatalogDoc[] = [];
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== "INDEX.md")
    .sort((a, b) => a.localeCompare(b));

  for (const file of files) {
    const path = join(dir, file);
    const fields = parseFrontmatter(readFileSync(path, "utf-8"));
    const fallbackType = basename(file, ".md");
    const type = fields.type ?? fallbackType;
    const target = fields.target ?? `${type}.md`;
    docs.push({
      type,
      target,
      applies_when: fields.applies_when ?? "",
      optional: parseOptional(fields.optional),
      summary: fields.summary ?? "",
    });
  }

  docs.sort((a, b) => a.type.localeCompare(b.type));
  return { degraded: false, docs };
}

function profileText(profile: ProjectProfile | null): string {
  return [
    profile?.slug,
    profile?.path,
    profile?.archetype,
    profile?.tech_stack,
  ]
    .filter((value): value is string => value !== null && value !== undefined)
    .join(" ")
    .toLowerCase();
}

function readPackageTokens(projectPath: string): string[] {
  const packageJsonPath = join(projectPath, "package.json");
  if (!existsSync(packageJsonPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      scripts?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
      peerDependencies?: Record<string, unknown>;
    };
    return [
      ...Object.keys(pkg.scripts ?? {}),
      ...Object.values(pkg.scripts ?? {}).map(String),
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ].map((value) => value.toLowerCase());
  } catch {
    return [];
  }
}

function scanProjectPath(projectPath: string): string[] {
  if (!existsSync(projectPath)) return [];

  const tokens: string[] = [];
  const stack: Array<{ path: string; depth: number }> = [
    { path: projectPath, depth: 0 },
  ];

  while (stack.length > 0 && tokens.length < MAX_PROJECT_SCAN_ENTRIES) {
    const current = stack.pop();
    if (current === undefined) break;

    let entries: string[];
    try {
      entries = readdirSync(current.path);
    } catch {
      continue;
    }

    entries.sort((a, b) => a.localeCompare(b));
    for (const entry of entries) {
      if (tokens.length >= MAX_PROJECT_SCAN_ENTRIES) break;
      if (
        entry === ".git" ||
        entry === ".igris" ||
        entry === "context-doc-types" ||
        entry === "node_modules" ||
        entry === "dist" ||
        entry === "build" ||
        entry === ".next"
      ) {
        continue;
      }

      const fullPath = join(current.path, entry);
      tokens.push(entry.toLowerCase());
      if (current.depth >= MAX_PROJECT_SCAN_DEPTH) continue;

      try {
        if (statSync(fullPath).isDirectory()) {
          stack.push({ path: fullPath, depth: current.depth + 1 });
        }
      } catch {
        // Ignore unreadable or disappearing entries; inventory is diagnostic.
      }
    }
  }

  return tokens;
}

function evidenceFor(profile: ProjectProfile | null): ProjectEvidence {
  const profileOnly = profileText(profile);
  const projectPath = profile?.path;
  const filesystemTokens =
    projectPath !== null && projectPath !== undefined
      ? [...scanProjectPath(projectPath), ...readPackageTokens(projectPath)]
      : [];
  const filesystemText = filesystemTokens.join(" ");
  const text = `${profileOnly} ${filesystemText}`.toLowerCase();

  const testable = hasAnySubstring(filesystemText, [
    ".bats",
    ".spec.",
    ".test.",
    "__tests__",
    "bats",
    "cypress",
    "jest",
    "playwright",
    "pytest",
    "test",
    "tests",
    "vitest",
    "vitest.config.js",
    "vitest.config.mjs",
    "vitest.config.ts",
  ]);

  const api = hasAnySubstring(filesystemText, [
    "api",
    "controllers",
    "endpoint",
    "endpoints",
    "express",
    "fastify",
    "graphql",
    "koa",
    "mcp",
    "mcp-server",
    "openapi",
    "openapi.yaml",
    "openapi.yml",
    "routes",
    "rpc",
    "server",
  ]);

  const ui = hasAnySubstring(filesystemText, [
    "app.jsx",
    "app.tsx",
    "components",
    ".html",
    "images",
    "next",
    "presentations",
    "react",
    "svelte",
    "tailwind",
    "vite",
    "vue",
  ]) || hasAnyTerm(filesystemText, ["ui"]);

  const structural = hasAnySubstring(filesystemText, [
    "package.json",
    "pyproject.toml",
    "src",
    "lib",
    "cli",
    "server",
    "app",
  ]);

  return { text, structural, api, ui, testable };
}

function hasAnySubstring(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function hasAnyTerm(haystack: string, needles: string[]): boolean {
  const normalizedHaystack = ` ${haystack
    .replace(/[^a-z0-9.+#-]+/g, " ")
    .replace(/\s+/g, " ")} `;
  return needles.some((needle) => {
    const normalizedNeedle = needle
      .toLowerCase()
      .replace(/[^a-z0-9.+#-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return normalizedNeedle.length > 0
      ? normalizedHaystack.includes(` ${normalizedNeedle} `)
      : false;
  });
}

function appliesFor(
  appliesWhen: string,
  evidence: ProjectEvidence,
): ContextDocApplies {
  const predicate = appliesWhen.toLowerCase();
  const text = evidence.text;

  if (predicate.includes("all projects")) return "yes";

  if (predicate.includes("structural projects")) {
    if (evidence.structural) return "yes";
    if (
      hasAnyTerm(text, [
        "ai-agent-system",
        "application",
        "app",
        "backend",
        "cli",
        "frontend",
        "library",
        "monorepo",
        "package",
        "service",
        "system",
      ])
    ) {
      return "yes";
    }
    if (hasAnyTerm(text, ["single-file", "single script", "notes", "documentation-only"])) {
      return "no";
    }
    return "unknown";
  }

  if (predicate.includes("api-bearing projects")) {
    if (evidence.api) return "yes";
    if (
      hasAnyTerm(text, [
        "api",
        "client",
        "endpoint",
        "express",
        "fastify",
        "graphql",
        "http",
        "mcp",
        "openapi",
        "rpc",
        "server",
      ])
    ) {
      return "yes";
    }
    if (hasAnyTerm(text, ["cli", "static", "documentation-only", "notes"])) {
      return "no";
    }
    return "unknown";
  }

  if (predicate.includes("ui-bearing projects")) {
    if (evidence.ui) return "yes";
    if (
      hasAnyTerm(text, [
        "android",
        "angular",
        "design",
        "frontend",
        "ios",
        "mobile",
        "next",
        "react",
        "svelte",
        "ui",
        "vue",
        "web",
      ])
    ) {
      return "yes";
    }
    if (hasAnyTerm(text, ["api", "backend", "cli", "library", "server"])) {
      return "no";
    }
    return "unknown";
  }

  if (predicate.includes("testable projects")) {
    if (evidence.testable) return "yes";
    if (
      hasAnyTerm(text, [
        "bats",
        "cypress",
        "jest",
        "junit",
        "playwright",
        "pytest",
        "test",
        "vitest",
        "xunit",
      ])
    ) {
      return "yes";
    }
    if (hasAnyTerm(text, ["no-tests", "untested", "documentation-only", "notes"])) {
      return "no";
    }
    return "unknown";
  }

  return "unknown";
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function renderHuman(digest: ContextDocsInventoryDigest): string {
  const lines = [
    `# Context docs inventory: ${digest.project}`,
    "",
    "| Type | Target | Applies | Exists | Optional | Summary |",
    "|---|---|---:|---:|---:|---|",
  ];

  for (const doc of digest.docs) {
    lines.push(
      `| ${escapeCell(doc.type)} | ${escapeCell(doc.target)} | ${doc.applies} | ${
        doc.exists ? "yes" : "no"
      } | ${doc.optional ? "yes" : "no"} | ${escapeCell(doc.summary)} |`,
    );
  }

  if (digest.degraded) {
    lines.push("");
    lines.push("Inventory degraded: project profile or catalog data was incomplete.");
  }

  if (digest.missing_applicable.length > 0) {
    lines.push("");
    lines.push(`Remediation: ${digest.remediation.join(", ")}`);
  }

  return `${lines.join("\n")}\n`;
}

export function buildContextDocsInventoryDigest(
  slug: string,
): ContextDocsInventoryDigest {
  const projectProfile = readProjectProfile(slug);
  const catalog = readCatalogDocs();
  const contextDir = projectContextDir(slug);
  const evidence = evidenceFor(projectProfile.profile);

  const docs: ContextDocInventoryRow[] = catalog.docs.map((doc) => {
    const exists = existsSync(join(contextDir, doc.target));
    const applies = appliesFor(doc.applies_when, evidence);
    const missingApplicable = applies === "yes" && !exists;
    return {
      type: doc.type,
      target: doc.target,
      applies_when: doc.applies_when,
      applies,
      optional: doc.optional,
      summary: doc.summary,
      exists,
      missing_applicable: missingApplicable,
    };
  });

  const missingApplicable = docs
    .filter((doc) => doc.missing_applicable)
    .map((doc) => doc.type);

  return {
    project: slug,
    archetype: projectProfile.profile?.archetype ?? null,
    tech_stack: projectProfile.profile?.tech_stack ?? null,
    degraded: projectProfile.degraded || catalog.degraded,
    docs,
    missing_applicable: missingApplicable,
    remediation: missingApplicable.map((type) => `/ground ${type}`),
  };
}

export function runContextDocs(opts: ContextDocsOptions): number {
  if (opts.action !== "inventory") {
    process.stderr.write(
      `context-docs: unknown action '${opts.action}'. Expected 'inventory'.\n`,
    );
    return 2;
  }
  if (opts.project === undefined || opts.project.trim().length === 0) {
    process.stderr.write("context-docs inventory: --project <slug> is required\n");
    return 2;
  }

  const digest = buildContextDocsInventoryDigest(opts.project);
  if (opts.json === true) {
    process.stdout.write(JSON.stringify(digest) + "\n");
  } else {
    process.stdout.write(renderHuman(digest));
  }
  return 0;
}
