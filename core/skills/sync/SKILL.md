---
name: sync
description: Deploy code and/or data to VPS brain - usage: /sync [code|data|all|status]
disable-model-invocation: false
allowed-tools:
  - Read
  - Bash
  - Grep
  - Edit
  - mcp__igris-brain__igris_brief_sync
  - mcp__igris-brain__igris_brief_create
triggers:
  - "SYNC"
  - "sync to vps"
  - "sync brain"
  - "deploy to vps"
  - "push to vps"
---

# SYNC - VPS Brain Deployment

Deploy code and/or data to the VPS brain server.

## Usage

```
/sync              -- Full sync (code + data), default
/sync code         -- Git push + VPS deploy only
/sync data         -- Brain data push only
/sync all          -- Explicit full sync (same as default)
/sync status       -- Show VPS health and last sync info
```

## Arguments

`$ARGUMENTS` determines the sync mode:
- Empty or `all`: Run code sync then data sync
- `code`: Code deployment only
- `data`: Brain data push only
- `status`: Health check and status display only

## Execution

### 0. Track Invocation
Silently emit a skill invocation event (never blocks execution):
```bash
bash "$CLAUDE_PROJECT_DIR/scripts/emit_skill_event.sh" "sync" 2>/dev/null || true
```

### Step 1: Load Configuration

Read `~/.igris/config.json` and extract:
- `vps.host` -- VPS server address
- `vps.user` -- SSH user
- `vps.repo_path` -- Remote repository path
- `vps.brain_path` -- Remote brain path
- `remote_brain.url` -- Remote brain API URL
- `remote_brain.api_key` -- Remote brain API key

**Validation:**
- If `vps` section is missing and mode is `code` or `all`:
  ```
  ERROR: VPS configuration not found in ~/.igris/config.json

  Add a "vps" section with host, user, repo_path, and brain_path.
  Example:
    "vps": {
      "host": "your.server.ip",
      "user": "root",
      "repo_path": "/root/igris-ai",
      "brain_path": "/root/.igris"
    }
  ```
  Stop execution.

- If `remote_brain` section is missing and mode is `data` or `all`:
  ```
  ERROR: Remote brain configuration not found in ~/.igris/config.json

  Add a "remote_brain" section with url and api_key.
  Example:
    "remote_brain": {
      "url": "http://your.server:3001",
      "api_key": "your-api-key"
    }
  ```
  Stop execution.

### Step 2: Pre-flight Checks (code and all modes only)

Skip this step if mode is `data` or `status`.

1. Run `git status --porcelain` in the project directory.
   - If there are uncommitted changes: display the list and warn the user.
     ```
     WARNING: Uncommitted changes detected:
     [list of files]

     These changes will NOT be deployed. Continue anyway? (y/n)
     ```
   - Wait for user confirmation before proceeding. If user declines, abort.

2. Detect current branch: `git rev-parse --abbrev-ref HEAD`

3. Run `git log origin/{branch}..HEAD --oneline` to count unpushed commits.
   - Display: `Found X unpushed commit(s) on branch {branch}`
   - If 0 unpushed commits and mode is `code`: warn that there is nothing new to push but continue (VPS deploy script may still update).

### Step 3: Code Sync (code and all modes)

Skip this step if mode is `data` or `status`.

Execute these steps sequentially, displaying progress:

**[1/4] Pushing to origin...**
- Run: `git push origin {branch}`
- On failure: display the error message.
  - If mode is `all`: ask user if they want to continue with data sync only.
  - If mode is `code`: abort with error.

**[2/4] SSH deploy to VPS...**
- Run: `ssh -o ConnectTimeout=30 {vps.user}@{vps.host} "cd {vps.repo_path} && bash scripts/igris_vps_update.sh --branch {branch}"`
- On failure: display clear error about SSH connectivity or deploy script failure.
  - If mode is `all`: ask user if they want to continue with data sync.
  - If mode is `code`: abort with error.

**[3/4] Health check...**
- Extract port from `remote_brain.url` if available (parse the URL), default to 3001.
- Run: `ssh -o ConnectTimeout=30 {vps.user}@{vps.host} "curl -s http://127.0.0.1:{port}/health"`
- Parse the JSON response for status and version fields.
- On success: display health status and version.
- On failure: display WARNING but do NOT abort. The deploy may still be starting up.
  ```
  WARNING: Health check failed. The service may still be starting up.
  Try again in a few seconds: /sync status
  ```

**[4/4] Code sync summary**
- Display results of steps 1-3.

### Step 4: Data Sync (data and all modes)

Skip this step if mode is `code` or `status`.

All data sync operations use MCP tools. The `igris-brain` MCP server must be available.

