#!/bin/bash

# Description: Switch brain mode between local, remote, and dual in ~/.claude.json
# Usage: igris_brain_switch.sh [status|local|remote|dual]
# Dependencies: python3
# Exit codes:
#   0 - Success
#   1 - Error (missing config, invalid mode)

set -euo pipefail

BRAIN_DIR="$HOME/.igris"
CLAUDE_CONFIG="$HOME/.claude.json"
CONFIG_FILE="$BRAIN_DIR/config.json"

# ============================================================
# Validate environment
# ============================================================
if [ ! -d "$BRAIN_DIR" ]; then
  echo "❌ Error: Igris Brain not found at $BRAIN_DIR"
  echo "   Run \"igris init\" first."
  exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
  echo "❌ Error: Brain config not found at $CONFIG_FILE"
  exit 1
fi

if [ ! -f "$CLAUDE_CONFIG" ]; then
  echo "❌ Error: Claude config not found at $CLAUDE_CONFIG"
  exit 1
fi

# ============================================================
# Parse command
# ============================================================
COMMAND="${1:-status}"

case "$COMMAND" in
  status|local|remote|dual)
    ;;
  -h|--help)
    echo "🧠 Igris AI - Brain Mode Switcher"
    echo ""
    echo "Usage: $0 [status|local|remote|dual]"
    echo ""
    echo "Commands:"
    echo "  status   Show current brain mode (default)"
    echo "  local    Disable remote MCP, keep local only"
    echo "  remote   Disable local MCP, keep remote only"
    echo "  dual     Enable both local and remote MCP"
    echo ""
    exit 0
    ;;
  *)
    echo "❌ Unknown command: $COMMAND"
    echo "   Usage: $0 [status|local|remote|dual]"
    exit 1
    ;;
esac

# ============================================================
# Detect current configuration
# ============================================================
detect_current_mode() {
  python3 -c "
import json, sys

claude_file = sys.argv[1]
config_file = sys.argv[2]

try:
    with open(claude_file, 'r') as f:
        claude = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    claude = {}

try:
    with open(config_file, 'r') as f:
        config = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    config = {}

servers = claude.get('mcpServers', {})
has_local = 'igris-brain' in servers and servers['igris-brain'].get('command') == 'node'
has_remote_named = 'igris-brain-remote' in servers
has_remote_as_primary = 'igris-brain' in servers and servers['igris-brain'].get('type') in ('http', 'streamable-http')
has_remote_config = 'remote_brain' in config

has_remote = has_remote_named or has_remote_as_primary

if has_local and has_remote:
    mode = 'dual'
elif has_local:
    mode = 'local'
elif has_remote:
    mode = 'remote'
else:
    mode = 'none'

# Output structured info
print(f'MODE={mode}')
print(f'HAS_LOCAL={\"true\" if has_local else \"false\"}')
print(f'HAS_REMOTE={\"true\" if has_remote else \"false\"}')
print(f'HAS_REMOTE_CONFIG={\"true\" if has_remote_config else \"false\"}')

if has_remote_config:
    rb = config['remote_brain']
    print(f'REMOTE_URL={rb.get(\"url\", \"\")}')
    # Never print the actual API key
    key = rb.get('api_key', '')
    if key:
        masked = key[:4] + '...' + key[-4:] if len(key) > 8 else '****'
        print(f'REMOTE_KEY_MASKED={masked}')
    else:
        print('REMOTE_KEY_MASKED=')
" "$CLAUDE_CONFIG" "$CONFIG_FILE"
}

# Read current state into variables
_detect_output="$(detect_current_mode)"
while IFS='=' read -r key value; do
  case "$key" in
    MODE) MODE="$value" ;;
    HAS_LOCAL) HAS_LOCAL="$value" ;;
    HAS_REMOTE) HAS_REMOTE="$value" ;;
    HAS_REMOTE_CONFIG) HAS_REMOTE_CONFIG="$value" ;;
    REMOTE_URL) REMOTE_URL="$value" ;;
    REMOTE_KEY_MASKED) REMOTE_KEY_MASKED="$value" ;;
  esac
