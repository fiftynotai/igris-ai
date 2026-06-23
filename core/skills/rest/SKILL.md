---
name: rest
description: Pause or end current session - saves state for later resumption
disable-model-invocation: false
allowed-tools:
  - Read
  - Write
  - Edit
  - mcp__igris-brain__igris_session_file_update
  - mcp__igris-brain__igris_instance_heartbeat
  - mcp__igris-brain__igris_instance_remove
  - mcp__igris-brain__igris_brief_release
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

### 1. Read Current Session

Read this instance's own LIVE scratchpad: `~/.igris/projects/{project}/session/instances/<instance_id>.md`. The `<instance_id>` is the Instance ID already stored in the session file body from `/awaken` §3.7 (the `**Instance ID:**` field). This per-instance file is where `/awaken` wrote the LIVE state for this instance; it has no shared `CURRENT_SESSION.md`.

### 2. Confirm with User

Ask: "Save session and enter REST MODE? Any unsaved work will be noted for resumption."

### 2.5. Close Instance Ownership (Mandatory)

You MUST close out this instance's ownership when ending a session. This is the deliberate "task closed" signal (Lock 1: ownership is explicit, never implied) AND it removes the instance from the VPS dashboard.

Read the Instance ID from the per-instance session file body (the `**Instance ID:**` field). Do NOT remove the `**Instance ID:**` line — §3 below needs it to write the per-instance path.

If the `igris-brain` MCP server is available AND an Instance ID exists, perform THREE actions in this order:

1. **Clear `current_brief` ownership** — call `igris_instance_heartbeat` with the stored `instance_id` and `current_brief=""` (empty string). This is the documented Lock-1 release signal: the empty `current_brief` is the auditable "task closed" event. Pass the same `machine_hostname` / `machine_os` / `project_slug` / `project_path` the instance was registered with so the heartbeat upserts the existing row rather than minting a new one.
2. **Deregister the instance** — call `igris_instance_remove` with the `instance_id`. This is dashboard cleanup. Display: "Instance ownership closed and deregistered: {instance_id}".
3. **Release any brief claims held by this instance (FR-127)** — for the
   Active Brief recorded in this instance's session file (and any other brief
   this instance is recorded as hunting), call `igris_brief_release` with
   `project` = current project slug, `brief_id` = the brief ID, and
   `instance_id` = the stored Instance ID. `igris_brief_release` is idempotent
   and ownership-scoped: it only frees a claim this instance holds, and a no-op
   release (claim already gone) is a clean success. This is the FR-127 lock
   release that pairs with `/hunt`'s claim. Display: "Released brief claim:
   {brief_id}." for each released brief.

   If brain MCP is NOT available, skip silently — the claim will be treated as
   stale by the next `/hunt` (claimer absent from the active registry once the
   instance is deregistered) and reclaimable via operator confirmation.

Ordering rationale: the ownership-clear runs first so that even if `igris_instance_remove` fails, the `current_brief` flag is already cleared — the release event is recorded regardless. (`igris_instance_remove` deletes the instance row entirely, which would *implicitly* drop `current_brief` with it; the explicit heartbeat-with-empty-brief makes the release deliberate and auditable, which Lock 1 requires.) The brief-claim release (action 3) runs LAST: even if it fails, the instance is already deregistered, so the next `/hunt` sees the claimer absent from the active set and offers a stale-reclaim — the claim is never permanently stuck.

> FR-127 note: FR-127's atomic brief-claim gate releases (action 3 above) the lock it took at hunt-start, alongside the Lock-1 ownership-clear. This section is named "Close Instance Ownership" because it is the named home for that lock-release.

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

### 2.6.4.5. Drain Local Sync Queue (Mandatory)

You MUST drain the local sync queue file before the final push when brain MCP is available. This is NOT optional — briefs queued locally during this session depend on this.

If the `igris-brain` MCP server is available:
- Invoke the canonical atomic drain via the CLI: `igris sync data` (delegates to `cli/src/lib/sync/queue.ts`). Same contract as `/awaken` §3.6.1.1: rename-then-process atomicity (FR-128), `.draining-*` crash recovery, strict-allow-list (TD-128 M3), and `cache_path → content` resolution for `brief_create`.
- The drain is gated on a non-empty queue: when the queue is empty (the common `/rest` case), the CLI short-circuits after a single filesystem stat plus the remote drain call. No-op-fast.

If brain MCP is NOT available, skip silently — matching the existing `/rest` skip-on-MCP-unavailable convention. The local queue (and any `.draining-*` temp) is preserved for `/awaken` to drain on the next session start. Do NOT block session end.

### 2.6.5. Drain Brain Sync Queue (Mandatory)

You MUST drain the brain-side sync queue before the final push. This is NOT optional.

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

Write the per-instance session file `~/.igris/projects/{project}/session/instances/<instance_id>.md` — the SAME path the LIVE scratchpad already lives at. `/rest` does LIVE → RESTED only: the on-disk file STAYS in `session/instances/`. `/rest` does NOT move it to `session/archive/` — RESTED → ARCHIVED is the next instance's job (Lock 2). The brain `state` column is the authoritative state; the disk location is unchanged.

After writing the file content, call `igris_session_file_update` with:
- `project` = current project slug
- `filename` = `instances/<instance_id>.md`
- `content` = the full file content below
- `instance_id` = `<instance_id>`
- `state` = `'rested'`

Keep the `**Instance ID:**` line in the file body — it is the per-instance identity.

File content:

```markdown
## Status
**Mode:** REST MODE
**Instance ID:** <instance_id>
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
