#!/bin/bash
set -e

# Description: SessionStart hook for Claude Code lifecycle integration.
#              Reads Igris AI session state and active briefs, then injects
#              context via additionalContext so Claude resumes with full awareness.
# Usage: Called automatically by Claude Code on session start. Reads JSON from stdin.
# Dependencies: jq (preferred), python3 (fallback)
# Exit codes:
#   0 - Always (hooks must never fail)

# Navigate to project root
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
cd "$PROJECT_DIR"

# Read stdin (Claude Code sends JSON with session_id, source, cwd)
INPUT=$(cat)

# Parse source field (startup, resume, clear, compact)
parse_source() {
  if command -v jq &> /dev/null; then
    echo "$INPUT" | jq -r '.source // "startup"' 2>/dev/null || echo "startup"
  else
    echo "$INPUT" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    print(data.get('source', 'startup'))
except Exception:
    print('startup')
" 2>/dev/null || echo "startup"
  fi
}

# Read session mode from CURRENT_SESSION.md
read_session_mode() {
  local slug
  slug=$(basename "$PROJECT_DIR")
  local session_file="$HOME/.igris/cache/$slug/session/CURRENT_SESSION.md"
  if [ -f "$session_file" ]; then
    grep '\*\*Mode:\*\*' "$session_file" 2>/dev/null | head -1 | sed 's/.*\*\*Mode:\*\* //' || echo "UNKNOWN"
  else
    echo "NO SESSION"
  fi
}

# Find active briefs (Status: In Progress)
find_active_briefs() {
  local slug
  slug=$(basename "$PROJECT_DIR")
  local briefs_dir="$HOME/.igris/cache/$slug/briefs"
  if [ ! -d "$briefs_dir" ]; then
    return
  fi

  local active_files
  active_files=$(grep -rl '^\*\*Status:\*\* In Progress' "$briefs_dir" 2>/dev/null | head -5) || true

  for brief_file in $active_files; do
    local brief_id
    brief_id=$(basename "$brief_file" | sed 's/\.md$//' | grep -oE '^[A-Z]+-[0-9]+' 2>/dev/null) || continue

    local title
    title=$(grep '^# ' "$brief_file" 2>/dev/null | head -1 | sed 's/^# //') || title="Unknown"

    local phase
    phase=$(grep '\*\*Phase:\*\*' "$brief_file" 2>/dev/null | head -1 | sed 's/.*\*\*Phase:\*\* //') || phase="Unknown"

    local agent
    agent=$(grep '\*\*Active Agent:\*\*' "$brief_file" 2>/dev/null | head -1 | sed 's/.*\*\*Active Agent:\*\* //') || agent="None"

    local next_steps
    next_steps=$(grep -A1 '### Next Steps' "$brief_file" 2>/dev/null | tail -1 | sed 's/^[[:space:]]*//' | head -1) || next_steps="None"

    echo "Active Brief: ${brief_id} - ${title}"
    echo "Phase: ${phase} | Agent: ${agent}"
    echo "Next Steps: ${next_steps}"
  done
}

# Read blockers
read_blockers() {
  local slug
  slug=$(basename "$PROJECT_DIR")
  local blockers_file="$HOME/.igris/cache/$slug/session/BLOCKERS.md"
  if [ -f "$blockers_file" ]; then
    local count
    count=$(grep -c '^## ' "$blockers_file" 2>/dev/null) || count=0
    if [ "$count" -gt 0 ]; then
      echo "Blockers: ${count} active"
    else
      echo "Blockers: None"
    fi
  else
    echo "Blockers: None"
  fi
}

# Build the additional context string
build_context() {
  local source
  source=$(parse_source)

  local mode
  mode=$(read_session_mode)

  local active_brief_info
  active_brief_info=$(find_active_briefs)

  local blockers
  blockers=$(read_blockers)

  local context="[IGRIS SESSION STATE]"
  context="${context}\nSource: ${source}"
  context="${context}\nMode: ${mode}"

  if [ -n "$active_brief_info" ]; then
    context="${context}\n${active_brief_info}"
  else
    context="${context}\nActive Brief: None"
  fi

  context="${context}\n${blockers}"
  context="${context}\n[/IGRIS SESSION STATE]"

  echo "$context"
}

# Main execution
main() {
  local context
  context=$(build_context 2>/dev/null) || context="[IGRIS SESSION STATE]\nMode: UNKNOWN\nActive Brief: None\nBlockers: None\n[/IGRIS SESSION STATE]"

  # Output JSON with additionalContext
  if command -v jq &> /dev/null; then
    jq -n --arg ctx "$context" '{"additionalContext": $ctx}'
  else
    CONTEXT_DATA="$context" python3 -c "
import json, os
context = os.environ.get('CONTEXT_DATA', '')
print(json.dumps({'additionalContext': context}))
" 2>/dev/null || echo '{"additionalContext": "[IGRIS SESSION STATE]\nMode: UNKNOWN\n[/IGRIS SESSION STATE]"}'
  fi

  exit 0
}

# Run main, catch any unexpected errors
main "$@" 2>/dev/null || echo '{"additionalContext": "[IGRIS SESSION STATE]\nMode: UNKNOWN\n[/IGRIS SESSION STATE]"}'
exit 0
