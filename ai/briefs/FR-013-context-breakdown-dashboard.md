# FR-013: Context Window Category Breakdown in Dashboard

**Type:** Feature Request
**Priority:** P2-Medium
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Partner
**Status:** In Progress
**Created:** 2026-02-09

---

## Feature Description

**What is the proposed feature?**

Add a context window category breakdown to the Crimson Arena Flutter dashboard, mirroring the data shown by Claude Code's `/context` command. Display how the context window is consumed across categories: system prompt, system tools, MCP tools, custom agents, memory files, skills, messages, free space, and autocompact buffer.

**Why is this valuable?**

Gives the Partner real-time visibility into what's consuming context window space — enabling informed decisions about when to compact, which MCP servers to disable, or when a session is getting heavy on messages vs. tooling overhead.

---

## User Value

### Who Benefits?
- [x] End users (people using the product)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
The `ContextWindowCard` widget on the Home page only shows total context used/max as a single progress bar. No visibility into what's eating the context window.

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

### Phase 1: Hook Changes (`main_agent_metrics.sh`)

Extend the orchestrator stop event payload with a `context_breakdown` object:

- Add file token counting step after transcript parsing
- Scan known config file paths and estimate tokens:
  - `CLAUDE.md` + `CLAUDE.local.md` + `.claude/rules/*.md` → memory
  - `.claude/agents/*.md` → agents
  - `.claude/skills/*/SKILL.md` → skills
- Include category breakdown in the event JSON payload
- New field in event:
  ```json
  "context_breakdown": {
    "system_prompt": 4500,
    "system_tools": 17000,
    "mcp_tools": 8000,
    "agents": 3200,
    "memory": 6800,
    "skills": 12000,
    "messages": 45000,
    "free": 70000,
    "buffer": 33000
  }
  ```

### Phase 2: Server Changes (`dashboard/server.py`)

**Database:**
- Add `context_breakdown` table (or extend `context_window` with new columns)
- Schema:
  ```sql
  CREATE TABLE IF NOT EXISTS context_breakdown (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    system_prompt INTEGER DEFAULT 0,
    system_tools INTEGER DEFAULT 0,
    mcp_tools INTEGER DEFAULT 0,
    agents INTEGER DEFAULT 0,
    memory INTEGER DEFAULT 0,
    skills INTEGER DEFAULT 0,
    messages INTEGER DEFAULT 0,
    free INTEGER DEFAULT 0,
    buffer INTEGER DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  ```

**Event Processing:**
- In `insert_event()`, parse `context_breakdown` from orchestrator stop events
- Upsert into `context_breakdown` table (same pattern as `context_window`)

**API:**
- Extend `build_context_window_state()` to include breakdown data
- Include in `/api/state` response under `context_window.breakdown`
- Broadcast via WebSocket `type: "state"` messages

### Phase 3: Flutter Model + Service

**New model:** `lib/data/models/context_breakdown_model.dart`

```dart
class ContextBreakdownModel {
  final int systemPrompt;
  final int systemTools;
  final int mcpTools;
  final int agents;
  final int memory;
  final int skills;
  final int messages;
  final int free;
  final int buffer;

  // Computed
  int get totalOverhead => systemPrompt + systemTools + mcpTools + agents + memory + skills;
  int get totalUsable => messages + free;
  List<ContextCategory> get categories => [...]; // Sorted list for chart rendering
}

class ContextCategory {
  final String label;
  final int tokens;
  final Color color;
  double get percentage => ...; // Relative to context_max
}
```

**Extend `ContextWindowModel`:**
- Add optional `ContextBreakdownModel? breakdown` field
- Parse from `context_window.breakdown` in `/api/state` response

**Extend `BrainApiService`:**
- No new endpoint needed — breakdown comes with `/api/state`

**Extend `BrainWebSocketService`:**
- Breakdown arrives as part of existing `type: "state"` messages
- Parsed automatically when `ContextWindowModel` is updated

### Phase 4: Flutter ViewModel + Widget

**Extend `HomeViewModel`:**
- Add `Rx<ContextBreakdownModel?>` observable
- Parse from `contextWindow` state updates (REST + WebSocket)

**New widget:** `lib/features/home/views/widgets/context_breakdown_card.dart`

