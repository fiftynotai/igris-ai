# FR-044: Crimson Arena v2 — Architecture-Aligned Dashboard

**Type:** Feature Request
**Priority:** P2-Medium
**Effort:** L-Large (3-5d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** In Progress
**Created:** 2026-02-17
**Completed:** _(pending)_

---

## Feature Description

**What is the proposed feature?**

Redesign the Crimson Arena dashboard to reflect the full v4.0 system architecture. Add 6 new/upgraded sections: Sync Pipeline indicator, Agent Teams panel, Active Brief Pipeline visualization, Knowledge Base panel, Skill Heatmap, and enhanced Battle Log with skill tracking.

**Why is this valuable?**

The dashboard was built during FR-027 and incrementally updated (FR-029, FR-032, FR-043), but the system architecture has evolved significantly. Agent Teams, Brain Sync Pipeline, Skills Layer, Knowledge Base, and Brief Workflow State Machine are all invisible in the current UI. This creates a blind spot — operators can't see half the system's activity.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
- Agent Teams layer is completely invisible — no team view when `/team` is active
- Brain sync status (push/pull timestamps, queue depth) has no UI presence
- 17+ learnings in Knowledge Base are hidden from the operator
- 20+ skills are invoked but never tracked or visualized
- Brief workflow is a flat status badge — the 5-phase state machine (PLAN→BUILD→TEST→REVIEW→DONE) has no pipeline visualization
- Cross-project intelligence exists in the brain but isn't surfaced

**With this feature:**
- Full architectural visibility — every layer of the system is represented on the dashboard
- Real-time sync health monitoring in the instrument strip
- Knowledge growth is visible and celebrated
- Skill usage patterns are tracked via heatmap
- Active brief progress is shown as a visual pipeline with phase indicators
- Team mode shows teammate cards with brief assignments and progress

---

## Use Cases

### Use Case 1: Monitor Active Brief Pipeline
**Actor:** Developer running `/hunt FR-044`
**Goal:** See real-time progress through the workflow state machine
**Steps:**
1. Start `/hunt FR-044`
2. Dashboard shows pipeline strip: PLAN(active) → BUILD → TEST → REVIEW → DONE
3. As ARCHITECT completes, pipeline advances: PLAN(done) → BUILD(active) → ...
4. Each phase shows the active agent and retry count

**Expected Outcome:** Visual pipeline updates in real-time as brief progresses through phases

### Use Case 2: Monitor Agent Teams
**Actor:** Developer running `/team hunt FR-044 FR-045`
**Goal:** See parallel teammate progress
**Steps:**
1. Start `/team hunt FR-044 FR-045`
2. Team Mode panel appears below the Nexus
3. Shows 2 teammate cards: Hunt-1 (FR-044, BUILD phase) and Hunt-2 (FR-045, TEST phase)
4. Each card shows progress bar and current agent

**Expected Outcome:** Parallel brief execution is visible with per-teammate status

### Use Case 3: Check Sync Health
**Actor:** Developer checking if brain sync is working
**Goal:** Verify push/pull cycle is healthy
**Steps:**
1. Look at Sync Pipeline in instrument strip
2. See last push timestamp, last pull timestamp, queue depth, definition version
3. If queue > 0, indicates pending operations

**Expected Outcome:** One-glance sync health without checking logs

---

## Technical Approach

### High-Level Design

Add 6 new/upgraded sections to the existing dashboard without disrupting the current layout. New sections slot into natural positions:

1. **Sync Pipeline** — Third panel in the instrument strip (alongside HP + Digivice)
2. **Team Mode** — Conditional panel below the Nexus (appears only when team active)
3. **Active Brief Pipeline** — New strip between main content and Brain Command Center
4. **Knowledge Base** — New panel in Brain Command Center grid (replacing empty space)
5. **Skill Heatmap** — New section between Brain Command Center and RPG Party Stats
6. **Battle Log (enhanced)** — Extend existing battle log to include skill events

### Components Affected

- `dashboard/static/index.html` — Add new section containers
- `dashboard/static/app.js` — Add render functions for 6 new sections
- `dashboard/static/style.css` — Add styles for new panels
- `dashboard/server.py` — Add 3 new API endpoints + extend event processing

### New API Endpoints

```
GET /api/sync-status     → { last_push, last_pull, queue_depth, def_version }
GET /api/team-status     → { active, teammates: [{ name, brief, phase, progress }] }
GET /api/brain/knowledge → { learnings_count, recent: [...], errors: count, patterns: [...] }
GET /api/skills          → { skill_name: invocation_count, ... }
```

### New WebSocket Message Types

```
"sync_status"    → Real-time sync pipeline updates
"team_status"    → Team mode state changes
"skill_event"    → Skill invocation events
```

---

## Context & Inputs

### Dependencies
- [x] Existing system: Brain MCP server (knowledge base API)
- [x] Existing system: Dashboard server (FastAPI + WebSocket)
- [x] Existing system: events.jsonl (event source)

### Files to Modify
- `dashboard/static/index.html` — Add section containers for 6 new panels
- `dashboard/static/app.js` — Add render functions, WebSocket handlers, data fetchers
- `dashboard/static/style.css` — Styles for pipeline strip, team cards, skill heatmap, knowledge panel
- `dashboard/server.py` — New endpoints, skill tracking, sync status, team status proxy

### Files to Create
- None (all changes within existing dashboard files)

### Configuration Changes
- [ ] New events.jsonl event types: `skill_start`, `skill_stop` for skill tracking
- [ ] New brain API proxy: `/api/brain/knowledge` for knowledge base access

---

## Alternatives Considered

### Alternative 1: Separate Dashboard Pages
**Pros:**
- Less visual clutter on main page
- Each page focused on one concern

**Cons:**
- Breaks "single pane of glass" principle
- Context switching between pages

**Why not chosen:** Crimson Arena's value is the unified command center — everything visible at once

### Alternative 2: Tabbed Sections
**Pros:**
- Reduces vertical scroll
- Clean organization

**Cons:**
- Hides information behind clicks
- Loses real-time overview

**Why not chosen:** Dashboard should surface information proactively, not hide it behind tabs

---

## Constraints

### Technical Constraints
- Must not break existing WebSocket real-time updates
- Must degrade gracefully when brain is offline (knowledge/sync panels show "N/A")
- Must not increase page load time significantly (lazy-load brain proxy data)
- Team Mode panel must be conditional (hidden when no team active)

### UX Constraints
- Maintain existing FDL (Fifty Design Language) theme
- New panels must follow the same card/panel visual language
- Pipeline strip must be scannable at a glance (no reading required)
- Skill heatmap must use familiar bar chart pattern

### Out of Scope
- Mobile responsive redesign (desktop-first remains)
- User authentication for the dashboard
- Dashboard persistence (refresh reloads state)
- Nested team visualization (teams within teams)

---

## Tasks

### Pending
- [ ] Task 1: Add Sync Pipeline panel to instrument strip (HTML + CSS + JS + API)
- [ ] Task 2: Add Active Brief Pipeline visualization strip (HTML + CSS + JS)
- [ ] Task 3: Add Knowledge Base panel to Brain Command Center (HTML + CSS + JS + brain proxy)
- [ ] Task 4: Add Skill Heatmap section (HTML + CSS + JS + new endpoint + event tracking)
- [ ] Task 5: Enhance Battle Log to include skill invocations
- [ ] Task 6: Add conditional Team Mode panel (HTML + CSS + JS + team status API)
- [ ] Task 7: Add new server endpoints (sync-status, skills, brain/knowledge proxy)
- [ ] Task 8: Add WebSocket message types (sync_status, team_status, skill_event)
- [ ] Task 9: Deploy to VPS via /sync code

### In Progress
_(none)_

### Completed
_(none)_

---

## Workflow State

**Phase:** COMMITTING
**Active Agent:** none
**Retry Count:** 0

### Current Work
WARDEN APPROVE + 3 fixes applied. Ready for commit.

### Next Steps
1. HUNT FR-044 to begin implementation
2. ARCHITECT will plan the implementation order (likely tasks 7→1→2→3→4→5→6→8→9)
3. FORGER implements across 4 files

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-17 10:00 | architect | PLANNING started | Pending |
| 2026-02-17 10:05 | architect | PLANNING complete | Plan delivered — 6 phases, 4 files, awaiting approval |
| 2026-02-17 10:06 | -- | APPROVAL | Partner approved — start BUILDING |
| 2026-02-17 10:06 | forger | BUILDING started | Implementing across server.py, index.html, app.js, style.css |
| 2026-02-17 10:14 | forger | BUILDING complete | 4 files modified: server.py, index.html, app.js, style.css |
| 2026-02-17 10:14 | sentinel | TESTING started | Syntax checks, server startup, endpoint validation |
| 2026-02-17 10:16 | sentinel | TESTING complete | PASS — 10/10 checks green |
| 2026-02-17 10:16 | warden | REVIEWING started | Code quality review |
| 2026-02-17 10:18 | warden | REVIEWING complete | APPROVE — 3 actionable fixes (broadcast serialization, DB connection, auth header) |
| 2026-02-17 10:19 | -- | FIXES applied | 3 WARDEN fixes: broadcast dict, reuse brain_request, shared DB conn |
| 2026-02-17 10:19 | -- | COMMITTING | Ready for git commit |

### Blockers
None

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] Sync Pipeline panel shows last push/pull timestamps and queue depth in instrument strip
2. [ ] Active Brief Pipeline shows 5-phase state machine with active phase highlighted
3. [ ] Knowledge Base panel shows learning count, recent learnings, and error count
4. [ ] Skill Heatmap shows all skill invocations as horizontal bar chart
5. [ ] Battle Log includes skill invocation entries (alongside agent events)
6. [ ] Team Mode panel appears conditionally when Agent Teams are active
7. [ ] All new panels degrade gracefully when brain is offline
8. [ ] New WebSocket message types broadcast real-time updates
9. [ ] Deployed to VPS and verified on Crimson Arena remote dashboard
10. [ ] No regressions in existing dashboard functionality

