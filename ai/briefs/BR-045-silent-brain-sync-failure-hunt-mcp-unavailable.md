# BR-045: Silent brain sync failure — briefs lost when MCP unavailable during /hunt

**Type:** Bug Fix
**Priority:** P1-High
**Effort:** M-Medium
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** In Progress
**Created:** 2026-03-01
**Completed:** _(if Status: Done)_

---

## Problem

**What's broken or missing?**

When the igris-brain MCP server is unavailable during a `/hunt` or `/register` skill execution, the `igris_brief_sync` call is silently skipped per the skill's design ("If brain MCP is not available, skip silently. No errors."). This causes briefs to never appear on the Crimson Arena dashboard despite being successfully hunted and committed locally.

**Evidence:**
- Project `fifty-eco-system` hunted AC-002 through AC-007 and registered TD-010 between Feb 28 – Mar 1, 2026.
- The brain event log shows ZERO `brief.synced` or `brief.created` events for any of these briefs.
- Meanwhile, BR-128, BR-129, BR-130 (hunted on Feb 27) were synced correctly — proving the brain was functional before and after.
- The brain MCP server was likely not connected to the Claude Code instances that ran those specific sessions.
- The user was never warned that brain sync was skipped.

**Root Cause:**

The `/hunt` skill (SKILL.md lines 89-99) and `/register` skill (SKILL.md lines 107-119) both use "skip silently if unavailable" for `igris_brief_sync`. There is no fallback, no warning, and no queuing mechanism.

**Why does it matter?**

Briefs that are hunted and committed locally but never synced to the brain are invisible on the Crimson Arena dashboard. The user has no way to know that sync was skipped, leading to a false sense of completeness. This undermines trust in the brain as the single source of truth for project status.

---

## Goal

**What should happen after this brief is completed?**

Brief status changes are never silently lost when the brain MCP is unavailable. Users receive visible warnings when sync is skipped, and skipped syncs are recoverable through either a local queue or a reconciliation mechanism during `/awaken`.

---

## Context & Inputs

### Affected Modules
- [x] Skill: `/hunt` (SKILL.md)
- [x] Skill: `/register` (SKILL.md)
- [x] Skill: `/awaken` (SKILL.md)
- [x] Skill: `/sync` (SKILL.md)

### Layers Touched
- [ ] Presentation (UI/Views)
- [x] Business Logic (Controllers/ViewModels/Services)
- [ ] Data Layer (Repositories/APIs)
- [ ] Domain (Models/Entities)

### API Changes
- [ ] New endpoint
- [ ] Modified endpoint
- [x] No API changes

### Dependencies
- [x] Existing service: igris-brain MCP server (`igris_brief_sync`, `igris_brief_dashboard`)
- [ ] New package
- [ ] External API

### Related Files
- `~/.igris/core/skills/hunt/SKILL.md` — add warning + queue on sync failure
- `~/.igris/core/skills/register/SKILL.md` — add warning + queue on sync failure
- `~/.igris/core/skills/awaken/SKILL.md` — add reconciliation step
- `~/.igris/core/skills/sync/SKILL.md` — add queue drain step (if local queue approach chosen)

---

## Constraints

### Architecture Rules
- Must follow project architecture pattern (see coding_guidelines.md)
- Respect layer boundaries
- Skill files are markdown-based instructions, not executable code — changes are to agent behavior definitions

### Technical Constraints
- Must not break existing `/hunt` or `/register` flows when MCP IS available
- Warning must be visible in the agent output (not buried in logs)
- Queue file format must be simple and human-readable (JSONL preferred)

### Timeline
- **Deadline:** N/A
- **Milestones:** None

### Out of Scope
- Automatic retry of failed syncs in real-time (would complicate skill execution)
- Changes to the brain MCP server itself
- Changes to Crimson Arena dashboard

---

## Proposed Solutions

**Pick one or combine:**

1. **Warning on skip** — When `igris_brief_sync` is skipped due to MCP unavailability, display a visible warning: "WARNING: Brain MCP unavailable — brief sync skipped for {BRIEF_ID}. Run `/sync data` to reconcile later."

2. **Local queue** — Write skipped sync operations to a local queue file (e.g., `ai/session/metrics/sync_queue.jsonl`). The `/awaken` or `/sync data` skill drains this queue on next session.

3. **Reconciliation on /awaken** — During `/awaken` step 4 (System Assessment), compare local `ai/briefs/*.md` statuses against `igris_brief_dashboard` results. Flag any briefs that exist locally but not in the brain.

---

## Tasks

### Pending
- [ ] Task 6: Reconcile existing missing briefs (AC-002–AC-007, TD-010 on fifty-eco-system)

