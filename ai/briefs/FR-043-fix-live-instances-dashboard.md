# FR-043: Fix Live Instances — Stale Cleanup, Filtering & Live Feel

**Type:** Feature Request
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-17
**Completed:** 2026-02-17

---

## Feature Description

**What is the proposed feature?**

Fix the Crimson Arena "Live Instances" tab which currently shows 3 instances (including stale test artifacts and dead sessions) when only 1 is actually active. The instance registry needs auto-cleanup, API-level filtering, a live-feeling dashboard UI, and more frequent heartbeats.

**Why is this valuable?**

The Live Instances tab is supposed to show real-time Claude Code sessions across machines. Currently it's misleading — stale instances from hours ago appear alongside active ones, test artifacts persist forever, and nothing feels "live". This undermines trust in the centralized brain as a real-time command center.

---

## User Value

### Who Benefits?
- [ ] End users (people using the product)
- [x] Developers (building with Igris AI)
- [ ] Contributors (extending Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
- VPS brain DB has 3 instances, all marked "stale" — including a `test-instance-001` artifact
- `GET /api/instances` returns ALL instances (no filtering), dashboard renders all of them
- No auto-purge — dead instances accumulate forever
- Heartbeat only fires on `/hunt` phase transitions — gaps of hours between heartbeats
- Dashboard shows static timestamps, no pulsing indicators, no live counters
- `/rest` deregistration fails silently if brain MCP is unavailable, leaving orphans

**With this feature:**
- Stale instances auto-purge after configurable TTL (e.g., 2 hours)
- API defaults to active/idle instances only
- Dashboard shows active instances prominently with pulsing dot and live "X ago" counter
- Stale instances hidden or collapsed in a separate section
- Heartbeats are more frequent and reliable

---

## Use Cases

### Use Case 1: Developer checks who's working
**Actor:** Developer opening Crimson Arena
**Goal:** See which Claude Code instances are actively running
**Steps:**
1. Open Crimson Arena dashboard
2. Navigate to Live Instances tab
3. See only active/idle instances with real-time heartbeat indicators

**Expected Outcome:** Only truly active instances shown. Pulsing green dot, "2 min ago" heartbeat that updates live.

### Use Case 2: Session ends cleanly
**Actor:** Developer running `/rest`
**Goal:** Instance disappears from dashboard
**Steps:**
1. Run `/rest` in Claude Code
2. Instance deregistered from brain
3. Dashboard reflects removal within seconds

**Expected Outcome:** Instance gone from active list immediately.

### Use Case 3: Session crashes without /rest
**Actor:** Developer closes terminal without `/rest`
**Goal:** Orphan instance auto-cleans after TTL
**Steps:**
1. Instance stops sending heartbeats
2. After 30min: marked "stale"
3. After 2h: auto-purged from database

**Expected Outcome:** No permanent orphan instances.

---

## Technical Approach

### High-Level Design

Three layers of fixes:

**Layer 1 — Brain MCP Server (`brain-mcp-server/src/`):**
- Add TTL-based auto-purge to `handleInstanceList()` — DELETE instances stale for >2h
- Modify `GET /api/instances` to accept `?include_stale=true` query param (default: exclude stale)
- Clean up existing stale instances (one-time)

**Layer 2 — Dashboard (`dashboard/`):**
- **Backend** (`server.py`): Pass `?include_stale=false` when proxying to brain API
- **Frontend** (`app.js`): Redesign instances rendering:
  - Active instances: prominent cards with pulsing green dot
  - Live "heartbeat X ago" timer that updates via `setInterval` (not just on fetch)
  - Stale instances: collapsed/hidden section or not shown at all
  - Instance count badge only reflects active instances

**Layer 3 — Heartbeat Reliability:**
- Not in scope for this brief (would require changes to Claude Code skill execution model)
- Document as future enhancement

### Components Affected
- `brain-mcp-server/src/tools/instances.ts` — Add TTL purge logic
- `brain-mcp-server/src/index.ts` — Filter `/api/instances` response
- `dashboard/server.py` — Update brain proxy call
- `dashboard/static/app.js` — Redesign instances rendering with live feel
- `dashboard/static/style.css` — Pulsing dot animation, stale styling

### API/Interface Design

**Brain API change:**
```
GET /api/instances                    — returns active + idle only (default)
GET /api/instances?include_stale=true — returns all including stale
```

**Response shape (unchanged):**
```json
{
  "instances": [...],
  "count": 1
}
```

**Frontend rendering:**
```
Active Instances (1)
+--------------------------------------------------+
| [pulsing green dot] Mohameds-MacBook-Air-2.local |
| igris-ai / FR-042 / BUILDING                     |
| Last heartbeat: 2 min ago (live counter)          |
+--------------------------------------------------+
```

---

## Context & Inputs

### Dependencies
- [x] Existing system: Brain MCP server running on VPS (PM2)
- [x] Existing system: Crimson Arena dashboard (port 8001)
- [x] Existing system: Instance heartbeat via `igris_instance_heartbeat` MCP tool

### Files to Modify
- `brain-mcp-server/src/tools/instances.ts` — TTL purge + filtering
- `brain-mcp-server/src/index.ts` — API query param support
- `dashboard/server.py` — Proxy filter param
- `dashboard/static/app.js` — Live rendering redesign
- `dashboard/static/style.css` — Pulsing dot, stale styling

### Configuration Changes
- [ ] None (TTL hardcoded as constant, can be made configurable later)

---

## Root Cause Analysis

### Why 3 instances showing:
1. **`test-instance-001`** — Created during FR-026 (Live Instance Registry) development. Never cleaned up. No TTL purge exists.
2. **`167aa117...`** — Session that worked on FR-032. Ended without `/rest` (terminal closed or context reset). Instance never deregistered. No TTL purge.
3. **`77318e66...`** — Current session. Heartbeat went stale because `/hunt` only heartbeats on phase transitions, and the conversation has been idle for hours between phases.

### Why it doesn't feel "live":
- `renderBrainInstances()` in app.js (line 2088) creates a static HTML table
- Heartbeat timestamp rendered as static text via `formatRelativeTime()`
- No `setInterval` to update relative times
- No CSS animations for active instances
- Polling interval exists but data itself is already stale when received

---

## Alternatives Considered

### Alternative 1: Only fix API filtering
**Pros:** Quick, server-side only change
**Cons:** Stale instances still accumulate in DB, dashboard still static

**Why not chosen:** Addresses symptom, not root cause.

### Alternative 2: WebSocket-based real-time instances
**Pros:** True real-time updates
**Cons:** Requires brain server to push instance changes via WebSocket
**Why not chosen:** Overkill for current use. Polling + TTL cleanup is sufficient.

---

## Constraints

### Technical Constraints
- Must not break existing `igris_instance_heartbeat` / `igris_instance_list` / `igris_instance_remove` MCP tools
- TTL purge must only delete truly dead instances (2h+ stale), not temporarily idle ones
- Dashboard changes must work with existing brain API (backwards compatible)

### UX Constraints
- Active instances must be immediately distinguishable from stale
- "Live" feel: at least the heartbeat timer should update without page refresh
- Instance count in tab badge should only count active/idle, not stale

### Out of Scope
- Changing heartbeat frequency in `/hunt` workflow (requires skill changes)
- Multi-machine instance dedup (future: same user on laptop + desktop)
- Instance history/audit log

---

## Tasks

### Pending
- [ ] Task 1: Add TTL auto-purge to brain MCP server (DELETE instances stale >2h)
- [ ] Task 2: Add `?include_stale` query param to `GET /api/instances`
- [ ] Task 3: Clean up existing stale instances from VPS DB
- [ ] Task 4: Update dashboard proxy to exclude stale by default
- [ ] Task 5: Redesign frontend instance rendering (pulsing dot, live timer)
- [ ] Task 6: Add CSS animations for active instance indicator
- [ ] Task 7: Test end-to-end: register, heartbeat, stale detection, purge

### In Progress

### Completed

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered and ready for implementation.

### Next Steps
HUNT FR-043 to implement.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-17 | ARCHITECT | Planning FR-043 | Plan approved (5 phases, 5 files) |
| 2026-02-17 | FORGER | Building FR-043 | Complete (5 files modified) |
| 2026-02-17 | SENTINEL | Testing FR-043 | PASS (TS compile clean, Python valid, all checks pass) |
| 2026-02-17 | WARDEN | Reviewing FR-043 | APPROVE (clean, no security issues) |

### Blockers
None

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] Stale instances (>2h no heartbeat) are auto-purged from brain DB
2. [ ] `GET /api/instances` excludes stale by default
3. [ ] Dashboard only shows active/idle instances in the main view
4. [ ] Active instances have a pulsing green indicator dot
5. [ ] Heartbeat timer updates live (setInterval, no page refresh needed)
6. [ ] Instance count badge reflects only active/idle count
7. [ ] Existing test artifact and dead sessions are cleaned up
8. [ ] MCP tools (heartbeat, list, remove) still work correctly

