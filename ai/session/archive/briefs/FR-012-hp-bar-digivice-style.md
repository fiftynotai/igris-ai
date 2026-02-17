# FR-012: Convert Session HP Bar to Digivice Visual Style

**Type:** Feature Request
**Priority:** P2-Medium
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Monarch
**Status:** Done
**Created:** 2026-02-09
**Completed:** 2026-02-09

---

## Feature Description

**What is the proposed feature?**

Extract shared Digivice CSS into a `.digi-panel` base class system and convert the Session HP bar from a plain smooth-fill bar to use the same 20-segment discrete bar, CRT scanlines, and bezel ridges as the Digivice context window monitor.

**Why is this valuable?**

Creates a consistent retro-gaming aesthetic across the dashboard header. Both HP and context window use the same visual language, reinforcing the Crimson Arena theme.

---

## User Value

### Who Benefits?
- [x] End users (people using the product)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
HP bar uses a plain smooth-fill bar that looks inconsistent with the Digivice retro-style display.

**With this feature:**
Both header widgets share the same distinctive visual identity with segments, scanlines, and bezels.

---

## Technical Approach

### High-Level Design
Extract shared CSS into `.digi-panel` base classes with CSS custom properties (`--digi-accent`) for per-instance color. Both HP (green) and Digivice (cyan) extend from this base.

### Components Affected
- `dashboard/static/style.css` - Extract shared base styles, refactor HP and Digivice
- `dashboard/static/index.html` - Replace HP HTML with digi-panel structure, update Digivice class names
- `dashboard/static/app.js` - Rewrite renderBudget() for segments, update Digivice class references

---

## Context & Inputs

### Files to Modify
- `dashboard/static/style.css`
- `dashboard/static/index.html`
- `dashboard/static/app.js`

---

## Tasks

### Completed
- [x] Task 1: CSS - Add digi-panel base classes, replace HP and Digivice styles (completed: 2026-02-09)
- [x] Task 2: HTML - Replace HP bar and Digivice with digi-panel structure (completed: 2026-02-09)
- [x] Task 3: Update app.js - add _initHpSegments(), rewrite renderBudget(), update Digivice class refs (completed: 2026-02-09)
- [x] Task 4: WARDEN review fixes - renamed digivice--transition to digi-panel--transition, fixed --text-dim, added CSS cache bust (completed: 2026-02-09)

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Current Work
Implementation complete, verified in browser.

### Next Steps
Commit changes.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-09 | architect | Plan approved from plan mode | APPROVED |
| 2026-02-09 | forger | Implementation (CSS/HTML/JS) | COMPLETE |
| 2026-02-09 | warden | Code review | REJECT (3 findings) |
| 2026-02-09 | orchestrator | Fix warden findings | FIXED |
| 2026-02-09 | sentinel | Visual verification in browser | PASS |

### Blockers
None

---

## Acceptance Criteria

**The feature is complete when:**

1. [x] HP bar renders with 20 green segments, scanlines, and bezel ridges
2. [x] Digivice context window still renders with cyan segments
3. [x] HP transitions: green (0-74%), orange pulse (75-89%), crimson pulse (90%+)
4. [x] Digivice transitions: cyan (0-59%), orange (60-89%), crimson (90%+)
5. [x] Responsive: HP bar visible at 900px, Digivice hides
6. [x] Both panels update independently on events
7. [x] No regressions to existing dashboard functionality

---

## Test Plan

### Functional Tests
**Test Case 1: HP Bar Visual**
**Steps:**
1. Start dashboard server
2. Open dashboard at localhost:8001
3. Observe HP bar in header

**Expected Result:** HP bar shows green segments, scanlines, bezel ridges
**Status:** [x] Pass

**Test Case 2: Digivice Still Works**
**Steps:**
1. Trigger orchestrator events
2. Observe Digivice context window

**Expected Result:** Digivice shows cyan segments, updates independently
**Status:** [x] Pass

**Test Case 3: Responsive**
**Steps:**
1. Resize browser to 800px width
2. Check HP bar visibility and Digivice hiding

**Expected Result:** HP bar remains visible, Digivice hides
**Status:** [x] Pass

---

**Created:** 2026-02-09
**Last Updated:** 2026-02-09
**Brief Owner:** Igris AI
