#!/bin/bash
# Igris AI Conversational Brief Refiner
# Interactive brief creation

set -e

if ! type resolve_hooks &>/dev/null; then
    if [ -f "scripts/igris_init.sh" ]; then
        source scripts/igris_init.sh
    fi
fi

hook_script=$(resolve_hooks "CONVERSATIONAL_REFINER" 2>/dev/null || echo "")
if [ -z "$hook_script" ]; then
    echo "❌ Error: CONVERSATIONAL_REFINER hook not installed"
    exit 1
fi

if [ -z "$1" ]; then
    echo "Usage: igris refine-brief --interactive"
    echo "   or: igris refine-brief BR-XXX --interactive"
    exit 2
fi

description="$*"

echo "💬 Conversational Brief Refinement"
echo "==================================="
echo ""
echo "Initial input: $description"
echo ""
echo "🤖 AI will ask clarifying questions to create comprehensive brief"
echo ""

export IGRIS_HOOK_TYPE="CONVERSATIONAL_REFINER"
export IGRIS_PROJECT_ROOT="$(pwd)"

brief_output=$(echo "$description" | "$hook_script" 2>&1)
hook_exit=$?

if [ $hook_exit -eq 0 ]; then
    echo "$brief_output"
    echo ""
    echo "✅ Brief refined through conversation"
    exit 0
else
    echo "❌ Refinement failed"
    exit 1
fi
