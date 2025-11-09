#!/bin/bash
# Igris AI Persona Packs - Mask Control
# Commands: wear, adjust, remove, status

set -e

COMMAND=$1
PERSONA=$2
MASK_LEVEL=$3

PERSONA_CONFIG="ai/persona.json"
HOOK_FILE="ai/prompts/persona_loader.md"

# Color codes
RED='\033[0:31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Usage function
usage() {
  echo "Usage: persona_mask.sh <command> [options]"
  echo ""
  echo "Commands:"
  echo "  wear <persona> <level>    Wear a persona mask"
  echo "  adjust <level>            Change current mask level"
  echo "  remove                    Remove mask (set to dormant)"
  echo "  status                    Show current configuration"
  echo ""
  echo "Mask Levels:"
  echo "  none   - Persona dormant (no injection)"
  echo "  half   - Branding only (corporate)"
  echo "  light  - Branding + subtle tone"
  echo "  full   - Complete immersion"
  echo ""
  echo "Examples:"
  echo "  ./scripts/persona_mask.sh wear igris full"
  echo "  ./scripts/persona_mask.sh adjust light"
  echo "  ./scripts/persona_mask.sh remove"
  echo "  ./scripts/persona_mask.sh status"
  exit 1
}

# Check if jq is available
if ! command -v jq &> /dev/null; then
  echo -e "${RED}❌ Error: jq is required but not installed${NC}"
  echo "Install with: brew install jq (macOS) or apt-get install jq (Linux)"
  exit 1
fi

# Check if persona config exists
if [ ! -f "$PERSONA_CONFIG" ]; then
  echo -e "${RED}❌ Error: Persona not configured${NC}"
  echo "Run: ./scripts/persona_install.sh"
  exit 1
fi

# Function to regenerate hook file
regenerate_hook() {
  local mask=$1
  local persona=$2

  MASK_FILE="ai/personas/$persona/masks/$mask.md"

  if [ ! -f "$MASK_FILE" ]; then
    echo -e "${RED}❌ Error: Mask file not found: $MASK_FILE${NC}"
    exit 1
  fi

  # Copy mask file to hook location
  cp "$MASK_FILE" "$HOOK_FILE"

  # Replace placeholders
  TITLE=$(jq -r '.branding.title // "User"' "$PERSONA_CONFIG")
  COMPANY=$(jq -r '.branding.company // "Your Company"' "$PERSONA_CONFIG")
  TONE_LEVEL=$(jq -r '.tone.level // "C2"' "$PERSONA_CONFIG")

  # Map tone level to name and description
  case $TONE_LEVEL in
    C1)
      TONE_NAME="Knight Ledger"
      TONE_DESC="restrained, professional"
      ;;
    C2)
      TONE_NAME="Shadow Scripture"
      TONE_DESC="dramatic, epic"
      ;;
    C3)
      TONE_NAME="Epic Chronicle"
      TONE_DESC="maximum drama"
      ;;
    *)
      TONE_NAME="Shadow Scripture"
      TONE_DESC="dramatic, epic"
      ;;
  esac

  # Replace placeholders in hook file
  sed -i.bak "s/{{TITLE}}/$TITLE/g" "$HOOK_FILE"
  sed -i.bak "s/{{COMPANY}}/$COMPANY/g" "$HOOK_FILE"
  sed -i.bak "s/{{TONE_NAME}}/$TONE_NAME/g" "$HOOK_FILE"
  sed -i.bak "s/{{TONE_DESC}}/$TONE_DESC/g" "$HOOK_FILE"
  rm -f "${HOOK_FILE}.bak"
}

# Function to regenerate CLAUDE.md
regenerate_claude() {
  echo "🔄 Regenerating CLAUDE.md..."

  # Check if CLAUDE.md template exists locally
  if [ ! -f "scripts/CLAUDE.md.template" ]; then
    echo -e "${YELLOW}⚠️  Warning: CLAUDE.md template not found${NC}"
    echo "Please run igris_update.sh to get the latest template"
    return
  fi

  # Get version and date
  IGRIS_VERSION=$(cat .igris_version 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('igris_ai_version','unknown'))" 2>/dev/null || echo "unknown")
  INSTALL_DATE=$(cat .igris_version 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('installed_at',''))" 2>/dev/null | cut -d'T' -f1 || date -u +"%Y-%m-%d")

  # Resolve persona hook
  PERSONA_INJECTION=""
  if [ -f "$HOOK_FILE" ]; then
    PERSONA_INJECTION=$(cat "$HOOK_FILE")
  fi

  # Regenerate CLAUDE.md with variable substitution
  # Use a two-step process to handle multi-line PERSONA_INJECTION

  # First pass: Replace simple variables
  sed -e "s/{{IGRIS_VERSION}}/$IGRIS_VERSION/g" \
      -e "s/{{INSTALL_DATE}}/$INSTALL_DATE/g" \
      "scripts/CLAUDE.md.template" > CLAUDE.md.tmp

  # Second pass: Replace persona injection using perl (handles newlines)
  if [ -n "$PERSONA_INJECTION" ]; then
    # Escape special characters for perl regex
    ESCAPED_INJECTION=$(printf '%s\n' "$PERSONA_INJECTION" | perl -pe 's/([\\\/\$])/\\$1/g')
    perl -i -pe "s/\{\{PERSONA_INJECTION\}\}/$ESCAPED_INJECTION/g" CLAUDE.md.tmp
  else
    # Remove the placeholder if no injection
    perl -i -pe 's/\{\{PERSONA_INJECTION\}\}//g' CLAUDE.md.tmp
  fi

  mv CLAUDE.md.tmp CLAUDE.md

  echo -e "${GREEN}✅ CLAUDE.md updated${NC}"
}

