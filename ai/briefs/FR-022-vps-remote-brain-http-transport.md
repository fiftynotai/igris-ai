# FR-022: VPS Remote Brain — HTTP Transport + API Key Auth

**Type:** Feature Request
**Priority:** P1-High
**Effort:** S-Small (< 4h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** In Progress
**Created:** 2026-02-16

---

## Feature Description

**What is the proposed feature?**

Add HTTP transport to the brain-mcp-server so it can run on a VPS and be accessed remotely from any machine running Claude Code. The existing stdio transport stays for local use. Simple API key auth protects the remote endpoint.

**Why is this valuable?**

Enables accessing Igris brain (learnings, errors, metrics, briefs, sessions) from any machine — not just the one with `~/.igris/` on disk. Single source of truth on the VPS.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
Brain data is locked to a single machine at `~/.igris/memory/knowledge.db`. Working from a different computer means no access to learnings, error solutions, or session history.

**With this feature:**
Any machine with Claude Code can connect to the brain on the VPS via HTTP. Full access to all 16 MCP tools remotely.

---

## Use Cases

### Use Case 1: Remote Development
**Actor:** Developer on a second machine
**Goal:** Access Igris brain tools from any location
**Steps:**
1. Configure Claude Code with VPS brain URL + API key
2. Use Claude Code normally — all `igris_*` tools hit the remote brain
3. Learnings, errors, metrics all stored centrally on VPS

**Expected Outcome:** All brain tools work identically to local, just over HTTP.

### Use Case 2: Local Fallback
**Actor:** Developer on primary machine
**Goal:** Keep fast local access when on the main machine
**Steps:**
1. Primary machine still uses stdio transport (local `~/.igris/`)
2. Remote machines use HTTP transport
3. Both modes coexist — configured per-machine in `~/.claude.json`

**Expected Outcome:** No performance regression on primary machine.

---

## Technical Approach

### High-Level Design

Add a `--http` CLI flag to `brain-mcp-server`. When set, it starts an Express server with `StreamableHTTPServerTransport` from MCP SDK v1.26.0 instead of stdio. API key auth via Bearer token middleware.

The MCP SDK already includes Express as a dependency. All 16 tool handlers remain unchanged — only the transport layer changes.

### Components Affected
- `brain-mcp-server/src/index.ts` — Add HTTP transport mode, Express routes, API key middleware
- `brain-mcp-server/package.json` — Add `start:http` script
- `scripts/igris_brain_deploy.sh` — New deployment script for VPS

### API/Interface Design

**Server startup:**
```bash
# Local (unchanged)
node dist/index.js

# Remote (new)
node dist/index.js --http --port 3001
# or
BRAIN_HTTP=1 BRAIN_PORT=3001 BRAIN_API_KEY=your-secret node dist/index.js
```

**Claude Code config (remote machine):**
```json
{
  "mcpServers": {
    "igris-brain": {
      "url": "https://your-vps.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}
```

---

## Context & Inputs

### Dependencies
- [x] Existing: `@modelcontextprotocol/sdk` v1.26.0 (already includes Express + StreamableHTTPServerTransport)
- [ ] New: None required (Express already bundled in SDK)

### Files to Create
- `scripts/igris_brain_deploy.sh` — VPS deployment helper

### Files to Modify
- `brain-mcp-server/src/index.ts` — Dual transport support
- `brain-mcp-server/package.json` — Add `start:http` script

### Configuration Changes
- [ ] Environment variables: `BRAIN_HTTP`, `BRAIN_PORT`, `BRAIN_API_KEY`

---

## Constraints

### Technical Constraints
- Must not break existing stdio transport (default mode)
- API key auth is sufficient for single-user VPS (no OAuth needed)
- VPS needs Node.js 20+ and Nginx for HTTPS termination
- All tool handlers must work identically in both modes

### Out of Scope
- OAuth/multi-user auth (single developer use case)
- Database replication/sync (that's FR-023)
- Automatic deployment pipeline (that's FR-024)

---

## Tasks

### Pending
- [ ] Add CLI flag parsing (`--http`, `--port`)
- [ ] Add Express server with StreamableHTTPServerTransport
- [ ] Add API key Bearer token middleware
- [ ] Add session management (stateful mode)
- [ ] Update package.json with `start:http` script
- [ ] Create VPS deployment script
- [ ] Test all 16 tools via HTTP transport

---

## Workflow State

**Phase:** COMMITTING
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered, awaiting implementation.

### Next Steps
Proceed to PLANNING phase.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|

### Blockers
None

---

## Acceptance Criteria

1. [ ] Server starts in HTTP mode with `--http` flag
2. [ ] All 16 MCP tools work over HTTP transport
3. [ ] API key auth rejects unauthorized requests (401)
4. [ ] Stdio mode still works as default (no regression)
5. [ ] Session management works (stateful connections)
6. [ ] Deployment script sets up VPS with PM2 + Nginx

---

## Test Plan

### Functional Tests
**Test Case 1: HTTP Transport**
1. Start server with `--http --port 3001`
2. Send MCP init request via curl
3. Call `igris_memory_search` tool via HTTP
**Expected Result:** Tool returns results over HTTP

**Test Case 2: Auth Rejection**
1. Start server with `BRAIN_API_KEY=secret`
2. Send request without Authorization header
**Expected Result:** 401 Unauthorized

**Test Case 3: Stdio Unchanged**
1. Start server without `--http` flag
2. Verify stdio transport works as before
**Expected Result:** No regression

---

## Delivery

- [ ] Updated brain-mcp-server with HTTP transport
- [ ] VPS deployment script
- [ ] Configuration examples in README

---

## Notes

**Key insight:** MCP SDK v1.26.0 bundles Express and StreamableHTTPServerTransport. The transport is a thin layer — all tool handler code stays identical. This is why effort is S-Small.

**Depends on:** None
**Blocks:** FR-023 (Sync), FR-024 (GitHub Updates)

---

**Created:** 2026-02-16
**Last Updated:** 2026-02-16
**Brief Owner:** Crimson (Fifty.ai)
