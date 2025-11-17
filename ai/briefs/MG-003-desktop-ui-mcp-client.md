# MG-003: Desktop UI as MCP Client

**Type:** Migration
**Priority:** P1-High
**Effort:** M-Medium (3-5 days)
**Assignee:** Igris AI + Fifty.ai
**Commanded By:** Fifty.ai
**Status:** In Progress - Phase 2 Implementation
**Created:** 2025-11-15
**Started:** 2025-11-16

---

## Current State

**Problem:**

Desktop UI currently uses custom HTTP to talk to Python bridge:

```dart
// Current (custom HTTP protocol)
final response = await http.post(
  Uri.parse('http://localhost:8765/chat'),
  body: jsonEncode({'message': message}),
);
```

This is:
- ❌ Not MCP standard
- ❌ Tied to our custom Python server
- ❌ Can't work with other MCP servers
- ❌ Reimplements protocol logic

---

## Target State

**Goal:** Desktop UI becomes pure data dashboard (MCP client for data, not AI chat)

**Strategic Decision (2025-11-16):**
- ❌ NO AI chat in Desktop UI (that's Terminal/Claude Code)
- ✅ Pure data display via MCP tools
- ✅ No Claude API costs
- ✅ Clean separation: Terminal = AI, Desktop = Data

**Desktop UI becomes:**
```dart
// Pure MCP data client
final mcpClient = MCPClient(
  transport: StdioTransport('igris-mcp-server'),
);

// Display briefs
final briefs = await mcpClient.callTool('igris_brief_list', {'status': 'In Progress'});
// Show in UI

// Display git status
final gitStatus = await mcpClient.callTool('igris_git_status', {});
// Show in UI

// Display session
final session = await mcpClient.callTool('igris_session_get', {});
// Show in UI
```

**Benefits:**
- ✅ No AI API costs (saves $360/year)
- ✅ Simpler implementation (just data display)
- ✅ Clean architecture (Terminal = AI, Desktop = Dashboard)
- ✅ Full MCP tool access (17 tools for data)
- ✅ Fast and responsive (no AI latency)

---

## Migration Steps

**Phase 1: MCP Client Library (Days 1-2)**
1. [ ] Add Dart MCP client library to pubspec.yaml
2. [ ] Create MCPService wrapper
3. [ ] Test connection to igris-mcp-server
4. [ ] Implement tool calling abstraction

**Phase 2: Refactor Services (Day 3)**
5. [ ] Replace IgrisBridgeService with MCPService
6. [ ] Update ChatController to use MCP tools
7. [ ] Remove HTTP dependencies
8. [ ] Update error handling for MCP responses

**Phase 3: Testing (Days 4-5)**
9. [ ] Test all chat functionality
10. [ ] Test brief listing
11. [ ] Test session queries
12. [ ] End-to-end testing
13. [ ] Performance testing

---

## Tasks

### Pending

**Phase 3: Integration & UI (Next Session)**
- [ ] Add fifty_mcp_client to igris_desktop pubspec.yaml
- [ ] Create MCPService wrapper in igris_desktop
- [ ] Build BriefListScreen (display briefs via MCP)
- [ ] Build GitStatusScreen (display git via MCP)
- [ ] Build SessionScreen (display session via MCP)
- [ ] Remove old Python bridge code
- [ ] Remove AI chat UI (Terminal handles that!)
- [ ] End-to-end testing

### In Progress
_(None - Phase 2B complete, ready for Phase 3)_

### Completed

**Phase 1: Architecture Planning & Validation - COMPLETE ✅**
- [x] Validated Desktop UI Python bridge still functional (completed: 2025-11-16 12:15)
- [x] Confirmed chat works with Claude API (completed: 2025-11-16 12:16)
- [x] Documented v3.0 architecture (ARCHITECTURE_V3.md) (completed: 2025-11-16 12:20)
- [x] Strategic decision: Desktop HTTP wrapper, Mobile MCP client (completed: 2025-11-16 12:22)
- [x] **Reality check:** Desktop UI uses OLD bridge (direct API), NOT new MCP (completed: 2025-11-16 12:30)

**Phase 2A: Strategic Pivot - COMPLETE ✅**
- [x] Strategic pivot: Desktop = Data Dashboard, NOT AI chat (decided: 2025-11-16 12:45)

**Phase 2B: Build fifty_mcp_client Package - COMPLETE ✅** 🔥
- [x] Research Dart MCP client options (completed: 2025-11-17 11:20)
- [x] Design package architecture (completed: 2025-11-17 11:25)
- [x] Create package structure (completed: 2025-11-17 11:30)
- [x] Implement JSON-RPC 2.0 protocol (completed: 2025-11-17 11:35)
- [x] Implement exception types (completed: 2025-11-17 11:40)
- [x] Implement MCP models (completed: 2025-11-17 11:42)
- [x] Commit Phase 1 foundation (completed: 2025-11-17 11:45)
- [x] Implement stdio transport (completed: 2025-11-17 11:50)
- [x] Implement MCP client class (completed: 2025-11-17 11:55)
- [x] Implement handshake protocol (completed: 2025-11-17 11:55)
- [x] Implement tool discovery (completed: 2025-11-17 11:55)
- [x] Implement tool calling (completed: 2025-11-17 11:55)
- [x] Create working example (completed: 2025-11-17 12:00)
- [x] **LIVE TEST: Connected to igris-mcp-server successfully!** (completed: 2025-11-17 12:05)
- [x] **LIVE TEST: Listed all 17 tools!** (completed: 2025-11-17 12:05)
- [x] **LIVE TEST: Called igris_git_status - SUCCESS!** (completed: 2025-11-17 12:05)
- [x] Commit Phase 2 working client (completed: 2025-11-17 12:10)

---

## Session State

**Current State:** fifty_mcp_client v0.1.0 COMPLETE & VALIDATED! Ready for igris_desktop integration
**Next Steps:** Integrate fifty_mcp_client into igris_desktop, build data dashboard UI (separate session)
**Last Updated:** 2025-11-17 12:10
**Blockers:** None

**Major Achievement (2025-11-17):**
- ✅ Built complete Dart MCP client package (1,274+ lines)
- ✅ LIVE TESTED against igris-mcp-server - IT WORKS!
- ✅ Connected, listed 17 tools, called tools successfully
- ✅ 2 commits: Phase 1 foundation + Phase 2 working client
- ✅ Package: /Users/m.elamin/StudioProjects/fifty_mcp_client
- ✅ Repository: Ready for GitHub (fifty-ai/fifty_mcp_client)

**Revised Scope:**
- Desktop UI will be: Data dashboard (MCP client for data tools)
- Desktop UI will NOT be: AI chat interface (that's Terminal/Claude Code!)
- Cost savings: Achieved ($360/year by eliminating Desktop AI)
- MCP Client: COMPLETE - ready for integration!

---

## Impact Assessment

### Affected Files
- [ ] `lib/services/igris_bridge_service.dart` → Archive
- [ ] `lib/services/mcp_service.dart` → Create (NEW)
- [ ] `lib/features/chat/chat_controller.dart` → Update to use MCP
- [ ] `pubspec.yaml` → Add MCP client package
- [ ] `bridge/` → Archive entire directory

### Dependencies
- [x] Depends on: MG-001 (Igris MCP server must exist)
- [x] Depends on: MG-002 (Claude Code integration for full power)

---

## Acceptance Criteria

1. [ ] Desktop UI connects to Igris MCP server
2. [ ] All chat functionality works via MCP
3. [ ] Can list/read briefs via MCP tools
4. [ ] Can query session via MCP tools
5. [ ] HTTP bridge code archived
6. [ ] No regressions in UI/UX
7. [ ] Ready to add Phone/Web clients (same MCP protocol)

---

## References

**MCP Client:**
- Dart MCP client: TBD (may need to build)
- MCP protocol: https://spec.modelcontextprotocol.io/

**Related Briefs:**
- Depends on: MG-001, MG-002

---

**Created:** 2025-11-15
**Last Updated:** 2025-11-15 18:00
**Brief Owner:** Fifty.ai
