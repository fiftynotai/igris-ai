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

# --- Bundle brain-mcp-server (TD-168, BR-068) ------------------------
# Stage brain-mcp-server's compiled dist/ + package.json into
# cli/dist/brain-mcp-server/ so `npm install -g igris-ai` ships a working
# igris-brain MCP.
#
# BR-068: the bundle's runtime deps ARE vendored into the bundle. An
# earlier scheme assumed cli/'s node_modules would resolve upward for the
# bundled MCP — it does not (the published tarball has no cli/node_modules
# on the bundle's resolution chain), so the brain died on spawn with
# ERR_MODULE_NOT_FOUND. The fix: a production-only `npm ci` inside the
# staged bundle dir produces a self-contained node_modules. A final
# spawn smoke guard proves the dependency set is complete and bootable
# before the build can be packed.
#
# Native-module note: better-sqlite3 / sqlite-vec ship platform-specific
# .node addons. This build-time vendored install verifies completeness on
# the BUILD machine; the published tarball ships the bundle's
# package.json + package-lock.json and cli/package.json's `postinstall`
# re-runs the production install on the END USER's machine so native
# addons match their OS/arch.
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

# Stage compiled output + package.json + package-lock.json. package.json
# is copied so the bundled MCP advertises "type":"module" to Node's module
# resolver and carries its version for doctor checks. The lockfile seeds
# the vendored install below; that install regenerates it to match the
# pruned manifest, and the regenerated lockfile is what ships — so the
# user-side postinstall can `npm ci` reproducibly.
rm -rf "$MCP_DEST"
mkdir -p "$MCP_DEST/dist"
cp -R "$MCP_SRC/dist/." "$MCP_DEST/dist/"
cp -p "$MCP_SRC/package.json" "$MCP_DEST/package.json"
if [ -f "$MCP_SRC/package-lock.json" ]; then
  cp -p "$MCP_SRC/package-lock.json" "$MCP_DEST/package-lock.json"
fi

# Fail loud if the staged entrypoint is missing — a publish with a broken
# bundle must abort rather than ship a half-package.
if [ ! -f "$MCP_DEST/dist/index.js" ]; then
  echo "copy-templates: bundled MCP entrypoint missing: $MCP_DEST/dist/index.js" >&2
  exit 1
fi

# Prune the staged package.json down to the production runtime surface
# the bundled MCP actually needs:
#   - devDependencies / optionalDependencies: dropped (build-only / not
#     required at runtime).
#   - @huggingface/transformers: dropped from `dependencies`. It is the
#     embeddings backend — large, and it pulls native `onnxruntime-node`.
#     The brain treats embeddings as optional (vector search degrades
#     gracefully when transformers is absent), so excluding it keeps the
#     bundle lean (~162 vs ~236 packages) without breaking the brain.
#   - sqlite-vec's own nested platform binaries (sqlite-vec-<os>-<arch>)
#     are NOT touched — they are required for vector search, so this
#     deliberately does NOT pass `npm --omit=optional` (that global flag
#     would strip those transitive platform packages too).
# Node is always present in this build context, so use `node -e` rather
# than adding a `jq` dependency.
node -e 'const fs=require("fs");const p=process.argv[1];
  const j=JSON.parse(fs.readFileSync(p,"utf-8"));
  delete j.devDependencies;delete j.optionalDependencies;
  if(j.dependencies)delete j.dependencies["@huggingface/transformers"];
  fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");' "$MCP_DEST/package.json"

# Vendor a production node_modules into the staged bundle. `npm install`
# (not `npm ci`) is used because the staged package.json was just pruned
# and no longer matches the staged lockfile — install reconciles and
# regenerates the lockfile from the pruned manifest. --ignore-scripts is
# left enabled (the default) so native modules (better-sqlite3,
# sqlite-vec) run their install scripts and produce their .node binaries.
echo "copy-templates: vendoring brain-mcp-server production node_modules..."
(cd "$MCP_DEST" && npm install --omit=dev --no-audit --no-fund)

# Fail loud if the vendored install is incomplete — a representative
# runtime dep MUST be present or the bundled MCP cannot spawn.
if [ ! -d "$MCP_DEST/node_modules/@modelcontextprotocol/sdk" ]; then
  echo "copy-templates: bundled MCP node_modules incomplete — @modelcontextprotocol/sdk missing" >&2
  exit 1
fi
echo "copy-templates: bundled brain-mcp-server -> $MCP_DEST"

# --- Post-build spawn smoke guard (BR-068 acceptance criterion) ------
# Spawn the bundled entrypoint and assert it boots without a
# module-resolution error. The brain MCP is a stdio server that idles
# until killed, so this is a spawn-wait-kill check: a process still alive
# after the wait booted cleanly; ERR_MODULE_NOT_FOUND / "Cannot find
# package" in stderr fails the build. macOS-safe — no GNU-only `timeout`.
echo "copy-templates: smoke-testing bundled MCP spawn..."
smoke_brain_dir="$(mktemp -d "${TMPDIR:-/tmp}/igris-mcp-smoke.XXXXXX")"
smoke_stderr="$(mktemp "${TMPDIR:-/tmp}/igris-mcp-smoke-err.XXXXXX")"
smoke_cleanup() { rm -rf "$smoke_brain_dir" "$smoke_stderr"; }
trap smoke_cleanup EXIT

IGRIS_BRAIN_DIR="$smoke_brain_dir" node "$MCP_DEST/dist/index.js" >/dev/null 2>"$smoke_stderr" &
smoke_pid=$!
sleep 2

smoke_alive=0
if kill -0 "$smoke_pid" 2>/dev/null; then
  smoke_alive=1
  kill "$smoke_pid" 2>/dev/null || true
  wait "$smoke_pid" 2>/dev/null || true
else
  wait "$smoke_pid" 2>/dev/null
fi

if grep -qE 'ERR_MODULE_NOT_FOUND|Cannot find package' "$smoke_stderr"; then
  echo "copy-templates: bundled MCP smoke test FAILED — module resolution error:" >&2
  cat "$smoke_stderr" >&2
  exit 1
fi

if [ "$smoke_alive" -eq 1 ]; then
  echo "copy-templates: bundled MCP smoke test passed (server booted and idled)"
else
  echo "copy-templates: bundled MCP smoke test passed (server exited cleanly)"
fi

smoke_cleanup
trap - EXIT