# Command: wear
cmd_wear() {
  if [ -z "$PERSONA" ] || [ -z "$MASK_LEVEL" ]; then
    usage
  fi

  # Validate mask level
  if [[ ! "$MASK_LEVEL" =~ ^(none|half|light|full)$ ]]; then
    echo -e "${RED}❌ Error: Invalid mask level: $MASK_LEVEL${NC}"
    echo "Valid levels: none, half, light, full"
    exit 1
  fi

  echo "🎭 Wearing $MASK_LEVEL mask..."

  # Update persona config
  jq --arg persona "$PERSONA" --arg mask "$MASK_LEVEL" \
     '.persona = $persona | .mask = $mask' \
     "$PERSONA_CONFIG" > "${PERSONA_CONFIG}.tmp"
  mv "${PERSONA_CONFIG}.tmp" "$PERSONA_CONFIG"

  # Regenerate hook
  regenerate_hook "$MASK_LEVEL" "$PERSONA"

  # Regenerate CLAUDE.md
  regenerate_claude

  echo ""
  echo -e "${GREEN}✅ Mask applied${NC}"
  echo "Persona: $PERSONA"
  echo "Mask Level: $MASK_LEVEL"

  if [ "$MASK_LEVEL" == "full" ]; then
    echo -e "⚔️  Shadow commands: ${GREEN}Enabled${NC}"
  fi
}

# Command: adjust
cmd_adjust() {
  if [ -z "$PERSONA" ]; then
    usage
  fi

  MASK_LEVEL=$PERSONA  # Second arg is mask level for adjust

  # Get current persona
  CURRENT_PERSONA=$(jq -r '.persona' "$PERSONA_CONFIG")

  if [ "$CURRENT_PERSONA" == "null" ] || [ -z "$CURRENT_PERSONA" ]; then
    echo -e "${RED}❌ Error: No persona configured${NC}"
    echo "Use 'wear' command first"
    exit 1
  fi

  echo "🎭 Adjusting to $MASK_LEVEL mask..."

  # Update mask level
  jq --arg mask "$MASK_LEVEL" '.mask = $mask' "$PERSONA_CONFIG" > "${PERSONA_CONFIG}.tmp"
  mv "${PERSONA_CONFIG}.tmp" "$PERSONA_CONFIG"

  # Regenerate hook
  regenerate_hook "$MASK_LEVEL" "$CURRENT_PERSONA"

  # Regenerate CLAUDE.md
  regenerate_claude

  echo ""
  echo -e "${GREEN}✅ Mask adjusted${NC}"
  echo "Persona: $CURRENT_PERSONA"
  echo "Mask Level: $MASK_LEVEL"
}

# Command: remove
cmd_remove() {
  echo "🎭 Removing mask..."

  # Get current persona
  CURRENT_PERSONA=$(jq -r '.persona' "$PERSONA_CONFIG")

  # Set mask to none
  jq '.mask = "none"' "$PERSONA_CONFIG" > "${PERSONA_CONFIG}.tmp"
  mv "${PERSONA_CONFIG}.tmp" "$PERSONA_CONFIG"

  # Regenerate hook (empty)
  regenerate_hook "none" "$CURRENT_PERSONA"

  # Regenerate CLAUDE.md
  regenerate_claude

  echo ""
  echo -e "${GREEN}✅ Mask removed${NC}"
  echo "Persona: $CURRENT_PERSONA (dormant)"
  echo "Mask Level: none"
  echo ""
  echo "Reverted to standard Igris AI"
}

# Command: status
cmd_status() {
  echo "🎭 Current Persona Configuration"
  echo ""

  CURRENT_PERSONA=$(jq -r '.persona' "$PERSONA_CONFIG")
  CURRENT_MASK=$(jq -r '.mask' "$PERSONA_CONFIG")
  TITLE=$(jq -r '.branding.title' "$PERSONA_CONFIG")
  TONE=$(jq -r '.tone.level' "$PERSONA_CONFIG")
  ADDRESSING=$(jq -r '.tone.addressing_mode' "$PERSONA_CONFIG")
  COMMANDS=$(jq -r '.features.commands' "$PERSONA_CONFIG")
  BANNER=$(jq -r '.features.banner' "$PERSONA_CONFIG")
  VERSION=$(jq -r '.version' "$PERSONA_CONFIG")
  INSTALLED=$(jq -r '.installed_at' "$PERSONA_CONFIG")

  echo "Persona: $CURRENT_PERSONA"
  echo "Mask: $CURRENT_MASK"
  echo "Title: $TITLE"
  echo "Tone: $TONE"
  echo "Addressing: $ADDRESSING"
  echo "Shadow Commands: $COMMANDS"
  echo "Banner: $BANNER"
  echo ""
  echo "Installed: $INSTALLED"
  echo "Version: $VERSION"
}

# Main command router
case $COMMAND in
  wear)
    cmd_wear
    ;;
  adjust)
    cmd_adjust
    ;;
  remove)
    cmd_remove
    ;;
  status)
    cmd_status
    ;;
  *)
    usage
    ;;
esac
