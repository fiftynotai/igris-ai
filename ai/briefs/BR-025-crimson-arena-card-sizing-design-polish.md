# BR-025: Crimson Arena — Home Page Layout & Space Utilization

**Type:** Bug Fix
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** In Progress
**Created:** 2026-02-19
**Completed:**

---

## Problem

**What's broken or missing?**

The HOME page wastes horizontal space — small-content cards like Brain Status and Sync Pipeline each occupy a full-width row when their actual content only needs ~1/3 of the screen width. The page layout treats every widget as a full-width block stacked vertically, instead of grouping compact widgets side-by-side to utilize the available space.

**Specific issues:**

1. **Brain Status card** — Contains only 4 key-value pairs (version, db size, uptime, records) + an ONLINE badge. This content fits in ~300px width but the card stretches to 100% of the page (~900-1200px). Massive wasted horizontal space.

2. **Sync Pipeline card** — Contains only 4 stats (status, last push, last pull, queue). Same problem: content fits in ~300px but the card takes the full row.

3. **Home page layout** — Currently stacks widgets in full-width rows. Many widgets (Brain Status, Sync Pipeline, Knowledge Panel) are compact enough to sit side-by-side in 2-3 column arrangements, similar to how the wide layout already groups Token Budget / Battle Log in a two-column Row.

4. **Remaining FR-059 gaps** (secondary):
   - ArenaSizes constants defined but not adopted in widgets
   - ArenaColors.legendaryGold not wired into rarity_theme.dart

**User feedback:** "both cards take a full screen width while the actual content can fit in 1/3 the screen width... it's about rearranging the components on the home page to utilize the spaces better, not each component should have a full row to itself"

---

## Goal

**What should happen after this brief is completed?**

1. Home page layout groups compact widgets side-by-side — Brain Status, Sync Pipeline, and other small cards share rows instead of each taking full width
2. Space utilization is efficient — no card wastes >50% of its row width as empty space
3. The layout is responsive — side-by-side on wide screens, stacked on narrow screens (using ArenaBreakpoints)
4. ArenaSizes constants adopted in widget files
5. ArenaColors.legendaryGold wired into rarity_theme.dart

---

## Context & Inputs

### Root Cause
The home page layout (`home_page.dart`) arranges widgets in a single-column `Column` with only one two-column breakpoint (the `_WideLayout` for Token Budget/Battle Log/etc). Cards like BrainHealthCard, SyncPanel, KnowledgePanel are placed as standalone full-width children when they should be grouped in Rows.

### Current Layout (home_page.dart)
```
RangeFilter                          ← full width (fine, it's right-aligned)
FiftySectionHeader('Vitals')         ← full width
InstrumentStrip                      ← full width (fine, it's a gauge strip)
AgentRosterStrip                     ← full width (fine, it's horizontal scroll)
[Two-column: Budget+Context+Cost | BattleLog+Heatmap+Velocity]  ← good!
FiftySectionHeader('Brain')          ← full width
BrainHealthCard                      ← FULL WIDTH — content is tiny!
BrainCommandCenter                   ← full width (fine, it's a tabbed panel)
FiftySectionHeader('Intelligence')   ← full width
[Wide: Knowledge | Sync]             ← already side-by-side on wide!
[Narrow: Knowledge, Sync stacked]
```

### Proposed Layout
```
RangeFilter
FiftySectionHeader('Vitals')
InstrumentStrip
AgentRosterStrip
[Two-column: Budget+Context+Cost | BattleLog+Heatmap+Velocity]
FiftySectionHeader('Brain')
[Wide: BrainHealthCard | SyncPanel | (optional 3rd card)]  ← GROUPED!
BrainCommandCenter
FiftySectionHeader('Intelligence')
[Wide: Knowledge | (other compact widget)]
```

### Files to Modify
- `lib/features/home/views/home_page.dart` — Main layout rearrangement
- `lib/features/home/views/widgets/brain_health_card.dart` — May need layout tweak for narrower width
- `lib/features/home/views/widgets/sync_panel.dart` — May need to stack stats vertically when in narrow column

### Related Briefs
- FR-059: Created the current widget set and theme-aware architecture
- FR-057: INSTANCES page live data (separate, not addressed here)

---

## Tasks

### Pending
- [ ] 1: Rearrange home_page.dart layout — group BrainHealthCard and SyncPanel side-by-side in a Row on wide screens
- [ ] 2: Ensure BrainHealthCard renders well at ~1/2 or ~1/3 width (stats may need to wrap or stack)
- [ ] 3: Ensure SyncPanel renders well at ~1/2 or ~1/3 width (stats may need to wrap or stack)
- [ ] 4: Review other full-width widgets on HOME for grouping opportunities (e.g., Knowledge Panel could pair with another compact card)
- [ ] 5: Ensure narrow screen fallback still stacks everything vertically
- [ ] 6: Adopt ArenaSizes constants in widget files where magic numbers remain
- [ ] 7: Wire ArenaColors.legendaryGold into rarity_theme.dart
- [ ] 8: Final flutter analyze + build web verification
- [ ] 9: Deploy to VPS and visual review

---

## Acceptance Criteria

**The fix is complete when:**

1. [ ] Brain Status and Sync Pipeline cards share a row on wide screens (not each full-width)
2. [ ] No compact card wastes >50% of its row as empty space on wide screens
3. [ ] Layout is responsive — side-by-side on wide, stacked on narrow
4. [ ] ArenaSizes constants adopted in 5+ widget files
5. [ ] ArenaColors.legendaryGold wired into rarity_theme.dart
6. [ ] `flutter analyze` 0 issues
7. [ ] `flutter build web` succeeds
8. [ ] Deployed to VPS, layout looks balanced

---

## Test Plan

### Manual Test Cases

**Test Case 1: Wide Screen Layout**
**Steps:**
1. Open Crimson Arena HOME page at >900px width
2. Check that Brain Status and Sync Pipeline are side-by-side, not stacked

**Expected Result:** Compact cards share rows, space is utilized efficiently
**Status:** [ ] Pass / [ ] Fail

**Test Case 2: Narrow Screen Layout**
**Steps:**
1. Resize browser to <600px width
2. Check that all cards stack vertically

**Expected Result:** Cards stack cleanly, no horizontal overflow
**Status:** [ ] Pass / [ ] Fail

---

## Workflow State

**Phase:** COMMITTING
**Active Agent:** none
**Retry Count:** 0

### Agent Log
- [2026-02-19] ARCHITECT — Plan complete. 5 phases, 10 files. Layout restructure + ArenaSizes adoption + ArenaColors wiring.
- [2026-02-19] FORGER — Implementation complete. 11 files modified. flutter analyze clean.
- [2026-02-19] SENTINEL — PASS. analyze 0 issues, build web success. All code verification checks pass. 1 pre-existing test failure (arena_scaffold nav overflow, not BR-025 related).
- [2026-02-19] WARDEN — APPROVED. Clean, well-structured. 3 minor nits (tiny magic numbers in private widgets), not blocking.

---

## Notes

- The two-column pattern already exists in home_page.dart (`_WideLayout` groups Budget/BattleLog side-by-side). The same pattern should be applied to Brain Status + Sync Pipeline.
- BrainHealthCard uses FiftyDataSlate which has internal padding — at narrower widths this may look fine since the content is key-value pairs that naturally stack.
- SyncPanel currently uses a horizontal Row of stats — at narrow column widths it may need to wrap to 2x2 grid.

---

**Created:** 2026-02-19
**Last Updated:** 2026-02-19
**Brief Owner:** Igris AI
