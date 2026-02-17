# BR-021: Fix Skill Invocation Heatmap — No Data

**Type:** Bug Fix
**Priority:** P2-Medium
**Effort:** M-Medium (4-8h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** In Progress
**Created:** 2026-02-17

---

## Problem

The Skill Invocation Heatmap on the Crimson Arena dashboard shows nothing and has never displayed any data since launch. The component exists in the UI but is empty — either the data pipeline never populates it, the API endpoint returns nothing, or the frontend never receives/renders the data.

**Why does it matter?**
The heatmap is supposed to show which skills (/hunt, /scan, /sync, etc.) are being invoked and how often, giving visibility into usage patterns. Without it, a key dashboard panel is dead space.

---

## Goal

Skill Invocation Heatmap displays real data — skill names, invocation counts, and time-based activity.

---

## Context & Inputs

### Related Files
- `dashboard/server.py` — API endpoint serving heatmap data
- `dashboard/static/app.js` — Frontend rendering of heatmap
- `ai/session/metrics/events.jsonl` — Source event data (may contain skill invocations)

---

## Investigation Findings (Seeker)

### Root Cause 1: `skill_invocations` table missing from arena.db
- Schema defined at `server.py:396-403` with `CREATE TABLE IF NOT EXISTS`
- But arena.db was created before this table was added to the schema
- DB only has: `agent_levels`, `context_window`, `daily_budget`, `events`, `sync_state`
- The table was never created because the DB already existed when the schema was updated

### Root Cause 2: No `skill_invoke` events are ever emitted
- `events.jsonl` only contains `start` and `stop` events — zero `skill_invoke` events
- Insert logic at `server.py:1679-1689` expects `event.event == "skill_invoke"` with `event.skill_name`
- No mechanism exists to emit these events when `/hunt`, `/scan`, `/sync` etc. are called
- Frontend rendering at `app.js:2609-2644` is correct — just receives empty data

### Root Cause 3: Silent error swallowing
- `build_skill_heatmap()` at `server.py:1147-1171` catches the table-not-found error silently
- Returns `{"skills": {}, "total": 0}` — frontend shows "No skill data yet"

### Fix Plan
1. **DB Migration:** Recreate or migrate arena.db to include `skill_invocations` table
2. **Event Emission:** Add `skill_invoke` event emission to skill invocation hooks (CLAUDE.md skills, hooks, or agent start events)
3. **Frontend:** No changes needed — code is correct

### Key Line References
| File | Lines | What |
|------|-------|------|
| `server.py` | 396-403 | Schema definition |
| `server.py` | 1147-1171 | `build_skill_heatmap()` query |
| `server.py` | 1679-1689 | Event insertion logic |
| `app.js` | 2609-2644 | Frontend render |

---

## Acceptance Criteria

1. [ ] `skill_invocations` table exists in arena.db
2. [ ] Skills emit `skill_invoke` events when called
3. [ ] Heatmap API returns real invocation data
4. [ ] Frontend renders heatmap with actual usage patterns

---

**Created:** 2026-02-17
**Brief Owner:** Crimson
