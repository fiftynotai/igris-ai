# Claude Code + Igris MCP Integration

**Status:** ✅ COMPLETE
**Completed:** 2025-11-16
**Updated:** 2025-12-03 (v3.2)
**Brief:** MG-002

---

## Overview

Igris MCP Server is integrated with Claude Code, enabling Claude to access Igris tools directly!

**What this means:**
- Claude Code can list, read, create, update briefs
- Claude Code has git operations (status, diff, log, commit)
- All through industry-standard MCP protocol

---

## v3.2 Update

In v3.2, Igris AI moved from external LangChain/LangGraph plugins to **native Claude Code subagents**:

| Old Approach (v2.5) | New Approach (v3.2) |
|---------------------|---------------------|
| LangChain via MCP tools | Native Claude Code |
| LangGraph via MCP tools | Native subagents |
| External API calls | Zero additional cost |
| 17 MCP tools | 12 MCP tools (data) + 12 subagents (AI) |

**Result:** Same capabilities, simpler architecture, zero external AI costs.

---

## Configuration

### Setup Command

```bash
claude mcp add --transport stdio igris-ai -- node /path/to/igris-ai/mcp-server/dist/index.js
```

### Verify Connection

```bash
claude mcp list
```

**Expected output:**
```
igris-ai: node /Users/.../mcp-server/dist/index.js - ✓ Connected
```

---

## Available Tools in Claude Code (12)

Once configured, Claude Code has access to **12 Igris MCP tools**:

### Brief Management (5)
- `igris_brief_list` - List all briefs
- `igris_brief_read` - Read specific brief
- `igris_brief_create` - Create new brief
- `igris_brief_update` - Update status/priority
- `igris_brief_archive` - Archive completed briefs

### Session Management (2)
- `igris_session_get` - Get current session
- `igris_session_update` - Update session state

### File Operations (1)
- `igris_file_read` - Read project files

### Git Operations (4)
- `igris_git_status` - Git status
- `igris_git_diff` - Git diff
- `igris_git_log` - Git log
- `igris_git_commit` - Create commits

---

## Native Subagents (12)

AI workflows are now handled by native Claude Code subagents instead of MCP tools:

| Tier | Agents |
|------|--------|
| 1 - Core | ARCHITECT (planner), FORGER (coder), SENTINEL (tester), WARDEN (reviewer) |
| 2 - Docs | CHRONICLER (documenter), HERALD (releaser), LAWKEEPER (standardizer) |
| 3 - Maintenance | INQUISITOR (auditor), MENDER (debugger), PATHFINDER (migrator) |
| 4 - Innovation | ORACLE (ideator), SEEKER (explorer) |

**Trigger:** Use HUNT workflow or DIGIVOLVE command to invoke subagents.

---

## Usage Examples

### Example 1: List Briefs

**You ask:** "Show me all P0 briefs"

**Claude Code:**
1. Calls `igris_brief_list` with `{"priority": "P0"}`
2. Gets filtered list
3. Responds with results

### Example 2: Read Current Session

**You ask:** "What am I working on?"

**Claude Code:**
1. Calls `igris_session_get`
2. Reads CURRENT_SESSION.md
3. Shows active briefs and status

### Example 3: Git Status

**You ask:** "What files have changed?"

**Claude Code:**
1. Calls `igris_git_status`
2. Gets git status output
3. Shows modified/untracked files

### Example 4: Code Review (v3.2 Native)

**You ask:** "Review my changes"

**Claude Code:**
1. Uses native `reviewer` subagent (WARDEN)
2. Analyzes code against coding_guidelines.md
3. Provides feedback directly

---

## Architecture Flow

```
You (in Claude Code CLI)
    ↓
Claude Code (with Igris MCP loaded)
    ↓
┌─────────────────────────────────────┐
│  For DATA operations:               │
│  Igris MCP Server (stdio)           │
│    → briefs, session, git, files    │
├─────────────────────────────────────┤
│  For AI operations:                 │
│  Native Claude Code subagents       │
│    → review, test, plan, implement  │
└─────────────────────────────────────┘
    ↓
Response formatted and displayed
```

---

## Benefits Achieved

✅ **Cost Savings:** Claude Code Max subscription fully utilized
✅ **No Duplicate API Calls:** All AI through Claude Code
✅ **Shared Context:** Briefs accessible in all Claude sessions
✅ **Standard Protocol:** MCP enables any client to connect
✅ **Simplified Architecture:** Data via MCP, AI via native subagents
✅ **Future-Proof:** Easy to add more tools

---

## Migration from v2.5

If you were using LangChain/LangGraph MCP tools:

| Old Tool | v3.2 Replacement |
|----------|------------------|
| `igris_langchain_generate_brief` | Use main agent: "Register a brief for..." |
| `igris_langchain_analyze_code` | Use native subagents |
| `igris_langgraph_code_review` | WARDEN (reviewer) subagent |
| `igris_langgraph_implementation` | HUNT workflow |
| `igris_langgraph_planning` | ARCHITECT (planner) subagent |

---

**Integration Time:** 10 minutes
**Result:** Full Claude Code + Igris MCP working!
**Cost Impact:** Zero external AI costs with native subagents

**🔥 The pivot is REAL. The architecture WORKS. Igris v3.2 is LIVE!** 🚀
