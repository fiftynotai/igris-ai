# BR-044: Crimson Arena — Instances Visibility & Reliability

**Type:** BR
**Priority:** P1
**Effort:** M-Medium
**Status:** In Progress
**Created:** 2026-02-28
**Completed:** _TBD_

---

## Problem

Two related issues with instance lifecycle in Crimson Arena dashboard (Instances page and Project Detail page):

### Issue 1: Instance Duplication on /rest → /awaken Cycle

When a user runs `/rest` and then `/awaken`, a **duplicate instance** appears in the dashboard. The old instance from the previous session is never cleaned up, and `/awaken` registers a fresh one. Result: two instances for the same project on the same machine — one showing the previous brief (e.g., "BR-044") and the other showing just "active" with no associated brief.

**Observed:** After `/rest` + `/awaken`, brain shows:
- `082407c2` — stale instance from prior session (brief: BR-044, phase: REGISTERED)
- `77af4c77` — new instance from this `/awaken` (no brief, no phase)

**Root cause:** No deregistration happens on session end. Instances are orphaned and linger until the 2h auto-purge:
- `/rest` skill does NOT call `igris_instance_remove`
- `/exit` (closing terminal / Ctrl+C / Claude Code exit) has no cleanup hook at all
- If the terminal window dies (crash, force quit, SSH disconnect), the instance is completely abandoned

### Issue 2: Instances Disappear During Long Sessions

1. **Auto-purge too aggressive**: `igris_instance_list` marks instances as stale after 30 minutes without heartbeat and purges after 2 hours. During a long session, no periodic heartbeats are sent after the initial `/awaken` registration, causing the instance to vanish mid-session.

2. **No periodic heartbeat from Igris sessions**: The `/awaken` skill registers the instance once but never sends follow-up heartbeats. A 2+ hour session will have its instance purged while still actively running.

3. **Dashboard shows "no instances" when brain has none**: When all instances are purged, the Instances page and Project Detail page show empty state with no explanation of why (stale vs genuinely no sessions).

## Goal

Ensure active Igris sessions remain visible in the dashboard for the duration of the session, and provide clear UX when instances are absent.

## Scope

**Repositories:** igris-ai (brain MCP, skills), crimson-arena (dashboard)

## Important Constraint

**Multiple instances per machine is valid.** A user may run 3+ Claude Code instances on the same machine across different projects simultaneously. `/awaken` must NOT blindly remove other instances from the same hostname — only clean up the **exact instance_id** from the previous session in CURRENT_SESSION.md (if it exists and is stale).

## Investigation Areas

1. **`/rest` skill**: Does NOT call `igris_instance_remove` — must deregister instance on session end
   - Fix: Add `igris_instance_remove(instance_id)` call to `/rest` skill before session sync
   - The instance_id is stored in CURRENT_SESSION.md during `/awaken`

2. **`/exit` and unexpected termination**: No cleanup happens when the user exits Claude Code without `/rest`
   - Claude Code has a `PreToolUse` / `PostToolUse` / `Notification` hook system — investigate if there's a session-end or exit hook
   - If no exit hook exists: the brain's auto-purge is the only safety net — make it smarter (see #4)
   - Consider: a Claude Code `stop` hook or `SubagentStop` hook that fires on session end

3. **`/awaken` skill**: Should detect if CURRENT_SESSION.md contains a previous instance_id and that instance is stale, then remove **only that specific instance** before registering a new one
   - Do NOT remove all instances from the same hostname (multi-instance is valid)
   - Only remove the exact previous instance_id if it still exists and is stale

4. **Brain side**: Review `igris_instance_list` purge logic (30min stale, 2h purge). Consider:
   - Should stale timeout be longer?
   - Should purge be less aggressive for instances with active briefs?
   - Should the `igris_instance_heartbeat` be called periodically during `/hunt` workflows?
   - The auto-purge is the fallback for crashed/killed sessions — make sure it's reliable

5. **Igris session side**: Review `/hunt` skill:
   - `/hunt` updates instance with current brief/phase — but only at phase transitions
   - Gap: long BUILDING phases (FORGER running 5+ minutes) send no heartbeats

6. **Dashboard side**: Review how crimson-arena fetches and displays instances:
   - Does the WebSocket correctly push instance updates?
   - Is the REST fallback working when WS is stale?
   - Should the dashboard show "last seen" for recently purged instances?

## Acceptance Criteria

1. [ ] `/rest` deregisters the instance via `igris_instance_remove` before ending session
2. [ ] Exiting Claude Code without `/rest` is handled (exit hook or reliable auto-purge fallback)
3. [ ] `/awaken` removes only the **exact previous instance_id** from session file if stale (not all instances from same host)
4. [ ] No duplicate instances appear after a `/rest` → `/awaken` cycle
5. [ ] Multiple instances on the same machine (different projects) coexist without interference
6. [ ] Active Igris sessions remain visible in dashboard for the full session duration
7. [ ] Instance heartbeat frequency is sufficient to prevent stale marking during normal workflows
8. [ ] Dashboard shows meaningful state when no instances are active (e.g., "No active sessions" with last-seen info)
9. [ ] `flutter analyze` passes (if dashboard changes)

---

**Created:** 2026-02-28
