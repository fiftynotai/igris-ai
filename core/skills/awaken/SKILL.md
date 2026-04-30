---
name: awaken
description: Start or resume session - loads state and continues work
disable-model-invocation: false
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - mcp__igris-brain__igris_brief_dashboard
  - mcp__igris-brain__igris_session_file_get
  - mcp__igris-brain__igris_coordination_config_get
  - mcp__igris-brain__igris_task_next
  - mcp__igris-brain__igris_agent_capability_list
  - mcp__igris-brain__igris_coordination_audit
  - mcp__igris-brain__igris_instance_heartbeat
  - mcp__igris-brain__igris_instance_remove
  - mcp__igris-brain__igris_instance_list
  - mcp__igris-brain__igris_brief_sync
  - mcp__igris-brain__igris_brief_create
  - mcp__igris-brain__igris_goal_list
  - mcp__igris-brain__igris_suggestion_list
triggers:
  - "AWAKEN"
  - "ARISE"
  - "start session"
  - "resume session"
---

# AWAKEN - Start/Resume Session

Initialize Igris AI and resume any pending work.

## Execution

### 0. Track Invocation
Silently emit a skill invocation event (never blocks execution):
```bash
bash "$CLAUDE_PROJECT_DIR/scripts/emit_skill_event.sh" "awaken" 2>/dev/null || true
```

### 1. Load Context via Tree

Read `~/.igris/core/igris_tree.json` first — this is the **sole router** for what context to load.

1. Read `~/.igris/core/igris_tree.json`
2. Look up `tasks["/awaken"].load` to get the context file keys (e.g., `["igris_os", "soul", "coding_guidelines"]`)
3. For each key, resolve the file path from `context_files[key].path` (replace `{project}` with current project slug)
4. If `tasks["/awaken"].sections.igris_os` is set, use it to determine which sections to load:
   - `"ALL"` → read the entire file
   - Array (e.g., `["identity", "brief_protocol"]`) → read only those section ranges from `context_files.igris_os.sections`
5. Read all resolved files silently

**Always-needed files** (not in tree, needed for awaken mechanics):
- `~/.igris/USER.md` - User config (addressing mode, mask preference)
- `~/.igris/config.json` - Remote brain URL and API key

Do NOT hardcode context file paths — always derive them from the tree.

### 2. Load Session State

First try `igris_session_file_get` (MCP) for CURRENT_SESSION.md, then read `~/.igris/projects/{project}/session/CURRENT_SESSION.md`:
- Check if session exists (Mode field)
- If REST MODE: This is a resume
- If no session: This is a fresh start

### 3. Display Persona Greeting

Use the persona (from `soul`) and user config (from `USER.md`) already loaded in Step 1:
```
[PERSONA GREETING FROM soul context]

My capabilities:
- Brief management, session recovery, architecture enforcement
- Quality gates, protocol enforcement

Current mode: [mask level description from soul context]
```

### 3.5. Query Brain for Context (Optional)

If the `igris-brain` MCP server is available:
- Call `igris_memory_recall` with the current project slug and context="session start, current project priorities"
- Display any relevant cross-project learnings to the user
- Call `igris_project_register` to update `last_session_at` for this project
- Call `igris_session_recall` with days=2 to see recent cross-project activity
- If sessions returned, display a "Cross-Project Context" section:
  ```
  ### Cross-Project Context (last 48h)
  - project-a: Worked on BR-012 (auth fix), BUILDING phase
  - project-b: Completed FR-005 (dark mode)
  ```
- This gives a "welcome back" overview across all projects

If brain MCP is not available, skip this step silently. No errors, no warnings.

### 3.6. Pull from Remote Brain (Mandatory)

You MUST call `igris_brain_pull` when remote brain is configured. This is NOT optional — the VPS brain depends on receiving data.

If the `igris-brain` MCP server is available AND a remote brain URL is configured:
- Read `~/.igris/config.json` to check for `remote_brain.url` and `remote_brain.api_key`
- If both are present, call `igris_brain_pull` with:
  - remote_url = the configured URL
  - api_key = the configured API key
- Display sync result summary (e.g., "Pulled 5 learnings, 2 errors from remote brain")

If remote brain is not configured or pull fails, skip with one-line notice: "Brain pull skipped ([reason])." Do NOT block session start.

### 3.6.1. Drain Sync Queue (Mandatory)

You MUST drain the sync queue when remote brain is configured. This is NOT optional.

If the `igris-brain` MCP server is available:
1. Call `igris_sync_queue_drain` to process any queued operations from previous failed pushes
2. Display count of drained operations if any were processed

If brain MCP is NOT available or drain fails, skip silently. Do NOT block session start.

### 3.6.1.1. Drain Local Sync Queue (Mandatory)

