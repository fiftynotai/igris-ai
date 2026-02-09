# FR-008: Dashboard Time Filter (Today / This Week / All Time)

**Type:** Feature Request
**Priority:** P2-Medium
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-09
**Completed:** 2026-02-09

---

## Feature Description

**What is the proposed feature?**

Add a time range filter to the Crimson Arena dashboard with three options: **Today**, **This Week**, and **All Time**. The filter applies to all dashboard components except agent levels/XP (which remain all-time progression). Currently the token breakdown, agent pod stats, battle log, and RPG stats all show all-time data with no way to scope by time period.

**Why is this valuable?**

Without filtering, the dashboard becomes less useful over time as all-time totals grow large and mask daily patterns. Developers need to see "how much did I spend today?" vs "how much has this agent consumed overall?" to make informed decisions about session planning and budget management.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)

### Pain Point Solved
**Current situation:** Token breakdown, agent stats, battle log, and RPG stats all show all-time aggregated data. The HP bar is the only daily-scoped component. Developers can't distinguish today's consumption from historical totals.

**With this feature:** A toggle in the header lets developers switch between Today / This Week / All Time views. All components update to reflect the selected time range, giving clear visibility into short-term and long-term patterns.

---

## Technical Approach

### Data Source

The SQLite `events` table already stores every event with `ts` (timestamp) and `session_date` (YYYY-MM-DD) columns. All filtered views can be recomputed from this table using date range queries:

- **Today:** `WHERE session_date = '2026-02-09'`
- **This Week:** `WHERE session_date >= '2026-02-03'` (Monday of current week)
- **All Time:** No date filter

### Components Affected

| Component | Filter Behavior | Implementation |
|-----------|----------------|----------------|
| Token Breakdown | Show tokens for selected period | `SUM(input_tokens) FROM events WHERE session_date ...` |
| Agent Pods (invocations, last used) | Show invocations for selected period | `COUNT(*) FROM events WHERE agent = ? AND session_date ...` |
| Battle Log | Show events from selected period | `SELECT * FROM events WHERE session_date ... ORDER BY ts DESC LIMIT 50` |
| RPG Stats (STR/INT/SPD/VIT) | Recompute from filtered data | Derive from filtered token/duration sums |
| HP Bar | Always daily (unchanged) | No change needed |
| Agent Levels/XP | Always all-time (unchanged) | No change needed — progression never resets |

### Server Changes

- Add `?range=today|week|all` query parameter to `GET /api/state`, `GET /api/agents`, `GET /api/events`
- Create `build_filtered_agents_state(db, range)` that queries events table instead of reading `agent-metrics.json`
- WebSocket initial state message should include the client's requested range (or default to today)

### Frontend Changes

- Add filter toggle UI in header (3 buttons: Today / This Week / All Time)
- On filter change: re-fetch state from `GET /api/state?range=X`
- Store selected filter in `localStorage` so it persists across page reloads
- Update all render methods to use the filtered state
- Active filter button gets crimson highlight

### Files to Modify

- `dashboard/server.py` — Add range parameter, filtered query builders
- `dashboard/static/index.html` — Add filter toggle buttons in header
- `dashboard/static/style.css` — Style for filter toggle buttons
- `dashboard/static/app.js` — Filter state management, re-fetch on change

---

## Constraints

### Technical Constraints
- Agent levels/XP must always show all-time (progression system)
- HP bar must always show today (budget is daily)
- WebSocket live events should update the current filtered view in real-time
- Filter default should be "Today" (most useful for daily workflow)

### Out of Scope
- Custom date range picker (just the 3 preset options)
- Per-session filtering (would require session ID tracking)
- Export/download of filtered data

---

## Acceptance Criteria

1. [ ] Filter toggle with 3 options (Today / This Week / All Time) visible in dashboard header
2. [ ] Token breakdown updates to show only tokens from selected time range
3. [ ] Agent pod invocation counts reflect selected time range
4. [ ] Battle log shows only events from selected time range
5. [ ] RPG stats recomputed from filtered data
6. [ ] Agent levels/XP remain all-time regardless of filter
7. [ ] HP bar remains daily regardless of filter
8. [ ] Selected filter persists in localStorage across page reloads
9. [ ] Default filter is "Today"
10. [ ] WebSocket live events update the filtered view correctly

---

## Test Plan

### Functional Tests

**Test Case 1: Filter switches correctly**
1. Open dashboard, verify default is "Today"
2. Click "All Time" — verify token breakdown shows larger numbers
3. Click "This Week" — verify numbers are between Today and All Time
4. Click "Today" — verify numbers return to daily scope

**Test Case 2: Live events update filtered view**
1. Set filter to "Today"
2. Run a subagent in Claude Code
3. Verify token breakdown, battle log, and agent pod update in real-time

**Test Case 3: Filter persistence**
1. Set filter to "This Week"
2. Refresh the page
3. Verify filter is still "This Week"

---

## Notes

- Depends on FR-007 (Agent Token Dashboard) which is now Done
- The `events` SQLite table already has `session_date` indexed (`idx_events_session_date`), so filtered queries will be fast
- Consider showing the date range label in the Token Breakdown header (e.g., "Token Breakdown — Today" or "Token Breakdown — Feb 3-9")

---

**Created:** 2026-02-09
**Last Updated:** 2026-02-09
**Brief Owner:** Fifty.ai
