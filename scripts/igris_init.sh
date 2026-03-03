#!/bin/bash

# Igris AI Initialization Script
# Initializes Igris AI in a target project

set -euo pipefail

# ============================================================
# DEPRECATED: This is the v4 legacy copy-based installer.
# For v5+, use: ./scripts/igris_install.sh <target_directory>
# The symlink installer uses the centralized brain at ~/.igris/
# ============================================================

# v5.0 Brain Check — suggest igris_install.sh if brain exists
if [ -d "$HOME/.igris" ]; then
  echo ""
  echo "💡 Igris Brain detected at ~/.igris/"
  echo "   Consider using the new symlink installer instead:"
  echo "   ./scripts/igris_install.sh ${1:-.}"
  echo ""
  echo "   Benefits: shared core files, persistent memory, instant updates"
  echo "   The v5.0 copy-based install will continue to work."
  echo ""
  # Check if running interactively
  if [ -t 0 ]; then
    read -p "Use new installer? [Y/n]: " USE_NEW
    USE_NEW=${USE_NEW:-Y}
    if [[ "$USE_NEW" =~ ^[Yy]$ ]]; then
      SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
      exec "$SCRIPT_DIR/igris_install.sh" "${1:-.}"
    fi
  fi
  echo "Continuing with v5.0 copy-based install..."
  echo ""
fi

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
mkdir -p ai/{briefs,prompts,templates,session/archive,context,masks}
mkdir -p scripts
mkdir -p docs

# Get the Igris AI installation directory
IGRIS_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"

# Get Igris AI version
IGRIS_VERSION=$(cat "$IGRIS_DIR/version.txt" 2>/dev/null || echo "unknown")

# Copy templates
echo "📄 Copying templates..."
cp "$IGRIS_DIR/ai/briefs/"*-TEMPLATE.md ai/briefs/
cp "$IGRIS_DIR/ai/prompts/"*.md ai/prompts/
cp "$IGRIS_DIR/ai/templates/"*.md ai/templates/

# Copy CLAUDE.md template for regeneration
cp "$IGRIS_DIR/scripts/templates/CLAUDE.md.template" scripts/

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

Use the DOCUMENT command to have IGRIS analyze your project and create these files:

```
DOCUMENT architecture
```

The /document skill will ask questions about your architecture and generate comprehensive documentation.
EOF

# Create Claude Code integration (hooks + CLAUDE.md)
echo "🤖 Setting up Claude Code integration..."
mkdir -p .claude/hooks

# Install native agents (v5.0)
echo "🤖 Installing native agents..."
mkdir -p .claude/agents
if [ -d "$IGRIS_DIR/.claude/agents" ]; then
  cp "$IGRIS_DIR/.claude/agents/"*.md .claude/agents/ 2>/dev/null || true
  cp "$IGRIS_DIR/.claude/agents/manifest.yaml" .claude/agents/ 2>/dev/null || true
fi

# Read persona from SOUL.md (if exists) for CLAUDE.md generation
PERSONA_INJECTION=""
if [ -f "SOUL.md" ]; then
  PERSONA_INJECTION=$(cat "SOUL.md")
elif [ -f "$IGRIS_DIR/SOUL.md" ]; then
  PERSONA_INJECTION=$(cat "$IGRIS_DIR/SOUL.md")
fi

# Create CLAUDE.md with variable substitution
INSTALL_DATE=$(date -u +"%Y-%m-%d")

# First pass: Replace simple variables
sed -e "s/{{IGRIS_VERSION}}/$IGRIS_VERSION/g" \
    -e "s/{{INSTALL_DATE}}/$INSTALL_DATE/g" \
    "$IGRIS_DIR/scripts/templates/CLAUDE.md.template" > CLAUDE.md.tmp

# Second pass: Replace persona injection using perl (handles newlines)
if [ -n "$PERSONA_INJECTION" ]; then
  ESCAPED_INJECTION=$(printf '%s\n' "$PERSONA_INJECTION" | perl -pe 's/([\\\/\$])/\\$1/g')
  perl -i -pe "s/\{\{PERSONA_INJECTION\}\}/$ESCAPED_INJECTION/g" CLAUDE.md.tmp