You MUST drain the local sync queue file when brain MCP is available. This is NOT optional — briefs queued during previous MCP outages depend on this.

If the `igris-brain` MCP server is available:
1. Check if `~/.igris/projects/{project}/sync_queue.jsonl` exists
2. If it exists and has entries:
   a. Read each JSON line
   b. For each entry, call the appropriate MCP tool based on the `operation` field:
      - `"brief_sync"` -> call `igris_brief_sync` with the stored parameters
      - `"brief_create"` -> call `igris_brief_create` with the stored parameters (read content from `cache_path` if present)
   c. On success: remove the processed line from the file
   d. On failure: leave the line in the file for next attempt
   e. Display summary: `Drained X of Y local sync queue entries`
3. If all entries processed successfully, delete the queue file
4. If some entries failed, display: `WARNING: {N} sync queue entries could not be processed — will retry on next /awaken or /sync data`

If brain MCP is NOT available:
- Check if `~/.igris/projects/{project}/sync_queue.jsonl` exists and has entries
- If yes, display: `WARNING: {N} brief sync(s) are queued locally — brain MCP unavailable. Will retry on next /awaken or /sync data.`
- Do NOT block session start.

### 3.6.2. Pull Session Files (Mandatory)

You MUST pull session files when remote brain is configured. This is NOT optional.

If the `igris-brain` MCP server is available:
1. Call `igris_session_file_pull` to restore session files from VPS if local is empty or stale
2. Compare local file hashes with remote — only pull if remote is newer
3. Session files to sync: CURRENT_SESSION.md, LEARNINGS.md, DECISIONS.md, BLOCKERS.md
4. Display summary of files pulled (e.g., "Pulled 2 session files from remote brain")

If brain MCP is NOT available or pull fails, skip silently. Do NOT block session start.

### 3.6.3. Pull Latest Definitions (Mandatory)

You MUST pull latest definitions when remote brain is configured. This is NOT optional.

If the `igris-brain` MCP server is available:
1. Call `igris_definition_pull` to check for newer agent, skill, rule, and prompt definitions
2. Only update local files if remote content hash differs
3. Display summary of definitions updated (e.g., "Updated 1 agent, 2 rules from remote brain")

If brain MCP is NOT available or pull fails, skip silently. Do NOT block session start.

### 3.6.4. Clean Stale Previous Instance (Mandatory)

Before registering a new instance, check if the previous session left an orphaned instance:

1. Read `~/.igris/projects/{project}/session/CURRENT_SESSION.md`
2. Look for the `**Instance ID:**` field
3. If a previous instance_id exists:
   a. Call `igris_instance_remove` with that specific instance_id
   b. Display: "Cleaned stale instance: {previous_instance_id}"
   c. Remove the `**Instance ID:**` line from CURRENT_SESSION.md
4. Do NOT call `igris_instance_list` and remove other instances — only the exact ID from session file

This ensures /rest → /awaken cycles never produce duplicates, while preserving other instances on the same machine (multi-instance is valid).

### 3.7. Register Instance (Mandatory)

You MUST call `igris_instance_heartbeat` to register this session as a live instance. This is NOT optional — the VPS dashboard depends on it.

If the `igris-brain` MCP server is available:
1. Call `igris_instance_heartbeat` with:
   - machine_hostname = system hostname
   - machine_os = platform (e.g., "darwin", "linux")
   - project_slug = current project slug
   - project_path = absolute path to project directory
2. Store the returned `instance_id` in `~/.igris/projects/{project}/session/CURRENT_SESSION.md` by adding a line: `**Instance ID:** {uuid}` in the Status section
3. Display: "Instance registered: {instance_id}"
4. This ID will be used for subsequent heartbeats and deregistration on /rest

If brain MCP is NOT available (tool call fails or MCP server not registered), skip gracefully with a one-line notice: "Instance registration skipped (brain MCP unavailable)." Do NOT block session start.

### 4. Perform System Assessment

Call `igris_brief_dashboard` with `project` and `summary_only=true`, fallback to cache glob at `~/.igris/projects/{project}/briefs/` for inventory:
- The dashboard returns aggregate counts by status and priority — no need to fetch individual briefs
- Use the counts to identify if there are Ready briefs to work on

Check `~/.igris/projects/{project}/session/BLOCKERS.md` for active blockers.

Check git status.

If brain is connected (from step 3.5), include brain stats in assessment:
- Brain: Connected (X learnings, Y errors cataloged) | Not available
- Active Instances: X (from `igris_instance_list` with status="active")
- Cross-project insights if relevant

### 4.5. Show Work Queue and Coordination Status (Optional)

If the `igris-brain` MCP server is available:

1. Call `igris_coordination_config_get` to check autonomous mode status
2. Call `igris_task_next` (no agent filter) to peek at the top pending task
3. Call `igris_task_list` with status="pending" and limit=5 to show the work queue
4. Display a work queue summary:

