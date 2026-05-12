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
# Dependencies: jq (preferred), python3 (fallback); sqlite3 (optional — brief-DB lookup)
#
# Brief-first resolution order (TD-146):
#   1. Brain DB (sqlite3): SELECT brief_id FROM brief_status
#      WHERE project = <slug> AND status = 'In Progress'  -- canonical (v5+)
#   2. Filesystem fallback: grep for '**Status:** In Progress' in
#      ~/.igris/projects/<slug>/briefs/  -- legacy v4 cache
#   3. Neither -> deny via JSON output.
# Slug is resolved by walking PROJECT_DIR up its ancestors and matching
# `projects.path` in the brain DB; falls back to basename(PROJECT_DIR).
# Slug is validated against ^[a-z0-9_-]+$ before any SQL interpolation;
# a non-matching slug skips the brain-DB branch (degrades to step 2).
# Cache: /tmp/igris_brief_gate_cache — single line, 60s mtime TTL.
#   non-empty => active brief exists (content = brief ID, or v4 brief path);
#   empty => no active brief.
# sqlite3 absent or brain DB missing => silently degrade to step 2.
#
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
# Resolve project slug by walking PROJECT_DIR's ancestors against the brain
# DB's `projects.path`. Falls back to basename(PROJECT_DIR). TD-146.
# Echoes the slug. Never fails (errors -> fallback).
# ---------------------------------------------------------------------------
find_project_slug() {
  local db="$HOME/.igris/memory/knowledge.db"
  local fallback
  fallback=$(basename "$PROJECT_DIR")

  if ! command -v sqlite3 >/dev/null 2>&1 || [ ! -f "$db" ]; then
    echo "$fallback"
    return
  fi

  local current="$PROJECT_DIR"
  while [ -n "$current" ] && [ "$current" != "/" ]; do
    local current_esc
    current_esc=$(printf '%s' "$current" | sed "s/'/''/g")
    local hit
    hit=$(sqlite3 "$db" "SELECT slug FROM projects WHERE path = '$current_esc' LIMIT 1;" 2>/dev/null) || hit=""
    if [ -n "$hit" ]; then
      echo "$hit"
      return
    fi
    current=$(dirname "$current")
  done

  echo "$fallback"
}

# ---------------------------------------------------------------------------
# Query the brain DB for an active (In Progress) brief for <slug>. TD-146.
# Echoes the brief_id (or empty). Validates slug against ^[a-z0-9_-]+$ before
# interpolation; a non-matching slug or missing sqlite3/DB -> empty (caller
# falls back to the v4 filesystem check).
# ---------------------------------------------------------------------------
find_active_brief_in_brain() {
  local slug="$1"
  local db="$HOME/.igris/memory/knowledge.db"

  case "$slug" in
    *[!a-z0-9_-]*|"") echo ""; return ;;
  esac

  if ! command -v sqlite3 >/dev/null 2>&1 || [ ! -f "$db" ]; then
    echo ""
    return
  fi

  sqlite3 "$db" \
    "SELECT brief_id FROM brief_status WHERE project = '$slug' AND status = 'In Progress' ORDER BY updated_at DESC LIMIT 1;" \
    2>/dev/null | head -1 || echo ""
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
  slug=$(find_project_slug)

  # 1. Canonical source: brain DB (v5+).
  active_brief=$(find_active_brief_in_brain "$slug")

  # 2. Legacy v4 fallback: filesystem brief cache.
  if [ -z "$active_brief" ]; then
    local cache_briefs="$HOME/.igris/projects/$slug/briefs"
    if [ -d "$cache_briefs" ]; then
      active_brief=$(grep -rl '^\*\*Status:\*\* In Progress' "$cache_briefs/" 2>/dev/null | head -1) || true
    fi
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
