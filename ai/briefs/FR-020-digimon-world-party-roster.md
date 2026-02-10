# FR-020: Digimon World Party Roster — RPG Stats Redesign v2

**Type:** Feature Request
**Priority:** P2-Medium
**Effort:** L-Large (3-5d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** In Progress
**Created:** 2026-02-10

---

## Feature Description

**What is the proposed feature?**

Replace the current Persona 5 Confidant Cards (FR-019) party stats panel with a Digimon World: Next Order-inspired vertical party roster. Each agent is a horizontal row with a hex portrait frame on the left, inline stat bars (STR/INT/SPD/VIT), XP progress bar, telemetry data (runs, tokens, last used), and active status indicator. Tier 1 core agents get full-size rows with detailed stats; Tier 3-5 support agents get compact single-line rows.

**Why is this valuable?**

The Confidant Cards from FR-019 were too basic — rectangular cards with a flip mechanic felt like a styled web component, not a premium game screen. The Digimon World roster is the most fitting design for the project's identity (Igris AI IS a Digimon-themed system), provides high data density in a vertical format, and delivers strong RPG energy through hex portraits, inline stat bars, scan line textures, and active agent glow effects.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
FR-019 Confidant Cards are functional but too basic — simple rectangular cards with diagonal lines and a flip mechanic. No depth, no ambient animations, no premium game-screen feeling.

**With this feature:**
The party stats panel looks like a Digimon World party management screen with hex portraits, inline stat bars, tier grouping, active agent glow, and scan line textures. Fits the Igris AI Digimon identity perfectly.

---

## Technical Approach

### Visual Specification

**Full Tier 1 Agent Row:**
```
┌─── TIER 1: CORE AGENTS ──────────────────────────────────────────────────┐
│                                                                           │
│  ╔═══════╗                                                                │
│  ║  ┌─┐  ║   ARCHITECT          Blueprint Blue   T1   Champion            │
│  ║  │AR│  ║   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░ 72% XP     142 runs  │ 3m avg     │
│  ║  └─┘  ║   STR ██████░░  INT ████████░ SPD ████░░░░ VIT ██████░░      │
│  ║  ⌖    ║   12.4K tkn    │  last: 2m ago       ● IDLE                   │
│  ╚═══════╝                                                                │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│  ╔═══════╗                                                                │
│  ║  ┌─┐  ║   FORGER             Forge Orange    T1   Rookie               │
│  ║  │FO│  ║   ▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░ 38% XP     87 runs  │ 5m avg      │
│  ║  └─┘  ║   STR ████████░ INT ██████░░░ SPD ██░░░░░░ VIT ████████░      │
│  ║  ⚙    ║   45.2K tkn   │  last: 5m ago       ◉ ACTIVE  [0:42]         │
│  ╚═══════╝                                                                │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

**Compact Support Row:**
```
┌─── TIER 3-5: SUPPORT ────────────────────────────────────────────────────┐
│  ╔════╗                                                                   │
│  ║ ME ║  MENDER    T3  Rookie   ▓▓░░░░ 12%   14 runs   1.2K tkn  ● IDLE │
│  ╚════╝                                                                   │
│  ╔════╗                                                                   │
│  ║ SK ║  SEEKER    T4  In-Trn   ▓░░░░░  5%    8 runs   0.4K tkn  ● IDLE │
│  ╚════╝                                                                   │
│  ╔════╗                                                                   │
│  ║ SA ║  SAGE      T5  Rookie   ▓▓▓░░░ 22%   31 runs   3.8K tkn  ● IDLE │
│  ╚════╝                                                                   │
└───────────────────────────────────────────────────────────────────────────┘
```

**Party Summary Footer:**
```
┌── PARTY SUMMARY ─────────────────────────────────────────────────────────┐
│  Total Runs: 546    Total Tokens: 76.8K    Active: 1/7    Avg XP: 38%   │
└───────────────────────────────────────────────────────────────────────────┘
```

### Key Visual Elements

| Element | Specification |
|---------|---------------|
| Portrait frame | Hex clip-path (reuse `.nexus__hex-outer` style), crest watermark behind monogram. Agent crest color as border/glow. 72x62px for Tier 1, 48x42px for support. |
| XP bar | Full-width horizontal bar. Color shifts: crimson 0-50%, gold 50-90%, green 90-100%. Segmented chevron fill (10 segments). |
| Stat bars | Four inline horizontal bars (STR/INT/SPD/VIT). STR=`#FF1744`, INT=`#5AC8FA`, SPD=`#FFD600`, VIT=`#00E676`. 3px tall, 60px wide each. |
| Status indicator | Pulsing dot: idle=`--text-muted` (dim), active=agent-crest-color (bright pulse), complete=`--success` (green). |
| Tier dividers | Dashed line (`1px dashed var(--divider)`) separating tier groups. Tier labels: `font-size: 9px; letter-spacing: 2px; color: var(--text-muted)`. |
| Active agent row | Left border glow in agent color (`border-left: 3px solid var(--agent-color); box-shadow: -4px 0 12px var(--agent-color-dim)`). Timer counting up in mono font. Scan-line texture on row background. |
| Row background | `var(--surface-2)` with `1px solid var(--border)`. Active rows get agent-color tinted background at 3% opacity. |
| Scan lines | `repeating-linear-gradient` horizontal lines at 0.5px intervals over each row, mimicking CRT terminal. |
| Animations | Idle: none. Active: left-border pulses, status dot blinks, timer counts. Row hover: lifts with `translateY(-1px)`, border brightens. |

### Interactions

| Trigger | Behavior |
|---------|----------|
| Hover on row | Row lifts with `translateY(-1px)`, border brightens, stat bars glow. Tooltip shows full stat breakdown. |
| Click on row | Expands to show detailed stats (success rate, last 5 mission durations, token breakdown by type). |
| Tier group header click | Collapse/expand that tier group. |
| Active agent | Left border glows + pulses, scan line overlay, timer counting, status dot blinks. |
| Keyboard | Tab through rows, Enter/Space to expand, Escape to collapse. |

### Components Affected
- `dashboard/static/style.css` — Replace `.confidant-card` CSS with `.roster-row` system
- `dashboard/static/app.js` — Rewrite `renderPartyStats()` to generate roster rows
- `dashboard/static/index.html` — Minor container updates if needed

---

## Context & Inputs

### Dependencies
- No new packages needed
- Reuse existing hex clip-paths, crest colors, CSS variables
- Reuse existing `AGENT_TIERS`, `AGENT_COLORS`, `evolutionStars()`, `renderStars()` constants/helpers from FR-019

### Files to Modify
- `dashboard/static/style.css` — Replace confidant card CSS with roster CSS
- `dashboard/static/app.js` — Rewrite `renderPartyStats()`, update `_renderStatBar()`, update `_bindCardFlip()` to `_bindRowExpand()`

---

## Constraints

### Technical Constraints
- Must replace FR-019 Confidant Cards (remove that CSS/JS entirely)
- Must reuse existing CSS variables and color system
- Must reuse `AGENT_TIERS`, `AGENT_COLORS` constants from FR-019
- Must not break nexus web, sidebar, or other dashboard sections
- Vertical layout should work in the footer collapse/expand mechanism

### Out of Scope
- Agent drag-and-drop reordering
- Custom row themes per agent
- Mobile-specific responsive (desktop-first)

---

## Tasks

### Pending
- [ ] Task 1: Design CSS roster row component (hex portrait, name, tier badge, evolution, XP bar, stat bars, telemetry, status)
- [ ] Task 2: Design CSS expanded row state (detailed stats, token breakdown, mission history)
- [ ] Task 3: Design CSS compact support row variant
- [ ] Task 4: Design CSS tier group headers with collapse/expand
- [ ] Task 5: Design CSS active agent row state (left border glow, scan lines, timer)
- [ ] Task 6: Design CSS party summary footer strip
- [ ] Task 7: Rewrite `renderPartyStats()` in app.js to generate roster HTML
- [ ] Task 8: Implement row expand/collapse interaction (click + keyboard)
- [ ] Task 9: Implement tier group collapse/expand
- [ ] Task 10: Add accessibility (ARIA, keyboard nav, reduced motion)

### In Progress

### Completed

---

## Workflow State

**Phase:** COMMITTING
**Active Agent:** none
**Retry Count:** 0

### Current Work
WARDEN approved. Ready to commit.

### Next Steps
1. HUNT FR-020 to begin implementation
2. ARCHITECT plans component structure
3. FORGER replaces Confidant Cards with roster rows

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-10 | ARCHITECT | Planning phase complete | 5-phase plan: CSS cleanup, roster CSS, JS rewrite, HTML updates, integration |
| 2026-02-10 | — | Plan approved by Partner | Proceeding to BUILDING |
| 2026-02-10 | FORGER | Build complete | 3 files modified, roster system implemented, all confidant refs removed |
| 2026-02-10 | SENTINEL | Test phase complete | PASS — 7/7 checks, 48/48 CSS cross-refs, 0 leftover refs |
| 2026-02-10 | WARDEN | Code review complete | APPROVE — 0 blockers, 5 minor suggestions (defense-in-depth) |

### Blockers
None

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] 8 agent roster rows render in party stats section (5 Tier 1 full + 3 support compact)
2. [ ] Tier 1 rows show: hex portrait, name, tier badge, evolution, XP bar, 4 stat bars, runs, tokens, status
3. [ ] Support rows show: compact hex, name, tier, evolution, XP %, runs, tokens, status
4. [ ] Tier groups have collapsible headers ("TIER 1: CORE AGENTS", "TIER 3-5: SUPPORT")
5. [ ] Click on row expands to show detailed stats (success rate, token breakdown)
6. [ ] Active agent row has left border glow, scan line overlay, and live timer
7. [ ] Hover lifts row and brightens border in agent color
8. [ ] Party summary footer shows totals (runs, tokens, active count, avg XP)
9. [ ] Keyboard accessible (Tab, Enter/Space to expand, Escape to collapse)
10. [ ] `@media (prefers-reduced-motion: reduce)` disables animations
11. [ ] FR-019 Confidant Card CSS/JS fully removed and replaced
12. [ ] No regressions to nexus web or other dashboard sections

