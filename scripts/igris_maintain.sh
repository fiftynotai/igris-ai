#!/bin/bash
# Igris AI Autonomous Maintenance
# Scan and fix technical debt

set -e

if ! type resolve_hooks &>/dev/null; then
    if [ -f "scripts/igris_init.sh" ]; then
        source scripts/igris_init.sh
    fi
fi

hook_script=$(resolve_hooks "MAINTENANCE_AGENT" 2>/dev/null || echo "")
if [ -z "$hook_script" ]; then
    echo "❌ Error: MAINTENANCE_AGENT hook not installed"
    exit 1
fi

# Parse arguments
AUTO_FIX=false
if [ "$1" = "--auto-fix" ]; then
    AUTO_FIX=true
fi

echo "🔧 Autonomous Maintenance Agent"
echo "================================"
echo ""

if [ "$AUTO_FIX" = "true" ]; then
    echo "⚠️  WARNING: Auto-fix enabled"
    echo "   This will automatically fix simple issues"
    echo "   Cost estimate: \$1-5 depending on issues found"
    echo ""
    read -p "Proceed with auto-fix? [y/N]: " CONFIRM
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        echo "Cancelled"
        exit 0
    fi
    echo ""
fi

export IGRIS_HOOK_TYPE="MAINTENANCE_AGENT"
export IGRIS_PROJECT_ROOT="$(pwd)"

input_json="{\"auto_fix\": $AUTO_FIX}"

maintenance_output=$(echo "$input_json" | "$hook_script" 2>&1)
hook_exit=$?

echo "$maintenance_output"
echo ""

case $hook_exit in
    0)
        echo "✅ Maintenance complete"
        exit 0
        ;;
    1)
        echo "❌ Maintenance failed"
        exit 1
        ;;
    2)
        exit 0
        ;;
    *)
        exit 1
        ;;
esac
