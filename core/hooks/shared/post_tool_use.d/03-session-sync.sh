#!/bin/bash

# Description: PostToolUse handler (order: 03). Auto-syncs session file changes to
#              brain staging when session files are modified. Writes a JSON staging
#              file to ~/.igris/staging/ for the brain MCP server to consume. Guarded
#              by `features.staging_pipeline` feature flag in ~/.igris/config.json.
# Usage: Invoked by the dispatcher `post_tool_use.sh`. Reads JSON from stdin.
#
# Input contract:
#   stdin (preferred): JSON object. Two shapes accepted:
#     Unified shape: { "payload": { "tool_input": { "file_path": "..." } } }
#     Claude native: { "tool_input": { "file_path": "..." } }
#   env fallback: IGRIS_FILE_PATH
#
# Dependencies: shasum (standard on macOS/Linux)
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

SESSION_FILES="CURRENT_SESSION.md LEARNINGS.md DECISIONS.md BLOCKERS.md TEST_RESULTS.md"

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

  case "$file_path" in
    */.igris/cache/*/session/*.md) ;;
    */.igris/projects/*/session/*.md) ;;
    *) exit 0 ;;
  esac

  local filename
  filename=$(basename "$file_path")
  local matched=false
  for known in $SESSION_FILES; do
    if [ "$filename" = "$known" ]; then
      matched=true
      break
    fi
  done

  if [ "$matched" != "true" ]; then
    exit 0
  fi

  if [ ! -f "$file_path" ]; then
    exit 0
  fi

  mkdir -p "$STAGING_DIR"

  local project_slug
  project_slug=$(basename "$PROJECT_DIR")

  local content_hash
  if command -v shasum &> /dev/null; then
    content_hash=$(shasum -a 256 "$file_path" 2>/dev/null | cut -d' ' -f1 || echo "")
  elif command -v md5 &> /dev/null; then
    content_hash=$(md5 -q "$file_path" 2>/dev/null || echo "")
  else
    content_hash=""
  fi

  local session_mode=""
  if [ "$filename" = "CURRENT_SESSION.md" ]; then
    session_mode=$(grep -m1 '^\*\*Mode:\*\*' "$file_path" 2>/dev/null | sed 's/.*\*\*Mode:\*\* //' || echo "Unknown")
  fi

  local file_key
  file_key=$(echo "$filename" | sed 's/\.md$//')

  local staging_file="$STAGING_DIR/session_sync_${project_slug}_${file_key}.json"
  cat > "$staging_file" <<EOF
{
  "type": "session_sync",
  "project": "$project_slug",
  "filename": "$filename",
  "session_mode": "$session_mode",
  "content_hash": "$content_hash",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source_file": "$file_path"
}
EOF

  exit 0
}

main "$@" 2>/dev/null || exit 0
