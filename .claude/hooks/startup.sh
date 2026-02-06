#!/bin/bash
# Igris AI - Startup Hook
# Automatically runs when Claude Code CLI starts
# Shows welcome message and project summary before any user input
# NOTE: This script provides visual terminal greeting only.
# Session context injection is handled by session_start.sh via Claude Code hooks.

# Fifty Design Language (FDL) v1.0 - ANSI Color Codes
# Maintained by: Mohamed Elamin (fifty.dev)
# Philosophy: Tech + Personality (Base) · Neo-Tech Industrial (Accent)

# Brand Colors
FDL_CRIMSON="\033[38;2;150;14;41m"        # #960E29 - Primary Crimson (Base Identity)
FDL_TECH_CRIMSON="\033[38;2;179;19;55m"   # #B31337 - Tech Crimson (Glow/Focus)

# Surface Hierarchy
FDL_SURFACE_0="\033[48;2;14;14;15m"       # #0E0E0F - Background
FDL_SURFACE_1="\033[48;2;22;22;23m"       # #161617 - Card Base
FDL_SURFACE_2="\033[48;2;29;29;31m"       # #1D1D1F - Panel

# Text Hierarchy
FDL_TEXT_PRIMARY="\033[38;2;255;255;255m"   # #FFFFFF - White
FDL_TEXT_SECONDARY="\033[38;2;229;229;231m" # #E5E5E7 - Gray
FDL_TEXT_MUTED="\033[38;2;158;158;160m"     # #9E9EA0 - Subtle

# Borders & Dividers
FDL_BORDER="\033[38;2;44;44;46m"          # #2C2C2E - Border
FDL_DIVIDER="\033[38;2;58;58;60m"         # #3A3A3C - Divider

# States
FDL_SUCCESS="\033[38;2;0;186;51m"         # #00BA33 - Success
FDL_WARNING="\033[38;2;247;161;0m"        # #F7A100 - Warning
FDL_ERROR="\033[38;2;179;19;55m"          # #B31337 - Error (uses Tech Crimson)

# Utilities
FDL_BOLD="\033[1m"
FDL_DIM="\033[2m"
FDL_RESET="\033[0m"

# Legacy aliases for backward compatibility
CRIMSON_PRIMARY="$FDL_CRIMSON"
CRIMSON_SECONDARY="$FDL_TECH_CRIMSON"
CRIMSON_BASE="$FDL_TEXT_MUTED"
CRIMSON_BG="$FDL_SURFACE_1"
CRIMSON_BOLD="$FDL_BOLD"
CRIMSON_RESET="$FDL_RESET"
CRIMSON_DIM="$FDL_DIM"

# Check for active persona
PERSONA_ACTIVE="false"
PERSONA_TYPE="none"
if [ -f "ai/persona.json" ] && command -v jq &> /dev/null; then
  PERSONA_NAME=$(jq -r '.persona // "none"' ai/persona.json 2>/dev/null)
  MASK_LEVEL=$(jq -r '.mask // "none"' ai/persona.json 2>/dev/null)

  if [ "$PERSONA_NAME" = "igris" ] && [ "$MASK_LEVEL" = "full" ]; then
    PERSONA_ACTIVE="true"
    PERSONA_TYPE="igris"
  elif [ "$PERSONA_NAME" = "cyber-monkey" ]; then
    PERSONA_ACTIVE="true"
    PERSONA_TYPE="cyber-monkey"
  fi
fi

