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

# Main execution
main() {
  update_session 2>/dev/null || true
  exit 0
}

# Run main, catch any unexpected errors
main "$@" 2>/dev/null || true
exit 0
