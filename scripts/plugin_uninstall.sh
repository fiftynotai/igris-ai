#!/bin/bash

# Igris AI Plugin Uninstaller
# Removes an installed Igris AI plugin

set -e

# Check Python3 dependency
check_python3() {
  if ! command -v python3 &> /dev/null; then
    echo "❌ Error: Python 3 is required but not installed"
    echo ""
    echo "Install Python 3:"
    echo "  macOS: brew install python3"
    echo "  Ubuntu/Debian: sudo apt install python3"
    echo "  Download: https://www.python.org/downloads/"
    echo ""
    exit 1
  fi
}

check_python3

# Validate JSON file
validate_json() {
  local file="$1"
  local desc="${2:-JSON file}"

  # Check if file exists
  if [ ! -f "$file" ]; then
    echo "❌ Error: $desc not found: $file"
    return 1
  fi

  # Validate JSON syntax
  if ! python3 -c "import json; json.load(open('$file'))" 2>/dev/null; then
    echo "❌ Error: $desc is corrupted or contains invalid JSON"
    echo "   File: $file"
    return 1
  fi

  return 0
}

PLUGIN_NAME=$1

if [ -z "$PLUGIN_NAME" ]; then
  echo "❌ Error: Plugin name not provided"
  echo ""
  echo "Usage: ./scripts/plugin_uninstall.sh <plugin-name>"
  echo ""
  echo "To see installed plugins:"
  echo "  ./scripts/plugin_list.sh"
  exit 1
fi

echo "🔌 Igris AI Plugin Uninstaller"
echo "==================================="
echo ""

# Check if Igris AI is initialized and validate installed.json
if [ ! -d "ai" ]; then
  echo "❌ Error: Igris AI not initialized in this directory"
  echo ""
  echo "Please run: ./scripts/igris_init.sh"
  exit 1
fi

if ! validate_json "ai/plugins/installed.json" "installed.json"; then
  echo ""
  echo "Please run: ./scripts/igris_init.sh"
  exit 1
fi

# Check if plugin is installed
PLUGIN_INSTALLED=$(cat ai/plugins/installed.json | grep "\"$PLUGIN_NAME\"" || echo "")
if [ -z "$PLUGIN_INSTALLED" ]; then
  echo "❌ Error: Plugin '$PLUGIN_NAME' is not installed"
  echo ""
  echo "To see installed plugins:"
  echo "  ./scripts/plugin_list.sh"
  exit 1
fi

# Get plugin info
PLUGIN_VERSION=$(cat ai/plugins/installed.json | python3 -c "
import sys, json
data = json.load(sys.stdin)
for p in data['plugins']:
    if p['name'] == '$PLUGIN_NAME':
        print(p['version'])
        break
")

echo "📋 Plugin: $PLUGIN_NAME v$PLUGIN_VERSION"
echo ""
echo "⚠️  This will remove the plugin from your project"
read -p "Continue? [y/N]: " CONFIRM

if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "Uninstall cancelled"
  exit 0
fi

echo ""
echo "🗑️  Uninstalling plugin..."

# Note: Plugin-specific cleanup would be handled by plugin's uninstall.sh
# For now, we just remove from registry

# Update installed.json
TEMP_JSON=$(mktemp)
cat ai/plugins/installed.json | python3 -c "
import sys, json
from datetime import datetime
data = json.load(sys.stdin)
data['plugins'] = [p for p in data['plugins'] if p['name'] != '$PLUGIN_NAME']
data['last_updated'] = datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
json.dump(data, sys.stdout, indent=2)
" > "$TEMP_JSON"

mv "$TEMP_JSON" ai/plugins/installed.json

echo ""
echo "✅ Plugin uninstalled successfully!"
echo ""
echo "⚠️  Note: Plugin files may still exist in scripts/, templates/, etc."
echo "   Manual cleanup may be required for complete removal."
echo ""
