#!/bin/bash

# Description: Portable SessionStart hook for multi-CLI lifecycle integration.
#              Reads Igris AI session state and active briefs, then injects context
#              via additionalContext so the CLI resumes with full awareness.
#              Works with Claude Code, OpenCode, and Codex via unified input contract.
# Usage: Invoked by a per-CLI bridge. Reads JSON from stdin (or env vars on fallback).
#
# Input contract:
#   stdin (preferred): JSON object. Two shapes accepted:
#     Unified shape (from bridges):
#       {
#         "source": "claude" | "opencode" | "codex",
#         "event":  "session_start",
#         "project_dir": "/absolute/path",
#         "payload": { ... CLI-native fields ... }
#       }
#     Native Claude shape (backward compat):
#       { "source": "startup|resume|clear|compact", "session_id": "...", "cwd": "..." }
#   env fallback (when stdin empty/invalid):
#     IGRIS_HOOK_SOURCE, IGRIS_HOOK_EVENT, IGRIS_PROJECT_DIR
#
# Dependencies: jq (preferred), python3 (fallback)
# Exit codes:
#   0 - Always (hooks must never fail)

set -e

# ---------------------------------------------------------------------------
# Resolve project directory: payload.project_dir > env > CLAUDE_PROJECT_DIR > PWD
# ---------------------------------------------------------------------------
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
# Set the terminal tab title to the Igris project slug (FR-178).
# Slug = registered-project lookup in the brain DB by longest path-prefix
# match on PROJECT_DIR, falling back to basename (same posture as the
# statusline script). Best-effort: silent no-op when no writable tty is
# present (headless, CI, Codex/Gemini bridges).
# NEVER writes to stdout — hook stdout is the additionalContext JSON contract.
# ---------------------------------------------------------------------------
set_terminal_title() {
  # Guard: only attempt when /dev/tty looks writable. Note: on macOS the
  # device node is world-writable, so this can pass headless — the actual
  # open below is the authoritative (silenced) check.
  [ -w /dev/tty ] || return 0

  local slug=""
  local db="$HOME/.igris/memory/knowledge.db"
  if command -v sqlite3 > /dev/null 2>&1 && [ -f "$db" ]; then
    # Single-quote-escape the path for the SQL literal. Deliberately
    # UNQUOTED expansion: double-quoting keeps the \ escapes literal
    # (\'\') and corrupts the SQL. Assignments don't word-split, so this
    # is safe (same form as the statusline script).
    local esc
    esc=${PROJECT_DIR//\'/\'\'}
    slug=$(sqlite3 "$db" \
      "SELECT slug FROM projects WHERE '$esc' = path OR '$esc' LIKE path || '/%' ORDER BY length(path) DESC LIMIT 1;" 2>/dev/null) || slug=""
  fi
  [ -n "$slug" ] || slug=$(basename "$PROJECT_DIR" 2>/dev/null) || slug=""
  [ -n "$slug" ] || return 0

  # OSC 0 sets the icon name + window/tab title. Direct to the tty, never
  # stdout. Group redirection so a failed /dev/tty open is silenced too.
  { printf '\033]0;%s\007' "$slug" > /dev/tty; } 2>/dev/null || true
  return 0
}

# Fire on ALL session-start paths (startup/resume/clear/compact, every bridge).
# Must never fail the hook (set -e): the trailing '|| true' guarantees it.
set_terminal_title || true

# ---------------------------------------------------------------------------
# Parse 'source' field. Unified shape: top-level 'source'. Native Claude: top-level
# 'source' too. Native Claude sources: startup|resume|clear|compact.
# Bridges pass: "claude" | "opencode" | "codex".
# Sub-source (e.g. native Claude 'startup') is under payload.source when unified.
# ---------------------------------------------------------------------------
parse_source() {
  if [ -z "$INPUT" ]; then
    echo "${IGRIS_HOOK_SOURCE:-startup}"
    return
  fi
  if command -v jq &> /dev/null; then
    echo "$INPUT" | jq -r '.payload.source // .source // "startup"' 2>/dev/null || echo "startup"
  else
    echo "$INPUT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    p = d.get('payload') or {}
    print((p.get('source') if isinstance(p, dict) else None) or d.get('source') or 'startup')
except Exception:
    print('startup')
" 2>/dev/null || echo "startup"
  fi
}

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
# Find active briefs (Status: In Progress)
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

    local next_steps
    next_steps=$(grep -A1 '### Next Steps' "$brief_file" 2>/dev/null | tail -1 | sed 's/^[[:space:]]*//' | head -1) || next_steps="None"

    echo "Active Brief: ${brief_id} - ${title}"
    echo "Phase: ${phase} | Agent: ${agent}"
    echo "Next Steps: ${next_steps}"
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
# Build the additional context string
# ---------------------------------------------------------------------------
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

  # FR-202 M4 Unit A — auto-boot nudge. Append a directive cue that prompts the
  # model to run /awaken on a FRESH session only. A native-Claude resume, clear,
  # or compact already carries grounding, so re-awakening just churns — those are
  # excluded. Fresh-session sources:
  #   - "startup"  : native Claude fresh session.
  #   - "opencode" : the OpenCode bridge dispatches session_start ONLY on a fresh
  #                  session (session.created / first-seen session.updated|status),
  #                  so every value it passes here is a fresh session.
  # Codex (session_end only) and Antigravity (no session hook) never reach this
  # script, so Claude+OpenCode are the only harnesses that see the cue.
  # This is a NUDGE the model is expected to follow — NOT a guaranteed system
  # trigger; /awaken is a registered skill the model invokes in response.
  # The cue rides the SAME $context string both serialization branches in main()
  # consume, so jq and the python3 fallback emit it byte-identically by
  # construction. The existing [IGRIS SESSION STATE] block is preserved verbatim.
  case "$source" in
    startup | opencode)
      context="${context}\n[IGRIS AUTO-BOOT] Run /awaken to ground this session."
      ;;
  esac

  echo "$context"
}

# ---------------------------------------------------------------------------
# Main execution
# ---------------------------------------------------------------------------
main() {
  local context
  context=$(build_context 2>/dev/null) || context="[IGRIS SESSION STATE]\nMode: UNKNOWN\nActive Brief: None\nBlockers: None\n[/IGRIS SESSION STATE]"

  # Output JSON with additionalContext (Claude contract). Bridges may ignore.
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
