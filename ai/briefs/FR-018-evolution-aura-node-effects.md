# FR-018: Evolution Aura — Node Visual Effects

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

Overhaul the hexframe node visuals from flat gray outlines into living Evolution Aura nodes. Each agent gets a unique Digimon Crest-inspired color. Nodes feature layered aura rings emanating outward, orbiting particle dots, scan line texture, rotating gradient fill, periodic crest power-flashes, and an evolution pillar of light on active state.

**Why is this valuable?**

The current hexframe nodes are flat gray outlines with monogram text — they look clinical, not Digimon. This overhaul adds per-agent color identity, layered energy effects, and dramatic state transitions that capture the Digivolution aesthetic.

---

## Visual Spec

### Per-Agent Colors

| Agent | Color | Hex | Dim (8% opacity) |
|-------|-------|-----|-------------------|
| IGRIS (orchestrator) | Hot Crimson | #FF1744 | rgba(255,23,68,0.08) |
| ARCHITECT | Blueprint Blue | #448AFF | rgba(68,138,255,0.08) |
| FORGER | Forge Orange | #FF6D00 | rgba(255,109,0,0.08) |
| SENTINEL | Guard Green | #00E676 | rgba(0,230,118,0.08) |
| WARDEN | Watcher Purple | #7C4DFF | rgba(124,77,255,0.08) |
| MENDER | Heal Teal | #00BFA5 | rgba(0,191,165,0.08) |
| SEEKER | Radar Yellow | #FFD600 | rgba(255,214,0,0.08) |
| SAGE | Wisdom Magenta | #E040FB | rgba(224,64,251,0.08) |

### Effects Per Node

1. **Aura rings** (2 spans) — hexagonal outlines at 115% and 130% scale, agent-colored, breathing animation with offset phases
2. **Particle ring** (1 span) — 8 orbiting dots via box-shadow, rotating wrapper
3. **Scan lines** — ::before on hex-inner with repeating-linear-gradient, scrolling upward
4. **Rotating gradient fill** — inside hex-inner via @property --aura-angle
5. **Crest power flash** — periodic opacity spike (5% -> 50% -> 5%) every 5s
6. **Evolution pillar** (active only) — thin vertical gradient line above hex
7. **Monogram glow** — text-shadow in agent-color

### State Expressions

| State | Aura Rings | Particles | Scan Lines | Gradient | Crest | Pillar | Glow |
|-------|-----------|-----------|------------|----------|-------|--------|------|
| Idle | Hidden | Hidden | Hidden | Off (solid dark) | 5% opacity | Hidden | None |
| Has-Data | Ring 1 at 15% | Hidden | Faint (3%) | Off | 10% + flash | Hidden | Subtle |
| Active | Ring 1+2 breathing | Orbiting | Bright (8%) | Rotating | 45% + flash | Visible | Strong drop-shadow |
| Complete | Burst outward + fade | Explode | Freeze | Flash white | Flash white->green | Flash bright | Green glow |

---

## Files to Modify

- `dashboard/static/index.html` — Add 2 aura ring spans + 1 particle wrapper per node (x8)
- `dashboard/static/style.css` — Per-agent colors, aura ring styles, particle orbit, scan lines, rotating gradient, pillar, state overhauls
- `dashboard/static/app.js` — Minor: no major changes (CSS handles via state classes + attribute selectors)

---

## Tasks

### Pending
- [ ] Task 1: Add per-agent color CSS custom properties via [data-agent] selectors
- [ ] Task 2: Add aura ring + particle HTML elements to all 8 nodes
- [ ] Task 3: Style aura rings (hex clip-path, agent-colored, breathing animation)
- [ ] Task 4: Style particle orbit (box-shadow dots, rotating wrapper)
- [ ] Task 5: Add scan line texture to hex-inner
- [ ] Task 6: Add rotating gradient fill (@property --aura-angle)
- [ ] Task 7: Crest power-flash animation + monogram glow
- [ ] Task 8: Evolution pillar (active state)
- [ ] Task 9: Overhaul state expressions (idle/has-data/active/complete)
- [ ] Task 10: Bump cache version

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
HUNT complete.

### Next Steps
Archive FR-018.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-10 | FORGER | CSS+HTML implementation | Per-agent colors, aura rings, particles, scan lines, pillar, state overhauls |
| 2026-02-10 | SENTINEL | Validation | PASS — 8/8 checks green |
| 2026-02-10 | WARDEN | Code review | APPROVE — 0 critical, 0 major, all 10 AC met |

### Blockers
None

---

## Acceptance Criteria

1. [ ] Each of the 8 agents has a unique color (not all gray/crimson)
2. [ ] Has-data/active nodes show aura rings emanating outward
3. [ ] Active nodes have orbiting particle dots
4. [ ] Scan line texture visible inside hex on has-data/active states
5. [ ] Crest periodically flashes brighter (power surge effect)
6. [ ] Active state shows evolution pillar of light above node
7. [ ] Monogram text glows in agent color with text-shadow
8. [ ] Complete state has burst animation (rings expand outward + fade)
9. [ ] Idle state is clean and minimal (no visual noise)
10. [ ] No regressions to nexus layout, connection lines, or other sections

---

**Created:** 2026-02-10
**Last Updated:** 2026-02-10
**Brief Owner:** Crimson (Fifty.ai)
