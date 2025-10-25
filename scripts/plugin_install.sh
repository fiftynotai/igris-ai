#!/bin/bash

# Igris AI Plugin Installer
# Installs a Igris AI plugin from a git repository

set -e

PLUGIN_REPO=$1

if [ -z "$PLUGIN_REPO" ]; then
  echo "❌ Error: Plugin repository URL not provided"
  echo ""
  echo "Usage: ./scripts/plugin_install.sh <plugin-repo-url>"
  echo ""
  echo "Example:"
  echo "  ./scripts/plugin_install.sh https://github.com/fiftynotai/igris-ai-distribution-flutter"
  exit 1
fi

echo "🔌 Igris AI Plugin Installer"
echo "================================="
echo ""
echo "Plugin: $PLUGIN_REPO"
echo ""

# Check if Igris AI is initialized
if [ ! -d "ai" ] || [ ! -f "ai/plugins/installed.json" ]; then
  echo "❌ Error: Igris AI not initialized in this directory"
  echo ""
  echo "Please run: ./scripts/igris_init.sh"
  exit 1
fi

# Create temporary directory
TEMP_DIR=$(mktemp -d)
echo "📦 Cloning plugin to temporary directory..."
git clone "$PLUGIN_REPO" "$TEMP_DIR" 2>&1 | grep -v "^Cloning" || true

if [ ! -d "$TEMP_DIR" ] || [ ! -f "$TEMP_DIR/install.sh" ]; then
  echo "❌ Error: Invalid plugin repository"
  echo "   Plugin must contain an install.sh script"
  rm -rf "$TEMP_DIR"
  exit 1
fi

# Read plugin metadata
if [ ! -f "$TEMP_DIR/plugin.json" ]; then
  echo "❌ Error: Plugin missing plugin.json metadata file"
  rm -rf "$TEMP_DIR"
  exit 1
fi

