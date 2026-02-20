# FR-060: Crimson Arena — Skill Cards Widget (RPG Game Card Style)

**Type:** Feature
**Priority:** P1-High
**Effort:** M-Medium (2-3d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-19
**Completed:** 2026-02-19

---

## Problem

**What's broken or missing?**

The Crimson Arena dashboard currently displays skills as a plain horizontal bar chart (SkillHeatmapWidget) — just skill names and invocation counts. This doesn't match the RPG/Digimon world aesthetic the dashboard is built around, where agents are Digimon characters with monograms, crests, tiers, and color identities.

Skills deserve the same treatment — they should be presented as **collectible game cards** (like Digimon skill cards or Pathfinder ability cards) that you "equip" to your agents. The current heatmap is functional but visually dead compared to the rest of the dashboard's game-inspired design.

**Reference:** The agent card aesthetic follows a Pathfinder 2E character card style — ornate borders, stat blocks, badges, and RPG iconography (see attached design reference).

---

## Goal

**What should happen after this brief is completed?**

A new **SKILLS page** (or prominent section) in Crimson Arena displays all 22 skills as visually rich RPG-style game cards:

1. **Each skill has its own card** — ornate card frame, skill name, category badge, usage stats, description, and associated agents
2. **Cards have rarity tiers** based on usage frequency — Common, Rare, Epic, Legendary (matching the existing `rarity_theme.dart` system)
3. **Cards show live data** — invocation count, last used timestamp, success rate if available
4. **Category badges** — Combat (hunt, team), Utility (scan, sync, awaken, rest), Support (register, archive, document), Management (digivolve, projects, portfolio, dashboard), Research (ideate, audit, migrate-analyze, standardize), Creative (higgsfield, ui-design, fifty-kit), System (release)
5. **Card interactions** — Tap to expand with full description, usage history sparkline, and which agents the skill invokes
6. **Grid/masonry layout** — Cards arranged in a responsive grid, filterable by category
7. **Visual consistency** — Cards use the same FDL design tokens (FiftySpacing, FiftyRadii, ArenaColors, ArenaTextStyles.mono) and game-themed visual language as the rest of Crimson Arena

---

## Context & Inputs

### Affected Modules
- [ ] Dashboard Frontend (new SKILLS page + SkillCard widget)
- [ ] Dashboard Frontend (navigation — add SKILLS to sidebar/nav)
- [ ] Dashboard Frontend (skill data model + constants)

### Layers Touched
- [ ] Presentation (new page, new widget, new constants)
- [ ] Business Logic (SkillsViewModel — data aggregation)

### API Changes
- None — uses existing `/api/skills` endpoint and skill heatmap data

### Dependencies
- Existing: `BrainApiService.getSkillHeatmap()` — returns `{skills: {name: count}, total: N}`
- Existing: `BrainWebSocketService.skillEvent` — real-time skill invocation stream
- Existing: `HomeViewModel.skillHeatmap` RxMap + `skillHeatmapTotal` RxInt
- Existing: `rarity_theme.dart` — rarity tiers (Common, Uncommon, Rare, Epic, Legendary)
- Existing: `agent_constants.dart` — agent colors, monograms, tiers, crests

### Reference Design
- **Agent card style:** Pathfinder 2E character card (ornate borders, stat blocks, badges)
- **Skill card adaptation:** Smaller than agent cards, focused on ability/spell card aesthetics
- **Color scheme:** Dark card background with category-colored accents and gold trim
- **Typography:** ArenaTextStyles.mono for stats, FDL text styles for titles

### Skill Registry (22 skills)

| Skill | Category | Description | Agents Invoked |
|-------|----------|-------------|----------------|
| hunt | Combat | Implement brief (full workflow) | architect, forger, sentinel, warden, mender |
| team | Combat | Parallel execution (Agent Teams) | multiple teammates |
| scan | Utility | System status report | none (orchestrator) |
| sync | Utility | VPS brain deployment | none (orchestrator) |
| awaken | Utility | Start/resume session | none (orchestrator) |
| rest | Utility | Pause/end session | none (orchestrator) |
| register | Support | Create new brief | none (orchestrator) |
| archive | Support | Archive completed brief | none (orchestrator) |
| document | Support | Documentation workflow | orchestrator-level skill |
| digivolve | Management | Agent management | none (orchestrator) |
| projects | Management | List brain-registered projects | none (orchestrator) |
| portfolio | Management | Cross-project dashboard | none (orchestrator) |
| dashboard | Management | Cross-project brief tracker | none (orchestrator) |
| ideate | Research | Feature brainstorming | none (orchestrator) |
| audit | Research | Codebase quality audit | warden (audit mode) |
| migrate-analyze | Research | Migration analysis | none (orchestrator) |
| standardize | Research | Generate coding guidelines | none (orchestrator) |
| higgsfield | Creative | Media generation | none (browser automation) |
| ui-design | Creative | UI design guidelines | none (orchestrator) |
| fifty-kit | Creative | FDL/Fifty kit reference | none (orchestrator) |
| release | System | Release preparation | none (orchestrator) |
| keybindings-help | System | Keyboard shortcut config | none (orchestrator) |

### Card Design Anatomy

```
+------------------------------------------+
|  [ornate top border / gold trim]         |
|                                          |
|  [CATEGORY BADGE]        [RARITY GEM]   |
|                                          |
|        [SKILL ICON / EMBLEM]             |
|                                          |
|          SKILL NAME                      |
|     "Short description line"             |
|                                          |
|  ----------------------------------------|
|  INVOCATIONS: 47    LAST: 2h ago         |
|  [======== usage bar ========]           |
|  ----------------------------------------|
|  AGENTS: AR  FO  SE  WA  (monograms)    |
+------------------------------------------+
```

---

## Constraints

### Architecture Rules
- Must follow MVVM + GetX pattern (ViewModel + reactive state)
- Must use FDL design tokens exclusively (FiftySpacing, FiftyRadii, FiftyTypography, FiftyMotion)
- Must use ArenaColors and ArenaTextStyles for game-themed elements
- Card animations must use FiftyMotion constants
- Must respect rarity_theme.dart tier system for card borders/accents

### Technical Constraints
- Flutter Web (Dart) — no native platform dependencies
- No new packages — use existing Flutter + FDL + fifty_ui
- Cards must be responsive (work on both wide and narrow layouts)
- No external image assets for card frames — build with Flutter BoxDecoration, gradients, borders
- Skill data comes from existing API — no backend changes

### Visual Constraints
- Card style must evoke RPG/collectible card game aesthetic
- Must feel like it belongs in the same world as agent monograms, crests, and battle log
- Dark theme with gold/crimson accents (matching Crimson Arena palette)
- Category colors should be distinct but harmonious
- Rarity borders: Common=gray, Uncommon=green, Rare=blue, Epic=purple, Legendary=gold (from rarity_theme.dart)

### Out of Scope
- Agent cards (separate brief — different layout, more complex)
- Skill equipping/assignment UI (future — drag skills onto agent cards)
- Skill creation/editing from dashboard
- 3D card flip animations (keep it performant)
- Backend skill metadata API (use what exists + hardcoded skill registry)

---

## Tasks

### Phase 1: Skill Data Model & Constants

- [ ] Task 1: Create `skill_constants.dart` with skill registry (name, category, description, icon, agents, rarity tier)
- [ ] Task 2: Create `skill_card_model.dart` merging static metadata with live usage data
- [ ] Task 3: Define category color map and category icon map

### Phase 2: SkillCard Widget

- [ ] Task 4: Create `skill_card_widget.dart` — the individual RPG card widget
- [ ] Task 5: Implement ornate card frame with BoxDecoration (gradient border, rounded corners, inner shadow)
- [ ] Task 6: Category badge (top-left) with category color and icon
- [ ] Task 7: Rarity indicator (top-right) — gem/border glow based on usage tier
- [ ] Task 8: Skill name title with game typography (ArenaTextStyles.mono, bold, letter-spacing)
- [ ] Task 9: Usage stats row (invocation count, last used relative time)
- [ ] Task 10: Agent monogram row (show which agents the skill invokes, using AgentConstants colors)
- [ ] Task 11: Card hover/tap interaction — subtle glow or scale animation

### Phase 3: Skills Page

- [ ] Task 12: Create `skills_page.dart` with responsive grid layout
- [ ] Task 13: Create `skills_view_model.dart` (extends existing skill heatmap data)
- [ ] Task 14: Category filter bar (horizontal chips — All, Combat, Utility, Support, etc.)
- [ ] Task 15: Sort options (by usage, alphabetical, rarity)
- [ ] Task 16: Add SKILLS to navigation (sidebar or tab bar alongside HOME, INSTANCES, BRIEFS)

### Phase 4: Integration & Polish

- [ ] Task 17: Wire SkillCard to live data (usage count from skillHeatmap, WebSocket updates)
- [ ] Task 18: Card entrance animation (staggered fade-in on page load)
- [ ] Task 19: Replace or complement SkillHeatmapWidget on HOME with top 5 skill cards preview
- [ ] Task 20: Responsive layout — 4 columns wide, 2 columns narrow, 1 column mobile

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] SKILLS page exists in Crimson Arena navigation
2. [ ] All 22 skills displayed as individual RPG-style game cards
3. [ ] Cards show: skill name, category badge, rarity tier, usage count, last used, agent monograms
4. [ ] Cards have ornate game-style visual treatment (borders, gradients, category colors)
5. [ ] Category filter works (All, Combat, Utility, Support, Management, Research, Creative, System)
6. [ ] Rarity tiers assigned based on usage frequency (Common < 10, Rare < 50, Epic < 100, Legendary 100+)
7. [ ] Cards update in real-time via WebSocket skill events
8. [ ] Responsive grid layout works on wide and narrow screens
9. [ ] Visual style consistent with Crimson Arena's RPG/Digimon theme
10. [ ] Linter/analyzer passes (zero issues)
11. [ ] Existing HOME page skill heatmap still functional (or replaced by card preview)

