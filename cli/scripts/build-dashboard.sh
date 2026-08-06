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

# --- TD-347: the two figures the chunk GATE asserts -------------------------
#
# `cli/src/__tests__/dashboard-chunks.test.ts` is the authoritative gate and can
# go RED; these are the same two numbers, printed here so the safe build states
# them on every run rather than leaving them to be re-derived by hand.
#
# The INITIAL SET is index.html's module `<script>` PLUS every
# `<link rel="modulepreload">` — i.e. what the browser must download before it
# can paint. NOT the entry file alone: a vendor `manualChunks` split shrinks the
# entry FILE by ~190 KB while moving the initial LOAD by 343 B. Measured at
# TD-347 (plant C): entry file 285_390 -> 95_394, initial set 285_390 -> 285_047.
#
# Node rather than a grep pipeline on purpose. This walks whole tags and reads
# their attributes individually, so an attribute-order change in a future Vite
# does not silently report an EMPTY initial set — and there is no pipe whose
# exit status could turn a match into a no-match.
node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const out = process.argv[1];
  const html = fs.readFileSync(path.join(out, "index.html"), "utf-8");
  const rels = [];
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    if (!/\btype\s*=\s*"module"/i.test(m[0])) continue;
    const s = m[0].match(/\bsrc\s*=\s*"([^"]+)"/i);
    if (s !== null) rels.push(s[1]);
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel\s*=\s*"modulepreload"/i.test(m[0])) continue;
    const h = m[0].match(/\bhref\s*=\s*"([^"]+)"/i);
    if (h !== null) rels.push(h[1]);
  }
  const initial = [...new Set(rels.map((r) => r.replace(/^\.?\//, "")))];
  const size = (f) => fs.statSync(path.join(out, f)).size;
  const assets = fs
    .readdirSync(path.join(out, "assets"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => "assets/" + f);
  const initialBytes = initial.reduce((n, f) => n + size(f), 0);
  const totalBytes = assets.reduce((n, f) => n + size(f), 0);
  const deferred = assets.filter((f) => !initial.includes(f));
  process.stdout.write(
    "build-dashboard: INITIAL SET " + initialBytes + " bytes over " +
      initial.length + " file(s) -- " + initial.join(", ") + "\n" +
    "build-dashboard: TOTAL JS    " + totalBytes + " bytes over " +
      assets.length + " chunk(s), " + deferred.length + " deferred (" +
      deferred.reduce((n, f) => n + size(f), 0) + " bytes off the critical path)\n",
  );
' "$OUT_DIR"