If the `igris-brain` MCP server is NOT available:
- Display error and abort:
  ```
  ERROR: Brain MCP server is not available.

  The igris-brain MCP server must be registered and running to sync brain data.
  Check ~/.claude.json for MCP server registration.
  ```

**[0/5] Draining local sync queue...**
- Check if `~/.igris/projects/{project}/sync_queue.jsonl` exists
- If it exists and has entries:
  a. Read each JSON line
  b. For each entry, call the appropriate MCP tool based on the `operation` field:
     - `"brief_sync"` -> call `igris_brief_sync` with the stored parameters
     - `"brief_create"` -> call `igris_brief_create` with the stored parameters (read content from `cache_path` if present)
  c. On success: remove the processed line from the file
  d. On failure: leave the line in the file for next attempt
  e. Display summary: `Drained X of Y local sync queue entries`
- If all entries processed successfully, delete the queue file
- If some entries failed, display: `WARNING: {N} local sync queue entries could not be processed`
- If file does not exist: display "No local sync queue entries."

**[1/5] Draining sync queue...**
- Call `igris_sync_queue_drain` with:
  - remote_url = value from `remote_brain.url`
  - api_key = value from `remote_brain.api_key`
- Display count of drained operations.

**[2/5] Pushing brain data...**
- Call `igris_brain_push` with:
  - remote_url = value from `remote_brain.url`
  - api_key = value from `remote_brain.api_key`
- Display sync summary (rows pushed, errors synced, etc.)

**File push strategy (steps [3/5] - [5/5])**

These three steps push flat metric files. They use a two-tier dispatch
based on file size:

- **Small files (< 200 KB):** Use the `igris_file_push` MCP tool. The
  file content travels through the model's context window as the tool's
  `content` parameter. This is the default path for typical files.
- **Large files (>= 200 KB):** Shell out directly to curl against the
  brain's `/sync/file-push` HTTP endpoint. **Why this dual path exists:**
  the Read tool caps at 256 KB per call AND ~25,000 tokens per chunk, so
  large `events.jsonl` files (a 341 KB file is ~85 K tokens) require 6+
  Read chunks, string concatenation, and re-emission as the tool arg —
  burning ~85-100 K tokens per sync for what amounts to a binary upload.
  The HTTP endpoint already accepts up to 50 MB JSON; curl bypasses the
  context-window round-trip cleanly.

For each push step below, decide the path with `wc -c <FILE_PATH>`:
- If `wc -c` reports `< 204800` bytes (200 KB) → MCP tool path
- If `wc -c` reports `>= 204800` bytes → curl direct path
- If `wc -c` is unavailable for any reason → default to MCP tool path

**Curl direct path (large files):**

```bash
API_KEY="..."        # from remote_brain.api_key
REMOTE_URL="..."     # from remote_brain.url
FILE_PATH="..."      # absolute path to the metric file
FILE_TYPE="events"   # one of: events | agent_metrics | budget

python3 -c "
import json, sys
with open('$FILE_PATH') as f:
    print(json.dumps({'file_type': '$FILE_TYPE', 'content': f.read()}))
" | curl -sS -X POST \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @- "$REMOTE_URL/sync/file-push"
```

The HTTP response on success is JSON like
`{"ok": true, "bytes_written": NNN, "file_type": "..."}` — display
`bytes_written` so the operator sees confirmation. On non-2xx response,
display the response body as a WARNING but do NOT abort.

**[3/5] Pushing events log...**
- Check if `~/.igris/projects/{project}/metrics/events.jsonl` exists in the project directory.
- If it exists:
  - Run `wc -c <path>` to get the size.
  - **If size < 200 KB:** call `igris_file_push` with:
    - file_type = `events`
    - content = file contents
    - remote_url = value from `remote_brain.url`
    - api_key = value from `remote_brain.api_key`
    On success: display "Events log pushed via MCP (X bytes)"
  - **If size >= 200 KB:** use the curl direct path with `FILE_TYPE=events`.
    On 2xx: display "Events log pushed via curl (X bytes_written)"
  - On failure (either path): display WARNING but do NOT abort.
  - **Note:** This file can be consumed by external dashboards (e.g., Crimson Arena) for event monitoring.
- If it does not exist:
  - Display: "No events.jsonl found. Skipping."

**[4/5] Pushing agent metrics...**
- Check if `~/.igris/projects/{project}/metrics/agent-metrics.json` exists in the project directory.
- If it exists:
  - Run `wc -c <path>` to get the size.
  - **If size < 200 KB:** call `igris_file_push` with:
    - file_type = `agent_metrics`
    - content = file contents
    - remote_url = value from `remote_brain.url`
    - api_key = value from `remote_brain.api_key`
    On success: display "Agent metrics pushed via MCP (X bytes)"
  - **If size >= 200 KB:** use the curl direct path with `FILE_TYPE=agent_metrics`.
    On 2xx: display "Agent metrics pushed via curl (X bytes_written)"
  - On failure (either path): display WARNING but do NOT abort.
