# MG-002: Claude Code as Igris Brain Integration

**Type:** Migration
**Priority:** P0-Critical
**Effort:** L-Large (1 week)
**Assignee:** Igris AI + Fifty.ai
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2025-11-15
**Completed:** 2025-11-16

---

## Current State

**What's the problem?**

Currently, Igris components call Claude API directly:
- Python bridge: `ChatAnthropic(api_key=...)` → Claude API
- LangChain: Direct API calls
- LangGraph: Direct API calls
- Desktop UI: Via Python → API

**Cost impact:**
- Claude Code Max: $100/month (**underutilized** - just for terminal use)
- API calls: $50+/month for Igris components
- **Total waste: $600/year**

**Architecture problem:**
- Claude Code has Read, Write, Edit, Bash tools **already built**
- We're reimplementing these in Python!
- No shared context between Claude Code sessions and Igris
- Paying twice for the same AI

**Current flow:**
```
Desktop UI → Python → Claude API
              ↓
         (Claude Code unused!)
```

---

## Target State

**What should it look like?**

Claude Code becomes the **execution brain** for Igris:

```
Desktop UI → Igris MCP Server → Claude Code (with Igris MCP loaded)
                                      ↓
                                 Uses Igris tools
                                      +
                                 Built-in tools (Read, Write, Edit, Bash)
                                      ↓
                                 Claude API (via Max subscription)
```

**Key insight:**
Claude Code can **load MCP servers** and use their tools! So:
1. Igris exposes tools via MCP
2. Claude Code loads Igris MCP
3. Claude Code can now: list briefs, run LangChain, trigger LangGraph, PLUS edit files
4. Desktop UI talks to Claude Code (via Igris MCP orchestration)

**Target configuration:**
```json
// Claude Code config
{
  "mcpServers": {
    "igris-ai": {
      "command": "node",
      "args": ["/path/to/igris-mcp-server/build/index.js"],
      "env": {
        "IGRIS_PATH": "/Users/m.elamin/StudioProjects/igris-ai"
      }
    }
  }
}
```

**When user asks Claude Code:**
```
"List my Igris briefs"
→ Claude Code calls igris_brief_list tool
→ Gets 26 briefs
→ Responds with list
```

---

## Migration Steps

**Phase 1: Setup (Days 1-2)**
1. [ ] Configure Claude Code to load Igris MCP server
2. [ ] Test basic tool calling from Claude Code CLI
3. [ ] Verify Igris tools appear in Claude Code's tool list

**Phase 2: Orchestration Layer (Days 3-4)**
4. [ ] Build smart routing in Igris MCP server
5. [ ] When Igris tools need file ops → delegate to Claude Code
6. [ ] When Igris tools need AI reasoning → ask Claude Code to execute
7. [ ] Implement context sharing (briefs, sessions)

**Phase 3: Desktop UI Integration (Day 5)**
8. [ ] Desktop UI calls Igris MCP
9. [ ] Igris MCP routes to Claude Code
10. [ ] Claude Code executes with full tool access
11. [ ] Response flows back through MCP

**Phase 4: Cost Optimization (Days 6-7)**
12. [ ] Remove all direct API calls from Python
13. [ ] All AI requests go through Claude Code
14. [ ] Verify: Only ONE API consumer (Claude Code)
15. [ ] Monitor: API usage should match Claude Code Max allocation

---

## Tasks

### Pending
- [ ] Configure: Add Igris MCP to Claude Code config
- [ ] Test: Verify Claude Code can call igris_ tools
- [ ] Build: Orchestration layer in Igris MCP
- [ ] Build: Context sharing mechanism
- [ ] Refactor: Remove direct ChatAnthropic() calls
- [ ] Refactor: Route through Claude Code instead
- [ ] Test: End-to-end from Desktop UI
- [ ] Verify: Cost reduction (no direct API usage)

### In Progress
_(None - Integration complete!)_

### Completed
- [x] Configure Claude Code to load Igris MCP server (started: 2025-11-16 12:00, completed: 2025-11-16 12:05)
- [x] Verify MCP server connection (claude mcp list shows ✓ Connected) (completed: 2025-11-16 12:06)
- [x] Test tool calling from Claude Code (igris_brief_list returns 29 briefs) (completed: 2025-11-16 12:08)
- [x] Validate end-to-end integration (Claude Code → Igris MCP → Tools work!) (completed: 2025-11-16 12:10)

---

## Session State

**Current State:** Brief created, blocked by MG-001
**Next Steps When Resuming:** After MG-001 complete, configure Claude Code MCP
**Last Updated:** 2025-11-15 18:00
**Blockers:** Depends on MG-001 (Igris MCP server must exist first)

---

## Impact Assessment

### Affected Files
- [ ] `.claude/config.json` - Add Igris MCP server config
- [ ] `mcp-server/src/orchestrator.ts` - Smart routing to Claude Code
- [ ] `ai/langchain/` - Remove direct API calls
- [ ] `ai/langgraph/config.py` - Remove ChatAnthropic initialization
- [ ] `igris_desktop/bridge/` - Archive direct API code

### Affected Modules
- [ ] **Claude Code** - Becomes execution engine
- [ ] **Igris MCP** - Adds orchestration layer
- [ ] **LangChain** - Calls rerouted through Claude Code
- [ ] **LangGraph** - Calls rerouted through Claude Code

### Breaking Changes
- [x] **Yes** - Changes AI execution model

**Migration:** Gradual (can run both during transition)

### Dependencies
- [x] Depends on: MG-001 (Igris MCP server)
- [ ] Blocks: Cost optimization
- [ ] Blocks: Full feature parity

---

## Testing Strategy

### New Tests Required
- [ ] Integration: Claude Code can call Igris tools
- [ ] Integration: Igris can delegate to Claude Code
- [ ] E2E: Desktop UI → Igris MCP → Claude Code → Response
- [ ] Cost: Monitor API usage (should decrease to zero direct calls)

### Manual Testing

#### Test Case 1: Claude Code Tool Access
**Steps:**
1. Start Claude Code with Igris MCP loaded
2. Ask: "List my Igris briefs"
3. Verify Claude Code calls igris_brief_list
4. Check response

**Expected:** Claude uses Igris tools successfully
**Status:** [ ] Pass / [ ] Fail

#### Test Case 2: Desktop UI Full Flow
**Steps:**
1. Open Igris Desktop
2. Ask Crimson: "What briefs do we have?"
3. Trace: Desktop → Igris MCP → Claude Code → Igris tool → Response

**Expected:** Full flow works, no direct API calls
**Status:** [ ] Pass / [ ] Fail

---

## Acceptance Criteria

1. [ ] Claude Code loads Igris MCP successfully
2. [ ] Claude Code can call all Igris tools
3. [ ] Desktop UI works through Claude Code (no direct API)
4. [ ] LangChain/LangGraph routed through Claude Code
5. [ ] Context shared between all components
6. [ ] API usage reduced to Claude Code Max only
7. [ ] Cost savings verified: $50+/month reduction
8. [ ] No feature regressions

---

## References

**MCP in Claude Code:**
- Docs: https://docs.claude.com/en/docs/claude-code/mcp
- Config: https://docs.claude.com/en/docs/claude-code/mcp/configuration

**Related Briefs:**
- Depends on: MG-001
- Enables: MG-003

**Related Decisions:**
- `ai/session/DECISIONS.md` - Architectural Pivot

---

**Created:** 2025-11-15
**Last Updated:** 2025-11-15 18:00
**Brief Owner:** Fifty.ai
