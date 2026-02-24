#!/bin/bash
set -e

# Description: PostToolUse hook for Write|Edit operations.
#              Auto-syncs session file changes to brain staging when session files are modified.
#              Writes a JSON staging file to ~/.igris/staging/ for the brain MCP server.
#              Guarded by staging_pipeline feature flag in ~/.igris/config.json.
# Usage: Called automatically by Claude Code after Write/Edit tool use. Reads JSON from stdin.
# Dependencies: shasum (standard on macOS/Linux)
# Exit codes:
#   0 - Always (hooks must never fail)

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
  # No config file means no brain — skip staging
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
STAGING_DIR="$HOME/.igris/staging"

# Known session files that trigger sync
SESSION_FILES="CURRENT_SESSION.md LEARNINGS.md DECISIONS.md BLOCKERS.md TEST_RESULTS.md"

# Read stdin (Claude Code sends JSON with tool_input)
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

# Main logic
main() {
  local file_path
  file_path=$(extract_file_path)

  if [ -z "$file_path" ]; then
    exit 0
  fi

  # Only process session files in brain cache
  case "$file_path" in
    */.igris/cache/*/session/*.md) ;;
    *) exit 0 ;;
  esac

  # Only process known session files (not archive or other files)
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

  # Check the file actually exists
  if [ ! -f "$file_path" ]; then
    exit 0
  fi

  # Ensure staging directory exists
  mkdir -p "$STAGING_DIR"

  # Extract project slug
  local project_slug
  project_slug=$(basename "$PROJECT_DIR")

  # Compute content hash for change detection
  local content_hash
  if command -v shasum &> /dev/null; then
    content_hash=$(shasum -a 256 "$file_path" 2>/dev/null | cut -d' ' -f1 || echo "")
  elif command -v md5 &> /dev/null; then
    content_hash=$(md5 -q "$file_path" 2>/dev/null || echo "")
  else
    content_hash=""
  fi

  # Extract session mode from CURRENT_SESSION.md
  local session_mode=""
  if [ "$filename" = "CURRENT_SESSION.md" ]; then
    session_mode=$(grep -m1 '^\*\*Mode:\*\*' "$file_path" 2>/dev/null | sed 's/.*\*\*Mode:\*\* //' || echo "Unknown")
  fi

  # Derive a safe key from filename (e.g., CURRENT_SESSION, LEARNINGS)
  local file_key
  file_key=$(echo "$filename" | sed 's/\.md$//')

  # Write staging file for brain MCP server to pick up
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

# Run main, catch any unexpected errors
main "$@" 2>/dev/null || exit 0
