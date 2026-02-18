# FR-057: Crimson Arena INSTANCES Page — Live Data & Agent Metrics

**Type:** Feature
**Priority:** P1-High
**Effort:** L-Large (3-5d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Superseded by FR-058
**Created:** 2026-02-18
**Completed:**

---

## Problem

**What's broken or missing?**

The Crimson Arena INSTANCES page is **structurally complete but data-empty**. When you expand an instance card, every section shows placeholder data:

1. **Agent Nexus Table** — All cells show `--` for Status, Time, and Tokens across all 7 agents. No per-agent execution data is tracked or displayed.
2. **Execution Log** — Shows "No execution data available". No event stream connects instance activity to this log.
3. **Hunt Pipeline** — Only shows phase name from heartbeat (`TESTING`). Missing task description, phase duration, and phase transition timestamps.
4. **Team Coordination Log** — Shows "No coordination data available". Team communication and coordination events are not piped into the dashboard.
5. **Team Action Buttons** — Broadcast, Team Status, and Shutdown buttons are visible but disabled with no backend implementation.
6. **No agent performance metrics** — No success rate, token efficiency, or timing data per agent.

**Root Causes:**
- `igris_instance_heartbeat` only sends `current_brief`, `current_phase`, `current_task` — no per-agent granularity
- No event pipeline from `/hunt` agent invocations → dashboard
- No per-agent timing, token consumption, or status tracking within an instance
- Team mode data structure exists in frontend code but nothing populates it
- `events.jsonl` has raw skill events but no agent execution events

**Why does it matter?**

- The INSTANCES page is the **operations floor** of Crimson Arena — it should be the live command center
- Users cannot see what agents are doing in real-time during `/hunt` workflows
- No visibility into agent performance, token costs, or bottlenecks
- Team parallel execution (`/team hunt`) is invisible — no coordination tracking
- The v4.0 dashboard claims "live instance tracking" but delivers a mostly empty page

---

## Goal

**What should happen after this brief is completed?**

The INSTANCES page becomes a **fully live operations dashboard** showing real-time data for every active instance:

1. **Agent Nexus** shows real-time per-agent status, timing, and token consumption during `/hunt` workflows
2. **Execution Log** streams live events as agents work (architect planning, forger writing, sentinel testing, etc.)
3. **Hunt Pipeline** shows phase durations, task descriptions, and transition timestamps
4. **Team views** show real teammate data with coordination logs
5. **Agent Performance Metrics** display success rates, efficiency scores, and historical trends
6. **Brief Velocity** tracking shows completion rates and time-per-complexity trends

---

## Context & Inputs

### Affected Modules
- [x] Brain MCP Server (instance heartbeat, new agent event tracking)
- [x] Dashboard Server (new API endpoints, WebSocket events)
- [x] Dashboard Frontend (data binding for agent nexus, logs, metrics)
- [x] Igris OS / Hunt Skill (emit agent events during workflow)
- [x] Agent Definitions (emit execution metadata)

### Layers Touched
- [x] Presentation (Dashboard UI — agent nexus, logs, metrics widgets)
- [x] Business Logic (Dashboard server — aggregation, proxying)
- [x] Data Layer (Brain MCP — new tables, event tracking)

### API Changes
- [x] New endpoint: `POST /api/agent-event` — Record agent execution event
- [x] New endpoint: `GET /api/instances/{id}/agents` — Per-instance agent stats
- [x] New endpoint: `GET /api/instances/{id}/log` — Execution log for instance
- [x] New endpoint: `GET /api/agent-metrics/summary` — Cross-instance agent performance
- [x] Modified endpoint: `GET /api/instances` — Extend with agent summary data
- [x] New WebSocket message: `instance_agent_event` — Real-time agent activity

### Dependencies
- Existing: Brain MCP server, Dashboard server, WebSocket system
- Existing: `events.jsonl` event pipeline, `emit_skill_event.sh`

### Related Files

**Brain MCP Server:**
- `brain-mcp-server/src/index.ts` — Instance API endpoints (line 1228+)
- `brain-mcp-server/src/db.ts` — Database schema (instances table)
- `brain-mcp-server/src/tools/instances.ts` — Heartbeat tool

**Dashboard:**
- `dashboard/server.py` — FastAPI server, brain polling, WebSocket
- `dashboard/static/app.js` — Instance rendering (lines 1404-1683)
- `dashboard/static/index.html` — INSTANCES page HTML (lines 338-378)
- `dashboard/static/style.css` — Instance card styles (lines 1195-1645)

**Skills & Agents:**
- `.claude/skills/hunt/SKILL.md` — Hunt workflow (needs agent event emission)
- `.claude/agents/*.md` — Agent definitions

---

## Constraints

### Architecture Rules
- Must work with existing WebSocket polling model (30s brain instances, 60s brain health)
- Agent events should be lightweight — don't bloat the brain DB
- Must degrade gracefully if brain MCP is unavailable
- Dashboard must remain performant with many concurrent instances

### Technical Constraints
- Brain MCP server is TypeScript/Express
- Dashboard is Python FastAPI + vanilla JS frontend
- No new dependencies — use existing SQLite + WebSocket stack
- Agent events must not slow down `/hunt` workflows

### Timeline
- **Deadline:** Before v4.0 publish (critical for dashboard value proposition)

### Out of Scope
- Brain v5.0 task management system (FR-052-engine through FR-056)
- Team action button backend (broadcast/shutdown RPC) — separate brief
- Context window auto-cleanup (`/compact` skill) — separate brief
- Brief dependency DAG visualization — separate brief

---

## Tasks

### Phase 1: Agent Event Pipeline (Backend)

- [ ] Task 1: Add `agent_events` table to brain DB schema
  ```sql
  CREATE TABLE agent_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    event_type TEXT NOT NULL, -- 'start', 'complete', 'fail', 'retry'
    brief_id TEXT,
    phase TEXT,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    details TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (instance_id) REFERENCES instances(id)
  );
  ```
- [ ] Task 2: Add `POST /api/agent-event` endpoint to brain MCP server
- [ ] Task 3: Add `igris_agent_event` MCP tool for recording agent events
- [ ] Task 4: Add `GET /api/instances/{id}/agents` — Aggregated per-agent stats for an instance
- [ ] Task 5: Add `GET /api/instances/{id}/log` — Execution log (recent agent events)

### Phase 2: Hunt Workflow Integration

- [ ] Task 6: Update `/hunt` skill to emit agent events at each phase transition
  - Before invoking agent: emit `{event_type: 'start', agent_name: 'architect', phase: 'PLANNING'}`
  - After agent returns: emit `{event_type: 'complete'|'fail', duration_ms, tokens_in, tokens_out}`
  - On retry: emit `{event_type: 'retry', details: {reason, attempt}}`
- [ ] Task 7: Update `igris_instance_heartbeat` calls during hunt to include richer phase data
- [ ] Task 8: Update `/team` skill to emit team coordination events (teammate status changes, messages)

### Phase 3: Dashboard API & WebSocket

- [ ] Task 9: Add dashboard proxy endpoints for new brain APIs
- [ ] Task 10: Add `instance_agent_event` WebSocket message type
- [ ] Task 11: Extend brain polling to include agent events for active instances
- [ ] Task 12: Add `GET /api/agent-metrics/summary` — Cross-instance agent performance aggregation

### Phase 4: Frontend — Agent Nexus Live Data

- [ ] Task 13: Wire Agent Nexus table to real data from `/api/instances/{id}/agents`
  - Status row: `IDLE` | `WORKING` | `DONE` | `FAIL` per agent
  - Time row: Duration of last/current invocation
  - Tokens row: Input + output tokens consumed
- [ ] Task 14: Add pulsing animation on active agent column
- [ ] Task 15: Add color coding: green (done/success), red (fail), yellow (working), gray (idle)

### Phase 5: Frontend — Execution Log & Pipeline

- [ ] Task 16: Wire Execution Log to real events from `/api/instances/{id}/log`
  - Format: `[14:52:30] ARCHITECT started planning BR-024...`
  - Format: `[14:53:15] ARCHITECT complete (45s, 12.4K tokens)`
  - Format: `[14:53:16] FORGER started building...`
- [ ] Task 17: Add phase duration display to Hunt Pipeline
  - Show elapsed time under each completed phase node
  - Show running timer on current phase
- [ ] Task 18: Wire retry counter to real data

### Phase 6: Agent Performance Metrics

- [ ] Task 19: Add Agent Performance widget to HOME page
  - Success rate per agent (% of invocations that succeed without retry)
  - Avg token consumption per agent
  - Avg duration per agent
  - Efficiency grade: S/A/B/C/F based on success rate + token efficiency
- [ ] Task 20: Add agent performance sparklines (last 20 invocations trend)
- [ ] Task 21: Add brief velocity widget — completions per day/week, avg time by effort size

### Phase 7: Team Mode Live Data

- [ ] Task 22: Wire team coordination log to real team events
- [ ] Task 23: Populate teammate cards with real per-teammate agent data
- [ ] Task 24: Add file ownership display from team coordination data

### In Progress

### Completed

---

## Workflow State

**Phase:** SUPERSEDED
**Active Agent:** none
**Retry Count:** 0

### Current Work
SUPERSEDED — All requirements absorbed into FR-058 (Crimson Arena Flutter Rewrite).

### Next Steps
HUNT FR-057 — Start with Phase 1 (backend agent event pipeline), then integrate with hunt skill, then wire up dashboard.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-18 | ARCHITECT | Planning FR-057 | COMPLETE — Full 7-phase plan produced |

### Blockers
None

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] Agent Nexus table shows real per-agent status, timing, and token data during `/hunt`
2. [ ] Execution Log streams live events as agents work
3. [ ] Hunt Pipeline shows phase durations and task descriptions
4. [ ] Agent performance metrics (success rate, efficiency grade) displayed on HOME page
5. [ ] Brief velocity tracking widget shows completion trends
6. [ ] Team mode shows real teammate data and coordination logs
7. [ ] All data updates in real-time via WebSocket (within 5s of event)
8. [ ] Graceful degradation when brain MCP unavailable
9. [ ] No performance impact on `/hunt` workflow execution
10. [ ] Linter/analyzer passes (zero issues)
11. [ ] Test suite passes (all existing + new tests green)