---

## Test Plan

### Manual Test Cases

#### Test Case 1: Skills Page Display
**Preconditions:** Dashboard running, skill data available
**Steps:**
1. Navigate to SKILLS page
2. Verify all 22 skill cards are visible

**Expected Result:**
- Each card shows skill name, category badge, usage count
- Cards arranged in responsive grid
- Ornate card borders with category-colored accents

#### Test Case 2: Category Filtering
**Steps:**
1. Click "Combat" filter chip
2. Verify only hunt and team cards shown
3. Click "All" to reset

**Expected Result:**
- Filter correctly shows/hides cards by category
- Smooth transition animation

#### Test Case 3: Live Updates
**Steps:**
1. Keep SKILLS page open
2. Run `/scan` in a Claude Code session
3. Check the "scan" card

**Expected Result:**
- Scan card's invocation count increments
- Last used timestamp updates

#### Test Case 4: Responsive Layout
**Steps:**
1. Resize browser window from wide to narrow

**Expected Result:**
- Grid adapts: 4 columns → 2 columns → 1 column
- Cards maintain aspect ratio and readability

### Regression Checklist
- [ ] HOME page still renders correctly
- [ ] Existing SkillHeatmapWidget still works (if kept)
- [ ] Navigation between pages works
- [ ] WebSocket connection stable
- [ ] Dashboard loads in < 2 seconds

