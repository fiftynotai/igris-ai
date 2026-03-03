# Implementation Plan: BR-048

**Complexity:** M
**Estimated Duration:** 2-3 hours
**Risk Level:** Medium (Issue 1 touches both server and shell script; worker is the production polling mechanism)

## Summary

Fix three known v5 pre-release issues: (1) add missing task lifecycle REST endpoints to the brain server and rewrite the worker daemon to use them, (2) pin `@types/express` to v4 to match the runtime express v4 dependency, and (3) remove version leak from the `/health` endpoint.

## Files to Modify

| File | Action | Changes |
|------|--------|---------|
| `brain-mcp-server/src/index.ts` | MODIFY | Add 4 new REST endpoints, add task handler imports, remove version from `/health` |
| `brain-mcp-server/package.json` | MODIFY | Pin `@types/express` to `^4.17.21` |
| `scripts/igris_worker.sh` | MODIFY | Rewrite `brain_api_call`, `poll_for_task`, `register_instance`, `remove_instance` to use REST endpoints |

## Implementation Steps

### Phase 1: Fix `/health` version leak (Issue 3)

**File:** `brain-mcp-server/src/index.ts` (line 405)

1. Change the `/health` response from `{ status: 'ok', version: '5.0.0' }` to `{ status: 'ok' }`.

**Current code:**
```typescript
app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', version: '5.0.0' });
});
```

**Target code:**
```typescript
app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
});
```

---

### Phase 2: Fix `@types/express` version mismatch (Issue 2)

**File:** `brain-mcp-server/package.json` (line 28)

1. Change `"@types/express": "^5.0.0"` to `"@types/express": "^4.17.21"`.
2. Run `npm install` (or equivalent) in the `brain-mcp-server/` directory to update `package-lock.json`.

**Note:** After pinning to v4 types, verify that the existing Express route handlers still compile without type errors. The v4 types use slightly different generics on `Request`/`Response`, but the current code uses `(req: Request, res: Response)` throughout which is compatible with both.

---

### Phase 3: Add task lifecycle REST endpoints (Issue 1a -- Server Side)

**File:** `brain-mcp-server/src/index.ts`

#### Step 1: Add imports

Add these imports at the top of the file, alongside the existing REST API handler imports (around line 37-41):

```typescript
import { handleTaskNext, handleTaskClaim, handleTaskComplete, handleTaskFail } from './engine/components/tasks/handlers.js';
```

Note: These are already exported from `brain-mcp-server/src/engine/components/tasks/handlers.ts`.

#### Step 2: Add 4 new REST endpoints

Insert after the existing `GET /api/tasks` endpoint (line ~828) and before the agent-event endpoints block (line ~830). Follow the established pattern used by `DELETE /api/instances/:id` -- wrap the existing handler, extract params from `req.body` / `req.params`, and return JSON.

**Endpoint 1: `POST /api/tasks/next`**
- Purpose: Get the next available task (with optional capability filtering and auto-assignment)
- Request body (JSON): `{ capabilities?: string[], agent_name?: string, project_slug?: string, scope?: string, task_type?: string }`
- Maps to: `handleTaskNext({ capabilities, agent: agent_name, project_slug, scope, task_type })`
- Response: The handler returns `ToolResult` with JSON in `content[0].text`. Parse it and return directly as JSON.
- Success: `200` with `{ ok: true, ...parsedResult }` (contains `task` and optionally `assignment`)
- No task found: `200` with `{ ok: true, task: null }`
- Error: `500` with `{ error: message }`

**Important:** The `handleTaskNext` handler accepts `agent` (not `agent_name`). The worker sends `agent_name`, so the REST endpoint must map `req.body.agent_name` to `args.agent`.