PLUGIN_NAME=$(cat "$TEMP_DIR/plugin.json" | grep '"name"' | head -1 | sed 's/.*"name": "\(.*\)".*/\1/')
PLUGIN_VERSION=$(cat "$TEMP_DIR/plugin.json" | grep '"version"' | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')

echo "📋 Plugin: $PLUGIN_NAME v$PLUGIN_VERSION"
echo ""

# Check if already installed
ALREADY_INSTALLED=$(cat ai/plugins/installed.json | grep "\"$PLUGIN_NAME\"" || echo "")
if [ ! -z "$ALREADY_INSTALLED" ]; then
  echo "⚠️  Plugin '$PLUGIN_NAME' is already installed"
  read -p "Reinstall? [y/N]: " REINSTALL
  if [[ ! "$REINSTALL" =~ ^[Yy]$ ]]; then
    echo "Installation cancelled"
    rm -rf "$TEMP_DIR"
    exit 0
  fi
fi

# Run plugin installation script
echo "🔧 Running plugin installation..."

# Get current project directory
PROJECT_DIR=$(pwd)

cd "$TEMP_DIR"
chmod +x install.sh

# Pass plugin temp directory and project directory to plugin installer
bash install.sh "$TEMP_DIR" "$PROJECT_DIR"

# Register plugin
echo "📝 Registering plugin..."
INSTALL_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Read capabilities from plugin.json
CAPABILITIES=$(cat plugin.json | grep '"capabilities"' -A 10 | grep -v "capabilities" | grep '"' | sed 's/.*"\(.*\)".*/\1/' | tr '\n' ',' | sed 's/,$//')

# Read hooks from plugin.json (if present)
HOOKS_JSON="{}"
if grep -q '"hooks"' plugin.json; then
  if command -v jq &> /dev/null; then
    HOOKS_JSON=$(jq -c '.hooks // {}' plugin.json 2>/dev/null || echo "{}")
  fi
fi

# Update installed.json
cd "$PROJECT_DIR"

# Simple JSON update (create temp file, update, replace)
TEMP_JSON=$(mktemp)
python3 <<EOF > "$TEMP_JSON"
import json

# Read current installed.json
with open('ai/plugins/installed.json', 'r') as f:
    data = json.load(f)

# Remove if already exists
data['plugins'] = [p for p in data['plugins'] if p['name'] != '$PLUGIN_NAME']

# Add new entry
plugin_entry = {
    'name': '$PLUGIN_NAME',
    'version': '$PLUGIN_VERSION',
    'repo': '$PLUGIN_REPO',
    'installed_at': '$INSTALL_DATE',
    'capabilities': [c.strip() for c in '$CAPABILITIES'.split(',') if c.strip()]
}

# Add hooks if present
hooks_data = json.loads('$HOOKS_JSON')
if hooks_data:
    plugin_entry['hooks'] = hooks_data

data['plugins'].append(plugin_entry)
data['last_updated'] = '$INSTALL_DATE'

# Write updated JSON
print(json.dumps(data, indent=2))
EOF

if [ $? -eq 0 ] && [ -s "$TEMP_JSON" ]; then
    mv "$TEMP_JSON" ai/plugins/installed.json
else
    echo "⚠️  Warning: Failed to update plugin registry"
    rm -f "$TEMP_JSON"
fi

# Update .igris_version if it exists
if [ -f ".igris_version" ]; then
    TEMP_VERSION=$(mktemp)
    python3 <<VERSION_EOF > "$TEMP_VERSION"
import json

try:
    with open('.igris_version', 'r') as f:
        data = json.load(f)

    # Update plugin version
    if 'plugins' not in data:
        data['plugins'] = {}

    data['plugins']['$PLUGIN_NAME'] = {
        'version': '$PLUGIN_VERSION',
        'installed_at': '$INSTALL_DATE',
        'repo': '$PLUGIN_REPO'
    }
    data['last_updated'] = '$INSTALL_DATE'

    print(json.dumps(data, indent=2))
except Exception as e:
    # If error, output original file
    with open('.igris_version', 'r') as f:
        print(f.read())
VERSION_EOF

    if [ $? -eq 0 ] && [ -s "$TEMP_VERSION" ]; then
        mv "$TEMP_VERSION" .igris_version
    else
        rm -f "$TEMP_VERSION"
    fi
fi

# Regenerate CLAUDE.md if plugin has hooks
if [ -n "$(echo "$HOOKS_JSON" | grep -v '^{}$')" ]; then
  echo "🔄 Regenerating CLAUDE.md with plugin hooks..."

  # Get Igris AI version
  IGRIS_VERSION=$(cat .igris_version | grep '"igris_ai_version"' | sed 's/.*"igris_ai_version": "\(.*\)".*/\1/' 2>/dev/null || echo "unknown")
  INSTALL_DATE=$(cat CLAUDE.md | grep "Installed:" | sed 's/.*Installed:\*\* //' 2>/dev/null || date -u +"%Y-%m-%d")

  # Find Igris AI installation
  IGRIS_DIR=$(dirname "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")")")

  # Resolve persona hook (if plugin provides one)
  PERSONA_INJECTION=""
  if [ -f "ai/plugins/installed.json" ] && command -v jq &> /dev/null; then
    PERSONA_HOOK=$(jq -r '.plugins[] | select(.hooks.persona_injection) | .hooks.persona_injection' ai/plugins/installed.json 2>/dev/null || echo "")
    if [ -n "$PERSONA_HOOK" ] && [ -f "$PERSONA_HOOK" ]; then
      PERSONA_INJECTION=$(cat "$PERSONA_HOOK")
    fi
  fi

  # Regenerate CLAUDE.md with two-step process (handles multi-line PERSONA_INJECTION)
  # First pass: Replace simple variables
  sed -e "s/{{IGRIS_VERSION}}/$IGRIS_VERSION/g" \
      -e "s/{{INSTALL_DATE}}/$INSTALL_DATE/g" \
      "$IGRIS_DIR/scripts/templates/CLAUDE.md.template" > CLAUDE.md.tmp

  # Second pass: Replace persona injection using perl (handles newlines)
  if [ -n "$PERSONA_INJECTION" ]; then
    # Escape special characters for perl regex
    ESCAPED_INJECTION=$(printf '%s\n' "$PERSONA_INJECTION" | perl -pe 's/([\\\/\$])/\\$1/g')
    perl -i -pe "s/\{\{PERSONA_INJECTION\}\}/$ESCAPED_INJECTION/g" CLAUDE.md.tmp
  else
    # Remove the placeholder if no injection
    perl -i -pe 's/\{\{PERSONA_INJECTION\}\}//g' CLAUDE.md.tmp
  fi

  mv CLAUDE.md.tmp CLAUDE.md
fi

# Cleanup
rm -rf "$TEMP_DIR"

echo ""
echo "✅ Plugin installed successfully!"
echo ""
echo "📦 Installed: $PLUGIN_NAME v$PLUGIN_VERSION"
echo ""
echo "To see all installed plugins:"
echo "  ./scripts/plugin_list.sh"
echo ""