---

## Test Plan

### Functional Tests

**Test Case 1: Sync Pipeline Display**
**Steps:**
1. Open dashboard
2. Verify Sync Pipeline panel appears in instrument strip
3. Verify last push/pull timestamps are displayed
4. Verify queue depth shows 0 when empty

**Expected Result:** Sync Pipeline panel renders with accurate data
**Status:** [ ] Pass / [ ] Fail

**Test Case 2: Brief Pipeline Visualization**
**Steps:**
1. Start `/hunt` on a brief
2. Observe pipeline strip updates through phases
3. Verify active phase is highlighted
4. Verify completed phases show checkmark

**Expected Result:** Pipeline advances in real-time as brief progresses
**Status:** [ ] Pass / [ ] Fail

**Test Case 3: Skill Heatmap**
**Steps:**
1. Run several skills (/scan, /hunt, /register)
2. Verify heatmap updates with invocation counts
3. Verify bars are sorted by frequency (most used first)

**Expected Result:** Skill usage is tracked and displayed as horizontal bars
**Status:** [ ] Pass / [ ] Fail

**Test Case 4: Brain Offline Degradation**
**Steps:**
1. Stop brain MCP server
2. Verify Knowledge Base panel shows "N/A" or "Offline"
3. Verify Sync Pipeline shows "Offline" status
4. Verify no JavaScript errors in console

