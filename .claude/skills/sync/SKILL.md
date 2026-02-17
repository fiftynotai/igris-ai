---
name: sync
description: Deploy code and/or data to VPS brain - usage: /sync [code|data|all|status]
disable-model-invocation: true
allowed-tools:
  - Read
  - Bash
  - Grep
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

**MCP-dependent steps ([1/4] and [2/4]):**

If the `igris-brain` MCP server is available:

**[1/4] Draining sync queue...**
- Call `igris_sync_queue_drain` with:
  - remote_url = value from `remote_brain.url`
  - api_key = value from `remote_brain.api_key`
- Display count of drained operations.

**[2/4] Pushing brain data...**
- Call `igris_brain_push` with:
  - remote_url = value from `remote_brain.url`
  - api_key = value from `remote_brain.api_key`
- Display sync summary (rows pushed, errors synced, etc.)

If the `igris-brain` MCP server is NOT available:
- Skip steps [1/4] and [2/4].
- Display warning:
  ```
  WARNING: Brain MCP server not available. Steps [1/4] and [2/4] skipped.
  ```
- If mode is `data` and SSH-based steps also fail: hard failure with clear error:
  ```
  ERROR: Brain MCP server is not available and SSH sync also failed.

  The igris-brain MCP server must be registered and running to sync brain data via MCP.
  Check ~/.claude.json for MCP server registration.
  Alternatively, ensure SSH connectivity is working for direct DB sync.
  ```
- If mode is `all`: warn but continue with SSH-based steps [3/4] and [4/4]:
  ```
  WARNING: Brain MCP server not available. MCP data sync skipped.
  Continuing with SSH-based sync steps...
  ```

**SSH-based steps ([3/4] and [4/4]) -- always run regardless of MCP availability:**

**[3/4] Uploading agent metrics...**
- Check if `ai/session/metrics/agent-metrics.json` exists in the project directory.
- If it exists:
  - Read `vps.user`, `vps.host`, `vps.brain_path` from config.
  - Create remote directory: `ssh -o ConnectTimeout=10 {vps.user}@{vps.host} "mkdir -p {vps.brain_path}/metrics"`
  - Upload file: `scp -o ConnectTimeout=10 ai/session/metrics/agent-metrics.json {vps.user}@{vps.host}:{vps.brain_path}/metrics/agent-metrics.json`
  - On success: display "Agent metrics uploaded (X agents, Y total invocations)"
    - Parse the JSON to get totals.total_invocations and count of agents for the display message.
  - On failure: display WARNING but do NOT abort. Continue with next step.
- If it does not exist:
  - Display: "No agent-metrics.json found. Skipping metrics upload."

**[4/4] Merging local brain data...**
- This step syncs the local machine's brain database to the VPS brain database.
- Read `vps.user`, `vps.host`, `vps.brain_path` from config.
- For each table (learnings, projects, sessions, brief_status, agent_metrics):
  1. Dump local data: Run `sqlite3 ~/.igris/memory/knowledge.db` with a query to export rows as INSERT OR IGNORE SQL statements (excluding the id column to avoid PK conflicts).
     - For `brief_status` (has UNIQUE on project+brief_id):
       `sqlite3 ~/.igris/memory/knowledge.db "SELECT 'INSERT OR IGNORE INTO brief_status (project, brief_id, brief_type, title, status, priority, effort, phase, updated_at) VALUES (' || quote(project) || ',' || quote(brief_id) || ',' || quote(brief_type) || ',' || quote(title) || ',' || quote(status) || ',' || quote(priority) || ',' || quote(effort) || ',' || quote(phase) || ',' || quote(updated_at) || ');' FROM brief_status;"`
     - For `projects` (has UNIQUE on slug):
       `sqlite3 ~/.igris/memory/knowledge.db "SELECT 'INSERT OR IGNORE INTO projects (slug, name, path, tech_stack, igris_version, status, registered_at, last_session_at) VALUES (' || quote(slug) || ',' || quote(name) || ',' || quote(path) || ',' || quote(tech_stack) || ',' || quote(igris_version) || ',' || quote(status) || ',' || quote(registered_at) || ',' || quote(last_session_at) || ');' FROM projects;"`
     - For `learnings` (no UNIQUE beyond PK -- use title+project dedup):
       `sqlite3 ~/.igris/memory/knowledge.db "SELECT 'INSERT INTO learnings (project, category, title, content, tags, tech_stack, scope, source_brief, confidence, created_at, updated_at, access_count, last_accessed_at) SELECT ' || quote(project) || ',' || quote(category) || ',' || quote(title) || ',' || quote(content) || ',' || quote(tags) || ',' || quote(tech_stack) || ',' || quote(scope) || ',' || quote(source_brief) || ',' || quote(confidence) || ',' || quote(created_at) || ',' || quote(updated_at) || ',' || quote(access_count) || ',' || quote(last_accessed_at) || ' WHERE NOT EXISTS (SELECT 1 FROM learnings WHERE project = ' || quote(project) || ' AND title = ' || quote(title) || ');' FROM learnings;"`
     - For `sessions` and `agent_metrics`: Use similar WHERE NOT EXISTS dedup on key columns.
  2. Write all INSERT statements to a temp file: `/tmp/igris_local_merge.sql`
  3. Upload: `scp -o ConnectTimeout=10 /tmp/igris_local_merge.sql {vps.user}@{vps.host}:/tmp/igris_local_merge.sql`
  4. Execute on VPS: `ssh -o ConnectTimeout=10 {vps.user}@{vps.host} "sqlite3 {vps.brain_path}/memory/knowledge.db < /tmp/igris_local_merge.sql"`
  5. Clean up: Remove `/tmp/igris_local_merge.sql` locally and on VPS.
  6. On success: display row counts merged per table.
  7. On failure: display WARNING with error details. Do NOT abort.

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
| Brain data (MCP) | OK (X rows synced) / SKIPPED / FAILED: {reason} |
| Agent metrics | OK (uploaded) / SKIPPED (no file) / FAILED: {reason} |
| Local DB merge | OK (X rows merged) / SKIPPED / FAILED: {reason} |
```

If any step failed, include troubleshooting tips:
```
### Troubleshooting

- **Git push failed:** Check remote permissions and network connectivity.
- **SSH failed:** Verify SSH key is configured for {vps.user}@{vps.host}. Test with: ssh {vps.user}@{vps.host} "echo ok"
- **Health check failed:** Service may be restarting. Check PM2: ssh {vps.user}@{vps.host} "pm2 status igris-brain"
- **Brain data failed:** Ensure igris-brain MCP server is registered in ~/.claude.json
- **Metrics upload failed:** Check SSH/SCP connectivity and that {vps.brain_path}/metrics/ is writable.
- **Local DB merge failed:** Check that local ~/.igris/memory/knowledge.db exists and VPS brain DB is accessible.
```

Only show troubleshooting tips relevant to the actual failures encountered.
