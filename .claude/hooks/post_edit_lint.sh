#!/bin/bash
set -e

# Description: PostToolUse hook for Write|Edit operations.
#              Runs shellcheck on .sh files after they are modified,
#              providing lint feedback as additionalContext to Claude.
# Usage: Called automatically by Claude Code after Write/Edit tool use. Reads JSON from stdin.
# Dependencies: shellcheck (optional - skips gracefully if not installed)
# Exit codes:
#   0 - Always (hooks must never fail)

# Navigate to project root
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
cd "$PROJECT_DIR"

# Read stdin (Claude Code sends JSON with tool_input)
INPUT=$(cat)

# Extract file_path from tool_input
extract_file_path() {
  if command -v jq &> /dev/null; then
    echo "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo ""
  else
    echo "$INPUT" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    print(data.get('tool_input', {}).get('file_path', ''))
except Exception:
    print('')
" 2>/dev/null || echo ""
  fi
}

# Run shellcheck and format results
run_lint() {
  local file_path="$1"

  # Only lint .sh files
  case "$file_path" in
    *.sh) ;;
    *) exit 0 ;;
  esac

  # Check if shellcheck is available
  if ! command -v shellcheck &> /dev/null; then
    exit 0
  fi

  # Check if file exists
  if [ ! -f "$file_path" ]; then
    exit 0
  fi

  # Run shellcheck with JSON output
  local lint_output
  lint_output=$(shellcheck --format=json1 "$file_path" 2>/dev/null) || true

  if [ -z "$lint_output" ]; then
    exit 0
  fi

  # Parse issues and build context string
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

  # Format issues into a readable context string
  local context
  if command -v jq &> /dev/null; then
    context=$(echo "$lint_output" | jq -r '
      "[SHELLCHECK LINT]\nFile: \(.file // "unknown")\nIssues: \(.comments | length)\n" +
      (.comments | map("  SC\(.code) (line \(.line)): \(.message)") | join("\n")) +
      "\n[/SHELLCHECK LINT]"
    ' 2>/dev/null) || context=""
  else
    context=$(echo "$lint_output" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    comments = data.get('comments', [])
    lines = ['[SHELLCHECK LINT]']
    lines.append(f'File: ${file_path}')
    lines.append(f'Issues: {len(comments)}')
    for c in comments:
        lines.append(f'  SC{c[\"code\"]} (line {c[\"line\"]}): {c[\"message\"]}')
    lines.append('[/SHELLCHECK LINT]')
    print('\n'.join(lines))
except Exception:
    pass
" 2>/dev/null) || context=""
  fi

  if [ -z "$context" ]; then
    exit 0
  fi

  # Output JSON with additionalContext
  if command -v jq &> /dev/null; then
    jq -n --arg ctx "$context" '{"additionalContext": $ctx}'
  else
    python3 -c "
import json
context = '''${context}'''
print(json.dumps({'additionalContext': context}))
" 2>/dev/null
  fi

  exit 0
}

# Main execution
main() {
  local file_path
  file_path=$(extract_file_path)

  if [ -z "$file_path" ]; then
    exit 0
  fi

  run_lint "$file_path"
}

# Run main, catch any unexpected errors
main "$@" 2>/dev/null || exit 0
