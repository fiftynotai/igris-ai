#!/bin/bash

# Igris AI - Shell Integration Installer
# Adds terminal notifications when entering Igris AI projects
# This script ONLY adds code to your shell config - you maintain full control

set -e

# Check Python3 dependency
check_python3() {
  if ! command -v python3 &> /dev/null; then
    echo "❌ Error: Python 3 is required but not installed"
    echo ""
    echo "Install Python 3:"
    echo "  macOS: brew install python3"
    echo "  Ubuntu/Debian: sudo apt install python3"
    echo "  Download: https://www.python.org/downloads/"
    echo ""
    exit 1
  fi
}

check_python3

echo "📘 Igris AI - Shell Integration Installer"
echo "============================================="
echo ""
echo "This will add Igris AI detection to your shell."
echo ""
echo "What it does:"
echo "  ✓ Shows a notification when you cd into a Igris AI project"
echo "  ✓ Displays the Igris AI version"
echo "  ✓ Reminds you that Claude will auto-initialize"
echo ""
echo "What it does NOT do:"
echo "  ✗ Does NOT modify any Igris AI behavior"
echo "  ✗ Does NOT send data anywhere"
echo "  ✗ Does NOT run on non-Igris AI projects"
echo ""

# Detect shell
SHELL_NAME=$(basename "$SHELL")
SHELL_RC=""

if [ "$SHELL_NAME" = "bash" ]; then
    SHELL_RC="$HOME/.bashrc"
    echo "Detected shell: bash"
elif [ "$SHELL_NAME" = "zsh" ]; then
    SHELL_RC="$HOME/.zshrc"
    echo "Detected shell: zsh"
else
    echo "❌ Unsupported shell: $SHELL_NAME"
    echo "   This script supports bash and zsh only"
    echo ""
    echo "Manual installation:"
    echo "   See the code below and add it to your shell config manually"
    exit 1
fi

echo "Shell config file: $SHELL_RC"
echo ""

# Show the code that will be added
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "The following code will be added to $SHELL_RC:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
cat << 'PREVIEW'

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Igris AI Auto-Detection
# Added by: scripts/install_shell_integration.sh
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

igris_check() {
    # Only check if .igris_version exists in current directory
    if [ -f ".igris_version" ]; then
        # Get Igris AI version
        BP_VERSION=$(python3 -c "import json; print(json.load(open('.igris_version'))['igris_ai_version'])" 2>/dev/null || echo "unknown")

        # Show notification
        echo "📘 Igris AI detected (v$BP_VERSION)"
        echo "   Claude will auto-initialize with Igris AI configuration"
    fi
}

# Hook into cd command to check on directory change
cd() {
    builtin cd "$@"
    igris_check
}

# Check on shell start (in case already in a Igris AI directory)
igris_check

# Igris Shadow Commands (if persona active)
# ARISE - Launch Claude Code with dramatic flair
alias arise='claude'

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PREVIEW
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if already installed
if grep -q "Igris AI Auto-Detection" "$SHELL_RC" 2>/dev/null; then
    echo "⚠️  Igris AI shell integration is already installed"
    echo ""
    read -p "Reinstall (this will add duplicate code)? [y/N]: " REINSTALL
    if [[ ! "$REINSTALL" =~ ^[Yy]$ ]]; then
        echo "❌ Installation cancelled"
        exit 0
    fi
    echo ""
fi

echo "Options:"
echo "  1. Install automatically (recommended)"
echo "  2. Show manual installation instructions"
echo "  3. Cancel"
echo ""
read -p "Choose [1/2/3]: " CHOICE

case $CHOICE in
    1)
        echo ""
        echo "Installing..."

        # Backup shell config
        BACKUP_FILE="${SHELL_RC}.backup.$(date +%Y%m%d_%H%M%S)"
        cp "$SHELL_RC" "$BACKUP_FILE" 2>/dev/null || touch "$BACKUP_FILE"
        echo "✓ Backup created: $BACKUP_FILE"

        # Add the integration code
        cat << 'INTEGRATION' >> "$SHELL_RC"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Igris AI Auto-Detection
# Added by: scripts/install_shell_integration.sh
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

igris_check() {
    # Only check if .igris_version exists in current directory
    if [ -f ".igris_version" ]; then
        # Get Igris AI version
        BP_VERSION=$(python3 -c "import json; print(json.load(open('.igris_version'))['igris_ai_version'])" 2>/dev/null || echo "unknown")

        # Show notification
        echo "📘 Igris AI detected (v$BP_VERSION)"
        echo "   Claude will auto-initialize with Igris AI configuration"
    fi
}

# Hook into cd command to check on directory change
cd() {
    builtin cd "$@"
    igris_check
}

# Check on shell start (in case already in a Igris AI directory)
igris_check

# Igris Shadow Commands (if persona active)
# ARISE - Launch Claude Code with dramatic flair
alias arise='claude'

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

INTEGRATION

        echo "✓ Code added to $SHELL_RC"
        echo ""
        echo "✅ Installation complete!"
        echo ""
        echo "To activate immediately:"
        echo "  $ source $SHELL_RC"
        echo ""
        echo "Or simply open a new terminal window."
        echo ""
        echo "To remove later:"
        echo "  Edit $SHELL_RC and delete the Igris AI section"
        echo "  Or restore backup: mv $BACKUP_FILE $SHELL_RC"
        echo ""
        ;;

    2)
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "Manual Installation Instructions"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        echo "1. Open your shell config file in a text editor:"
        echo "   $ nano $SHELL_RC"
        echo ""
        echo "2. Scroll to the end of the file"
        echo ""
        echo "3. Copy and paste the code shown above"
        echo ""
        echo "4. Save and close the file"
        echo ""
        echo "5. Reload your shell config:"
        echo "   $ source $SHELL_RC"
        echo ""
        echo "6. Test it by cd'ing into a Igris AI project"
        echo ""
        ;;

    *)
        echo ""
        echo "❌ Installation cancelled"
        echo ""
        exit 0
        ;;
esac
