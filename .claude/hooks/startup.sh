#!/bin/bash
# Igris AI - Startup Hook
# Automatically runs when Claude Code CLI starts
# Shows welcome message and project summary before any user input

# Check for Igris persona (full mask)
PERSONA_ACTIVE="false"
if [ -f "ai/persona.json" ] && command -v jq &> /dev/null; then
  PERSONA_NAME=$(jq -r '.persona // "none"' ai/persona.json 2>/dev/null)
  MASK_LEVEL=$(jq -r '.mask // "none"' ai/persona.json 2>/dev/null)

  if [ "$PERSONA_NAME" = "igris" ] && [ "$MASK_LEVEL" = "full" ]; then
    PERSONA_ACTIVE="true"
  fi
fi

# Show greeting based on persona
if [ "$PERSONA_ACTIVE" = "true" ]; then
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "    ⚔️  THE SHADOW RISES  ⚔️"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "Monarch, your shadow knight stands ready."
  echo ""
else
  echo "🚀 Welcome to Igris AI on Claude Code"
  echo ""
fi

# Check if Igris AI is fully initialized
if [ ! -f "ai/prompts/igris_os.md" ]; then
  echo "⚠️  Igris AI not fully initialized"
  echo "   Run initialization script to complete setup"
  echo ""
  exit 0
fi

echo "📊 Project Status"
echo "────────────────"

# Count briefs by type
BR_COUNT=$(find ai/briefs -name "BR-*.md" ! -name "*TEMPLATE*" 2>/dev/null | wc -l | tr -d ' ')
MG_COUNT=$(find ai/briefs -name "MG-*.md" ! -name "*TEMPLATE*" 2>/dev/null | wc -l | tr -d ' ')
TD_COUNT=$(find ai/briefs -name "TD-*.md" ! -name "*TEMPLATE*" 2>/dev/null | wc -l | tr -d ' ')
TS_COUNT=$(find ai/briefs -name "TS-*.md" ! -name "*TEMPLATE*" 2>/dev/null | wc -l | tr -d ' ')
TOTAL=$((BR_COUNT + MG_COUNT + TD_COUNT + TS_COUNT))

if [ "$TOTAL" -eq 0 ]; then
  echo "Briefs: None yet (ready for first task)"
else
  echo "Briefs: $TOTAL total ($BR_COUNT BR, $MG_COUNT MG, $TD_COUNT TD, $TS_COUNT TS)"
fi

# Count by status (grep for "Status:" in brief files)
if [ "$TOTAL" -gt 0 ]; then
  READY_COUNT=$(find ai/briefs -name "*.md" ! -name "*TEMPLATE*" -exec grep -l "^Status: Ready" {} \; 2>/dev/null | wc -l | tr -d ' ')
  IN_PROGRESS_COUNT=$(find ai/briefs -name "*.md" ! -name "*TEMPLATE*" -exec grep -l "^Status: In Progress" {} \; 2>/dev/null | wc -l | tr -d ' ')
  DONE_COUNT=$(find ai/briefs -name "*.md" ! -name "*TEMPLATE*" -exec grep -l "^Status: Done" {} \; 2>/dev/null | wc -l | tr -d ' ')

  echo "Status: $READY_COUNT Ready, $IN_PROGRESS_COUNT In Progress, $DONE_COUNT Done"
fi

# Count blockers (lines starting with ## in BLOCKERS.md, excluding the header)
BLOCKER_COUNT="0"
if [ -f "ai/session/BLOCKERS.md" ]; then
  BLOCKER_COUNT=$(grep "^## " ai/session/BLOCKERS.md 2>/dev/null | wc -l | tr -d ' ' || echo "0")
fi
echo "Blockers: $BLOCKER_COUNT"

echo ""

# Find highest priority ready brief
if [ "$TOTAL" -gt 0 ] && [ "${READY_COUNT:-0}" -gt 0 ]; then
  # Find P0 briefs first
  P0_BRIEF=$(find ai/briefs -name "*.md" ! -name "*TEMPLATE*" -exec grep -l "^Priority: P0" {} \; 2>/dev/null | head -1)

  if [ -n "$P0_BRIEF" ]; then
    # Check if it's Ready
    if grep -q "^Status: Ready" "$P0_BRIEF" 2>/dev/null; then
      BRIEF_TITLE=$(grep "^# " "$P0_BRIEF" 2>/dev/null | head -1 | sed 's/^# //')
      echo "💡 Recommended Next Task:"
      echo "   $BRIEF_TITLE (P0 - Critical)"
      echo ""
    fi
  else
    # Try P1 briefs
    P1_BRIEF=$(find ai/briefs -name "*.md" ! -name "*TEMPLATE*" -exec grep -l "^Priority: P1" {} \; 2>/dev/null | head -1)

    if [ -n "$P1_BRIEF" ] && grep -q "^Status: Ready" "$P1_BRIEF" 2>/dev/null; then
      BRIEF_TITLE=$(grep "^# " "$P1_BRIEF" 2>/dev/null | head -1 | sed 's/^# //')
      echo "💡 Recommended Next Task:"
      echo "   $BRIEF_TITLE (P1 - High)"
      echo ""
    else
      # Just show any Ready brief
      READY_BRIEF=$(find ai/briefs -name "*.md" ! -name "*TEMPLATE*" -exec grep -l "^Status: Ready" {} \; 2>/dev/null | head -1)
      if [ -n "$READY_BRIEF" ]; then
        BRIEF_TITLE=$(grep "^# " "$READY_BRIEF" 2>/dev/null | head -1 | sed 's/^# //')
        echo "💡 Recommended Next Task:"
        echo "   $BRIEF_TITLE"
        echo ""
      fi
    fi
  fi
fi

echo "Ready for your command!"
echo ""
