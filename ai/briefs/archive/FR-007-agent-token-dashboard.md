# FR-007: Agent Token Consumption Dashboard (Crimson Arena)

**Type:** Feature Request
**Priority:** P1-High
**Effort:** L-Large (3-5d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-08
**Completed:** 2026-02-09

---

## Feature Description

**What is the proposed feature?**

A gaming-style real-time dashboard that visualizes Igris AI agent token consumption during Claude Code sessions. The dashboard receives live data from SubagentStart/SubagentStop hooks, displays per-agent token breakdowns, session budget tracking, and agent activity feeds -- all styled with the Crimson persona's Fifty Design Language (FDL) and Digimon battle aesthetics.

**Why is this valuable?**

Developers using Igris AI's 7-agent system have zero visibility into which agents consume tokens, how efficiently cache is used, or whether a session is burning through budget. The existing `agent-metrics.json` tracks invocations and durations but not tokens. This dashboard turns raw hook data into an engaging, actionable visualization that helps developers understand and optimize their AI workflow costs.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] Contributors (extending Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
No visibility into agent token consumption. The `agent-metrics.json` only tracks invocation counts and durations. Developers cannot see which agent is the most expensive, how much cache is being utilized, or estimate remaining session budget. The persona's visual identity (FDL colors, Digimon theme) is completely unused beyond terminal text.

**With this feature:**
Real-time visual monitoring of all 7 agents during sessions. Per-agent token breakdowns, budget health indicators, activity feeds, and RPG-style progression stats. Developers make informed decisions about workflow optimization. The Crimson persona comes alive through a gaming-inspired interface.

---

## Use Cases

### Use Case 1: Real-Time Session Monitoring
**Actor:** Developer running Claude Code with Igris AI
**Goal:** Monitor agent token consumption during a `/hunt` workflow
**Steps:**
1. Developer starts the dashboard (launches web app or TUI)
2. Developer runs `/hunt BR-015` in Claude Code
3. Dashboard shows ARCHITECT activating with live token counter
4. ARCHITECT completes, dashboard shows token delta and pipeline flow to FORGER
5. Developer sees FORGER consuming majority of budget, understands cost distribution

**Expected Outcome:** Developer has real-time awareness of which agents consume what, enabling informed decisions about workflow and budget.

### Use Case 2: Session Budget Tracking
**Actor:** Developer on a limited token plan
**Goal:** Avoid exhausting daily token budget
**Steps:**
1. Developer configures budget ceiling in `budget.json`
2. Dashboard displays HP-style budget bar
3. As agents consume tokens, the bar depletes with color shifts (green -> yellow -> crimson)
4. At 75% usage, warning indicator appears
5. Developer decides to defer remaining work to next session

**Expected Outcome:** Developer never gets surprised by budget exhaustion.

### Use Case 3: Agent Performance Analysis
**Actor:** Developer optimizing their multi-agent workflow
**Goal:** Identify inefficient agents and optimize token usage
**Steps:**
1. Developer opens agent comparison view after session
2. Sees FORGER consumed 67% of total tokens across 3 invocations
3. Sees SEEKER has excellent cache efficiency (high cache_read ratio)
4. Reviews RPG-style agent character sheets with STR/INT/SPD/VIT stats
5. Considers splitting large briefs to reduce per-FORGER-run cost

**Expected Outcome:** Data-driven optimization of multi-agent workflow.

---

## Technical Approach

### Verified Data Model

**Hook stdin payload (SubagentStart/SubagentStop):**
```json
{
  "session_id": "uuid",
  "transcript_path": "/path/to/session.jsonl",
  "cwd": "/project/root",
  "hook_event_name": "SubagentStart|SubagentStop",
  "agent_id": "short-id",
  "agent_type": "Explore|coder|planner|...",
  "agent_transcript_path": "/path/to/subagent.jsonl",  // SubagentStop only
  "permission_mode": "acceptEdits"  // SubagentStop only
}
```

**Token data location (transcript JSONL at `agent_transcript_path`):**
```json
{
  "message": {
    "usage": {
      "input_tokens": 8,
      "output_tokens": 27,
      "cache_read_input_tokens": 30757,
      "cache_creation_input_tokens": 32760
    }
  }
}
```

**Note:** Token fields are NOT in the hook stdin payload. They must be parsed from the subagent transcript JSONL file provided via `agent_transcript_path` on SubagentStop.

### Architecture

```
Claude Code Hooks (SubagentStart/SubagentStop)
  |
  v
agent_metrics.sh (enhanced)
  |-- Parses transcript JSONL for token data
  |-- Appends to events.jsonl (timestamped event log)
  |-- Updates agent-metrics.json (aggregated stats)
  |-- POSTs to localhost:8001/api/event (if server running)
  |
  v
Dashboard Server (FastAPI / Express)
  |-- Receives POST from hook OR watches events.jsonl
  |-- Stores in SQLite for persistence
  |-- Broadcasts via WebSocket to connected clients
  |
  v
Dashboard UI (Browser at localhost:8001)
  |-- WebSocket connection for real-time updates
  |-- React/Tailwind with gaming CSS components
  |-- FDL color theme (#960E29, #B31337, #161617)
  |-- Agent arena, budget HP bar, battle log, RPG stats
```

### Components Affected
- `.claude/hooks/agent_metrics.sh` - Enhance to parse transcript tokens + write event log + POST to server
- `ai/session/metrics/events.jsonl` - New: append-only event log
- `ai/session/metrics/budget.json` - New: budget configuration
- `ai/session/metrics/agent-metrics.json` - Enhanced: add token fields
- `dashboard/` - New: dashboard application (server + frontend)

---

## Implementation Phases

### Phase 0: Data Pipeline Enhancement (S effort, prerequisite)

Extend `agent_metrics.sh` to:
1. Parse `agent_transcript_path` JSONL for token usage on SubagentStop
2. Store token totals (input, output, cache_read, cache_create) per agent in `agent-metrics.json`
3. Append timestamped events to `ai/session/metrics/events.jsonl`
4. Create `ai/session/metrics/budget.json` config file

**Enhanced metrics schema:**
```json
{
  "version": "2.0.0",
  "agents": {
    "forger": {
      "invocations": 16,
      "avg_duration_seconds": 155.6,
      "total_input_tokens": 18540,
      "total_output_tokens": 12870,
      "total_cache_read_tokens": 4096,
      "total_cache_create_tokens": 2048,
      "success_rate": 1.0
    }
  }
}
```

**Event log format (events.jsonl):**
```jsonl
{"ts":"2026-02-08T19:44:00Z","event":"start","agent":"architect","agent_id":"a1b2c3"}
{"ts":"2026-02-08T19:46:23Z","event":"stop","agent":"architect","agent_id":"a1b2c3","duration_s":143,"input_tokens":3100,"output_tokens":2340,"cache_read":256,"cache_create":1024}
```

### Phase 1: Dashboard Server (M effort)

- FastAPI (Python) or Express (Node.js) web server
- WebSocket endpoint for real-time broadcast
- REST endpoint for hook POST (`/api/event`)
- SQLite for persistent storage
- File-watcher fallback (reads events.jsonl if no POST)
- Serves static frontend files
- Auto-launch script (`scripts/dashboard.sh`)

### Phase 2: Gaming UI Frontend (M effort)

**Crimson Arena (primary view):**
- 7 agent pods arranged in pipeline formation
- Agent pods: idle (dim) / active (crimson glow + particles) / complete (green flash)
- Session HP bar (budget meter) with threshold color shifts
- Real-time battle log ticker
- Token flow breakdown (input vs output vs cache)
- FDL color theme throughout

**RPG Party Stats (agent detail view):**
- Per-agent character cards with:
  - STR (output tokens), INT (cache efficiency), SPD (avg duration), VIT (success rate)
  - Level system: Trainee (0) -> Novice (5) -> Adept (15) -> Expert (30) -> Master (50) -> Legend (100) -> Mythic (200)
  - Digimon evolution tier: In-Training -> Rookie -> Champion -> Ultimate -> Mega
  - Ability tags from agent definitions
  - Lifetime stats

**Agent comparison view:**
- Side-by-side bar charts for token consumption
- Timeline / Gantt-chart of session activity

### Phase 3: Enhancements (S effort each, backlog)

- Achievement system (persistent JSON, toast notifications)
- Pre-compact token snapshot (inject token summary into compact recovery context)
- `/scan` token integration (add token summary to existing skill)
- Sound design (optional audio cues for agent events)
- Session replay (timeline scrub of recorded events)

---

## Context & Inputs

### Dependencies
- [x] Python3 (already required by Igris AI)
- [ ] FastAPI + uvicorn (pip install, for server)
- [ ] React + Tailwind (npm, for frontend)
- [ ] SQLite3 (Python stdlib, no external dep)
- [x] Existing hooks infrastructure (SubagentStart/SubagentStop in settings.json)

### Files to Create
- `dashboard/server.py` - FastAPI WebSocket server
- `dashboard/static/index.html` - Dashboard frontend
- `dashboard/static/app.js` - Frontend logic
- `dashboard/static/style.css` - FDL-themed gaming CSS
- `dashboard/requirements.txt` - Python deps
- `scripts/dashboard.sh` - Launch script
- `ai/session/metrics/budget.json` - Budget config
- `ai/session/metrics/events.jsonl` - Event log (auto-created by hook)

### Files to Modify
- `.claude/hooks/agent_metrics.sh` - Add token parsing + event log + POST
- `ai/session/metrics/agent-metrics.json` - Schema v2.0.0 with token fields

### Configuration Changes
- [ ] New settings: `budget.json` (daily_token_budget, warning/critical thresholds, tokens_per_second_estimate)
- [ ] Dashboard port: localhost:8001 (configurable)

---

## Alternatives Considered

### Alternative 1: Terminal TUI Only (DIGIVICE HUD)
**Pros:**
- No browser needed, runs in split terminal pane
- Uses existing FDL ANSI colors
- Lighter weight, fewer dependencies

**Cons:**
- Limited visual fidelity (no animations, particles, smooth charts)
- Terminal size constraints
- Cannot do gaming-style effects (gradients, glow, canvas)

**Why not primary:** Gaming UI requires web rendering for the visual fidelity the user wants. However, a TUI companion could be built later as a lightweight alternative using the same data pipeline.

### Alternative 2: Python Textual TUI
**Pros:**
- Pure Python (matches project stack)
- Good terminal aesthetics with Rich library

**Cons:**
- Still terminal-limited
- No true gaming UI possible
- Less visual impact

**Why not primary:** Same terminal limitations. Better as a Phase 3 enhancement.

### Alternative 3: Electron/Tauri Desktop App
**Pros:**
- Native app experience
- System tray integration
- Full web capabilities

**Cons:**
- Much higher complexity (Rust toolchain for Tauri, 50MB+ for Electron)
- Distribution/packaging overhead
- Overkill for local dev monitoring

**Why not primary:** Too heavy for the use case. Web app in browser achieves the same visual result with simpler stack.

---

## Constraints

### Technical Constraints
- Hook timeout is 5 seconds (curl POST to localhost fits easily)
- Hooks must always exit 0 (never block Claude Code)
- Transcript JSONL may not be fully flushed at SubagentStop (add small delay or retry)
- Dashboard must run alongside Claude Code without interfering
- Follow `ai/context/coding_guidelines.md` for bash scripts

### UX Constraints
- Dashboard auto-updates without manual refresh
- Must use FDL color palette (Crimson #960E29, Tech Crimson #B31337, Surface 0 #0E0E0F)
- Gaming aesthetic: HP bars, XP bars, battle log, agent avatars -- not corporate charts
- Must degrade gracefully if dashboard server isn't running (hooks still work, data still collected)

### Timeline
- **Deadline:** N/A
- **Milestones:** Phase 0 (data pipeline) -> Phase 1 (server) -> Phase 2 (UI)

### Out of Scope
- Mobile companion app
- Cloud-hosted dashboard
- Multi-user / team dashboards
- Integration with external monitoring tools (Grafana, DataDog)
- Actual Digimon artwork generation (use placeholders/ASCII)

---

## Tasks

### Pending

**Phase 0: Data Pipeline**
- [ ] Enhance `agent_metrics.sh` to parse transcript JSONL for token usage
- [ ] Add token fields to `agent-metrics.json` schema (v2.0.0)
- [ ] Create `events.jsonl` append-only event log
- [ ] Create `budget.json` config file with defaults
- [ ] Add curl POST to localhost:8001 in hook (non-blocking, fail-silent)

**Phase 1: Dashboard Server**
- [ ] Create FastAPI server with WebSocket endpoint
- [ ] Create REST endpoint `/api/event` for hook POST
- [ ] Add SQLite storage for persistent metrics
- [ ] Add file-watcher fallback for events.jsonl
- [ ] Create launch script (`scripts/dashboard.sh`)

**Phase 2: Gaming UI**
- [ ] Build Crimson Arena layout (agent pods in pipeline formation)
- [ ] Implement agent pod states (idle/active/complete) with CSS animations
- [ ] Build session HP bar (budget meter) with threshold colors
- [ ] Build real-time battle log ticker
- [ ] Build token flow breakdown panel
- [ ] Build RPG Party Stats character cards with leveling system
- [ ] Build agent comparison view
- [ ] Apply FDL color theme throughout

**Phase 3: Enhancements (backlog)**
- [ ] Achievement system
- [ ] Pre-compact token snapshot
- [ ] `/scan` token integration
- [ ] Sound design (optional)
- [ ] Session replay

### In Progress
_(None - brief just registered)_

### Completed
_(None)_

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 1

### Current Work
All phases implemented, tested, reviewed, and committed.

### Next Steps
Archive brief. Launch dashboard with `scripts/dashboard.sh`.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-08 | seeker | Research hook payloads + dashboard tech | Complete: verified data model, recommended FastAPI + React stack |
| 2026-02-08 | ideator | Brainstorm gaming UI concepts | Complete: 5 concepts + 3 systems, recommended Crimson Arena + DIGIVICE HUD |
| 2026-02-09 | architect | Create implementation plan (Phases 0-2) | SUCCESS: 10 files (2 modify, 8 create), 3 phases, ~16h total |
| 2026-02-09 | forger | Build Phase 0: Data Pipeline Enhancement | SUCCESS: agent_metrics.sh v2.0.0, budget.json, events.jsonl, .gitignore |
| 2026-02-09 | forger | Build Phase 1: Dashboard Server | SUCCESS: server.py (852L), dashboard.sh (217L), requirements.txt |
| 2026-02-09 | forger | Build Phase 2: Gaming UI Frontend | SUCCESS: index.html (210L), style.css (910L), app.js (813L) |
| 2026-02-09 | sentinel | Test all phases + regression | PASS: 9/9 test categories, 12/12 migration assertions, all clean |
| 2026-02-09 | warden | Code review | REJECT: 4 issues (XSS, eval, 0.0.0.0, POST validation) |
| 2026-02-09 | forger | Fix 4 WARDEN issues | SUCCESS: escapeHtml (22x), eval removed, 127.0.0.1, Pydantic model |
| 2026-02-09 | warden | Re-review after fixes | APPROVE: all 4 issues verified fixed, no regressions |
| 2026-02-09 | orchestrator | Commit to develop | SUCCESS: 86cea25, 13 files, +3918 lines |

### Blockers
None

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] `agent_metrics.sh` captures token data from SubagentStop transcript JSONL
2. [ ] `events.jsonl` records timestamped start/stop events with token counts
3. [ ] `budget.json` config exists with configurable budget ceiling
4. [ ] Dashboard server runs on localhost:8001 and accepts WebSocket connections
5. [ ] Dashboard UI displays 7 agent pods with real-time state (idle/active/complete)
6. [ ] Session budget HP bar depletes as tokens are consumed with color thresholds
7. [ ] Per-agent token breakdown shows input/output/cache split
8. [ ] Battle log displays real-time agent activity feed
9. [ ] RPG stats (STR/INT/SPD/VIT) derived from real agent data
10. [ ] Agent leveling system tracks progression across sessions
11. [ ] FDL color theme applied (#960E29, #B31337, #161617)
12. [ ] Dashboard works independently of Claude Code (fail-silent if not running)
13. [ ] No regressions to existing hook functionality

---

## Test Plan

### Functional Tests

**Test Case 1: Token Data Capture**
**Steps:**
1. Run a subagent invocation in Claude Code
2. Check `events.jsonl` for new event entry
3. Verify token fields (input_tokens, output_tokens, cache_read, cache_create) are populated
4. Check `agent-metrics.json` for updated token totals

**Expected Result:** Token data captured from transcript and stored in both files
**Status:** [ ] Pass / [ ] Fail

**Test Case 2: Real-Time Dashboard Updates**
**Steps:**
1. Start dashboard server (`scripts/dashboard.sh`)
2. Open browser to localhost:8001
3. Run a subagent invocation in Claude Code
4. Observe dashboard updates in real-time

**Expected Result:** Agent pod activates, token counter updates, battle log shows event
**Status:** [ ] Pass / [ ] Fail

**Test Case 3: Budget Threshold Warnings**
**Steps:**
1. Set budget to low value in `budget.json`
2. Run multiple agent invocations
3. Observe budget HP bar approaching threshold

**Expected Result:** Bar color shifts from green to yellow at 75%, to crimson at 90%
**Status:** [ ] Pass / [ ] Fail

**Test Case 4: Hook Resilience**
**Steps:**
1. Stop dashboard server
2. Run a subagent invocation
3. Verify Claude Code hooks still succeed (exit 0)
4. Verify `events.jsonl` still records data

**Expected Result:** Hooks degrade gracefully, data collection continues, no errors
**Status:** [ ] Pass / [ ] Fail

### Regression Tests
- [ ] Existing SubagentStart/SubagentStop hooks still fire correctly
- [ ] `agent-metrics.json` backward compatible (v1 data not lost)
- [ ] All other hooks (session_start, session_end, brief_gate, etc.) unaffected
- [ ] Claude Code performance not degraded by hook changes

---

## Delivery

### Documentation
- [ ] README: Add "Dashboard" section with setup instructions
- [ ] Dashboard: Inline help/tooltips for gaming UI elements
- [ ] Architecture: Document data pipeline in `ai/context/`

### Announcement
- [ ] Changelog entry: "Agent Token Dashboard with gaming UI"
- [ ] Release notes: Screenshot of Crimson Arena dashboard

---

## Success Metrics

**How will we know this feature is valuable?**

- Developer uses dashboard during normal workflow sessions
- Token visibility leads to measurable optimization decisions (splitting briefs, choosing lightweight agents)
- Budget tracking prevents surprise token exhaustion
- The gaming aesthetic makes monitoring enjoyable rather than tedious
- RPG progression system encourages consistent use of the multi-agent system

---

## Notes

**Research Sources:**
- Community project: `disler/claude-code-hooks-multi-agent-observability` (Vue 3 + Bun + SQLite + WebSocket - validates architecture)
- Community tools: `ccusage`, `Claude-Code-Usage-Monitor`, `claude-code-otel`
- Claude Code hooks docs: https://code.claude.com/docs/en/hooks

**Design References:**
- Crimson persona: `ai/persona.json` (cyber-monkey, Digimon Battle Mode)
- FDL color system: `ai/personas/cyber-monkey/themes/README.md`
- Character art prompts: `ai/personas/cyber-monkey/CRIMSON_CHARACTER_PROMPT.md`

**Verified Payload Data (2026-02-08):**
- Hook stdin does NOT include token fields
- Tokens available at `event.message.usage` in transcript JSONL at `agent_transcript_path`
- Fields: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`
- Test agent (Explore/haiku) used 63,552 total tokens (mostly cache)

**Future Enhancements:**
- DIGIVICE HUD: TUI version for terminal-only monitoring
- Achievement system: Persistent badges for usage milestones
- Brief token attribution: Link costs to specific briefs
- Session replay: Playback recorded sessions
- Sound design: Audio cues for agent events
- Cyberpunk data stream: Ambient Matrix-rain monitor

---

**Created:** 2026-02-08
**Last Updated:** 2026-02-08
**Brief Owner:** Fifty.ai
