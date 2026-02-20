#!/bin/bash
# Igris AI Persona Packs - Mask Control
# Commands: wear, adjust, remove, status

set -euo pipefail

COMMAND="${1:-}"
PERSONA="${2:-}"
MASK_LEVEL="${3:-}"

PERSONA_CONFIG="ai/persona.json"
HOOK_FILE="ai/prompts/persona_loader.md"

# Color codes
RED='\033[0;31m'
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

# JSON read helper: uses jq if available, falls back to python3
json_read() {
  local file="$1"
  local jq_expr="$2"
  local py_expr="$3"
  local default="${4:-}"

  if command -v jq &>/dev/null; then
    jq -r "$jq_expr" "$file" 2>/dev/null || echo "$default"
  elif command -v python3 &>/dev/null; then
    python3 -c "import json,sys; data=json.load(open(sys.argv[1])); $py_expr" "$file" 2>/dev/null || echo "$default"
  else
    echo -e "${RED}Error: Neither jq nor python3 is available${NC}"
    echo "Install one of: brew install jq | apt-get install jq | python3"
    exit 1
  fi
}

# JSON write helper: uses jq if available, falls back to python3
json_write() {
  local file="$1"
  local jq_expr="$2"
  local py_code="$3"
  shift 3
  # Remaining args are --arg pairs for jq or env vars already exported

  local tmp_file
  tmp_file=$(mktemp)

  if command -v jq &>/dev/null; then
    jq "$@" "$jq_expr" "$file" > "$tmp_file" 2>/dev/null && mv "$tmp_file" "$file"
  elif command -v python3 &>/dev/null; then
    python3 -c "
import json, sys, os
with open(sys.argv[1], 'r') as f:
    data = json.load(f)
$py_code
with open(sys.argv[1], 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
" "$file" 2>/dev/null
    rm -f "$tmp_file"
  else
    rm -f "$tmp_file"
    echo -e "${RED}Error: Neither jq nor python3 is available${NC}"
    exit 1
  fi
}

# Portable sed in-place replacement (avoids macOS sed -i.bak issue)
sed_inplace() {
  local pattern="$1"
  local file="$2"
  local tmp_file
  tmp_file=$(mktemp)
  sed "$pattern" "$file" > "$tmp_file" && mv "$tmp_file" "$file"
}

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
  TITLE=$(json_read "$PERSONA_CONFIG" '.branding.title // "User"' "print(data.get('branding',{}).get('title','User'))" "User")
  COMPANY=$(json_read "$PERSONA_CONFIG" '.branding.company // "Your Company"' "print(data.get('branding',{}).get('company','Your Company'))" "Your Company")
  TONE_LEVEL=$(json_read "$PERSONA_CONFIG" '.tone.level // "C2"' "print(data.get('tone',{}).get('level','C2'))" "C2")

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

  # Replace placeholders in hook file (portable sed)
  sed_inplace "s/{{TITLE}}/$TITLE/g" "$HOOK_FILE"
  sed_inplace "s/{{COMPANY}}/$COMPANY/g" "$HOOK_FILE"
  sed_inplace "s/{{TONE_NAME}}/$TONE_NAME/g" "$HOOK_FILE"
  sed_inplace "s/{{TONE_DESC}}/$TONE_DESC/g" "$HOOK_FILE"
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
  export _PERSONA="$PERSONA"
  export _MASK="$MASK_LEVEL"
  json_write "$PERSONA_CONFIG" \
    '.persona = $persona | .mask = $mask' \
    "data['persona'] = os.environ['_PERSONA']; data['mask'] = os.environ['_MASK']" \
    --arg persona "$PERSONA" --arg mask "$MASK_LEVEL"

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

  # Validate mask level
  case "$MASK_LEVEL" in
    none|light|half|full) ;;
    *)
      echo -e "${RED}Error: Invalid mask level '$MASK_LEVEL'${NC}"
      echo "Valid masks: none, light, half, full"
      exit 1
      ;;
  esac

  # Get current persona
  CURRENT_PERSONA=$(json_read "$PERSONA_CONFIG" '.persona' "print(data.get('persona',''))")

  if [ "$CURRENT_PERSONA" == "null" ] || [ -z "$CURRENT_PERSONA" ]; then
    echo -e "${RED}❌ Error: No persona configured${NC}"
    echo "Use 'wear' command first"
    exit 1
  fi

  echo "🎭 Adjusting to $MASK_LEVEL mask..."

  # Update mask level
  export _MASK="$MASK_LEVEL"
  json_write "$PERSONA_CONFIG" \
    '.mask = $mask' \
    "data['mask'] = os.environ['_MASK']" \
    --arg mask "$MASK_LEVEL"

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
  CURRENT_PERSONA=$(json_read "$PERSONA_CONFIG" '.persona' "print(data.get('persona',''))")

  # Set mask to none
  json_write "$PERSONA_CONFIG" \
    '.mask = "none"' \
    "data['mask'] = 'none'"

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

  CURRENT_PERSONA=$(json_read "$PERSONA_CONFIG" '.persona' "print(data.get('persona',''))")
  CURRENT_MASK=$(json_read "$PERSONA_CONFIG" '.mask' "print(data.get('mask',''))")
  TITLE=$(json_read "$PERSONA_CONFIG" '.branding.title' "print(data.get('branding',{}).get('title',''))")
  TONE=$(json_read "$PERSONA_CONFIG" '.tone.level' "print(data.get('tone',{}).get('level',''))")
  ADDRESSING=$(json_read "$PERSONA_CONFIG" '.tone.addressing_mode' "print(data.get('tone',{}).get('addressing_mode',''))")
  COMMANDS=$(json_read "$PERSONA_CONFIG" '.features.commands' "print(data.get('features',{}).get('commands',''))")
  BANNER=$(json_read "$PERSONA_CONFIG" '.features.banner' "print(data.get('features',{}).get('banner',''))")
  VERSION=$(json_read "$PERSONA_CONFIG" '.version' "print(data.get('version',''))")
  INSTALLED=$(json_read "$PERSONA_CONFIG" '.installed_at' "print(data.get('installed_at',''))")

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
