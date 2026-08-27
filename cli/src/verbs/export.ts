/**
 * `igris export <project>` — the project-handoff PRODUCER (FR-229).
 *
 * Serializes ONE project's brain slice into a portable, self-describing
 * `<slug>.igris-pack.tar.gz`. This is the PRODUCER half only — NO import / merge
 * / apply logic (that is FR-230), no `/handoff` skill, no formalized contract
 * row (FR-231).
 *
 * Channel: LOCAL — better-sqlite3 reads via `brain-db.ts` + raw context-doc file
 * reads from `projectContextDir(slug)`. No network.
 *
 * Degradation: UNLIKE `assess`, a missing brain DB (`caps.brain_db` false) is a
 * HARD failure (typed error + non-zero exit) — an export with no source DB has
 * nothing to serialize.
 *
 * Egress discipline (MAINTAINING row #100): the exporter is a NEW egress choke
 * point. Every row passes through `redactTablesForEgress` BEFORE anything is
 * written to disk, and the manifest carries only the project SLUG (never its
 * absolute path). The redaction is a defensive no-op for the current store set
 * (no exported table carries `redactCols`) but stays wired for future tiers.
 *
 * Tier map (reconciled to the FR-229 brief, which widens the plan's `full`):
 *   - core     = brief_status + brief_files
 *   - standard = core + entity_edges(brief↔brief) + goals + context_docs (DEFAULT)
 *   - full     = standard + learnings(approved) + errors + project concept-graph
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectCapabilities } from "../lib/detect.js";
import {
  readApprovedLearnings,
  readBriefBriefEdges,
  readBriefFilesRows,
  readBriefStatusRows,
  readConceptEdges,
  readConceptNodes,
  readProjectErrors,
  readProjectGoals,
  redactTablesForEgress,
  exportTableConfig,
  EXPORT_TABLES,
} from "../lib/brain-db.js";
import { packDir, TarballError } from "../lib/tarball.js";
import { projectContextDir } from "../lib/paths.js";
import { error as logError, warn } from "../lib/log.js";
import type {
  ExportDigest,
  ExportManifest,
  ExportOptions,
  ExportStoreDescriptor,
  ExportTier,
} from "../types.js";

/** Raised when the export cannot proceed (hard failures; the verb exits non-zero). */
export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportError";
  }
}

/**
 * A row-backed store spec: the manifest key + data-file basename, the target DB
 * `table` (for FR-230), and the reader. `context_docs` is handled separately
 * (disk-backed, no DB table).
 */
interface StoreSpec {
  /** Manifest key + `data/<name>.json` basename (distinct from `table`). */
  name: string;
  /** Target DB table for the FR-230 importer. */
  table: string;
  read: (slug: string, since?: string) => Record<string, unknown>[];
}

/**
 * The row-backed stores, in a stable order. `concept_edges` reuses the
 * `entity_edges` DB table (its own file so it never collides with the standard
 * brief↔brief `entity_edges.json`).
 */
const ROW_STORES: Record<string, StoreSpec> = {
  brief_status: { name: "brief_status", table: "brief_status", read: readBriefStatusRows },
  brief_files: { name: "brief_files", table: "brief_files", read: readBriefFilesRows },
  entity_edges: { name: "entity_edges", table: "entity_edges", read: readBriefBriefEdges },
  goals: { name: "goals", table: "goals", read: readProjectGoals },
  learnings: { name: "learnings", table: "learnings", read: readApprovedLearnings },
  errors: { name: "errors", table: "errors", read: readProjectErrors },
  graph_nodes: { name: "graph_nodes", table: "graph_nodes", read: readConceptNodes },
  concept_edges: { name: "concept_edges", table: "entity_edges", read: readConceptEdges },
};

/** The special disk-backed store name (context docs read from projectContextDir). */
const CONTEXT_DOCS = "context_docs";

/** Tier → the store names it includes (each tier is a superset of the previous). */
const TIER_STORES: Record<ExportTier, string[]> = {
  core: ["brief_status", "brief_files"],
  standard: ["brief_status", "brief_files", "entity_edges", "goals", CONTEXT_DOCS],
  full: [
    "brief_status",
    "brief_files",
    "entity_edges",
    "goals",
    CONTEXT_DOCS,
    "learnings",
    "errors",
    "graph_nodes",
    "concept_edges",
  ],
};

/** Every valid `--include` store name (row stores + context_docs). */
const ALL_STORE_NAMES = new Set<string>([...Object.keys(ROW_STORES), CONTEXT_DOCS]);

/**
 * Stores that are NEVER exported (self-described in the manifest so FR-230 knows
 * the omission is deliberate, not a truncation). Instances/session/queue/metrics
 * are machine-local; embeddings are re-derivable; loadout/catalog/definition are
 * global surface state, not a project slice.
 */
