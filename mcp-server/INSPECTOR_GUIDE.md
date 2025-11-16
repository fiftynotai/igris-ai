# MCP Inspector Testing Guide

**For Igris AI MCP Server v3.0.0**

---

## What is MCP Inspector?

The MCP Inspector is a **web-based testing tool** that:
- ✅ Connects to your MCP server
- ✅ Lists all available tools
- ✅ Lets you test tools with a GUI
- ✅ Shows request/response in real-time
- ✅ Validates MCP protocol compliance

---

## Quick Start

### Step 1: Launch the Inspector

From the **igris-ai root directory**:

```bash
cd /Users/m.elamin/StudioProjects/igris-ai
npx @modelcontextprotocol/inspector node mcp-server/dist/index.js
```

**Important:** Run from `igris-ai/` (not `mcp-server/`) so tools can find `ai/briefs/`!

### Step 2: Watch for Output

You'll see:

```
Starting MCP inspector...
⚙️  Proxy server listening on localhost:6277
🌐 Inspector running at http://localhost:6274
🔑 Session token: [long hex string]
```

**Key URLs:**
- **Web UI:** http://localhost:6274
- **Proxy:** localhost:6277
- **Auth:** You can set `DANGEROUSLY_OMIT_AUTH=true` to skip auth for local testing

### Step 3: Open in Browser

1. Open http://localhost:6274 in your browser
2. You'll see the MCP Inspector interface
3. Tools should appear in the left sidebar

---

## Using the Inspector UI

### Interface Overview

```
┌─────────────────────────────────────┐
│  MCP Inspector                      │
├──────────────┬──────────────────────┤
│  Tools       │  Tool Details        │
│              │                      │
│  • brief_    │  Name: igris_brief_  │
│    list      │  Description: ...    │
│  • brief_    │  Parameters:         │
│    read      │  - type (optional)   │
│  • brief_    │  - status (optional) │
│    create    │  - priority (opt)    │
│  • session_  │                      │
│    get       │  [Test Tool Button]  │
│  • session_  │                      │
│    update    │  Response:           │
│  • file_     │  {...}               │
│    read      │                      │
└──────────────┴──────────────────────┘
```

### Testing a Tool

**Example: Test `igris_brief_list`**

1. Click `igris_brief_list` in the left sidebar
2. Fill in parameters (optional):
   ```json
   {
     "status": "In Progress"
   }
   ```
3. Click **"Call Tool"** button
4. Watch the response appear!

**Expected Response:**
```json
{
  "content": [
    {
      "type": "text",
      "text": "# Igris Briefs\n\nFound 2 brief(s)\n\n| ID | Title | Priority | Status | Effort |\n|-----|-------|----------|--------|--------|\n| MG-001 | Igris AI as MCP Server Foundation | P0-Critical | In Progress | XL |\n| TD-005 | Automated Testing | P1-High | In Progress | L |"
    }
  ]
}
```

---

## Test Cases

### Test 1: List All Briefs

**Tool:** `igris_brief_list`
**Parameters:** `{}`
**Expected:** Table of all briefs

### Test 2: Filter by Status

**Tool:** `igris_brief_list`
**Parameters:** `{"status": "In Progress"}`
**Expected:** Only "In Progress" briefs

### Test 3: Read Specific Brief

**Tool:** `igris_brief_read`
**Parameters:** `{"brief_id": "MG-001"}`
**Expected:** Full MG-001 brief content

### Test 4: Get Session

**Tool:** `igris_session_get`
**Parameters:** `{}`
**Expected:** Current CURRENT_SESSION.md content

### Test 5: Read File

**Tool:** `igris_file_read`
**Parameters:** `{"path": "ai/session/DECISIONS.md"}`
**Expected:** DECISIONS.md content

### Test 6: Create Brief (Optional - Creates Real Brief!)

**Tool:** `igris_brief_create`
**Parameters:**
```json
{
  "type": "BR",
  "title": "Test brief from MCP inspector",
  "priority": "P3",
  "problem": "Testing brief creation via MCP",
  "goal": "Validate igris_brief_create tool works"
}
```
**Expected:** Success message with new brief ID

---

## Troubleshooting

### Issue: Port Already in Use

**Error:**
```
❌  MCP Inspector PORT IS IN USE at http://localhost:6274 ❌
```

**Fix:**
```bash
# Kill existing inspector
lsof -ti :6274 | xargs kill -9
lsof -ti :6277 | xargs kill -9

# Retry
npx @modelcontextprotocol/inspector node mcp-server/dist/index.js
```

### Issue: Tools Not Found (ENOENT)

**Error:**
```
Error: ENOENT: no such file or directory, scandir '.../mcp-server/ai/briefs'
```

**Fix:** Run from `igris-ai/` root, not `mcp-server/`:
```bash
# ❌ WRONG
cd mcp-server
npx @modelcontextprotocol/inspector node dist/index.js

# ✅ CORRECT
cd /Users/m.elamin/StudioProjects/igris-ai
npx @modelcontextprotocol/inspector node mcp-server/dist/index.js
```

### Issue: Can't Connect in Browser

**Check:**
1. Inspector is running (terminal shows "Inspector running at...")
2. Correct URL: http://localhost:6274 (not 6277!)
3. No firewall blocking localhost

---

## Quick Launch Script

Save this as `test-inspector.sh` in `mcp-server/`:

```bash
#!/bin/bash
# Launch MCP Inspector for Igris AI

echo "🔥 Starting Igris MCP Inspector..."
echo ""
echo "Server will start at: http://localhost:6274"
echo "Proxy at: localhost:6277"
echo ""
echo "Press Ctrl+C to stop"
echo ""

cd /Users/m.elamin/StudioProjects/igris-ai
npx @modelcontextprotocol/inspector node mcp-server/dist/index.js
```

**Usage:**
```bash
chmod +x mcp-server/test-inspector.sh
./mcp-server/test-inspector.sh
```

---

## Disable Auth (Local Testing)

For easier local testing, disable auth:

```bash
DANGEROUSLY_OMIT_AUTH=true npx @modelcontextprotocol/inspector node mcp-server/dist/index.js
```

**Warning:** Only use for local testing! Don't expose publicly without auth.

---

## What to Look For

### ✅ Success Indicators

- All 6 tools appear in left sidebar
- Tool descriptions are clear
- Parameters show correct types (string, enum, etc.)
- Required fields marked
- Tool calls return JSON with `content` array
- No error messages in browser console

### ❌ Failure Indicators

- Tools list empty
- "Connection failed" errors
- Tool calls return `isError: true`
- Browser console shows network errors
- Response is empty or malformed

---

## Next Steps After Validation

1. ✅ **Validated:** Tools work in inspector
2. **Next:** Test with actual MCP client (Claude Code, Desktop UI)
3. **Next:** Add more tools (git ops, brief update, etc.)
4. **Next:** Integrate with Claude Code (MG-002)

---

**Happy Testing, Partner!** 🔥🐒

The inspector is your VISUAL PROOF the MCP server works!
