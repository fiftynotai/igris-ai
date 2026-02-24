#!/bin/bash

# Description: One-time initialization of the centralized ~/.igris/ brain
# Usage: igris_brain_init.sh [--force] [--local] [--remote URL KEY] [--dual URL KEY] [--add-remote URL KEY]
# Dependencies: sqlite3 (with FTS5 support), python3
# Exit codes:
#   0 - Success (brain created or already exists)
#   1 - Error (missing dependency, invalid state)

set -euo pipefail

echo "🧠 Igris AI - Brain Bootstrap"
echo "========================================"
echo ""

# ============================================================
# Parse flags
# ============================================================
FORCE=false
BRAIN_MODE=""
REMOTE_URL=""
REMOTE_KEY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --force)
      FORCE=true
      shift
      ;;
    --local)
      BRAIN_MODE="local"
      shift
      ;;
    --remote)
      BRAIN_MODE="remote"
      if [ -z "${2:-}" ] || [ -z "${3:-}" ]; then
        echo "❌ Error: --remote requires URL and API_KEY arguments"
        echo "   Usage: $0 --remote <URL> <API_KEY>"
        exit 1
      fi
      REMOTE_URL="$2"
      REMOTE_KEY="$3"
      shift 3
      ;;
    --dual)
      BRAIN_MODE="dual"
      if [ -z "${2:-}" ] || [ -z "${3:-}" ]; then
        echo "❌ Error: --dual requires URL and API_KEY arguments"
        echo "   Usage: $0 --dual <URL> <API_KEY>"
        exit 1
      fi
      REMOTE_URL="$2"
      REMOTE_KEY="$3"
      shift 3
      ;;
    --add-remote)
      BRAIN_MODE="add-remote"
      if [ -z "${2:-}" ] || [ -z "${3:-}" ]; then
        echo "❌ Error: --add-remote requires URL and API_KEY arguments"
        echo "   Usage: $0 --add-remote <URL> <API_KEY>"
        exit 1
      fi
      REMOTE_URL="$2"
      REMOTE_KEY="$3"
      shift 3
      ;;
    *)
      echo "❌ Unknown argument: $1"
      echo ""
      echo "Usage: $0 [--force] [--local] [--remote URL KEY] [--dual URL KEY] [--add-remote URL KEY]"
      echo ""
      echo "Brain modes:"
      echo "  --local                Local stdio only (default, current behavior)"
      echo "  --remote URL KEY       Remote HTTP only"
      echo "  --dual URL KEY         Both local and remote"
      echo "  --add-remote URL KEY   Add remote to existing local brain"
      echo ""
      echo "Options:"
      echo "  --force                Reinitialize even if brain exists"
      exit 1
      ;;
  esac
done

BRAIN_DIR="$HOME/.igris"

# ============================================================
# Global symlink creation function
# ============================================================
# Creates symlinks from ~/.igris/core/{agents,skills,rules} -> ~/.claude/{agents,skills,rules}
# This replaces per-project symlinks with Claude Code's native global directories.
# Safe: never clobbers existing real directories or symlinks pointing elsewhere.
create_global_symlinks() {
  local claude_dir="$HOME/.claude"
  local brain_core="$BRAIN_DIR/core"
  local created=0
  local skipped=0
  local warned=0

  mkdir -p "$claude_dir"

  for symlink_type in agents skills rules; do
    local target="$brain_core/$symlink_type"
    local link="$claude_dir/$symlink_type"

    # Source must exist in brain core
    if [ ! -d "$target" ]; then
      echo "   ⚠️  $symlink_type: brain core directory not found at $target"
      warned=$((warned + 1))
      continue
    fi

    if [ -L "$link" ]; then
      # It's a symlink — check where it points
      local current_target
      current_target=$(readlink "$link")
      if [ "$current_target" = "$target" ]; then
        echo "   ✅ $symlink_type: already symlinked correctly"
        skipped=$((skipped + 1))
        continue
      else
        echo "   ⚠️  $symlink_type: symlink exists but points to '$current_target' (expected '$target') — skipping"
        warned=$((warned + 1))
        continue
      fi
    elif [ -d "$link" ]; then
      # It's a real directory with content — don't clobber
      echo "   ⚠️  $symlink_type: real directory exists at $link — skipping (won't clobber user content)"
      warned=$((warned + 1))
      continue
    elif [ -e "$link" ]; then
      # Some other file type — skip
      echo "   ⚠️  $symlink_type: unexpected file at $link — skipping"
      warned=$((warned + 1))
      continue
    fi

    # Doesn't exist — create symlink
    ln -s "$target" "$link"
    echo "   ✅ $symlink_type: symlinked $link -> $target"
    created=$((created + 1))
  done

  echo ""
  echo "   Global symlinks: $created created, $skipped already correct, $warned warnings"
}

