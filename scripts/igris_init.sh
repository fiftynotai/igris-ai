#!/bin/bash

# Igris AI Initialization Script
# Initializes Igris AI in a target project

set -e

echo "⚔️  Igris AI - Project Initialization"
echo "========================================"
echo ""

# Get target project directory
TARGET_DIR=${1:-.}

if [ ! -d "$TARGET_DIR" ]; then
  echo "❌ Error: Directory '$TARGET_DIR' does not exist"
  exit 1
fi

cd "$TARGET_DIR"
TARGET_DIR=$(pwd)

echo "📁 Target directory: $TARGET_DIR"
echo ""

# Check if Igris AI already initialized
if [ -d "ai" ]; then
  echo "⚠️  Warning: 'ai/' directory already exists"
  read -p "Continue and overwrite? [y/N]: " OVERWRITE
  if [[ ! "$OVERWRITE" =~ ^[Yy]$ ]]; then
    echo "❌ Initialization cancelled"
    exit 1
  fi
fi

# Create directory structure
echo "📦 Creating directory structure..."
mkdir -p ai/{briefs,prompts,checks,templates,session/archive,context,plugins}
mkdir -p scripts
mkdir -p docs

# Get the Igris AI installation directory
IGRIS_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"

# Get Igris AI version
IGRIS_VERSION=$(cat "$IGRIS_DIR/version.txt" 2>/dev/null || echo "unknown")

# Copy templates
echo "📄 Copying templates..."
cp "$IGRIS_DIR/ai/briefs/BR-TEMPLATE.md" ai/briefs/
cp "$IGRIS_DIR/ai/prompts/"*.md ai/prompts/
cp "$IGRIS_DIR/ai/checks/"*.md ai/checks/
cp "$IGRIS_DIR/ai/templates/"*.md ai/templates/

# Copy CONTRIBUTING guide
cp "$IGRIS_DIR/ai/CONTRIBUTING.md" ai/

# Create empty session files
echo "📝 Creating session files..."
cat > ai/session/CURRENT_SESSION.md <<'EOF'
# Current Session

**Status:** No active session
**Last Updated:** N/A

---

## Session Goal

[No active session]

---

## Tasks

[None]

---

## Current State

[No active work in progress]

---

## Next Steps When Resuming

[N/A]
EOF

cat > ai/session/BLOCKERS.md <<'EOF'
# Active Blockers

**Last Updated:** N/A

---

[No active blockers]
EOF

cat > ai/session/DECISIONS.md <<'EOF'
# Architectural Decisions

**Last Updated:** N/A

---

[No decisions recorded yet]
EOF

cat > ai/session/LEARNINGS.md <<'EOF'
# Learnings & Patterns

**Last Updated:** N/A

---

[No learnings recorded yet]
EOF

# Create context README
cat > ai/context/README.md <<'EOF'
# Architecture Context

This directory should contain project-specific architecture documentation:

- **architecture_map.md** - Architecture pattern, layer boundaries, module structure
- **api_pattern.md** - API call patterns, state management, error handling
- **coding_guidelines.md** - Naming conventions, doc-comments, linting rules
- **module_catalog.md** - Module inventory, purposes, dependencies

## How to Generate

Use the `generate_architecture_docs.md` prompt to have Claude analyze your project and create these files:

```
Please analyze this project using ai/prompts/generate_architecture_docs.md
```

Claude will ask questions about your architecture and generate comprehensive documentation.
EOF

# Create plugins README
cat > ai/plugins/README.md <<'EOF'
# Igris AI Plugins

This directory tracks installed Igris AI plugins.

## Installed Plugins

See `installed.json` for the list of installed plugins.

## Installing a Plugin

```bash
./scripts/plugin_install.sh <plugin-repo-url>
```

## Available Plugins

- **igris-ai-persona-igris** - Shadow Knight persona pack
- **igris-ai-distribution-flutter** - Smart release automation for Flutter projects

## Creating Your Own Plugin

See the main Igris AI documentation for plugin development guide.
EOF

