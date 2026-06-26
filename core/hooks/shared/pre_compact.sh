#!/bin/bash

# Description: Portable PreCompact hook for multi-CLI lifecycle integration.
#              Captures critical Igris AI session state before context compaction,
#              ensuring session recovery information survives the compact operation.
# Usage: Invoked by a per-CLI bridge. Reads JSON from stdin.
#
# Input contract:
#   stdin (preferred): JSON object. Two shapes accepted:
#     Unified shape (from bridges):
#       { "source": "claude"|"opencode", "event": "pre_compact",
#         "project_dir": "...", "payload": {...} }
#     Native Claude shape:
#       { "trigger": "manual"|"auto", ... }
#   env fallback:
#     IGRIS_HOOK_SOURCE, IGRIS_HOOK_EVENT, IGRIS_PROJECT_DIR
#
# Dependencies: jq (preferred), python3 (fallback)
# Exit codes:
#   0 - Always (hooks must never fail)

set -e

# FR-212c: capture the gate-helper dir while cwd is still the invocation dir
# (the later `cd "$PROJECT_DIR"` would break a relative dirname). See _gate.sh.
_IGRIS_HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"

# shellcheck disable=SC2034  # INPUT is unused but stdin must be consumed
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

# ---------------------------------------------------------------------------
# FR-212c REGISTRATION GATE. PreCompact projects GLOBALLY. Outside a registered
# Igris project this hook MUST no-op: clean exit 0, NO side effects (no recovery
# context, no detached perception extractor). FAIL-OPEN-TO-NO-OP: a missing/
# locked brain DB resolves to not-registered -> clean exit.
# ---------------------------------------------------------------------------
if [ -n "$_IGRIS_HOOK_DIR" ] && [ -f "$_IGRIS_HOOK_DIR/_gate.sh" ]; then
  # shellcheck source=/dev/null
  . "$_IGRIS_HOOK_DIR/_gate.sh"
  if ! is_registered_igris_project "$PROJECT_DIR"; then
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Read session mode from CURRENT_SESSION.md
# ---------------------------------------------------------------------------
read_session_mode() {
  local slug
  slug=$(basename "$PROJECT_DIR")
  local session_file="$HOME/.igris/projects/$slug/session/CURRENT_SESSION.md"
  if [ -f "$session_file" ]; then
    grep '\*\*Mode:\*\*' "$session_file" 2>/dev/null | head -1 | sed 's/.*\*\*Mode:\*\* //' || echo "UNKNOWN"
  else
    echo "NO SESSION"
  fi
}

# ---------------------------------------------------------------------------
# Find active briefs and extract workflow state
# ---------------------------------------------------------------------------
find_active_briefs() {
  local slug
  slug=$(basename "$PROJECT_DIR")
  local briefs_dir="$HOME/.igris/projects/$slug/briefs"
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

# ---------------------------------------------------------------------------
# Read blockers
# ---------------------------------------------------------------------------
read_blockers() {
  local slug
  slug=$(basename "$PROJECT_DIR")
  local blockers_file="$HOME/.igris/projects/$slug/session/BLOCKERS.md"
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

# ---------------------------------------------------------------------------
# Build recovery context
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# Main execution
# ---------------------------------------------------------------------------
main() {
  local context
  context=$(build_recovery_context 2>/dev/null) || context="[IGRIS SESSION RECOVERY - Context was compacted]\nSession Mode: UNKNOWN\nActive Brief: None\nBlockers: None\n[/IGRIS SESSION RECOVERY]"

  if command -v jq &> /dev/null; then
    jq -n --arg ctx "$context" '{"additionalContext": $ctx}'
  else
    CONTEXT_DATA="$context" python3 -c "
import json, os
context = os.environ.get('CONTEXT_DATA', '')
print(json.dumps({'additionalContext': context}))
" 2>/dev/null || echo '{"additionalContext": "[IGRIS SESSION RECOVERY - Context was compacted]\nSession Mode: UNKNOWN\n[/IGRIS SESSION RECOVERY]"}'
  fi

  # TD-066 perception channel: spawn detached extractor so the parent session
  # exits immediately while LLM extraction runs in the background.
  # We forward INPUT (the original stdin payload) so the wrapper can locate
  # transcript_path the same way the parent hook did.
  if [ -x "$HOME/.igris/core/hooks/shared/perception_extract_and_persist.sh" ]; then
    local slug
    slug=$(basename "$PROJECT_DIR")
    printf '%s' "$INPUT" | nohup bash "$HOME/.igris/core/hooks/shared/perception_extract_and_persist.sh" "$slug" "pre_compact" >/dev/null 2>&1 & disown
  fi

  exit 0
}

main "$@" 2>/dev/null || echo '{"additionalContext": "[IGRIS SESSION RECOVERY - Context was compacted]\nSession Mode: UNKNOWN\n[/IGRIS SESSION RECOVERY]"}'
exit 0
