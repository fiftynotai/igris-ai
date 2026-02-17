# FR-033: Fix igris-brain HTTP MCP Transport — Tools Not Loading in Claude Code

**Type:** Feature Request
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Ready
**Created:** 2026-02-17

---

## Feature Description

**What is the proposed feature?**

Diagnose and fix why the `igris-brain` HTTP MCP server's tools don't load in Claude Code despite the server being reachable and correctly configured. The VPS brain server at `http://76.13.180.77:3001/mcp` responds to initialization handshakes (SSE) and all REST API endpoints work, but Claude Code never surfaces its MCP tools (`igris_instance_heartbeat`, `igris_brain_push`, `igris_memory_store`, etc.) in ToolSearch.

**Why is this valuable?**

Without MCP tools loading, the entire brain integration pipeline is broken at the orchestration layer. Instance registration (FR-032), memory recall, brain push/pull, and all cross-project features depend on these tools being available in Claude Code sessions. Currently everything works only via direct curl/API calls, defeating the purpose of MCP integration.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
- `igris-brain` is configured in `~/.claude.json` as `"type": "http"` pointing to VPS
- VPS server responds to `POST /mcp` initialize (returns SSE with server info)
- VPS REST APIs all work (`/api/instances`, `/api/brain-stats`, `/sync/push`, etc.)
- But `ToolSearch` for `igris_instance`, `igris_brain`, `igris_memory` returns zero brain tools
- Only the local `igris-ai` MCP server tools (brief/session) appear
- All brain features (instance registration, memory, sync) are unreachable from orchestrator
- FR-032 skill changes are correct but can never fire because the tools don't load

**With this feature:**
- `igris-brain` HTTP MCP tools load on session start
- All brain tools available via ToolSearch (`igris_instance_heartbeat`, `igris_brain_push`, etc.)
- FR-032 instance registration works end-to-end via /awaken
- Memory recall, error lookup, metrics, sync all functional
- Live Instances dashboard populated automatically

---

## Use Cases

### Use Case 1: Brain Tools Available on Session Start
**Actor:** Developer running `/awaken`
**Goal:** Brain MCP tools loaded and callable
**Steps:**
1. Start Claude Code session
2. Run `/awaken`
3. Step 3.7 calls `igris_instance_heartbeat` (requires tool to be loaded)
4. Instance appears on dashboard
**Expected Outcome:** Tool is available, instance registered, dashboard shows it

### Use Case 2: Brain Push After Implementation
**Actor:** Developer completing a `/hunt` workflow
**Goal:** Push learnings and metrics to VPS brain
**Steps:**
1. Complete a brief implementation
2. Call `igris_brain_push` to sync to VPS
3. VPS brain receives data
**Expected Outcome:** `igris_brain_push` tool is available and sync succeeds

---

## Technical Approach

### Investigation Areas

**Area 1: HTTP MCP Transport Compatibility**
- Claude Code's HTTP MCP client may expect specific response formats
- VPS server returns SSE (`event: message\ndata: {...}`) for initialize
- Check if Claude Code's HTTP MCP client handles SSE correctly
- Check if `Accept: application/json, text/event-stream` header is sent by Claude Code
- The VPS rejects requests without this Accept header (`406 Not Acceptable`)

**Area 2: Session Lifecycle**
- The VPS MCP server requires session initialization before tool listing
- Error without session: `"Session expired. Send an initialize request to start a new session."`
- Claude Code may be failing silently on initialization and never reaching `tools/list`
- Check Claude Code logs for MCP connection errors

**Area 3: MCP Server Configuration**
- Current config in `~/.claude.json`:
  ```json
  {
    "igris-brain": {
      "type": "http",
      "url": "http://76.13.180.77:3001/mcp",
      "headers": {
        "Authorization": "Bearer <api_key>"
      }
    }
  }
  ```
- Verify `type: "http"` is correct (vs `"streamableHttp"` or `"sse"`)
- Check if Claude Code supports HTTP MCP with Bearer auth headers
- Check if there's a `"type": "streamable-http"` option needed

**Area 4: VPS Server Implementation**
- Server uses `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk`
- May need to verify compatibility with Claude Code's MCP client version
- Check if the server needs CORS headers or other transport-level config

### Components Affected
- `~/.claude.json` — MCP server configuration (may need type/format changes)
- `brain-mcp-server/src/index.ts` — Server transport config (may need adjustments)
- VPS deployment — May need server restart with updated config

---

## Context & Inputs

