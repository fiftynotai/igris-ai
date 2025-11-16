# Igris AI v3.0 Architecture

**Version:** 3.0.0
**Status:** ACTIVE
**Completed:** 2025-11-16

---

## Overview

Igris AI v3.0 uses **Model Context Protocol (MCP)** as the foundation for multi-client AI assistant architecture.

**Core Principle:** One MCP server, infinite clients, shared intelligence.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    IGRIS ECOSYSTEM                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ Desktop UI   │  │ Mobile UI    │  │ Terminal     │ │
│  │ (macOS/Win)  │  │ (iOS/Andr)   │  │ (CLI)        │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘ │
│         │                  │                  │         │
│         │ HTTP API         │ MCP Client       │ Direct  │
│         │ Wrapper          │ (Future)         │ Access  │
│         │                  │                  │         │
│         └──────────┬───────┴──────────────────┘         │
│                    ↓                                     │
│         ┌──────────────────────────┐                    │
│         │   Claude Code (Brain)    │                    │
│         │   - AI Reasoning         │                    │
│         │   - Tool Orchestration   │                    │
│         │   - Context Management   │                    │
│         └──────────┬───────────────┘                    │
│                    ↓                                     │
│         ┌──────────────────────────┐                    │
│         │  Igris MCP Server        │                    │
│         │  (17 Tools via stdio)    │                    │
│         ├──────────────────────────┤                    │
│         │  • Brief Management (5)  │                    │
│         │  • Session Tracking (2)  │                    │
│         │  • File Operations (1)   │                    │
│         │  • Git Operations (4)    │                    │
│         │  • LangChain AI (2)      │                    │
│         │  • LangGraph Agents (3)  │                    │
│         └──────────┬───────────────┘                    │
│                    ↓                                     │
│         ┌──────────────────────────┐                    │
│         │  Data Layer              │                    │
│         │  • ai/briefs/            │                    │
│         │  • ai/session/           │                    │
│         │  • Git repository        │                    │
│         │  • Project files         │                    │
│         └──────────────────────────┘                    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Current State (v3.0.0)

### ✅ **Completed Migrations:**

**MG-001: Igris MCP Server Foundation**
- 17 tools operational
- TypeScript with MCP SDK v1.22.0
- stdio transport
- Type-safe with Zod validation

**MG-002: Claude Code Integration**
- Claude Code loads Igris MCP
- All 17 tools accessible
- No duplicate API costs
- Shared context across sessions

**MG-003: Desktop UI Validation**
- Existing HTTP bridge works
- Claude API wrapper functional
- Desktop UI operational
- Crimson personality active

### ⏳ **Planned (Future):**

**FR-004: Mobile-Ready Architecture** (Next)
- Add `igris_chat` tool to MCP server
- Build `fifty_mcp_client` Dart package
- Mobile apps can connect via MCP
- Same intelligence, different interface

---

## Client Implementation Strategies

### **Desktop UI (Current - Phase 1)**

**Approach:** HTTP → Claude API Wrapper

```dart
// Desktop uses existing HTTP bridge
final response = await http.post(
  Uri.parse('http://localhost:8765/chat'),
  body: jsonEncode({'message': userMessage}),
);
// → Python bridge → Claude API (with Igris MCP context)
```

**Why this works:**
- ✅ Already built and working
- ✅ Gets AI + Igris tools together
- ✅ Fast (no refactor needed)
- ✅ Claude Code has Igris MCP loaded

---

### **Mobile UI (Future - Phase 2)**

**Approach:** Dart MCP Client → igris_chat tool

```dart
// Mobile uses native MCP client
final mcpClient = FiftyMCPClient(
  serverUrl: 'igris-mcp-server',
  transport: StdioTransport(),
);

final response = await mcpClient.callTool('igris_chat', {
  'message': userMessage,
  'session_id': sessionId,
});
// → Igris MCP → igris_chat tool → Claude API
```

**Why this works:**
- ✅ No HTTP server needed (direct MCP)
- ✅ Works offline for data queries
- ✅ igris_chat tool provides AI
- ✅ Portable to iOS/Android
- ✅ Same Igris MCP server!

---

### **Terminal (Current - Built-in)**

**Approach:** Direct (Claude Code with Igris MCP)

```
You: "List my Igris briefs"
Claude Code: [calls igris_brief_list]
→ Returns 29 briefs
```

**Already works!** This is where we are NOW.

---

## Tool Categories

### **1. Brief Management (5 tools)**
- `igris_brief_list` - List with filters
- `igris_brief_read` - Read by ID
- `igris_brief_create` - Create new
- `igris_brief_update` - Update status/priority
- `igris_brief_archive` - Archive completed