# ============================================================
# Input validation helpers
# ============================================================
validate_url() {
  local url="$1"
  local label="${2:-URL}"

  # Must start with http:// or https://
  if [[ ! "$url" =~ ^https?:// ]]; then
    echo "❌ Error: $label must start with http:// or https://"
    echo "   Got: $url"
    exit 1
  fi

  # No spaces allowed
  if [[ "$url" =~ [[:space:]] ]]; then
    echo "❌ Error: $label must not contain spaces"
    echo "   Got: $url"
    exit 1
  fi

  # Extract port if present and validate range
  local port_match
  port_match=$(echo "$url" | sed -n 's|.*://[^:/]*:\([0-9]*\).*|\1|p')
  if [ -n "$port_match" ]; then
    if [ "$port_match" -lt 1 ] || [ "$port_match" -gt 65535 ] 2>/dev/null; then
      echo "❌ Error: $label port must be between 1 and 65535"
      echo "   Got port: $port_match"
      exit 1
    fi
  fi
}

validate_ssh_host() {
  local host="$1"

  # No spaces allowed
  if [[ "$host" =~ [[:space:]] ]]; then
    echo "❌ Error: SSH host must not contain spaces"
    echo "   Got: $host"
    exit 1
  fi

  # Only allow valid hostname characters (letters, digits, dots, hyphens, colons for IPv6)
  if [[ ! "$host" =~ ^[a-zA-Z0-9._:-]+$ ]]; then
    echo "❌ Error: SSH host contains invalid characters"
    echo "   Got: $host"
    echo "   Allowed: letters, digits, dots, hyphens, colons, underscores"
    exit 1
  fi
}

# Validate remote URL if provided
if [ -n "${REMOTE_URL:-}" ]; then
  validate_url "$REMOTE_URL" "Remote brain URL"
fi

# ============================================================
# Handle --add-remote (operates on existing brain, skips init)
# ============================================================
if [ "$BRAIN_MODE" = "add-remote" ]; then
  if [ ! -d "$BRAIN_DIR" ]; then
    echo "❌ Error: No brain found at $BRAIN_DIR"
    echo "   Run $0 first to create the brain, then use --add-remote."
    exit 1
  fi

  echo "🔌 Adding remote brain to existing local configuration..."
  echo ""

  # Update config.json with remote_brain block
  python3 -c "
import json, sys

config_file = sys.argv[1]
remote_url = sys.argv[2]
remote_key = sys.argv[3]

with open(config_file, 'r') as f:
    config = json.load(f)

config['remote_brain'] = {
    'url': remote_url,
    'api_key': remote_key
}

with open(config_file, 'w') as f:
    json.dump(config, f, indent=2)
    f.write('\n')
" "$BRAIN_DIR/config.json" "$REMOTE_URL" "$REMOTE_KEY"
  echo "   ✅ remote_brain added to config.json"

  # Register remote MCP in ~/.claude.json
  CLAUDE_CONFIG="$HOME/.claude.json"
  python3 -c "
import json, sys

config_file = sys.argv[1]
remote_url = sys.argv[2]
remote_key = sys.argv[3]

try:
    with open(config_file, 'r') as f:
        config = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    config = {}

if 'mcpServers' not in config:
    config['mcpServers'] = {}

config['mcpServers']['igris-brain-remote'] = {
    'type': 'http',
    'url': remote_url.rstrip('/') + '/mcp',
    'headers': {
        'Authorization': 'Bearer ' + remote_key
    }
}

with open(config_file, 'w') as f:
    json.dump(config, f, indent=2)
    f.write('\n')
" "$CLAUDE_CONFIG" "$REMOTE_URL" "$REMOTE_KEY"
  echo "   ✅ igris-brain-remote registered in $CLAUDE_CONFIG"

  # Health check remote
  echo ""
  echo "🩺 Verifying remote brain connectivity..."
  HEALTH_URL="${REMOTE_URL%/}/health"
  if command -v curl &> /dev/null; then
    HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 "$HEALTH_URL" 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
      echo "   ✅ Remote brain is healthy (HTTP $HTTP_CODE)"
    else
      echo "   ⚠️  Remote brain health check returned HTTP $HTTP_CODE"
      echo "   URL: $HEALTH_URL"
      echo "   The remote MCP entry has been registered but the server may not be running."
    fi
  else
    echo "   ⚠️  curl not found — skipping remote health check"
  fi

  echo ""
  echo "✅ Remote brain added successfully!"
  echo "   Mode: dual (local + remote)"
  echo "   Both igris-brain (local) and igris-brain-remote (HTTP) are now registered."
  exit 0
fi

# ============================================================
# Interactive mode prompt (when no brain mode flag specified)
# ============================================================
if [ -z "$BRAIN_MODE" ]; then
  if [ -t 0 ]; then
    echo "🧠 Brain Mode Selection"
    echo ""
    echo "  1) local   — Local stdio only (default, recommended for single machine)"
    echo "  2) remote  — Remote HTTP only (VPS brain, no local DB)"
    echo "  3) dual    — Both local and remote (full redundancy)"
    echo ""
    read -rp "Select brain mode [1/2/3] (default: 1): " MODE_CHOICE
    MODE_CHOICE=${MODE_CHOICE:-1}

    case "$MODE_CHOICE" in
      1|local)
        BRAIN_MODE="local"
        ;;
      2|remote)
        BRAIN_MODE="remote"
        # Check env vars first, fall back to interactive prompts
        REMOTE_URL="${IGRIS_REMOTE_BRAIN_URL:-}"
        REMOTE_KEY="${IGRIS_BRAIN_API_KEY:-}"
        if [ -z "$REMOTE_URL" ]; then
          read -rp "Remote brain URL (e.g., http://your-vps:3001): " REMOTE_URL
        fi
        if [ -z "$REMOTE_KEY" ]; then
          read -rsp "API key: " REMOTE_KEY
          echo ""
        fi
        if [ -z "$REMOTE_URL" ] || [ -z "$REMOTE_KEY" ]; then
          echo "❌ Error: URL and API key are required for remote mode"
          echo "   Set IGRIS_REMOTE_BRAIN_URL and IGRIS_BRAIN_API_KEY env vars, or provide interactively."
          exit 1
        fi
        validate_url "$REMOTE_URL" "Remote brain URL"
        ;;
      3|dual)
        BRAIN_MODE="dual"
        # Check env vars first, fall back to interactive prompts
        REMOTE_URL="${IGRIS_REMOTE_BRAIN_URL:-}"
        REMOTE_KEY="${IGRIS_BRAIN_API_KEY:-}"
        if [ -z "$REMOTE_URL" ]; then
          read -rp "Remote brain URL (e.g., http://your-vps:3001): " REMOTE_URL
        fi
        if [ -z "$REMOTE_KEY" ]; then
          read -rsp "API key: " REMOTE_KEY
          echo ""
        fi
        if [ -z "$REMOTE_URL" ] || [ -z "$REMOTE_KEY" ]; then
          echo "❌ Error: URL and API key are required for dual mode"
          echo "   Set IGRIS_REMOTE_BRAIN_URL and IGRIS_BRAIN_API_KEY env vars, or provide interactively."
          exit 1
        fi
        validate_url "$REMOTE_URL" "Remote brain URL"
        ;;
      *)
        echo "❌ Invalid selection. Using default: local"
        BRAIN_MODE="local"
        ;;
    esac
    echo ""
  else
    # Non-interactive: check env vars to determine mode
    if [ -n "${IGRIS_REMOTE_BRAIN_URL:-}" ] && [ -n "${IGRIS_BRAIN_API_KEY:-}" ]; then
      BRAIN_MODE="dual"
      REMOTE_URL="${IGRIS_REMOTE_BRAIN_URL}"
      REMOTE_KEY="${IGRIS_BRAIN_API_KEY}"
      validate_url "$REMOTE_URL" "Remote brain URL"
    else
      BRAIN_MODE="local"
    fi
  fi
