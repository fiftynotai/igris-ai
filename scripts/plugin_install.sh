#!/bin/bash

# Igris AI Plugin Installer
# Installs a Igris AI plugin from a git repository

set -euo pipefail

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
  if ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$file" 2>/dev/null; then
    echo "❌ Error: $desc is corrupted or contains invalid JSON"
    echo "   File: $file"
    return 1
  fi

  return 0
}

PLUGIN_REPO="${1:-}"

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
if [ "${IGRIS_TEST_MODE:-}" = "1" ] && [ -d "$PLUGIN_REPO" ]; then
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
export _PLUGIN_JSON="$TEMP_DIR/plugin.json"
PLUGIN_METADATA=$(python3 <<'PYEOF'
import json, os
with open(os.environ['_PLUGIN_JSON'], 'r') as f:
    data = json.load(f)
    print(data.get('name', ''))
    print(data.get('version', ''))
PYEOF
)
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
export _PLUGIN_NAME="$PLUGIN_NAME"
export _PLUGIN_VERSION="$PLUGIN_VERSION"
export _PLUGIN_REPO="$PLUGIN_REPO"
export _INSTALL_DATE="$INSTALL_DATE"
export _CAPABILITIES="$CAPABILITIES"
export _HOOKS_JSON="$HOOKS_JSON"
python3 <<'PYEOF' > "$TEMP_JSON"
import json, os

# Read current installed.json
with open('ai/plugins/installed.json', 'r') as f:
    data = json.load(f)

plugin_name = os.environ.get('_PLUGIN_NAME', '')
plugin_version = os.environ.get('_PLUGIN_VERSION', '')
plugin_repo = os.environ.get('_PLUGIN_REPO', '')
install_date = os.environ.get('_INSTALL_DATE', '')
capabilities = os.environ.get('_CAPABILITIES', '')
hooks_json = os.environ.get('_HOOKS_JSON', '{}')

# Remove if already exists
data['plugins'] = [p for p in data['plugins'] if p['name'] != plugin_name]

# Add new entry
plugin_entry = {
    'name': plugin_name,
    'version': plugin_version,
    'repo': plugin_repo,
    'location': plugin_repo,
    'installed_at': install_date,
    'capabilities': [c.strip() for c in capabilities.split(',') if c.strip()]
}

# Add hooks if present
hooks_data = json.loads(hooks_json)
if hooks_data:
    plugin_entry['hooks'] = hooks_data

data['plugins'].append(plugin_entry)
data['last_updated'] = install_date

# Write updated JSON
print(json.dumps(data, indent=2))
PYEOF

if [ $? -eq 0 ] && [ -s "$TEMP_JSON" ]; then
    mv "$TEMP_JSON" ai/plugins/installed.json
else
    echo "⚠️  Warning: Failed to update plugin registry"
    rm -f "$TEMP_JSON"
fi

# Update .igris_version if it exists
if [ -f ".igris_version" ]; then
    TEMP_VERSION=$(mktemp)
    export _PLUGIN_NAME="$PLUGIN_NAME"
    export _PLUGIN_VERSION="$PLUGIN_VERSION"
    export _INSTALL_DATE="$INSTALL_DATE"
    export _PLUGIN_REPO="$PLUGIN_REPO"
    python3 <<'PYEOF' > "$TEMP_VERSION"
import json, os

try:
    with open('.igris_version', 'r') as f:
        data = json.load(f)

    plugin_name = os.environ.get('_PLUGIN_NAME', '')
    plugin_version = os.environ.get('_PLUGIN_VERSION', '')
    install_date = os.environ.get('_INSTALL_DATE', '')
    plugin_repo = os.environ.get('_PLUGIN_REPO', '')

    # Update plugin version
    if 'plugins' not in data:
        data['plugins'] = {}

    data['plugins'][plugin_name] = {
        'version': plugin_version,
        'installed_at': install_date,
        'repo': plugin_repo
    }
    data['last_updated'] = install_date

    print(json.dumps(data, indent=2))
except Exception as e:
    # If error, output original file
    with open('.igris_version', 'r') as f:
        print(f.read())
PYEOF

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
    else
      PERSONA_HOOK=$(python3 <<'PYEOF' 2>/dev/null || echo ""
import json
try:
    with open('ai/plugins/installed.json', 'r') as f:
        data = json.load(f)
    for plugin in data.get('plugins', []):
        hooks = plugin.get('hooks', {})
        if 'persona_injection' in hooks:
            print(hooks['persona_injection'])
            break
except Exception:
    pass
PYEOF
)
    fi
    if [ -n "$PERSONA_HOOK" ] && [ -f "$PERSONA_HOOK" ]; then
      PERSONA_INJECTION=$(cat "$PERSONA_HOOK")
    fi
  fi

  # Write persona content to temp file if present (preserves all formatting)
  PERSONA_TEMP=""
  if [ -n "$PERSONA_INJECTION" ]; then
    PERSONA_TEMP=$(mktemp)
    printf '%s' "$PERSONA_INJECTION" > "$PERSONA_TEMP"
  fi

  # Regenerate CLAUDE.md with proper multi-line persona injection
  export _TEMPLATE_PATH="$IGRIS_DIR/scripts/templates/CLAUDE.md.template"
  export _IGRIS_VERSION="$IGRIS_VERSION"
  export _INSTALL_DATE="$INSTALL_DATE"
  export _PERSONA_TEMP="${PERSONA_TEMP:-}"
  python3 <<'PYEOF'
import json, os

# Read template
with open(os.environ['_TEMPLATE_PATH'], 'r') as f:
    content = f.read()

# Replace simple variables
content = content.replace('{{IGRIS_VERSION}}', os.environ.get('_IGRIS_VERSION', 'unknown'))
content = content.replace('{{INSTALL_DATE}}', os.environ.get('_INSTALL_DATE', ''))

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
except Exception:
    pass

content = content.replace('{{HOOK_STATUS}}', hook_status)
content = content.replace('{{INSTALLED_ENHANCEMENT_PLUGINS}}', installed_plugins)

# Replace persona injection (multi-line safe)
persona_content = ""
persona_file = os.environ.get('_PERSONA_TEMP', '')
if persona_file:
    try:
        with open(persona_file, 'r') as f:
            persona_content = f.read()
    except Exception:
        pass
content = content.replace('{{PERSONA_INJECTION}}', persona_content)

# Write result
with open('CLAUDE.md', 'w') as f:
    f.write(content)
PYEOF

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