```
### Work Queue
| Task | Priority | Type | Due |
|------|----------|------|-----|
| t-abc123: Fix auth flow | P1 | brief | 2026-02-26 |
| t-def456: Update docs | P3 | operational | -- |

Autonomous Mode: [Enabled/Disabled]
Self-Healing: [Enabled/Disabled]
```

If brain MCP is NOT available or calls fail, skip silently. Do NOT block session start.

### 4.7. Goals Approaching Deadline (FR-110)

If `igris-brain` MCP is available, call `igris_goal_list` with:
- `project` = current project slug
- `status` = `'active'`
- `upcoming_days` = `14`
- `limit` = `3`

Token budget: this surface is bounded to ≤3 rows by the `limit` parameter. Render at most ~120 tokens.

If results are returned, render:

```
## Goals approaching deadline
- GL-003 "Ship v6.1" — due 2026-05-01 (3 days), 4/7 briefs done
- GL-001 "Compliance audit" — due 2026-05-12 (14 days), 1/5 briefs done
```

The "X/Y briefs done" comes from each goal's `serving_briefs_count` field plus a per-goal call (only if the count is non-zero) — but for the awaken surface, prefer using just `serving_briefs_count` from the list response and rendering "N briefs serving" rather than calling `igris_goal_progress` per goal (token budget).

If zero results, render nothing — no "No goals" line. Do NOT call any further goal tools when zero rows are returned.

If `>3` active goals exist beyond the 14-day window, append a single trailing line: `(+N other active goals — run /scan for full list)`. Only display this trailing line if you happen to have called `igris_goal_list` without `upcoming_days` separately; if you only called the bounded version, omit the trailing line.

If the goal tools are unavailable (older brain), skip silently.

### 4.8. Subconscious Suggestions (FR-106)

If `igris-brain` MCP is available, call `igris_suggestion_list` with:
- `status` = `'pending'`
- `project_slug` = current project slug
- `limit` = `3`

Token budget: bounded to <=3 rows by `limit`. Render at most ~120 tokens.

If results are returned, render:

```
## Suggestions ({total} pending)
- [{priority}] {title} ({source_module})
- [{priority}] {title} ({source_module})
- [{priority}] {title} ({source_module})
```

Use the `total` count from the response (may exceed `limit`) so the user
knows how many are queued in total. Format each row as:
`- [{priority}] {title} ({source_module})` — keep it terse; the user can
run `igris_suggestion_list` directly for full details.

If zero results, render nothing — no "No suggestions" line. If the tool
is unavailable (older brain), skip silently.

### 4.9. Pending Perception Candidates (FR-109 / TD-066)

Extraction happens in a detached background process at session-end (spawned
by `session_end.sh` / `pre_compact.sh` via `perception_extract_and_persist.sh`).
This section is purely a SELECT — it surfaces whatever the background process
has committed since the last awaken. /awaken does NOT drain any inbox.

If `igris-brain` MCP is available, call `igris_perception_review_pending` with:
- `project` = current project slug
- `limit` = `5`

Token budget: bounded to <=5 rows by `limit`. Render at most ~150 tokens.

If results are returned, render:

```
## Pending Learnings ({total} pending review)
- [{source_extractor}, conf {confidence}] {title}
- [{source_extractor}, conf {confidence}] {title}
```

Use the `total` count from the response (may exceed `limit`) so the user
knows the queue depth. The `source_extractor` field values are typically
`llm` (from background extraction) or `manual` (from direct memory_store
calls). Legacy rows from pre-TD-066 extractions may render as
`rule:learned_marker`, `rule:retry_chain`, `rule:blocker_resolution`, or
`rule:error_fingerprint` — these are read-side compatible and surface
verbatim. Show `approve` and `reject` MCP tools as next-step hints once per
session, not per row.

If zero results, render nothing — no "No pending" line. If the tool is
unavailable (older brain), skip silently.

If `auto_approve_enabled=true` is set in `~/.igris/config.json`'s `perception`
section, the background extractor inserts new rows as `approved` directly
and they bypass this surface — they appear in `recall`/`search` immediately
without operator review. Default is opt-in (off).

### 5. Display Resume Point (if resuming)

If session was in REST MODE:
```
## Resuming Session

**Last Active:** [brief ID]
**Phase:** [phase]
**Next Steps:** [from session file]
```

### 6. Display Recommendations

```
## Recommended Actions

1. [Primary - resume current or start highest priority]
2. [Secondary - show status or review briefs]
3. [Tertiary - other relevant action]
```

### 7. Update Session

If resuming, update Mode from "REST MODE" to "HUNT MODE" or "Active".

Display: "Igris AI initialized. System ready."
