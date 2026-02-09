# FR-011: Digivice Context Window Display

**Type:** Feature Request
**Priority:** P2-Medium
**Effort:** M-Medium (4-8 hours)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-09
**Completed:** 2026-02-09

---

## Problem

The dashboard has no visibility into the main agent's context window usage. When the context fills up (~200K tokens), the conversation gets compacted/summarized and the user loses prior context with no warning. The user has no way to see how full the context is or anticipate when compaction will happen.

---

## Goal

Add a **Digivice-themed context window display** to the dashboard header that shows real-time context fill level, warns at critical thresholds, and visually communicates compaction events. The context window max should be **model-aware**, detected from Anthropic's context awareness system warnings in the transcript.

---

## Design: Digivice Data Scan (Option 1)

### Layout

A miniature Digivice screen (~210px wide) in the header, placed between the HP bar and the connection status indicator.

```
HEADER
+------------------------------------------------------------------------------------+
| CRIMSON ARENA  [Today][This Week][All Time]  SESSION HP [...bar...]  [DIGIVICE] LIVE|
+------------------------------------------------------------------------------------+

Digivice screen detail (210px x 56px):

    +--[ DIGIVICE SCREEN ]---------------------+
    |  .-----------------------------------.   |
    |  | > DATA LOAD ............ 71.4%    |   |
    |  | |||||||||||||||||||||||.........   |   |  <- 20-segment bar
    |  | 142,890 / 200,000 ctx             |   |
    |  | [cache:98K] [in:32K] [new:12K]    |   |  <- composition tags
    |  '-----------------------------------'   |
    +---[ |||  crimson accent lines  ||| ]-----+
```

### Visual Elements

- **CRT scanline overlay** (CSS repeating-linear-gradient)
- **20-segment bar** (discrete blocks, not smooth fill)
- **Bezel ridges** (crimson accent lines at bottom, like Digivice antenna)
- **Monospace terminal readout** (> prompt character, dotted leaders)
- **Composition micro-tags** showing cache/input/new breakdown

### State Transitions

| Fill % | Label | Segment Color | Effect |
|--------|-------|---------------|--------|
| 0-60% | DATA LOAD | cyan (--token-input) | Calm |
| 60-80% | DATA LOAD | blue-to-amber gradient | Segments shift color |
| 80-90% | DATA LOAD | amber, pulse | "+ APPROACHING LIMIT" text |
| 90%+ | DATA OVERFLOW | crimson, aggressive pulse | Border pulses, scanlines intensify |

### Compaction Event

1. Screen flickers (opacity toggle, 3x over 0.5s)
2. Text shows "> REFORMATTING DATA..."
3. Segments drain right-to-left (staggered animation)
4. Flash cyan, settle at new level
5. "> DATA REFORMATTED" for 3 seconds, then back to normal

---

## Context Window Detection (Model-Aware)

### Primary: Anthropic Context Awareness System Warnings

Claude models receive context awareness data in the transcript:

**Initial budget (start of conversation):**
```
<budget:token_budget>200000</budget:token_budget>
```

**Per-turn updates (after tool calls):**
```
<system_warning>Token usage: 35000/200000; 165000 remaining</system_warning>
```

The hook should parse these from the transcript to get:
- `context_max` — from `token_budget` tag or the denominator in usage warnings
- `context_used` — from the numerator in usage warnings
- `context_remaining` — from the "remaining" value

This approach is model-agnostic and works regardless of whether the model has 200K or 1M context.

### Fallback: Model ID Lookup Table

If context awareness tags are not found in the transcript, fall back to model ID detection:

```
claude-opus-4-6     -> 200,000
claude-sonnet-4-5   -> 200,000
claude-haiku-4-5    -> 200,000
default             -> 200,000
```

The model ID is available in transcript entries at `message.model`.

### Detection Priority

1. Parse `<budget:token_budget>` or `Token usage: X/Y` from transcript -> use those values
2. If not found, extract model ID from `message.model` -> lookup table
3. If nothing found -> default 200,000

