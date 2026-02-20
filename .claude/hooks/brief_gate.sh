#!/bin/bash
set -e

# Description: PreToolUse hook for Write|Edit operations.
#              Enforces the brief-first protocol by checking for an active brief
#              before allowing file modifications. Exempt paths (ai/, .claude/, tests)
#              are always allowed through.
# Usage: Called automatically by Claude Code before Write/Edit tool use. Reads JSON from stdin.
# Dependencies: jq (preferred), python3 (fallback)
# Exit codes:
#   0 - Always (hooks must never fail; denial is via JSON output, not exit code)

# Navigate to project root
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
cd "$PROJECT_DIR"

# Escape hatch: skip gate entirely if env var is set
if [ "${IGRIS_SKIP_BRIEF_GATE}" = "1" ]; then
  exit 0
fi

# Read stdin (Claude Code sends JSON with tool_name, tool_input)
INPUT=$(cat)

# Extract file_path from tool_input
extract_file_path() {
  if command -v jq &> /dev/null; then
    echo "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo ""
  else
    echo "$INPUT" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    print(data.get('tool_input', {}).get('file_path', ''))
except Exception:
    print('')
" 2>/dev/null || echo ""
  fi
}

# Check if path is exempt from brief gate
is_exempt() {
  local file_path="$1"

  # Empty path: allow (safety)
  if [ -z "$file_path" ]; then
    return 0
  fi

  # Check exempt patterns
  case "$file_path" in
    */ai/briefs/*)     return 0 ;;
    */ai/session/*)    return 0 ;;
    */ai/prompts/*)    return 0 ;;
    */ai/context/*)    return 0 ;;
    */ai/plans/*)      return 0 ;;
    */ai/personas/*)   return 0 ;;
    */ai/templates/*)  return 0 ;;
    */.claude/*)       return 0 ;;
    */test/*)          return 0 ;;
    */tests/*)         return 0 ;;
  esac

  # Check filename matches
  local filename
  filename=$(basename "$file_path")
  case "$filename" in
    CLAUDE.md)       return 0 ;;
    CLAUDE.local.md) return 0 ;;
  esac

  return 1
}

# Check for active brief with caching
check_active_brief() {
  local cache_file="/tmp/igris_brief_gate_cache"
  local cache_ttl=60  # seconds

  # Check if cache exists and is fresh
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
        return 0  # Active brief found (cached)
      else
        return 1  # No active brief (cached)
      fi
    fi
  fi

  # Cache stale or missing: check briefs directory
  local active_brief=""
  if [ -d "ai/briefs" ]; then
    active_brief=$(grep -rl '^\*\*Status:\*\* In Progress' ai/briefs/ 2>/dev/null | head -1) || true
  fi

  # Write to cache
  echo "$active_brief" > "$cache_file" 2>/dev/null || true

  if [ -n "$active_brief" ]; then
    return 0
  else
    return 1
  fi
}

# Output deny decision as JSON
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

# Main execution
main() {
  local file_path
  file_path=$(extract_file_path)

  # Check exemptions first
  if is_exempt "$file_path"; then
    exit 0
  fi

  # Check for active brief
  if check_active_brief; then
    exit 0
  fi

  # No active brief: deny the operation
  output_deny
  exit 0
}

# Run main, catch any unexpected errors (on error, allow through)
main "$@" 2>/dev/null || exit 0
