# FR-031: Sync Briefs to Brain on Registration

**Type:** Feature Request
**Priority:** P1-High
**Effort:** S-Small (< 4h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** In Progress
**Created:** 2026-02-16

---

## Feature Description

**What is the proposed feature?**

Add `igris_brief_sync` MCP tool call to the `/register` skill so that newly created briefs are immediately synced to the local brain database (`brief_status` table). This enables the push/pull pipeline to deliver brief data to the VPS brain, making them visible on the Crimson Arena dashboard.

**Why is this valuable?**

Currently, newly registered briefs exist only as markdown files in `ai/briefs/`. The brain database has no entry for them, so `igris_brain_push` has nothing to send to VPS, and the VPS dashboard's Brain Command Center shows zero briefs. This is a critical data flow gap — the entire brief lifecycle is invisible to remote monitoring.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
- `/register` creates brief file in `ai/briefs/` but NEVER calls `igris_brief_sync`
- `brief_status` table in local brain has no entry for the brief
- `igris_brain_push` (at `/rest`) has nothing to push for that brief
- VPS dashboard's Brain Command Center shows "No briefs found"

**With this feature:**
- `/register` creates file AND syncs to brain DB in one step
- Brief appears in `brief_status` table immediately
- Next `/rest` pushes brief to VPS brain
- VPS dashboard shows brief within 2 minutes (polling interval)
- Additionally: sync on status changes (implement, done, archive) keeps VPS current

---

## Use Cases

### Use Case 1: Register Brief → Visible on Dashboard
**Actor:** Developer registering a new brief
**Goal:** Brief appears on VPS dashboard without manual intervention
**Steps:**
1. Run `/register feature "Add dark mode"`
2. Brief file created in `ai/briefs/FR-XXX-add-dark-mode.md`
3. `igris_brief_sync` called automatically with brief metadata
4. Run `/rest` later (or wait for next sync)
5. Open VPS dashboard
**Expected Outcome:** Brief visible in Brain Command Center with status "Ready"

### Use Case 2: Brief Status Change → Dashboard Updates
**Actor:** Developer implementing a brief
**Goal:** Status changes (Ready → In Progress → Done) reflected on dashboard
**Steps:**
1. Run `/hunt FR-XXX` — status changes to "In Progress"
2. `igris_brief_sync` called with updated status
3. Complete work, status changes to "Done"
4. `igris_brief_sync` called again
**Expected Outcome:** Dashboard shows real-time brief lifecycle

---

## Technical Approach

### High-Level Design

Add `igris_brief_sync` MCP tool calls at every brief lifecycle transition point:

1. **Registration** (`/register` skill) — sync after creating brief file
2. **Implementation start** (`/hunt` skill) — sync when status → "In Progress"
3. **Completion** (`/hunt` workflow) — sync when status → "Done"
4. **Archiving** (`/archive` skill) — sync when status → "Archived"
5. **Priority/status changes** — sync when metadata updated

### Components Affected

- `.claude/skills/register/SKILL.md` — Add `igris_brief_sync` call after file creation
- `.claude/skills/hunt/SKILL.md` — Verify sync on status transitions (may already exist)
- `.claude/skills/archive/SKILL.md` — Add sync on archive
- `ai/prompts/igris_os.md` — Update brief management operations to include sync

### igris_brief_sync Call Pattern

```
Call igris_brief_sync with:
  - project: current project slug (from brain registry)
  - brief_id: "FR-031" (extracted from filename)
  - brief_type: "feature" | "bug" | "tech_debt" | etc.
  - title: brief title
  - status: "Ready" | "In Progress" | "Done" | "Archived"
  - priority: "P0" | "P1" | "P2" | "P3"
  - effort: "S" | "M" | "L" | "XL"
  - phase: "INIT" | "PLANNING" | "BUILDING" | etc.
```

---

## Context & Inputs

### Dependencies
- [x] Brain MCP server with `igris_brief_sync` tool (already implemented)
- [x] `brief_status` table in brain DB (already in schema)
- [x] VPS brain `/api/briefs` endpoint (already working)
- [x] Dashboard polling for briefs (every 120s, already working)

### Files to Create
- None

### Files to Modify
- `.claude/skills/register/SKILL.md` — Add sync step after brief creation
- `.claude/skills/archive/SKILL.md` — Add sync step on archive
- `ai/prompts/igris_os.md` — Update brief operations sections to include sync

---

## Constraints

### Technical Constraints
- Sync must be optional (if brain MCP not available, skip silently)
- Must not slow down registration (sync is fast — single DB insert)
- Must work with existing `igris_brief_sync` tool signature
- Backward compatible (projects without brain still work)

### Out of Scope
- Batch sync of all existing briefs (separate concern, could be a /scan feature)
- Real-time push to VPS on registration (relies on /rest push cycle)
- Dashboard WebSocket for instant brief updates

---

## Tasks

### Pending
- [ ] Update `/register` skill — add `igris_brief_sync` call after brief file creation
- [ ] Update `/archive` skill — add `igris_brief_sync` call on archive
- [ ] Update `igris_os.md` brief operations — add sync to registration, status update, priority change sections
- [ ] Verify `/hunt` skill already syncs on status transitions
- [ ] Test: register a brief, check local brain `brief_status` table has entry
- [ ] Test: run /rest, verify brief pushed to VPS brain
- [ ] Test: VPS dashboard shows the brief
- [ ] Test: brain unavailable — register still works (graceful skip)

---

## Workflow State

**Phase:** BUILDING
**Active Agent:** forger (teammate agent)
**Retry Count:** 0

### Current Work
Implementing brain sync calls across skill files and igris_os.md.

### Next Steps
Review changes, verify formatting, proceed to TESTING.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-16 | forger | Edit /register SKILL.md — add sync step 7 | SUCCESS |
| 2026-02-16 | forger | Edit /archive SKILL.md — add sync step 6 | SUCCESS |
| 2026-02-16 | forger | Edit /hunt SKILL.md — add sync at INIT and COMMITTING | SUCCESS |
| 2026-02-16 | forger | Edit igris_os.md — add sync to registration (section 1) | SUCCESS |
| 2026-02-16 | forger | Edit igris_os.md — add sync to prioritization (section 5) | SUCCESS |
| 2026-02-16 | forger | Edit igris_os.md — add sync to status updates (section 6) | SUCCESS |
| 2026-02-16 | forger | Edit igris_os.md — add sync to archiving (section 9) | SUCCESS |

### Blockers
None

---

## Acceptance Criteria

1. [ ] `/register` calls `igris_brief_sync` after creating brief file
2. [ ] Newly registered briefs appear in local brain `brief_status` table
3. [ ] After `/rest` push, briefs appear in VPS brain
4. [ ] VPS dashboard Brain Command Center shows registered briefs
5. [ ] `/archive` syncs status change to brain
6. [ ] Brain unavailable → registration still works (graceful skip)
7. [ ] No performance impact on brief registration

---

## Test Plan

### Functional Tests

**Test Case 1: Register → Brain DB**
1. Register a test brief: `/register feature "Test sync"`
2. Query local brain: `sqlite3 ~/.igris/memory/knowledge.db "SELECT * FROM brief_status WHERE brief_id='FR-XXX'"`
**Expected Result:** Row exists with status="Ready"

**Test Case 2: Register → VPS Dashboard**
1. Register a brief
2. Run `/rest` to trigger push
3. Check VPS dashboard Brain Command Center
**Expected Result:** Brief visible on dashboard

**Test Case 3: Graceful Degradation**
1. Disconnect brain MCP (or rename config)
2. Register a brief
**Expected Result:** Brief file created normally, no errors, sync silently skipped

### Regression Tests
- [ ] `/register` still creates brief files correctly
- [ ] `/archive` still moves files correctly
- [ ] `/hunt` workflow unaffected

---

## Delivery

- [ ] Updated `/register` skill with brain sync
- [ ] Updated `/archive` skill with brain sync
- [ ] Updated `igris_os.md` with sync in brief operations

---

## Notes

**Depends on:** Brain MCP server (already deployed), FR-030 (brain sync activation — for full push/pull to work)
**Enables:** Complete brief visibility on VPS dashboard

**Root Cause Analysis (SEEKER Investigation):**
The `/register` skill was built before the brain MCP server existed (v3.x era). When the brain was added in v4.0, the sync tools were integrated into `/hunt`, `/rest`, and `/awaken` — but `/register` was never updated. This is a simple oversight in the v4.0 integration.

**Data Flow After Fix:**
```
/register → create file → igris_brief_sync → brief_status table
                                                    ↓
/rest → igris_brain_push → VPS brain brief_status
                                    ↓
Dashboard polls /api/briefs → shows brief (within 2 min)
```

---

**Created:** 2026-02-16
**Last Updated:** 2026-02-16
**Brief Owner:** Crimson (Fifty.ai)