fi

echo "📡 Brain mode: $BRAIN_MODE"
echo ""

# ============================================================
# Check if brain already exists
# ============================================================
if [ -d "$BRAIN_DIR" ] && [ "$FORCE" = false ]; then
  # Even without --force, create global symlinks if missing
  CLAUDE_DIR="$HOME/.claude"
  MISSING_GLOBAL_SYMLINKS=false
  for symlink_type in agents skills rules; do
    if [ ! -e "$CLAUDE_DIR/$symlink_type" ]; then
      MISSING_GLOBAL_SYMLINKS=true
      break
    fi
  done

  if [ "$MISSING_GLOBAL_SYMLINKS" = true ]; then
    echo "🧠 Brain exists at $BRAIN_DIR — creating missing global symlinks..."
    echo ""
    create_global_symlinks
    echo ""
    echo "✅ Global symlinks created. Brain is up to date."
  else
    echo "✅ Igris Brain already exists at $BRAIN_DIR"
    echo "   Use --force to reinitialize."
  fi
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
# Copy masks (v4.0 — replaces personas)
# ============================================================
if [ -d "$IGRIS_DIR/ai/masks" ]; then
  mkdir -p "$BRAIN_DIR/masks"
  cp "$IGRIS_DIR/ai/masks/"*.md "$BRAIN_DIR/masks/" 2>/dev/null || true
  echo "   ✅ Masks copied"
