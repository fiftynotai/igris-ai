#!/bin/bash
# Igris AI Persona Packs - Interactive Installer

set -e

echo "🎭 Igris AI Persona Installer"
echo ""
echo "Choose a persona:"
echo "[1] Igris - Shadow Knight (loyal, dramatic)"
echo "[2] Cancel"
echo ""
read -p "Selection: " PERSONA_CHOICE

if [ "$PERSONA_CHOICE" != "1" ]; then
  echo "Installation cancelled"
  exit 0
fi

PERSONA="igris"
echo ""
echo "⚔️ Installing Igris..."
echo ""

# Choose mask level
echo "Choose your mask level:"
echo ""
echo "[1] 🎭 Half Mask - Branding only (corporate/professional)"
echo "    • Shows company branding"
echo "    • Uses your title subtly"
echo "    • Professional tone maintained"
echo ""
echo "[2] 🎭 Light Mask - Branding + personality (balanced)"
echo "    • Company branding"
echo "    • Subtle tone adjustments"
echo "    • Title addressing"
echo ""
echo "[3] 🎭 Full Mask - Complete immersion (epic mode)"
echo "    • Full banner display"
echo "    • Dramatic persona language"
echo "    • Shadow commands enabled"
echo ""
echo "[4] ⚪ No Mask - Install but keep dormant"
echo ""
read -p "Selection: " MASK_CHOICE

case $MASK_CHOICE in
  1) MASK="half" ;;
  2) MASK="light" ;;
  3) MASK="full" ;;
  4) MASK="none" ;;
  *) echo "Invalid choice"; exit 1 ;;
esac

echo ""
read -p "Title (how Igris addresses you) [Monarch]: " TITLE
TITLE=${TITLE:-Monarch}

if [ "$MASK" != "none" ]; then
  read -p "Company name (optional, press Enter to skip): " COMPANY
  COMPANY=${COMPANY:-Shadow Industries}
fi

if [ "$MASK" == "light" ] || [ "$MASK" == "full" ]; then
  echo ""
  echo "Tone level:"
  echo "[1] C1 - Knight Ledger (restrained, subtle)"
  echo "[2] C2 - Shadow Scripture (dramatic, recommended)"
  echo "[3] C3 - Epic Chronicle (maximum drama)"
  read -p "Tone [2]: " TONE_CHOICE
  case ${TONE_CHOICE:-2} in
    1) TONE="C1" ;;
    2) TONE="C2" ;;
    3) TONE="C3" ;;
    *) TONE="C2" ;;
  esac

  echo ""
  echo "Addressing mode:"
  echo "[1] T1 - Summon Only (title at session start only)"
  echo "[2] T2 - Always (title in every response)"
  echo "[3] T3 - Hybrid (summon + major moments)"
  read -p "Addressing [3]: " ADDR_CHOICE
  case ${ADDR_CHOICE:-3} in
    1) ADDRESSING="T1" ;;
    2) ADDRESSING="T2" ;;
    3) ADDRESSING="T3" ;;
    *) ADDRESSING="T3" ;;
  esac
else
  TONE="C2"
  ADDRESSING="T3"
fi

# Create persona.json
cat > ai/persona.json <<EOF
{
  "persona": "$PERSONA",
  "mask": "$MASK",
  "installed_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "version": "1.0.0",
  "branding": {
    "title": "$TITLE",
    "company": "$COMPANY"
  },
  "tone": {
    "level": "$TONE",
    "addressing_mode": "$ADDRESSING"
  },
  "features": {
    "commands": $([ "$MASK" == "full" ] && echo "true" || echo "false"),
    "banner": $([ "$MASK" == "full" ] && echo "true" || echo "false")
  }
}
EOF

echo ""
echo "✅ Persona installed: Igris"
echo "🎭 Mask level: $MASK"

if [ "$MASK" == "full" ]; then
  echo "⚔️ Shadow commands: Enabled"
  echo "⚔️ Banner: Enabled"
fi

echo ""
echo "Configuration saved to: ai/persona.json"
echo ""

# Apply the mask
./scripts/persona_mask.sh wear "$PERSONA" "$MASK"

echo ""
if [ "$MASK" == "full" ]; then
  echo "Your transformation is complete, $TITLE."
  echo ""
  echo "Type 'ARISE' to awaken the shadow."
else
  echo "Persona configured and ready."
fi
