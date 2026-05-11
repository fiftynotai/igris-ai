/**
 * FR-111 — CLI: Render an offline HTML force-directed graph of a project's briefs.
 *
 * This script is a thin wrapper around `renderGraphFromDb` (in
 * `src/engine/components/edges/visualization-tool.ts`). It opens a read-only
 * connection to the brain DB and delegates rendering to the shared module.
 *
 * Usage:
 *   tsx scripts/render_brief_graph.ts --project <slug> [--out <path>] [--db <path>]
 *
 * The MCP handler `igris_brief_graph_render` reuses the same `renderGraphFromDb`
 * function with the live `getDb()` connection, so the two entry points are
 * guaranteed to produce identical output for identical inputs.
 *
 * @module scripts/render_brief_graph
 * @author Fifty.ai
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  renderGraphFromDb,
  type RenderResult,
} from '../src/engine/components/edges/visualization-tool.js';

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

/** CLI options. */
export interface CliOptions {
  /** Project slug (matches brief_status.project). Required. */
  project: string;
  /** Output HTML path. Defaults to ~/.igris/projects/{project}/visualizations/briefs-graph-{ts}.html. */
  outPath?: string;
  /** Database path override. Defaults to ~/.igris/memory/knowledge.db. */
  dbPath?: string;
  /** Fixed timestamp for deterministic output (test injection). */
  generatedAt?: string;
}

const DEFAULT_DB_PATH = path.join(os.homedir(), '.igris', 'memory', 'knowledge.db');

// ---------------------------------------------------------------------------
// renderGraphForProject — programmatic entry point (CLI + tests)
// ---------------------------------------------------------------------------

/**
 * Open a read-only connection to the brain DB and render the project graph.
 *
 * Throws if the DB file is missing. Returns an empty-graph result (NOT an
 * error) when the project has no briefs.
 *
 * @param opts - CLI options.
 * @returns RenderResult with outPath, payload, render duration, file size.
 */
export function renderGraphForProject(opts: CliOptions): RenderResult {
  if (!opts.project) {
    throw new Error('renderGraphForProject: project is required');
  }
  const dbPath = opts.dbPath ?? DEFAULT_DB_PATH;
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Brain DB not found at ${dbPath}`);
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    return renderGraphFromDb({
      db,
      project: opts.project,
      outPath: opts.outPath,
      generatedAt: opts.generatedAt,
    });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * Parse argv into CliOptions. Supports:
 *   --project <slug> (required)
 *   --out <path>     (optional)
 *   --db <path>      (optional)
 */
function parseArgv(argv: string[]): CliOptions {
  const opts: Partial<CliOptions> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project' && argv[i + 1]) {
      opts.project = argv[++i];
    } else if (arg === '--out' && argv[i + 1]) {
      opts.outPath = argv[++i];
    } else if (arg === '--db' && argv[i + 1]) {
      opts.dbPath = argv[++i];
    }
  }
  if (!opts.project) {
    throw new Error('Usage: tsx scripts/render_brief_graph.ts --project <slug> [--out <path>] [--db <path>]');
  }
  return opts as CliOptions;
}

async function main(): Promise<void> {
  const opts = parseArgv(process.argv.slice(2));
  const result = renderGraphForProject(opts);
  console.log(JSON.stringify({
    ok: true,
    output_path: result.outPath,
    node_count: result.payload.nodes.length,
    edge_count: result.payload.edges.length,
    goal_count: result.payload.stats.goal_count,
    god_nodes: result.payload.god_nodes,
    render_time_ms: result.renderTimeMs,
    html_size_bytes: result.htmlSizeBytes,
  }, null, 2));
}

// Run main only when invoked directly via tsx, not when imported by tests/handlers.
// Exact-equality guard: compares the resolved module path to the resolved argv[1].
// More portable than basename regex — survives renames, transpiled .js entry,
// and avoids false positives from any caller whose script ends with the same name.
const isMain = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '');

if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
