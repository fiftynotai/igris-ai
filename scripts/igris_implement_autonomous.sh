#!/bin/bash
# Igris AI Autonomous Implementation
# AI implements entire brief with human oversight

set -e

# Check if hook system available
if ! type resolve_hooks &>/dev/null; then
    if [ -f "scripts/igris_init.sh" ]; then
        source scripts/igris_init.sh
    else
        echo "❌ Error: Hook system not available"
        exit 1
    fi
fi

# Check if AUTONOMOUS_IMPLEMENTER hook registered
hook_script=$(resolve_hooks "AUTONOMOUS_IMPLEMENTER" 2>/dev/null || echo "")
if [ -z "$hook_script" ]; then
    echo "❌ Error: AUTONOMOUS_IMPLEMENTER hook not installed"
    echo ""
    echo "Install the LangGraph plugin for autonomous implementation:"
    echo "  ./scripts/plugin_install.sh igris-ai-langgraph.tar.gz"
    exit 1
fi

# Get brief ID
if [ -z "$1" ]; then
    echo "Usage: igris implement <brief-id> --autonomous"
    echo ""
    echo "Example:"
    echo "  ./scripts/igris_implement_autonomous.sh BR-005"
    echo ""
    exit 2
fi

brief_id="$1"

# Validate brief exists
brief_file=$(ls ai/briefs/${brief_id}-*.md 2>/dev/null | head -1)
if [ ! -f "$brief_file" ]; then
    echo "❌ Error: Brief not found: $brief_id"
    exit 1
fi

echo "🤖 Autonomous Brief Implementation"
echo "===================================="
echo ""
echo "Brief: $brief_id"
echo "File: $brief_file"
echo ""

# Show brief summary
echo "📋 Brief Summary:"
head -20 "$brief_file" | grep -E '^(# |\\*\\*)'
echo ""

# Warning
echo "⚠️  WARNING: Autonomous Implementation"
echo ""
echo "This will:"
echo "  - AI analyzes brief and creates implementation plan"
echo "  - Human approves plan (checkpoint 1)"
echo "  - AI implements code step-by-step"
echo "  - AI generates and runs tests"
echo "  - AI reviews code against guidelines"
echo "  - AI fixes issues if found (retry loops)"
echo "  - AI updates documentation"
echo "  - Human approves final result (checkpoint 2)"
echo ""
echo "Cost estimate: \$2-5 (multiple agents, iterations)"
echo "Duration estimate: 5-10 minutes"
echo ""
read -p "Proceed with autonomous implementation? [y/N]: " CONFIRM

if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "Implementation cancelled"
    exit 0
fi

echo ""
echo "🚀 Starting autonomous implementation..."
echo ""

# Execute AUTONOMOUS_IMPLEMENTER hook
export IGRIS_HOOK_TYPE="AUTONOMOUS_IMPLEMENTER"
export IGRIS_PROJECT_ROOT="$(pwd)"
export IGRIS_BRIEF_ID="$brief_id"

# Create JSON input
input_json="{\"brief_id\": \"$brief_id\"}"

implementation_output=$(echo "$input_json" | "$hook_script" 2>&1)
hook_exit=$?

echo "$implementation_output"
echo ""

# Handle exit codes
case $hook_exit in
    0)
        echo "✅ Implementation complete!"
        echo ""
        echo "Next steps:"
        echo "  1. Review changes: git diff"
        echo "  2. Run tests: npm test (or appropriate)"
        echo "  3. Commit if satisfied"
        exit 0
        ;;
    1)
        echo "❌ Implementation failed"
        echo "Review errors above and implement manually"
        exit 1
        ;;
    2)
        echo "⏸️  Implementation paused"
        echo "Resume when ready"
        exit 0
        ;;
    *)
        echo "❌ Unexpected error"
        exit 1
        ;;
esac
