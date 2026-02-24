# BR-029: VPS Deploy Script References Removed Dashboard

**Type:** Bug Fix
**Priority:** P2-Medium
**Effort:** S-Small (< 4h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Completed:** 2026-02-24
**Created:** 2026-02-24

---

## Problem

**What's broken or missing?**

The VPS deploy script (`scripts/igris_vps_update.sh`) on the VPS was running an older version that still contained a "Deploying Crimson Arena dashboard..." step referencing `dashboard/server.py`. This file was removed in MG-012 (commit `2043cd0`) when Crimson Arena was extracted to its own standalone repo (`fiftynotai/crimson-arena`).

During `/sync code` on 2026-02-24, the VPS pulled 6 commits and the brain MCP server rebuilt successfully, but the deploy script exited with code 1 at the dashboard deployment step:
```
Deploying Crimson Arena dashboard...
  [FAIL] server.py not found in /root/igris-ai/dashboard
```

**Why does it matter?**

The `/sync code` command reports failure (exit 1) even though the critical components (git pull + brain MCP server build) succeed. This is confusing and blocks clean deployment workflows.

**Note:** The current local version of `igris_vps_update.sh` does NOT contain dashboard deployment logic. The error occurred because the VPS was running the pre-pull (older) version of the script. The VPS now has the updated script after pulling. However, verification is needed to confirm the issue is fully resolved and no other VPS artifacts reference the removed dashboard.

---

## Goal

**What should happen after this brief is completed?**

1. `/sync code` completes with exit 0 (no dashboard-related failures)
2. No scripts, configs, or PM2 processes on the VPS reference the removed `dashboard/` directory
3. Any stale PM2 processes for the old Python dashboard server are cleaned up

---

## Context & Inputs

### Affected Modules
- [x] `scripts/igris_vps_update.sh` — VPS deploy script
- [x] VPS server configuration (PM2, cron, etc.)

### Layers Touched
- [x] Scripts/Infrastructure

### API Changes
- [x] No API changes

### Dependencies
- [x] SSH access to VPS (root@76.13.180.77)

### Related Files
- `scripts/igris_vps_update.sh` — Main deploy script (local version appears clean)
- VPS: `/root/igris-ai/scripts/igris_vps_update.sh` — Remote copy (now updated after pull)
- VPS PM2 config — May have stale dashboard process

---

## Constraints

### Architecture Rules
- Follow bash standards from `coding_guidelines.md` (set -e, quoted vars, etc.)

### Out of Scope
- Crimson Arena deployment (now managed in its own repo)
- Brain v5.0 changes

---

## Tasks

### Pending
- [ ] Task 1: Verify current `igris_vps_update.sh` has no dashboard references
- [ ] Task 2: SSH to VPS and check for stale PM2 processes related to old dashboard
- [ ] Task 3: Check VPS cron jobs for any dashboard-related entries
- [ ] Task 4: Run `/sync code` and confirm clean exit 0
- [ ] Task 5: Clean up any remaining `dashboard/` artifacts on VPS if present

---

## Workflow State

**Phase:** INIT
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered. Awaiting hunt command.

### Next Steps
1. Investigate if the current script is already clean (likely yes)
2. SSH verify VPS state
3. Clean up any stale artifacts

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|

### Blockers
None

---

## Acceptance Criteria

**The fix is complete when:**

1. [ ] `scripts/igris_vps_update.sh` contains zero references to `dashboard/`, `server.py`, or Crimson Arena
2. [ ] `/sync code` exits with code 0 (full clean run)
3. [ ] No stale PM2 processes for the old dashboard on VPS
4. [ ] No stale cron entries referencing the old dashboard on VPS

---

## Test Plan

### Manual Test Cases

#### Test Case 1: Clean Code Sync
**Preconditions:** VPS is reachable, branch is develop
**Steps:**
1. Run `/sync code`
2. Observe output for any dashboard-related messages

**Expected Result:** Deploy completes with exit 0, no dashboard references in output
**Status:** [ ] Pass / [ ] Fail

---

## Delivery

### Code Changes
- [ ] Modified files: `scripts/igris_vps_update.sh` (if changes needed)
- [ ] VPS cleanup: Remove stale PM2/cron entries (if any)

### Deployment Notes
- [ ] Requires VPS SSH access for verification and cleanup

---

## Notes

- The current local script (`b3a31e7`) appears already clean — the dashboard deployment logic was likely removed as part of MG-012
- The VPS pulled the fix during this sync session (84529b6 -> b3a31e7)
- This brief is primarily a **verification and cleanup** task
- Related: MG-012 (Crimson Arena extraction), commit `2043cd0`

---

**Created:** 2026-02-24
**Last Updated:** 2026-02-24
**Brief Owner:** Igris AI
