#!/bin/bash
# Igris AI Sprint Planner
# AI-driven strategic work prioritization

set -e

if ! type resolve_hooks &>/dev/null; then
    if [ -f "scripts/igris_init.sh" ]; then
        source scripts/igris_init.sh
    else
        echo "❌ Error: Hook system not available"
        exit 1
    fi
fi

hook_script=$(resolve_hooks "BRIEF_PLANNER" 2>/dev/null || echo "")
if [ -z "$hook_script" ]; then
    echo "❌ Error: BRIEF_PLANNER hook not installed"
    echo ""
    echo "Install the LangGraph plugin:"
    echo "  ./scripts/plugin_install.sh igris-ai-langgraph.tar.gz"
    exit 1
fi

# Get days parameter (default: 10)
days="${1:-10}"

echo "📊 Strategic Sprint Planning"
echo "============================"
echo ""
echo "Analyzing briefs for optimal ${days}-day plan..."
echo ""

# Execute BRIEF_PLANNER hook
export IGRIS_HOOK_TYPE="BRIEF_PLANNER"
export IGRIS_PROJECT_ROOT="$(pwd)"

input_json="{\"days\": $days}"

plan_output=$(echo "$input_json" | "$hook_script" 2>&1)
hook_exit=$?

if [ $hook_exit -eq 0 ]; then
    echo "$plan_output"
    exit 0
else
    echo "❌ Planning failed"
    exit 1
fi
