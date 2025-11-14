#!/bin/bash
# Example Enhancement Hook (Test Fixture)
# Demonstrates hook contract: stdin input, stdout output, exit codes

set -e

# Read input from stdin
input=$(cat)

# Echo environment variables (for testing)
echo "Hook Type: $IGRIS_HOOK_TYPE"
echo "Project Root: $IGRIS_PROJECT_ROOT"
echo "Igris Version: $IGRIS_VERSION"
echo ""

# Process based on hook type
case "$IGRIS_HOOK_TYPE" in
  SYSTEM_ASSESSMENT)
    echo "🔍 Enhanced System Assessment"
    echo ""
    echo "Recent activity:"
    git log --oneline -3 2>/dev/null || echo "No git history"
    echo ""
    exit 0
    ;;

  *)
    echo "Example hook executed successfully"
    echo "Input received: $input"
    exit 0
    ;;
esac
