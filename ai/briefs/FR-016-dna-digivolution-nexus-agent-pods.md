# FR-016: DNA Digivolution Nexus — Agent Pods Redesign

**Type:** Feature Request
**Priority:** P2-Medium
**Effort:** L-Large (3-5d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-10

---

## Feature Description

**What is the proposed feature?**

Redesign the Agent Pods section of the Crimson Arena dashboard from flat rectangular cards into an interconnected energy web (DNA Digivolution Nexus). Agents are displayed as glowing circular energy cores on a dark hexagonal grid, connected by data-flow lines that light up with traveling particles during active delegation chains.

**Why is this valuable?**

The current agent pods are visually flat and read like database records. This redesign leans into the Digimon aesthetic that the rest of the dashboard (Digivice context bar, HP bar, RPG stats) already commits to. It visually communicates delegation relationships, agent activity, and progression in a way that feels alive and thematic.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
Agent pods are small rectangles in a pipeline layout with plain Unicode arrows. RPG stats are hidden in a collapsed footer. The Digimon theme is underrepresented in the most prominent section of the dashboard.

**With this feature:**
Agents feel like living digital entities. Delegation flows are visible as energy traveling between cores. The hexagonal grid gives a Digital World backdrop. RPG stats are accessible via hover without scrolling to the footer.

---

## Use Cases

### Use Case 1: Monitoring Active Delegation
**Actor:** Developer watching the dashboard during a HUNT
**Goal:** See which agent is active and its relationship to the orchestrator
**Steps:**
1. Dashboard shows IGRIS core at center, connected to all agents
2. FORGER activates — connection line from IGRIS to FORGER lights up crimson
3. Crimson particles travel along the line from orchestrator to FORGER
4. FORGER core glows full brightness, timer appears

**Expected Outcome:** Developer instantly sees the delegation chain without reading text

### Use Case 2: Checking Agent Progression
**Actor:** Developer reviewing agent stats
**Goal:** See an agent's XP, evolution tier, and RPG stats
**Steps:**
1. Hover over SENTINEL core
2. XP ring (conic-gradient) shows 18% fill
3. Four stat bars orbit outward: STR, INT, SPD, VIT

**Expected Outcome:** Full agent stats visible without navigating to footer

---

## Technical Approach

### High-Level Design

Replace the `.agent-pipeline` section in `index.html` with a `.nexus` container using absolutely positioned agent cores. Each core is a circular element with:
- Outer ring: XP progress via `conic-gradient`
- Inner circle: Agent monogram + evolution badge
- Label below: Agent name + invocation count

Connection lines between orchestrator and each agent rendered via positioned pseudo-elements with CSS borders. Active state triggers particle animation along lines.

Hexagonal grid background via inline SVG `background-image` pattern.

### Components Affected
- `dashboard/static/index.html` — Replace agent pipeline HTML with nexus layout
- `dashboard/static/style.css` — New `.nexus*` classes, remove/replace `.agent-pod*` classes
- `dashboard/static/app.js` — Update `renderAgentPods` / `_renderSinglePod` to render nexus cores, add hover stat expansion

### Visual Spec

```
                              ARCHITECT
                                (O)
                                 |
                                 |
            WARDEN             IGRIS              FORGER
             (O)-------(*)-------(O)
                                 |
                                 |
                              SENTINEL
                                (O)


              MENDER        SEEKER          SAGE
               (.)           (O)            (.)

  (*) = orchestrator (larger, crimson)
  (O) = idle agent
  (.) = dim / rarely used
  Lines connect orchestrator to each Tier 1 agent
```

### Core Element Structure

```html
<div class="nexus">
  <div class="nexus__core nexus__core--orchestrator" data-agent="igris">
    <div class="nexus__ring"></div>
    <div class="nexus__inner">IG</div>
    <div class="nexus__label">IGRIS</div>
  </div>
  <div class="nexus__line nexus__line--igris-architect"></div>
  <div class="nexus__core" data-agent="architect">...</div>
  <!-- repeat for all agents -->
</div>
```

### Key CSS Patterns

- **XP Ring:** `conic-gradient(var(--crimson) 0deg Xdeg, transparent Xdeg 360deg)` on `.nexus__ring`
- **Hex Grid BG:** `background-image: url("data:image/svg+xml,...")` repeating hexagon pattern
- **Connection Lines:** `position: absolute` divs with `border-top`, rotated via `transform: rotate()`
- **Flow Particles:** `::after` pseudo-element on active lines, animated via `transform: translateX()` keyframe
- **Core Breathing:** Slow `scale(1.0 → 1.02)` + `box-shadow` pulse with staggered `animation-delay`
- **Hover Stats:** Four arc-bars at N/E/S/W using `::before`/`::after` with `conic-gradient` segments

### Animations

| Animation | Trigger | Duration | Description |
|-----------|---------|----------|-------------|
| Core breathing | Always (idle) | 3-4s loop | Subtle scale + shadow pulse, staggered per agent |
| Line charge | Agent activates | 300ms | Line opacity 0.2 → 1.0, color shift to crimson |
| Flow particles | Agent active | 1.5s loop | 3px crimson dot travels along connection line |
| Particle reverse | Agent completes | 1s | Particles flow back, core green flash |
| Stat orbit | Hover | 200ms | 4 stat bars animate outward from core center |
| DNA spiral | 2 agents active | Continuous | Two overlapping circles with opposing rotation at midpoint |

---

## Context & Inputs

### Dependencies
- No new packages needed — pure HTML/CSS/JS

### Files to Create
- None (modifications to existing files only)

### Files to Modify
- `dashboard/static/index.html` — Replace agent pipeline section
- `dashboard/static/style.css` — Add nexus classes, deprecate agent-pod classes
- `dashboard/static/app.js` — Rewrite renderAgentPods for nexus layout

### Configuration Changes
- None

---

## Alternatives Considered

### Alternative 1: V-Pet Grid (Concept 1)
**Pros:**
- Easy to implement (CSS reskin of existing pods)
- Heavy reuse of existing digi-panel classes
- Nostalgic Digimon hardware charm

**Cons:**
- Doesn't show delegation relationships
- Visually similar to current flat layout

**Why not chosen:** Lower wow factor, doesn't communicate agent interactions

### Alternative 2: Evolution Roster (Concept 3)
**Pros:**
- Highest data density
- Excellent mobile support
- Evolution chain track is compelling

**Cons:**
- Less visual impact
- Vertical list feels conventional

**Why not chosen:** Less thematic, more "game menu" than "digital world"

### Alternative 3: Digivice HUD (Concept 2)
**Pros:**
- Interactive radar concept
- Shows all agents spatially

**Cons:**
- Only shows one agent's detail at a time
- Radar needs minimum viewport size

**Why not chosen:** Lower data density, tricky on mobile

---

## Constraints

### Technical Constraints
- HTML/CSS/JS only — no canvas or WebGL
- Must work with existing FastAPI backend and WebSocket events
- All agent positioning percentage-based for responsive scaling
- Must maintain real-time updates from WebSocket agent events

### UX Constraints
- Agent status must be visible at a glance (no clicks required for basic info)
- Active delegation must be immediately obvious
- RPG stats accessible on hover without breaking layout

### Out of Scope
- Agent avatar artwork / illustrations
- 3D rendering or WebGL effects
- Changes to backend server.py or data model
- Mobile-specific nexus layout (acceptable to set min-width)

---

## Tasks

### Pending
- [ ] Task 1: Design hexagonal grid SVG background pattern
- [ ] Task 2: Build nexus container with absolute-positioned cores
- [ ] Task 3: Implement XP conic-gradient ring on each core
- [ ] Task 4: Render connection lines between orchestrator and agents
- [ ] Task 5: Add flow particle animation on active connection lines
- [ ] Task 6: Implement core breathing idle animation (staggered)
- [ ] Task 7: Add hover stat orbit (STR/INT/SPD/VIT radial bars)
- [ ] Task 8: Wire up app.js rendering to nexus layout
- [ ] Task 9: Handle active/idle/complete state transitions with animations
- [ ] Task 10: Add DNA spiral effect for simultaneous active agents
- [ ] Task 11: Remove or deprecate old agent-pod CSS/HTML

### In Progress
_(none)_

### Completed
_(none)_

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered. Awaiting HUNT command.

### Next Steps
HUNT FR-016 to begin implementation.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-10 | ARCHITECT | Planning FR-016 | Plan complete — 5 phases, 3 files, full spec delivered |
| 2026-02-10 | FORGER | Phase 1-2: CSS + HTML | 342 lines CSS added, pipeline HTML replaced with nexus grid |
| 2026-02-10 | FORGER | Phase 3: JavaScript | renderAgentPods rewritten, 4 new methods added, onAgentStop migrated |
| 2026-02-10 | FORGER | Phase 4: CSS cleanup | 202 lines dead CSS removed (pipeline + agent-pod) |
| 2026-02-10 | SENTINEL | Validation | PASS — HTML, JS, CSS, cross-file consistency, server startup all green |
| 2026-02-10 | WARDEN | Code review | APPROVE — 0 critical, 0 major, 8 minor suggestions |

### Blockers
None

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] Agent pods replaced with nexus energy core layout
2. [ ] Orchestrator (IGRIS) at center, Tier 1 in inner ring, Support in outer arc
3. [ ] Hexagonal grid background visible behind cores
4. [ ] XP progress shown as conic-gradient ring on each core
5. [ ] Connection lines visible between orchestrator and agents
6. [ ] Active agent triggers particle flow animation on its connection line
7. [ ] Idle cores have subtle breathing animation
8. [ ] Hover on core reveals RPG stats (STR/INT/SPD/VIT) orbiting outward
9. [ ] Agent complete state triggers green flash + reverse particle flow
10. [ ] Real-time WebSocket updates still drive core states correctly
11. [ ] No regressions to other dashboard sections (token breakdown, cost estimate, battle log)