else
  echo "   ⚠️  No masks directory found"
fi

# Copy SOUL.md if it exists
if [ -f "$IGRIS_DIR/SOUL.md" ]; then
  cp "$IGRIS_DIR/SOUL.md" "$BRAIN_DIR/core/" 2>/dev/null || true
  echo "   ✅ SOUL.md copied"
fi

# ============================================================
# Copy starter patterns
# ============================================================
if [ -d "$IGRIS_DIR/brain-mcp-server/patterns" ]; then
  cp "$IGRIS_DIR/brain-mcp-server/patterns/"*.json "$BRAIN_DIR/memory/patterns/" 2>/dev/null || true
  echo "   ✅ Starter patterns copied"
fi

# ============================================================
# Copy and build Brain MCP server (only for local/dual modes)
# ============================================================
if [ "$BRAIN_MODE" = "local" ] || [ "$BRAIN_MODE" = "dual" ]; then
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
fi

# ============================================================
# Initialize knowledge.db (only for local/dual modes)
# ============================================================
if [ "$BRAIN_MODE" = "local" ] || [ "$BRAIN_MODE" = "dual" ]; then
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
fi

# ============================================================
# Generate config.json
# ============================================================
echo ""
echo "⚙️  Generating configuration files..."

INSTALL_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

python3 -c "
import json, sys

brain_mode = sys.argv[4]
remote_url = sys.argv[5] if len(sys.argv) > 5 else ''
remote_key = sys.argv[6] if len(sys.argv) > 6 else ''

