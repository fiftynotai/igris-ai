# FR-052: Redesign Crimson Arena Dashboard UI/UX

**Type:** Feature
**Priority:** P1-High
**Effort:** L-Large (8-24h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** In Progress
**Created:** 2026-02-17

---

## Problem

The current Crimson Arena dashboard UI has several UX issues:

1. **Hunt Pipeline Job** — The representation is unclear and confusing. Users don't understand what it shows or how to interpret the workflow stages.

2. **Agent Teams** — No representation at all. When `/team` spawns parallel agents, there's no visibility into team composition, progress, or coordination.

3. **DNA Digivolution Nexus** — The homepage component is pointless in its current form. It should be replaced with a **Running Instances** view where users can:
   - See all active Igris instances across machines
   - Select an instance to drill into
   - See agents working inside that instance in real-time
   - Monitor which brief each agent is working on and its current phase

**Why does it matter?**
The dashboard should be the command center for monitoring Igris AI operations. Key capabilities (agent teams, instance monitoring, hunt pipeline) are either invisible or confusing, making the dashboard less useful than it should be.

---

## Goal

Redesigned Crimson Arena dashboard with:
- **Two-page architecture:** HOME (general overview) + INSTANCES (operations floor)
- HOME: System-wide health, tokens, costs, brain data, agent roster, skill heatmap, battle log
- INSTANCES: Running instances with expandable hunt pipelines, agent tables, gantt timelines
- Agent Teams nested inside parent (team lead) instance — not a separate section
- Clear Hunt Pipeline visualization with phases, active agent, duration, retries
- Best-practice UI/UX patterns for monitoring dashboards

### Design Spec
Full wireframes and design decisions: `ai/briefs/FR-052-crimson-arena-redesign-spec.md`

---

## Context & Inputs

### Current Architecture
- `dashboard/server.py` — FastAPI backend with SQLite + brain API proxy
- `dashboard/static/app.js` — Vanilla JS SPA with WebSocket updates
- `dashboard/static/style.css` — CSS styles
- `dashboard/static/index.html` — Single page HTML shell
- Brain MCP server provides: instances, projects, briefs, sessions, metrics APIs

### Key Data Sources
- `igris_instance_list` / `igris_instance_heartbeat` — Running instances with current_brief and current_phase
- Agent metrics — Per-agent invocation counts, success/failure rates
- Brief status — Workflow phase progression (INIT > PLANNING > BUILDING > TESTING > REVIEWING > COMMITTING)
- Team status — Agent team composition and task assignments

---

## Acceptance Criteria

1. [ ] Two-page navigation (HOME + INSTANCES) with hash routing
2. [ ] HOME shows general Igris info (tokens, costs, brain, agents, skills, battle log)
3. [ ] INSTANCES page with expandable instance cards
4. [ ] Solo instance expands to: hunt pipeline + agent table + gantt + execution log
5. [ ] Team lead instance expands to: team container with nested teammate pipelines
6. [ ] Team coordination log + file ownership map inside parent instance
7. [ ] Hunt Pipeline shows phases, active agent, duration, retry counters
8. [ ] Empty state when no instances running
9. [ ] Persistent vital signs strip (HP, CTX, Sync) on both pages
10. [ ] Responsive and performant

---

---

## Workflow State

**Phase:** COMMITTING
**Active Agent:** none
**Retry Count:** 0

### Current Work
Loading brief and preparing for implementation.

### Next Steps
Proceed to PLANNING phase.

### Agent Log
- [2026-02-18] INIT: Brief loaded, status updated to In Progress.
- [2026-02-18] ARCHITECT: Plan complete — 4 files, 8 phases, ~16h estimated. Two-page architecture (HOME + INSTANCES), hash routing, instance cards with expanded hunt pipeline/gantt/agents, nested team views. Awaiting user approval (L effort).
- [2026-02-18] APPROVAL: Plan approved by user.
- [2026-02-18] FORGER: Implementation complete — 4 files modified. index.html restructured to two-page SPA, app.js refactored with hash router + page dispatcher + instance rendering, style.css rewritten (2549 lines), server.py enhanced with instance detail endpoint.
- [2026-02-18] SENTINEL: PASS — Python/JS/HTML/CSS syntax clean, 10/10 acceptance criteria verified, all cross-references valid, server endpoint correct.
- [2026-02-18] WARDEN: APPROVE — Zero critical/major issues. 5 minor suggestions (CSS selector sanitization, duplicate timeAgo function, server path regex, bound flag pattern, var re-declaration). Security solid, XSS protection thorough, 10/10 AC met.

---

**Created:** 2026-02-17
**Brief Owner:** Crimson
