#!/bin/bash

# Description: Portable PreToolUse hook for multi-CLI lifecycle integration.
#              Enforces the brief-first protocol by checking for an active brief
#              before allowing file modifications. Exempt paths (~/.igris/, .claude/,
#              tests, etc.) are always allowed through.
# Usage: Invoked by a per-CLI bridge. Reads JSON from stdin.
#
# Input contract:
#   stdin (preferred): JSON object. Two shapes accepted:
#     Unified shape (from bridges):
#       { "source": "claude"|"opencode", "event": "pre_tool_use",
#         "project_dir": "...",
#         "payload": { "tool_name": "...", "tool_input": { "file_path": "..." } } }
#     Native Claude shape:
#       { "tool_name": "Write|Edit", "tool_input": { "file_path": "..." } }
#   env fallback:
#     IGRIS_HOOK_SOURCE, IGRIS_HOOK_EVENT, IGRIS_PROJECT_DIR,
#     IGRIS_TOOL_NAME, IGRIS_FILE_PATH
#
# Dependencies: jq (preferred), python3 (fallback)
# Exit codes:
#   0 - Always (hooks must never fail; denial is via JSON output, not exit code)

set -e

INPUT=$(cat 2>/dev/null || true)

resolve_project_dir() {
  local from_input=""
  if [ -n "$INPUT" ]; then
    if command -v jq &> /dev/null; then
      from_input=$(echo "$INPUT" | jq -r '.project_dir // .cwd // ""' 2>/dev/null || echo "")
    else
      from_input=$(echo "$INPUT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get('project_dir') or d.get('cwd') or '')
except Exception:
    print('')
" 2>/dev/null || echo "")
    fi
  fi
  if [ -n "$from_input" ]; then
    echo "$from_input"
  elif [ -n "${IGRIS_PROJECT_DIR:-}" ]; then
    echo "$IGRIS_PROJECT_DIR"
  elif [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    echo "$CLAUDE_PROJECT_DIR"
  else
    echo "$PWD"
  fi
}

PROJECT_DIR=$(resolve_project_dir)
[ -d "$PROJECT_DIR" ] && cd "$PROJECT_DIR"

# Escape hatch: skip gate entirely if env var is set
if [ "${IGRIS_SKIP_BRIEF_GATE:-0}" = "1" ]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Extract file_path from tool_input (both shapes)
# ---------------------------------------------------------------------------
extract_file_path() {
  if [ -z "$INPUT" ]; then
    echo "${IGRIS_FILE_PATH:-}"
    return
  fi
  if command -v jq &> /dev/null; then
    # Try payload.tool_input.file_path first (unified), then tool_input.file_path (Claude)
    local result
    result=$(echo "$INPUT" | jq -r '.payload.tool_input.file_path // .tool_input.file_path // ""' 2>/dev/null || echo "")
    echo "$result"
  else
    echo "$INPUT" | python3 -c "
import json, sys, os
try:
    data = json.load(sys.stdin)
    p = data.get('payload') or {}
    tool_input = None
    if isinstance(p, dict):
        tool_input = p.get('tool_input')
    if not tool_input:
        tool_input = data.get('tool_input')
    if isinstance(tool_input, dict):
        print(tool_input.get('file_path', ''))
    else:
        print(os.environ.get('IGRIS_FILE_PATH', ''))
except Exception:
    print(os.environ.get('IGRIS_FILE_PATH', ''))
" 2>/dev/null || echo "${IGRIS_FILE_PATH:-}"
  fi
}

# ---------------------------------------------------------------------------
# Check if path is exempt from brief gate
# ---------------------------------------------------------------------------
is_exempt() {
  local file_path="$1"

  # Empty path: allow (safety)
  if [ -z "$file_path" ]; then
    return 0
  fi

  case "$file_path" in
    */.igris/*)        return 0 ;;
    */core/*)          return 0 ;;
    */.claude/*)       return 0 ;;
    */test/*)          return 0 ;;
    */tests/*)         return 0 ;;
  esac

  local filename
  filename=$(basename "$file_path")
  case "$filename" in
    CLAUDE.md)       return 0 ;;
    CLAUDE.local.md) return 0 ;;
    AGENTS.md)       return 0 ;;
  esac

  return 1
}

# ---------------------------------------------------------------------------
# Check for active brief with caching
# ---------------------------------------------------------------------------
check_active_brief() {
  local cache_file="/tmp/igris_brief_gate_cache"
  local cache_ttl=60  # seconds

  if [ -f "$cache_file" ]; then
    local cache_age
    local now
    now=$(date +%s)
    local cache_mtime
    if [[ "$OSTYPE" == "darwin"* ]]; then
      cache_mtime=$(stat -f %m "$cache_file" 2>/dev/null) || cache_mtime=0
    else
      cache_mtime=$(stat -c %Y "$cache_file" 2>/dev/null) || cache_mtime=0
    fi
    cache_age=$((now - cache_mtime))

    if [ "$cache_age" -lt "$cache_ttl" ]; then
      local cached_result
      cached_result=$(<"$cache_file")
      if [ -n "$cached_result" ]; then
        return 0
      else
        return 1
      fi
    fi
  fi

  local active_brief=""
  local slug
  slug=$(basename "$PROJECT_DIR")
  local cache_briefs="$HOME/.igris/projects/$slug/briefs"
  if [ -d "$cache_briefs" ]; then
    active_brief=$(grep -rl '^\*\*Status:\*\* In Progress' "$cache_briefs/" 2>/dev/null | head -1) || true
  fi

  echo "$active_brief" > "$cache_file" 2>/dev/null || true

  if [ -n "$active_brief" ]; then
    return 0
  else
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Output deny decision as JSON
# ---------------------------------------------------------------------------
output_deny() {
  if command -v jq &> /dev/null; then
    jq -n '{
      "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": "No active brief found. Create a brief first: use REGISTER or '\''create a brief for...'\''"
      }
    }'
  else
    python3 -c "
import json
result = {
    'hookSpecificOutput': {
        'hookEventName': 'PreToolUse',
        'permissionDecision': 'deny',
        'permissionDecisionReason': \"No active brief found. Create a brief first: use REGISTER or 'create a brief for...'\"
    }
}
print(json.dumps(result))
" 2>/dev/null || echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"No active brief found. Create a brief first: use REGISTER or create a brief for..."}}'
  fi
}

# ---------------------------------------------------------------------------
# Main execution
# ---------------------------------------------------------------------------
main() {
  local file_path
  file_path=$(extract_file_path)

  if is_exempt "$file_path"; then
    exit 0
  fi

  if check_active_brief; then
    exit 0
  fi

  output_deny
  exit 0
}

main "$@" 2>/dev/null || exit 0
