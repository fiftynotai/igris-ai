# Brief Graph Visualization

**Brief:** FR-111
**MCP Tool:** `igris_brief_graph_render`
**Skill:** `/visualize`
**Component:** `edges` v1.2.0

The brief graph visualization renders an interactive, self-contained HTML
force-directed graph of a project's briefs and typed edges. It is built on
the same `entity_edges` typed-graph layer used by `igris_graph_neighbors`,
`igris_graph_path`, and `igris_graph_subgraph`.

## What It Does

- **Nodes**: Every brief in the project (from `brief_status`). Optionally
  goal nodes when at least one brief links to a goal via `serves_goal`.
- **Edges**: Typed connections between briefs (`parent_of`, `depends_on`,
  `blocks`, `supersedes`, `related_to`, `serves_goal`, `duplicates`,
  `derived_from`, `recurs_with`).
- **Layout**: Force-directed (ForceAtlas2) by default, with a one-click
  toggle to a top-down hierarchical tree.
- **Interaction**: Filter by node type and edge type, free-text search,
  click-to-detail, god-node camera focus.

## Quickstart

### Via the skill

```
/visualize
```

Renders the current project's graph to
`~/.igris/projects/{project}/visualizations/briefs-graph-{timestamp}.html`
and auto-opens it in the default browser.

### Via the MCP tool

```json
{
  "name": "igris_brief_graph_render",
  "arguments": {
    "project": "igris-ai",
    "output_path": "/tmp/graph.html"
  }
}
```

Returns:

```json
{
  "output_path": "/tmp/graph.html",
  "node_count": 82,
  "edge_count": 14,
  "goal_count": 0,
  "god_nodes": ["brief|BR-004", "brief|BR-009", "brief|BR-010"],
  "render_time_ms": 17,
  "html_size_bytes": 213575
}
```

### Via the standalone script

```bash
cd brain-mcp-server
npx tsx scripts/render_brief_graph.ts --project igris-ai --out /tmp/graph.html
```

## Layout & Color Legend

### Node colors (by `brief_id` prefix)

| Prefix | Color    | Meaning                  |
| ------ | -------- | ------------------------ |
| FR     | Blue     | Feature Request          |
| TD     | Orange   | Technical Debt           |
| BR     | Red      | Bug Report               |
| PI     | Purple   | Process Improvement      |
| MG     | Green    | Migration                |
| AC     | Teal     | Acceptance Criteria      |
| TS     | Light Green | Test Strategy         |
| DU     | Gray     | Documentation Update     |
| PF     | Yellow   | Performance              |
| goal   | Gold     | Goal (diamond shape)     |

### Edge colors (by `edge_type`)

| Edge type     | Color    |
| ------------- | -------- |
| `parent_of`   | Blue     |
| `depends_on`  | Orange   |
| `blocks`      | Red      |
| `supersedes`  | Magenta  |
| `related_to`  | Gray     |
| `serves_goal` | Gold     |
| `duplicates`  | Green    |
| `derived_from`| Teal     |
| `recurs_with` | Orange   |

### Node size

Node radius scales with degree as `10 + sqrt(degree) * 4`. Goal nodes have
a base size bonus (`22 + sqrt(degree) * 4`) so they read as anchors.

## Filter Sidebar

The left sidebar provides:

- **Node Types** filter (one checkbox per brief-id prefix). Toggle to
  hide/show all nodes in that group. Counts are shown next to each.
- **Edge Types** filter (one checkbox per edge type). Toggling an edge
  type also hides edges whose endpoints are themselves hidden.
- **God Nodes** panel: top 3 nodes by total degree (in + out). Click any
  entry to focus the camera on that node and load its detail card.

## Search

Typing in the search box highlights nodes whose `brief_id` or title
contains the query (case-insensitive). Matching nodes get a 4px white
border; non-matching nodes drop to 20% opacity. Clearing the search box
restores the default rendering.

## Click-to-Detail

Clicking any node populates the right sidebar with:

- Brief title and id
- Status, priority, and brief type pills
- Effort, phase, last-updated timestamp, degree
- Brief content (truncated at 8 KB — open the brief file for the full text)

The detail panel uses `textContent` (not `innerHTML`), so brief content
that contains HTML or `<script>` tags renders as plain text.

