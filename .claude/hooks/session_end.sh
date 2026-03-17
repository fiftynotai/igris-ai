#!/bin/bash
set -e

# Description: SessionEnd hook for Claude Code lifecycle integration.
#              Updates CURRENT_SESSION.md to REST MODE when a session ends,
#              ensuring clean session state for next startup.
# Usage: Called automatically by Claude Code on session end. Reads JSON from stdin.
# Dependencies: python3
# Exit codes:
#   0 - Always (hooks must never fail)

# Navigate to project root
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
cd "$PROJECT_DIR"

# Read stdin (Claude Code sends JSON with session_id, reason)
INPUT=$(cat)

# Parse reason field
parse_reason() {
  if command -v jq &> /dev/null; then
    echo "$INPUT" | jq -r '.reason // "unknown"' 2>/dev/null || echo "unknown"
  else
    echo "$INPUT" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    print(data.get('reason', 'unknown'))
except Exception:
    print('unknown')
" 2>/dev/null || echo "unknown"
  fi
}

# Update session file to REST MODE
update_session() {
  local slug
  slug=$(basename "$PROJECT_DIR")
  local session_file="$HOME/.igris/cache/$slug/session/CURRENT_SESSION.md"

  if [ ! -f "$session_file" ]; then
    return 0
  fi

  local today
  today=$(date '+%Y-%m-%d')

  local reason
  reason=$(parse_reason)

  # Use python3 for reliable file manipulation
  python3 << PYEOF
import re
import os
import tempfile

session_file = "${session_file}"
today = "${today}"
reason = "${reason}"

try:
    with open(session_file, 'r') as f:
        content = f.read()

    # Replace Mode: ACTIVE with Mode: REST MODE
    content = re.sub(
        r'\*\*Mode:\*\* ACTIVE',
        '**Mode:** REST MODE',
        content
    )

    # Update the Updated date
    content = re.sub(
        r'\*\*Updated:\*\* \d{4}-\d{2}-\d{2}',
        f'**Updated:** {today}',
        content
    )

    # Write via temp file for atomic operation
    dir_name = os.path.dirname(os.path.abspath(session_file))
    fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix='.tmp')
    with os.fdopen(fd, 'w') as f:
        f.write(content)
    os.rename(tmp_path, session_file)

except Exception as e:
    import sys
    print(f"session_end.sh: failed to update session: {e}", file=sys.stderr)
PYEOF
}

# Deregister instance from brain before session ends
deregister_instance() {
  local slug
  slug=$(basename "$PROJECT_DIR")
  local session_file="$HOME/.igris/cache/$slug/session/CURRENT_SESSION.md"

  if [ ! -f "$session_file" ]; then
    return 0
  fi

  # Extract Instance ID from session file
  local instance_id
  instance_id=$(sed -n 's/^\*\*Instance ID:\*\* *//p' "$session_file" 2>/dev/null | tr -d '[:space:]' || true)

  if [ -z "$instance_id" ]; then
    return 0
  fi

  # Read remote brain config
  local config_file="$HOME/.igris/config.json"
  local brain_url=""
  local api_key=""

  if [ -f "$config_file" ]; then
    if command -v jq &> /dev/null; then
      brain_url=$(jq -r '.remote_brain.url // empty' "$config_file" 2>/dev/null || true)
      api_key=$(jq -r '.remote_brain.api_key // empty' "$config_file" 2>/dev/null || true)
    else
      brain_url=$(python3 -c "
import json, sys
try:
    with open('$config_file') as f:
        c = json.load(f)
    print(c.get('remote_brain', {}).get('url', ''))
except Exception:
    pass
" 2>/dev/null || true)
      api_key=$(python3 -c "
import json, sys
try:
    with open('$config_file') as f:
        c = json.load(f)
    print(c.get('remote_brain', {}).get('api_key', ''))
except Exception:
    pass
" 2>/dev/null || true)
    fi
  fi

  local deregistered=false

  # Try remote brain first
  if [ -n "$brain_url" ] && [ -n "$api_key" ] && command -v curl &> /dev/null; then
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
      "${brain_url}/api/instances/${instance_id}" \
      -H "Authorization: Bearer ${api_key}" \
      --connect-timeout 5 --max-time 10 2>/dev/null || echo "000")
    if [ "$http_code" = "200" ]; then
      deregistered=true
    fi
  fi

  # Try localhost fallback (local brain)
  if [ "$deregistered" = "false" ] && command -v curl &> /dev/null; then
    curl -s -o /dev/null -X DELETE \
      "http://localhost:3001/api/instances/${instance_id}" \
      --connect-timeout 3 --max-time 5 2>/dev/null || true
  fi

  # Remove Instance ID line from session file
  python3 << PYEOF2
import re, os, tempfile

session_file = "${session_file}"
try:
    with open(session_file, 'r') as f:
        content = f.read()

    content = re.sub(r'\n?\*\*Instance ID:\*\*.*\n?', '\n', content)

    dir_name = os.path.dirname(os.path.abspath(session_file))
    fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix='.tmp')
    with os.fdopen(fd, 'w') as f:
        f.write(content)
    os.rename(tmp_path, session_file)
except Exception:
    pass
PYEOF2
}

# Main execution
main() {
  deregister_instance 2>/dev/null || true
  update_session 2>/dev/null || true
  exit 0
}

# Run main, catch any unexpected errors
main "$@" 2>/dev/null || true
exit 0