---

## Context & Inputs

### Data Source

Each orchestrator `stop` event already carries token counts. Context fill can be approximated from:
- `cache_read + input_tokens + cache_create` = approximate context window usage per turn

But with context awareness parsing, we get the **exact** values from Anthropic's system.

### Files to Modify

- `.claude/hooks/main_agent_metrics.sh` — Add context awareness parsing from transcript, emit context_window data in events
- `dashboard/server.py` — Store/serve context_window state, add to WebSocket payload
- `dashboard/static/index.html` — Add Digivice HTML component in header
- `dashboard/static/app.js` — Render Digivice, update on orchestrator events, state transitions, compaction detection
- `dashboard/static/style.css` — Digivice styling (screen, scanlines, segments, bezel, animations)

### New Event Fields

The orchestrator stop event should include:
```json
{
  "context_used": 142890,
  "context_max": 200000,
  "context_remaining": 57110
}
```

### New CSS Classes

- `.digivice` — outer frame
- `.digivice__screen` — inner display area with scanline overlay
- `.digivice__scanlines` — CRT effect (repeating-linear-gradient)
- `.digivice__bar` / `.digivice__segment` — 20-segment fill bar
- `.digivice__bezel` / `.digivice__ridge` — crimson accent lines
- `.digivice__tag` — composition micro-tags
- `.digivice--warning` / `.digivice--critical` / `.digivice--overflow` — state modifiers

---

## Constraints

### Architecture Rules
- Keep Digivice compact (~210px) to fit header without crowding
- Use existing CSS variable system (no new colors)
- Pure CSS for scanlines and animations (no canvas/WebGL)
- Segment count: 20 (each = 5% = 10K tokens at 200K max)
- Must detect compaction (context dropping significantly between turns)

### Out of Scope
- Historical context usage trend/graph
- Per-subagent context tracking (only orchestrator)
- 1M context beta header support
- Modifying the SESSION HP bar

---

## Acceptance Criteria

1. [ ] Digivice screen appears in dashboard header between HP bar and LIVE status
2. [ ] Shows context fill percentage and raw count (X / Y ctx)
3. [ ] 20-segment bar fills proportionally to context usage
4. [ ] Composition tags show cache/input/new breakdown
5. [ ] Color transitions at 60%, 80%, 90% thresholds
6. [ ] Compaction detected and animated (flicker + drain + "REFORMATTING")
7. [ ] Context max detected from Anthropic system warnings (primary)
8. [ ] Falls back to model ID lookup if system warnings unavailable
9. [ ] CRT scanline overlay and bezel ridges present
10. [ ] No visual regression on existing header layout

---

## Test Plan

### Manual Test Cases

**Test Case 1: Context display accuracy**
1. Open dashboard with active session
2. Verify Digivice shows current context fill
3. Trigger a new orchestrator turn
4. Verify Digivice updates with new values

**Test Case 2: Model-aware detection**
1. Check that context_max matches model's actual limit
2. Verify system warning parsing extracts correct values
3. If no warnings, verify fallback to model ID lookup

**Test Case 3: State transitions**
1. Observe color changes as context grows past 60%, 80%, 90%
2. Verify text changes to "DATA OVERFLOW" at 90%+
3. Verify compaction animation when context drops significantly

**Test Case 4: Visual integration**
1. Verify Digivice fits in header without overlapping other elements
2. Check at various viewport widths (1400px, 1200px, 900px)

---

## Notes

- Design chosen from 3 Digimon-themed options proposed by UI Designer agent
- Option 1 (Digivice Data Scan) selected for: compact size, always-visible header placement, iconic Digimon theming, S-M implementation effort
- Anthropic's context awareness is confirmed for Sonnet 4.5 and Haiku 4.5; Opus 4.6 likely has it too (released 2026-02-07, docs may not be updated yet)
- If context awareness parsing works, it gives us exact values rather than approximations from token sums

---

**Created:** 2026-02-09
**Last Updated:** 2026-02-09
**Brief Owner:** Fifty.ai
