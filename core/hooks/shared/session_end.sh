#!/bin/bash

# Description: Portable SessionEnd hook for multi-CLI lifecycle integration.
#              Updates CURRENT_SESSION.md to REST MODE and deregisters the Igris
#              instance from the brain (if registered).
# Usage: Invoked by a per-CLI bridge. Reads JSON from stdin.
#
# Input contract:
#   stdin (preferred): JSON object. Two shapes accepted:
#     Unified shape (from bridges):
#       { "source": "claude"|"opencode"|"codex", "event": "session_end",
#         "project_dir": "...", "payload": {...}, "reason": "..." }
#     Native Claude shape:
#       { "session_id": "...", "reason": "..." }
#   env fallback:
#     IGRIS_HOOK_SOURCE, IGRIS_HOOK_EVENT, IGRIS_PROJECT_DIR
#
# Dependencies: python3
# Exit codes:
#   0 - Always (hooks must never fail)

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

parse_reason() {
  if [ -z "$INPUT" ]; then
    echo "unknown"
    return
  fi
  if command -v jq &> /dev/null; then
    echo "$INPUT" | jq -r '.reason // .payload.reason // "unknown"' 2>/dev/null || echo "unknown"
  else
    echo "$INPUT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    p = d.get('payload') or {}
    reason = d.get('reason') or (p.get('reason') if isinstance(p, dict) else None) or 'unknown'
    print(reason)
except Exception:
    print('unknown')
" 2>/dev/null || echo "unknown"
  fi
}

# ---------------------------------------------------------------------------
# Update session file to REST MODE
# ---------------------------------------------------------------------------
update_session() {
  local slug
  slug=$(basename "$PROJECT_DIR")
  local session_file="$HOME/.igris/projects/$slug/session/CURRENT_SESSION.md"

  if [ ! -f "$session_file" ]; then
    return 0
  fi

  local today
  today=$(date '+%Y-%m-%d')

  local reason
  reason=$(parse_reason)

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

    content = re.sub(
        r'\*\*Mode:\*\* ACTIVE',
        '**Mode:** REST MODE',
        content
    )

    content = re.sub(
        r'\*\*Updated:\*\* \d{4}-\d{2}-\d{2}',
        f'**Updated:** {today}',
        content
    )

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

# ---------------------------------------------------------------------------
# Deregister instance from brain before session ends
# ---------------------------------------------------------------------------
deregister_instance() {
  local slug
  slug=$(basename "$PROJECT_DIR")
  local session_file="$HOME/.igris/projects/$slug/session/CURRENT_SESSION.md"

  if [ ! -f "$session_file" ]; then
    return 0
  fi

  local instance_id
  instance_id=$(sed -n 's/^\*\*Instance ID:\*\* *//p' "$session_file" 2>/dev/null | tr -d '[:space:]' || true)

  if [ -z "$instance_id" ]; then
    return 0
  fi

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

# ---------------------------------------------------------------------------
# Main execution
# ---------------------------------------------------------------------------
main() {
  deregister_instance 2>/dev/null || true
  update_session 2>/dev/null || true
  # FR-109 perception channel: queue transcript window for offline extraction.
  # Re-feeds stdin via the captured INPUT — perception_extract.sh expects the
  # same JSON the parent hook received.
  if [ -x "$HOME/.igris/core/hooks/shared/perception_extract.sh" ]; then
    printf '%s' "$INPUT" | "$HOME/.igris/core/hooks/shared/perception_extract.sh" 2>/dev/null || true
  fi
  exit 0
}

main "$@" 2>/dev/null || true
exit 0
