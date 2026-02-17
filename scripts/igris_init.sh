#!/bin/bash

# Igris AI Initialization Script
# Initializes Igris AI in a target project

set -euo pipefail

# v4.0 Brain Check — suggest igris_install.sh if brain exists
if [ -d "$HOME/.igris" ]; then
  echo ""
  echo "💡 Igris Brain detected at ~/.igris/"
  echo "   Consider using the new symlink installer instead:"
  echo "   ./scripts/igris_install.sh ${1:-.}"
  echo ""
  echo "   Benefits: shared core files, persistent memory, instant updates"
  echo "   The v3.4 copy-based install will continue to work."
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
  echo "Continuing with v3.4 copy-based install..."
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
mkdir -p ai/{briefs,prompts,templates,session/archive,context,plugins}
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

# Copy CLAUDE.md template for persona regeneration
cp "$IGRIS_DIR/scripts/templates/CLAUDE.md.template" scripts/

# Copy persona.json.default
cp "$IGRIS_DIR/ai/persona.json.default" ai/

# Copy bundled Igris persona
if [ -d "$IGRIS_DIR/ai/personas/igris" ]; then
  mkdir -p ai/personas
  cp -r "$IGRIS_DIR/ai/personas/igris" ai/personas/

  # Create active persona.json with Igris half mask as default
  cat > ai/persona.json <<'EOF'
{
  "persona": "igris",
  "mask": "half",
  "installed_at": null,
  "version": "1.0.0",
  "branding": {
    "title": "Igris",
    "intro": "Welcome to the sanctum of code",
    "tagline": "Where shadows enforce architecture"
  },
  "user": {
    "name": ""
  },
  "tone": {
    "level": "Shadow Knight",
    "description": "Dramatic Persona - Complete immersion",
    "addressing_mode": "Monarch"
  },
  "features": {
    "commands": true,
    "banner": true,
    "shadow_commands": true
  }
}
EOF
fi

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

# Install native subagents (v3.2)
echo "🤖 Installing native subagents..."
mkdir -p .claude/agents
if [ -d "$IGRIS_DIR/.claude/agents" ]; then
  cp "$IGRIS_DIR/.claude/agents/"*.md .claude/agents/ 2>/dev/null || true
  cp "$IGRIS_DIR/.claude/agents/manifest.yaml" .claude/agents/ 2>/dev/null || true
fi

# Resolve persona hook (if plugin provides one)
PERSONA_INJECTION=""

# Check if bundled persona is active
if [ -f "ai/persona.json" ]; then
  PERSONA_NAME=$(python3 -c "import json, sys; data=json.load(open('ai/persona.json')); print(data.get('persona', 'none'))" 2>/dev/null || echo "none")
  PERSONA_MASK=$(python3 -c "import json, sys; data=json.load(open('ai/persona.json')); print(data.get('mask', 'none'))" 2>/dev/null || echo "none")

  if [ "$PERSONA_NAME" != "none" ] && [ "$PERSONA_MASK" != "none" ]; then
    PERSONA_MASK_FILE="ai/personas/$PERSONA_NAME/masks/${PERSONA_MASK}.md"
    if [ -f "$PERSONA_MASK_FILE" ]; then
      PERSONA_INJECTION=$(cat "$PERSONA_MASK_FILE")
    fi
  fi
fi

# Plugin hooks override bundled persona (if both exist)
if [ -f "ai/plugins/installed.json" ]; then
  if command -v jq &> /dev/null; then
    PERSONA_HOOK=$(jq -r '.plugins[] | select(.hooks.persona_injection) | .hooks.persona_injection' ai/plugins/installed.json 2>/dev/null || echo "")
    if [ -n "$PERSONA_HOOK" ] && [ -f "$PERSONA_HOOK" ]; then
      PERSONA_INJECTION=$(cat "$PERSONA_HOOK")
    fi
  else
    echo "⚠️  Note: jq not found - plugin hooks will not be processed"
    echo "   Install for full plugin support:"
    echo "   macOS: brew install jq"
    echo "   Ubuntu/Debian: sudo apt install jq"
    echo ""
  fi