### **2. Session Tracking (2 tools)**
- `igris_session_get` - Current session
- `igris_session_update` - Update state

### **3. File Operations (1 tool)**
- `igris_file_read` - Read project files

### **4. Git Operations (4 tools)**
- `igris_git_status` - Git status
- `igris_git_diff` - Git diff
- `igris_git_log` - Commit history
- `igris_git_commit` - Create commits

### **5. LangChain AI (2 tools)**
- `igris_langchain_generate_brief` - AI brief generation
- `igris_langchain_analyze_code` - Code analysis with RAG

### **6. LangGraph Agents (3 tools)**
- `igris_langgraph_code_review` - Autonomous review
- `igris_langgraph_implementation` - Autonomous coding
- `igris_langgraph_planning` - Autonomous planning

### **7. AI Chat (Future - 1 tool)**
- `igris_chat` - Conversational AI with full Igris context

**Total:** 18 tools (17 operational + 1 planned)

---

## Mobile Experience (Future State)

### **What Mobile Can Do:**

**Triage & Planning:**
```
You (phone): "Register bug: API timeout on login"
Igris: ✅ Created BR-055 (P1-High)
       Analyzed similar issues
       Recommended fix: Increase timeout + add retry
       Brief ready for implementation when you're at laptop
```

**Status & Context:**
```
You (phone): "What's my current work?"
Igris: Working on MG-003 (Desktop UI)
       2/5 tasks complete
       Next: Test chat flow
       ETA: 2 hours remaining
```

**Code Review:**
```
You (phone): "Review auth_service.dart"
Igris: Found 3 issues:
       1. Missing null check (line 45)
       2. Hardcoded timeout (should be config)
       3. No error handling

       Want me to create a brief?
```

### **What Mobile Defers to Laptop:**

**Implementation:**
```
You (phone): "Implement BR-055"
Igris: I've got the plan ready, Partner!
       Code modifications need your laptop.

       I've added implementation notes to BR-055.
       When you're back, say "implement BR-055" and
       I'll modify the files, add tests, and commit! ✅
```

**Why:** Code lives on laptop, not cloud (security + simplicity)

---

## Cost Model

### **Before v3.0:**
- Claude Code Max: $100/month (underutilized)
- Direct API calls: $50+/month (Igris components)
- **Total: $150+/month**

### **After v3.0:**
- Claude Code Max: $100/month (fully utilized with Igris MCP)
- Direct API calls: $0/month
- **Total: $100/month**

**Annual Savings: $600+** 💰

---

## Technology Stack

**MCP Server:**
- Language: TypeScript
- Framework: @modelcontextprotocol/sdk v1.22.0
- Transport: stdio
- Validation: Zod schemas

**AI Integration:**
- Brain: Claude Code (with Igris MCP loaded)
- LangChain: Python modules (via subprocess)
- LangGraph: Python agents (via subprocess)

**Clients:**
- Desktop: Flutter + HTTP bridge (current)
- Mobile: Flutter + Dart MCP client (planned)
- Terminal: Claude Code CLI (built-in)

---

## Migration Timeline

**Completed (2025-11-16):**
- ✅ MG-001: Igris MCP Server (2 hours)
- ✅ MG-002: Claude Code Integration (10 min)
- ✅ MG-003: Desktop UI Validation (5 min)

**Total Pivot Time:** ~2.5 hours (estimated 3 weeks!)

**Planned (Future Sessions):**
- FR-004: Mobile MCP Client + igris_chat tool (1-2 days)
- FR-005: Phone app with Igris companion (1 week)

---

## Strategic Benefits

1. **Multi-Platform:** Same Igris, everywhere
2. **Cost Efficient:** One AI subscription
3. **Industry Standard:** MCP protocol
4. **Extensible:** Easy to add tools/clients
5. **Shared Context:** All devices see same data
6. **Future-Proof:** Mobile, web, IDE plugins all possible

---

## Next Steps

**Immediate:**
- Desktop UI: Working with HTTP bridge ✅
- Terminal: Working via Claude Code ✅

**Next Session:**
- Add `igris_chat` tool to MCP server
- Build `fifty_mcp_client` package (pub.dev)
- Enable mobile companion experience

---

**Built with FIRE by Crimson** 🔥🐒
**Developed by:** Fifty.ai
**Powered by:** Model Context Protocol + Claude Code

---

**The pivot is COMPLETE. The future is BRIGHT. Igris v3.0 is LIVE!** ⚡
