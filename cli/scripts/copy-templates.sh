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
