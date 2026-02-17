#!/bin/bash
set -e

# Description: PostToolUse hook for Write|Edit operations.
#              Auto-syncs brief changes to brain staging when brief files are modified.
#              Writes a JSON staging file to ~/.igris/staging/ for the brain MCP server.
# Usage: Called automatically by Claude Code after Write/Edit tool use. Reads JSON from stdin.
# Dependencies: None (pure bash)
# Exit codes:
#   0 - Always (hooks must never fail)

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
STAGING_DIR="$HOME/.igris/staging"

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

  # Only process brief files in ai/briefs/ (not templates)
  case "$file_path" in
    *ai/briefs/*.md) ;;
    *) exit 0 ;;
  esac

  case "$file_path" in
    *TEMPLATE*) exit 0 ;;
  esac

  # Ensure staging directory exists
  mkdir -p "$STAGING_DIR"

  # Extract brief_id from filename (e.g., FR-033 from FR-033-brain-mcp-http-transport-fix.md)
  local basename_noext
  basename_noext=$(basename "$file_path" .md)
  local brief_id
  brief_id=$(echo "$basename_noext" | grep -oE '^[A-Z]{2,3}-[0-9]{3}' || echo "")

  if [ -z "$brief_id" ]; then
    exit 0
  fi

  # Check the file actually exists before reading metadata
  if [ ! -f "$file_path" ]; then
    exit 0
  fi

  # Extract project slug
  local project_slug
  project_slug=$(basename "$PROJECT_DIR")

  # Extract metadata from the brief file
  local status priority title
  status=$(grep -m1 '^\*\*Status:\*\*' "$file_path" 2>/dev/null | sed 's/.*\*\*Status:\*\* //' || echo "Unknown")
  priority=$(grep -m1 '^\*\*Priority:\*\*' "$file_path" 2>/dev/null | sed 's/.*\*\*Priority:\*\* //' || echo "Unknown")
  title=$(grep -m1 '^# ' "$file_path" 2>/dev/null | sed 's/^# //' | sed 's/^[A-Z]*-[0-9]*: //' || echo "Unknown")

  # Write staging file for brain MCP server to pick up
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

# Run main, catch any unexpected errors
main "$@" 2>/dev/null || exit 0
