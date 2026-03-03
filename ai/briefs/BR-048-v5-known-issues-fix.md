# BR-048: Fix v5 Known Issues Before Release

**Type:** Bug Fix
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Ready
**Created:** 2026-03-04

---

## Problem

**What's broken or missing?**

Three known issues identified during the v5 release audit:

### Issue 1: Worker daemon cannot communicate with brain server (CRITICAL)

`scripts/igris_worker.sh` calls `POST /api/tools/<tool_name>` in its `brain_api_call()` function, but this endpoint **does not exist** on the brain server. The server only exposes MCP tools via:
- `POST /mcp` (JSON-RPC / MCP Streamable HTTP protocol)
- stdio (when running as MCP server)

This means the worker daemon **cannot poll for tasks, claim tasks, or report results**. The entire worker execution pipeline is broken.

### Issue 2: `@types/express@^5` with `express@^4` version mismatch (LOW)

`brain-mcp-server/package.json` has `express@^4.21.0` but `@types/express@^5.0.0`. Express 5 types may introduce incompatibilities with Express 4 runtime. Currently compiles clean but is a latent risk.

### Issue 3: `/health` endpoint leaks server version without auth (LOW)

`GET /health` returns `{ status: "ok", version: "5.0.0" }` with no authentication required. Minor information disclosure.

**Why does it matter?**

Issue 1 is a complete blocker for the autonomous worker feature (FR-065). The worker daemon is a headline v5 feature and currently non-functional. Issues 2-3 are low severity but should be fixed for a clean release.

---

## Goal

1. Worker daemon can successfully poll, claim, execute, and complete tasks against the brain server
2. Express types aligned with Express runtime version
3. Health endpoint does not leak version to unauthenticated requests

---

## Context & Inputs

### Affected Modules
- [x] `scripts/igris_worker.sh` — worker daemon
- [x] `brain-mcp-server/package.json` — dependency versions
- [x] `brain-mcp-server/src/index.ts` — health endpoint

### Related Files
- `scripts/igris_worker.sh` — `brain_api_call()` function and `poll_for_task()` / `complete_task()` / `fail_task()`
- `brain-mcp-server/src/index.ts` — REST route definitions, health endpoint
- `brain-mcp-server/package.json` — express and @types/express versions

---

## Tasks

### Issue 1: Fix worker daemon API communication

The worker needs to communicate with the brain server. Two approaches:

**Option A (Recommended): Use existing REST endpoints**
The brain server already has REST endpoints for the operations the worker needs:
- Poll for tasks: `GET /api/tasks?status=pending&limit=1` (exists) — but no capability filtering
- Need to add: `POST /api/tasks/:id/claim` REST endpoint
- Complete task: Could use MCP via HTTP or add `POST /api/tasks/:id/complete`
- Fail task: Could add `POST /api/tasks/:id/fail`

**Option B: Use MCP Streamable HTTP**
The worker could call `POST /mcp` with JSON-RPC payloads to invoke MCP tools. This would work with all 67 tools but requires building JSON-RPC request formatting in bash.

### Pending
- [ ] Audit `igris_worker.sh` to identify all `brain_api_call` usages and what MCP tools they map to
- [ ] Add REST endpoints for task operations: `POST /api/tasks/next`, `POST /api/tasks/:id/claim`, `POST /api/tasks/:id/complete`, `POST /api/tasks/:id/fail`
- [ ] Update `igris_worker.sh` to use the new REST endpoints
- [ ] Test worker start → poll → claim → complete cycle end-to-end

### Issue 2: Align Express types
- [ ] Pin `@types/express` to `^4.17.21` in `brain-mcp-server/package.json`
- [ ] Run `npm install` to update lock file
- [ ] Verify `npm run build` still passes

### Issue 3: Sanitize health endpoint
- [ ] Change `/health` to return `{ status: "ok" }` without version
- [ ] Or add version only when authenticated

---

## Acceptance Criteria

1. [ ] Worker daemon starts, polls brain server, receives task response
2. [ ] Worker can claim a task via REST API
3. [ ] Worker can report task completion via REST API
4. [ ] Worker can report task failure via REST API
5. [ ] `@types/express` version matches `express` major version
6. [ ] `npm run build` passes after type alignment
7. [ ] `/health` does not expose version to unauthenticated requests
8. [ ] All 223 existing vitest tests still pass

---

## Test Plan

### Manual Test: Worker E2E
1. Create a task via MCP: `igris_task_create` with type=dev
2. Start worker: `./scripts/igris_worker.sh start`
3. Worker should poll and find the task
4. Worker should claim and attempt to execute
5. Stop worker: `./scripts/igris_worker.sh stop`
6. Verify task status changed in brain

### Automated
- [ ] `npm run build` — TypeScript compiles
- [ ] `npm test` — 223 tests pass
- [ ] `curl /health` — no version field

---

**Created:** 2026-03-04
**Brief Owner:** Igris AI
