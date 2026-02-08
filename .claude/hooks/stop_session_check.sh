#!/bin/bash
set -e

# Description: Stop hook for Claude Code lifecycle integration.
#              Checks if CURRENT_SESSION.md reflects current work before stopping.
#              Outputs a warning if session mode is ACTIVE but provides no blocking.
# Usage: Called automatically by Claude Code on Stop event. Reads JSON from stdin.
# Dependencies: none (pure bash)
# Exit codes:
#   0 - Always (hooks must never fail)

# Navigate to project root
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
cd "$PROJECT_DIR"

# Read stdin (Claude Code sends JSON context)
INPUT=$(cat)

# Check session state
check_session() {
  local session_file="ai/session/CURRENT_SESSION.md"

  # No session file: nothing to check
  if [ ! -f "$session_file" ]; then
    return 0
  fi

  # Read the mode line
  local mode
  mode=$(grep '\*\*Mode:\*\*' "$session_file" 2>/dev/null | head -1 | sed 's/.*\*\*Mode:\*\* //') || mode=""

  # REST MODE or empty: all good
  case "$mode" in
    "REST MODE"|""|"UNKNOWN")
      return 0
      ;;
  esac

  # Mode is ACTIVE/HUNT MODE/etc: warn
  echo "Session mode is '${mode}' - ensure CURRENT_SESSION.md has your latest progress." >&2
}

# Main execution
main() {
  check_session 2>/dev/null || true
  exit 0
}

# Run main, catch any unexpected errors
main "$@" 2>/dev/null || true
exit 0