```typescript
app.post('/api/tasks/next', express.json(), (req: Request, res: Response) => {
    try {
      const args: Record<string, unknown> = {};
      if (req.body.capabilities) args.capabilities = req.body.capabilities;
      if (req.body.agent_name) args.agent = req.body.agent_name;
      if (req.body.project_slug) args.project_slug = req.body.project_slug;
      if (req.body.scope) args.scope = req.body.scope;
      if (req.body.task_type) args.task_type = req.body.task_type;

      const result = handleTaskNext(args);
      const parsed = JSON.parse(result.content[0].text);
      res.json({ ok: true, ...parsed });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[brain] POST /api/tasks/next error:', message);
      res.status(500).json({ error: message });
    }
});
```

**Endpoint 2: `POST /api/tasks/:id/claim`**
- Purpose: Atomically claim a task for an agent
- Request body: `{ agent: string }`
- Maps to: `handleTaskClaim({ task_id: req.params.id, agent: req.body.agent })`
- Response: `200` with parsed result (contains `task` and `assignment`)
- Validation: Return `400` if `agent` missing from body
- Error: `500` with `{ error: message }` (handler returns errors for not-found, non-pending tasks)

```typescript
app.post('/api/tasks/:id/claim', express.json(), (req: Request, res: Response) => {
    try {
      const agent = req.body.agent as string | undefined;
      if (!agent) {
        res.status(400).json({ error: 'Missing required field: agent' });
        return;
      }
      const result = handleTaskClaim({ task_id: req.params.id, agent });
      const parsed = JSON.parse(result.content[0].text);
      res.json({ ok: true, ...parsed });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[brain] POST /api/tasks/:id/claim error:', message);
      res.status(500).json({ error: message });
    }
});
```

**Endpoint 3: `POST /api/tasks/:id/complete`**
- Purpose: Mark a task as complete
- Request body: `{ result?: string }`
- Maps to: `handleTaskComplete({ task_id: req.params.id, result: req.body.result })`
- Response: `200` with parsed result (contains `task` and `unblocked` array)

```typescript
app.post('/api/tasks/:id/complete', express.json(), (req: Request, res: Response) => {
    try {
      const result = handleTaskComplete({ task_id: req.params.id, result: req.body.result });
      const parsed = JSON.parse(result.content[0].text);
      res.json({ ok: true, ...parsed });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[brain] POST /api/tasks/:id/complete error:', message);
      res.status(500).json({ error: message });
    }
});
```

**Endpoint 4: `POST /api/tasks/:id/fail`**
- Purpose: Mark a task as failed
- Request body: `{ reason: string }`
- Maps to: `handleTaskFail({ task_id: req.params.id, reason: req.body.reason })`
- Validation: Return `400` if `reason` missing from body
- Response: `200` with parsed result (contains `task`)

```typescript
app.post('/api/tasks/:id/fail', express.json(), (req: Request, res: Response) => {
    try {
      const reason = req.body.reason as string | undefined;
      if (!reason) {
        res.status(400).json({ error: 'Missing required field: reason' });
        return;
      }
      const result = handleTaskFail({ task_id: req.params.id, reason });
      const parsed = JSON.parse(result.content[0].text);
      res.json({ ok: true, ...parsed });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[brain] POST /api/tasks/:id/fail error:', message);
      res.status(500).json({ error: message });
    }
});
```

#### Step 3: Add instance heartbeat REST endpoint

The worker also needs `POST /api/instances/heartbeat` to replace the `brain_api_call "igris_instance_heartbeat"` call. This endpoint does NOT currently exist.

**File:** `brain-mcp-server/src/index.ts`

Add import for `handleInstanceHeartbeat` (already imported in the file at line 39 -- BUT only `handleInstanceRemove` is imported currently, NOT `handleInstanceHeartbeat`). Update the import line:

```typescript
import { handleInstanceRemove, handleInstanceHeartbeat } from './tools/instances.js';
```

**Wait -- check:** The import at line 39 only imports `handleInstanceRemove`. Confirm `handleInstanceHeartbeat` is exported from `./tools/instances.js` -- YES, it is exported at line 228 of that file.

Add endpoint after the existing `DELETE /api/instances/:id` (line ~455):

