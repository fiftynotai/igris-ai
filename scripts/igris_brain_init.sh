#!/bin/bash

# Description: One-time initialization of the centralized ~/.igris/ brain
# Usage: igris_brain_init.sh [--force]
# Dependencies: sqlite3 (with FTS5 support), python3
# Exit codes:
#   0 - Success (brain created or already exists)
#   1 - Error (missing dependency, invalid state)

set -e

echo "🧠 Igris AI - Brain Bootstrap"
echo "========================================"
echo ""

# ============================================================
# Parse flags
# ============================================================
FORCE=false
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

BRAIN_DIR="$HOME/.igris"

# ============================================================
# Check if brain already exists
# ============================================================
if [ -d "$BRAIN_DIR" ] && [ "$FORCE" = false ]; then
  echo "✅ Igris Brain already exists at $BRAIN_DIR"
  echo "   Use --force to reinitialize."
  echo ""
  echo "   To install Igris in a project, run:"
  echo "   ./scripts/igris_install.sh <project-dir>"
  exit 0
fi

if [ -d "$BRAIN_DIR" ] && [ "$FORCE" = true ]; then
  echo "⚠️  Reinitializing brain (--force). Existing data will be preserved where possible."
  echo ""
fi

# ============================================================
# Check dependencies: sqlite3
# ============================================================
echo "🔍 Checking dependencies..."

if ! command -v sqlite3 &> /dev/null; then
  echo "❌ Error: sqlite3 is not installed."
  echo ""
  echo "   Install instructions:"
  echo "   macOS:         brew install sqlite3  (or use system sqlite3)"
  echo "   Ubuntu/Debian: sudo apt install sqlite3"
  echo "   Fedora/RHEL:   sudo dnf install sqlite"
  echo "   Arch Linux:    sudo pacman -S sqlite"
  echo ""
  exit 1
fi

echo "   ✅ sqlite3 found: $(sqlite3 --version | head -1)"

# ============================================================
# Check FTS5 support
# ============================================================
if ! sqlite3 ":memory:" "CREATE VIRTUAL TABLE t USING fts5(x);" 2>/dev/null; then
  echo "❌ Error: Your sqlite3 does not support FTS5."
  echo ""
  echo "   FTS5 is required for full-text search in the knowledge database."
  echo "   On most systems, FTS5 is included by default since 2017."
  echo ""
  echo "   macOS:         brew install sqlite3  (Homebrew version includes FTS5)"
  echo "   Ubuntu/Debian: sudo apt install sqlite3 libsqlite3-dev"
  echo ""
  exit 1
fi

echo "   ✅ FTS5 support confirmed"
echo ""

# ============================================================
# Get Igris AI source directory
# ============================================================
IGRIS_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
IGRIS_VERSION=$(cat "$IGRIS_DIR/version.txt" 2>/dev/null || echo "4.0.0")

echo "📁 Source repo: $IGRIS_DIR"
echo "📌 Version: $IGRIS_VERSION"
echo ""

# ============================================================
# Create directory structure
# ============================================================
echo "📦 Creating brain directory structure..."

mkdir -p "$BRAIN_DIR/core/prompts"
mkdir -p "$BRAIN_DIR/core/agents"
mkdir -p "$BRAIN_DIR/core/skills"
mkdir -p "$BRAIN_DIR/core/rules"
mkdir -p "$BRAIN_DIR/core/templates"
mkdir -p "$BRAIN_DIR/personas"
mkdir -p "$BRAIN_DIR/memory/patterns"
mkdir -p "$BRAIN_DIR/staging"
mkdir -p "$BRAIN_DIR/mcp-server"

echo "   ✅ Directory tree created at $BRAIN_DIR"

# ============================================================
# Copy core files from igris-ai repo
# ============================================================
echo "📄 Copying core files..."

# Prompts
if [ -d "$IGRIS_DIR/ai/prompts" ]; then
  cp "$IGRIS_DIR/ai/prompts/"*.md "$BRAIN_DIR/core/prompts/" 2>/dev/null || true
  echo "   ✅ Prompts copied"