**Expected Result:** Graceful degradation without errors
**Status:** [ ] Pass / [ ] Fail

### Regression Tests
- [ ] Existing HP Bar still renders correctly
- [ ] Existing Digivice still renders correctly
- [ ] Existing Nexus grid still animates on agent events
- [ ] Existing Battle Log still receives WebSocket events
- [ ] Existing Brain Command Center panels still function
- [ ] WebSocket reconnect still works

---

## Delivery

### Documentation
- [ ] Update FR-027 brief notes with v2 reference
- [ ] Add ASCII layout diagrams to this brief (done — see design review session)

### Announcement
- [ ] Changelog entry: "Crimson Arena v2 — Full architecture visibility"

---

## Success Metrics

**How will we know this feature is valuable?**

- All 3 architectural layers (OS, Subagents, Teams) are visible on the dashboard
- Operator can identify sync issues within 5 seconds (Sync Pipeline panel)
- Skill usage patterns become visible for the first time
- Knowledge Base growth is tracked and visible

---

## Notes

**Design Review:** Conducted 2026-02-17 during /awaken session. Full ASCII before/after mockups created. SEEKER investigated all 4 dashboard files (server.py 1602 lines, app.js 2375 lines, index.html 524 lines, style.css).

**Architecture Gap Analysis:**
- 5 system features completely invisible: Agent Teams, Sync Pipeline, Knowledge Base, Skills Layer, Brief State Machine
- 1 feature partially visible: Briefs (flat table, no pipeline view)

**Implementation Priority:**
- Sync Pipeline + Brief Pipeline first (highest operational value)
- Knowledge Base + Skill Heatmap second (intelligence visibility)
- Team Mode last (conditional, depends on experimental feature)

**Future Enhancements:**
- Cross-project knowledge graph visualization
- Agent performance trend charts (over time)
- Skill recommendation engine based on usage patterns
- Team Mode with real-time teammate token consumption

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Crimson (Fifty.ai)
