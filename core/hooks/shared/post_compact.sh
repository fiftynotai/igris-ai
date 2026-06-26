#!/bin/bash

# Description: Portable PostCompact hook for multi-CLI lifecycle integration.
#              Logs compaction completion to the per-project compact log.
#              OpenCode fires `session.compacted`; Claude has no native equivalent
#              (as of this writing — Claude handles only PreCompact). Bridges may
#              choose to invoke this after their own compaction pipeline completes.
# Usage: Invoked by a per-CLI bridge. Reads JSON from stdin.
#
# Input contract:
#   stdin (preferred): JSON object. Accepted shape:
#     { "source": "claude"|"opencode", "event": "post_compact",
#       "project_dir": "...", "payload": {...} }
#   env fallback:
#     IGRIS_HOOK_SOURCE, IGRIS_HOOK_EVENT, IGRIS_PROJECT_DIR
#
# Dependencies: python3 (optional, for structured JSON parsing)
# Exit codes:
#   0 - Always (hooks must never fail)

set -e

# FR-212c: capture the gate-helper dir at the top (before main()) so the
# registration gate resolves `_gate.sh` regardless of relative invocation.
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

parse_source() {
  if [ -z "$INPUT" ]; then
    echo "${IGRIS_HOOK_SOURCE:-unknown}"
    return
  fi
  if command -v jq &> /dev/null; then
    echo "$INPUT" | jq -r '.source // "unknown"' 2>/dev/null || echo "unknown"
  else
    echo "$INPUT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get('source') or 'unknown')
except Exception:
    print('unknown')
" 2>/dev/null || echo "unknown"
  fi
}

main() {
  local project_dir
  project_dir=$(resolve_project_dir)

  # -------------------------------------------------------------------------
  # FR-212c REGISTRATION GATE. PostCompact projects GLOBALLY. Outside a
  # registered Igris project this hook MUST no-op: clean exit 0, NO side effects
  # (no compact.log write under ~/.igris/projects/<basename>). FAIL-OPEN-TO-
  # NO-OP: a missing/locked brain DB resolves to not-registered -> clean exit.
  # -------------------------------------------------------------------------
  if [ -n "$_IGRIS_HOOK_DIR" ] && [ -f "$_IGRIS_HOOK_DIR/_gate.sh" ]; then
    # shellcheck source=/dev/null
    . "$_IGRIS_HOOK_DIR/_gate.sh"
    if ! is_registered_igris_project "$project_dir"; then
      exit 0
    fi
  fi

  local source
  source=$(parse_source)

  local slug
  slug=$(basename "$project_dir")
  local log_dir="$HOME/.igris/projects/$slug/session"
  local log_file="$log_dir/compact.log"

  mkdir -p "$log_dir" 2>/dev/null || true

  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  echo "${timestamp} event=post_compact source=${source} project=${slug}" >> "$log_file" 2>/dev/null || true

  exit 0
}

main "$@" 2>/dev/null || true
exit 0
