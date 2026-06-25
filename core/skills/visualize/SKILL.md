---
name: visualize
tier: opt-in
description: Render and open the current project's brief graph as an interactive HTML visualization
disable-model-invocation: false
allowed-tools:
  - Bash
  - mcp__igris-brain__igris_brief_graph_render
triggers:
  - "/visualize"
  - "visualize briefs"
  - "show brief graph"
  - "render brief graph"
  - "brief visualization"
---

# VISUALIZE - Brief Graph Visualization

Render the current project's brief-and-edges graph (FR-111) as a self-contained interactive HTML file, then open it in the OS default browser. Wraps `igris_brief_graph_render` + cross-platform openers; no other side effects.

## Arguments

`$ARGUMENTS` is optional.
- Empty: derive project slug from `$CLAUDE_PROJECT_DIR` basename (the active working directory).
- A single token: treat as the project slug to render (e.g. `/visualize my-app`).

Cross-project rendering of multiple projects in one call is out of scope (see FR-111 Phase 2).

## Execution

### 1. Resolve Project

If `$ARGUMENTS` is non-empty, use its first token as `$PROJECT`. Otherwise:
```bash
PROJECT="$(basename "$CLAUDE_PROJECT_DIR")"
```

### 2. Render the Graph

Call `igris_brief_graph_render` with:
- `project`: resolved `$PROJECT`
- `output_path`: omitted (let the handler default to `~/.igris/projects/$PROJECT/visualizations/briefs-graph-{timestamp}.html`)

The handler returns JSON with `output_path`, `node_count`, `edge_count`, `goal_count`, `god_nodes`, `render_time_ms`, `html_size_bytes`. Capture `output_path` as `$OUT`.

If the call fails (brain MCP offline, project not found, render error), surface the error message verbatim to the user and stop — do NOT attempt to open anything.

### 3. Open the HTML in the Default Browser

Run the cross-platform open ladder. Pass the path as an argument; never `eval`.

```bash
open_in_browser() {
  local path="$1"

  # Headless guard: no DISPLAY and no WAYLAND_DISPLAY -> print path, skip open.
  if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ] && [[ "$OSTYPE" != darwin* ]]; then
    echo "(headless — open manually: $path)"
    return 0
  fi

  # 1) macOS
  if [[ "$OSTYPE" == darwin* ]]; then
    open "$path" && return 0
  fi

  # 2) WSL — detect via /proc/version, prefer wslview, fallback to cmd.exe
  if grep -qi microsoft /proc/version 2>/dev/null; then
    if command -v wslview >/dev/null 2>&1; then
      wslview "$path" && return 0
    fi
    cmd.exe /c start "" "$path" 2>/dev/null && return 0
  fi

  # 3) Linux
  if [[ "$OSTYPE" == linux* ]] && command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$path" >/dev/null 2>&1 & disown
    return 0
  fi

  # 4) Fallback — print path, do not fail
  echo "(could not auto-open — open manually: $path)"
  return 0
}

open_in_browser "$OUT"
```

### 4. Confirm to the User

Print one line summarizing the render and open:

```
Rendered $PROJECT graph -> $OUT  ($node_count nodes, $edge_count edges, ${render_time_ms}ms)
```

If the open step printed a "headless" or "could not auto-open" message, that line is shown above this confirmation. Do not duplicate.

## Notes

- The MCP tool does the actual data work (SQL, layout, HTML embedding). This skill is a thin orchestrator over that tool.
- Output directory is the per-project `~/.igris/projects/{project}/visualizations/`. Files are timestamped, never overwritten.
- For empty graphs (no edges yet), see `docs/visualization.md` "Empty graph?" — run the FR-105/TD-057 backfill.
- For the standalone CLI alternative (no skill, no MCP), see `brain-mcp-server/scripts/render_brief_graph.ts`.
