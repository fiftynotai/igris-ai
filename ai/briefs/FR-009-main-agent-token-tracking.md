# FR-009: Main Agent Token Tracking in Crimson Arena

**Type:** Feature Request
**Priority:** P2-Medium
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-09
**Completed:** 2026-02-09

---

## Feature Description

**What is the proposed feature?**

Track main agent (orchestrator) token consumption in the Crimson Arena dashboard. Currently the dashboard only captures subagent data via `SubagentStart`/`SubagentStop` hooks. The main Claude Code session — which is typically the biggest token consumer — is completely invisible.

**Why is this valuable?**

The main agent holds the full conversation context, loads all rules/briefs/session files, and coordinates everything. Without tracking it, the dashboard shows only a fraction of actual token usage. Developers can't see their true consumption or make accurate budget decisions.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)

### Pain Point Solved
**Current situation:** Only subagent invocations (architect, forger, sentinel, etc.) are tracked. The orchestrator session — often 60-80% of total token consumption — is not captured. Token breakdown and budget HP bar underreport actual usage.

**With this feature:** The main agent appears as a distinct entry in the dashboard (e.g., "CRIMSON" or "orchestrator" pod). Token breakdown reflects true total consumption. HP bar budget tracking becomes accurate.

---

## Technical Approach

### Hook Strategy

The main agent lifecycle uses different hooks than subagents:

| Hook | Event | Data Available |
|------|-------|----------------|
| `Stop` | Main agent finishes a response | `session_id`, `transcript_path`, `cwd` |
| `Notification` | Agent needs attention | `message`, `title`, `notification_type` |

The `Stop` hook fires after every main agent turn. The `transcript_path` contains the main session JSONL with `event.message.usage` token data — same format as subagent transcripts.

### Data Pipeline Changes

1. **New hook script:** `.claude/hooks/main_agent_metrics.sh`
   - Triggered on `Stop` event
   - Parse tokens from main session transcript JSONL (last entry since previous check)
   - Track cumulative tokens per session
   - Append to `events.jsonl` with `agent: "orchestrator"`
   - POST to dashboard server

2. **Incremental parsing:** The main transcript grows continuously. Use a cursor/offset file to only parse new entries since last `Stop` event:
   - Store last-read line number in `/tmp/igris_main_cursor_<session_id>`
   - On each `Stop`, read from cursor to end
   - Update cursor

3. **Dashboard changes:**
   - Add "ORCHESTRATOR" pod to agent pipeline (or use persona name "CRIMSON")
   - Include orchestrator tokens in token breakdown
   - Include in HP bar budget calculation
   - Orchestrator level/XP tracks total turns (not invocations)

### Files to Modify

- `.claude/settings.json` — Add `Stop` hook for main agent metrics
- `.claude/hooks/main_agent_metrics.sh` — New script (token parsing + events)
- `dashboard/server.py` — Handle orchestrator agent type, include in aggregations
- `dashboard/static/index.html` — Add orchestrator pod
- `dashboard/static/app.js` — Render orchestrator data

### Relation to Stop Hook

The existing `Stop` hook (`stop_session_check.sh`) handles session protocol. The new hook runs alongside it — multiple hooks can be chained on the same event.

---

## Constraints

### Technical Constraints
- `Stop` fires on every main agent turn — must be fast (< 5 seconds)
- Transcript file grows large — must use incremental parsing (cursor-based)
- Must not conflict with existing `stop_session_check.sh` hook
- Session transcript path format may differ from subagent transcripts

### Out of Scope
- Tracking token costs in dollars (separate concern)
- Per-turn breakdown in battle log (just aggregate per Stop event)
- Notification sounds (covered by FR-010)

---

## Acceptance Criteria

1. [ ] Main agent token consumption appears in token breakdown
2. [ ] Orchestrator pod visible in dashboard agent pipeline
3. [ ] HP bar budget includes main agent tokens
4. [ ] Battle log shows main agent events (turns)
5. [ ] Incremental parsing — no re-reading entire transcript on each turn
6. [ ] Existing Stop hook (stop_session_check.sh) continues to work
7. [ ] Performance: hook completes in < 2 seconds

---

## Test Plan

### Functional Tests

**Test Case 1: Token capture**
1. Start a Claude Code session with dashboard running
2. Send a message to the main agent
3. Verify token breakdown updates with orchestrator data

**Test Case 2: Incremental parsing**
1. Send 5 messages in a session
2. Verify cursor file tracks position
3. Verify no duplicate token counting

**Test Case 3: Coexistence with existing hooks**
1. Verify stop_session_check.sh still runs
2. Verify agent_metrics.sh still tracks subagents
3. Verify no race conditions

---

## Notes

- Depends on FR-007 (Agent Token Dashboard) which is Done
- The `Stop` hook input schema has `transcript_path` — same field used by SubagentStop
- Display name = "IGRIS" (approved by user). Internal agent key = "orchestrator"
- Main agent tokens will likely dwarf subagent tokens — UI should handle large numbers gracefully

---

**Created:** 2026-02-09
**Last Updated:** 2026-02-09
**Brief Owner:** Fifty.ai
