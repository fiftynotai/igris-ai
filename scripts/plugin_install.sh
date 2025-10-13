#!/bin/bash

# Blueprint AI Plugin Installer
# Installs a Blueprint AI plugin from a git repository

set -e

PLUGIN_REPO=$1

if [ -z "$PLUGIN_REPO" ]; then
  echo "❌ Error: Plugin repository URL not provided"
  echo ""
  echo "Usage: ./scripts/plugin_install.sh <plugin-repo-url>"
  echo ""
  echo "Example:"
  echo "  ./scripts/plugin_install.sh https://github.com/yourorg/blueprint-ai-distribution-flutter"
  exit 1
fi

echo "🔌 Blueprint AI Plugin Installer"
echo "================================="
echo ""
echo "Plugin: $PLUGIN_REPO"
echo ""

# Check if Blueprint AI is initialized
if [ ! -d "ai" ] || [ ! -f "ai/plugins/installed.json" ]; then
  echo "❌ Error: Blueprint AI not initialized in this directory"
  echo ""
  echo "Please run: ./scripts/blueprint_init.sh"
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

# Update installed.json
cd "$PROJECT_DIR"

# Simple JSON update (create temp file, update, replace)
TEMP_JSON=$(mktemp)
cat ai/plugins/installed.json | python3 -c "
import sys, json
data = json.load(sys.stdin)
# Remove if already exists
data['plugins'] = [p for p in data['plugins'] if p['name'] != '$PLUGIN_NAME']
# Add new entry
data['plugins'].append({
    'name': '$PLUGIN_NAME',
    'version': '$PLUGIN_VERSION',
    'repo': '$PLUGIN_REPO',
    'installed_at': '$INSTALL_DATE',
    'capabilities': ['$CAPABILITIES'.split(',')]
})
data['last_updated'] = '$INSTALL_DATE'
json.dump(data, sys.stdout, indent=2)
" > "$TEMP_JSON"

mv "$TEMP_JSON" ai/plugins/installed.json

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