### Dependencies
- [x] VPS brain server running (confirmed reachable)
- [x] `~/.claude.json` has igris-brain entry (confirmed)
- [x] MCP SDK (`@modelcontextprotocol/sdk`) installed on VPS

### Diagnostic Evidence
```
# Initialize works via curl:
POST /mcp → 200 OK, SSE response with server info

# But needs specific Accept header:
Without "Accept: application/json, text/event-stream" → 406 Not Acceptable

# Session required for tools:
tools/list without session → "Session expired"

# Claude Code behavior:
ToolSearch "+igris instance" → returns only igris-ai tools, zero brain tools
```

### Files to Investigate
- `~/.claude.json` — MCP server config format
- `brain-mcp-server/src/index.ts` — Transport setup (lines ~1096-1230)
- Claude Code MCP client logs (if accessible)
- `brain-mcp-server/package.json` — SDK version

### Files to Potentially Modify
- `~/.claude.json` — Fix MCP server type/config
- `brain-mcp-server/src/index.ts` — Fix transport compatibility
- VPS deployment scripts — If server changes needed

---

## Constraints

### Technical Constraints
- Must not break existing REST API endpoints (`/api/*`, `/sync/*`)
- Must maintain Bearer auth for all MCP connections
- Must work over public internet (VPS to local)
- Should not require Claude Code restart for every session

### Out of Scope
- Migrating to local-only MCP server (the HTTP transport is intentional for VPS)
- Adding new brain tools (just fix loading of existing ones)
- Changing the dashboard or API endpoints

---

## Tasks

### Pending
- [ ] Check Claude Code logs for MCP connection errors on startup
- [ ] Verify correct `type` field in `~/.claude.json` (`http` vs `streamable-http` vs `sse`)
- [ ] Test with `streamableHttp` type if supported
- [ ] Check MCP SDK version compatibility between Claude Code client and VPS server
- [ ] Check if VPS server needs CORS or transport-level headers
- [ ] Fix configuration or server to establish connection
- [ ] Verify tools load in ToolSearch after fix
- [ ] Test full flow: /awaken → instance registered → dashboard shows it

---

## Workflow State

**Phase:** INIT
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered. Ready for investigation and HUNT.

### Next Steps
Run `/hunt FR-033` to begin investigation.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|

### Blockers
None

---

## Acceptance Criteria

1. [ ] `igris-brain` MCP tools appear in ToolSearch on session start
2. [ ] `igris_instance_heartbeat` callable from Claude Code session
3. [ ] `igris_brain_push` callable from Claude Code session
4. [ ] `igris_memory_store` and `igris_memory_recall` callable
5. [ ] Full /awaken → instance registration → dashboard visibility flow works
6. [ ] Connection survives long sessions (no mid-session disconnects)
7. [ ] Graceful error if VPS unreachable (timeout, not hang)

---

## Test Plan

### Functional Tests

**Test Case 1: Tools Load on Session Start**
1. Start new Claude Code session
2. Run `ToolSearch "+igris instance"`
3. Expect: `igris_instance_heartbeat` appears in results
**Expected Result:** Brain MCP tools loaded and searchable

**Test Case 2: Instance Registration via MCP**
1. Call `igris_instance_heartbeat` with hostname, OS, project
2. Query local DB: `SELECT * FROM instances WHERE status='active'`
3. Call `igris_brain_push` to sync to VPS
4. Check VPS: `curl /api/instances`
**Expected Result:** Instance visible on dashboard

**Test Case 3: Graceful Failure**
1. Stop VPS brain server
2. Start Claude Code session
3. Verify session starts without hanging
**Expected Result:** Session starts, brain tools unavailable, no crash

---

## Delivery

- [ ] Fixed `~/.claude.json` config or VPS server transport
- [ ] Verified tools load in Claude Code
- [ ] Documented correct MCP server configuration for HTTP transport

---

## Notes

**Root Cause Hypothesis:**
Most likely the `type: "http"` config in `~/.claude.json` doesn't match what Claude Code expects for Streamable HTTP transport. The server uses `StreamableHTTPServerTransport` which returns SSE responses. Claude Code may need `"type": "streamable-http"` or a different transport identifier. Alternatively, the `Accept` header requirement (`application/json, text/event-stream`) may not be sent by Claude Code's MCP client.

**Key Diagnostic:**
```
# Server requires this header:
Accept: application/json, text/event-stream

# Without it → 406 Not Acceptable
# This is likely where Claude Code's connection fails silently
```

**Depends on:** FR-022 (HTTP transport — Done), FR-032 (skill language — Done)
**Blocks:** Full brain integration pipeline

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Crimson (Fifty.ai)
