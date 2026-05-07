#!/bin/bash

# Igris AI Initialization Script
# Initializes Igris AI in a target project (v3-era shim)

set -euo pipefail

# ============================================================
# DEPRECATED: This is the v3-era copy-based installer shim.
# For v7+, use: igris install <target_directory>
# (npm-published unified CLI; no shell-script dependency)
#
# Kept as a back-compat redirect for users with old runbooks.
# ============================================================

# v6.0+ Brain Check — redirect to the unified CLI when available.
if [ -d "$HOME/.igris" ]; then
  echo ""
  echo "Igris Brain detected at ~/.igris/"
  echo "   Redirecting to the brain-based installer..."
  echo ""

  # Prefer the v7 unified CLI when it's on PATH (the canonical path post-MG-014).
  if command -v igris >/dev/null 2>&1; then
    exec igris install "${1:-.}"
  fi

  # Fallback: build directly from the source repo's CLI dist (contributor mode).
  SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
  CLI_DIST="$( cd "$SCRIPT_DIR/.." && pwd )/cli/dist/index.js"
  if [ -f "$CLI_DIST" ]; then
    exec node "$CLI_DIST" install "${1:-.}"
  fi

  echo "Error: igris CLI not found on PATH and cli/dist/ is not built."
  echo "       Run 'npm install -g igris-ai' or 'cd cli && npm run build && npm link'."
  exit 1
fi

echo "Error: Copy-based install is no longer supported."
echo ""
echo "   Use the unified CLI instead:"
echo "   igris install ${1:-.}"
echo ""
exit 1
