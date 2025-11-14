#!/bin/bash
# Igris AI Self-Healer
# Auto-fix failing tests with retry loops

set -e

if ! type resolve_hooks &>/dev/null; then
    if [ -f "scripts/igris_init.sh" ]; then
        source scripts/igris_init.sh
    else
        echo "❌ Error: Hook system not available"
        exit 1
    fi
fi

hook_script=$(resolve_hooks "SELF_HEALER" 2>/dev/null || echo "")
if [ -z "$hook_script" ]; then
    echo "❌ Error: SELF_HEALER hook not installed"
    echo ""
    echo "Install the LangGraph plugin:"
    echo "  ./scripts/plugin_install.sh igris-ai-langgraph.tar.gz"
    exit 1
fi

echo "🔧 Self-Healing Agent"
echo "====================="
echo ""

# Get test output (from stdin or run tests)
if [ -t 0 ]; then
    # No stdin, run tests to get output
    echo "Running tests to detect failures..."
    test_output=$(npm test 2>&1 || true)
else
    # Read from stdin
    test_output=$(cat)
fi

if [ -z "$test_output" ]; then
    echo "No test output available"
    exit 2
fi

# Check if tests actually failed
if echo "$test_output" | grep -q "PASS\|passed\|OK"; then
    echo "✅ Tests are passing - nothing to heal"
    exit 0
fi

echo "⚠️  Test failures detected. Attempting auto-fix..."
echo ""
echo "Max attempts: 3"
echo "Cost estimate: \$0.30-2.00"
echo ""

# Execute SELF_HEALER hook
export IGRIS_HOOK_TYPE="SELF_HEALER"
export IGRIS_PROJECT_ROOT="$(pwd)"

heal_output=$(echo "$test_output" | "$hook_script" 2>&1)
hook_exit=$?

echo "$heal_output"
echo ""

case $hook_exit in
    0)
        echo "✅ Tests healed successfully!"
        echo ""
        echo "Next steps:"
        echo "  1. Review fixes: git diff"
        echo "  2. Run tests again: npm test"
        echo "  3. Commit if satisfied"
        exit 0
        ;;
    1)
        echo "❌ Could not auto-fix tests"
        echo "Manual debugging required"
        exit 1
        ;;
    2)
        exit 0
        ;;
    *)
        exit 1
        ;;
esac
