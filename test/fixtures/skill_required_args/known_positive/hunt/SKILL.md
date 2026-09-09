### Phase 1: INIT

1. Load brief via `igris_brief_get` (MCP), fallback to cache at `~/.igris/projects/{project}/briefs/` matching `$ARGUMENTS`
2. Read brief content

6.5. **Atomically claim the brief (FR-127 — the hard gate):**
   If the `igris-brain` MCP server is available, call `igris_brief_claim` with
   `project` = current project slug, `brief_id` = `$ARGUMENTS`, and
   `instance_id` = the Instance ID from the per-instance session file.

   Branch on the result:

   - **`claimed: true`** — proceed. (If `reentrant: true`, this instance already
     held the brief — a resumed hunt; display "Re-claimed FR-XXX (already
     yours)." and continue. Otherwise display nothing and continue to step 7.)

   - **`claimed: false`** — the brief is claimed by `held_by`. Determine if that
     claim is LIVE or RECLAIMABLE: run `igris instance list --project {project}`
     and inspect the held instance's liveness result.
       - **`held_by` is `alive` or `unknown_remote` / `unknown_no_metadata` with an unexpired lease** (live/uncertain claim) → **HARD STOP.** Display:
         "BR-XXX is being hunted by instance {held_by} ({harness}, active {T}
         ago). Two instances cannot hunt the same brief. Aborting /hunt."
         Do NOT proceed to step 7. Do NOT mutate brief status. End the skill.
       - **`held_by` is `dead` / `dead_pid_reused`, OR the remote/unknown lease expired, OR `held_since` is older than 24h**
         (reclaimable claim) → display: "BR-XXX's claim by {held_by} looks reclaimable
         ({reason}). Reclaim? [y/N]" — WAIT for
         explicit operator input. On **N / anything but y** → HARD STOP, end the
         skill. On **y** → call `igris_brief_release` with the STALE `held_by`
         instance_id, then call `igris_brief_claim` again with THIS instance's
         `instance_id`; if that second claim returns `claimed: true`, proceed to
         step 7. (If it returns `claimed: false` again — a race where another
         instance grabbed it in the gap — HARD STOP with the live-claim message.)

   If brain MCP is NOT available or `igris_brief_claim` is unavailable (older
   brain), skip this step silently and proceed — the gate degrades to the
   FR-132 display-only advisory. Do NOT block the hunt on MCP absence.

3. Verify commit succeeded
4. Update brief: Status = "Done", Completed = today
5. Call `igris_brief_sync` with status="Done", phase="COMMITTING".
   **If brain MCP is NOT available or the call fails:**
   - Display: `WARNING: Brain sync skipped for {BRIEF_ID} (status=Done) — MCP unavailable. Queued locally for next /boot or /sync data.`


1. Update brief: Phase = COMPLETE
2. Call `igris_brief_sync` with status="Done" (unchanged) and phase="COMPLETE".
   This is the terminal-phase flip — Phase 7 synced phase="COMMITTING"; this
   step lands the canonical phase=COMPLETE in the brain DB so the

## Agent Event Emission (Mandatory When Available)

On each agent invocation, you MUST emit `igris_agent_event` calls if brain MCP is available AND Instance ID exists in `~/.igris/projects/{project}/session/instances/<instance_id>.md`.

**Pattern for every agent:**

1. **Before invoking agent:** Call `igris_agent_event` with event_type="start"
2. **After agent returns successfully:** Call `igris_agent_event` with event_type="stop" and result summary
3. **On agent failure:** Call `igris_agent_event` with event_type="error" and error_message
4. **On retry:** Call `igris_agent_event` with event_type="retry" and metadata with attempt count and reason

