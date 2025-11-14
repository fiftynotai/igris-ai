#!/bin/bash
# Igris AI Brief Generator
# Auto-generate briefs using LangChain

set -e

# Check if hook system available
if ! type resolve_hooks &>/dev/null; then
    # Load hook functions from igris_init.sh
    if [ -f "scripts/igris_init.sh" ]; then
        source scripts/igris_init.sh
    else
        echo "❌ Error: Hook system not available"
        echo "   This command requires Igris AI v2.5.0+"
        exit 1
    fi
fi

# Check if BRIEF_GENERATOR hook is registered
hook_script=$(resolve_hooks "BRIEF_GENERATOR" 2>/dev/null || echo "")
if [ -z "$hook_script" ]; then
    echo "❌ Error: BRIEF_GENERATOR hook not installed"
    echo ""
    echo "Install the LangChain plugin:"
    echo "  ./scripts/plugin_install.sh igris-ai-langchain.tar.gz"
    echo ""
    echo "Or install from GitHub:"
    echo "  ./scripts/plugin_install.sh https://github.com/fiftynotai/igris-ai-langchain"
    exit 1
fi

# Determine input source
if [ -t 0 ]; then
    # No stdin, use arguments as natural language
    if [ -z "$*" ]; then
        echo "Usage:"
        echo "  git diff main...feature | igris generate-brief"
        echo "  igris generate-brief \"add authentication with JWT\""
        echo ""
        echo "Examples:"
        echo "  # From git diff"
        echo "  git diff | ./scripts/igris_generate_brief.sh"
        echo ""
        echo "  # From natural language"
        echo "  ./scripts/igris_generate_brief.sh \"add user authentication\""
        echo ""
        echo "  # From branch comparison"
        echo "  git diff main...feature-auth | ./scripts/igris_generate_brief.sh"
        exit 2
    fi
    input="$*"
else
    # Read from stdin
    input=$(cat)
fi

# Validate input
if [ -z "$input" ]; then
    echo "❌ Error: No input provided"
    exit 1
fi

echo "🤖 Generating brief with LangChain..."
echo ""

# Execute BRIEF_GENERATOR hook
export IGRIS_HOOK_TYPE="BRIEF_GENERATOR"
export IGRIS_PROJECT_ROOT="$(pwd)"

brief_content=$(echo "$input" | "$hook_script" 2>&1)
hook_exit=$?

if [ $hook_exit -ne 0 ]; then
    echo "❌ Brief generation failed"
    echo "$brief_content"
    exit 1
fi

# Determine next brief number
echo "📋 Determining brief number..."
next_num=1

if [ -d "ai/briefs" ]; then
    # Find highest BR number
    highest=$(ls ai/briefs/BR-*.md 2>/dev/null | \
              grep -v TEMPLATE | \
              sed 's/.*BR-0*//' | \
              sed 's/-.*//' | \
              sort -n | \
              tail -1)

    if [ -n "$highest" ]; then
        next_num=$((highest + 1))
    fi
fi

brief_id=$(printf "BR-%03d" $next_num)

# Extract title from generated brief
# Look for first line starting with "# BR-"
title=$(echo "$brief_content" | \
        grep "^# BR-" | \
        head -1 | \
        sed 's/^# BR-[0-9]*: //' | \
        tr '[:upper:]' '[:lower:]' | \
        tr ' ' '-' | \
        tr -cd '[:alnum:]-')

if [ -z "$title" ]; then
    # Fallback: generate title from first few words of input
    title=$(echo "$input" | head -c 50 | tr ' ' '-' | tr -cd '[:alnum:]-' | tr '[:upper:]' '[:lower:]')
fi

# Ensure title is not too long
title=$(echo "$title" | cut -c1-50)

# Create brief file
brief_file="ai/briefs/${brief_id}-${title}.md"

# Replace BR-XXX placeholder with actual ID in content
brief_content=$(echo "$brief_content" | sed "s/BR-XXX/$brief_id/g")

# Write brief
echo "$brief_content" > "$brief_file"

echo ""
echo "✅ Brief generated successfully!"
echo ""
echo "📄 File: $brief_file"
echo "🆔 ID: $brief_id"
echo ""
echo "Next steps:"
echo "  1. Review the generated brief: cat $brief_file"
echo "  2. Edit if needed (adjust priority, effort, tasks)"
echo "  3. Mark as Ready when satisfied"
echo "  4. Implement: igris implement $brief_id"
echo ""

# Show brief summary
echo "📋 Brief Summary:"
echo "$(head -20 $brief_file | grep -E '^(# |\\*\\*)')"
echo ""
