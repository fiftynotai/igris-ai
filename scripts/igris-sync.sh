#!/bin/bash
# Description: SessionEnd hook — captures session learnings to brain staging
# Usage: Called automatically by Claude Code SessionEnd hook
# Dependencies: python3
# Exit codes: 0 always (hooks should never fail the session)

BRAIN_DIR="$HOME/.igris"

# Exit silently if brain not installed
[ -d "$BRAIN_DIR" ] || exit 0

# Determine project slug
PROJECT_SLUG=$(basename "$(pwd)")
STAGING_DIR="$BRAIN_DIR/staging/$PROJECT_SLUG"
mkdir -p "$STAGING_DIR"

TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
UUID=$(python3 -c "import uuid; print(uuid.uuid4().hex[:8])" 2>/dev/null || echo "$$")

# Capture learnings from LEARNINGS.md if it has content
if [ -f "ai/session/LEARNINGS.md" ]; then
  CONTENT=$(cat "ai/session/LEARNINGS.md")
  if [ "$CONTENT" != "$(cat <<'EOF'
# Learnings & Patterns

**Last Updated:** N/A

---

[No learnings recorded yet]
EOF
)" ]; then
    # Has real content — stage it
    python3 -c "
import json, sys
content = sys.stdin.read()
data = {
    'type': 'learning_file',
    'project': sys.argv[1],
    'source': 'LEARNINGS.md',
    'content': content,
    'timestamp': sys.argv[2]
}
print(json.dumps(data))
" "$PROJECT_SLUG" "$TIMESTAMP" < "ai/session/LEARNINGS.md" > "$STAGING_DIR/${TIMESTAMP}-${UUID}-learnings.json" 2>/dev/null
  fi
fi

# Capture decisions from DECISIONS.md if it has content
if [ -f "ai/session/DECISIONS.md" ]; then
  CONTENT=$(cat "ai/session/DECISIONS.md")
  if [ "$CONTENT" != "$(cat <<'EOF'
# Architectural Decisions

**Last Updated:** N/A

---

[No decisions recorded yet]
EOF
)" ]; then
    python3 -c "
import json, sys
content = sys.stdin.read()
data = {
    'type': 'decision_file',
    'project': sys.argv[1],
    'source': 'DECISIONS.md',
    'content': content,
    'timestamp': sys.argv[2]
}
print(json.dumps(data))
" "$PROJECT_SLUG" "$TIMESTAMP" < "ai/session/DECISIONS.md" > "$STAGING_DIR/${TIMESTAMP}-${UUID}-decisions.json" 2>/dev/null
  fi
fi

exit 0
