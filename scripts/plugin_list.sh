#!/bin/bash

# Blueprint AI Plugin Lister
# Lists all installed Blueprint AI plugins

echo "🔌 Blueprint AI Installed Plugins"
echo "=================================="
echo ""

# Check if Blueprint AI is initialized
if [ ! -d "ai" ] || [ ! -f "ai/plugins/installed.json" ]; then
  echo "❌ Error: Blueprint AI not initialized in this directory"
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
        if isinstance(caps[0], list):
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