---

## Test Plan

### Functional Tests
**Test Case 1: Active Agent Visualization**
**Steps:**
1. Trigger an agent event (POST /api/event with agent start)
2. Observe nexus layout

**Expected Result:** Connection line charges, particles flow, core glows crimson
**Status:** [ ] Pass / [ ] Fail

**Test Case 2: Hover Stat Display**
**Steps:**
1. Hover over any agent core
2. Observe stat expansion

**Expected Result:** 4 RPG stat bars animate outward from core
**Status:** [ ] Pass / [ ] Fail

**Test Case 3: Agent Completion**
**Steps:**
1. Trigger agent stop event
2. Observe nexus layout

**Expected Result:** Particles reverse, core flashes green, returns to idle breathing
**Status:** [ ] Pass / [ ] Fail

### Regression Tests
- [ ] Token Breakdown card still renders correctly
- [ ] Cost Estimate card still renders correctly
- [ ] Battle Log still receives and displays events
- [ ] WebSocket connection stable
- [ ] Context Window (Digivice) unaffected

---

## Delivery

### Documentation
- [ ] Update dashboard README if exists
- [ ] Add inline code comments for nexus positioning logic

### Announcement
- [ ] Changelog: "Redesigned Agent Pods as DNA Digivolution Nexus with energy cores, flow particles, and hover stats"

---

## Notes

**Inspiration:**
- Digimon V-Pet energy transfer animations
- DNA Digivolution sequences from Digimon Adventure 02
- Digital World grid/matrix aesthetics
- Cyber Sleuth battle interface

**Future Enhancements:**
- Toggle between Nexus View and List View (Evolution Roster as alt mode)
- Agent avatar artwork inside cores
- Sound effects on activation/completion
- Evolution animation when agent levels up tier

---

**Created:** 2026-02-10
**Last Updated:** 2026-02-10
**Brief Owner:** Crimson (Fifty.ai)
