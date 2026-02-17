# FR-032: Fix Live Instance Registration & Heartbeat

**Type:** Feature Request
**Priority:** P1-High
**Effort:** S-Small (< 4h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-16

---

## Feature Description

**What is the proposed feature?**

Fix the instance registration flow so that `/awaken` actually calls `igris_instance_heartbeat` and the local instance appears on the VPS Crimson Arena dashboard. Additionally, add periodic heartbeat refresh to prevent instances from going stale during long sessions, and ensure `/rest` deregisters the instance.

**Why is this valuable?**

The Live Instances panel on the VPS dashboard shows zero instances despite active local sessions. The entire instance registry infrastructure exists (FR-026) but the first step — calling `igris_instance_heartbeat` at session start — never fires. The `/awaken` skill marks step 3.7 as "Optional" and the orchestrator silently skips it. No registration = no sync = no dashboard data.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
- `/awaken` skill step 3.7 says "Optional" — orchestrator skips it
- Local brain `instances` table has 0 rows
- CURRENT_SESSION.md has no Instance ID field
- VPS `/api/instances` returns empty array
- Dashboard Live Instances panel shows "0 instances"
- Even if registered once, instance goes stale after 30 min (no periodic heartbeat)

**With this feature:**
- `/awaken` registers instance on every session start (mandatory, not optional)
- Instance ID stored in CURRENT_SESSION.md
- Periodic heartbeat keeps instance "active" during long sessions
- `/rest` deregisters instance (already documented but never fires)
- VPS dashboard shows live instances with real-time status

---

## Use Cases

### Use Case 1: Session Start → Instance Visible
**Actor:** Developer starting a session
**Goal:** See local instance on VPS dashboard
**Steps:**
1. Run `/awaken`
2. `igris_instance_heartbeat` called with machine hostname, OS, project
3. Instance ID stored in CURRENT_SESSION.md
4. Next `igris_brain_push` syncs instance to VPS
5. Dashboard shows instance in Live Instances panel
**Expected Outcome:** Instance visible within 2 minutes of session start

### Use Case 2: Long Session → Instance Stays Active
**Actor:** Developer in a multi-hour session
**Goal:** Instance doesn't go stale
**Steps:**
1. Start session (instance registered)
2. Work for 2+ hours
3. Dashboard still shows instance as "active"
**Expected Outcome:** Periodic heartbeat refreshes every 15 minutes, instance never goes stale

### Use Case 3: Session End → Instance Removed
**Actor:** Developer ending session
**Goal:** Instance removed from live registry
**Steps:**
1. Run `/rest`
2. `igris_instance_remove` called with stored instance ID
3. Instance removed or marked inactive
**Expected Outcome:** Dashboard no longer shows the instance

---

## Technical Approach

### High-Level Design

**Fix 1: Make registration mandatory in /awaken**
- Change step 3.7 from "Optional" to mandatory (when brain MCP available)
- Strengthen language: "MUST call" instead of "If available, call"
- Add verification: if heartbeat succeeds, store Instance ID in session file
- If brain MCP truly unavailable, skip gracefully (but log it)

**Fix 2: Add periodic heartbeat to /hunt workflow**
- During long-running `/hunt` operations, refresh heartbeat between phases
- Call `igris_instance_heartbeat` with current_brief and current_phase fields
- Keeps instance active and shows real-time workflow progress on dashboard

**Fix 3: Ensure /rest deregisters**
- `/rest` skill step 2.5 already documents calling `igris_instance_remove`
- Verify the language is strong enough (not "Optional")
- Ensure Instance ID is read from CURRENT_SESSION.md

**Fix 4: Strengthen igris_os.md**
- Add instance heartbeat to the Post-Initialization Analysis Protocol
- Mention instance registration in the system assessment display

### Components Affected

- `.claude/skills/awaken/SKILL.md` — Strengthen step 3.7 (mandatory, not optional)
- `.claude/skills/hunt/SKILL.md` — Add periodic heartbeat between workflow phases
- `.claude/skills/rest/SKILL.md` — Verify step 2.5 deregistration language
- `ai/prompts/igris_os.md` — Add instance registration to init protocol

---

## Context & Inputs

### Dependencies
- [x] FR-026: Live Instance Registry (DONE — infrastructure exists)
- [x] FR-030: Brain Sync Activation (DONE — sync pipeline operational)
- [x] `instances` table in sync config (already configured in sync.ts)

### Files to Create
- None

### Files to Modify
- `.claude/skills/awaken/SKILL.md` — Strengthen step 3.7
- `.claude/skills/hunt/SKILL.md` — Add heartbeat between phases
- `.claude/skills/rest/SKILL.md` — Verify step 2.5
- `ai/prompts/igris_os.md` — Add instance registration to init protocol

---

## Constraints

### Technical Constraints
- Heartbeat call must be fast (< 1s)
- Must not block session start if brain MCP unavailable
- Periodic heartbeat must not disrupt workflow execution
- Instance ID must persist in CURRENT_SESSION.md for /rest deregistration

### Out of Scope
- Auto-discovery of other instances (peer-to-peer)
- Instance-to-instance communication
- Load balancing between instances

---

## Tasks

### Pending
- [ ] Update `/awaken` skill — change step 3.7 from "Optional" to mandatory
- [ ] Update `/hunt` skill — add heartbeat refresh between workflow phases
- [ ] Verify `/rest` skill — step 2.5 deregistration is actionable
- [ ] Update `igris_os.md` — add instance registration to init protocol
- [ ] Test: run /awaken, verify Instance ID in CURRENT_SESSION.md
- [ ] Test: verify local instances table has 1 row
- [ ] Test: run igris_brain_push, verify instance appears on VPS
- [ ] Test: run /rest, verify instance removed

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered. Ready for HUNT.

### Next Steps
Run `/hunt FR-032` to begin implementation.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-17 | ARCHITECT | Planning FR-032 | COMPLETE — 4 files, 7 changes identified |
| 2026-02-17 | FORGER | Implementing FR-032 | COMPLETE — 4 files, 7 changes applied |
| 2026-02-17 | SENTINEL | Validating FR-032 changes | PASS — all 4 files verified, 0 issues |
| 2026-02-17 | WARDEN | Reviewing FR-032 | APPROVE — quality 9/10, all ACs covered |

### Blockers
None

---

## Acceptance Criteria

1. [ ] `/awaken` calls `igris_instance_heartbeat` on every session start
2. [ ] Instance ID stored in CURRENT_SESSION.md after registration
3. [ ] Local brain `instances` table has active entry after /awaken
4. [ ] `/hunt` refreshes heartbeat between workflow phases
5. [ ] `/rest` calls `igris_instance_remove` to deregister
6. [ ] VPS dashboard Live Instances panel shows the local instance
7. [ ] Instance doesn't go stale during sessions longer than 30 min
8. [ ] Brain MCP unavailable → graceful skip (no crash, no blocking)

---

## Test Plan

### Functional Tests

**Test Case 1: Instance Registration on Awaken**
1. Run `/awaken`
2. Check CURRENT_SESSION.md for Instance ID field
3. Query: `sqlite3 ~/.igris/memory/knowledge.db "SELECT * FROM instances WHERE status='active'"`
**Expected Result:** 1 active instance with correct hostname and project

**Test Case 2: Instance on VPS Dashboard**
1. After /awaken, trigger brain push
2. Check VPS: `curl -H "Authorization: Bearer <key>" http://<VPS>:3001/api/instances`
3. Check dashboard Live Instances panel
**Expected Result:** Instance visible with hostname, OS, project

**Test Case 3: Instance Removal on Rest**
1. Run `/rest`
2. Query local instances table
3. Check VPS dashboard
**Expected Result:** Instance removed or marked inactive

**Test Case 4: Heartbeat During Hunt**
1. Start a /hunt workflow
2. After each phase transition, check instances table `last_heartbeat_at`
**Expected Result:** Timestamp refreshes between phases

---

## Delivery

- [ ] Updated `/awaken` skill with mandatory instance registration
- [ ] Updated `/hunt` skill with periodic heartbeat
- [ ] Verified `/rest` skill deregistration
- [ ] Updated `igris_os.md` with instance registration in init protocol

---

## Notes

**Depends on:** FR-026 (DONE — infrastructure), FR-030 (DONE — sync pipeline)
**Enables:** Live instance monitoring on VPS dashboard

**Root Cause Analysis (SEEKER Investigation):**
The instance registry infrastructure (FR-026) is 100% correct — schema, MCP tools, sync config, API endpoints, dashboard polling all work. The failure is purely at the orchestration layer: step 3.7 in `/awaken` is marked "Optional" and the orchestrator never executes it. No registration = no data = no sync = empty dashboard.

**Key Insight:** "Optional" in skill files means "orchestrator will skip it." For critical features, use mandatory language: "MUST call" with graceful fallback only if MCP is truly unavailable.

---

**Created:** 2026-02-16
**Last Updated:** 2026-02-16
**Brief Owner:** Crimson (Fifty.ai)