done <<< "$_detect_output"

# ============================================================
# Status command
# ============================================================
if [ "$COMMAND" = "status" ]; then
  echo "🧠 Igris AI - Brain Mode Status"
  echo "========================================"
  echo ""
  echo "   Current mode: $MODE"
  echo ""
  echo "   Local brain (stdio):  $([ "$HAS_LOCAL" = "true" ] && echo "✅ active" || echo "❌ inactive")"
  echo "   Remote brain (HTTP):  $([ "$HAS_REMOTE" = "true" ] && echo "✅ active" || echo "❌ inactive")"
  echo ""

  if [ "$HAS_REMOTE_CONFIG" = "true" ]; then
    echo "   Remote URL: $REMOTE_URL"
    echo "   API Key:    $REMOTE_KEY_MASKED"
    echo ""
  fi

  # Run health checks
  echo "🩺 Health Checks:"

  if [ "$HAS_LOCAL" = "true" ]; then
    if [ -f "$BRAIN_DIR/memory/knowledge.db" ]; then
      INTEGRITY=$(sqlite3 "$BRAIN_DIR/memory/knowledge.db" "PRAGMA integrity_check;" 2>/dev/null || echo "failed")
      if [ "$INTEGRITY" = "ok" ]; then
        echo "   ✅ Local: knowledge.db OK"
      else
        echo "   ❌ Local: knowledge.db integrity FAILED"
      fi
    else
      echo "   ❌ Local: knowledge.db not found"
    fi
  fi

  if [ "$HAS_REMOTE" = "true" ] && [ "$HAS_REMOTE_CONFIG" = "true" ]; then
    HEALTH_URL="${REMOTE_URL%/}/health"
    if command -v curl &> /dev/null; then
      HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 "$HEALTH_URL" 2>/dev/null || echo "000")
      if [ "$HTTP_CODE" = "200" ]; then
        echo "   ✅ Remote: healthy (HTTP $HTTP_CODE)"
      else
        echo "   ⚠️  Remote: HTTP $HTTP_CODE ($HEALTH_URL)"
      fi
    else
      echo "   ⚠️  Remote: curl not found, cannot check"
    fi
  fi

  echo ""
  exit 0
fi

# ============================================================
# Switch commands (local, remote, dual)
# ============================================================

# For remote/dual, we need remote_brain config (from config.json or env vars)
if [ "$COMMAND" = "remote" ] || [ "$COMMAND" = "dual" ]; then
  if [ "$HAS_REMOTE_CONFIG" != "true" ]; then
    # Fall back to environment variables
    if [ -n "${IGRIS_REMOTE_BRAIN_URL:-}" ] && [ -n "${IGRIS_BRAIN_API_KEY:-}" ]; then
      echo "   Using remote credentials from environment variables"
      # Write remote_brain block into config.json from env vars
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
" "$CONFIG_FILE" "${IGRIS_REMOTE_BRAIN_URL}" "${IGRIS_BRAIN_API_KEY}"
      # Re-detect after updating config
      _detect_output="$(detect_current_mode)"
      while IFS='=' read -r key value; do
        case "$key" in
          MODE) MODE="$value" ;;
          HAS_LOCAL) HAS_LOCAL="$value" ;;
          HAS_REMOTE) HAS_REMOTE="$value" ;;
          HAS_REMOTE_CONFIG) HAS_REMOTE_CONFIG="$value" ;;
          REMOTE_URL) REMOTE_URL="$value" ;;
          REMOTE_KEY_MASKED) REMOTE_KEY_MASKED="$value" ;;
        esac
      done <<< "$_detect_output"
    else
      echo "❌ Error: No remote_brain configured in $CONFIG_FILE"
      echo ""
      echo "   Add remote brain first by editing $CONFIG_FILE:"
      echo "   set 'remote_brain.url' and 'remote_brain.api_key'."
      echo ""
      echo "   Or set environment variables:"
      echo "   export IGRIS_REMOTE_BRAIN_URL=http://your-vps:3001"
      echo "   export IGRIS_BRAIN_API_KEY=your-api-key"
      exit 1
    fi
  fi
