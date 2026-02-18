# FR-059: Crimson Arena — Theme-Aware UI/UX Polish

**Type:** Feature Request
**Priority:** P1-High
**Effort:** L-Large (3-5d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** In Progress
**Created:** 2026-02-18
**Completed:**

---

## Feature Description

**What is the proposed feature?**

Refactor the Crimson Arena Flutter dashboard to be fully theme-aware, eliminate hardcoded styling, adopt fifty_ui components, fix visual/UX issues, and establish consistent design patterns. Currently 201 direct GoogleFonts calls bypass the theme system, 89.5% of fifty_ui components are unused, and widgets use FiftyColors directly instead of Theme.of(context).colorScheme — breaking theme inheritance.

**Why is this valuable?**

The dashboard was built rapidly in FR-058 (16,418 LOC in one session). It works but has accumulated tech debt: hardcoded dimensions, duplicated widget patterns, no theme awareness, and accessibility gaps. Making widgets theme-aware ensures they'll adapt to theme changes, light mode support, and FDL v3 upgrades without per-widget rewrites.

---

## User Value

### Who Benefits?
- [x] End users (people using the product)
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
- Widgets hardcode `FiftyColors.cream` instead of `Theme.of(context).colorScheme.onSurface` — adding a light theme or adjusting colors requires editing 33 files
- 201 `GoogleFonts.manrope(...)` calls instead of `Theme.of(context).textTheme` — global typography changes impossible
- 38 fifty_ui components available but only 1 used (FiftyLoadingIndicator) — custom widgets duplicate what FDL already provides
- Text as small as 8-9px, missing overflow handling, color-only status indicators (accessibility issues)
- No loading skeletons, inconsistent empty states, no hover feedback

**With this feature:**
- All widgets are theme-aware: changing FiftyTheme.dark() automatically propagates everywhere
- fifty_ui components (FiftyCard, FiftyBadge, FiftyProgressBar, FiftyStatusIndicator, etc.) replace custom implementations
- Minimum 11px font size, proper text overflow, accessible contrast ratios
- Consistent UX patterns: loading states, empty states, hover feedback, tooltips

---

## Technical Approach

### Core Principle: Theme-Aware Widgets

**DO NOT** hardcode FiftyColors/FiftyTypography directly in widgets. Instead:

```dart
// BAD — breaks theme inheritance
Text(
  'Hello',
  style: GoogleFonts.manrope(
    fontSize: FiftyTypography.bodyMedium,
    color: FiftyColors.cream,
  ),
);

// GOOD — theme-aware
Text(
  'Hello',
  style: Theme.of(context).textTheme.bodyMedium,
);

// BAD — hardcoded color
Container(color: FiftyColors.surfaceDark);

// GOOD — theme-aware
Container(color: Theme.of(context).colorScheme.surface);

// GOOD — when you need FDL-specific properties not in Material ColorScheme
final ext = Theme.of(context).extension<FiftyThemeExtension>()!;
Container(color: ext.accent);
```

**When to use FiftyColors directly:**
- Only in theme definition files (fifty_theme package itself)
- In one-off decorative elements where theme inheritance isn't needed (glitch effects, gaming overlays)

**When to use Theme.of(context):**
- All text styling → `.textTheme`
- All surface/background colors → `.colorScheme`
- All FDL extras (accent, success, warning, shadows) → `.extension<FiftyThemeExtension>()`

### Theme Property Mapping

| Direct Token (avoid) | Theme-Aware (use) |
|---|---|
| `FiftyColors.cream` | `colorScheme.onSurface` |
| `FiftyColors.burgundy` | `colorScheme.primary` |
| `FiftyColors.darkBurgundy` | `colorScheme.surface` / `scaffoldBackgroundColor` |
| `FiftyColors.surfaceDark` | `colorScheme.surfaceContainer` |
| `FiftyColors.slateGrey` | `colorScheme.secondary` |
| `FiftyColors.hunterGreen` | `ext.success` |
| `FiftyColors.warning` | `ext.warning` |
| `FiftyColors.borderDark` | `colorScheme.outline` |
| `FiftyColors.powderBlush` | `ext.accent` |
| `GoogleFonts.manrope(fontSize: X)` | `textTheme.bodyMedium` / `labelSmall` etc. |

---

## Phases

### Phase 1: Foundation — Theme Constants & Shared Widgets (S)

Extract centralized constants and shared widgets that all other phases depend on.

**Tasks:**
1. Create `lib/core/constants/arena_breakpoints.dart` — centralize all responsive breakpoints (600, 900, 1200)
2. Create `lib/core/constants/arena_sizes.dart` — centralize all magic number dimensions
3. Extract `lib/shared/widgets/status_badge.dart` — replace 5+ duplicated status dot+label patterns
4. Extract `lib/shared/widgets/segmented_bar.dart` — replace duplicated progress bar in token_budget_card and context_window_card
5. Add `FiftyTypography.fontFamilyMono` token for Source Code Pro (or local constant if tokens package is external)
6. Add rarity/achievement color constants to a local `arena_colors.dart` (game-specific colors that don't belong in FDL)

### Phase 2: Theme-Aware Text Migration (M)

Replace all 201 direct `GoogleFonts.manrope(...)` calls with `Theme.of(context).textTheme.*`.

**Tasks:**
7. Audit all text styles and map each GoogleFonts call to the correct textTheme property
8. Migrate home page widgets (14 files) to theme-aware text styles
9. Migrate instances page widgets (6 files) to theme-aware text styles
10. Migrate agents page widgets (4 files) to theme-aware text styles
11. Migrate achievements page widgets (5 files) to theme-aware text styles
12. Migrate shared widgets (arena_card, arena_scaffold) to theme-aware text styles
13. For monospace text (GoogleFonts.sourceCodePro), create a local `ArenaTextStyles.mono()` helper that still uses theme colors
14. Verify: `flutter analyze` 0 issues, visual regression check

### Phase 3: Theme-Aware Color Migration (M)

Replace direct `FiftyColors.*` usage in widgets with `Theme.of(context).colorScheme` and `FiftyThemeExtension`.

**Tasks:**
15. Replace `FiftyColors.cream` → `colorScheme.onSurface` across all widgets
16. Replace `FiftyColors.burgundy` → `colorScheme.primary` across all widgets
17. Replace `FiftyColors.surfaceDark` → `colorScheme.surfaceContainer` across all widgets
18. Replace `FiftyColors.borderDark` → `colorScheme.outline` across all widgets
19. Replace `FiftyColors.slateGrey` → `colorScheme.secondary` across all widgets
20. Replace `FiftyColors.hunterGreen/warning` → `ext.success/ext.warning` across all widgets
21. Keep `FiftyColors.*` only for: agent-specific colors (from AgentConstants), rarity theme colors, decorative overlays
22. Replace `.withValues(alpha: X)` patterns with themed opacity — ensure contrast meets WCAG AA
23. Verify: `flutter analyze` 0 issues, visual regression check

### Phase 4: fifty_ui Component Adoption (M)

Replace custom widget implementations with fifty_ui components.

**Tasks:**
24. Replace ArenaCard internals to extend/wrap FiftyCard (or refactor ArenaCard to use theme-aware patterns)
25. Replace custom status dot indicators with FiftyStatusIndicator (agent_roster_strip, instance_card, compact_vitals_strip, brain_health_card)
26. Replace custom progress bars with FiftyProgressBar (token_budget_card, context_window_card, agent_grid stat bars)
27. Replace custom stat displays with FiftyStatCard (brain_health_card stats, cost_estimate_card)
28. Replace custom section headers with FiftySectionHeader (all pages)
29. Replace custom badge widgets with FiftyBadge (achievement rarity, status badges, category tags)
30. Replace custom chip/tag widgets with FiftyChip (achievement filters, knowledge panel categories)
31. Verify: `flutter analyze` 0 issues, visual regression check

### Phase 5: Visual Fixes & Accessibility (S)

Fix text overflow, font sizes, contrast, and missing UX states.

**Tasks:**
32. Add `maxLines` + `overflow: TextOverflow.ellipsis` to all unbounded text (brain_command_center project names, brief rows, instance card headers)
33. Increase minimum font size to 11px — fix 8px category badges, 9px rarity badges, 9px progress counters
34. Fix brief row fixed widths — replace `SizedBox(width: 64/72/28)` with `Flexible`/`Expanded`
35. Change locked achievement opacity from 0.55 to 0.70 for better contrast
36. Add Tooltip widgets on truncated text (agent names, project slugs, brief titles)
37. Add icon/text alongside color-only status indicators (green/gray dots) for colorblind users
38. Add hover states to interactive elements (REFRESH button, nav tabs)
39. Standardize empty state messages to consistent format across all widgets

### Phase 6: Architecture Cleanup (S)

Reduce widget complexity and eliminate code duplication.

**Tasks:**
40. Split `brain_command_center.dart` (510 lines) into: `brain_projects_panel.dart`, `brain_briefs_panel.dart`, `brain_sessions_panel.dart`
41. Extract token breakdown bars from token_budget_card into standalone widget
42. Add loading skeleton/shimmer states for data-dependent widgets (battle log, skill heatmap, agent grid)
43. Standardize page layout pattern — ensure all pages use consistent LayoutBuilder breakpoints from ArenaBreakpoints
44. Specify scroll physics on nested ListViews (`ClampingScrollPhysics` for web)
45. Remove hardcoded SizedBox heights — use constraints or flexible layout where possible
46. Final `flutter analyze` + `flutter build web` verification

---

## Context & Inputs

### Dependencies
- [x] Existing system: fifty_tokens (design tokens)
- [x] Existing system: fifty_theme (ThemeData builder, FiftyThemeExtension)
- [x] Existing system: fifty_ui (38 components)
- [x] Existing system: FiftyTheme.dark() already applied in main.dart

### Files to Create
- `lib/core/constants/arena_breakpoints.dart`
- `lib/core/constants/arena_sizes.dart`
- `lib/core/constants/arena_colors.dart` (game-specific colors only)
- `lib/core/theme/arena_text_styles.dart` (mono helper, custom text styles)
- `lib/shared/widgets/status_badge.dart`
- `lib/shared/widgets/segmented_bar.dart`
- `lib/features/home/views/widgets/brain_projects_panel.dart`
- `lib/features/home/views/widgets/brain_briefs_panel.dart`
- `lib/features/home/views/widgets/brain_sessions_panel.dart`

### Files to Modify
- All 33 feature widget files (theme-aware migration)
- `lib/shared/widgets/arena_card.dart` (FiftyCard integration)
- `lib/shared/widgets/arena_scaffold.dart` (theme-aware)
- `lib/main.dart` (verify theme setup)

---

## Constraints

### Technical Constraints
- Must NOT break existing functionality — visual regression only
- Must use `Theme.of(context)` for colors and text — no direct FiftyColors in widgets except game-specific decorative elements
- Must pass `flutter analyze` with 0 issues after each phase
- Must build successfully with `flutter build web`
- fifty_tokens/fifty_theme/fifty_ui packages are in external ecosystem repo — do NOT modify them; only use what's available

### UX Constraints
- Visual appearance should remain nearly identical (same dark theme, same burgundy/cream palette)
- The change is architectural (theme-aware) not visual redesign
- Minimum font size: 11px
- WCAG AA contrast on all text elements

### Out of Scope
- Light theme implementation (but theme-aware migration enables it later)
- Mobile-optimized layout (tablet/phone breakpoints)
- New features or pages
- Modifying fifty_tokens/fifty_theme/fifty_ui packages

---

## Tasks

### Pending
- [ ] 1: Create arena_breakpoints.dart
- [ ] 2: Create arena_sizes.dart
- [ ] 3: Extract StatusBadge shared widget
- [ ] 4: Extract SegmentedBar shared widget
- [ ] 5: Add mono font constant
- [ ] 6: Create arena_colors.dart for game-specific colors
- [ ] 7: Audit text styles mapping
- [ ] 8-12: Migrate all widgets to theme-aware text (5 task groups by feature)
- [ ] 13: Create ArenaTextStyles.mono() helper
- [ ] 14: Phase 2 verification
- [ ] 15-22: Migrate all colors to theme-aware (8 tasks)
- [ ] 23: Phase 3 verification
- [ ] 24-31: Adopt fifty_ui components (8 tasks)
- [ ] 32-39: Visual fixes and accessibility (8 tasks)
- [ ] 40-46: Architecture cleanup (7 tasks)

---

## Workflow State

**Phase:** BUILDING
**Active Agent:** forger
**Retry Count:** 0

### Current Work
All 6 phases COMPLETE. SENTINEL PASS. WARDEN APPROVE. Committing.

### Next Steps
Commit, update brief status to Done.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-18 17:30 | seeker x3 | UI/UX audit (FDL tokens, visual, architecture) | COMPLETE — 20 critical, 7 major, 9 minor issues |
| 2026-02-18 19:03 | architect | Full implementation plan (Phase 1-2 detailed, 3-6 roadmapped) | COMPLETE — 6 new files, 35 to modify, risk assessment done |
| 2026-02-18 19:07 | forger | Phase 1 Foundation — 6 new files | COMPLETE — 468 lines, flutter analyze 0 issues |
| 2026-02-18 19:12 | sentinel | Phase 1 validation | PASS — analyze 0, build web success, 6/6 quality checks pass |
| 2026-02-18 19:15 | forger | Phase 2 Text Migration — 32 files | COMPLETE — 201 GoogleFonts calls removed, analyze 0 issues |
| 2026-02-18 19:36 | sentinel | Phase 2 validation | PASS — analyze 0, build web success, 0 manrope calls, 1 sourceCodePro (wrapper only) |
| 2026-02-18 19:57 | forger | Phase 3 Color Migration — 20 files | COMPLETE — ~200 FiftyColors replaced, 16 justified exceptions, analyze 0 |
| 2026-02-18 20:18 | sentinel | Phase 3 validation | PASS — analyze 0, build web success, 0 FiftyColors in widgets, 20/20 ext imports |
| 2026-02-18 20:23 | forger | Phase 4 fifty_ui Adoption — 5 files | COMPLETE — 5 custom widgets replaced, ~163 LOC removed, 7 components evaluated/skipped |
| 2026-02-18 20:28 | forger | Phase 5 Visual Fixes + Accessibility — 18 files | COMPLETE — 11 font fixes, overflow+tooltips in 10 files, hover states, empty states standardized |
| 2026-02-18 20:35 | forger | Phase 6 Architecture Cleanup — 11 files | COMPLETE — brain_command_center split (523→78), 8 breakpoint adoptions, 6 scroll physics |
| 2026-02-18 20:42 | sentinel | Final validation (9 checks) | PASS — 9/9 all green |
| 2026-02-18 20:42 | warden | Code review | APPROVE — 9/10, 0 critical, 2 minor (follow-up) |

### Blockers
None

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] Zero direct `GoogleFonts.manrope(...)` calls in widget files — all text uses `Theme.of(context).textTheme`
2. [ ] Zero direct `FiftyColors.*` in widget files for themeable properties — all use `colorScheme` or `FiftyThemeExtension`
3. [ ] FiftyColors only used for: agent-specific colors, rarity colors, decorative overlays
4. [ ] 10+ fifty_ui components adopted (FiftyCard, FiftyBadge, FiftyProgressBar, FiftyStatusIndicator, FiftyStatCard, FiftySectionHeader, FiftyChip minimum)
5. [ ] No text smaller than 11px
6. [ ] All unbounded text has overflow handling (maxLines + ellipsis)
7. [ ] All color-only indicators have icon/text alternative
8. [ ] Loading skeleton states for data-dependent widgets
9. [ ] Consistent empty state messages
10. [ ] `brain_command_center.dart` split into 3 files (each < 200 lines)
11. [ ] All breakpoints use ArenaBreakpoints constants
12. [ ] `flutter analyze` 0 issues
13. [ ] `flutter build web` succeeds
14. [ ] No visual regressions on deployed dashboard

---

## Test Plan

### Functional Tests
**Test Case 1: Theme Awareness**
**Steps:**
1. Verify all widgets render correctly with FiftyTheme.dark()
2. Temporarily modify a colorScheme property in FiftyTheme.dark() (e.g., change primary)
3. Confirm change propagates to all widgets without per-widget edits

**Expected Result:** Single theme change affects entire dashboard
**Status:** [ ] Pass / [ ] Fail

**Test Case 2: Visual Regression**
**Steps:**
1. Deploy updated build to VPS
2. Compare each page visually to pre-refactor screenshots
3. Verify no layout breaks, missing text, or color mismatches

**Expected Result:** Dashboard looks identical to pre-refactor version
**Status:** [ ] Pass / [ ] Fail

**Test Case 3: Accessibility**
**Steps:**
1. Check all text meets minimum 11px size
2. Check all status indicators have non-color alternative
3. Check all truncated text has tooltips
4. Verify locked achievement contrast passes WCAG AA

**Expected Result:** All accessibility checks pass
**Status:** [ ] Pass / [ ] Fail

### Regression Tests
- [ ] WebSocket connection still works (no grey screen)
- [ ] All 4 pages render correctly (HOME, INSTANCES, AGENTS, ACHIEVEMENTS)
- [ ] Navigation and keyboard shortcuts still work
- [ ] Deep linking to instances still works
- [ ] Loading indicator sequence still displays
- [ ] Agent roster strip still scrolls horizontally
- [ ] Battle log still auto-updates via WebSocket

---

## Delivery

### Documentation
- [ ] Update dashboard README if needed
- [ ] Theme usage patterns documented in code comments

### Announcement
- [ ] Include in v4.0 release notes

---

## Notes

**Audit Data Sources:**
- 3 parallel SEEKER agents analyzed all 33 widget files
- FDL token compliance: 94% (gaps in shadows, spacing, components)
- fifty_ui utilization: 2.6% (1 of 38 components used)
- 201 direct GoogleFonts calls identified
- 109 hardcoded SizedBox heights + 47 hardcoded EdgeInsets

**Key Insight from User:**
"You shouldn't use the FiftyColors always so you don't break the theme aware components or build widgets without theme aware" — the fundamental principle is that widgets must pull styling from Theme.of(context), not from token constants directly. FiftyColors/FiftyTypography belong in the theme definition layer, not in the widget layer.

---

**Created:** 2026-02-18
**Last Updated:** 2026-02-18
**Brief Owner:** Igris AI
