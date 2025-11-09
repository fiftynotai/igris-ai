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

# Function to migrate from Blueprint AI to Igris AI
migrate_from_blueprint() {
  echo "🔄 Detected Blueprint AI project - starting migration to Igris AI..."
  echo ""

  # 1. Validate blueprint version file
  if ! python3 -c "import json; json.load(open('.blueprint_version'))" 2>/dev/null; then
    echo "❌ Error: Invalid .blueprint_version file"
    echo ""
    echo "The version file appears to be corrupted."
    echo "Please restore from backup or reinitialize."
    exit 1
  fi

  # 2. Create backup
  BACKUP_DIR=".igris_backup/blueprint_migration_$(date +%Y%m%d_%H%M%S)"
  mkdir -p "$BACKUP_DIR"
  cp .blueprint_version "$BACKUP_DIR/"
  echo "💾 Backup created: $BACKUP_DIR/.blueprint_version"
  echo ""

  # 3. Migrate version file (rename key)
  echo "📝 Migrating version file..."
  python3 <<EOF
import json
with open('.blueprint_version', 'r') as f:
    data = json.load(f)

# Migrate key name: blueprint_ai_version → igris_ai_version
if 'blueprint_ai_version' in data:
    data['igris_ai_version'] = data.pop('blueprint_ai_version')

with open('.igris_version', 'w') as f:
    json.dump(data, f, indent=2)
EOF

  if [ ! -f ".igris_version" ]; then
    echo "❌ Error: Migration failed - could not create .igris_version"
    exit 1
  fi

  # 4. Remove old file
  rm .blueprint_version

  # 5. Show success message
  echo "✅ Migration complete!"
  echo ""
  echo "📋 What was migrated:"
  echo "  - .blueprint_version → .igris_version"
  echo "  - All briefs, session data, and context preserved"
  echo "  - Plugins configuration preserved"
  echo ""
  echo "🔄 Continuing with update to latest Igris AI..."
  echo ""
}

# Check for Blueprint AI project and migrate if needed
if [ -f ".blueprint_version" ] && [ ! -f ".igris_version" ]; then
  migrate_from_blueprint
fi

# Check if both files exist (unusual state)
if [ -f ".blueprint_version" ] && [ -f ".igris_version" ]; then
  echo "⚠️  Warning: Both .blueprint_version and .igris_version exist"
  echo ""
  echo "This is an unusual state. Please choose:"
  echo "  1) Keep .igris_version (recommended if already migrated)"
  echo "  2) Re-migrate from .blueprint_version (will backup and overwrite)"
  echo ""
  read -p "Choice [1/2]: " CHOICE
  if [ "$CHOICE" = "2" ]; then
    rm .igris_version
    migrate_from_blueprint
  else
    echo ""
    echo "✅ Using existing .igris_version"
    echo "   (Removing .blueprint_version)"
    BACKUP_DIR=".igris_backup/cleanup_$(date +%Y%m%d_%H%M%S)"
    mkdir -p "$BACKUP_DIR"
    mv .blueprint_version "$BACKUP_DIR/"
    echo "   (Old file backed up to $BACKUP_DIR)"
    echo ""
  fi
fi

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
echo "  - CLAUDE.md (Claude Code context file)"
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

  # CLAUDE.md
  if [ -f "$TEMP_DIR/scripts/templates/CLAUDE.md.template" ]; then
    echo ""
    echo "Context:"
    echo "  - CLAUDE.md (regenerated from template)"
  fi

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
cp CLAUDE.md "$BACKUP_DIR/" 2>/dev/null || true
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

  # Create scripts directory if it doesn't exist (for old installations)
  mkdir -p scripts

  cp "$TEMP_DIR/scripts/plugin_install.sh" scripts/
  cp "$TEMP_DIR/scripts/plugin_uninstall.sh" scripts/
  cp "$TEMP_DIR/scripts/plugin_list.sh" scripts/

  # Copy persona management scripts (if they exist)
  if [ -f "$TEMP_DIR/scripts/persona_install.sh" ]; then
    cp "$TEMP_DIR/scripts/persona_install.sh" scripts/
  fi
  if [ -f "$TEMP_DIR/scripts/persona_mask.sh" ]; then
    cp "$TEMP_DIR/scripts/persona_mask.sh" scripts/
  fi

  chmod +x scripts/*.sh
fi

# Copy CLAUDE.md template for local use
if [ -f "$TEMP_DIR/scripts/templates/CLAUDE.md.template" ]; then
  echo "  - Copying CLAUDE.md template..."
  cp "$TEMP_DIR/scripts/templates/CLAUDE.md.template" scripts/
fi

# Regenerate CLAUDE.md with latest template
if [ -f "scripts/CLAUDE.md.template" ]; then
  echo "  - Regenerating CLAUDE.md..."

  # Read persona injection from installed plugins (if any)
  PERSONA_INJECTION=""
  if [ -f "ai/plugins/installed.json" ]; then
    PERSONA_INJECTION=$(python3 <<'PYEOF'
import json
import sys

try:
    with open('ai/plugins/installed.json', 'r') as f:
        data = json.load(f)

    injection_parts = []
    for plugin_name, plugin_data in data.get('plugins', {}).items():
        hooks = plugin_data.get('hooks', {})
        if 'persona_injection' in hooks:
            injection_parts.append(hooks['persona_injection'])

    if injection_parts:
        print('\n\n'.join(injection_parts))
except:
    pass
PYEOF
    )
  fi

  # Generate CLAUDE.md with variable substitution
  INSTALL_DATE=$(date -u +"%Y-%m-%d")

  # First pass: Replace simple variables
  sed -e "s/{{IGRIS_VERSION}}/$REMOTE_VERSION/g" \
      -e "s/{{INSTALL_DATE}}/$INSTALL_DATE/g" \
      "$TEMP_DIR/scripts/templates/CLAUDE.md.template" > CLAUDE.md.tmp

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
