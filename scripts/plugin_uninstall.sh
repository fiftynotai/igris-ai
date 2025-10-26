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

# Parse arguments
PLUGIN_NAME=""
AUTO_CONFIRM=false

while [[ $# -gt 0 ]]; do
  case $1 in
    -y|--yes)
      AUTO_CONFIRM=true
      shift
      ;;
    *)
      PLUGIN_NAME="$1"
      shift
      ;;
  esac
done

if [ -z "$PLUGIN_NAME" ]; then
  echo "❌ Error: Plugin name not provided"
  echo ""
  echo "Usage: ./scripts/plugin_uninstall.sh <plugin-name> [-y|--yes]"
  echo ""
  echo "Options:"
  echo "  -y, --yes    Skip confirmation prompt"
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

# Confirmation prompt (skip if auto-confirm enabled)
if [ "$AUTO_CONFIRM" = false ]; then
  echo "⚠️  This will remove the plugin from your project"
  read -p "Continue? [y/N]: " CONFIRM

  if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "Uninstall cancelled"
    exit 0
  fi
fi

echo ""
echo "🗑️  Uninstalling plugin..."

# Get plugin info for cleanup
PLUGIN_LOCATION=$(python3 -c "
import sys, json
data = json.load(sys.stdin)
for p in data['plugins']:
    if p['name'] == '$PLUGIN_NAME':
        # Try 'location' first (new), fallback to 'repo' (old)
        print(p.get('location', p.get('repo', '')))
        break
" < ai/plugins/installed.json)

HAS_HOOKS=$(python3 -c "
import sys, json
data = json.load(sys.stdin)
for p in data['plugins']:
    if p['name'] == '$PLUGIN_NAME':
        print('yes' if 'hooks' in p and p['hooks'] else 'no')
        break
" < ai/plugins/installed.json)

# Create backup before removal
BACKUP_DIR=".igris_backup/uninstall/$(date +%Y%m%d_%H%M%S)_${PLUGIN_NAME}"
echo "💾 Creating backup at $BACKUP_DIR..."
mkdir -p "$BACKUP_DIR"
cp ai/plugins/installed.json "$BACKUP_DIR/" 2>/dev/null || true
cp .igris_version "$BACKUP_DIR/" 2>/dev/null || true
[ -f CLAUDE.md ] && cp CLAUDE.md "$BACKUP_DIR/" 2>/dev/null || true

# Phase 1: Plugin-specific cleanup (if plugin provides uninstall.sh)
if [ -n "$PLUGIN_LOCATION" ] && [ -d "$PLUGIN_LOCATION" ] && [ -f "$PLUGIN_LOCATION/uninstall.sh" ]; then
  echo ""
  echo "🔧 Running plugin cleanup..."
  PROJECT_DIR=$(pwd)
  bash "$PLUGIN_LOCATION/uninstall.sh" "$PROJECT_DIR" 2>&1 | sed 's/^/   /'
elif [ -n "$PLUGIN_LOCATION" ]; then
  echo ""
  echo "⚠️  Note: Plugin does not provide uninstall.sh"
  echo "   Plugin files may still exist in:"
  echo "   - scripts/"
  echo "   - templates/"
  echo "   - ai/plugins/${PLUGIN_NAME}/"
  echo ""
  echo "   Manual cleanup may be required"
fi

# Phase 2: Core cleanup (hooks)
if [ "$HAS_HOOKS" = "yes" ] && [ -f "CLAUDE.md" ]; then
  echo ""
  echo "🔄 Removing plugin hooks from CLAUDE.md..."

  # Find Igris AI installation
  IGRIS_DIR=$(dirname "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")")")

  # Get Igris AI version
  IGRIS_VERSION=$(python3 -c "
import json
with open('.igris_version', 'r') as f:
    data = json.load(f)
    print(data.get('igris_ai_version', 'unknown'))
" 2>/dev/null || echo "unknown")

  INSTALL_DATE=$(cat CLAUDE.md | grep "Installed:" | sed 's/.*Installed:\*\* //' 2>/dev/null || date -u +"%Y-%m-%d")

  # Regenerate CLAUDE.md without this plugin's hooks
  # Get remaining plugins' hooks (excluding the one being uninstalled)
  PERSONA_INJECTION=""
  if command -v jq &> /dev/null; then
    # Get hooks from remaining plugins only
    PERSONA_HOOK=$(python3 -c "
import json
with open('ai/plugins/installed.json', 'r') as f:
    data = json.load(f)
    for plugin in data['plugins']:
        if plugin['name'] != '$PLUGIN_NAME' and 'hooks' in plugin and 'persona_injection' in plugin['hooks']:
            hook_path = plugin['hooks']['persona_injection']
            try:
                with open(hook_path, 'r') as h:
                    print(h.read())
                    break
            except:
                pass
" 2>/dev/null)

    if [ -n "$PERSONA_HOOK" ]; then
      PERSONA_INJECTION="$PERSONA_HOOK"
    fi
  fi

  # Regenerate CLAUDE.md
  PERSONA_TEMP=""
  if [ -n "$PERSONA_INJECTION" ]; then
    PERSONA_TEMP=$(mktemp)
    printf '%s' "$PERSONA_INJECTION" > "$PERSONA_TEMP"
  fi

  python3 <<PYTHON_EOF
# Read template
with open("$IGRIS_DIR/scripts/templates/CLAUDE.md.template", 'r') as f:
    content = f.read()

# Replace simple variables
content = content.replace('{{IGRIS_VERSION}}', '$IGRIS_VERSION')
content = content.replace('{{INSTALL_DATE}}', '$INSTALL_DATE')

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

  echo "   ✅ CLAUDE.md regenerated without plugin hooks"
fi

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
echo "📋 Summary:"
echo "   - Plugin removed from registry"
if [ "$HAS_HOOKS" = "yes" ]; then
  echo "   - Plugin hooks removed from CLAUDE.md"
fi
if [ -n "$PLUGIN_LOCATION" ] && [ -d "$PLUGIN_LOCATION" ] && [ -f "$PLUGIN_LOCATION/uninstall.sh" ]; then
  echo "   - Plugin files cleaned up"
elif [ -n "$PLUGIN_LOCATION" ]; then
  echo "   - ⚠️  Plugin files may remain (no uninstall.sh provided)"
fi
echo "   - Backup saved: $BACKUP_DIR"
echo ""