---

## Delivery

### Code Changes
- [ ] `dashboard/crimson-arena/lib/core/constants/skill_constants.dart` — NEW: Skill registry
- [ ] `dashboard/crimson-arena/lib/data/models/skill_card_model.dart` — NEW: Card data model
- [ ] `dashboard/crimson-arena/lib/features/skills/views/skills_page.dart` — NEW: Skills page
- [ ] `dashboard/crimson-arena/lib/features/skills/views/widgets/skill_card_widget.dart` — NEW: Card widget
- [ ] `dashboard/crimson-arena/lib/features/skills/controllers/skills_view_model.dart` — NEW: ViewModel
- [ ] `dashboard/crimson-arena/lib/app/routes/` — Modified: Add skills route
- [ ] `dashboard/crimson-arena/lib/app/navigation/` — Modified: Add skills to nav

### Database Migrations
- None

### Documentation Updates
- [ ] README: Add skills page description

### Deployment Notes
- Flutter Web only — build locally, SCP to VPS
- No backend changes needed

---

## Notes

### Design Philosophy

The Crimson Arena is building a Digimon-world aesthetic where:
- **Agents** = Digimon characters (monograms, crests, tiers, color identities)
- **Skills** = Ability cards / spell cards (equippable, collectible, categorized)
- **Briefs** = Quests / missions
- **Hunt workflow** = Battle sequence (PLANNING → BUILDING → TESTING → REVIEWING)

Skill cards are the next piece of this world-building. They should feel like something you'd collect and equip — not just a data visualization.

### Rarity Tier Assignment

Based on cumulative usage (from skill heatmap data):
- **Common** (gray border): 0-9 invocations
- **Uncommon** (green border): 10-24 invocations
- **Rare** (blue border): 25-49 invocations
- **Epic** (purple border): 50-99 invocations
- **Legendary** (gold border): 100+ invocations

This means frequently-used skills like `hunt` and `scan` naturally become Legendary over time, while niche skills like `higgsfield` or `release` stay Common until used more.

### Category Color Map (Suggested)

| Category | Color | Rationale |
|----------|-------|-----------|
| Combat | Crimson/Red | Offensive, action-oriented |
| Utility | Cyan/Teal | Tools, maintenance |
| Support | Green | Helping, organizing |
| Management | Purple | Leadership, oversight |
| Research | Gold/Amber | Knowledge, discovery |
| Creative | Magenta/Pink | Art, design |
| System | Silver/Gray | Infrastructure |

---

**Created:** 2026-02-19
**Last Updated:** 2026-02-19
**Brief Owner:** Crimson

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Current Work
HUNT COMPLETE. All phases passed. Commit: a916778.

### Next Steps
Archive brief. Deploy to VPS via `/sync code`.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-19 | architect | Create implementation plan | SUCCESS — 11 files (6 new, 5 modify), 6 phases |
| 2026-02-19 | forger | Implement all changes | SUCCESS — 6 new, 5 modified, 0 analyzer issues |
| 2026-02-19 | sentinel | Run test suite | PASS — lint 0 issues, build OK, all 11 files verified |
| 2026-02-19 | warden | Code review | APPROVE — clean architecture, exemplary FDL token usage, 2 minor suggestions |
| 2026-02-19 | /document | Documentation | Skipped — internal dashboard feature, no public API changes |
