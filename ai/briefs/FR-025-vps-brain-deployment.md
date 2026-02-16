# FR-025: Deploy Brain MCP Server to VPS

**Type:** Feature Request
**Priority:** P1-High
**Effort:** S-Small (< 2h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-16

---

## Feature Description

**What is the proposed feature?**

Deploy the Igris Brain MCP Server (with HTTP transport from FR-022) to the VPS at `root@76.13.180.77`. Set up Node.js, PM2, the brain database, and configure the server to run persistently. Generate an API key and configure the local machine to connect remotely.

**Why is this valuable?**

Makes the Igris brain accessible from any machine. Single source of truth for learnings, errors, metrics, briefs, and sessions — all stored centrally on the VPS.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:** Brain data is local-only at `~/.igris/memory/knowledge.db`. No remote access.

**With this feature:** Brain runs on VPS, accessible from any Claude Code session via HTTP.

---

## Technical Approach

### High-Level Design

SSH into `root@76.13.180.77`, install prerequisites (Node.js 20+, PM2), copy the brain-mcp-server code, build it, generate an API key, start with PM2, and configure the local `~/.claude.json` to connect.

### Steps

1. SSH into VPS, install Node.js 20+ and PM2
2. Create `~/.igris/memory/` directory structure on VPS
3. Copy `brain-mcp-server/` to VPS via scp
4. Run `npm ci && npm run build` on VPS
5. Generate API key, create `~/.igris/brain.env`
6. Start server with PM2: `--http --port 3001`
7. Verify health endpoint: `curl http://76.13.180.77:3001/health`
8. Update local `~/.claude.json` with remote brain config
9. Test a brain tool call from local machine

### Components Affected
- VPS: `root@76.13.180.77` — new service installed
- Local: `~/.claude.json` — add remote `igris-brain` MCP server config

---

## Context & Inputs

### Dependencies
- [x] FR-022: VPS Remote Brain HTTP Transport (DONE)

### VPS Details
- **IP:** 76.13.180.77
- **User:** root
- **Target port:** 3001

---

## Constraints

### Technical Constraints
- VPS must have Node.js 20+ (install if missing)
- PM2 for process management
- API key auth required (no open endpoints)
- No Nginx needed initially (direct port access is fine for single-user)

### Out of Scope
- TLS/Nginx setup (can add later)
- Domain name configuration
- Local/remote brain sync (that's FR-023)

---

## Tasks

### Done
- [x] SSH into VPS, check/install Node.js 20+ and PM2
- [x] Create brain directory structure on VPS
- [x] Copy and build brain-mcp-server on VPS
- [x] Generate API key and create brain.env
- [x] Start server with PM2
- [x] Verify health endpoint from local machine
- [x] Update local ~/.claude.json with remote brain config
- [x] Test brain tool call from local

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Current Work
Done. All acceptance criteria met.

### Next Steps
None — brief complete.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-16 | orchestrator | VPS recon | SSH OK, Ubuntu 6.8.0, Git 2.43, no Node/PM2/igris, 176GB disk, 13GB RAM |
| 2026-02-16 | orchestrator | Install Node.js 20 + PM2 | Node 20.20.0, PM2 6.0.14 installed |
| 2026-02-16 | orchestrator | Clone repo + deploy | igris_brain_deploy.sh SUCCESS, PM2 running |
| 2026-02-16 | orchestrator | Fix PM2 env_file bug | Rewrote ecosystem.config.cjs with fs-based env parsing |
| 2026-02-16 | orchestrator | Init VPS DB schema | Applied igris_brain_schema.sql (v3, 16 tables) |
| 2026-02-16 | orchestrator | Verify all acceptance criteria | 5/5 PASS — health, auth, local config, remote tool call |

### Blockers
None

---

## Acceptance Criteria

1. [x] Brain MCP server running on VPS via PM2
2. [x] Health endpoint accessible: `curl http://76.13.180.77:3001/health`
3. [x] API key auth working (401 without key, 200 with key)
4. [x] Local `~/.claude.json` configured with remote brain
5. [x] At least one brain tool works remotely (e.g., `igris_project_list`)

---

## Test Plan

### Functional Tests
**Test Case 1: Health Check**
1. `curl http://76.13.180.77:3001/health`
**Expected Result:** `{"status":"ok","version":"4.0.0"}`

**Test Case 2: Auth Rejection**
1. `curl -X POST http://76.13.180.77:3001/mcp` (no auth header)
**Expected Result:** 401 Unauthorized

**Test Case 3: Remote Tool Call**
1. Use Claude Code locally with remote brain configured
2. Call `igris_project_list`
**Expected Result:** Returns project list from VPS brain

---

## Delivery

- [x] Brain server running on VPS with PM2
- [x] Local machine configured to connect
- [x] API key securely stored on VPS

---

## Notes

**Depends on:** FR-022 (Done)
**Blocks:** Nothing directly, but enables FR-023 and FR-024

---

**Created:** 2026-02-16
**Last Updated:** 2026-02-16
**Brief Owner:** Crimson (Fifty.ai)