const EXCLUDED_STORES = [
  "instances",
  "session_files",
  "sessions",
  "sync_state",
  "sync_queue",
  "agent_metrics",
  "agent_events",
  // FR-268: the ceremony record is machine-keyed telemetry, not project content — replicated by sync, never exported.
  "ceremony_events",
  "suggestions",
  "dismissed_patterns",
  "embeddings",
  "loadout",
  "catalog",
  "definition_files",
  "schedules",
  "schedule_runs",
  "event_log",
  "skills",
  "agents",
  "hooks",
];

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Read the CLI package version for the manifest `producer` block. */
function readCliVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/verbs/export.js -> dist -> package root (mirror index.ts#readPackageVersion).
  const pkgPath = join(here, "..", "..", "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Resolve the effective store set for a tier + `--include` extras. Preserves the
 * tier order and appends any include-only extras, de-duplicated.
 */
function resolveStores(tier: ExportTier, include: string[]): string[] {
  const set = new Set<string>(TIER_STORES[tier]);
  for (const name of include) set.add(name);
  // Emit in a stable order: tier order first, then any include-only extras.
  const ordered: string[] = [...TIER_STORES[tier]];
  for (const name of include) {
    if (!ordered.includes(name)) ordered.push(name);
  }
  return ordered.filter((n) => set.has(n));
}

/** Build the store descriptor for one row-backed store. */
function rowStoreDescriptor(
  storeName: string,
  rows: Record<string, unknown>[],
): ExportStoreDescriptor {
  const spec = ROW_STORES[storeName];
  const cfg = exportTableConfig(spec.table);
  const descriptor: ExportStoreDescriptor = {
    file: `data/${storeName}.json`,
    count: rows.length,
    table: spec.table,
    columns: cfg.columns,
    syncKey: cfg.syncKey,
    strategy: cfg.strategy,
    timestampCol: cfg.timestampCol,
  };
  // brief_files: surface per-brief content_hash (recomputed from content so a
  // stale stored hash never ships — plan §Risks).
  if (storeName === "brief_files") {
    const hashes: Record<string, string> = {};
    for (const row of rows) {
      const briefId = String(row.brief_id ?? "");
      const content = typeof row.content === "string" ? row.content : "";
      if (briefId.length > 0) hashes[briefId] = sha256(content);
    }
    descriptor.content_hashes = hashes;
  }
  return descriptor;
}

/**
 * Read every context doc (`*.md`) from `projectContextDir(slug)`. Returns the
 * sorted filenames + their raw content. Missing dir → empty (degrade cleanly).
 */
function readContextDocs(slug: string): { filename: string; content: string }[] {
  const dir = projectContextDir(slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((filename) => ({
      filename,
      content: readFileSync(join(dir, filename), "utf-8"),
    }));
}

/** Result of the read/redact/stage pass, before packing. */
interface BuiltExport {
  manifest: ExportManifest;
  digest: ExportDigest;
  /** relative-path → content, the payload files to stage (data/ + context/). */
  files: Map<string, string>;
}

/**
 * Read the resolved stores, redact egress paths in place, hash the payload, and
 * assemble the manifest + staged-file map. Pure w.r.t. the filesystem OUTPUT
 * (only READS the brain DB + context docs) — the caller stages + packs.
 */
export function buildExport(
  slug: string,
  tier: ExportTier,
  include: string[],
  since: string | undefined,
): BuiltExport {
  const storeNames = resolveStores(tier, include);
  const files = new Map<string, string>();
  const stores: Record<string, ExportStoreDescriptor> = {};
  const counts: Record<string, number> = {};

  // 1. Read row-backed stores. Collect rows per DB TABLE so the row-100 egress
  //    redaction runs over shared row refs BEFORE any serialization.
  const rowsByStore: Record<string, Record<string, unknown>[]> = {};
  const byTable: Record<string, Record<string, unknown>[]> = {};
  for (const name of storeNames) {
    if (name === CONTEXT_DOCS) continue;
    const spec = ROW_STORES[name];
    const rows = spec.read(slug, since);
    rowsByStore[name] = rows;
    (byTable[spec.table] ??= []).push(...rows);
  }

  // 2. Egress redaction — MUST run before writing anything (row #100). Mutates
  //    the shared row objects in place, so the arrays in rowsByStore are redacted.
  redactTablesForEgress(byTable);

  // 3. Serialize row stores + build descriptors.
  for (const name of storeNames) {
    if (name === CONTEXT_DOCS) continue;
    const rows = rowsByStore[name];
    files.set(`data/${name}.json`, JSON.stringify(rows, null, 2) + "\n");
    stores[name] = rowStoreDescriptor(name, rows);
    counts[name] = rows.length;
  }

  // 4. Context docs (disk-backed).
  if (storeNames.includes(CONTEXT_DOCS)) {
    const docs = readContextDocs(slug);
    const fileNames: string[] = [];
    const hashes: Record<string, string> = {};
    for (const doc of docs) {
      files.set(`context/${doc.filename}`, doc.content);
      fileNames.push(`context/${doc.filename}`);
      hashes[doc.filename] = sha256(doc.content);
    }
    stores[CONTEXT_DOCS] = {
      count: docs.length,
      files: fileNames,
      hashes,
    };
    counts[CONTEXT_DOCS] = docs.length;
  }

  // 5. Payload checksum: sha256 over the ordered (path, content) pairs. The
  //    manifest is NOT part of its own checksum.
  const checksum = payloadChecksum(files);

  // 6. Redaction disclosure: which EXPORT_TABLES columns were redacted (empty
  //    today; self-describing for future tiers).
  const redactionCols: Record<string, string[]> = {};
  for (const cfg of EXPORT_TABLES) {
    if (cfg.redactCols && cfg.redactCols.length > 0) {
      redactionCols[cfg.table] = cfg.redactCols;
    }
  }

  const manifest: ExportManifest = {
    format: "igris-pack",
    format_version: 1,
    created_at: new Date().toISOString(),
    producer: { cli_version: readCliVersion() },
    project: { slug },
    tier,
    filters: { since: since ?? null, include },
    stores,
    excluded: EXCLUDED_STORES,
    redaction: { applied: true, cols: redactionCols },
    checksum,
  };
  files.set("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

  const digest: ExportDigest = {
    tier,
    stores: storeNames,
    counts,
    out_path: "",
    checksum,
  };

  return { manifest, digest, files };
}

/** Deterministic sha256 over the ordered (path, content) payload pairs. */
function payloadChecksum(files: Map<string, string>): string {
  const hash = createHash("sha256");
  for (const path of [...files.keys()].sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(files.get(path) ?? "");
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Default output path for a slug: `./<slug>.igris-pack.tar.gz`. */
function defaultOutPath(slug: string): string {
  return join(process.cwd(), `${slug}.igris-pack.tar.gz`);
}

function normalizeTier(raw: string | undefined): ExportTier {
  if (raw === undefined) return "standard";
  if (raw === "core" || raw === "standard" || raw === "full") return raw;
  throw new ExportError(
    `--tier value '${raw}' is not one of 'core' | 'standard' | 'full'`,
  );
}

/**
 * Run the export verb. Returns the process exit code (0 success, 1 hard
 * failure). On success, prints the JSON digest to stdout; progress/warnings go
 * to stderr so stdout stays a clean digest.
 */
export async function runExport(opts: ExportOptions): Promise<number> {
  const slug = opts.project;
  if (!slug || slug.length === 0) {
    logError("export: a <project> slug is required");
    return 2;
  }

  let tier: ExportTier;
  try {
    tier = normalizeTier(opts.tier);
  } catch (err) {
    logError(err instanceof Error ? err.message : String(err));
    return 2;
  }

  const include = opts.include ?? [];
  const unknown = include.filter((n) => !ALL_STORE_NAMES.has(n));
  if (unknown.length > 0) {
    logError(
      `export: unknown --include store(s): ${unknown.join(", ")} ` +
        `(valid: ${[...ALL_STORE_NAMES].sort().join(", ")})`,
    );
    return 2;
  }

  // HARD failure on a missing brain DB (unlike assess): nothing to serialize.
  const caps = detectCapabilities();
  if (!caps.brain_db) {
    logError(
      `export: brain DB not found at ${caps.brain_root}/memory/knowledge.db — ` +
        "nothing to export (run 'igris init' first).",
    );
    return 1;
  }

  const outPath = opts.out ?? defaultOutPath(slug);

  let staged: string | null = null;
  try {
    const built = buildExport(slug, tier, include, opts.since);

    // Stage the payload into a temp dir, then pack it into a single archive.
    staged = mkdtempSync(join(tmpdir(), "igris-export-"));
    for (const [rel, content] of built.files) {
      const abs = join(staged, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }

    await packDir(staged, outPath);

    built.digest.out_path = outPath;
    if (opts.json !== false) {
      process.stdout.write(JSON.stringify(built.digest) + "\n");
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof TarballError || err instanceof ExportError) {
      logError(`export: ${msg}`);
    } else {
      logError(`export failed: ${msg}`);
    }
    return 1;
  } finally {
    if (staged !== null && existsSync(staged)) {
      try {
        rmSync(staged, { recursive: true, force: true });
      } catch {
        warn(`export: could not clean staging dir ${staged}`);
      }
    }
  }
}
