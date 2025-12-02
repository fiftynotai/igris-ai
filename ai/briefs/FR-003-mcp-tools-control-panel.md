# FR-003: MCP Tools Control Panel for igris_desktop

**Type:** Feature Request
**Priority:** P2-Medium
**Effort:** M-Medium (1-2 days)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2025-11-17
**Started:** 2025-11-22
**Completed:** 2025-11-22

---

## Feature Description

**What is the proposed feature?**

A visual control panel in igris_desktop that allows users to manually discover and invoke ANY MCP tool exposed by igris-mcp-server. Users can browse all 17 tools, see their input schemas, provide arguments via UI forms, and execute them with button clicks.

**Why is this valuable?**

igris_desktop is a DATA DASHBOARD (not AI chat). Users should be able to interact with Igris AI capabilities directly through a UI without typing commands or talking to AI. This turns the MCP server into a controllable API with a visual interface.

---

## User Value

### Who Benefits?
- [x] End users (developers using Igris AI)
- [x] Developers (building with Igris AI)
- [ ] Contributors (extending Igris AI)
- [x] System (Igris AI itself - makes tools discoverable)

### Pain Point Solved

**Current situation:**
- Users can only access MCP tools through:
  1. Terminal (Claude Code) - requires AI conversation
  2. Test screens (hard-coded specific tools)
  3. Command line (node dist/index.js) - no UI

**With this feature:**
- Click "Tools" in sidebar
- See all 17 MCP tools with descriptions
- Fill in arguments via UI forms
- Click "Execute" and see results
- Manual, predictable, controllable

---

## Use Cases

### Use Case 1: Create Brief via UI
**Actor:** Developer
**Goal:** Create a new brief without typing commands
**Steps:**
1. Open igris_desktop
2. Click "Tools" in sidebar
3. Select "igris_brief_create" from tool list
4. Fill in form:
   - Brief type: "BR" (dropdown)
   - Title: "Fix login bug"
   - Priority: "P1" (dropdown)
5. Click "Execute"
6. See success message with brief ID

**Expected Outcome:** Brief created, user sees confirmation

### Use Case 2: Trigger Code Review
**Actor:** Developer
**Goal:** Run LangGraph code review agent manually
**Steps:**
1. Open igris_desktop
2. Click "Tools" → "igris_langgraph_code_review"
3. Fill in form:
   - File paths: "lib/auth/"
   - Guidelines: "Check for security issues"
4. Click "Execute"
5. See review results in output panel

**Expected Outcome:** Code review runs, results displayed

### Use Case 3: Browse Available Tools
**Actor:** New Igris AI user
**Goal:** Discover what Igris can do
**Steps:**
1. Open igris_desktop
2. Click "Tools" in sidebar
3. Browse list of 17 tools with descriptions
4. Click a tool to see input schema
5. Understand capabilities without documentation

**Expected Outcome:** User discovers Igris features organically

---

## Technical Approach

### High-Level Design

**UI Components:**
1. **ToolsScreen** - Main control panel
2. **Tool List** - Scrollable list of all 17 tools (from `mcpService.listTools()`)
3. **Tool Detail Panel** - Shows selected tool's description + input schema
4. **Dynamic Form Generator** - Builds UI form from JSON Schema
5. **Execution Panel** - Shows results/errors

**Flow:**
```
User opens Tools screen
  ↓
MCPService.initialize() + listTools()
  ↓
Display tool cards (17 tools)
  ↓
User clicks a tool
  ↓
Generate form from inputSchema
  ↓
User fills form + clicks Execute
  ↓
Call mcpService.callTool(name, args)
  ↓
Display result
```

### Components Affected
- **NEW:** `lib/screens/tools_screen.dart` - Main control panel
- **NEW:** `lib/widgets/tool_card.dart` - Tool list item
- **NEW:** `lib/widgets/dynamic_form.dart` - JSON Schema → Flutter form
- **NEW:** `lib/widgets/tool_result_panel.dart` - Result display
- **MODIFY:** `lib/main.dart` - Add Tools to sidebar navigation

### Example UI