```typescript
app.post('/api/instances/heartbeat', express.json(), (req: Request, res: Response) => {
    try {
      const result = handleInstanceHeartbeat(req.body);
      const text = result.content[0].text;
      // Extract instance ID from response text like "Instance registered: <uuid>"
      const idMatch = text.match(/:\s*(.+)$/);
      const instanceId = idMatch ? idMatch[1].trim() : null;
      res.json({ ok: true, message: text, instance_id: instanceId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[brain] POST /api/instances/heartbeat error:', message);
      res.status(500).json({ error: message });
    }
});
```

**Route ordering note:** This `POST /api/instances/heartbeat` route MUST be registered BEFORE any `POST /api/instances/:id` routes (if they existed), otherwise Express would treat "heartbeat" as a param. Currently there are no `POST /api/instances/:id` routes, so this is safe placed after the DELETE route.

---

### Phase 4: Rewrite worker daemon (Issue 1b -- Client Side)

**File:** `scripts/igris_worker.sh`

#### Step 1: Remove `brain_api_call()` function

Delete the generic `brain_api_call()` function (lines 135-147). It is being replaced by purpose-specific functions.

#### Step 2: Add a generic `brain_rest_call()` helper

Replace with a thin helper that takes method, path, and optional body:

```bash
# Makes an authenticated HTTP request to the brain REST API
# Usage: brain_rest_call <method> <path> [json_body]
# Returns: response body on stdout, exit code 0 on success
brain_rest_call() {
  local method="$1"
  local path="$2"
  local body="${3:-}"

  local url="${REMOTE_BRAIN_URL%/}${path}"
  local curl_args=(-s --connect-timeout 10 --max-time 30 \
    -X "$method" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${REMOTE_BRAIN_API_KEY}")

  if [ -n "$body" ]; then
    curl_args+=(-d "$body")
  fi

  curl "${curl_args[@]}" "$url" 2>/dev/null || return 1
}
```

#### Step 3: Rewrite `poll_for_task()`

Replace the current implementation (lines 151-198) to call `POST /api/tasks/next`:

```bash
# Polls the brain for the next available task matching worker capabilities
# Returns task JSON on stdout if a task is found, empty string otherwise
poll_for_task() {
  local request_body
  request_body=$(python3 -c "
import json, sys
caps = sys.argv[1].split(',')
print(json.dumps({
    'capabilities': caps,
    'agent_name': sys.argv[2]
}))
" "$WORKER_CAPABILITIES" "$WORKER_AGENT_NAME")

  local response
  response=$(brain_rest_call "POST" "/api/tasks/next" "$request_body" 2>/dev/null) || {
    log_error "Failed to poll brain for tasks"
    echo ""
    return 0
  }

  # Check if a task was returned (REST response has { ok: true, task: {...} } or { ok: true, task: null })
  local has_task
  has_task=$(python3 -c "
import json, sys
try:
    data = json.loads(sys.argv[1])
    task = data.get('task')
    if task and (task.get('id') or task.get('task_id')):
        print('yes')
    else:
        print('no')
except Exception:
    print('no')
" "$response" 2>/dev/null) || has_task="no"

  if [ "$has_task" = "yes" ]; then
    echo "$response"
  else
    echo ""
  fi
}
```

#### Step 4: Rewrite `extract_task_id()`

Simplify since the REST response is now a flat JSON object (not nested in MCP ToolResult):

```bash
# Extracts the task ID from a REST API response JSON
# Usage: extract_task_id <response_json>
extract_task_id() {
  local response="$1"
  python3 -c "
import json, sys
try:
    data = json.loads(sys.argv[1])
    task = data.get('task', {})
    print(task.get('id', ''))
except Exception:
    print('')
" "$response" 2>/dev/null || echo ""
}
```

#### Step 5: Rewrite `extract_task_type()`

Same simplification:

