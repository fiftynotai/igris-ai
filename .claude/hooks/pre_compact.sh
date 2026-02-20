#!/bin/bash
set -e

# Description: PreCompact hook for Claude Code lifecycle integration.
#              Captures critical Igris AI session state before context compaction,
#              ensuring session recovery information survives the compact operation.
# Usage: Called automatically by Claude Code before context compaction. Reads JSON from stdin.
# Dependencies: jq (preferred), python3 (fallback)
# Exit codes:
#   0 - Always (hooks must never fail)

# Navigate to project root
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
cd "$PROJECT_DIR"

# Read stdin (Claude Code sends JSON with trigger: manual/auto)
# shellcheck disable=SC2034  # INPUT is unused but stdin must be consumed
INPUT=$(cat)

# Read session mode from CURRENT_SESSION.md
read_session_mode() {
  local session_file="ai/session/CURRENT_SESSION.md"
  if [ -f "$session_file" ]; then
    grep '\*\*Mode:\*\*' "$session_file" 2>/dev/null | head -1 | sed 's/.*\*\*Mode:\*\* //' || echo "UNKNOWN"
  else
    echo "NO SESSION"
  fi
}

# Find active briefs and extract workflow state
find_active_briefs() {
  local briefs_dir="ai/briefs"
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

    local retries
    retries=$(grep '\*\*Retry Count:\*\*' "$brief_file" 2>/dev/null | head -1 | sed 's/.*\*\*Retry Count:\*\* //') || retries="0"

    local next_steps
    next_steps=$(grep -A1 '### Next Steps' "$brief_file" 2>/dev/null | tail -1 | sed 's/^[[:space:]]*//' | head -1) || next_steps="None"

    echo "Active Brief: ${brief_id} - ${title}"
    echo "Phase: ${phase} | Agent: ${agent} | Retries: ${retries}"
    echo "Next Steps: ${next_steps}"
    echo "Resume Point: ${brief_id} — ${title}"
  done
}

# Read blockers
read_blockers() {
  local blockers_file="ai/session/BLOCKERS.md"
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

# Build recovery context
build_recovery_context() {
  local mode
  mode=$(read_session_mode)

  local active_brief_info
  active_brief_info=$(find_active_briefs)

  local blockers
  blockers=$(read_blockers)

  local context="[IGRIS SESSION RECOVERY - Context was compacted]"
  context="${context}\nSession Mode: ${mode}"

  if [ -n "$active_brief_info" ]; then
    context="${context}\n${active_brief_info}"
  else
    context="${context}\nActive Brief: None"
  fi

  context="${context}\n${blockers}"
  context="${context}\n[/IGRIS SESSION RECOVERY]"

  echo "$context"
}

# Main execution
main() {
  local context
  context=$(build_recovery_context 2>/dev/null) || context="[IGRIS SESSION RECOVERY - Context was compacted]\nSession Mode: UNKNOWN\nActive Brief: None\nBlockers: None\n[/IGRIS SESSION RECOVERY]"

  # Output JSON with additionalContext
  if command -v jq &> /dev/null; then
    jq -n --arg ctx "$context" '{"additionalContext": $ctx}'
  else
    CONTEXT_DATA="$context" python3 -c "
import json, os
context = os.environ.get('CONTEXT_DATA', '')
print(json.dumps({'additionalContext': context}))
" 2>/dev/null || echo '{"additionalContext": "[IGRIS SESSION RECOVERY - Context was compacted]\nSession Mode: UNKNOWN\n[/IGRIS SESSION RECOVERY]"}'
  fi

  exit 0
}

# Run main, catch any unexpected errors
main "$@" 2>/dev/null || echo '{"additionalContext": "[IGRIS SESSION RECOVERY - Context was compacted]\nSession Mode: UNKNOWN\n[/IGRIS SESSION RECOVERY]"}'
exit 0