else
  echo "   ⚠️  No prompts directory found"
fi

# Agents
if [ -d "$IGRIS_DIR/.claude/agents" ]; then
  cp "$IGRIS_DIR/.claude/agents/"*.md "$BRAIN_DIR/core/agents/" 2>/dev/null || true
  [ -f "$IGRIS_DIR/.claude/agents/manifest.yaml" ] && cp "$IGRIS_DIR/.claude/agents/manifest.yaml" "$BRAIN_DIR/core/agents/"
  echo "   ✅ Agents copied"
else
  echo "   ⚠️  No agents directory found"
fi

# Skills
if [ -d "$IGRIS_DIR/.claude/skills" ]; then
  cp -r "$IGRIS_DIR/.claude/skills/"* "$BRAIN_DIR/core/skills/" 2>/dev/null || true
  echo "   ✅ Skills copied"
else
  echo "   ⚠️  No skills directory found"
fi

# Rules
if [ -d "$IGRIS_DIR/.claude/rules" ]; then
  cp "$IGRIS_DIR/.claude/rules/"*.md "$BRAIN_DIR/core/rules/" 2>/dev/null || true
  echo "   ✅ Rules copied"
else
  echo "   ⚠️  No rules directory found"
fi

# Templates
if [ -d "$IGRIS_DIR/ai/templates" ]; then
  cp "$IGRIS_DIR/ai/templates/"*.md "$BRAIN_DIR/core/templates/" 2>/dev/null || true
  echo "   ✅ Templates copied"
else
  echo "   ⚠️  No templates directory found"
fi

# ============================================================
# Copy personas
# ============================================================
if [ -d "$IGRIS_DIR/ai/personas" ]; then
  cp -r "$IGRIS_DIR/ai/personas/"* "$BRAIN_DIR/personas/" 2>/dev/null || true
  echo "   ✅ Personas copied"
else
  echo "   ⚠️  No personas directory found"
fi

# ============================================================
# Copy starter patterns
# ============================================================
if [ -d "$IGRIS_DIR/brain-mcp-server/patterns" ]; then
  cp "$IGRIS_DIR/brain-mcp-server/patterns/"*.json "$BRAIN_DIR/memory/patterns/" 2>/dev/null || true
  echo "   ✅ Starter patterns copied"
fi

# ============================================================
# Copy and build Brain MCP server
# ============================================================
echo ""
echo "🔌 Setting up Brain MCP server..."

if [ -d "$IGRIS_DIR/brain-mcp-server" ]; then
  cp -r "$IGRIS_DIR/brain-mcp-server/"* "$BRAIN_DIR/mcp-server/"

  if command -v node &> /dev/null; then
    NODE_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_MAJOR" -ge 20 ]; then
      echo "   📦 Installing dependencies..."
      cd "$BRAIN_DIR/mcp-server"
      npm install --silent 2>/dev/null
      echo "   📦 Building MCP server..."
      npm run build --silent 2>/dev/null
      cd "$IGRIS_DIR"
      echo "   ✅ Brain MCP server built"
    else
      echo "   ⚠️  Node.js $NODE_MAJOR detected (requires 20+). MCP server not built."
    fi
  else
    echo "   ⚠️  Node.js not found. MCP server not built."
    echo "   Install Node.js 20+ and run: cd ~/.igris/mcp-server && npm install && npm run build"
  fi
else
  echo "   ⚠️  brain-mcp-server/ not found in repo"
fi

# ============================================================
# Initialize knowledge.db
# ============================================================
echo ""
echo "🗄️  Initializing knowledge database..."

if [ -f "$BRAIN_DIR/memory/knowledge.db" ] && [ "$FORCE" = false ]; then
  echo "   ✅ knowledge.db already exists (skipping)"
