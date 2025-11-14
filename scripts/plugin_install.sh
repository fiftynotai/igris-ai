#!/bin/bash

# Igris AI Plugin Installer
# Installs a Igris AI plugin from a git repository

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
if [ ! -d "ai" ]; then
  echo "❌ Error: Igris AI not initialized in this directory"
  echo ""
  echo "Please run: ./scripts/igris_init.sh"
  exit 1
fi

# Create installed.json if it doesn't exist
if [ ! -f "ai/plugins/installed.json" ]; then
  mkdir -p "ai/plugins"
  echo '{"plugins": [], "last_updated": "'$(date -u +"%Y-%m-%dT%H:%M:%SZ")'"}' > "ai/plugins/installed.json"
fi

# Create temporary directory
TEMP_DIR=$(mktemp -d)

# Test mode: allow local directories (for bats testing)
if [ "$IGRIS_TEST_MODE" = "1" ] && [ -d "$PLUGIN_REPO" ]; then
  echo "📦 Copying plugin from local directory (test mode)..."
  cp -r "$PLUGIN_REPO"/* "$TEMP_DIR/"
else
  echo "📦 Cloning plugin to temporary directory..."
  git clone "$PLUGIN_REPO" "$TEMP_DIR" 2>&1 | grep -v "^Cloning" || true
fi

if [ ! -d "$TEMP_DIR" ] || [ ! -f "$TEMP_DIR/install.sh" ]; then
  echo "❌ Error: Invalid plugin repository"
  echo "   Plugin must contain an install.sh script"
  rm -rf "$TEMP_DIR"
  exit 1
fi

# Read plugin metadata
# Validate plugin.json exists and has valid JSON syntax
if ! validate_json "$TEMP_DIR/plugin.json" "plugin.json"; then
  rm -rf "$TEMP_DIR"
  exit 1
fi

# Extract name and version using python3 (reliable JSON parsing)
PLUGIN_METADATA=$(python3 -c "
import json
with open('$TEMP_DIR/plugin.json', 'r') as f:
    data = json.load(f)
    print(data.get('name', ''))
    print(data.get('version', ''))
")
PLUGIN_NAME=$(echo "$PLUGIN_METADATA" | sed -n '1p')
PLUGIN_VERSION=$(echo "$PLUGIN_METADATA" | sed -n '2p')

# Validate plugin name is not empty
if [ -z "$PLUGIN_NAME" ]; then
  echo "❌ Error: Plugin name cannot be empty"
  echo "   Check plugin.json 'name' field"
  rm -rf "$TEMP_DIR"
  exit 1
fi

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
    'location': '$PLUGIN_REPO',
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
  if [ -f "ai/plugins/installed.json" ]; then
    if command -v jq &> /dev/null; then
      PERSONA_HOOK=$(jq -r '.plugins[] | select(.hooks.persona_injection) | .hooks.persona_injection' ai/plugins/installed.json 2>/dev/null || echo "")
      if [ -n "$PERSONA_HOOK" ] && [ -f "$PERSONA_HOOK" ]; then
        PERSONA_INJECTION=$(cat "$PERSONA_HOOK")
      fi
    else
      echo "⚠️  Note: jq not found - plugin hooks will not be processed"
      echo "   Install jq to enable persona plugins:"
      echo "   macOS: brew install jq"
      echo "   Ubuntu/Debian: sudo apt install jq"
      echo ""
    fi
  fi

  # Regenerate CLAUDE.md with proper multi-line persona injection
  # Use Python to handle multi-line content correctly

  # Write persona content to temp file if present (preserves all formatting)
  PERSONA_TEMP=""
  if [ -n "$PERSONA_INJECTION" ]; then
    PERSONA_TEMP=$(mktemp)
    printf '%s' "$PERSONA_INJECTION" > "$PERSONA_TEMP"
  fi

  python3 <<PYTHON_EOF
import json

# Read template
with open("$IGRIS_DIR/scripts/templates/CLAUDE.md.template", 'r') as f:
    content = f.read()

# Replace simple variables
content = content.replace('{{IGRIS_VERSION}}', '$IGRIS_VERSION')
content = content.replace('{{INSTALL_DATE}}', '$INSTALL_DATE')

# Determine hook status
hook_status = "No enhancement hooks installed"
installed_plugins = "None"

try:
    with open('ai/plugins/installed.json', 'r') as f:
        plugins_data = json.load(f)
    plugin_count = len(plugins_data.get('plugins', []))
    if plugin_count > 0:
        hook_status = f"{plugin_count} plugin(s) with enhancement hooks installed"
        names = [p.get('name', 'unknown') for p in plugins_data.get('plugins', [])]
        installed_plugins = ', '.join(names)
except:
    pass

content = content.replace('{{HOOK_STATUS}}', hook_status)
content = content.replace('{{INSTALLED_ENHANCEMENT_PLUGINS}}', installed_plugins)

# Replace persona injection (multi-line safe)
persona_content = ""
persona_file = "$PERSONA_TEMP"
if persona_file:
    with open(persona_file, 'r') as f:
        persona_content = f.read()
content = content.replace('{{PERSONA_INJECTION}}', persona_content)

# Write result
with open('CLAUDE.md', 'w') as f:
    f.write(content)
PYTHON_EOF

  # Cleanup temp file
  if [ -n "$PERSONA_TEMP" ]; then
    rm -f "$PERSONA_TEMP"
  fi
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
