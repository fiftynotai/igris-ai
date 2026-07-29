#!/usr/bin/env bash
set -e

# Description: Build the FR-238 dashboard bundle (cli/dashboard -> cli/dist/dashboard).
# Usage: build-dashboard.sh
# Dependencies: node >= 20, the cli workspace devDependencies (vite, react, tailwind, gsap)
# Exit codes:
#   0 - Success
#   1 - Error (vite missing, build failed, or no index.html produced)
#
# UNCONDITIONAL BY DESIGN. There is deliberately no "skip if dist/dashboard
# already exists" shortcut: `prepublishOnly` runs `npm run build`, so a
# skip-if-present branch is exactly how a stale bundle ships to npm (the TD-276
# class of bug). The vitest artifact-freshness guard
# (src/__tests__/dashboard-artifact.test.ts) is the belt; this is the braces.
#
# Prints measured byte sizes on every run, the way copy-templates.sh echoes its
# stages — the D2 weight budget is only enforceable if every build reports its
# weight.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT/dashboard"
OUT_DIR="$ROOT/dist/dashboard"

if [ ! -d "$APP_DIR" ]; then
  echo "build-dashboard: source dir missing: $APP_DIR" >&2
  exit 1
fi

# Resolve the vite binary explicitly rather than via `npx`. `npx` re-roots its
# child process at the nearest package.json (cli/), which makes vite look for
# cli/vite.config.ts and fail with an unresolved-entry error. Walking up for
# node_modules/vite/bin/vite.js works from both a workspace install (hoisted to
# the monorepo root) and a standalone cli/ install.
VITE_BIN=""
for candidate in \
  "$ROOT/node_modules/vite/bin/vite.js" \
  "$ROOT/../node_modules/vite/bin/vite.js"; do
  if [ -f "$candidate" ]; then
    VITE_BIN="$candidate"
    break
  fi
done

if [ -z "$VITE_BIN" ]; then
  echo "build-dashboard: vite not found. Run \`npm ci\` at the repo root first." >&2
  echo "  looked in: $ROOT/node_modules and $ROOT/../node_modules" >&2
  exit 1
fi

echo "build-dashboard: building $APP_DIR -> $OUT_DIR"
(cd "$APP_DIR" && node "$VITE_BIN" build)

# Fail LOUD on a missing artifact. A silently absent bundle would ship a
# package whose `igris dashboard` serves a placeholder — an AC failure that no
# other step would catch before publish.
if [ ! -f "$OUT_DIR/index.html" ]; then
  echo "build-dashboard: FAILED — no index.html at $OUT_DIR" >&2
  exit 1
fi

# --- Report measured weight (D2) -------------------------------------------
total_bytes=$(find "$OUT_DIR" -type f -exec wc -c {} + | tail -1 | awk '{print $1}')
file_count=$(find "$OUT_DIR" -type f | wc -l | tr -d ' ')
echo "build-dashboard: $file_count files, $total_bytes bytes unpacked"
find "$OUT_DIR" -type f \( -name '*.js' -o -name '*.css' -o -name '*.woff2' -o -name '*.html' \) \
  -exec sh -c 'printf "  %8d  %s\n" "$(wc -c < "$1")" "${1#'"$OUT_DIR"'/}"' _ {} \; | sort -rn