else
  if [ -f "$BRAIN_DIR/memory/knowledge.db" ] && [ "$FORCE" = true ]; then
    echo "   ⚠️  Backing up existing knowledge.db..."
    cp "$BRAIN_DIR/memory/knowledge.db" "$BRAIN_DIR/memory/knowledge.db.backup.$(date -u +"%Y%m%dT%H%M%SZ")"
  fi

  sqlite3 "$BRAIN_DIR/memory/knowledge.db" < "$IGRIS_DIR/scripts/igris_brain_schema.sql"
  echo "   ✅ Schema applied"
fi

# Apply connection-time PRAGMAs (idempotent)
sqlite3 "$BRAIN_DIR/memory/knowledge.db" "PRAGMA journal_mode=WAL;"
sqlite3 "$BRAIN_DIR/memory/knowledge.db" "PRAGMA trusted_schema=ON;"
echo "   ✅ WAL mode enabled (persistent). trusted_schema set (per-connection, must be set on each open)"

# Verify tables
TABLE_COUNT=$(sqlite3 "$BRAIN_DIR/memory/knowledge.db" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")
echo "   ✅ Database ready ($TABLE_COUNT tables)"

# ============================================================
# Generate config.json
# ============================================================
echo ""
echo "⚙️  Generating configuration files..."

INSTALL_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

python3 -c "
import json, sys
config = {
    'version': '4.0.0',
    'installed_at': sys.argv[1],
    'source_repo': sys.argv[2],
    'features': {
        'memory': True,
        'project_registry': True,
        'symlinks': True,
        'mcp_server': True,
        'staging_pipeline': True,
        'analytics': True
    },
    'paths': {
        'brain': '~/.igris',
        'core': '~/.igris/core',
        'memory': '~/.igris/memory',
        'staging': '~/.igris/staging'
    },
    'database': {
        'path': '~/.igris/memory/knowledge.db',
        'wal_mode': True,
        'busy_timeout_ms': 5000
    }
}
with open(sys.argv[3], 'w') as f:
    json.dump(config, f, indent=2)
    f.write('\n')
" "$INSTALL_DATE" "$IGRIS_DIR" "$BRAIN_DIR/config.json"

echo "   ✅ config.json created"

# ============================================================
# Generate user_profile.json
# ============================================================
USER_NAME=""
USER_ADDRESSING=""

# Extract user info from persona.json if available
if [ -f "$IGRIS_DIR/ai/persona.json" ]; then
  if command -v python3 &> /dev/null; then
    USER_NAME=$(python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    print(data.get('user', {}).get('name', ''))
except:
    print('')
" < "$IGRIS_DIR/ai/persona.json" 2>/dev/null || echo "")

    USER_ADDRESSING=$(python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    print(data.get('user', {}).get('default_addressing', data.get('tone', {}).get('addressing_mode', '')))
except:
    print('')
" < "$IGRIS_DIR/ai/persona.json" 2>/dev/null || echo "")
  fi
fi

python3 -c "
import json, sys
profile = {
    'name': sys.argv[1],
    'default_addressing': sys.argv[2],
    'preferences': {
        'default_mask': 'half',
        'default_persona': 'igris',
        'auto_register_projects': True
    },
    'created_at': sys.argv[3]
}
with open(sys.argv[4], 'w') as f:
    json.dump(profile, f, indent=2)
    f.write('\n')
" "$USER_NAME" "$USER_ADDRESSING" "$INSTALL_DATE" "$BRAIN_DIR/user_profile.json"

echo "   ✅ user_profile.json created"

# ============================================================
# Create global ~/.claude/CLAUDE.md
# ============================================================
echo ""
echo "🌐 Setting up global Claude Code integration..."

CLAUDE_DIR="$HOME/.claude"
CLAUDE_MD="$CLAUDE_DIR/CLAUDE.md"

mkdir -p "$CLAUDE_DIR"

if [ -f "$CLAUDE_MD" ] && [ "$FORCE" = false ]; then
  echo "   ⚠️  $CLAUDE_MD already exists — skipping (won't overwrite)"
  echo "   Use --force to regenerate, or edit manually."
else
  # Use template if available, otherwise generate directly
  TEMPLATE_FILE="$IGRIS_DIR/scripts/templates/CLAUDE.global.md.template"
  if [ -f "$TEMPLATE_FILE" ]; then
    sed -e "s|{{IGRIS_VERSION}}|4.0.0|g" \
        -e "s|{{INSTALL_DATE}}|$INSTALL_DATE|g" \
        -e "s|{{SOURCE_REPO}}|$IGRIS_DIR|g" \
        "$TEMPLATE_FILE" > "$CLAUDE_MD"
  else
    cat > "$CLAUDE_MD" << 'CLAUDEEOF'
# Igris AI — Centralized Brain

The Igris AI brain is installed at `~/.igris/`.

## What This Means

- Igris AI agents, rules, and prompts are shared across all projects via symlinks
- Persistent memory stored in `~/.igris/memory/knowledge.db` (SQLite + FTS5)
- Projects using Igris are registered in the brain's project registry

## Quick Commands

Check registered projects:
```
sqlite3 ~/.igris/memory/knowledge.db "SELECT slug, path, status FROM projects;"
```

Check brain health:
```
sqlite3 ~/.igris/memory/knowledge.db "PRAGMA integrity_check; PRAGMA journal_mode;"
```

## Note

This file is auto-generated by `igris_brain_init.sh`.
If you have project-specific CLAUDE.md instructions, they take priority over this global file.
Projects with their own CLAUDE.md will use that instead of this global one.
CLAUDEEOF
  fi
  echo "   ✅ Global CLAUDE.md created at $CLAUDE_MD"
fi

# ============================================================
# Register Brain MCP in ~/.claude.json
# ============================================================
echo ""
echo "🔌 Registering Brain MCP server in Claude Code..."

CLAUDE_CONFIG="$HOME/.claude.json"
MCP_SERVER_PATH="$BRAIN_DIR/mcp-server/dist/index.js"

if [ -f "$MCP_SERVER_PATH" ]; then
  python3 -c "
import json, sys, os

config_file = sys.argv[1]
mcp_path = sys.argv[2]

try:
    with open(config_file, 'r') as f:
        config = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    config = {}

if 'mcpServers' not in config:
    config['mcpServers'] = {}

config['mcpServers']['igris-brain'] = {
    'command': 'node',
    'args': [mcp_path]
}

with open(config_file, 'w') as f:
    json.dump(config, f, indent=2)
    f.write('\n')
" "$CLAUDE_CONFIG" "$MCP_SERVER_PATH"
  echo "   ✅ Brain MCP server registered in $CLAUDE_CONFIG"
else
  echo "   ⚠️  MCP server not built yet — skipping registration"
  echo "   Build manually: cd ~/.igris/mcp-server && npm install && npm run build"
fi

# ============================================================
# Done
# ============================================================
echo ""
echo "========================================"
echo "✅ Igris AI Brain initialized successfully!"
echo "========================================"
echo ""
echo "🧠 Brain location: $BRAIN_DIR"
echo "🗄️  Database: $BRAIN_DIR/memory/knowledge.db"
echo "⚙️  Config: $BRAIN_DIR/config.json"
echo "👤 Profile: $BRAIN_DIR/user_profile.json"
echo "🌐 Global CLAUDE.md: $HOME/.claude/CLAUDE.md"
echo ""
echo "📚 Next Steps:"
echo ""
echo "1. Install Igris in a project (symlink mode):"
echo "   ./scripts/igris_install.sh /path/to/your/project"
echo ""
echo "2. Or install in the current directory:"
echo "   ./scripts/igris_install.sh ."
echo ""
echo "3. Verify brain health:"
echo "   sqlite3 ~/.igris/memory/knowledge.db \"PRAGMA integrity_check;\""
echo ""
echo "🔗 Docs: https://github.com/fiftynotai/igris-ai"
echo ""
