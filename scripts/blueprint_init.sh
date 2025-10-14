#!/bin/bash

# Blueprint AI Initialization Script
# Initializes Blueprint AI in a target project

set -e

echo "🎯 Blueprint AI - Project Initialization"
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

# Check if Blueprint AI already initialized
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

# Get the Blueprint AI installation directory
BLUEPRINT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"

# Get Blueprint AI version
BLUEPRINT_VERSION=$(cat "$BLUEPRINT_DIR/version.txt" 2>/dev/null || echo "unknown")

# Copy templates
echo "📄 Copying templates..."
cp "$BLUEPRINT_DIR/ai/briefs/BR-TEMPLATE.md" ai/briefs/
cp "$BLUEPRINT_DIR/ai/prompts/"*.md ai/prompts/
cp "$BLUEPRINT_DIR/ai/checks/"*.md ai/checks/
cp "$BLUEPRINT_DIR/ai/templates/"*.md ai/templates/

# Copy CONTRIBUTING guide
cp "$BLUEPRINT_DIR/ai/CONTRIBUTING.md" ai/

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
# Blueprint AI Plugins

This directory tracks installed Blueprint AI plugins.

## Installed Plugins

See `installed.json` for the list of installed plugins.

## Installing a Plugin

```bash
./scripts/plugin_install.sh <plugin-repo-url>
```

## Available Plugins

- **blueprint-ai-distribution-flutter** - Smart release automation for Flutter projects

## Creating Your Own Plugin

See the main Blueprint AI documentation for plugin development guide.
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
cp "$BLUEPRINT_DIR/scripts/templates/startup.sh.template" .claude/hooks/startup.sh
chmod +x .claude/hooks/startup.sh

# Create CLAUDE.md with variable substitution
sed -e "s/{{BLUEPRINT_VERSION}}/$BLUEPRINT_VERSION/g" \
    -e "s/{{INSTALL_DATE}}/$(date -u +"%Y-%m-%d")/g" \
    "$BLUEPRINT_DIR/scripts/templates/CLAUDE.md.template" > CLAUDE.md

# Copy core scripts
echo "🔧 Installing Blueprint AI scripts..."
cp "$BLUEPRINT_DIR/scripts/plugin_install.sh" scripts/
cp "$BLUEPRINT_DIR/scripts/plugin_uninstall.sh" scripts/
cp "$BLUEPRINT_DIR/scripts/plugin_list.sh" scripts/
cp "$BLUEPRINT_DIR/scripts/plugin_update.sh" scripts/
cp "$BLUEPRINT_DIR/scripts/blueprint_update.sh" scripts/
cp "$BLUEPRINT_DIR/scripts/install_shell_integration.sh" scripts/
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
cat > .blueprint_version <<EOF
{
  "blueprint_ai_version": "$BLUEPRINT_VERSION",
  "installed_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "last_updated": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "plugins": {}
}
EOF

echo ""
echo "✅ Blueprint AI initialized successfully!"
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
echo "   🚀 Welcome to Blueprint AI on Claude Code"
echo "   📊 Project Status: [briefs, status, blockers]"
echo "   💡 Recommended Next Task: [highest priority]"
echo "   Ready for your command!"
echo ""
echo "2. (Optional) Install shell integration for terminal notifications:"
echo "   $ ./scripts/install_shell_integration.sh"
echo "   This will show Blueprint AI version when entering the project"
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
echo "🔗 More info: https://github.com/Mohamed50/blueprint-ai"
echo ""
