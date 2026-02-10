# FR-019: Persona 5 Confidant Cards -- RPG Party Stats Redesign

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

Redesign the RPG Party Stats panel in the Igris AI dashboard using a Persona 5-inspired Confidant Cards carousel. Each of the 7 agents becomes a tarot-style card with diagonal slash lines, rank stars (evolution mapped to 0-4 stars), and a 3D card-flip mechanic to reveal detailed stats on the back.

**Why is this valuable?**

The current party stats panel reads like a flat database table. This redesign transforms it into a visually striking RPG party screen that reinforces the Digimon/game identity of Igris AI, making agent management feel like a game experience rather than a corporate dashboard.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
The party stats footer uses basic `.char-card` grid cards with `.stat-badge` components. It's functional but flat, visually generic, and doesn't match the RPG energy of the nexus web above it.

**With this feature:**
Agent stats become visually immersive Persona 5-style Confidant cards with diagonal slash aesthetics, star-based evolution ranking, and satisfying 3D flip interactions. The dashboard feels like a cohesive RPG experience from top to bottom.

---

## Use Cases

### Use Case 1: Scanning Party Status at a Glance
**Actor:** Developer using Igris AI dashboard
**Goal:** Quickly assess all 7 agents' status, XP, and evolution
**Steps:**
1. Open dashboard, scroll to party stats section
2. See all 7 agent cards in a horizontal layout (4 Tier 1 + 3 support)
3. Identify active agents by elevated card + pulsing glow
4. Read rank stars for evolution level, XP bar for progress

**Expected Outcome:** All agent statuses visible in under 3 seconds

### Use Case 2: Inspecting Agent Details
**Actor:** Developer checking a specific agent's performance
**Goal:** See detailed RPG stats, mission history, and token usage
**Steps:**
1. Click on an agent's Confidant card
2. Card flips with 3D CSS transform to reveal stat back
3. View STR/INT/SPD/VIT bars, mission count, success rate, token breakdown
4. Click again or press Escape to flip back

**Expected Outcome:** Full agent detail revealed with satisfying flip animation

---

## Technical Approach

### High-Level Design
Replace the existing `.char-card` grid in the dashboard footer with a Persona 5-themed Confidant Cards layout. Tier 1 agents get full-size cards (140x220px), support agents get compact cards (100x150px). Each card has a front face (summary) and back face (detailed stats) connected via CSS 3D perspective transforms.

### Components Affected
- `dashboard/static/style.css`: Replace `.char-card` / `.party-stats` styles with new Confidant card system
- `dashboard/static/index.html`: Update footer party stats HTML structure
- `dashboard/static/app.js`: Update `renderPartyStats()` and `_renderStatBadge()` to render new card format with flip interaction

### Visual Specification

**Card Front:**
```
 ┌──────────┐
 │ ///////  │  ← Diagonal slash lines (agent color, repeating-linear-gradient -45deg)
 │ //┌────┐ │
 │ //│ AR │ │  ← Hex frame with monogram + crest watermark
 │ //└────┘ │
 │ ///////  │
 │          │
 │ ARCHITECT│  ← Agent name (agent crest color, 14px bold, letter-spacing 1.5px)
 │  ★★★☆   │  ← Rank stars (evolution: In-Training=0, Rookie=1, Champion=2, Ultimate=3, Mega=4)
 │ T1  72%  │  ← Tier badge + XP percentage
 │ ████████ │  ← XP bar (agent color gradient)
 │ ▓▓▓▓▓▓░░ │  ← Token usage bar (crimson)
 │ 142 runs │  ← Mission count
 │ 12.4K tk │  ← Token total
 └──────────┘
```

**Card Back (on flip):**
```
 ┌──────────────────────────────┐
 │         ARCHITECT            │
 │  Tier 1  │  Champion         │
 │                              │
 │  STR ████████░░  76          │  ← Stat bars (color-coded)
 │  INT ██████░░░░  58          │
 │  SPD ██░░░░░░░░  22          │
 │  VIT ████████░░  78          │
 │                              │
 │  Missions: 142 (96% pass)   │
 │  Tokens:   12.4K total      │
 │  Avg Time: 3m 08s           │
 │  Last:     2m ago           │
 └──────────────────────────────┘
```

**Active Agent Card:**
- Elevated: `transform: translateY(-8px)`
- Glow: `box-shadow: 0 8px 24px var(--agent-color-dim)`
- Diagonal lines animate (background-position shift)
- Pulsing "ACTIVE" badge
- Timer overlay

---

## Context & Inputs

### Dependencies
- No new packages needed
- Existing CSS 3D transforms (perspective, rotateY)
- Existing agent crest colors and hex frame components

### Files to Modify
- `dashboard/static/style.css` — Replace party stats CSS (~lines 777-975)
- `dashboard/static/index.html` — Update footer party stats section (~lines 411-422)
- `dashboard/static/app.js` — Update `renderPartyStats()` (~lines 1140-1204) and `_renderStatBadge()` (~lines 1213-1221)

---

## Alternatives Considered

### Alternative A: Digimon World -- Party Roster Sidebar
**Pros:**
- Easiest to implement
- Best for vertical/narrow layouts

**Cons:**
- Lower visual impact
- Less RPG wow factor

**Why not chosen:** Too close to a styled list. Doesn't deliver the game-screen experience.

### Alternative C: Final Fantasy -- Tactical Formation Grid
**Pros:**
- Strong hierarchy visualization (commander -> front line -> support)
- Tactical grid background looks great

