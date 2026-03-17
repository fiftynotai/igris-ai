#!/bin/bash
set -e

# Description: Verifies that an Igris AI v6 installation is complete and healthy.
#              Checks core files, symlinks, and structure against v6 requirements.
# Usage: v6_verify.sh [project_directory]
#        If no directory is given, uses the current working directory.
# Exit codes:
#   0 - All checks passed (v6 OK)
#   1 - One or more checks failed (v6 FAIL)

BRAIN_DIR="$HOME/.igris"
PROJECT_DIR="${1:-.}"

# Resolve to absolute path
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"

PASS_COUNT=0
FAIL_COUNT=0

# Helper: report pass
pass() {
  echo "  PASS: $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

# Helper: report fail
fail() {
  echo "  FAIL: $1" >&2
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

echo "Igris v6 Verification"
echo "Brain: $BRAIN_DIR"
echo "Project: $PROJECT_DIR"
echo "---"

# --------------------------------------------------------------------------
# Check 1: ~/.igris/core/igris_tree.json exists and is valid JSON
# --------------------------------------------------------------------------
echo ""
echo "[1/5] Context tree"

TREE_FILE="$BRAIN_DIR/core/igris_tree.json"

if [ ! -f "$TREE_FILE" ]; then
  fail "$TREE_FILE does not exist"
else
  if python3 -c "import json; json.load(open('$TREE_FILE'))" 2>/dev/null; then
    pass "$TREE_FILE exists and is valid JSON"
  else
    fail "$TREE_FILE exists but is not valid JSON"
  fi
fi

# --------------------------------------------------------------------------
# Check 2: CLAUDE.md exists and is < 5KB (no @imports bloat)
# --------------------------------------------------------------------------
echo ""
echo "[2/5] CLAUDE.md size"

CLAUDE_FILE="$PROJECT_DIR/CLAUDE.md"

if [ ! -f "$CLAUDE_FILE" ]; then
  fail "CLAUDE.md not found in $PROJECT_DIR"
else
  FILE_SIZE=$(wc -c < "$CLAUDE_FILE" | tr -d ' ')
  MAX_SIZE=5120  # 5KB

  if [ "$FILE_SIZE" -lt "$MAX_SIZE" ]; then
    pass "CLAUDE.md is ${FILE_SIZE} bytes (< 5KB, no @imports bloat)"
  else
    fail "CLAUDE.md is ${FILE_SIZE} bytes (>= 5KB, likely has @imports bloat)"
  fi
fi

# --------------------------------------------------------------------------
# Check 3: .claude/agents/ symlinks exist and point to ~/.igris/core/agents/
# --------------------------------------------------------------------------
echo ""
echo "[3/5] Agent symlinks"

AGENTS_DIR="$PROJECT_DIR/.claude/agents"

if [ ! -d "$AGENTS_DIR" ]; then
  fail ".claude/agents/ directory does not exist"
else
  agent_count=0
  agent_ok=0
  agent_bad=0

  for agent_file in "$AGENTS_DIR"/*.md; do
    [ -e "$agent_file" ] || continue
    agent_count=$((agent_count + 1))

    if [ -L "$agent_file" ]; then
      link_target=$(readlink "$agent_file")
      # Check if the symlink target contains the expected brain agents path
      if echo "$link_target" | grep -q "\.igris/core/agents/"; then
        agent_ok=$((agent_ok + 1))
      else
        fail "$(basename "$agent_file") symlink points to unexpected target: $link_target"
        agent_bad=$((agent_bad + 1))
      fi
    else
      fail "$(basename "$agent_file") is not a symlink (should point to ~/.igris/core/agents/)"
      agent_bad=$((agent_bad + 1))
    fi
  done

  if [ "$agent_count" -eq 0 ]; then
    fail "No agent files found in .claude/agents/"
  elif [ "$agent_bad" -eq 0 ]; then
    pass "$agent_ok agent(s) symlinked to ~/.igris/core/agents/"
  fi
fi

# --------------------------------------------------------------------------
# Check 4: .claude/rules/00-igris-universal.md symlink exists
# --------------------------------------------------------------------------
echo ""
echo "[4/5] Universal rule symlink"

RULE_FILE="$PROJECT_DIR/.claude/rules/00-igris-universal.md"

if [ ! -e "$RULE_FILE" ]; then
  fail ".claude/rules/00-igris-universal.md does not exist"
elif [ -L "$RULE_FILE" ]; then
  link_target=$(readlink "$RULE_FILE")
  if echo "$link_target" | grep -q "\.igris/core/rules/"; then
    pass "00-igris-universal.md symlinked to ~/.igris/core/rules/"
  else
    fail "00-igris-universal.md symlink points to unexpected target: $link_target"
  fi
else
  fail "00-igris-universal.md exists but is not a symlink"
fi

# --------------------------------------------------------------------------
# Check 5: .claude/skills/ has 15+ symlinked skill directories
# --------------------------------------------------------------------------
echo ""
echo "[5/5] Skill symlinks"

SKILLS_DIR="$PROJECT_DIR/.claude/skills"

if [ ! -d "$SKILLS_DIR" ]; then
  fail ".claude/skills/ directory does not exist"
else
  skill_count=0
  skill_ok=0

  for skill_dir in "$SKILLS_DIR"/*/; do
    [ -d "$skill_dir" ] || continue
    skill_count=$((skill_count + 1))

    if [ -L "${skill_dir%/}" ]; then
      skill_ok=$((skill_ok + 1))
    fi
  done

  if [ "$skill_count" -ge 15 ]; then
    pass "$skill_count skill directories found ($skill_ok symlinked) (>= 15 required)"
  else
    fail "Only $skill_count skill directories found (>= 15 required)"
  fi
fi

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
echo ""
echo "---"
TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed (of $TOTAL checks)"
echo ""

if [ "$FAIL_COUNT" -eq 0 ]; then
  echo "v6 OK"
  exit 0
else
  echo "v6 FAIL: $FAIL_COUNT check(s) failed" >&2
  exit 1
fi