---

## Test Plan

### Functional Tests

**Test Case 1: Roster Rendering**
**Steps:**
1. Load dashboard with 8 agents configured
2. Expand party stats footer

**Expected Result:** 5 full Tier 1 rows + 3 compact support rows visible, grouped by tier
**Status:** [ ] Pass / [ ] Fail

**Test Case 2: Row Expand**
**Steps:**
1. Click on ARCHITECT row
2. Observe expansion animation
3. Verify detailed stats appear (success rate, token breakdown)
4. Click again to collapse

**Expected Result:** Smooth expand/collapse with correct data
**Status:** [ ] Pass / [ ] Fail

**Test Case 3: Active Agent Row**
**Steps:**
1. Trigger an agent run (e.g., FORGER active)
2. Observe FORGER row left border glow, scan lines, timer

**Expected Result:** Active row visually distinct with live timer
**Status:** [ ] Pass / [ ] Fail

**Test Case 4: Tier Group Collapse**
**Steps:**
1. Click "TIER 3-5: SUPPORT" header
2. Verify support rows collapse
3. Click again to expand

**Expected Result:** Tier group toggles visibility
**Status:** [ ] Pass / [ ] Fail

### Regression Tests
- [ ] Nexus web layout unaffected
- [ ] Digivice context window unaffected
- [ ] Token tracking dashboard unaffected
- [ ] Footer expand/collapse toggle still works
- [ ] No leftover Confidant Card CSS/JS references

---

## Delivery

### Code Changes
- [ ] Modified: `dashboard/static/style.css` (replace confidant card CSS with roster CSS)
- [ ] Modified: `dashboard/static/app.js` (rewrite renderPartyStats, replace interactions)

---

## Notes

**Inspiration:**
- Digimon World: Next Order party management screen
- Digimon Story: Cyber Sleuth team overview sidebar
- Military CRT diagnostic terminal aesthetic

**Why this over the other options:**
- Most fitting for Igris AI's Digimon identity
- Highest data density in a vertical format
- Easiest to scan all agents at a glance
- Vertical layout works best in the footer section
- Strong RPG energy without excessive complexity

**Replaces:** FR-019 (Persona 5 Confidant Cards)

---

**Created:** 2026-02-10
**Last Updated:** 2026-02-10
**Brief Owner:** Crimson (Igris AI)
