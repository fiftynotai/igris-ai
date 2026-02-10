# FR-017: Crest Hexframe — Agent Node Redesign

**Type:** Feature Request
**Priority:** P2-Medium
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-10

---

## Feature Description

**What is the proposed feature?**

Redesign each agent core node in the DNA Digivolution Nexus from plain circles with monogram text into hexagonal tech-frames with 6 independently-lit edge segments for XP visualization, corner diamond accents, and unique ghosted crest watermarks per agent. The nexus grid layout, connection lines, and particle flow remain unchanged — only the individual node shape and visual treatment changes.

**Why is this valuable?**

The current circle+monogram nodes feel too minimal for the Digimon aesthetic. Hexagonal nodes on the hexagonal grid background create visual harmony. The 6-segment edge lighting gives richer XP visualization than a conic-gradient ring. Unique crest watermarks give each agent distinct identity at a glance.

---

## Visual Spec

### Node Structure

Each node becomes a hexagon (flat-top orientation) with:
- **6 edge segments** — independently lit based on XP (each ~16.6%)
- **Corner diamonds** — 6 small diamond accents at hex vertices, pulse when active
- **Crest watermark** — unique faint background glyph per agent (3-12% opacity)
- **Monogram** — bold 2-letter code centered
- **Agent name** — below the hexagon
- **Evolution stage** — below the name

### Crest Assignments

| Agent | Crest Symbol | Unicode/Glyph |
|-------|-------------|---------------|
| IGRIS (orchestrator) | Crown / Command | ⬡ or ♛ |
| ARCHITECT | Compass / Blueprint | ⌖ or ◎ |
| FORGER | Hammer / Anvil | ⚒ or ⚙ |
| SENTINEL | Shield / Guard | ⛊ or ◈ |
| WARDEN | Eye / Lock | ◉ or ⊙ |
| MENDER | Wrench / Heal | ⚕ or ✦ |
| SEEKER | Magnifier / Radar | ⊕ or ◎ |
| SAGE | Scroll / Wisdom | ☯ or ✧ |

### Tier Sizing

| Tier | Hex Width | Edge Thickness | Corner Size |
|------|-----------|----------------|-------------|
| Orchestrator | 100px | 3px | 6px diamonds |
| Core (ARCH/FORG/SENT/WARD) | 76px | 2px | 4px diamonds |
| Support (MEND/SEEK/SAGE) | 56px | 1px | 2px dots |

### State Expression

| State | Edges | Corners | Crest | Monogram | Background |
|-------|-------|---------|-------|----------|------------|
| Idle | All dim (`--border`) | Barely visible | 3% opacity | Dim gray | Transparent |
| Has-Data | Lit edges based on XP (white) | Visible | 6% opacity | White | `rgba(255,255,255,0.02)` |
| Active | Lit edges crimson + glow | Pulsing crimson | 12% crimson tint | Crimson glow + text-shadow | `rgba(150,14,41,0.08)` + sweep animation |
| Complete | All edges green flash | Green | 15% green pulse | Green | Green flash then settle |

---

## Technical Approach

### CSS Techniques

- **Hex shape:** `clip-path: polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)` on inner content area
- **Edge segments:** Layered approach — outer hex (slightly larger) with `conic-gradient` for segment coloring, inner hex (clipped smaller) for content. JS sets `--xp-deg` CSS variable to control fill.
- **Corner diamonds:** 6 small `span.nexus__vertex` elements positioned at hex vertices via `transform: rotate(N*60deg) translateY(-radius)`
- **Crest watermark:** `::before` pseudo-element with large Unicode character, `font-size: 40px`, low opacity, centered
- **Data flow sweep (active):** `::after` with sweeping `linear-gradient` animation

### HTML Changes

