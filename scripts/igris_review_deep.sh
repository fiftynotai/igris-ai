#!/bin/bash
# Igris AI Deep Code Review
# Multi-agent review with 5 specialized experts

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

# Check if MULTI_AGENT_REVIEWER hook registered
hook_script=$(resolve_hooks "MULTI_AGENT_REVIEWER" 2>/dev/null || echo "")
if [ -z "$hook_script" ]; then
    echo "❌ Error: MULTI_AGENT_REVIEWER hook not installed"
    echo ""
    echo "Install the LangGraph plugin for multi-agent review:"
    echo "  ./scripts/plugin_install.sh igris-ai-langgraph.tar.gz"
    echo ""
    echo "Or use simple review:"
    echo "  ./scripts/igris_review.sh"
    exit 1
fi

# Get changed files
if [ -n "$1" ]; then
    # Specific files provided
    changed_files="$@"
else
    # Get all staged files, or all modified files
    changed_files=$(git diff --name-only --cached 2>/dev/null)
    if [ -z "$changed_files" ]; then
        changed_files=$(git diff --name-only 2>/dev/null)
    fi
fi

# Validate we have files
if [ -z "$changed_files" ]; then
    echo "ℹ️  No changed files to review"
    exit 0
fi

echo "🤖 Multi-Agent Deep Code Review"
echo "================================"
echo ""
echo "Files under review:"
echo "$changed_files" | while read -r file; do
    echo "  - $file"
done
echo ""

# Cost warning
echo "⚠️  Note: Deep review costs ~\$0.50-1.00 (5 agents + synthesis)"
read -p "Continue? [Y/n]: " CONFIRM
if [[ "$CONFIRM" =~ ^[Nn]$ ]]; then
    echo "Review cancelled"
    exit 0
fi
echo ""

# Execute MULTI_AGENT_REVIEWER hook
export IGRIS_HOOK_TYPE="MULTI_AGENT_REVIEWER"
export IGRIS_PROJECT_ROOT="$(pwd)"

review_output=$(echo "$changed_files" | "$hook_script" 2>&1)
hook_exit=$?

echo "$review_output"
echo ""

# Handle exit codes
case $hook_exit in
    0)
        echo "✅ Multi-agent review: APPROVED"
        exit 0
        ;;
    1)
        echo "⚠️  Multi-agent review found issues"
        echo ""
        echo "Options:"
        echo "  1. Fix issues and review again: ./scripts/igris_review_deep.sh"
        echo "  2. Get quick review: ./scripts/igris_review.sh"
        echo "  3. Commit anyway (not recommended)"
        exit 1
        ;;
    2)
        # Hook skipped
        exit 0
        ;;
    *)
        echo "❌ Review failed with unexpected error"
        exit 1
        ;;
esac