---

## Test Plan

### Manual Test Cases

#### Test Case 1: Solo Hunt Agent Tracking
**Preconditions:** Instance registered, brief in Ready status
**Steps:**
1. Run `/hunt BR-XXX` on a test brief
2. Open Crimson Arena → INSTANCES page
3. Expand the active instance card

**Expected Result:**
- Agent Nexus shows ARCHITECT as WORKING during planning
- After architect completes, shows duration and tokens
- FORGER lights up as WORKING during building
- Execution log shows timestamped entries for each agent transition
- Hunt pipeline shows elapsed time per completed phase

#### Test Case 2: Agent Performance Metrics
**Preconditions:** Multiple completed hunts in history
**Steps:**
1. Open Crimson Arena → HOME page
2. Look for Agent Performance widget

**Expected Result:**
- Each agent shows success rate percentage
- Token consumption averages displayed
- Efficiency grade (S/A/B/C/F) shown per agent
- Sparklines show trend over recent invocations

#### Test Case 3: Team Hunt Live Tracking
**Preconditions:** Two briefs in Ready status
**Steps:**
1. Run `/team hunt BR-XXX BR-YYY`
2. Open INSTANCES page
3. Expand team lead instance

**Expected Result:**
- Team header shows team name and brief count
- Each teammate card shows individual pipeline progress
- Coordination log shows teammate status changes
- File ownership displayed per teammate

