# FR-027: Crimson Arena — Unified Command Center Dashboard

**Type:** Feature Request
**Priority:** P1-High
**Effort:** L-Large (3-5d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-16

---

## Feature Description

**What is the proposed feature?**

Evolve the existing Crimson Arena dashboard (`dashboard/server.py`) into a unified command center that integrates with the brain MCP server on VPS. The dashboard will show live instances, registered projects, brief statuses, session history, and brain health — alongside the existing agent nexus, token tracking, and RPG leveling system.

**Why is this valuable?**

The brain MCP server (FR-025) and live instance registry (FR-026) created a centralized data hub, but there's no visual interface to see it all at a glance. Crimson Arena already has the real-time infrastructure (FastAPI + WebSocket), agent visualization (DNA Digivolution Nexus), and event tracking. Extending it to pull from the brain gives a single pane of glass for the entire Igris AI ecosystem — instances, projects, briefs, agents, and system health in one place.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:** Brain data (instances, projects, briefs, sessions) is only accessible via MCP tool calls in the CLI. The Crimson Arena dashboard only shows local agent events and token stats — it has no awareness of the brain, other machines, or cross-project state.

**With this feature:** Open one browser tab and see everything: which machines are running Igris, what projects are active, which briefs are in progress, brain health status, plus the existing agent RPG stats and token tracking. Real-time updates via WebSocket.

---

## Use Cases

### Use Case 1: View Live Instances
**Actor:** Developer
**Goal:** See all active Igris sessions across machines
**Steps:**
1. Open Crimson Arena in browser (`localhost:8001`)
2. View "Live Instances" panel
3. See table: machine, project, brief, phase, status, last heartbeat
**Expected Outcome:** Real-time grid of all Igris instances with stale detection visual indicators.

### Use Case 2: Monitor Projects & Briefs
**Actor:** Developer
**Goal:** See all registered projects and their brief statuses
**Steps:**
1. Open Crimson Arena
2. View "Projects" panel (registered projects with last session time)
3. View "Briefs" panel (active/ready briefs across projects)
**Expected Outcome:** Cross-project overview of all work tracked by the brain.

### Use Case 3: Check Brain Health
**Actor:** Developer
**Goal:** Verify the brain MCP server is healthy and responsive
**Steps:**
1. Open Crimson Arena
2. View "Brain Health" card in the header/sidebar
3. See: status (ok/down), version, response time, DB stats
**Expected Outcome:** Quick health indicator with last-checked timestamp.

### Use Case 4: View Session History
**Actor:** Developer
**Goal:** See recent sessions across all projects
**Steps:**
1. Open Crimson Arena
2. View "Sessions" panel
3. See table: project, brief, phase, mode, started_at, ended_at
**Expected Outcome:** Timeline of recent work across all projects.

---

## Technical Approach

### High-Level Design

1. **Backend (server.py):** Add brain API proxy endpoints that query the VPS brain at `http://76.13.180.77:3001`. These endpoints fetch instances, projects, briefs, sessions, and health from the brain's REST API and return them to the frontend.

2. **Frontend (index.html + app.js):** Add new panels/sections to the existing Crimson Arena layout. Instances panel (live grid), Projects panel (cards/table), Briefs panel (kanban or table), Brain Health card (status badge), Sessions timeline.

3. **Real-time (WebSocket):** Extend the existing WebSocket connection to poll brain data periodically (every 30s for instances, every 60s for projects/briefs) and broadcast updates to connected frontends.

4. **Configuration:** Brain URL and API key read from `~/.igris/config.json` (already used by sync tools) or environment variables.

### Components Affected

- `dashboard/server.py` — Add brain proxy endpoints, WebSocket brain polling, config loading
- `dashboard/static/index.html` — Add new panels (instances, projects, briefs, sessions, brain health)
- `dashboard/static/app.js` — Add brain data fetching, panel rendering, WebSocket message handling
- `dashboard/static/style.css` — Styles for new panels (matching existing cyberpunk/Digimon theme)

### API/Interface Design

**New Backend Endpoints:**

```
GET /api/brain/health          — Brain server health check
GET /api/brain/instances       — List all live instances (proxies to brain)
GET /api/brain/projects        — List registered projects (proxies to brain)
GET /api/brain/briefs          — List brief statuses (proxies to brain)
GET /api/brain/sessions        — List recent sessions (proxies to brain)
```

All `/api/brain/*` endpoints proxy to the VPS brain REST API with proper auth headers.

**WebSocket Messages (new types):**

```json
{"type": "brain_instances", "data": [...]}
{"type": "brain_projects", "data": [...]}
{"type": "brain_health", "data": {"status": "ok", "version": "4.0.0", "latency_ms": 45}}
```

---

## Context & Inputs

### Dependencies
- [x] FR-025: Deploy Brain MCP Server to VPS (DONE)
- [x] FR-026: Live Instance Registry (DONE)
- [x] Existing Crimson Arena dashboard (`dashboard/server.py`, 1353 lines)
- [ ] `~/.igris/config.json` — Must contain `remote_brain.url` and `remote_brain.api_key`

### Files to Modify
- `dashboard/server.py` — Add brain proxy endpoints, polling, config
- `dashboard/static/index.html` — Add new panel sections
- `dashboard/static/app.js` — Add brain data rendering and WebSocket handling
- `dashboard/static/style.css` — Add styles for new panels

### Files to Create
- None expected (all changes go into existing files)

### Configuration Changes
- [ ] Brain URL from `~/.igris/config.json` (`remote_brain.url`)
- [ ] Brain API key from `~/.igris/config.json` (`remote_brain.api_key`)
- [ ] Optional: `BRAIN_URL` and `BRAIN_API_KEY` environment variable overrides

---

## Alternatives Considered

### Alternative 1: Separate New Dashboard (React/Next.js)
**Pros:**
- Modern framework, component-based
- Easier to scale long-term

**Cons:**
- Throws away existing Crimson Arena work (1353-line server, full frontend)
- Requires new build pipeline, dependencies
- Loses the Digimon theme and RPG system already built

**Why not chosen:** Crimson Arena already has the infrastructure, theme, and real-time capabilities. Extending it is faster and preserves existing work.

### Alternative 2: Brain MCP Server Serves Its Own Dashboard
**Pros:**
- Self-contained, no separate server needed

**Cons:**
- Brain is a headless MCP server, adding UI concerns pollutes its architecture
- Would need to duplicate the agent tracking already in Crimson Arena
- Different tech stack (TypeScript/Node vs Python/FastAPI)

**Why not chosen:** Separation of concerns — brain handles data, Crimson Arena handles visualization.

---

## Constraints

### Technical Constraints
- Must not break existing Crimson Arena functionality (agent tracking, tokens, RPG stats)
- Brain API calls must be async (use `httpx` or `aiohttp`, not blocking `urllib`)
- Brain API calls must handle failures gracefully (brain down = show "offline" status, don't crash)
- Must work when brain is unreachable (existing local features still function)
- Respect brain API key auth (read from config, never expose to frontend)

### UX Constraints
- New panels must match the existing cyberpunk/Digimon visual theme
- Layout must work on standard desktop screens (1920x1080+)
- Brain-related panels should be visually distinct but cohesive with existing sections
- Stale instances should have clear visual indicators (red/dimmed)

### Out of Scope
- Mobile-responsive layout
- User authentication for the dashboard itself
- Instance-to-instance messaging
- Editing brain data from the dashboard (read-only proxy)
- Separate build step (keep it vanilla HTML/JS/CSS like current dashboard)

---

## Tasks

### Pending
- [ ] Phase 1: Backend — Add brain config loading to server.py (read ~/.igris/config.json)
- [ ] Phase 1: Backend — Add async brain HTTP client (httpx/aiohttp with timeout + retry)
- [ ] Phase 1: Backend — Add `/api/brain/health` endpoint
- [ ] Phase 1: Backend — Add `/api/brain/instances` endpoint
- [ ] Phase 1: Backend — Add `/api/brain/projects` endpoint
- [ ] Phase 1: Backend — Add `/api/brain/briefs` endpoint
- [ ] Phase 1: Backend — Add `/api/brain/sessions` endpoint
- [ ] Phase 2: Frontend — Add Brain Health status card to header
- [ ] Phase 2: Frontend — Add Live Instances panel with grid/table
- [ ] Phase 2: Frontend — Add Projects panel with cards
- [ ] Phase 2: Frontend — Add Briefs panel with status indicators
- [ ] Phase 2: Frontend — Add Sessions timeline/table
- [ ] Phase 3: Real-time — Add brain polling loop (30s instances, 60s projects/briefs)
- [ ] Phase 3: Real-time — Broadcast brain updates via existing WebSocket
- [ ] Phase 3: Real-time — Frontend handles new WebSocket message types
- [ ] Test end-to-end: dashboard shows live instance data from VPS brain

---

## Workflow State

**Phase:** INIT
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered. Ready for HUNT.

### Next Steps
Run `/hunt FR-027` to begin implementation.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|

### Blockers
None

---

## Acceptance Criteria

1. [ ] Dashboard loads without errors when brain is reachable
2. [ ] Dashboard loads without errors when brain is unreachable (graceful degradation)
3. [ ] `/api/brain/health` returns brain status, version, and latency
4. [ ] `/api/brain/instances` returns live instance data from VPS brain
5. [ ] `/api/brain/projects` returns registered projects from VPS brain
6. [ ] `/api/brain/briefs` returns brief statuses from VPS brain
7. [ ] Live Instances panel shows machine, project, brief, phase, status
8. [ ] Stale instances visually distinct (dimmed/red)
9. [ ] Brain Health card shows status badge (green/red)
10. [ ] WebSocket broadcasts brain updates to connected clients
11. [ ] Existing Crimson Arena features (agents, tokens, RPG stats) unaffected
12. [ ] All new panels match the cyberpunk/Digimon visual theme

---

## Test Plan

### Functional Tests

**Test Case 1: Brain Health Endpoint**
1. Start dashboard server
2. GET `/api/brain/health`
**Expected Result:** Returns `{"status": "ok", "version": "4.0.0", "latency_ms": <number>}`

**Test Case 2: Live Instances Panel**
1. Register an instance via `igris_instance_heartbeat` on VPS
2. Open dashboard, check Live Instances panel
**Expected Result:** Instance appears with correct machine, project, status

**Test Case 3: Stale Instance Visualization**
1. Create instance with old heartbeat (31+ min ago)
2. Open dashboard
**Expected Result:** Instance shown with stale visual indicator

**Test Case 4: Brain Offline Graceful Degradation**
1. Stop brain server on VPS
2. Open dashboard
**Expected Result:** Brain Health shows "offline", other panels show "brain unavailable", existing agent features still work

**Test Case 5: WebSocket Real-time Updates**
1. Open dashboard in browser
2. Register a new instance on VPS
3. Wait 30 seconds
**Expected Result:** New instance appears in panel without page refresh

### Regression Tests
- [ ] Existing agent hex-grid still renders correctly
- [ ] Token tracking and cost estimation still works
- [ ] Battle log still receives events
- [ ] RPG stats and leveling still functional
- [ ] WebSocket connection for agent events not disrupted

---

## Delivery

- [ ] Updated `dashboard/server.py` with brain proxy endpoints
- [ ] Updated `dashboard/static/index.html` with new panels
- [ ] Updated `dashboard/static/app.js` with brain data handling
- [ ] Updated `dashboard/static/style.css` with new panel styles

---

## Notes

**Depends on:** FR-025 (Brain deployed to VPS), FR-026 (Instance registry)
**Enables:** Future web-based command center, remote monitoring

**Existing Crimson Arena Features (preserve all):**
- DNA Digivolution Nexus hex-grid with 8 agent pods
- Instrument strip (Session HP bar + Digivice data load bar)
- Token Breakdown sidebar
- Cost Estimate sidebar
- Battle Log
- RPG Party Stats (footer)
- Agent leveling: Trainee > Novice > Adept > Expert > Master > Legend > Mythic
- Claude Code hooks integration (events.jsonl)

**Brain VPS:** `http://76.13.180.77:3001`
**Brain API:** `/health`, `/sync/push`, `/sync/pull` (existing); tool calls via MCP

**Architecture Note:** The brain MCP server's tool handlers return data but aren't REST endpoints themselves. For dashboard proxy, we'll need to either:
1. Call the brain's tool handlers via the MCP protocol (complex)
2. Add simple REST query endpoints to the brain server (preferred — lightweight GET routes that query SQLite directly)

Option 2 is preferred — add a few GET routes to the brain's Express/HTTP layer that return JSON. This is simpler than proxying MCP tool calls.

---

**Created:** 2026-02-16
**Last Updated:** 2026-02-16
**Brief Owner:** Crimson (Fifty.ai)
