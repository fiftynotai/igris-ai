#!/bin/bash

# Igris AI Plugin Update Script
# Updates an installed plugin to the latest version

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
DRY_RUN=false
FORCE=false
AUTO_YES=false

# Parse arguments
shift || true
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --force)
      FORCE=true
      shift
      ;;
    --yes|-y)
      AUTO_YES=true
      shift
      ;;
    *)
      echo "❌ Unknown option: $1"
      echo ""
      echo "Usage: ./scripts/plugin_update.sh <plugin-name> [--dry-run] [--force] [--yes]"
      exit 1
      ;;
  esac
done

if [ -z "$PLUGIN_NAME" ]; then
  echo "❌ Error: Plugin name not provided"
  echo ""
  echo "Usage: ./scripts/plugin_update.sh <plugin-name> [--dry-run] [--force]"
  echo ""
  echo "Example:"
  echo "  ./scripts/plugin_update.sh igris-ai-distribution-flutter"
  echo ""
  echo "To see installed plugins:"
  echo "  ./scripts/plugin_list.sh"
  exit 1
fi

echo "🔄 Igris AI Plugin Updater"
echo "=============================="
echo ""

# Check if Igris AI is initialized and validate installed.json
if ! validate_json "ai/plugins/installed.json" "installed.json"; then
  echo ""
  echo "Please run: ./scripts/igris_init.sh"
  exit 1
fi

# Check if plugin is installed
PLUGIN_ENTRY=$(cat ai/plugins/installed.json | grep -A 5 "\"name\": \"$PLUGIN_NAME\"" || echo "")

if [ -z "$PLUGIN_ENTRY" ]; then
  echo "❌ Error: Plugin '$PLUGIN_NAME' is not installed"
  echo ""
  echo "Installed plugins:"
  ./scripts/plugin_list.sh
  exit 1
fi