- If it does not exist:
  - Display: "No agent-metrics.json found. Skipping."

**[5/5] Pushing budget config...**
- Check if `~/.igris/projects/{project}/metrics/budget.json` exists in the project directory.
- If it exists:
  - Run `wc -c <path>` to get the size.
  - **If size < 200 KB:** call `igris_file_push` with:
    - file_type = `budget`
    - content = file contents
    - remote_url = value from `remote_brain.url`
    - api_key = value from `remote_brain.api_key`
    On success: display "Budget config pushed via MCP (X bytes)"
  - **If size >= 200 KB:** use the curl direct path with `FILE_TYPE=budget`.
    On 2xx: display "Budget config pushed via curl (X bytes_written)"
  - On failure (either path): display WARNING but do NOT abort.
- If it does not exist:
  - Display: "No budget.json found. Skipping."

### Step 5: Status Mode (status mode only)

Skip this step if mode is not `status`.

Read `~/.igris/config.json` for VPS and remote brain configuration, then check and display:

**VPS Connectivity:**
- Run: `ssh -o ConnectTimeout=10 {vps.user}@{vps.host} "echo ok"`
- Display: Connected / Unreachable

**VPS Brain Health:**
- Extract port from `remote_brain.url` if available, default to 3001.
- Run: `ssh -o ConnectTimeout=10 {vps.user}@{vps.host} "curl -s http://127.0.0.1:{port}/health"`
- Parse and display health status, version, uptime.

**PM2 Status:**
- Run: `ssh -o ConnectTimeout=10 {vps.user}@{vps.host} "pm2 jlist"`
- Parse the JSON output for the `igris-brain` process entry.
- Display: process status, uptime, restarts, memory usage.

**Local State:**
- Current branch: `git rev-parse --abbrev-ref HEAD`
- Unpushed commits: `git log origin/{branch}..HEAD --oneline | wc -l`
- Remote brain config: present / missing (from config.json)
- Brain MCP: available / unavailable (check if MCP tools respond)

**Last Deploy:**
- Run: `ssh -o ConnectTimeout=10 {vps.user}@{vps.host} "tail -1 ~/.igris/logs/update.log"`
- Display the last deployment log entry.

Format the output as:
```
## VPS Sync Status

### Connectivity
- SSH: [Connected | Unreachable]
- Brain API: [Healthy (v{version}) | Unhealthy | Unreachable]

### PM2 Process
- Status: [online | stopped | errored]
- Uptime: [duration]
- Restarts: [count]
- Memory: [usage]

### Local State
- Branch: {branch}
- Unpushed commits: {count}
- Remote brain config: [Present | Missing]
- Brain MCP: [Available | Unavailable]

### Last Deploy
{last log entry or "No deployment logs found"}
```

### Step 6: Final Summary (all modes except status)

After code and/or data sync completes, display a summary table:

```
## Sync Complete

| Step | Status |
|------|--------|
| Git push | OK (X commits) / SKIPPED / FAILED: {reason} |
| VPS deploy | OK ({old_hash} -> {new_hash}) / SKIPPED / FAILED: {reason} |
| Health check | PASSED (v{version}) / WARNING: {reason} / FAILED |
| Local sync queue | OK (X items drained) / SKIPPED (no file) / PARTIAL: {N} failed |
| Sync queue drain | OK (X items drained) / SKIPPED / FAILED: {reason} |
| Brain data push | OK (X rows synced) / SKIPPED / FAILED: {reason} |
| Events log | OK (X bytes pushed) / SKIPPED (no file) / FAILED: {reason} |
| Agent metrics | OK (X bytes pushed) / SKIPPED (no file) / FAILED: {reason} |
| Budget config | OK (X bytes pushed) / SKIPPED (no file) / FAILED: {reason} |
```

If any step failed, include troubleshooting tips:
```
### Troubleshooting

- **Git push failed:** Check remote permissions and network connectivity.
- **SSH failed:** Verify SSH key is configured for {vps.user}@{vps.host}. Test with: ssh {vps.user}@{vps.host} "echo ok"
- **Health check failed:** Service may be restarting. Check PM2: ssh {vps.user}@{vps.host} "pm2 status igris-brain"
- **Brain data failed:** Ensure igris-brain MCP server is registered in ~/.claude.json
- **File push failed:** Ensure remote brain server is reachable at the configured URL and API key is correct.
```

Only show troubleshooting tips relevant to the actual failures encountered.
