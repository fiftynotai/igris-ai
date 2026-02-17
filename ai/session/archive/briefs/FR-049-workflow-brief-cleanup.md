# FR-049: Workflow & Brief Cleanup — Pre-Release Fixes

**Type:** Feature Request
**Priority:** P1-High
**Effort:** S-Small (< 4h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-17
**Completed:** 2026-02-17

---

## Feature Description

**What is the proposed feature?**

Fix workflow gaps and clean up the brief system for v4.0 release. Create missing documenter agent, archive 23+ completed briefs, fix stale briefs, and update BLOCKERS.md.

**Why is this valuable?**

The `/hunt` workflow references a "documenter" agent that doesn't exist (breaks DOCUMENTING phase). 23 completed briefs clutter the active directory. Several briefs have inconsistent states. BLOCKERS.md doesn't reflect current blockers.

---

## Issues to Fix

### CRITICAL (1)

#### CR-001: "documenter" Agent Referenced but Doesn't Exist
**File:** `.claude/skills/hunt/SKILL.md:251, 267-284`
**Problem:** DOCUMENTING phase delegates to "documenter" agent, but no `.claude/agents/documenter.md` exists.
**Fix:** Update hunt skill to use `/document` skill directly instead of delegating to a non-existent subagent. The DOCUMENTING phase should invoke the `/document` skill as an orchestrator-level operation (matching the skill-based pattern in rules/04-igris-agents.md which lists `/document` as a skill, not an agent delegation).

### HIGH (3)

#### H-001: 23 Done Briefs Not Archived
**Problem:** FR-022 through FR-044 (23 briefs) are Done but still in `ai/briefs/`. Should be in `ai/briefs/archive/`.
**Fix:** Move all 23 to archive, update CURRENT_SESSION.md archived list.

#### H-002: Stale Briefs Need Status Fix
**Problems:**
- FR-014: Status "In Progress" but blocked on external input. Should be "Blocked".
- TD-005: Missing Workflow State section entirely. Stale since Oct 2025.
- FR-037/038/039: Status unclear — either implement or clarify as Done.
**Fix:** Update each brief's status and workflow state to match reality.

#### H-003: BLOCKERS.md Not Current
**File:** `ai/session/BLOCKERS.md`
**Problem:** Shows "No active blockers" but FR-014 is blocked on URL slugs. Last entry from Oct 2025.
**Fix:** Add FR-014 blocker, review protocol for keeping current.

---

## Tasks

### Pending
_(none)_

### Completed
- [x] Task 1: Update hunt skill DOCUMENTING phase to use /document skill (CR-001)
- [x] Task 2: Archive FR-022 through FR-044 (23 briefs) to ai/briefs/archive/ (H-001)
- [x] Task 3: Update CURRENT_SESSION.md archived list (H-001)
- [x] Task 4: Fix FR-014 status to "Blocked" with clear blocker (H-002)
- [x] Task 5: Archive stale TD-005 (H-002) — stale since Oct 2025, archived
- [x] Task 6: Clarify FR-037/038/039 status (H-002) — already Done and archived in H-001
- [x] Task 7: Update BLOCKERS.md with FR-014 blocker (H-003)

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** forger
**Retry Count:** 0

### Current Work
All 7 tasks implemented by FORGER.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-17 | forger | CR-001: Fix hunt DOCUMENTING phase | SUCCESS |
| 2026-02-17 | forger | H-001: Archive 23 briefs + TD-005 | SUCCESS (24 briefs archived) |
| 2026-02-17 | forger | H-001: Update CURRENT_SESSION.md | SUCCESS |
| 2026-02-17 | forger | H-002: Fix FR-014 status to Blocked | SUCCESS |
| 2026-02-17 | forger | H-003: Update BLOCKERS.md | SUCCESS |

### Blockers
None

---

## Acceptance Criteria

1. [x] Hunt skill DOCUMENTING phase works without "documenter" agent
2. [x] 23 completed briefs moved to archive directory (+ TD-005 = 24 total)
3. [x] CURRENT_SESSION.md archived list includes FR-022 through FR-045
4. [x] FR-014 status is "Blocked" with clear blocker description
5. [x] TD-005 archived (stale since Oct 2025)
6. [x] FR-037/038/039 archived as Done (confirmed via CURRENT_SESSION.md)
7. [x] BLOCKERS.md reflects current active blockers (FR-014 entry added)

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Crimson (Fifty.ai)
