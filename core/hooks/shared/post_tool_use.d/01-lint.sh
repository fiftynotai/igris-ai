#!/bin/bash

# Description: PostToolUse handler (order: 01 — runs first).
#              Runs shellcheck on .sh files after they are modified, providing lint
#              feedback as additionalContext to the CLI (Claude reads additionalContext
#              natively; other CLIs ignore it).
# Usage: Invoked by the dispatcher `post_tool_use.sh`. Reads JSON from stdin.
#
# Input contract:
#   stdin (preferred): JSON object. Two shapes accepted:
#     Unified shape: { "payload": { "tool_input": { "file_path": "..." } } }
#     Claude native: { "tool_input": { "file_path": "..." } }
#   env fallback: IGRIS_FILE_PATH
#
# Dependencies: shellcheck (optional — skips gracefully if not installed)
# Exit codes:
#   0 - Always (hooks must never fail)

set -e

# Navigate to project root
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-${IGRIS_PROJECT_DIR:-$PWD}}"
cd "$PROJECT_DIR"

INPUT=$(cat 2>/dev/null || true)

extract_file_path() {
  if [ -z "$INPUT" ]; then
    echo "${IGRIS_FILE_PATH:-}"
    return
  fi
  if command -v jq &> /dev/null; then
    echo "$INPUT" | jq -r '.payload.tool_input.file_path // .tool_input.file_path // ""' 2>/dev/null || echo ""
  else
    echo "$INPUT" | python3 -c "
import json, sys, os
try:
    data = json.load(sys.stdin)
    p = data.get('payload') or {}
    tool_input = p.get('tool_input') if isinstance(p, dict) else None
    if not tool_input:
        tool_input = data.get('tool_input')
    if isinstance(tool_input, dict):
        print(tool_input.get('file_path', ''))
    else:
        print(os.environ.get('IGRIS_FILE_PATH', ''))
except Exception:
    print(os.environ.get('IGRIS_FILE_PATH', ''))
" 2>/dev/null || echo "${IGRIS_FILE_PATH:-}"
  fi
}

run_lint() {
  local file_path="$1"

  case "$file_path" in
    *.sh) ;;
    *) exit 0 ;;
  esac

  if ! command -v shellcheck &> /dev/null; then
    exit 0
  fi

  if [ ! -f "$file_path" ]; then
    exit 0
  fi

  local lint_output
  lint_output=$(shellcheck --format=json1 "$file_path" 2>/dev/null) || true

  if [ -z "$lint_output" ]; then
    exit 0
  fi

  local issue_count
  if command -v jq &> /dev/null; then
    issue_count=$(echo "$lint_output" | jq '.comments | length' 2>/dev/null) || issue_count=0
  else
    issue_count=$(echo "$lint_output" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    print(len(data.get('comments', [])))
except Exception:
    print(0)
" 2>/dev/null) || issue_count=0
  fi

  if [ "$issue_count" -eq 0 ] || [ "$issue_count" = "0" ]; then
    exit 0
  fi

  local context
  if command -v jq &> /dev/null; then
    context=$(echo "$lint_output" | jq -r '
      "[SHELLCHECK LINT]\nFile: \(.file // "unknown")\nIssues: \(.comments | length)\n" +
      (.comments | map("  SC\(.code) (line \(.line)): \(.message)") | join("\n")) +
      "\n[/SHELLCHECK LINT]"
    ' 2>/dev/null) || context=""
  else
    context=$(FILE_PATH="$file_path" python3 -c "
import json, sys, os
try:
    data = json.load(sys.stdin)
    comments = data.get('comments', [])
    fp = os.environ.get('FILE_PATH', 'unknown')
    lines = ['[SHELLCHECK LINT]']
    lines.append(f'File: {fp}')
    lines.append(f'Issues: {len(comments)}')
    for c in comments:
        lines.append(f'  SC{c[\"code\"]} (line {c[\"line\"]}): {c[\"message\"]}')
    lines.append('[/SHELLCHECK LINT]')
    print('\n'.join(lines))
except Exception:
    pass
" <<< "$lint_output" 2>/dev/null) || context=""
  fi

  if [ -z "$context" ]; then
    exit 0
  fi

  if command -v jq &> /dev/null; then
    jq -n --arg ctx "$context" '{"additionalContext": $ctx}'
  else
    CONTEXT_DATA="$context" python3 -c "
import json, os
context = os.environ.get('CONTEXT_DATA', '')
print(json.dumps({'additionalContext': context}))
" 2>/dev/null
  fi

  exit 0
}

main() {
  local file_path
  file_path=$(extract_file_path)

  if [ -z "$file_path" ]; then
    exit 0
  fi

  run_lint "$file_path"
}

main "$@" 2>/dev/null || exit 0
