#!/bin/bash
set -e

# Validate brief exists and is ready for HUNT
# Usage: validate-brief.sh <brief_id>

BRIEF_ID="$1"

if [ -z "$BRIEF_ID" ]; then
    echo "ERROR: Brief ID required"
    echo "Usage: validate-brief.sh <brief_id>"
    exit 2
fi

# Find brief file
BRIEF_PATH=$(ls ai/briefs/*"${BRIEF_ID}"*.md 2>/dev/null | head -1)

if [ -z "$BRIEF_PATH" ]; then
    echo "ERROR: Brief $BRIEF_ID not found in ai/briefs/"
    echo ""
    echo "Available briefs:"
    ls ai/briefs/*.md 2>/dev/null | grep -v TEMPLATE | head -10
    exit 1
fi

# Check status - extract first word after "Status:" to handle multi-line content
STATUS=$(grep "^\*\*Status:\*\*" "$BRIEF_PATH" | head -1 | sed 's/.*\*\*Status:\*\* //' | awk '{print $1}' | tr -d ' ')

case "$STATUS" in
    "Done")
        echo "ERROR: Brief $BRIEF_ID is already Done"
        echo "Use /archive to archive completed briefs"
        exit 1
        ;;
    "Draft")
        echo "WARNING: Brief $BRIEF_ID is still a Draft"
        echo "Consider updating to Ready status first"
        exit 0
        ;;
    "Ready"|"InProgress"|"In Progress")
        echo "OK: $BRIEF_PATH"
        echo "Status: $STATUS"
        exit 0
        ;;
    *)
        echo "WARNING: Unknown status '$STATUS'"
        echo "Brief: $BRIEF_PATH"
        exit 0
        ;;
esac
