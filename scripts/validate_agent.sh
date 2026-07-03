#!/bin/bash
set -e

# Description: Validates an Igris AI agent definition file against v7 standards.
#              Checks required sections, prohibited patterns, and size. Agent
#              CONTEXT PROTOCOLs are self-contained (FR-187/FR-213): they state
#              how the agent loads its project context (usually via the
#              context-doc catalog), with no igris_tree.json reference.
# Usage: validate_agent.sh <agent_file.md>
# Exit codes:
#   0 - Validation passed
#   1 - Validation failed (details on stderr)

AGENT_FILE="${1:-}"

if [ -z "$AGENT_FILE" ] || [ ! -f "$AGENT_FILE" ]; then
  echo "Usage: validate_agent.sh <agent_file.md>" >&2
  exit 1
fi

ERRORS=0
WARNINGS=0
AGENT_NAME=$(basename "$AGENT_FILE" .md)

echo "Validating agent: $AGENT_NAME ($AGENT_FILE)"
echo "---"

# Helper: check if file contains a pattern
has_pattern() {
  grep -q "$1" "$AGENT_FILE" 2>/dev/null
}

# Helper: report error
fail() {
  echo "  FAIL: $1" >&2
  ERRORS=$((ERRORS + 1))
}

# Helper: report warning
warn() {
  echo "  WARN: $1" >&2
  WARNINGS=$((WARNINGS + 1))
}

# Helper: report pass
pass() {
  echo "  PASS: $1"
}

# 1. Required sections
for section in "CORE IDENTITY" "CONTEXT PROTOCOL" "CAPABILITIES" "WORKFLOW" "OUTPUT FORMAT" "CONSTRAINTS"; do
  if has_pattern "## $section"; then
    pass "Section '$section' present"
  else
    fail "Missing required section: '$section'"
  fi
done

# 2. Context protocol is self-contained (FR-187/FR-213): it must NOT reference
#    the retired routing tree. Agents state their own context-loading protocol.
if has_pattern "igris_tree.json"; then
  fail "Context protocol references the retired igris_tree.json (FR-187/FR-213: agents are self-contained — state the context-loading protocol directly)"
else
  pass "Context protocol does not reference the retired igris_tree.json"
fi

# 3. Prohibited patterns
if has_pattern "ai/prompts\|ai/context\|ai/briefs\|ai/session\|ai/masks"; then
  fail "Contains legacy ai/ path references"
else
  pass "No legacy ai/ path references"
fi

if has_pattern "Read.*igris_os\.md\|Load.*igris_os\.md"; then
  fail "Agent should not load igris_os.md (orchestrator-only)"
else
  pass "Does not load igris_os.md"
fi

if has_pattern "You are Claude\|As an AI"; then
  fail "Contains identity-breaking language (should use agent persona)"
else
  pass "No identity-breaking language"
fi

# 4. Frontmatter check
if head -1 "$AGENT_FILE" | grep -q "^---"; then
  pass "Frontmatter present"

  # Check required frontmatter fields
  FRONTMATTER=$(sed -n '1,/^---$/p' "$AGENT_FILE" | tail -n +2)
  for field in "name:" "description:" "tools:"; do
    if echo "$FRONTMATTER" | grep -q "$field"; then
      pass "Frontmatter field '$field' present"
    else
      fail "Missing frontmatter field: '$field'"
    fi
  done
else
  fail "Missing YAML frontmatter (---)"
fi

# 5. File size check (warn if > 10KB for non-sage agents, > 25KB for any)
FILE_SIZE=$(wc -c < "$AGENT_FILE" | tr -d ' ')
if [ "$FILE_SIZE" -gt 25000 ]; then
  fail "Agent file too large: ${FILE_SIZE} bytes (max 25KB)"
elif [ "$FILE_SIZE" -gt 10000 ] && [ "$AGENT_NAME" != "sage" ]; then
  warn "Agent file is ${FILE_SIZE} bytes (recommended < 10KB)"
else
  pass "File size OK: ${FILE_SIZE} bytes"
fi

# 6. "Do NOT need" directive check
if has_pattern "do NOT need\|do not need\|You do NOT need"; then
  pass "Explicit exclusion list present"
else
  warn "Consider adding 'You do NOT need: the os/ INDEX, SOUL.md, ...' directive"
fi

# Summary
echo "---"
echo "Results: $ERRORS error(s), $WARNINGS warning(s)"

if [ "$ERRORS" -gt 0 ]; then
  echo "VALIDATION FAILED" >&2
  exit 1
else
  echo "VALIDATION PASSED"
  exit 0
fi