```bash
# Extracts the task type from a REST API response JSON
# Usage: extract_task_type <response_json>
extract_task_type() {
  local response="$1"
  python3 -c "
import json, sys
try:
    data = json.loads(sys.argv[1])
    task = data.get('task', {})
    print(task.get('task_type', 'dev'))
except Exception:
    print('dev')
" "$response" 2>/dev/null || echo "dev"
}
```

#### Step 6: Rewrite `register_instance()`

Replace to use `POST /api/instances/heartbeat`:

```bash
# Registers this worker instance with the brain via heartbeat
register_instance() {
  local hostname_val
  hostname_val=$(hostname)
  local os_val
  os_val=$(uname -s | tr '[:upper:]' '[:lower:]')

  local capabilities_json
  capabilities_json=$(python3 -c "
import json, sys
caps = sys.argv[1].split(',')
print(json.dumps(caps))
" "$WORKER_CAPABILITIES")

  local body
  body=$(python3 -c "
import json, sys
print(json.dumps({
    'machine_hostname': sys.argv[1],
    'machine_os': sys.argv[2],
    'project_slug': 'igris-worker',
    'capabilities': json.loads(sys.argv[3])
}))
" "$hostname_val" "$os_val" "$capabilities_json")

  brain_rest_call "POST" "/api/instances/heartbeat" "$body" > /dev/null 2>&1 || {
    log_error "Failed to register instance heartbeat"
    return 0
  }

  log "Instance registered (hostname=$hostname_val, os=$os_val, capabilities=$WORKER_CAPABILITIES)"
}
```

#### Step 7: Rewrite `remove_instance()`

Replace to use `DELETE /api/instances/:id`. However, the current implementation uses `machine_hostname` to identify the instance, while the REST endpoint uses `instance_id`. Two options:

**Option A (Recommended):** Store the instance_id returned from the heartbeat response and use it for removal. This requires capturing the response from `register_instance()` and storing the ID in a global variable.

```bash
# Global variable to track our registered instance ID
WORKER_INSTANCE_ID=""

# Updated register_instance() — stores the returned instance_id
register_instance() {
  # ... (same body construction as Step 6) ...

  local response
  response=$(brain_rest_call "POST" "/api/instances/heartbeat" "$body" 2>/dev/null) || {
    log_error "Failed to register instance heartbeat"
    return 0
  }

  # Extract and store the instance_id from the response
  local instance_id
  instance_id=$(python3 -c "
import json, sys
try:
    data = json.loads(sys.argv[1])
    print(data.get('instance_id', ''))
except Exception:
    print('')
" "$response" 2>/dev/null) || instance_id=""

  if [ -n "$instance_id" ]; then
    WORKER_INSTANCE_ID="$instance_id"
  fi

  log "Instance registered (id=$WORKER_INSTANCE_ID, hostname=$hostname_val, os=$os_val)"
}

# Removes this worker instance from the brain registry on shutdown
remove_instance() {
  if [ -z "$WORKER_INSTANCE_ID" ]; then
    log "No instance ID stored, skipping removal"
    return 0
  fi

  brain_rest_call "DELETE" "/api/instances/${WORKER_INSTANCE_ID}" > /dev/null 2>&1 || {
    log_error "Failed to remove instance from brain"
    return 0
  }

  log "Instance removed from brain registry (id=$WORKER_INSTANCE_ID)"
}
```

---

### Phase 5: Build and verify

1. Run `cd brain-mcp-server && npm run build` to verify TypeScript compiles cleanly after:
   - New handler imports
   - New REST endpoints
   - `@types/express` v4 pinning
2. Run `cd brain-mcp-server && npm test` to verify no existing tests break.
3. Manually test with `curl`:
   - `curl http://localhost:3001/health` -- should return `{ "status": "ok" }` (no version)
   - `curl -X POST http://localhost:3001/api/tasks/next -H "Authorization: Bearer ..." -H "Content-Type: application/json" -d '{"capabilities":["code"]}'` -- should return `{ "ok": true, "task": null }` (no tasks pending)
   - `curl -X POST http://localhost:3001/api/instances/heartbeat -H "Authorization: Bearer ..." -H "Content-Type: application/json" -d '{"machine_hostname":"test"}'` -- should return `{ "ok": true, "instance_id": "..." }`