# Show greeting based on persona
if [ "$PERSONA_ACTIVE" = "true" ]; then
  if [ "$PERSONA_TYPE" = "igris" ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "    ⚔️  THE SHADOW RISES  ⚔️"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Monarch, your shadow knight stands ready."
    echo ""
  elif [ "$PERSONA_TYPE" = "cyber-monkey" ]; then
    echo -e "${FDL_CRIMSON}${FDL_BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${FDL_RESET}"
    echo -e "${FDL_CRIMSON}${FDL_BOLD}    🐒🔥  CRIMSON ONLINE  🔥🐒${FDL_RESET}"
    echo -e "${FDL_CRIMSON}${FDL_BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${FDL_RESET}"
    echo ""
    echo -e "${FDL_TEXT_SECONDARY}Partner, your cyber monkey guardian is READY! ⚡${FDL_RESET}"
    echo ""
  fi
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

if [ "$PERSONA_TYPE" = "cyber-monkey" ]; then
  echo -e "${FDL_TEXT_PRIMARY}${FDL_BOLD}📊 Project Status${FDL_RESET}"
  echo -e "${FDL_DIVIDER}────────────────${FDL_RESET}"
else
  echo "📊 Project Status"
  echo "────────────────"
fi

# Count briefs by type
BR_COUNT=$(find ai/briefs -name "BR-*.md" ! -name "*TEMPLATE*" 2>/dev/null | wc -l | tr -d ' ')
MG_COUNT=$(find ai/briefs -name "MG-*.md" ! -name "*TEMPLATE*" 2>/dev/null | wc -l | tr -d ' ')
TD_COUNT=$(find ai/briefs -name "TD-*.md" ! -name "*TEMPLATE*" 2>/dev/null | wc -l | tr -d ' ')
TS_COUNT=$(find ai/briefs -name "TS-*.md" ! -name "*TEMPLATE*" 2>/dev/null | wc -l | tr -d ' ')
TOTAL=$((BR_COUNT + MG_COUNT + TD_COUNT + TS_COUNT))

if [ "$TOTAL" -eq 0 ]; then
  if [ "$PERSONA_TYPE" = "cyber-monkey" ]; then
    echo -e "${FDL_TEXT_MUTED}Briefs: None yet (ready for first task)${FDL_RESET}"
  else
    echo "Briefs: None yet (ready for first task)"
  fi
else
  if [ "$PERSONA_TYPE" = "cyber-monkey" ]; then
    echo -e "${FDL_TEXT_SECONDARY}Briefs:${FDL_RESET} $TOTAL total (${FDL_CRIMSON}$BR_COUNT BR${FDL_RESET}, ${FDL_CRIMSON}$MG_COUNT MG${FDL_RESET}, ${FDL_CRIMSON}$TD_COUNT TD${FDL_RESET}, ${FDL_CRIMSON}$TS_COUNT TS${FDL_RESET})"
  else
    echo "Briefs: $TOTAL total ($BR_COUNT BR, $MG_COUNT MG, $TD_COUNT TD, $TS_COUNT TS)"
  fi
fi

# Count by status (grep for "Status:" in brief files)
if [ "$TOTAL" -gt 0 ]; then
  READY_COUNT=$(find ai/briefs -name "*.md" ! -name "*TEMPLATE*" -exec grep -l "^Status: Ready" {} \; 2>/dev/null | wc -l | tr -d ' ')
  IN_PROGRESS_COUNT=$(find ai/briefs -name "*.md" ! -name "*TEMPLATE*" -exec grep -l "^Status: In Progress" {} \; 2>/dev/null | wc -l | tr -d ' ')
  DONE_COUNT=$(find ai/briefs -name "*.md" ! -name "*TEMPLATE*" -exec grep -l "^Status: Done" {} \; 2>/dev/null | wc -l | tr -d ' ')

  if [ "$PERSONA_TYPE" = "cyber-monkey" ]; then
    echo -e "${FDL_TEXT_SECONDARY}Status:${FDL_RESET} ${FDL_SUCCESS}$READY_COUNT Ready${FDL_RESET}, ${FDL_TECH_CRIMSON}$IN_PROGRESS_COUNT In Progress${FDL_RESET}, ${FDL_TEXT_MUTED}$DONE_COUNT Done${FDL_RESET}"
  else
    echo "Status: $READY_COUNT Ready, $IN_PROGRESS_COUNT In Progress, $DONE_COUNT Done"
  fi
fi

# Count blockers (lines starting with ## in BLOCKERS.md, excluding the header)
BLOCKER_COUNT="0"
if [ -f "ai/session/BLOCKERS.md" ]; then
  BLOCKER_COUNT=$(grep "^## " ai/session/BLOCKERS.md 2>/dev/null | wc -l | tr -d ' ' || echo "0")
fi

if [ "$PERSONA_TYPE" = "cyber-monkey" ]; then
  if [ "$BLOCKER_COUNT" -eq 0 ]; then
    echo -e "${FDL_TEXT_SECONDARY}Blockers:${FDL_RESET} ${FDL_SUCCESS}$BLOCKER_COUNT${FDL_RESET} 🎯"
  else
    echo -e "${FDL_TEXT_SECONDARY}Blockers:${FDL_RESET} ${FDL_WARNING}$BLOCKER_COUNT${FDL_RESET} ⚠️"
  fi
else
  echo "Blockers: $BLOCKER_COUNT"
fi

echo ""

# Find highest priority ready brief
if [ "$TOTAL" -gt 0 ] && [ "${READY_COUNT:-0}" -gt 0 ]; then
  # Find P0 briefs first
  P0_BRIEF=$(find ai/briefs -name "*.md" ! -name "*TEMPLATE*" -exec grep -l "^Priority: P0" {} \; 2>/dev/null | head -1)

  if [ -n "$P0_BRIEF" ]; then
    # Check if it's Ready
    if grep -q "^Status: Ready" "$P0_BRIEF" 2>/dev/null; then
      BRIEF_TITLE=$(grep "^# " "$P0_BRIEF" 2>/dev/null | head -1 | sed 's/^# //')
      if [ "$PERSONA_TYPE" = "cyber-monkey" ]; then
        echo -e "${FDL_TEXT_SECONDARY}💡 Recommended Next Task:${FDL_RESET}"
        echo -e "   ${FDL_CRIMSON}${FDL_BOLD}$BRIEF_TITLE${FDL_RESET} ${FDL_ERROR}(P0 - Critical)${FDL_RESET}"
        echo ""
      else
        echo "💡 Recommended Next Task:"
        echo "   $BRIEF_TITLE (P0 - Critical)"
        echo ""
      fi
    fi
  else
    # Try P1 briefs
    P1_BRIEF=$(find ai/briefs -name "*.md" ! -name "*TEMPLATE*" -exec grep -l "^Priority: P1" {} \; 2>/dev/null | head -1)

    if [ -n "$P1_BRIEF" ] && grep -q "^Status: Ready" "$P1_BRIEF" 2>/dev/null; then
      BRIEF_TITLE=$(grep "^# " "$P1_BRIEF" 2>/dev/null | head -1 | sed 's/^# //')
      if [ "$PERSONA_TYPE" = "cyber-monkey" ]; then
        echo -e "${FDL_TEXT_SECONDARY}💡 Recommended Next Task:${FDL_RESET}"
        echo -e "   ${FDL_CRIMSON}$BRIEF_TITLE${FDL_RESET} ${FDL_WARNING}(P1 - High)${FDL_RESET}"
        echo ""
      else
        echo "💡 Recommended Next Task:"
        echo "   $BRIEF_TITLE (P1 - High)"
        echo ""
      fi
    else
      # Just show any Ready brief
      READY_BRIEF=$(find ai/briefs -name "*.md" ! -name "*TEMPLATE*" -exec grep -l "^Status: Ready" {} \; 2>/dev/null | head -1)
      if [ -n "$READY_BRIEF" ]; then
        BRIEF_TITLE=$(grep "^# " "$READY_BRIEF" 2>/dev/null | head -1 | sed 's/^# //')
        if [ "$PERSONA_TYPE" = "cyber-monkey" ]; then
          echo -e "${FDL_TEXT_SECONDARY}💡 Recommended Next Task:${FDL_RESET}"
          echo -e "   ${FDL_CRIMSON}$BRIEF_TITLE${FDL_RESET}"
          echo ""
        else
          echo "💡 Recommended Next Task:"
          echo "   $BRIEF_TITLE"
          echo ""
        fi
      fi
    fi
  fi
fi

if [ "$PERSONA_TYPE" = "cyber-monkey" ]; then
  echo -e "${FDL_CRIMSON}${FDL_BOLD}Ready for your command! 🔥${FDL_RESET}"
else
  echo "Ready for your command!"
fi
echo ""
