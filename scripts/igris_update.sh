#!/bin/bash

# Igris AI Update Script
# Updates Igris AI core to the latest version

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

DRY_RUN=false
FORCE=false

# Parse arguments
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
    *)
      echo "❌ Unknown option: $1"
      echo ""
      echo "Usage: ./scripts/igris_update.sh [--dry-run] [--force]"
      echo ""
      echo "Options:"
      echo "  --dry-run   Show what would be updated without making changes"
      echo "  --force     Skip version check and force update"
      exit 1
      ;;
  esac
done

echo "⚔️  Igris AI Update Manager"
echo "=============================="
echo ""

# Check if Igris AI is initialized
if [ ! -f ".igris_version" ]; then
  echo "❌ Error: Igris AI not initialized in this directory"
  echo ""
  echo "This doesn't appear to be an Igris AI project."
  echo "Please run: ./scripts/igris_init.sh"
  exit 1
fi

# Read current version using python3 (reliable JSON parsing)
CURRENT_VERSION=$(python3 -c "
import json
with open('.igris_version', 'r') as f:
    data = json.load(f)
    print(data.get('igris_ai_version', ''))
")

echo "📦 Current version: $CURRENT_VERSION"
echo ""

# Create temporary directory for update
TEMP_DIR=$(mktemp -d)

# Fetch latest version from GitHub
echo "🌐 Checking for updates..."
IGRIS_REPO="https://github.com/fiftynotai/igris-ai"
git clone --depth 1 --quiet "$IGRIS_REPO" "$TEMP_DIR" 2>&1 | grep -v "^Cloning" || true

if [ ! -f "$TEMP_DIR/version.txt" ]; then
  echo "❌ Error: Could not fetch remote version"
  rm -rf "$TEMP_DIR"
  exit 1
fi

REMOTE_VERSION=$(cat "$TEMP_DIR/version.txt")

echo "📡 Latest version: $REMOTE_VERSION"
echo ""

# Compare versions
if [ "$CURRENT_VERSION" = "$REMOTE_VERSION" ] && [ "$FORCE" = false ]; then
  echo "✅ Igris AI is already up to date!"
  rm -rf "$TEMP_DIR"
  exit 0
fi

if [ "$CURRENT_VERSION" = "$REMOTE_VERSION" ]; then
  echo "⚠️  Versions are the same, but --force flag provided"
fi

# Show what will be updated
echo "📋 Update Summary:"
echo "  From: $CURRENT_VERSION"
echo "  To:   $REMOTE_VERSION"
echo ""
echo "📝 Files that will be updated:"
echo "  - ai/prompts/*.md (system prompts)"
echo "  - ai/templates/*.md (brief templates)"
echo "  - ai/checks/*.md (QA checklists)"
echo "  - ai/CONTRIBUTING.md (documentation)"
echo "  - scripts/plugin_*.sh (plugin management scripts)"
echo ""
echo "🔒 Files that will be preserved:"
echo "  - ai/briefs/*.md (your work items)"
echo "  - ai/session/*.md (your session data)"
echo "  - ai/context/*.md (your architecture docs)"
echo "  - ai/plugins/installed.json (plugin registry)"
echo ""

if [ "$DRY_RUN" = true ]; then
  echo "🔍 DRY RUN MODE - No changes will be made"
  echo ""
  echo "Files that would be updated:"

  # List files that would be updated
  if [ -d "$TEMP_DIR/ai/prompts" ]; then
    echo ""
    echo "Prompts:"
    ls "$TEMP_DIR/ai/prompts/"*.md 2>/dev/null | xargs -n1 basename | sed 's/^/  - /'
  fi

  if [ -d "$TEMP_DIR/ai/templates" ]; then
    echo ""
    echo "Templates:"
    ls "$TEMP_DIR/ai/templates/"*.md 2>/dev/null | xargs -n1 basename | sed 's/^/  - /'
  fi

  if [ -d "$TEMP_DIR/ai/checks" ]; then
    echo ""
    echo "Checks:"
    ls "$TEMP_DIR/ai/checks/"*.md 2>/dev/null | xargs -n1 basename | sed 's/^/  - /'
  fi

  echo ""
  echo "Scripts:"
  ls "$TEMP_DIR/scripts/plugin_"*.sh 2>/dev/null | xargs -n1 basename | sed 's/^/  - /'

  echo ""
  echo "✅ Dry run complete. Run without --dry-run to apply update."
  rm -rf "$TEMP_DIR"
  exit 0
fi

# Confirm update
read -p "Continue with update? [y/N]: " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "❌ Update cancelled"
  rm -rf "$TEMP_DIR"
  exit 0
fi

echo ""
echo "📦 Starting update..."
echo ""

# Create backup
BACKUP_DIR=".igris_backup/$(date +%Y%m%d_%H%M%S)"
echo "💾 Creating backup at $BACKUP_DIR..."
mkdir -p "$BACKUP_DIR"

# Backup files that will be updated
cp -r ai/prompts "$BACKUP_DIR/" 2>/dev/null || true
cp -r ai/templates "$BACKUP_DIR/" 2>/dev/null || true
cp -r ai/checks "$BACKUP_DIR/" 2>/dev/null || true
cp ai/CONTRIBUTING.md "$BACKUP_DIR/" 2>/dev/null || true
cp scripts/plugin_*.sh "$BACKUP_DIR/" 2>/dev/null || true
cp .igris_version "$BACKUP_DIR/" 2>/dev/null || true

echo "✅ Backup created"
echo ""

# Update system files
echo "📝 Updating system files..."

# Update prompts
if [ -d "$TEMP_DIR/ai/prompts" ]; then
  echo "  - Updating prompts..."
  cp "$TEMP_DIR/ai/prompts/"*.md ai/prompts/
fi

# Update templates (but preserve user's custom templates)
if [ -d "$TEMP_DIR/ai/templates" ]; then
  echo "  - Updating templates..."
  cp "$TEMP_DIR/ai/templates/"*.md ai/templates/
fi

# Update checks
if [ -d "$TEMP_DIR/ai/checks" ]; then
  echo "  - Updating checks..."
  cp "$TEMP_DIR/ai/checks/"*.md ai/checks/
fi

# Update CONTRIBUTING.md
if [ -f "$TEMP_DIR/ai/CONTRIBUTING.md" ]; then
  echo "  - Updating CONTRIBUTING.md..."
  cp "$TEMP_DIR/ai/CONTRIBUTING.md" ai/
fi

# Update plugin management scripts
if [ -f "$TEMP_DIR/scripts/plugin_install.sh" ]; then
  echo "  - Updating plugin management scripts..."
  cp "$TEMP_DIR/scripts/plugin_install.sh" scripts/
  cp "$TEMP_DIR/scripts/plugin_uninstall.sh" scripts/
  cp "$TEMP_DIR/scripts/plugin_list.sh" scripts/
  chmod +x scripts/plugin_*.sh
fi

# Update .igris_version
echo "  - Updating version tracking..."
UPDATE_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

TEMP_VERSION=$(mktemp)
python3 <<EOF > "$TEMP_VERSION"
import json

with open('.igris_version', 'r') as f:
    data = json.load(f)

# Update version
data['igris_ai_version'] = '$REMOTE_VERSION'
data['last_updated'] = '$UPDATE_DATE'

print(json.dumps(data, indent=2))
EOF

if [ $? -eq 0 ] && [ -s "$TEMP_VERSION" ]; then
    mv "$TEMP_VERSION" .igris_version
else
    echo "⚠️  Warning: Failed to update version tracking"
    rm -f "$TEMP_VERSION"
fi

# Cleanup
rm -rf "$TEMP_DIR"

echo ""
echo "✅ Igris AI updated successfully!"
echo ""
echo "📦 Updated to version: $REMOTE_VERSION"
echo "💾 Backup saved at: $BACKUP_DIR"
echo ""
echo "📝 What's new in $REMOTE_VERSION:"
echo "  See CHANGELOG.md or visit:"
echo "  https://github.com/fiftynotai/igris-ai/releases"
echo ""
echo "⚠️  Note: If you have plugins installed, update them separately:"
echo "  ./scripts/plugin_update.sh <plugin-name>"
echo ""