else
  perl -i -pe 's/\{\{PERSONA_INJECTION\}\}//g' CLAUDE.md.tmp
fi

mv CLAUDE.md.tmp CLAUDE.md

# Copy core scripts
echo "🔧 Installing Igris AI scripts..."
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
  "last_updated": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

# ============================================================
# MCP Server Setup (Optional Enhancement)
# ============================================================
echo ""
echo "🔌 MCP Server Setup (Optional)"
echo "--------------------------------"

MCP_AVAILABLE=false
MCP_CONFIGURED=false

# Check for Node.js
if command -v node &> /dev/null; then
  NODE_VERSION=$(node --version 2>/dev/null | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)

  if [ "$NODE_MAJOR" -ge 20 ]; then
    echo "✅ Node.js $NODE_VERSION detected (required: 20+)"
    MCP_AVAILABLE=true
  else
    echo "⚠️  Node.js $NODE_VERSION detected (required: 20+)"
    echo "   MCP server requires Node.js 20 or higher."
    echo "   Upgrade: https://nodejs.org/"
  fi
else
  echo "⚠️  Node.js not found"
  echo "   MCP server provides enhanced tool integration but is optional."
  echo "   Install: https://nodejs.org/ (version 20+)"
fi

# If Node.js available, offer to build MCP server
if [ "$MCP_AVAILABLE" = true ]; then
  MCP_SERVER_DIR="$IGRIS_DIR/mcp-server"

  if [ -d "$MCP_SERVER_DIR" ]; then
    # Check if running interactively
    if [ -t 0 ]; then
      echo ""
      read -p "Build MCP server for enhanced tool integration? [Y/n]: " BUILD_MCP
      BUILD_MCP=${BUILD_MCP:-Y}
    else
      # Non-interactive mode: skip MCP setup
      echo "   (Non-interactive mode: skipping MCP setup)"
      BUILD_MCP="n"
    fi

    if [[ "$BUILD_MCP" =~ ^[Yy]$ ]]; then
      echo "📦 Building MCP server..."

      # Check if already built
      if [ -f "$MCP_SERVER_DIR/dist/index.js" ]; then
        echo "   MCP server already built."
      else
        # Build MCP server
        cd "$MCP_SERVER_DIR"
        if npm install --silent 2>/dev/null && npm run build --silent 2>/dev/null; then
          echo "   ✅ MCP server built successfully."
        else
          echo "   ⚠️  MCP server build failed. You can build manually later:"
          echo "      cd $MCP_SERVER_DIR && npm install && npm run build"
        fi
        cd "$TARGET_DIR"
      fi

      # Offer to configure Claude Code
      if [ -f "$MCP_SERVER_DIR/dist/index.js" ]; then
        CLAUDE_CONFIG_DIR="$HOME/.claude"
        CLAUDE_CONFIG_FILE="$CLAUDE_CONFIG_DIR/config.json"

        echo ""
        read -p "Configure Claude Code to use MCP server? [Y/n]: " CONFIGURE_MCP
        CONFIGURE_MCP=${CONFIGURE_MCP:-Y}

        if [[ "$CONFIGURE_MCP" =~ ^[Yy]$ ]]; then
          mkdir -p "$CLAUDE_CONFIG_DIR"

          MCP_SERVER_PATH="$MCP_SERVER_DIR/dist/index.js"

          if [ -f "$CLAUDE_CONFIG_FILE" ]; then
            # Config exists - check if igris-ai already configured
            if grep -q '"igris-ai"' "$CLAUDE_CONFIG_FILE" 2>/dev/null; then
              echo "   ✅ Claude Code already configured for Igris MCP."
              MCP_CONFIGURED=true
            else
              # Add to existing config using Python (safe JSON manipulation)
              python3 <<PYEOF
import json
import sys

config_file = "$CLAUDE_CONFIG_FILE"
mcp_path = "$MCP_SERVER_PATH"

try:
    with open(config_file, 'r') as f:
        config = json.load(f)
except:
    config = {}

if 'mcpServers' not in config:
    config['mcpServers'] = {}

config['mcpServers']['igris-ai'] = {
    "command": "node",
    "args": [mcp_path]
}

