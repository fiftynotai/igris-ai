# BR-015: Token Breakdown Misleading Headline

**Type:** Bug Fix
**Priority:** P2-Medium
**Effort:** S-Small (< 4 hours)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-09
**Completed:** 2026-02-09

---

## Problem

The Token Breakdown card in the Crimson Arena dashboard displays a grand total (e.g., "44,418,610") that sums all token types equally. Cache reads dominate at ~91% of the total but are ~10x cheaper per token than direct input/output. This makes the headline alarming and misleading — users think they're consuming far more than they actually are in cost terms.

---

## Goal

Redesign the Token Breakdown card using **Option B: Stacked Summary** to clearly separate direct tokens (expensive) from cached tokens (cheap), matching the split view pattern already used in the battle log.

---

## Design: Option B — Stacked Summary

### Layout

```
TOKEN BREAKDOWN — TODAY

Direct Tokens
49,218  (+ 44.4M cached)
─────────────────────────────────────
Input     [███]            38.6K  79%
Output    [█]              10.4K  21%
· · · · · · · · · · · · · · · · · ·
Cache Rd  [██████████████] 40.4M  91%
Cache Wr  [██]              4.0M   9%
─────────────────────────────────────
Total Invocations                  34
```

### Key Changes

1. **Headline reframe:** Label changes from "Total Tokens" to "Direct Tokens". Big number shows only input + output. Parenthetical shows cached total in muted text with green-tinted number.
2. **Per-group percentages:** Direct bars (input, output) show % relative to direct total. Cache bars show % relative to cache total. Fixes current "0%" display for input/output.
3. **Dotted separator:** Thin dashed border between output and cache read rows to visually group the two categories.
4. **Consistent with battle log:** Same `"X tokens (+ Y cached)"` pattern.

---

## Context & Inputs

### Files to Modify

- `dashboard/static/index.html` — Update headline markup (label, cached parenthetical)
- `dashboard/static/app.js` — Change `renderTokenBreakdown` to compute per-group percentages, update headline with direct-only total and cached parenthetical
- `dashboard/static/style.css` — Add ~3 new CSS classes (cached text, dotted separator)

### New CSS Elements

- `.token-total__cached` — Inline/block, 12px, `--text-muted`, number in `--token-cache-r`
- `.token-bars__separator` — 1px dashed `--divider`, margin 6px 0

---

## Constraints

### Architecture Rules
- Keep all 4 token types visible in one card
- Maintain dark RPG theme and existing CSS variable system
- Must fit in 360px sidebar width

### Out of Scope
- Cost-weighted calculations (Option C complexity)
- Dual headline layout (Option A)
- Changing the HP bar budget calculation

---

## Acceptance Criteria

1. [ ] Headline shows direct tokens only (input + output) as primary number
2. [ ] Cached total shown as parenthetical "(+ X cached)" in muted text
3. [ ] Input/Output bars show percentage relative to direct total (not grand total)
4. [ ] Cache Read/Create bars show percentage relative to cache total
5. [ ] Dotted separator between direct and cached bar groups
6. [ ] Consistent with battle log split view pattern
7. [ ] No visual regression on existing dashboard layout

---

## Test Plan

### Manual Test Cases

**Test Case 1: Headline accuracy**
1. Open dashboard with active session data
2. Verify headline number = input_tokens + output_tokens only
3. Verify parenthetical shows cache_read + cache_create

**Test Case 2: Per-group percentages**
1. Verify Input + Output percentages sum to ~100%
2. Verify Cache Read + Cache Create percentages sum to ~100%
3. Verify bars reflect these group-relative percentages

**Test Case 3: Visual separator**
1. Verify dotted line appears between Output and Cache Read rows

---

## Notes

- This brief was informed by the UI Designer agent analysis (3 options evaluated)
- Option B chosen for: lowest complexity, strongest consistency with battle log, minimal layout disruption
- The battle log split view was already implemented in the FR-009 session

---

**Created:** 2026-02-09
**Last Updated:** 2026-02-09
**Brief Owner:** Fifty.ai
