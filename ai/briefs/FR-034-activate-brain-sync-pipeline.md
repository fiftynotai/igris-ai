# FR-034: Activate Brain Sync in /awaken and /rest Skills

**Type:** Feature Request
**Priority:** P0-Critical
**Effort:** S-Small (< 4h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Ready
**Created:** 2026-02-17

---

## Feature Description

**What is the proposed feature?**

Change `/awaken` step 3.6 ("Pull from Remote Brain") and `/rest` step 2.7 ("Push to Remote Brain") from "Optional" to "Mandatory when remote brain is configured." The sync tools (`igris_brain_pull`, `igris_brain_push`) exist and work, but the orchestrator skips them because the skills mark them as optional.

**Why is this valuable?**

This is the single most impactful change for the distributed brain vision. Without activating sync in the session lifecycle, the VPS brain receives zero data from any local machine. Every table (learnings, errors, projects, sessions, briefs, instances, metrics) stays isolated locally. Fixing this one gap activates the entire sync pipeline end-to-end.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
- `/awaken` step 3.6 says "Pull from Remote Brain (Optional)" — orchestrator skips it
- `/rest` step 2.7 says "Push to Remote Brain (Optional)" — orchestrator skips it
- VPS brain has 0 learnings, 0 sessions, 0 errors, 0 projects synced
- Every machine is an isolated island

**With this feature:**
- `/awaken` pulls latest data from VPS brain (learnings, errors, patterns from other machines)
- `/rest` pushes all local changes to VPS brain (learnings, sessions, metrics, briefs, instances)
- VPS brain becomes the living centralized knowledge store
- Cross-machine intelligence sharing works

---

## Technical Approach

### High-Level Design

**Same pattern as FR-032:** Change "Optional" to "Mandatory" with "You MUST" language and graceful fallback.

### Components Affected
- `.claude/skills/awaken/SKILL.md` — Step 3.6: change "Optional" to "Mandatory"
- `.claude/skills/rest/SKILL.md` — Step 2.7: change "Optional" to "Mandatory"
- `ai/prompts/igris_os.md` — Update Brain Integration Points to mark pull/push as mandatory

---

## Context & Inputs

### Dependencies
- [x] FR-033: Brain MCP HTTP transport fix (MUST be fixed first — tools don't load without it)
- [x] FR-022: HTTP transport (Done)
- [x] FR-030: Brain sync activation (Done — sync tools work)

### Files to Modify
- `.claude/skills/awaken/SKILL.md` — Step 3.6
- `.claude/skills/rest/SKILL.md` — Step 2.7
- `ai/prompts/igris_os.md` — Brain Integration Points

---

## Constraints

### Technical Constraints
- Sync must not block session start/end if VPS is unreachable
- Pull on /awaken should be fast (< 5s timeout)
- Push on /rest should queue if VPS unreachable (see FR-036)
- Must read remote_brain.url and api_key from `~/.igris/config.json`

### Out of Scope
- Offline queuing (FR-036)
- Real-time/live sync (future)

---

## Tasks

### Pending
- [ ] Update `/awaken` skill step 3.6 — "Optional" to "Mandatory"
- [ ] Update `/rest` skill step 2.7 — "Optional" to "Mandatory"
- [ ] Update `igris_os.md` brain integration points
- [ ] Test: /awaken pulls data from VPS brain
- [ ] Test: /rest pushes all tables to VPS brain
- [ ] Test: VPS unreachable → graceful skip, no hang

---

## Workflow State

**Phase:** INIT
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered. Blocked by FR-033 (MCP tools must load first).

### Next Steps
Fix FR-033 first, then `/hunt FR-034`.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|

### Blockers
- FR-033 must be completed first (brain MCP tools don't load)

---

## Acceptance Criteria

1. [ ] `/awaken` calls `igris_brain_pull` on every session start (when remote brain configured)
2. [ ] `/rest` calls `igris_brain_push` on every session end (when remote brain configured)
3. [ ] VPS brain receives data after /rest (verify via /api/brain-stats)
4. [ ] Local brain receives data after /awaken (verify via sqlite3 query)
5. [ ] VPS unreachable → graceful skip with notice, no hang or crash
6. [ ] Remote brain not configured → silent skip (no error)

---

## Test Plan

### Functional Tests

**Test Case 1: Push on /rest**
1. Run `/rest`
2. Check VPS: `curl /api/brain-stats` — verify counts > 0
**Expected Result:** Learnings, sessions, projects, metrics synced to VPS

**Test Case 2: Pull on /awaken**
1. Add a learning on VPS directly
2. Run `/awaken`
3. Query local DB for the learning
**Expected Result:** Learning pulled from VPS to local

**Test Case 3: VPS Unreachable**
1. Block VPS connectivity
2. Run `/rest`
3. Verify session ends normally with notice
**Expected Result:** "Brain sync skipped (VPS unreachable)" — no hang

---

## Notes

**Depends on:** FR-033 (Critical — MCP tools must load)
**Enables:** All brain features — cross-machine sync, dashboard data, distributed intelligence
**Same pattern as:** FR-032 (change "Optional" to "Mandatory")

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Crimson (Fifty.ai)
