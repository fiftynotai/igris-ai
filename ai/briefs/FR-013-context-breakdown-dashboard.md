# FR-013: Context Window Category Breakdown in Dashboard

**Type:** Feature Request
**Priority:** P2-Medium
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Monarch
**Status:** Ready
**Created:** 2026-02-09

---

## Feature Description

**What is the proposed feature?**

Add a context window category breakdown to the Crimson Arena dashboard, mirroring the data shown by Claude Code's `/context` command. Display how the context window is consumed across categories: system prompt, system tools, MCP tools, custom agents, memory files, skills, messages, free space, and autocompact buffer.

**Why is this valuable?**

Gives the Monarch real-time visibility into what's consuming context window space — enabling informed decisions about when to compact, which MCP servers to disable, or when a session is getting heavy on messages vs. tooling overhead.

---

## User Value

### Who Benefits?
- [x] End users (people using the product)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
The Digivice only shows total context used/max as a single number. No visibility into what's eating the context window.

**With this feature:**
A category breakdown shows exactly where context is being consumed — system overhead vs. actual conversation, helping optimize session longevity.

---

## Technical Approach

### Data Sources

| Category | Source | Accuracy |
|----------|--------|----------|
| Total context used | API usage: `input_tokens + cache_read_input_tokens` | Exact |
| Context max | Model defaults / `Token usage:` pattern | Exact |
| Free space | `context_max - context_used` | Exact |
| Autocompact buffer | ~16.5% of context_max (known constant) | Exact |
| Memory files | Token-count `CLAUDE.md`, `.claude/rules/*.md`, `CLAUDE.local.md` | Estimate (~95%) |
| Custom agents | Token-count `.claude/agents/*.md` | Estimate (~95%) |
| Skills | Token-count `.claude/skills/*/SKILL.md` | Estimate (~90%) |
| System prompt | Hardcoded estimate (~4.5K) | Approximate |
| System tools | Hardcoded estimate (~17K) | Approximate |
| MCP tools | Count from MCP server tool schemas or hardcode | Approximate |
| Messages | Derived: `total - all_other_categories` | Derived |

### Token Counting Strategy
- Use simple heuristic: ~4 characters per token (or integrate `tiktoken` if available)
- Count file sizes in bytes, divide by 4 for token estimate
- Cache file token counts (files rarely change mid-session)

### Hook Changes (`main_agent_metrics.sh`)
- Add file token counting step after transcript parsing
- Scan known config file paths and estimate tokens
- Include category breakdown in the event JSON payload
- New fields: `context_breakdown: { system_prompt, system_tools, mcp_tools, agents, memory, skills, messages, free, buffer }`

### Server Changes (`dashboard/server.py`)
- Extend `context_window` table or add `context_breakdown` table
- Parse new breakdown fields from events
- Expose via `/api/state` response

### Dashboard UI Changes
- Add breakdown display to the Digivice panel or as a new sidebar widget
- Stacked horizontal bar or mini pie chart showing category proportions
- Color-coded categories matching `/context` visual style

### Components Affected
- `.claude/hooks/main_agent_metrics.sh` — Token counting + breakdown in event payload
- `dashboard/server.py` — Store and serve breakdown data
- `dashboard/static/style.css` — Breakdown widget styles
- `dashboard/static/index.html` — Breakdown widget HTML
- `dashboard/static/app.js` — Render breakdown from API data

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] Hook emits `context_breakdown` object with category token counts
2. [ ] Dashboard API returns breakdown data in `/api/state`
3. [ ] Digivice or sidebar displays category breakdown visually
4. [ ] Categories match `/context` output: system prompt, system tools, MCP tools, custom agents, memory files, skills, messages
5. [ ] Free space and autocompact buffer shown
6. [ ] Breakdown updates on each hook fire (every assistant response)
7. [ ] Estimates within ~10% of `/context` actual values

---

## Test Plan

### Functional Tests
**Test Case 1: Breakdown Accuracy**
**Steps:**
1. Run `/context` in Claude Code CLI
2. Compare category values with dashboard breakdown

**Expected Result:** Values within ~10% of each other
**Status:** [ ] Pass

**Test Case 2: Dashboard Display**
**Steps:**
1. Open dashboard at localhost:8001
2. Check breakdown widget renders

**Expected Result:** All categories shown with proportional bars/segments
**Status:** [ ] Pass

---

**Created:** 2026-02-09
**Last Updated:** 2026-02-09
**Brief Owner:** Igris AI
