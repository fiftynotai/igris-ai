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

### 1. Load System Context

Read these files silently:
- `ai/prompts/igris_os.md` - Operating system
- `SOUL.md` - Persona identity
- `~/.igris/USER.md` - User config
- `ai/context/coding_guidelines.md` - Architecture standards

### 2. Load Session State

Read `ai/session/CURRENT_SESSION.md`:
- Check if session exists (Mode field)
- If REST MODE: This is a resume
- If no session: This is a fresh start

### 3. Display Persona Greeting

Read mask level from `~/.igris/USER.md` (default: full). Load greeting from `ai/masks/{level}.md`:
```
[MASK GREETING FROM ai/masks/{level}.md]

My capabilities:
- Brief management, session recovery, architecture enforcement
- Quality gates, protocol enforcement

Current mode: [mask level description from SOUL.md]
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

### 3.7. Register Instance (Mandatory)

You MUST call `igris_instance_heartbeat` to register this session as a live instance. This is NOT optional — the VPS dashboard depends on it.

If the `igris-brain` MCP server is available:
1. Call `igris_instance_heartbeat` with:
   - machine_hostname = system hostname
   - machine_os = platform (e.g., "darwin", "linux")
   - project_slug = current project slug
   - project_path = absolute path to project directory
2. Store the returned `instance_id` in CURRENT_SESSION.md by adding a line: `**Instance ID:** {uuid}` in the Status section
3. Display: "Instance registered: {instance_id}"
4. This ID will be used for subsequent heartbeats and deregistration on /rest

If brain MCP is NOT available (tool call fails or MCP server not registered), skip gracefully with a one-line notice: "Instance registration skipped (brain MCP unavailable)." Do NOT block session start.

### 4. Perform System Assessment

Scan `ai/briefs/` for inventory:
- Count by status and priority
- Identify highest priority ready brief

Check `ai/session/BLOCKERS.md` for active blockers.

Check git status.

If brain is connected (from step 3.5), include brain stats in assessment:
- Brain: Connected (X learnings, Y errors cataloged) | Not available
- Active Instances: X (from `igris_instance_list` with status="active")
- Cross-project insights if relevant

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
