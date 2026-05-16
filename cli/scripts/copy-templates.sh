#!/usr/bin/env bash
# copy-templates.sh — propagate non-TS assets from src/ into dist/
# after tsc builds. tsc only compiles .ts; .tmpl/.json fixtures
# don't get copied automatically.
#
# Run as the second step of `npm run build` from cli/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/src/lib/templates"
DEST="$ROOT/dist/lib/templates"

if [ ! -d "$SRC" ]; then
  echo "copy-templates: source dir missing: $SRC" >&2
  exit 1
fi

mkdir -p "$DEST"
# Copy every .tmpl and .json under src/lib/templates/ to the same
# relative path under dist/lib/templates/.
find "$SRC" -type f \( -name '*.tmpl' -o -name '*.json' \) -print0 |
while IFS= read -r -d '' f; do
  rel="${f#"$SRC"/}"
  dest_file="$DEST/$rel"
  mkdir -p "$(dirname "$dest_file")"
  cp -p "$f" "$dest_file"
done

# --- Bundle brain-mcp-server (TD-168) --------------------------------
# Stage brain-mcp-server's compiled dist/ + package.json into
# cli/dist/brain-mcp-server/ so `npm install -g igris-ai` ships a working
# igris-brain MCP. The bundled MCP's runtime deps are NOT bundled — they
# are hoisted into cli/package.json `dependencies` and resolve upward via
# Node's node_modules lookup (the bundled MCP sits inside cli/dist/, so
# cli/'s node_modules is on its resolution chain).
#
# ROOT = cli/ ; the monorepo root is ROOT/.. ; brain-mcp-server is a sibling.
MCP_SRC="$ROOT/../brain-mcp-server"
MCP_DEST="$ROOT/dist/brain-mcp-server"

if [ ! -d "$MCP_SRC" ]; then
  echo "copy-templates: brain-mcp-server dir missing: $MCP_SRC" >&2
  exit 1
fi

# Build brain-mcp-server (tsc) when its dist/ is absent OR src/ is newer
# than the compiled entrypoint. On a clean publish machine the monorepo
# install brings brain-mcp-server's devDeps, so `tsc` is available.
mcp_needs_build=0
if [ ! -f "$MCP_SRC/dist/index.js" ]; then
  mcp_needs_build=1
elif [ -n "$(find "$MCP_SRC/src" -type f -newer "$MCP_SRC/dist/index.js" -print -quit 2>/dev/null)" ]; then
  mcp_needs_build=1
fi

if [ "$mcp_needs_build" -eq 1 ]; then
  echo "copy-templates: building brain-mcp-server (dist/ missing or stale)..."
  (cd "$MCP_SRC" && npm run build)
fi

# Stage compiled output + package.json. package.json is copied so the
# bundled MCP advertises "type":"module" to Node's module resolver and
# carries its version for doctor checks. node_modules is intentionally
# NOT copied (see hoisting note above).
rm -rf "$MCP_DEST"
mkdir -p "$MCP_DEST/dist"
cp -R "$MCP_SRC/dist/." "$MCP_DEST/dist/"
cp -p "$MCP_SRC/package.json" "$MCP_DEST/package.json"

# Fail loud if the bundle is incomplete — a publish with a broken bundle
# must abort rather than ship a half-package.
if [ ! -f "$MCP_DEST/dist/index.js" ]; then
  echo "copy-templates: bundled MCP entrypoint missing: $MCP_DEST/dist/index.js" >&2
  exit 1
fi
echo "copy-templates: bundled brain-mcp-server -> $MCP_DEST"