**Cons:**
- Needs more horizontal space
- Less interactive

**Why not chosen:** Good hierarchy but less visual personality than Persona cards.

### Alternative D: Pokemon -- Status Grid
**Pros:**
- Highest data density
- Most practical for quick scanning

**Cons:**
- More "dashboard" than "game screen"
- Less visual flair

**Why not chosen:** Best balance of data/practicality but the user wants maximum RPG vibes.

---

## Constraints

### Technical Constraints
- Must use existing CSS variables and color system
- Must reuse existing hex frame and crest color definitions
- 3D card flip requires CSS `perspective` and `backface-visibility`
- Must not break existing nexus web layout above

### UX Constraints
- All 7 agents visible without scrolling on desktop (1280px+)
- Card flip animation must be smooth (use `transform` not layout shifts)
- Active agent card should NOT flip while agent is running
- Support cards (Tier 3-5) are compact but still flippable

### Out of Scope
- Agent drag-and-drop reordering
- Custom card skins/themes per agent
- Mobile-specific carousel behavior (desktop-first)

---

## Tasks

### Pending

### In Progress

### Completed
- [x] Task 1: Design CSS card component (front face with diagonal slashes, hex frame, rank stars, XP bars)
- [x] Task 2: Design CSS card back (stat bars, mission details, token breakdown)
- [x] Task 3: Implement 3D flip animation (perspective, rotateY, backface-visibility)
- [x] Task 4: Update `renderPartyStats()` in app.js to generate new card HTML
- [x] Task 5: Implement active agent state (elevation, glow, pulse, timer)
- [x] Task 6: Implement hover interactions (lift, border glow, diagonal line animation)
- [x] Task 7: Add support card compact variant (100x150px)
- [x] Task 8: Test across viewport sizes (1280px, 1440px, 1920px)
- [x] Task 9: Add accessibility (ARIA roles, keyboard nav, reduced motion)

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Current Work
SENTINEL testing implementation. WARDEN reviewing code quality.

### Next Steps
1. SENTINEL delivers test results
2. WARDEN delivers review
3. Commit if both pass

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-10 | ARCHITECT | Planning — analyze existing code, design component structure | Complete — 9-phase plan, 3 files, full CSS/JS/HTML spec |
| 2026-02-10 | FORGER | Building — implement Confidant cards (CSS + JS + HTML) | Complete — 2 files modified, ~200 lines CSS + ~180 lines JS |
| 2026-02-10 | SENTINEL | Testing — verify implementation correctness | PASS — all checks green, 38 CSS cross-refs verified, 0 regressions |
| 2026-02-10 | WARDEN | Reviewing — code quality inspection | APPROVE — 2 minor nits (unused var, unescaped numeric value) |
| 2026-02-10 | ORCHESTRATOR | Commit — fix nits + commit | Complete — `3b458ed` |

### Blockers
None

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] 7 agent Confidant cards render in party stats section (4 Tier 1 large + 3 support compact)
2. [ ] Cards display diagonal slash lines in agent crest color
3. [ ] Rank stars reflect evolution level (0-4 stars)
4. [ ] XP bar and token bar display on card front
5. [ ] Click flips card with 3D CSS transform to reveal detailed stat back
6. [ ] Active agent card is elevated with glow and pulse animation
7. [ ] Hover lifts card and brightens border in agent color
8. [ ] Keyboard accessible (Tab, Enter/Space to flip, Escape to close)
9. [ ] `@media (prefers-reduced-motion: reduce)` disables animations
10. [ ] No regressions to nexus web or other dashboard sections

---

## Test Plan

### Functional Tests
**Test Case 1: Card Rendering**
**Steps:**
1. Load dashboard with 7 agents configured
2. Scroll to party stats section

**Expected Result:** 4 large Tier 1 cards + 3 compact support cards visible
**Status:** [ ] Pass / [ ] Fail

**Test Case 2: Card Flip**
**Steps:**
1. Click on ARCHITECT card
2. Observe flip animation
3. Verify back shows STR/INT/SPD/VIT stats
4. Click again to flip back

**Expected Result:** Smooth 3D flip with correct data on both sides
**Status:** [ ] Pass / [ ] Fail

**Test Case 3: Active Agent State**
**Steps:**
1. Trigger an agent run (e.g., FORGER active)
2. Observe FORGER card elevation, glow, timer

**Expected Result:** Active card elevated with pulsing glow, click does NOT flip
**Status:** [ ] Pass / [ ] Fail

### Regression Tests
- [ ] Nexus web layout unaffected
- [ ] Digivice context window unaffected
- [ ] Token tracking dashboard unaffected
- [ ] Footer collapse/expand still works

---

## Delivery

### Code Changes
- [ ] Modified: `dashboard/static/style.css`
- [ ] Modified: `dashboard/static/index.html`
- [ ] Modified: `dashboard/static/app.js`

---

## Notes

**Inspiration:**
- Persona 5 Royal Confidant arcana cards
- Persona 5 character stat screens (diagonal lines, red/black contrast)
- Digimon evolution star ranking system

**Future Enhancements:**
- Card unlock animations when agents first Digivolve
- Custom card art/skins per agent
- Mobile carousel with swipe gestures
- Sound effects on flip (optional toggle)

---

**Created:** 2026-02-10
**Last Updated:** 2026-02-10
**Brief Owner:** Crimson (Igris AI)