### Regression Checklist
- [ ] HOME page still renders correctly
- [ ] Instance heartbeat still registers/deregisters
- [ ] WebSocket connection stable
- [ ] Dashboard loads in < 2 seconds
- [ ] Brain MCP tools still functional

---

## Delivery

### Code Changes
- [ ] Modified files: brain-mcp-server/src/db.ts (new table)
- [ ] Modified files: brain-mcp-server/src/index.ts (new endpoints + MCP tool)
- [ ] Modified files: dashboard/server.py (proxy endpoints, WebSocket events)
- [ ] Modified files: dashboard/static/app.js (agent nexus data binding, logs, metrics)
- [ ] Modified files: dashboard/static/index.html (metrics widgets on HOME)
- [ ] Modified files: dashboard/static/style.css (metrics styling)
- [ ] Modified files: .claude/skills/hunt/SKILL.md (agent event emission)
- [ ] Modified files: .claude/skills/team/SKILL.md (team event emission)

### Database Migrations
- [ ] New table: `agent_events` in knowledge.db
- [ ] No data migration needed (new data only)

### Documentation Updates
- [ ] README: Update dashboard section with agent metrics description

### Deployment Notes
- [ ] Requires brain MCP server restart (new table + endpoints)
- [ ] Requires dashboard server restart (new proxy endpoints)
- [ ] Deploy via `/sync code` then restart services on VPS

---

## Notes

### Ideator Enhancements Integrated

This brief incorporates the following ideas from the v4.0 ideation session:

1. **Agent Performance Metrics** (DO NOW) — Success rate, avg tokens, efficiency grade per agent
2. **Brief Velocity Tracking** (DO NOW) — Completion trends, time-per-complexity widget
3. **Agent Confidence Scores** (QUICK WIN) — Agents self-assess confidence on completion
4. **Skill Usage Attribution** (DO NOW) — Extend existing heatmap with per-brief skill correlation

### Data Model Design

**Agent Event Flow:**
```
/hunt invokes architect
  → igris_agent_event(instance_id, 'architect', 'start', brief_id, 'PLANNING')
  → architect works...
  → igris_agent_event(instance_id, 'architect', 'complete', brief_id, 'PLANNING', tokens, duration)
  → Dashboard receives via WebSocket
  → Agent Nexus table updates in real-time
  → Execution Log appends entry
```

**Performance Aggregation:**
```sql
SELECT agent_name,
  COUNT(*) as total_runs,
  SUM(CASE WHEN event_type = 'complete' THEN 1 ELSE 0 END) as successes,
  AVG(tokens_in + tokens_out) as avg_tokens,
  AVG(duration_ms) as avg_duration
FROM agent_events
WHERE event_type IN ('complete', 'fail')
GROUP BY agent_name;
```

---

**Created:** 2026-02-18
**Last Updated:** 2026-02-18
**Brief Owner:** Crimson