## Performance Bounds

| Metric        | Target | Notes                                                |
| ------------- | ------ | ---------------------------------------------------- |
| Node count    | ≤200   | vis-network handles 200 nodes smoothly              |
| Edge count    | ≤500   | Standard force-directed convergence in ~1500 iters  |
| Render time   | <500ms | Single SQL pass + template substitute + write       |
| HTML size     | <1.5MB | At 200/500 with full content embedded               |

For larger projects (1000+ briefs), the renderer continues to work, but
the embedded content cap (8 KB per brief) becomes important to avoid
multi-megabyte HTML files. A `--lite` mode that strips brief content is
planned for Phase 2.

## Limitations (Phase 1)

- **Read-only.** You cannot edit briefs or edges from the visualization.
- **No live updates.** Re-run `/visualize` to refresh.
- **Single project.** Cross-project graphs are not yet supported.
- **CDN dependency.** vis-network is loaded from `unpkg.com`. Once the
  HTML has been opened once with internet access, the browser caches the
  CDN; subsequent loads work offline. Phase 2 will add an `--inline` mode
  that vendors the JS into the HTML.
- **No edge weighting.** Edge thickness reflects `confidence` (0..1) but
  there's no weight slider in the UI.
- **`output_path` is unrestricted.** The `igris_brief_graph_render` MCP
  tool accepts arbitrary file paths writable by the brain process — by
  design, since the tool is internal and called by trusted skills (`/visualize`)
  or operators. Shared-environment deployments should default callers to
  the per-project visualization directory under
  `~/.igris/projects/{project}/visualizations/` rather than passing a
  user-supplied `output_path`. See
  `src/engine/components/edges/visualization-tool.ts` for the handler.

## Architecture

Two modules in `brain-mcp-server/src/engine/components/edges/`:

- `visualization.ts` — pure data layer. SQL queries against `brief_status`,
  `entity_edges`, `goals`, and `brief_files`. Soft-delete filter matches
  `handleEdgeList` semantics
  (`COALESCE(json_extract(metadata,'$.deleted'), 0) = 0`). Computes degree
  and god nodes in O(E + N log N).
- `visualization-tool.ts` — MCP handler + shared `renderGraphFromDb`
  function. Loads the HTML template by ascending from the module path to
  the package root (works in both dev/`src/` and prod/`dist/` layouts).

The HTML template lives at
`brain-mcp-server/scripts/render_brief_graph.template.html` and is loaded
once per render. Three literal markers (`__PAYLOAD__`,
`__GENERATED_AT__`, `__PROJECT__`) are swapped via `String#split + Array#join`
(not regex) to guard against accidental matches inside CSS/JS.

## Security

Brief titles and content are user-controlled. The renderer applies these
mitigations:

- `JSON.stringify` for the payload, then escape `<`/`>` and U+2028/U+2029
  so a brief title containing `</script>` cannot escape the embedding tag.
- Click-handler populates the sidebar via `textContent`, never `innerHTML`.
- Project slug is HTML-attribute-escaped before being injected into the
  `<title>` and header.

A regression test (`scripts/__tests__/render_brief_graph.test.ts`) renders
a brief with title `</script><script>alert(1)</script>` and asserts that:

- `<script>alert(1)</script>` does not appear in the HTML.
- Total `</script>` count is exactly 2 (the vis-network CDN script + our
  inline script).

## Files

| Path                                                                            | Purpose                                  |
| ------------------------------------------------------------------------------- | ---------------------------------------- |
| `brain-mcp-server/src/engine/components/edges/visualization.ts`                 | Data layer + HTML embedding helpers      |
| `brain-mcp-server/src/engine/components/edges/visualization-tool.ts`            | MCP handler + shared renderer            |
| `brain-mcp-server/src/engine/components/edges/__tests__/visualization.test.ts`  | Unit tests (14 scenarios)                |
| `brain-mcp-server/scripts/render_brief_graph.template.html`                     | HTML template                            |
| `brain-mcp-server/scripts/render_brief_graph.ts`                                | CLI script                               |
| `brain-mcp-server/scripts/__tests__/render_brief_graph.test.ts`                 | Integration tests (7 scenarios)          |
| `~/.igris/core/skills/visualize/SKILL.md`                                       | `/visualize` skill                       |