# Extract plugin info from installed.json using python3 (reliable JSON parsing)
PLUGIN_INFO=$(python3 -c "
import json
with open('ai/plugins/installed.json', 'r') as f:
    data = json.load(f)
    for plugin in data['plugins']:
        if plugin['name'] == '$PLUGIN_NAME':
            print(plugin.get('repo', ''))
            print(plugin.get('version', ''))
            break
")
PLUGIN_REPO=$(echo "$PLUGIN_INFO" | sed -n '1p')
CURRENT_VERSION=$(echo "$PLUGIN_INFO" | sed -n '2p')

echo "📦 Plugin: $PLUGIN_NAME"
echo "📍 Repository: $PLUGIN_REPO"
echo "📌 Current version: $CURRENT_VERSION"
echo ""

# Create temporary directory
TEMP_DIR=$(mktemp -d)

# Fetch latest version from plugin repo
echo "🌐 Checking for updates..."

# Test mode: allow local directories (for bats testing)
if [ "$IGRIS_TEST_MODE" = "1" ] && [ -d "$PLUGIN_REPO" ]; then
  echo "📦 Copying plugin from local directory (test mode)..."
  cp -r "$PLUGIN_REPO"/* "$TEMP_DIR/"
else
  git clone --depth 1 --quiet "$PLUGIN_REPO" "$TEMP_DIR" 2>&1 | grep -v "^Cloning" || true
fi

if [ ! -f "$TEMP_DIR/plugin.json" ]; then
  echo "❌ Error: Could not fetch plugin.json"
  echo "   Plugin repository is missing plugin.json file"
  rm -rf "$TEMP_DIR"
  exit 1
fi

# Extract version from plugin.json using python3 (reliable JSON parsing)
REMOTE_VERSION=$(python3 -c "
import json
with open('$TEMP_DIR/plugin.json', 'r') as f:
    data = json.load(f)
    print(data.get('version', ''))
" 2>/dev/null)

if [ -z "$REMOTE_VERSION" ]; then
  echo "❌ Error: Could not extract version from plugin.json"
  echo "   Check that plugin.json has a 'version' field"
  rm -rf "$TEMP_DIR"
  exit 1
fi

echo "📡 Latest version: $REMOTE_VERSION"
echo ""

# Compare versions
if [ "$CURRENT_VERSION" = "$REMOTE_VERSION" ] && [ "$FORCE" = false ]; then
  echo "✅ Plugin '$PLUGIN_NAME' is already up to date!"
  rm -rf "$TEMP_DIR"
  exit 0
fi

if [ "$CURRENT_VERSION" = "$REMOTE_VERSION" ]; then
  echo "⚠️  Versions are the same, but --force flag provided"
fi

# Show update summary
echo "📋 Update Summary:"
echo "  From: $CURRENT_VERSION"
echo "  To:   $REMOTE_VERSION"
echo ""

if [ "$DRY_RUN" = true ]; then
  echo "🔍 DRY RUN MODE - No changes will be made"
  echo ""

  # Show what plugin provides
  if [ -f "$TEMP_DIR/plugin.json" ]; then
    echo "Plugin info:"
    PLUGIN_DESC=$(cat "$TEMP_DIR/plugin.json" | grep '"description"' | sed 's/.*"description": "\([^"]*\)".*/\1/')
    if [ -n "$PLUGIN_DESC" ]; then
      echo "  Description: $PLUGIN_DESC"
    fi
  fi

  echo ""
  echo "Update would:"
  echo "  1. Backup current plugin files"
  echo "  2. Clone latest version from repository"
  echo "  3. Run plugin's install script"
  echo "  4. Update plugin registry"
  echo ""
  echo "✅ Dry run complete. Run without --dry-run to apply update."
  rm -rf "$TEMP_DIR"
  exit 0
fi

# Confirm update (skip if --yes flag)
if [ "$AUTO_YES" = false ]; then
  read -p "Continue with update? [y/N]: " CONFIRM
  if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "❌ Update cancelled"
    rm -rf "$TEMP_DIR"
    exit 0
  fi
fi

echo ""
echo "📦 Starting plugin update..."
echo ""

# Create backup
BACKUP_DIR=".igris_backup/plugins/$(date +%Y%m%d_%H%M%S)_${PLUGIN_NAME}"
echo "💾 Creating backup at $BACKUP_DIR..."
mkdir -p "$BACKUP_DIR"

# Note: Plugin files location depends on plugin implementation
# We backup the version tracking
cp .igris_version "$BACKUP_DIR/" 2>/dev/null || true
cp ai/plugins/installed.json "$BACKUP_DIR/" 2>/dev/null || true

echo "✅ Backup created"
echo ""

# Run plugin installation script (it handles updates)
echo "🔧 Running plugin update..."

# Get current project directory before changing directories
PROJECT_DIR=$(pwd)

cd "$TEMP_DIR"
chmod +x install.sh

# Pass plugin temp directory and project directory to plugin installer
bash install.sh "$TEMP_DIR" "$PROJECT_DIR"

# Update plugin registry
echo "📝 Updating plugin registry..."
UPDATE_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cd "$PROJECT_DIR"

# Update installed.json
TEMP_JSON=$(mktemp)
python3 <<EOF > "$TEMP_JSON"
import json

with open('ai/plugins/installed.json', 'r') as f:
    data = json.load(f)

# Find and update plugin entry
for plugin in data['plugins']:
    if plugin['name'] == '$PLUGIN_NAME':
        plugin['version'] = '$REMOTE_VERSION'
        plugin['installed_at'] = '$UPDATE_DATE'
        break

data['last_updated'] = '$UPDATE_DATE'

print(json.dumps(data, indent=2))
EOF

if [ $? -eq 0 ] && [ -s "$TEMP_JSON" ]; then
    mv "$TEMP_JSON" ai/plugins/installed.json
else
    echo "⚠️  Warning: Failed to update plugin registry"
    rm -f "$TEMP_JSON"
fi

# Update .igris_version
if [ -f ".igris_version" ]; then
    TEMP_VERSION=$(mktemp)
    python3 <<VERSION_EOF > "$TEMP_VERSION"
import json

with open('.igris_version', 'r') as f:
    data = json.load(f)

# Update plugin version
if 'plugins' not in data:
    data['plugins'] = {}

if '$PLUGIN_NAME' in data['plugins']:
    data['plugins']['$PLUGIN_NAME']['version'] = '$REMOTE_VERSION'
    data['plugins']['$PLUGIN_NAME']['installed_at'] = '$UPDATE_DATE'

data['last_updated'] = '$UPDATE_DATE'

print(json.dumps(data, indent=2))
VERSION_EOF

    if [ $? -eq 0 ] && [ -s "$TEMP_VERSION" ]; then
        mv "$TEMP_VERSION" .igris_version
    else
        rm -f "$TEMP_VERSION"
    fi
fi

# Cleanup
rm -rf "$TEMP_DIR"

echo ""
echo "✅ Plugin updated successfully!"
echo ""
echo "📦 Plugin: $PLUGIN_NAME"
echo "📌 Updated to version: $REMOTE_VERSION"
echo "💾 Backup saved at: $BACKUP_DIR"
echo ""
echo "📝 What's new in $REMOTE_VERSION:"
echo "  Check the plugin repository for changelog:"
echo "  $PLUGIN_REPO"
echo ""
