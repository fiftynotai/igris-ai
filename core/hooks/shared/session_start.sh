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

# FR-212c: capture the gate-helper dir while cwd is still the invocation dir
# (the later `cd "$PROJECT_DIR"` would break a relative dirname). See _gate.sh.
_IGRIS_HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"

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
# TD-359: ONE slug for this hook, resolved once by `igris_resolve_project`
# (_gate.sh): marker, then the git main checkout, then the registry walk on the
# worktree-translated path, then basename(main), then basename(dir) — so a git
# worktree names its main checkout's project. _gate.sh only DEFINES functions,
# so sourcing it here (above the gate) changes nothing else. basename is the
# last resort only when _gate.sh is absent. The gate below re-confirms the slug
# for a registered project; every reader under it uses $IGRIS_SLUG.
# ---------------------------------------------------------------------------
if [ -n "$_IGRIS_HOOK_DIR" ] && [ -f "$_IGRIS_HOOK_DIR/_gate.sh" ]; then
  # shellcheck source=/dev/null
  . "$_IGRIS_HOOK_DIR/_gate.sh"
fi
IGRIS_SLUG=""
if type igris_resolve_project >/dev/null 2>&1; then
  igris_resolve_project "$PROJECT_DIR"
  IGRIS_SLUG="$_IGRIS_RES_SLUG"
fi
if [ -z "$IGRIS_SLUG" ]; then
  IGRIS_SLUG=$(basename "$PROJECT_DIR" 2>/dev/null) || IGRIS_SLUG=""  # TD-359 last-resort
fi

# ---------------------------------------------------------------------------
# Set the terminal tab title to the Igris project slug (FR-178): the resolved
# $IGRIS_SLUG above (registered or not — the title is cosmetic, so it names
# ANY project tab). Best-effort: silent no-op when no writable tty is
# present (headless, CI, Codex/Gemini bridges).
# NEVER writes to stdout — hook stdout is the additionalContext JSON contract.
# ---------------------------------------------------------------------------
set_terminal_title() {
  # Guard: only attempt when /dev/tty looks writable. Note: on macOS the
  # device node is world-writable, so this can pass headless — the actual
  # open below is the authoritative (silenced) check.
  [ -w /dev/tty ] || return 0
  [ -n "$IGRIS_SLUG" ] || return 0

  # OSC 0 sets the icon name + window/tab title. Direct to the tty, never
  # stdout. Group redirection so a failed /dev/tty open is silenced too.
  { printf '\033]0;%s\007' "$IGRIS_SLUG" > /dev/tty; } 2>/dev/null || true
  return 0
}

# Fire on ALL session-start paths (startup/resume/clear/compact, every bridge).
# Must never fail the hook (set -e): the trailing '|| true' guarantees it.
set_terminal_title || true

# ---------------------------------------------------------------------------
# FR-212c REGISTRATION GATE. SessionStart projects GLOBALLY (one
# ~/.claude/settings.json block fires it in EVERY project on the machine).
# Outside a registered Igris project this hook MUST no-op the CONTEXT INJECTION:
# emit an empty additionalContext and skip the [IGRIS SESSION STATE] block + the
# [IGRIS AUTO-BOOT] /boot nudge (injecting Igris context / nudging /boot inside
# someone else's repo is the misfire this gate prevents). FAIL-OPEN-TO-NO-OP: a
# missing/locked brain DB resolves to not-registered -> empty context (never an
# Igris nudge in a non-Igris project).
#
# Placed AFTER set_terminal_title (FR-178): the tab title is a harmless cosmetic
# that should still name the project tab (the resolved slug) for ANY harness —
# only the Igris CONTEXT/nudge is gated on registration.
# ---------------------------------------------------------------------------
if [ -n "$_IGRIS_HOOK_DIR" ] && [ -f "$_IGRIS_HOOK_DIR/_gate.sh" ]; then
  # _gate.sh was sourced above (same condition).
  if ! is_registered_igris_project "$PROJECT_DIR"; then
    if command -v jq &> /dev/null; then
      jq -n '{"additionalContext": ""}'
    else
      echo '{"additionalContext": ""}'
    fi
    exit 0
  fi
  IGRIS_SLUG="$_GATE_RESOLVED_SLUG"
fi

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
  local session_file="$HOME/.igris/projects/$IGRIS_SLUG/session/CURRENT_SESSION.md"
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
  local briefs_dir="$HOME/.igris/projects/$IGRIS_SLUG/briefs"
  if [ ! -d "$briefs_dir" ]; then
    return
  fi

  local active_files
  active_files=$(grep -rl '^\*\*Status:\*\* In Progress' "$briefs_dir" 2>/dev/null | head -5) || true

  for brief_file in $active_files; do
    local brief_id
    # `FR-003e.md` is the sub-brief FR-003e, not FR-003 (one letter — TD-468).
    brief_id=$(basename "$brief_file" | sed 's/\.md$//' | grep -oE '^[A-Z]+-[0-9]+[a-z]?' 2>/dev/null) || continue

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
  local blockers_file="$HOME/.igris/projects/$IGRIS_SLUG/session/BLOCKERS.md"
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
  # model to run /boot on a FRESH session only. A native-Claude resume, clear,
  # or compact already carries grounding, so re-booting just churns — those are
  # excluded. Fresh-session sources:
  #   - "startup"  : native Claude fresh session.
  #   - "opencode" : the OpenCode bridge dispatches session_start ONLY on a fresh
  #                  session (session.created / first-seen session.updated|status),
  #                  so every value it passes here is a fresh session.
  # Codex (session_end only) and Antigravity (no session hook) never reach this
  # script, so Claude+OpenCode are the only harnesses that see the cue.
  # This is a NUDGE the model is expected to follow — NOT a guaranteed system
  # trigger; /boot is a registered skill the model invokes in response.
  # The cue rides the SAME $context string both serialization branches in main()
  # consume, so jq and the python3 fallback emit it byte-identically by
  # construction. The existing [IGRIS SESSION STATE] block is preserved verbatim.
  case "$source" in
    startup | opencode)
      context="${context}\n[IGRIS AUTO-BOOT] Run /boot to ground this session."
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
