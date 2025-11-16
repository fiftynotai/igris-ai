#!/bin/bash
# Launch MCP Inspector for Igris AI MCP Server
# Must run from igris-ai root directory

set -e

echo ""
echo "🔥 Starting Igris MCP Inspector..."
echo ""
echo "📍 Server will start at:"
echo "   Web UI:  http://localhost:6274"
echo "   Proxy:   localhost:6277"
echo ""
echo "⚠️  Running from: $(pwd)"
echo "   (Must be igris-ai root, not mcp-server/)"
echo ""
echo "💡 Open http://localhost:6274 in your browser"
echo ""
echo "🛑 Press Ctrl+C to stop"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Ensure we're in the right directory
if [ ! -d "ai/briefs" ]; then
    echo "❌ ERROR: ai/briefs/ not found!"
    echo "   You must run this from igris-ai root directory:"
    echo "   cd /Users/m.elamin/StudioProjects/igris-ai"
    echo "   ./mcp-server/test-inspector.sh"
    exit 1
fi

# Clean up any existing inspector processes
lsof -ti :6274 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti :6277 2>/dev/null | xargs kill -9 2>/dev/null || true

sleep 1

# Launch inspector
DANGEROUSLY_OMIT_AUTH=true npx @modelcontextprotocol/inspector node mcp-server/dist/index.js
