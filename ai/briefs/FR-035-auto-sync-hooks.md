# FR-035: Auto-Sync Hooks for Brief and Session Changes

**Type:** Feature Request
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Ready
**Created:** 2026-02-17

---

## Feature Description

**What is the proposed feature?**

Add Claude Code hooks that automatically trigger brain sync when brief files or session files are modified. Currently, sync only happens on explicit MCP tool calls which the orchestrator often skips. Hooks provide a reliable event-driven sync trigger that fires on every file write.

**Why is this valuable?**

Without automatic sync triggers, the VPS brain only receives data during `/awaken` (pull) and `/rest` (push). Between those bookends, all brief status changes, session updates, learnings, and decisions stay local. Hooks bridge this gap by pushing changes as they happen — enabling near-real-time data flow to the VPS.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
- Brief status changes (`Ready` → `In Progress` → `Done`) never pushed between /awaken and /rest
- Session file updates (CURRENT_SESSION.md, LEARNINGS.md, DECISIONS.md) stay local
- VPS dashboard shows stale data until next full push
- No event-driven sync — everything is manual

**With this feature:**
- Brief file write → auto-sync brief status to brain
- Session file write → auto-sync session snapshot to brain
- VPS dashboard reflects changes within seconds
- Offline: changes queue in staging, push on reconnect

---

## Technical Approach

### High-Level Design

Use Claude Code's hook system (`.claude/hooks/`) to trigger sync on file writes:

1. **PostToolUse hook for Edit/Write** — detect when brief or session files are modified
2. **Extract metadata** — parse brief status/priority or session mode from written content
3. **Call brain MCP tools** — `igris_brief_sync` for briefs, `igris_session_sync` for sessions
4. **Queue on failure** — if brain MCP unavailable, write to `~/.igris/staging/` for later

### Components Affected
- `.claude/hooks/` — New hook scripts for brief/session sync
- `~/.igris/staging/` — Queue for offline changes

### Hook Design
```bash
# .claude/hooks/post_brief_sync.sh
# Trigger: PostToolUse for Edit/Write on ai/briefs/*.md
# Action: Call igris_brief_sync with brief metadata
```

---

## Context & Inputs

### Dependencies
- [x] FR-033: Brain MCP HTTP transport fix (tools must load)
- [x] FR-034: Activate brain sync pipeline (push/pull must work)
- [x] Claude Code hook system (exists, used by session_end.sh)

### Files to Create
- `.claude/hooks/post_brief_sync.sh` — Brief change hook
- `.claude/hooks/post_session_sync.sh` — Session change hook

### Files to Modify
- `.claude/settings.json` or hook config — Register new hooks

---

## Constraints

### Technical Constraints
- Hooks must be non-blocking (async/background — don't slow down file writes)
- Must not fail loudly if brain MCP unavailable
- Must handle rapid successive writes (debounce or last-write-wins)
- Queue changes if offline, don't lose data

### Out of Scope
- File watching daemon (future — use hooks for now)
- WebSocket push to dashboard (future)
- Conflict resolution for concurrent edits across machines

---

## Tasks

### Pending
- [ ] Design hook trigger conditions (which files, which tool events)
- [ ] Create post_brief_sync.sh hook
- [ ] Create post_session_sync.sh hook
- [ ] Implement staging/queue for offline changes
- [ ] Register hooks in Claude Code config
- [ ] Test: edit brief → VPS brain sees status change within 5s
- [ ] Test: edit session → VPS brain sees session update
- [ ] Test: offline edit → queued → push on reconnect

---

## Workflow State

**Phase:** INIT
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered. Blocked by FR-033 and FR-034.

### Next Steps
Implement after FR-033 and FR-034 are complete.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|

### Blockers
- FR-033 (MCP tools must load)
- FR-034 (base sync must work)

---

## Acceptance Criteria

1. [ ] Brief file edit triggers automatic `igris_brief_sync` call
2. [ ] Session file edit triggers automatic `igris_session_sync` call
3. [ ] VPS brain reflects brief status changes within 10 seconds
4. [ ] Hooks are non-blocking (file write completes immediately)
5. [ ] Offline changes queued in staging directory
6. [ ] Queued changes pushed on next successful sync
7. [ ] No data loss on hook failure (queue, don't discard)

---

## Notes

**Depends on:** FR-033, FR-034
**Enables:** Near-real-time dashboard updates, live brief tracking across machines
**Existing hook reference:** `.claude/hooks/session_end.sh` (staging pipeline pattern)

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Crimson (Fifty.ai)