with open(config_file, 'w') as f:
    json.dump(config, f, indent=2)

print("   ✅ Added igris-ai to Claude Code config.")
PYEOF
              MCP_CONFIGURED=true
            fi
          else
            # Create new config
            cat > "$CLAUDE_CONFIG_FILE" <<MCPEOF
{
  "mcpServers": {
    "igris-ai": {
      "command": "node",
      "args": ["$MCP_SERVER_PATH"]
    }
  }
}
MCPEOF
            echo "   ✅ Created Claude Code config with Igris MCP."
            MCP_CONFIGURED=true
          fi
        fi
      fi
    else
      echo "   Skipping MCP setup. You can set it up later:"
      echo "   cd $MCP_SERVER_DIR && npm install && npm run build"
    fi
  else
    echo "⚠️  MCP server directory not found at $MCP_SERVER_DIR"
  fi
fi

# ============================================================
# Brain health check (if brain exists)
# ============================================================
if [ -d "$HOME/.igris" ]; then
  echo ""
  echo "🩺 Brain health check..."

  if [ -f "$HOME/.igris/memory/knowledge.db" ]; then
    INTEGRITY=$(sqlite3 "$HOME/.igris/memory/knowledge.db" "PRAGMA integrity_check;" 2>/dev/null || echo "failed")
    if [ "$INTEGRITY" = "ok" ]; then
      echo "   ✅ Local brain: knowledge.db OK"
    else
      echo "   ⚠️  Local brain: knowledge.db integrity issue detected"
    fi
  fi

  # Check remote brain if configured
  if [ -f "$HOME/.igris/config.json" ]; then
    BRAIN_REMOTE_URL=$(python3 -c "
import json, sys
try:
    with open(sys.argv[1], 'r') as f:
        config = json.load(f)
    print(config.get('remote_brain', {}).get('url', ''))
except:
    print('')
" "$HOME/.igris/config.json" 2>/dev/null || echo "")

    if [ -n "$BRAIN_REMOTE_URL" ]; then
      HEALTH_URL="${BRAIN_REMOTE_URL%/}/health"
      if command -v curl &> /dev/null; then
        HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 "$HEALTH_URL" 2>/dev/null || echo "000")
        if [ "$HTTP_CODE" = "200" ]; then
          echo "   ✅ Remote brain: healthy (HTTP $HTTP_CODE)"
        else
          echo "   ⚠️  Remote brain: HTTP $HTTP_CODE (may not be running)"
        fi
      fi
    fi
  fi
fi

echo ""
echo "✅ Igris AI v5.0 initialized successfully!"
echo ""
echo "🤖 Claude Code Integration:"
echo "   ✓ Context file created (CLAUDE.md)"
echo "   ✓ 7 native agents installed (.claude/agents/)"
if [ "$MCP_CONFIGURED" = true ]; then
  echo "   ✓ MCP server configured (enhanced tool integration)"
elif [ "$MCP_AVAILABLE" = true ]; then
  echo "   ○ MCP server available but not configured"
else
  echo "   ○ MCP server skipped (Node.js 20+ not found)"
fi
echo "   ✓ True zero-configuration - works immediately!"
echo ""
echo "📚 Getting Started:"
echo ""
echo "1. Launch Claude Code:"
echo "   $ claude"
echo ""
echo "   Igris AI will auto-initialize and show:"
echo "   - System assessment (briefs, blockers, git status)"
echo "   - Intelligent recommendations"
echo "   - Ready for your command!"
echo ""
echo "2. (Optional) Install shell integration:"
echo "   $ ./scripts/install_shell_integration.sh"
echo ""
echo "📚 v5.0 Commands:"
echo ""
echo "   STANDARDIZE    - Generate coding_guidelines.md"
echo "   HUNT <brief>   - Autonomous implementation"
echo "   DIGIVOLVE      - Multi-agent orchestration"
echo "   SCAN           - Show status report"
echo ""
echo "📚 Quick Start:"
echo ""
echo "   'Generate coding guidelines for this project'"
echo "   'What should I work on next?'"
echo "   'Register a bug: [description]'"
echo ""
echo "🔗 Docs: https://github.com/fiftynotai/igris-ai"
echo ""