fi

# For local/dual, we need the local MCP server to be built
MCP_SERVER_PATH="$BRAIN_DIR/mcp-server/dist/index.js"
if [ "$COMMAND" = "local" ] || [ "$COMMAND" = "dual" ]; then
  if [ ! -f "$MCP_SERVER_PATH" ]; then
    echo "❌ Error: Local MCP server not found at $MCP_SERVER_PATH"
    echo ""
    echo "   Build it first:"
    echo "   cd ~/.igris/mcp-server && npm install && npm run build"
    exit 1
  fi
fi

echo "🔄 Switching brain mode: $MODE → $COMMAND"
echo ""

python3 -c "
import json, sys

claude_file = sys.argv[1]
config_file = sys.argv[2]
target_mode = sys.argv[3]
mcp_path = sys.argv[4]

# Read Claude config
try:
    with open(claude_file, 'r') as f:
        claude = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    claude = {}

# Read brain config for remote settings
try:
    with open(config_file, 'r') as f:
        config = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    config = {}

if 'mcpServers' not in claude:
    claude['mcpServers'] = {}

remote_brain = config.get('remote_brain', {})
remote_url = remote_brain.get('url', '')
remote_key = remote_brain.get('api_key', '')

# Remove existing brain entries to start clean
for key in list(claude['mcpServers'].keys()):
    if key in ('igris-brain', 'igris-brain-remote'):
        del claude['mcpServers'][key]

# Add entries based on target mode
if target_mode in ('local', 'dual'):
    claude['mcpServers']['igris-brain'] = {
        'command': 'node',
        'args': [mcp_path]
    }

if target_mode == 'remote':
    # Remote-only: use primary name
    if remote_url and remote_key:
        mcp_url = remote_url.rstrip('/') + '/mcp'
        claude['mcpServers']['igris-brain'] = {
            'type': 'http',
            'url': mcp_url,
            'headers': {
                'Authorization': 'Bearer ' + remote_key
            }
        }

if target_mode == 'dual':
    # Dual: add remote under separate name
    if remote_url and remote_key:
        mcp_url = remote_url.rstrip('/') + '/mcp'
        claude['mcpServers']['igris-brain-remote'] = {
            'type': 'http',
            'url': mcp_url,
            'headers': {
                'Authorization': 'Bearer ' + remote_key
            }
        }

with open(claude_file, 'w') as f:
    json.dump(claude, f, indent=2)
    f.write('\n')
" "$CLAUDE_CONFIG" "$CONFIG_FILE" "$COMMAND" "$MCP_SERVER_PATH"

# Verify the switch
_detect_output="$(detect_current_mode)"
while IFS='=' read -r key value; do
  case "$key" in
    MODE) MODE="$value" ;;
    HAS_LOCAL) HAS_LOCAL="$value" ;;
    HAS_REMOTE) HAS_REMOTE="$value" ;;
    HAS_REMOTE_CONFIG) HAS_REMOTE_CONFIG="$value" ;;
    REMOTE_URL) REMOTE_URL="$value" ;;
    REMOTE_KEY_MASKED) REMOTE_KEY_MASKED="$value" ;;
  esac
done <<< "$_detect_output"

echo "✅ Brain mode switched to: $MODE"
echo ""

if [ "$MODE" = "local" ]; then
  echo "   igris-brain → local stdio ($MCP_SERVER_PATH)"
elif [ "$MODE" = "remote" ]; then
  echo "   igris-brain → remote HTTP ($REMOTE_URL)"
elif [ "$MODE" = "dual" ]; then
  echo "   igris-brain         → local stdio ($MCP_SERVER_PATH)"
  echo "   igris-brain-remote  → remote HTTP ($REMOTE_URL)"
fi

echo ""
echo "⚠️  Restart Claude Code for the change to take effect."
echo ""
