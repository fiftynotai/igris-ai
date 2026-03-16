#!/bin/bash

# Igris AI Initialization Script
# Initializes Igris AI in a target project

set -euo pipefail

# ============================================================
# DEPRECATED: This is the v4 legacy copy-based installer.
# For v6+, use: ./scripts/igris_install.sh <target_directory>
# The symlink installer uses the centralized brain at ~/.igris/
# ============================================================

# v6.0 Brain Check — redirect to igris_install.sh
if [ -d "$HOME/.igris" ]; then
  echo ""
  echo "💡 Igris Brain detected at ~/.igris/"
  echo "   Redirecting to the brain-based installer..."
  echo ""
  SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
  exec "$SCRIPT_DIR/igris_install.sh" "${1:-.}"
fi

echo "❌ Error: Copy-based install is no longer supported in v6."
echo ""
echo "   Use the brain-based installer instead:"
echo "   ./scripts/igris_install.sh ${1:-.}"
echo ""
exit 1
