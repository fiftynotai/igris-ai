/**
 * Brain Engine v5.0 — FR-111 igris_brief_graph_render handler
 *
 * Thin MCP wrapper over the visualization data layer. Reads the live
 * brain DB, assembles a project's graph payload, and writes the HTML
 * file to disk. The HTML template lives in
 * `brain-mcp-server/scripts/render_brief_graph.template.html` and is
 * loaded by absolute path computed relative to this module — works
 * whether we're running from `src/` (tsx, dev) or `dist/` (built MCP
 * server, prod) since the template path is anchored to the repo via
 * a relative ascent (`../../../../../scripts/...` from
 * `dist/engine/components/edges/`).
 *
 * @module engine/components/edges/visualization-tool
 * @author Fifty.ai
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getDb } from '../../../db.js';
import type { ToolResult } from '../../types.js';
import { errorResult, successResult } from '../../helpers.js';
import {
  fetchProjectGraphRows,
  assembleGraphPayload,
  renderHtml,
  type GraphPayload,
} from './visualization.js';

// ---------------------------------------------------------------------------
// Template resolution
// ---------------------------------------------------------------------------

/**
 * Locate the bundled HTML template. The template is project-relative
 * (lives in `scripts/`) and is NOT compiled into `dist/`, so we resolve it
 * by walking up from this module to the package root and into `scripts/`.
 *
 * Layout (dev, tsx):
 *   src/engine/components/edges/visualization-tool.ts
 *   scripts/render_brief_graph.template.html
 *   -> ascent: ../../../../scripts
 *
 * Layout (built, dist):
 *   dist/engine/components/edges/visualization-tool.js
 *   scripts/render_brief_graph.template.html
 *   -> ascent: ../../../../scripts
 *
 * The two layouts are identical in depth, so a single ascent works.
 */
function templatePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', '..', '..', '..', 'scripts', 'render_brief_graph.template.html');
}

/** Default output directory for renders. */
function defaultOutDir(project: string): string {
  return path.join(os.homedir(), '.igris', 'projects', project, 'visualizations');
}

/** Build a filesystem-safe timestamp slug from an ISO string. */
function timestampSlug(iso: string): string {
  return iso.replace(/[:.]/g, '-').replace('T', '_').replace(/Z$/, '');
}

// ---------------------------------------------------------------------------
// Programmatic entry — also used by the standalone CLI script
// ---------------------------------------------------------------------------

/** Result returned by `renderGraphForProject`. */
export interface RenderResult {
  outPath: string;
  payload: GraphPayload;
  renderTimeMs: number;
  htmlSizeBytes: number;
}

/**
 * Render a project's brief graph to a self-contained HTML file using the
 * provided database connection. Used by both the MCP handler (which passes
 * the live brain DB via getDb()) and the CLI script (which opens its own
 * read-only handle).
 */
export function renderGraphFromDb(args: {
  // Use a structural type so the test DB shape (better-sqlite3) and the prod
  // DB shape work without coupling to a specific Database.Database import.
  db: Parameters<typeof fetchProjectGraphRows>[0];
  project: string;
  outPath?: string;
  generatedAt?: string;
  templateFile?: string;
}): RenderResult {
  const t0 = Date.now();
  const generatedAt = args.generatedAt ?? new Date().toISOString();

  const rows = fetchProjectGraphRows(args.db, args.project);
  const payload = assembleGraphPayload(rows, args.project, generatedAt);

  const tmpl = fs.readFileSync(args.templateFile ?? templatePath(), 'utf8');
  const html = renderHtml(tmpl, payload);

  const outPath = args.outPath
    ?? path.join(defaultOutDir(args.project), `briefs-graph-${timestampSlug(generatedAt)}.html`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');
  const stats = fs.statSync(outPath);

  return {
    outPath,
    payload,
    renderTimeMs: Date.now() - t0,
    htmlSizeBytes: stats.size,
  };
}

// ---------------------------------------------------------------------------
// MCP handler
// ---------------------------------------------------------------------------

/**
 * MCP handler for `igris_brief_graph_render`.
 *
 * Required arg: `project` (string).
 * Optional arg: `output_path` (string).
 *
 * Behavior:
 *   - Project not found / no briefs: returns success with empty graph stats
 *     (NOT an error — empty is a valid state).
 *   - Throws are caught and returned as errorResult so the MCP gateway
 *     surfaces them with isError=true.
 *
 * Returns JSON: { output_path, node_count, edge_count, goal_count,
 *                 god_nodes, render_time_ms, html_size_bytes }.
 */
export function handleBriefGraphRender(args: Record<string, unknown>): ToolResult {
  const project = args.project;
  if (typeof project !== 'string' || !project) {
    return errorResult('Missing required field: project');
  }

  const outputPath = args.output_path;
  if (outputPath !== undefined && typeof outputPath !== 'string') {
    return errorResult('output_path must be a string');
  }

  try {
    const db = getDb();
    const result = renderGraphFromDb({
      db,
      project,
      outPath: outputPath as string | undefined,
    });
    return successResult(
      JSON.stringify(
        {
          output_path: result.outPath,
          node_count: result.payload.nodes.length,
          edge_count: result.payload.edges.length,
          goal_count: result.payload.stats.goal_count,
          god_nodes: result.payload.god_nodes,
          render_time_ms: result.renderTimeMs,
          html_size_bytes: result.htmlSizeBytes,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`Render failed: ${msg}`);
  }
}