---

## Test Plan

### Functional Tests
**Test Case 1: Auto-purge stale instances**
**Steps:**
1. Insert a test instance with `last_heartbeat_at` = 3 hours ago
2. Call `GET /api/instances`
3. Verify the stale instance is purged from DB

**Expected Result:** Instance deleted, not returned in API response
**Status:** [ ] Pass / [ ] Fail

**Test Case 2: Active instance with pulsing dot**
**Steps:**
1. Register an instance via heartbeat
2. Open Crimson Arena Live Instances tab
3. Verify pulsing green dot and live timer

**Expected Result:** Green pulsing dot visible, timer counts up in real-time
**Status:** [ ] Pass / [ ] Fail

**Test Case 3: include_stale query param**
**Steps:**
1. Call `GET /api/instances` — should exclude stale
2. Call `GET /api/instances?include_stale=true` — should include stale

**Expected Result:** Filtering works correctly in both cases
**Status:** [ ] Pass / [ ] Fail

### Regression Tests
- [ ] `igris_instance_heartbeat` MCP tool still works
- [ ] `igris_instance_list` MCP tool still works (with status filter)
- [ ] `igris_instance_remove` MCP tool still works
- [ ] `/rest` deregistration still works
- [ ] Dashboard other tabs unaffected

---

## Delivery

### Documentation
- [ ] No external docs needed (internal dashboard feature)

### Announcement
- [ ] Changelog entry: "Fixed Live Instances: auto-cleanup, active-only filtering, pulsing indicators"

---

## Notes

**Current VPS instance data (for cleanup reference):**
```
test-instance-001 | (none) | stale | 05:25 — DELETE (test artifact)
167aa117...       | FR-032 | stale | 05:55 — DELETE (orphan session)
77318e66...       | FR-042 | stale | 08:20 — UPDATE or DELETE (current session)
```

**Future Enhancements:**
- Configurable TTL via config.json
- More frequent heartbeats in /hunt (every 5 min background timer)
- Instance history log (keep record of past sessions for analytics)
- Multi-machine view grouping

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Fifty.ai