## Testing Strategy

### Automated Tests

No new test files are strictly required since the underlying handler functions (`handleTaskNext`, `handleTaskClaim`, etc.) are already tested through the engine component tests. The REST endpoints are thin wrappers that parse/format.

However, if desired, integration tests can be added for the REST layer in a future brief.

### Manual Verification

| Test | Command | Expected |
|------|---------|----------|
| Health no version | `curl localhost:3001/health` | `{"status":"ok"}` -- no `version` field |
| Tasks next (empty) | `POST /api/tasks/next` with `{}` | `{"ok":true,"task":null,"message":"..."}` |
| Tasks next (with caps) | `POST /api/tasks/next` with `{"capabilities":["code"]}` | `{"ok":true,"task":null,...}` or task object |
| Task claim (missing agent) | `POST /api/tasks/t-xxx/claim` with `{}` | `400 {"error":"Missing required field: agent"}` |
| Task complete | `POST /api/tasks/t-xxx/complete` with `{}` | 200 with task or 500 if not found |
| Task fail (missing reason) | `POST /api/tasks/t-xxx/fail` with `{}` | `400 {"error":"Missing required field: reason"}` |
| Instance heartbeat | `POST /api/instances/heartbeat` with `{"machine_hostname":"test"}` | `{"ok":true,"instance_id":"..."}` |
| Worker start | `./scripts/igris_worker.sh start` | Polls `/api/tasks/next`, registers via `/api/instances/heartbeat` |
| Worker stop | `./scripts/igris_worker.sh stop` | Deregisters via `DELETE /api/instances/:id` |
| TypeScript build | `npm run build` | Clean compilation with `@types/express@^4` |

### Build Verification

- `cd brain-mcp-server && npm install && npm run build` -- must compile cleanly
- `cd brain-mcp-server && npm test` -- all existing tests must pass

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `@types/express` v4 type incompatibilities | Low | Medium | The codebase uses basic `Request`/`Response` types without advanced generics; v4 types are a superset of what's used |
| Route ordering conflict for `/api/tasks/:id/claim` vs `/api/tasks/next` | Medium | High | Register `POST /api/tasks/next` BEFORE `POST /api/tasks/:id/*` routes, so Express matches `/next` literally rather than treating it as an `:id` param |
| Worker shell script regression -- untested changes | Medium | Medium | The worker is not yet deployed in production; manual testing is sufficient for now |
| Instance ID not captured from heartbeat response | Low | Low | The `handleInstanceHeartbeat` response text has a known format (`"Instance registered: <uuid>"` or `"Instance heartbeat updated: <uuid>"`); parsing with regex is reliable. The REST endpoint also returns `instance_id` as a dedicated field. |
| Handler error results returned as 200 | Low | Low | The `handleTaskNext` etc. return `successResult` even for "not found" cases (e.g., `{ task: null }`). Only true exceptions throw. For `handleTaskClaim`/`handleTaskFail`, `errorResult` throws on missing task, which the `catch` block handles as 500. Consider parsing `isError` on the result for 4xx responses in a future pass. |

## Endpoint Summary

After implementation, the brain server will have these task lifecycle REST endpoints:

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `GET` | `/api/tasks` | List tasks with filters (already exists) | Yes |
| `POST` | `/api/tasks/next` | Get next available task | Yes |
| `POST` | `/api/tasks/:id/claim` | Atomically claim a task | Yes |
| `POST` | `/api/tasks/:id/complete` | Mark task as complete | Yes |
| `POST` | `/api/tasks/:id/fail` | Mark task as failed | Yes |
| `POST` | `/api/instances/heartbeat` | Register/update instance | Yes |
| `DELETE` | `/api/instances/:id` | Remove instance (already exists) | Yes |
