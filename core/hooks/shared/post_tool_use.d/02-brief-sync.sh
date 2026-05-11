#!/bin/bash

# Description: PostToolUse handler (order: 02). Auto-syncs brief changes to brain
#              staging when brief files are modified. Writes a JSON staging file to
#              ~/.igris/staging/ for the brain MCP server to consume. Guarded by
#              `features.staging_pipeline` feature flag in ~/.igris/config.json.
# Usage: Invoked by the dispatcher `post_tool_use.sh`. Reads JSON from stdin.
#
# Input contract:
#   stdin (preferred): JSON object. Two shapes accepted:
#     Unified shape: { "payload": { "tool_input": { "file_path": "..." } } }
#     Claude native: { "tool_input": { "file_path": "..." } }
#   env fallback: IGRIS_FILE_PATH
#
# Dependencies: None (pure bash)
# Exit codes:
#   0 - Always (hooks must never fail)

set -e

# Early exit if staging_pipeline is not enabled in config
BRAIN_CONFIG="$HOME/.igris/config.json"
if [ -f "$BRAIN_CONFIG" ]; then
  STAGING_ENABLED=""
  if command -v jq &> /dev/null; then
    STAGING_ENABLED=$(jq -r '.features.staging_pipeline // false' "$BRAIN_CONFIG" 2>/dev/null || echo "false")
  elif command -v python3 &> /dev/null; then
    STAGING_ENABLED=$(python3 -c "
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    print(str(data.get('features', {}).get('staging_pipeline', False)).lower())
except Exception:
    print('false')
" "$BRAIN_CONFIG" 2>/dev/null || echo "false")
  else
    STAGING_ENABLED="false"
  fi
  if [ "$STAGING_ENABLED" != "true" ]; then
    exit 0
  fi
else
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-${IGRIS_PROJECT_DIR:-$PWD}}"
STAGING_DIR="$HOME/.igris/staging"

INPUT=$(cat 2>/dev/null || true)

extract_file_path() {
  if [ -z "$INPUT" ]; then
    echo "${IGRIS_FILE_PATH:-}"
    return
  fi
  if command -v jq &> /dev/null; then
    echo "$INPUT" | jq -r '.payload.tool_input.file_path // .tool_input.file_path // ""' 2>/dev/null || echo ""
  else
    echo "$INPUT" | python3 -c "
import json, sys, os
try:
    data = json.load(sys.stdin)
    p = data.get('payload') or {}
    tool_input = p.get('tool_input') if isinstance(p, dict) else None
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

main() {
  local file_path
  file_path=$(extract_file_path)

  if [ -z "$file_path" ]; then
    exit 0
  fi

  # Only process brief files in brain cache (not templates)
  case "$file_path" in
    */.igris/cache/*/briefs/*.md) ;;
    */.igris/projects/*/briefs/*.md) ;;
    *) exit 0 ;;
  esac

  case "$file_path" in
    *TEMPLATE*) exit 0 ;;
  esac

  mkdir -p "$STAGING_DIR"

  local basename_noext
  basename_noext=$(basename "$file_path" .md)
  local brief_id
  brief_id=$(echo "$basename_noext" | grep -oE '^[A-Z]{2,3}-[0-9]{3}' || echo "")

  if [ -z "$brief_id" ]; then
    exit 0
  fi

  if [ ! -f "$file_path" ]; then
    exit 0
  fi

  local project_slug
  project_slug=$(basename "$PROJECT_DIR")

  local status priority title
  status=$(grep -m1 '^\*\*Status:\*\*' "$file_path" 2>/dev/null | sed 's/.*\*\*Status:\*\* //' || echo "Unknown")
  priority=$(grep -m1 '^\*\*Priority:\*\*' "$file_path" 2>/dev/null | sed 's/.*\*\*Priority:\*\* //' || echo "Unknown")
  title=$(grep -m1 '^# ' "$file_path" 2>/dev/null | sed 's/^# //' | sed 's/^[A-Z]*-[0-9]*: //' || echo "Unknown")

  local staging_file="$STAGING_DIR/brief_sync_${project_slug}_${brief_id}.json"
  cat > "$staging_file" <<EOF
{
  "type": "brief_sync",
  "project": "$project_slug",
  "brief_id": "$brief_id",
  "title": "$title",
  "status": "$status",
  "priority": "$priority",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source_file": "$file_path"
}
EOF

  exit 0
}

main "$@" 2>/dev/null || exit 0