Replace each `.nexus__core` internals. Instead of `nexus__ring` + `nexus__inner`, use:
```html
<div class="nexus__core" data-agent="architect">
  <div class="nexus__hex-outer"></div>        <!-- edge segments via conic-gradient -->
  <div class="nexus__hex-inner">              <!-- clipped hex content -->
    <div class="nexus__crest">◎</div>         <!-- watermark glyph -->
    <div class="nexus__monogram">AR</div>     <!-- bold monogram -->
  </div>
  <div class="nexus__vertex"></div>           <!-- x6 corner diamonds -->
  <div class="nexus__vertex"></div>
  <div class="nexus__vertex"></div>
  <div class="nexus__vertex"></div>
  <div class="nexus__vertex"></div>
  <div class="nexus__vertex"></div>
  <div class="nexus__label">
    <span class="nexus__name">ARCHITECT</span>
    <span class="nexus__evo" id="evo-architect">In-Training</span>
    <span class="nexus__stats mono" id="inv-architect">0 runs</span>
  </div>
  <div class="nexus__timer mono" id="timer-architect"></div>
  <span class="nexus__hidden" id="level-architect"></span>
  <span class="nexus__hidden" id="xp-architect"></span>
  <span class="nexus__hidden" id="last-architect"></span>
</div>
```

### JS Changes

- Update `_renderSinglePod` to set `--xp-deg` CSS variable on `nexus__hex-outer` instead of updating `xp-ring` conic-gradient directly
- Update state class logic (same class names, just different visual treatment)
- Remove references to `xp-ring-{agent}` IDs, use `nexus__hex-outer` within the pod

---

## Files to Modify

- `dashboard/static/index.html` — Replace inner structure of each nexus core
- `dashboard/static/style.css` — Replace `.nexus__ring`/`.nexus__inner` with hexframe classes
- `dashboard/static/app.js` — Update `_renderSinglePod` for hex-outer XP and crest rendering

---

## Tasks

### Pending
- [ ] Task 1: Design hex-outer conic-gradient segment system (CSS)
- [ ] Task 2: Build hexframe HTML structure for all 8 agents
- [ ] Task 3: Position 6 corner vertex diamonds per node (CSS)
- [ ] Task 4: Implement crest watermark system with unique glyphs
- [ ] Task 5: Update state classes for hexframe visuals (idle/active/complete/has-data)
- [ ] Task 6: Add data-flow sweep animation for active state
- [ ] Task 7: Wire JS to set --xp-deg and update hexframe elements
- [ ] Task 8: Handle tier sizing (orchestrator/core/support)
- [ ] Task 9: Update responsive breakpoints

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
HUNT complete. Committed `b422851`.

### Next Steps
Archive FR-017.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-10 | ARCHITECT | Planning FR-017 | Plan complete — 4 phases, 3 files, hex-outer/inner/crest/vertex system |
| 2026-02-10 | FORGER | Phase 1: CSS+HTML | Hexframe classes added, all 8 cores restructured, 4 new keyframes |
| 2026-02-10 | FORGER | Phase 2: JavaScript | XP via --xp-deg, orbit insertion → hex-frame, complete state → 360deg |
| 2026-02-10 | SENTINEL | Validation | PASS — HTML, CSS, JS, cache version, server startup all green |
| 2026-02-10 | WARDEN | Code review | APPROVE — 0 critical, 0 major, 8 minor suggestions |

### Blockers
None

---

## Acceptance Criteria

1. [ ] All 8 agent nodes rendered as hexagonal frames (not circles)
2. [ ] 6 edge segments per node, independently lit based on XP percentage
3. [ ] Corner diamond accents at all 6 vertices
4. [ ] Unique crest watermark visible (faint) on each agent
5. [ ] Active state: crimson edge glow, pulsing corners, sweep animation
6. [ ] Complete state: green flash on edges and corners
7. [ ] Orchestrator node visibly larger with thicker edges
8. [ ] Support nodes visibly smaller with thinner edges
9. [ ] Connection lines still connect correctly to hex nodes
10. [ ] No regressions to nexus layout, particle flow, or other dashboard sections

---

**Created:** 2026-02-10
**Last Updated:** 2026-02-10
**Brief Owner:** Crimson (Fifty.ai)
