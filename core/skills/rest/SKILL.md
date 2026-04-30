---
name: rest
description: Pause or end current session - saves state for later resumption
disable-model-invocation: false
allowed-tools:
  - Read
  - Write
  - Edit
  - mcp__igris-brain__igris_session_file_update
  - mcp__igris-brain__igris_instance_remove
triggers:
  - "REST"
  - "REST MODE"
  - "end session"
  - "pause session"
  - "STAND DOWN"
---

# REST - Pause/End Session

Safely pause or end the current session, saving state for later resumption.

## Execution

### 0. Track Invocation
Silently emit a skill invocation event (never blocks execution):
```bash
bash "$CLAUDE_PROJECT_DIR/scripts/emit_skill_event.sh" "rest" 2>/dev/null || true
```

### 1. Read Current Session

Read `~/.igris/projects/{project}/session/CURRENT_SESSION.md` to understand current state.

### 2. Confirm with User

Ask: "Save session and enter REST MODE? Any unsaved work will be noted for resumption."

### 2.5. Deregister Instance (Mandatory)

You MUST deregister the instance when ending a session. This removes the instance from the VPS dashboard.

If the `igris-brain` MCP server is available:
1. Read the Instance ID from `~/.igris/projects/{project}/session/CURRENT_SESSION.md` (look for `**Instance ID:**` field)
2. If Instance ID exists, call `igris_instance_remove` with the instance_id
3. Display: "Instance deregistered: {instance_id}"
4. Remove the `**Instance ID:**` line from `~/.igris/projects/{project}/session/CURRENT_SESSION.md` (clean up for next session)

If brain MCP is NOT available or no Instance ID is stored, skip gracefully. Do NOT block session end.

### 2.6. Sync to Brain (Optional)

If the `igris-brain` MCP server is available:
- Read `~/.igris/projects/{project}/session/LEARNINGS.md` -- if it has new content since last sync, store each learning via `igris_memory_store` with the current project slug
- Read `~/.igris/projects/{project}/session/DECISIONS.md` -- if it has new content, store each decision via `igris_memory_store` with category="decision" and the current project slug
- Call `igris_metrics_record` with session summary: project=current project slug, agent="session", action="rest", result="success"
- Call `igris_session_sync` with:
  - project = current project slug (basename of project directory)
  - brief_id = active brief ID from CURRENT_SESSION.md (if any)
  - phase = current workflow phase from the active brief's Workflow State (if any)
  - mode = "REST"
  - summary = brief description of work done this session (from Last Session Summary)
- Call `igris_brief_sync` for each active brief that changed status during this session:
  - project, brief_id, brief_type, title, status, priority, effort, phase from the brief file

If brain MCP is not available, skip this step silently. No errors, no warnings.

### 2.6.5. Drain Sync Queue (Mandatory)

You MUST drain the sync queue before the final push. This is NOT optional.

If the `igris-brain` MCP server is available:
1. Call `igris_sync_queue_drain` to process any queued sync operations from previous failed pushes
2. Display count of drained operations if any were processed

If brain MCP is NOT available or drain fails, skip silently. Do NOT block session end.

### 2.7. Push to Remote Brain (Mandatory)

You MUST call `igris_brain_push` when remote brain is configured. This is NOT optional — the VPS brain depends on receiving data.

If the `igris-brain` MCP server is available AND a remote brain URL is configured:
- Read `~/.igris/config.json` to check for `remote_brain.url` and `remote_brain.api_key`
- If both are present, call `igris_brain_push` with:
  - remote_url = the configured URL
  - api_key = the configured API key
- Display sync result summary (e.g., "Pushed 3 learnings, 1 error, 2 sessions to remote brain")

If remote brain is not configured or push fails, skip with one-line notice: "Brain push skipped ([reason])." Do NOT block session end.

### 3. Update Session File

Edit `~/.igris/projects/{project}/session/CURRENT_SESSION.md`:

```markdown
## Status
**Mode:** REST MODE
**Updated:** [current date]
**Active Brief:** [current brief or None]

---

## Resume Point

**Last Active:** [brief ID if any]
**Phase:** [current phase]

---

## Next Session Instructions

[Capture current context and next steps for resumption]

---

## Last Session Summary
**Date:** [today]
**Completed:** [list completed items]
**Summary:** [brief summary of work done]
```

### 4. Confirm REST MODE

Display:
```
Session saved. REST MODE activated.

Resume Point:
- Brief: [ID]
- Phase: [phase]
- Next: [next steps]

To resume: /awaken or "ARISE"
```