```
┌─────────────────────────────────────────┐
│ 🛠️  MCP Tools Control Panel            │
├─────────────────────────────────────────┤
│ TOOLS (17)                              │
│                                         │
│ ┌───────────────────────────────────┐ │
│ │ 📋 igris_brief_create             │ │
│ │ Create a new Igris brief          │ │
│ └───────────────────────────────────┘ │
│                                         │
│ ┌───────────────────────────────────┐ │
│ │ 📊 igris_git_status               │ │
│ │ Get git status (short format)     │ │
│ └───────────────────────────────────┘ │
│                                         │
│ [When tool selected →]                  │
│                                         │
│ ┌─── INPUT ──────────────────────┐    │
│ │ Brief Type: [BR ▼]             │    │
│ │ Title: [________________]      │    │
│ │ Priority: [P1 ▼]               │    │
│ │                                 │    │
│ │ [Execute Tool 🔥]               │    │
│ └─────────────────────────────────┘    │
│                                         │
│ ┌─── RESULT ─────────────────────┐    │
│ │ ✅ Brief created: BR-012        │    │
│ └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

---

## Context & Inputs

### Dependencies
- [x] Existing: fifty_mcp_client (already integrated)
- [x] Existing: MCPService (already created)
- [ ] New package: None (use Flutter built-in form widgets)

### Files to Create
- `lib/screens/tools_screen.dart` - Main control panel
- `lib/widgets/tool_card.dart` - Tool list item widget
- `lib/widgets/dynamic_form.dart` - JSON Schema to Flutter form generator
- `lib/widgets/tool_result_panel.dart` - Result/error display

### Files to Modify
- `lib/main.dart` - Add "Tools" nav item to sidebar

### Configuration Changes
- None (uses existing MCPService)

---

## Alternatives Considered

### Alternative 1: Pre-built Forms for Each Tool
**Pros:**
- ✅ More polished UI per tool
- ✅ Better validation

**Cons:**
- ❌ 17 separate screens to build
- ❌ Not scalable (new tools require new screens)
- ❌ Maintenance nightmare

**Why not chosen:** Dynamic form generation is more scalable

### Alternative 2: Command Palette (Text Input)
**Pros:**
- ✅ Fast to build
- ✅ Power user friendly

**Cons:**
- ❌ Not discoverable
- ❌ Requires memorizing tool names
- ❌ No visual schema

**Why not chosen:** UI forms are more user-friendly

---

## Constraints

### Technical Constraints
- Must work with ANY MCP tool (not hard-coded to 17)
- Must generate forms from JSON Schema dynamically
- Must handle all JSON Schema types (string, number, enum, object, array)
- Must work offline (local MCP server)

### UX Constraints
- Must be intuitive (no training required)
- Must show tool descriptions clearly
- Must provide clear feedback (loading, success, error)
- Must not require knowledge of MCP protocol

### Timeline
- **Deadline:** N/A
- **Milestone:** After dashboard screens complete

### Out of Scope
- Custom UI per tool (use generic forms)
- Tool history/favorites
- Batch tool execution
- Tool chaining/workflows

---

## Tasks

### Pending
_(None - All development tasks complete!)_

### In Progress
_(None - All complete!)_

### Completed
- [x] Test with all 17 tools (completed: 2025-11-22 09:30)
- [x] Create ToolsScreen layout with tool list (completed: 2025-11-22 06:05)
- [x] Add "Tools" nav item to sidebar (completed: 2025-11-22 06:08)
- [x] Implement tool discovery (listTools on init) (completed: 2025-11-22 06:08)
- [x] Build ToolCard widget for list items (completed: 2025-11-22 06:08)
- [x] Loading states (completed: 2025-11-22 06:08)
- [x] Create DynamicFormGenerator (JSON Schema → Flutter widgets) (completed: 2025-11-22 06:15)
- [x] Handle string, enum, number, boolean types (completed: 2025-11-22 06:15)
- [x] Handle nested objects and arrays (completed: 2025-11-22 06:15)
- [x] Build ToolResultPanel for output display (completed: 2025-11-22 06:25)
- [x] Error handling for invalid inputs (completed: 2025-11-22 06:25)

---

## Session State (Tactical - This Brief)

**Current State:** ✅ SHIPPED - v1.0 COMPLETE
**Next Steps When Resuming:** N/A - Brief complete, marked Done, committed
**Last Updated:** 2025-11-22 09:35
**Blockers:** None
**Commits:**
- igris-ai: cc251ee
- igris_desktop: 71cc9fa

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] ToolsScreen shows all 17 MCP tools
2. [ ] User can click a tool to see details
3. [ ] Dynamic form generated from inputSchema
4. [ ] User can fill form and execute tool
5. [ ] Results displayed in output panel
6. [ ] Errors shown clearly
7. [ ] Works with ANY MCP tool (not hard-coded)
8. [ ] Navigation added to sidebar
9. [ ] No regressions in existing screens

---

## Test Plan

### Functional Tests

**Test Case 1: Execute igris_git_status**
**Steps:**
1. Open Tools screen
2. Click "igris_git_status"
3. Click "Execute" (no args needed)
4. See git status output

**Expected Result:** Git status displayed
**Status:** [ ] Pass / [ ] Fail

**Test Case 2: Create Brief via Form**
**Steps:**
1. Open Tools screen
2. Click "igris_brief_create"
3. Fill form: type=BR, title="Test", priority=P2
4. Click "Execute"
5. See success message

**Expected Result:** Brief created
**Status:** [ ] Pass / [ ] Fail

**Test Case 3: Handle Tool Error**
**Steps:**
1. Click "igris_brief_read"
2. Enter invalid brief_id: "XX-999"
3. Click "Execute"
4. See error message

**Expected Result:** Error displayed clearly
**Status:** [ ] Pass / [ ] Fail

### Regression Tests
- [ ] Briefs screen still works
- [ ] Git screen still works
- [ ] Session screen still works
- [ ] Navigation works

---

## Delivery

### Documentation
- [ ] Add Tools screen to README
- [ ] Screenshot of Tools UI
- [ ] Example use cases

### Announcement
- [ ] Changelog: "Added MCP Tools Control Panel"
- [ ] Release notes: Highlight manual tool execution

---

## Success Metrics

**How will we know this feature is valuable?**

- Users discover tools they didn't know existed
- Reduces need to ask "how do I create a brief?"
- Makes Igris AI more accessible (visual vs command-line)

---

## Notes

**Inspiration:**
- Postman (API testing UI)
- GraphQL Playground (query builder)
- MCP Inspector (tool testing)

**Future Enhancements:**
- Tool favorites/recent
- Save argument presets
- Tool history
- Batch execution
- Tool chaining (pipe output → input)

**Implementation Note:**
JSON Schema dynamic form generation is the KEY challenge. Start simple:
- Phase 1: string, enum, number, boolean
- Phase 2: objects, arrays
- Phase 3: advanced validation

---

**Created:** 2025-11-17
**Last Updated:** 2025-11-17
**Brief Owner:** Fifty.ai