fi

# Create CLAUDE.md with variable substitution
# Use a two-step process to handle multi-line PERSONA_INJECTION
INSTALL_DATE=$(date -u +"%Y-%m-%d")

# Set INSTALLED_PERSONA display text
if [ "$PERSONA_NAME" != "none" ] && [ -n "$PERSONA_NAME" ]; then
  INSTALLED_PERSONA="**Installed Persona:** $PERSONA_NAME"
else
  INSTALLED_PERSONA=""
fi

# Determine hook status
HOOK_STATUS="No enhancement hooks installed"
INSTALLED_ENHANCEMENT_PLUGINS="None"

if [ -f "ai/plugins/installed.json" ]; then
  # Count plugins with hooks
  if command -v jq &> /dev/null; then
    PLUGIN_COUNT=$(jq '.plugins | length' ai/plugins/installed.json 2>/dev/null || echo "0")
    if [ "$PLUGIN_COUNT" -gt 0 ]; then
      HOOK_STATUS="$PLUGIN_COUNT plugin(s) with enhancement hooks installed"
      INSTALLED_ENHANCEMENT_PLUGINS=$(jq -r '.plugins[].name' ai/plugins/installed.json 2>/dev/null | paste -sd ", " -)
    fi
  else
    # Python fallback
    PLUGIN_COUNT=$(python3 <<EOF 2>/dev/null
import json
try:
    with open('ai/plugins/installed.json', 'r') as f:
        data = json.load(f)
    print(len(data.get('plugins', [])))
except:
    print('0')
EOF
)
    if [ "$PLUGIN_COUNT" != "0" ] && [ -n "$PLUGIN_COUNT" ]; then
      HOOK_STATUS="$PLUGIN_COUNT plugin(s) with enhancement hooks installed"
      INSTALLED_ENHANCEMENT_PLUGINS=$(python3 <<EOF 2>/dev/null
import json
try:
    with open('ai/plugins/installed.json', 'r') as f:
        data = json.load(f)
    names = [p.get('name', 'unknown') for p in data.get('plugins', [])]
    print(', '.join(names))
except:
    pass
EOF
)
    fi
  fi
fi

# First pass: Replace simple variables
sed -e "s/{{IGRIS_VERSION}}/$IGRIS_VERSION/g" \
    -e "s/{{INSTALL_DATE}}/$INSTALL_DATE/g" \
    -e "s/{{HOOK_STATUS}}/$HOOK_STATUS/g" \
    -e "s/{{INSTALLED_ENHANCEMENT_PLUGINS}}/$INSTALLED_ENHANCEMENT_PLUGINS/g" \
    -e "s/{{INSTALLED_PERSONA}}/$INSTALLED_PERSONA/g" \
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

# Copy persona management scripts (if they exist)
if [ -f "$IGRIS_DIR/scripts/persona_install.sh" ]; then
  cp "$IGRIS_DIR/scripts/persona_install.sh" scripts/
fi
if [ -f "$IGRIS_DIR/scripts/persona_mask.sh" ]; then
  cp "$IGRIS_DIR/scripts/persona_mask.sh" scripts/
fi
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

# ============================================================
# MCP Server Setup (Optional Enhancement)
# ============================================================
echo ""
echo "🔌 MCP Server Setup (Optional)"
echo "--------------------------------"

MCP_AVAILABLE=false
MCP_CONFIGURED=false
PERSONA_NAME="${PERSONA_NAME:-none}"

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
echo "✅ Igris AI v3.3 initialized successfully!"
echo ""
echo "🤖 Claude Code Integration:"
echo "   ✓ Startup hook enabled (.claude/hooks/startup.sh)"
echo "   ✓ Context file created (CLAUDE.md)"
echo "   ✓ 18 native subagents installed (.claude/agents/)"
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
echo "📚 v3.3 Commands:"
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
