#!/bin/bash

# Igris AI Plugin Lister
# Lists all installed Igris AI plugins

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

echo "🔌 Igris AI Installed Plugins"
echo "=================================="
echo ""

# Check if Igris AI is initialized
if [ ! -d "ai" ] || [ ! -f "ai/plugins/installed.json" ]; then
  echo "❌ Error: Igris AI not initialized in this directory"
  exit 1
fi

# Check if any plugins installed
PLUGIN_COUNT=$(cat ai/plugins/installed.json | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(len(data['plugins']))
")

if [ "$PLUGIN_COUNT" = "0" ]; then
  echo "No plugins installed"
  echo ""
  echo "To install a plugin:"
  echo "  ./scripts/plugin_install.sh <plugin-repo-url>"
  echo ""
  exit 0
fi

# List plugins
cat ai/plugins/installed.json | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(f'Found {len(data[\"plugins\"])} plugin(s):\n')
for p in data['plugins']:
    print(f'📦 {p[\"name\"]} v{p[\"version\"]}')
    print(f'   Installed: {p[\"installed_at\"]}')
    if 'capabilities' in p and p['capabilities']:
        # Handle both nested list (old format) and flat list (new format)
        caps = p['capabilities']
        if caps and isinstance(caps[0], list):
            caps = caps[0]  # Flatten nested list
        caps_str = ', '.join(caps)
        print(f'   Capabilities: {caps_str}')
    print(f'   Repository: {p[\"repo\"]}')
    print()
"

echo ""
echo "To uninstall a plugin:"
echo "  ./scripts/plugin_uninstall.sh <plugin-name>"
echo ""