# Initialize plugin registry
cat > ai/plugins/installed.json <<'EOF'
{
  "plugins": [],
  "last_updated": null
}
EOF

# Create Claude Code integration (hooks + CLAUDE.md)
echo "🤖 Setting up Claude Code integration..."
mkdir -p .claude/hooks

# Copy startup hook
cp "$IGRIS_DIR/scripts/templates/startup.sh.template" .claude/hooks/startup.sh
chmod +x .claude/hooks/startup.sh

# Resolve persona hook (if plugin provides one)
PERSONA_INJECTION=""
if [ -f "ai/plugins/installed.json" ] && command -v jq &> /dev/null; then
  PERSONA_HOOK=$(jq -r '.plugins[] | select(.hooks.persona_injection) | .hooks.persona_injection' ai/plugins/installed.json 2>/dev/null || echo "")
  if [ -n "$PERSONA_HOOK" ] && [ -f "$PERSONA_HOOK" ]; then
    PERSONA_INJECTION=$(cat "$PERSONA_HOOK")
  fi
fi

# Create CLAUDE.md with variable substitution
# Use a two-step process to handle multi-line PERSONA_INJECTION
INSTALL_DATE=$(date -u +"%Y-%m-%d")

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

# Copy core scripts
echo "🔧 Installing Igris AI scripts..."
cp "$IGRIS_DIR/scripts/plugin_install.sh" scripts/
cp "$IGRIS_DIR/scripts/plugin_uninstall.sh" scripts/
cp "$IGRIS_DIR/scripts/plugin_list.sh" scripts/
cp "$IGRIS_DIR/scripts/plugin_update.sh" scripts/
cp "$IGRIS_DIR/scripts/igris_update.sh" scripts/
cp "$IGRIS_DIR/scripts/install_shell_integration.sh" scripts/
chmod +x scripts/*.sh

# Create archive README
cat > ai/session/archive/README.md <<'EOF'
# Session Archive

Completed sessions are archived here for reference.

## Naming Convention

`YYYY-MM-DD-NNN.md` where NNN is a session number for that day.

Example: `2025-10-13-001.md`
EOF

# Create version tracking file
echo "📌 Creating version tracking..."
cat > .igris_version <<EOF
{
  "igris_ai_version": "$IGRIS_VERSION",
  "installed_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "last_updated": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "plugins": {}
}
EOF

echo ""
echo "✅ Igris AI initialized successfully!"
echo ""
echo "🤖 Claude Code Integration:"
echo "   ✓ Startup hook enabled (.claude/hooks/startup.sh)"
echo "   ✓ Context file created (CLAUDE.md)"
echo "   ✓ True zero-configuration - works immediately!"
echo ""
echo "📚 Getting Started:"
echo ""
echo "1. Launch Claude Code:"
echo "   $ claude"
echo ""
echo "   BEFORE YOU TYPE, you'll see:"
echo "   ⚔️  Welcome to Igris AI on Claude Code"
echo "   📊 Project Status: [briefs, status, blockers]"
echo "   💡 Recommended Next Task: [highest priority]"
echo "   Ready for your command!"
echo ""
echo "2. (Optional) Install shell integration for terminal notifications:"
echo "   $ ./scripts/install_shell_integration.sh"
echo "   This will show Igris AI version when entering the project"
echo ""
echo "📚 Next Steps:"
echo ""
echo "1. Generate coding guidelines (recommended first):"
echo "   'Please generate coding guidelines using ai/prompts/generate_coding_guidelines.md'"
echo ""
echo "2. Generate architecture documentation:"
echo "   'Please analyze this project using ai/prompts/generate_architecture_docs.md'"
echo ""
echo "3. Analyze your codebase for migration tasks:"
echo "   'Please analyze this codebase using ai/prompts/migration_analysis.md'"
echo ""
echo "4. Install plugins (optional):"
echo "   $ ./scripts/plugin_install.sh <plugin-repo-url>"
echo ""
echo "📖 Documentation: ai/CONTRIBUTING.md"
echo "🔗 More info: https://github.com/fiftynotai/igris-ai"
echo ""