config = {
    'version': '4.0.0',
    'installed_at': sys.argv[1],
    'source_repo': sys.argv[2],
    'features': {
        'memory': brain_mode in ('local', 'dual'),
        'project_registry': True,
        'symlinks': True,
        'mcp_server': True,
        'staging_pipeline': brain_mode in ('local', 'dual'),
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

if brain_mode in ('remote', 'dual') and remote_url and remote_key:
    config['remote_brain'] = {
        'url': remote_url,
        'api_key': remote_key
    }

with open(sys.argv[3], 'w') as f:
    json.dump(config, f, indent=2)
    f.write('\n')
" "$INSTALL_DATE" "$IGRIS_DIR" "$BRAIN_DIR/config.json" "$BRAIN_MODE" "$REMOTE_URL" "$REMOTE_KEY"

echo "   ✅ config.json created"

# ============================================================
# Generate user_profile.json
# ============================================================
USER_NAME=""
USER_ADDRESSING=""

# Extract user info from USER.md if available (v4.0)
if [ -f "$HOME/.igris/USER.md" ]; then
  if command -v python3 &> /dev/null; then
    USER_NAME=$(python3 -c "
import re, sys
try:
    with open(sys.argv[1], 'r') as f:
        content = f.read()
    match = re.search(r'\*\*Name:\*\*\s*(.+)', content)
    print(match.group(1).strip() if match else '')
except:
    print('')
" "$HOME/.igris/USER.md" 2>/dev/null || echo "")

    USER_ADDRESSING=$(python3 -c "
import re, sys
try:
    with open(sys.argv[1], 'r') as f:
        content = f.read()
    match = re.search(r'\*\*Default Addressing:\*\*\s*(.+)', content)
    print(match.group(1).strip() if match else '')
except:
    print('')
" "$HOME/.igris/USER.md" 2>/dev/null || echo "")
  fi
elif [ -f "$IGRIS_DIR/SOUL.md" ]; then
  # Fallback: try SOUL.md for defaults
  USER_ADDRESSING="Partner"
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

- Igris AI agents, rules, and skills are shared across all projects via global directories (~/.claude/)
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
# Create global symlinks: ~/.igris/core/ -> ~/.claude/
# ============================================================
echo ""
echo "🔗 Setting up global agent/skill/rule symlinks..."

create_global_symlinks

# ============================================================
# Register Brain MCP in ~/.claude.json
# ============================================================
echo ""
echo "🔌 Registering Brain MCP server in Claude Code..."

CLAUDE_CONFIG="$HOME/.claude.json"
MCP_SERVER_PATH="$BRAIN_DIR/mcp-server/dist/index.js"

python3 -c "
import json, sys

config_file = sys.argv[1]
mcp_path = sys.argv[2]
brain_mode = sys.argv[3]
remote_url = sys.argv[4] if len(sys.argv) > 4 else ''
remote_key = sys.argv[5] if len(sys.argv) > 5 else ''

try:
    with open(config_file, 'r') as f:
        config = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    config = {}

if 'mcpServers' not in config:
    config['mcpServers'] = {}

import os

# Register local MCP (stdio) for local and dual modes
if brain_mode in ('local', 'dual') and os.path.exists(mcp_path):
    config['mcpServers']['igris-brain'] = {
        'command': 'node',
        'args': [mcp_path]
    }

# Register remote MCP (HTTP) for remote and dual modes
if brain_mode in ('remote', 'dual') and remote_url and remote_key:
    mcp_url = remote_url.rstrip('/') + '/mcp'
    if brain_mode == 'remote':
        # Remote-only: use the primary igris-brain name
        config['mcpServers']['igris-brain'] = {
            'type': 'http',
            'url': mcp_url,
            'headers': {
                'Authorization': 'Bearer ' + remote_key
            }
        }
    else:
        # Dual mode: use separate name for remote
        config['mcpServers']['igris-brain-remote'] = {
            'type': 'http',
            'url': mcp_url,
            'headers': {
                'Authorization': 'Bearer ' + remote_key
            }
        }

with open(config_file, 'w') as f:
    json.dump(config, f, indent=2)
    f.write('\n')
" "$CLAUDE_CONFIG" "$MCP_SERVER_PATH" "$BRAIN_MODE" "$REMOTE_URL" "$REMOTE_KEY"

if [ "$BRAIN_MODE" = "local" ]; then
  if [ -f "$MCP_SERVER_PATH" ]; then
    echo "   ✅ igris-brain (local stdio) registered in $CLAUDE_CONFIG"
  else
    echo "   ⚠️  MCP server not built yet — skipping local registration"
    echo "   Build manually: cd ~/.igris/mcp-server && npm install && npm run build"
  fi
elif [ "$BRAIN_MODE" = "remote" ]; then
  echo "   ✅ igris-brain (remote HTTP) registered in $CLAUDE_CONFIG"
elif [ "$BRAIN_MODE" = "dual" ]; then
  if [ -f "$MCP_SERVER_PATH" ]; then
    echo "   ✅ igris-brain (local stdio) registered in $CLAUDE_CONFIG"
  else
    echo "   ⚠️  MCP server not built — local registration skipped"
  fi
  echo "   ✅ igris-brain-remote (remote HTTP) registered in $CLAUDE_CONFIG"
fi

# ============================================================
# Health checks
# ============================================================
echo ""
echo "🩺 Running health checks..."

# Local health check
if [ "$BRAIN_MODE" = "local" ] || [ "$BRAIN_MODE" = "dual" ]; then
  if [ -f "$BRAIN_DIR/memory/knowledge.db" ]; then
    INTEGRITY=$(sqlite3 "$BRAIN_DIR/memory/knowledge.db" "PRAGMA integrity_check;" 2>/dev/null || echo "failed")
    if [ "$INTEGRITY" = "ok" ]; then
      echo "   ✅ Local brain: knowledge.db integrity check passed"
    else
      echo "   ❌ Local brain: knowledge.db integrity check FAILED"
      : # health check failed
    fi
  else
    echo "   ❌ Local brain: knowledge.db not found"
  fi
fi

# Remote health check
if [ "$BRAIN_MODE" = "remote" ] || [ "$BRAIN_MODE" = "dual" ]; then
  HEALTH_URL="${REMOTE_URL%/}/health"
  if command -v curl &> /dev/null; then
    HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 "$HEALTH_URL" 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
      echo "   ✅ Remote brain: healthy (HTTP $HTTP_CODE)"
    else
      echo "   ⚠️  Remote brain: health check returned HTTP $HTTP_CODE"
      echo "      URL: $HEALTH_URL"
      echo "      The remote MCP entry has been registered but the server may not be running."
    fi
  else
    echo "   ⚠️  curl not found — skipping remote health check"
  fi
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
echo "📡 Brain mode: $BRAIN_MODE"

if [ "$BRAIN_MODE" = "local" ] || [ "$BRAIN_MODE" = "dual" ]; then
  echo "🗄️  Database: $BRAIN_DIR/memory/knowledge.db"
fi

echo "⚙️  Config: $BRAIN_DIR/config.json"
echo "👤 Profile: $BRAIN_DIR/user_profile.json"
echo "🌐 Global CLAUDE.md: $HOME/.claude/CLAUDE.md"
echo "🔗 Global symlinks: ~/.claude/{agents,skills,rules} -> ~/.igris/core/"

if [ "$BRAIN_MODE" = "dual" ]; then
  echo ""
  echo "🔗 MCP Servers registered:"
  echo "   igris-brain         → local stdio ($MCP_SERVER_PATH)"
  echo "   igris-brain-remote  → remote HTTP ($REMOTE_URL)"
fi

echo ""
echo "📚 Next Steps:"
echo ""
echo "1. Install Igris in a project (global mode):"
echo "   ./scripts/igris_install.sh /path/to/your/project"
echo ""
echo "2. Or install in the current directory:"
echo "   ./scripts/igris_install.sh ."
echo ""

if [ "$BRAIN_MODE" = "local" ] || [ "$BRAIN_MODE" = "dual" ]; then
  echo "3. Verify brain health:"
  echo "   sqlite3 ~/.igris/memory/knowledge.db \"PRAGMA integrity_check;\""
  echo ""
fi

if [ "$BRAIN_MODE" = "dual" ]; then
  echo "4. Switch brain modes:"
  echo "   ./scripts/igris_brain_switch.sh status  — Show current mode"
  echo "   ./scripts/igris_brain_switch.sh local   — Local only"
  echo "   ./scripts/igris_brain_switch.sh remote  — Remote only"
  echo "   ./scripts/igris_brain_switch.sh dual    — Both active"
  echo ""
fi

echo "🔗 Docs: https://github.com/fiftynotai/igris-ai"
echo ""