- **Layout:** `ArenaCard` with stacked horizontal segmented bar (reuse `SegmentedBar` pattern)
- **Categories:** Color-coded segments matching `/context` visual style
- **Labels:** Category name + token count + percentage
- **Color palette** (using `ArenaColors`):
  - System prompt → `legendaryGold`
  - System tools → `epicPurple`
  - MCP tools → `rareCyan`
  - Agents → `uncommonGreen`
  - Memory → `commonBlue`
  - Skills → `uncommonGreen` (lighter)
  - Messages → `ArenaColors.crimson`
  - Free → `ArenaColors.surface` (dimmed)
  - Buffer → `ArenaColors.surfaceLight`
- **Empty state:** Show "Awaiting context data..." when no breakdown available
- **Responsive:** Full-width card below `ContextWindowCard`, or side-by-side on wide screens

**Placement on Home page (`home_page.dart`):**
- Below existing `ContextWindowCard` widget
- Or replace it entirely with a richer combined card

### Components Affected

| File | Change |
|------|--------|
| `.claude/hooks/main_agent_metrics.sh` | Add file token counting + breakdown in event payload |
| `dashboard/server.py` | New table, parse breakdown, include in API/WS |
| `dashboard/crimson-arena/lib/data/models/context_breakdown_model.dart` | **New** — Breakdown data model |
| `dashboard/crimson-arena/lib/data/models/context_window_model.dart` | Extend with optional breakdown field |
| `dashboard/crimson-arena/lib/features/home/controllers/home_view_model.dart` | Add breakdown observable + parsing |
| `dashboard/crimson-arena/lib/features/home/views/widgets/context_breakdown_card.dart` | **New** — Breakdown visualization widget |
| `dashboard/crimson-arena/lib/features/home/views/home_page.dart` | Place new widget in layout |
| `dashboard/crimson-arena/lib/core/constants/arena_colors.dart` | Category color constants (if not already defined) |

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] Hook emits `context_breakdown` object with category token counts in orchestrator stop event
2. [ ] Server stores breakdown in `context_breakdown` table and includes in `/api/state` response
3. [ ] `ContextBreakdownModel` parses breakdown data from API/WebSocket
4. [ ] `ContextBreakdownCard` widget renders stacked segmented bar with all categories
5. [ ] Categories match `/context` output: system prompt, system tools, MCP tools, custom agents, memory files, skills, messages
6. [ ] Free space and autocompact buffer shown as distinct segments
7. [ ] Breakdown updates in real-time via WebSocket on each hook fire
8. [ ] Estimates within ~10% of `/context` actual values
9. [ ] Widget follows FDL v2 design system (ArenaCard, ArenaColors, ArenaSizes)
10. [ ] Responsive layout — works on both narrow and wide viewports

---

## Test Plan

### Functional Tests

**Test Case 1: Hook Payload**
**Steps:**
1. Trigger an orchestrator stop event (end a Claude Code session)
2. Check `ai/session/metrics/events.jsonl` for latest event

**Expected Result:** Event contains `context_breakdown` object with all 9 category fields
**Status:** [ ] Pass

**Test Case 2: Server Storage & API**
**Steps:**
1. POST event with `context_breakdown` to `/api/event`
2. GET `/api/state` and check `context_window.breakdown`

**Expected Result:** Breakdown data persisted and returned correctly
**Status:** [ ] Pass

**Test Case 3: Breakdown Accuracy**
**Steps:**
1. Run `/context` in Claude Code CLI
2. Compare category values with dashboard breakdown

**Expected Result:** Values within ~10% of each other
**Status:** [ ] Pass

**Test Case 4: Dashboard Display**
**Steps:**
1. Open Crimson Arena at localhost:8001
2. Navigate to Home page
3. Check `ContextBreakdownCard` renders below context window

**Expected Result:** All categories shown with proportional colored segments and labels
**Status:** [ ] Pass

**Test Case 5: Real-Time Updates**
**Steps:**
1. Open dashboard, observe current breakdown
2. Send a few messages in Claude Code session
3. Watch breakdown update via WebSocket

**Expected Result:** Messages category grows, free space shrinks, updates without page refresh
**Status:** [ ] Pass

---

**Created:** 2026-02-09
**Last Updated:** 2026-02-19
**Brief Owner:** Igris AI