### In Progress
_(Tasks currently being worked on)_

### Completed
- [x] Task 1: Add visible warning to `/hunt` SKILL.md when `igris_brief_sync` is skipped (INIT + COMMITTING phases)
- [x] Task 2: Add visible warning to `/register` SKILL.md when `igris_brief_create` fails
- [x] Task 3: Implement local sync queue file (`~/.igris/cache/{project}/sync_queue.jsonl`) — JSONL format, written by hunt/register on MCP failure
- [x] Task 4: Add local queue drain step to `/sync` SKILL.md (Step [0/5] before remote drain)
- [x] Task 5: Add local sync queue drain step to `/awaken` SKILL.md (Step 3.6.1.1 with MCP-unavailable warning)

---

## Workflow State

**Phase:** BUILDING
**Active Agent:** forger
**Retry Count:** 0

### Current Work
Implementing all three proposed solutions: visible warnings, local sync queue, and reconciliation on /awaken.

### Next Steps
Proceed to TESTING phase.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-03-09 | architect | Create implementation plan | SUCCESS |
| 2026-03-09 | forger | Implement changes across 4 skill files | IN PROGRESS |

### Blockers
None

---

## Acceptance Criteria

**The fix is complete when:**

1. [ ] When brain MCP is unavailable during `/hunt`, user sees a visible warning (not silent skip)
2. [ ] When brain MCP is unavailable during `/register`, user sees a visible warning (not silent skip)
3. [ ] Skipped brief syncs are recoverable (either via queue or reconciliation)
4. [ ] `/awaken` detects drift between local briefs and brain state
5. [ ] Existing missing briefs (AC-002–AC-007, TD-010 on fifty-eco-system) can be reconciled
6. [ ] Linter/analyzer passes (zero issues)
7. [ ] No regressions to `/hunt` or `/register` when MCP IS available

---

## Test Plan

### Automated Tests
- [ ] N/A (skill files are markdown agent instructions, not executable code)

### Manual Test Cases

#### Test Case 1: Warning on MCP unavailability during /hunt
**Preconditions:** Brain MCP server is disconnected/unavailable
**Steps:**
1. Run `/hunt` on a brief
2. Complete the hunt successfully (local commit)
3. Observe agent output

**Expected Result:** Visible warning displayed: "WARNING: Brain MCP unavailable — brief sync skipped for {BRIEF_ID}."
**Actual Result:** [Fill during testing]
**Status:** [ ] Pass / [ ] Fail

#### Test Case 2: Reconciliation on /awaken with known drift
**Preconditions:** Local briefs exist that are not in the brain
**Steps:**
1. Run `/awaken`
2. Observe system assessment output

**Expected Result:** System assessment flags briefs that exist locally but not in the brain
**Actual Result:** [Fill during testing]
**Status:** [ ] Pass / [ ] Fail

#### Test Case 3: Queue drain on /sync data
**Preconditions:** Sync queue file has pending entries, brain MCP is now available
**Steps:**
1. Run `/sync data`
2. Observe output

**Expected Result:** Queued syncs are processed and briefs appear on Crimson Arena dashboard
**Actual Result:** [Fill during testing]
**Status:** [ ] Pass / [ ] Fail

### Regression Checklist
- [ ] `/hunt` works normally when MCP IS available
- [ ] `/register` works normally when MCP IS available
- [ ] `/awaken` works normally with no drift
- [ ] `/sync data` works normally with empty queue

---

## Delivery

### Code Changes
- [ ] Modified files: `~/.igris/core/skills/hunt/SKILL.md`
- [ ] Modified files: `~/.igris/core/skills/register/SKILL.md`
- [ ] Modified files: `~/.igris/core/skills/awaken/SKILL.md`
- [ ] Modified files: `~/.igris/core/skills/sync/SKILL.md`

### Database Migrations
- [ ] N/A

### Configuration Changes
- [ ] N/A

### Documentation Updates
- [ ] Update skill documentation if behavior changes are user-visible

### Deployment Notes
- [ ] Requires app restart: No
- [ ] Backend changes needed first: No
- [ ] Rollback plan: Revert SKILL.md changes

---

## Notes

This bug was discovered during the fifty-eco-system AC-001 theme customization pipeline (AC-002 through AC-007) where 6 architecture cleanup briefs and 1 technical debt brief were hunted successfully but never appeared on the Crimson Arena dashboard. The brain was functional before and after this window, confirming the issue is specifically about MCP connection availability during the Claude Code sessions that executed those hunts.

---

**Created:** 2026-03-01
**Last Updated:** 2026-03-01
**Brief Owner:** Fifty.ai
