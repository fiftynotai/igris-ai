# Igris AI v1.0 - Complete System Architecture

**Generated:** 2025-12-01
**Version:** 1.0.0
**Status:** Production Ready

---

## 🌐 HIGH-LEVEL ARCHITECTURE

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          IGRIS AI ECOSYSTEM v1.0                             │
│                    "Structure over Chaos" - AI Engineering Platform           │
└─────────────────────────────────────────────────────────────────────────────┘

                                  ┌─────────────┐
                                  │   USERS     │
                                  │  (Devs)     │
                                  └──────┬──────┘
                                         │
                 ┌───────────────────────┼───────────────────────┐
                 │                       │                       │
                 ▼                       ▼                       ▼
        ┌────────────────┐     ┌────────────────┐     ┌────────────────┐
        │  Claude Code   │     │ igris_desktop  │     │  Terminal      │
        │  (VS Code)     │     │  (Flutter App) │     │  (Future)      │
        │                │     │                │     │                │
        │  • Code editor │     │  • Data UI     │     │  • CLI         │
        │  • AI brain    │     │  • Visual ops  │     │  • Batch ops   │
        │  • MCP client  │     │  • MCP client  │     │  • MCP client  │
        └───────┬────────┘     └───────┬────────┘     └───────┬────────┘
                │                      │                      │
                └──────────────────────┼──────────────────────┘
                                       │
                            ┌──────────▼──────────┐
                            │  MCP PROTOCOL       │
                            │  (stdio transport)  │
                            └──────────┬──────────┘
                                       │
┌──────────────────────────────────────▼──────────────────────────────────────┐
│                         IGRIS MCP SERVER (Node.js)                           │
│                         TypeScript v3.0.0 | 1,318 lines                      │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                        17 MCP TOOLS (6 Categories)                     │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                         │  │
│  │  [Brief Management - 5 tools]        [Session Management - 2 tools]   │  │
│  │  • igris_brief_list                  • igris_session_get              │  │
│  │  • igris_brief_read                  • igris_session_update           │  │
│  │  • igris_brief_create                                                 │  │
│  │  • igris_brief_update                [File Operations - 1 tool]       │  │
│  │  • igris_brief_archive               • igris_file_read                │  │
│  │                                                                         │  │
│  │  [Git Operations - 4 tools]                                            │  │
│  │  • igris_git_status                  ┌──────────────────────────────┐ │  │
│  │  • igris_git_diff                    │  PLUGIN ENHANCEMENT HOOKS    │ │  │
│  │  • igris_git_log                     │  (Optional AI Layer)         │ │  │
│  │  • igris_git_commit                  └──────────────────────────────┘ │  │
│  │                                                ▲                        │  │
│  │  [AI Analysis - LangChain - 2 tools]          │                        │  │
│  │  • igris_langchain_generate_brief ────────────┤                        │  │
│  │  • igris_langchain_analyze_code ──────────────┤                        │  │
│  │                                                │                        │  │
│  │  [Multi-Agent - LangGraph - 3 tools]          │                        │  │
│  │  • igris_langgraph_code_review ───────────────┤                        │  │
│  │  • igris_langgraph_implementation ────────────┤                        │  │
│  │  • igris_langgraph_planning ──────────────────┘                        │  │
│  │                                                                         │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  Tool Execution Flow:                                                        │
│  1. Client requests tool (via MCP)                                           │
│  2. Server validates against JSON Schema                                     │
│  3. Tool handler executes (reads/writes Igris project)                       │
│  4. Optional: Enhancement hook triggers (LangChain/LangGraph)                │
│  5. Response returned to client                                              │
│                                                                               │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │  IGRIS PROJECT FILES  │
                    │  (Multi-Project)      │
                    └───────────┬───────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
        ▼                       ▼                       ▼
┌───────────────┐       ┌───────────────┐       ┌───────────────┐
│ ai/briefs/    │       │ ai/session/   │       │ ai/plugins/   │
│ (30 files)    │       │               │       │ (3 installed) │
│               │       │ • CURRENT_    │       │               │
│ • BR-* (8)    │       │   SESSION.md  │       │ • langchain   │
│ • FR-* (4)    │       │ • DECISIONS   │       │ • langgraph   │
│ • TD-* (13)   │       │ • BLOCKERS    │       │ • persona     │
│ • MG-* (3)    │       │ • LEARNINGS   │       │               │
│ • PI-* (2)    │       │               │       └───────────────┘
│               │       └───────────────┘
└───────────────┘
```

---

## 🔌 PLUGIN SYSTEM ARCHITECTURE

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        PLUGIN ENHANCEMENT LAYER                              │
│                         (Optional AI Capabilities)                           │
└─────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  PLUGIN 1: igris-langchain v1.0.0-alpha                            │
├────────────────────────────────────────────────────────────────────┤
│  Location: /Users/m.elamin/StudioProjects/igris-ai-langchain      │
│  Language: Python 3.9+                                             │
│  Dependencies: langchain ^0.1.0, anthropic, chromadb               │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  HOOKS (4 Enhancement Points)                               │  │
│  ├─────────────────────────────────────────────────────────────┤  │
│  │                                                             │  │
│  │  1. BRIEF_GENERATOR Hook                                    │  │
│  │     ├─ Script: ai/langchain/hooks/generate_brief.sh        │  │
│  │     ├─ Triggers: When user says "generate brief from..."   │  │
│  │     ├─ Input: Natural language description OR git diff     │  │
│  │     ├─ AI Model: Claude 3.5 Sonnet                         │  │
│  │     └─ Output: Structured brief JSON → MCP tool creates it │  │
│  │                                                             │  │
│  │  2. SYSTEM_ASSESSMENT Hook                                  │  │
│  │     ├─ Script: ai/langchain/hooks/system_assessment.sh     │  │
│  │     ├─ Triggers: On ARISE command (session start)          │  │
│  │     ├─ AI Model: Claude 3.5 Sonnet                         │  │
│  │     └─ Output: Enhanced recommendations with context       │  │
│  │                                                             │  │
│  │  3. CODE_REVIEWER Hook                                      │  │
│  │     ├─ Script: ai/langchain/hooks/code_review.sh           │  │
│  │     ├─ Triggers: Before git commit                         │  │
│  │     ├─ Checks: coding_guidelines.md compliance             │  │
│  │     └─ Output: Review report + suggestions                 │  │
│  │                                                             │  │
│  │  4. TEST_GENERATOR Hook                                     │  │
│  │     ├─ Script: ai/langchain/hooks/generate_tests.sh        │  │
│  │     ├─ Triggers: After implementation complete             │  │
│  │     └─ Output: Test scaffolding code                       │  │
│  │                                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  Core Features:                                                   │
│  • Codebase RAG (chromadb vector store)                          │
│  • Brief generation from diffs                                    │
│  • Code analysis against guidelines                               │
│  • Test generation                                                │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  PLUGIN 2: igris-langgraph v1.0.0                                  │
├────────────────────────────────────────────────────────────────────┤
│  Location: /Users/m.elamin/StudioProjects/igris-ai-langgraph      │
│  Language: Python 3.10+                                            │
│  Dependencies: langgraph ^0.1.0, anthropic                         │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  HOOKS (6 Autonomous Agents)                                │  │
│  ├─────────────────────────────────────────────────────────────┤  │
│  │                                                             │  │
│  │  1. AUTONOMOUS_IMPLEMENTER Hook                             │  │
│  │     ├─ Script: ai/langgraph/hooks/implement_brief.sh       │  │
│  │     ├─ Triggers: "Implement BR-XXX autonomously"           │  │
│  │     ├─ Agent Graph: Plan → Code → Test → Review → Commit  │  │
│  │     ├─ State Management: LangGraph state machine           │  │
│  │     └─ Output: Full implementation + commit                │  │
│  │                                                             │  │
│  │  2. MULTI_AGENT_REVIEWER Hook                               │  │
│  │     ├─ Script: ai/langgraph/hooks/code_review_multi.sh     │  │
│  │     ├─ Multi-Agent: Security + Performance + Style reviewers│ │
│  │     ├─ Consensus: Agents vote on approval                  │  │
│  │     └─ Output: Comprehensive review from 3 perspectives    │  │
│  │                                                             │  │
│  │  3. BRIEF_PLANNER Hook                                      │  │
│  │     ├─ Script: ai/langgraph/hooks/plan_briefs.sh           │  │
│  │     ├─ Triggers: Sprint planning mode                      │  │
│  │     ├─ Agent: Analyzes all Ready briefs                    │  │
│  │     └─ Output: Prioritized sprint plan (7-14 days)         │  │
│  │                                                             │  │
│  │  4. SELF_HEALER Hook                                        │  │
│  │     ├─ Script: ai/langgraph/hooks/self_heal.sh             │  │
│  │     ├─ Triggers: Test failures, protocol violations        │  │
│  │     ├─ Agent: Analyze → Fix → Validate → Commit            │  │
│  │     └─ Output: Self-correcting system behavior             │  │
│  │                                                             │  │
│  │  5. CONVERSATIONAL_REFINER Hook                             │  │
│  │     ├─ Script: ai/langgraph/hooks/refine_brief.sh          │  │
│  │     ├─ Triggers: Brief needs clarification                 │  │
│  │     └─ Output: Improved brief with better criteria         │  │
│  │                                                             │  │
│  │  6. MAINTENANCE_AGENT Hook                                  │  │
│  │     ├─ Script: ai/langgraph/hooks/maintenance.sh           │  │
│  │     ├─ Triggers: Scheduled or manual "run maintenance"     │  │
│  │     └─ Output: Code quality audit + new TD briefs          │  │
│  │                                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  Core Features:                                                   │
│  • Multi-agent coordination (LangGraph state machines)            │
│  • Autonomous workflows (no human intervention)                   │
│  • Agent consensus (multi-reviewer voting)                        │
│  • Self-healing (automatic error correction)                      │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  PLUGIN 3: igris-persona-cyber-monkey v1.0.0                       │
├────────────────────────────────────────────────────────────────────┤
│  Location: /tmp/igris-persona-cyber-monkey                         │
│  Language: Markdown + Shell                                        │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  HOOKS (1 Persona Enhancement)                              │  │
│  ├─────────────────────────────────────────────────────────────┤  │
│  │                                                             │  │
│  │  1. PERSONA_INJECTION Hook                                  │  │
│  │     ├─ Script: Injects Crimson persona into CLAUDE.md      │  │
│  │     ├─ Triggers: On igris_init.sh installation             │  │
│  │     ├─ Persona: Crimson (Cyber Monkey Guardian, Rookie)    │  │
│  │     ├─ Masks: none, half, light, full (4 intensity levels) │  │
│  │     └─ Output: Persona-branded Igris AI experience         │  │
│  │                                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  Personality Features:                                             │
│  • Crimson cyber monkey identity                                  │
│  • Fire/monkey emojis (🔥🐒⚡💥)                                   │
│  • Battle-ready tone (Digimon theme)                              │
│  • 4 mask levels (companion → battle mode)                        │
│  • Evolution commands (AWAKEN, HUNT, SCAN, etc.)                  │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

## 🔧 MCP SERVER INTERNAL ARCHITECTURE

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    IGRIS MCP SERVER (TypeScript)                             │
│                         mcp-server/src/                                      │
└─────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  index.ts (447 lines) - Main Server                                │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  class IgrisMCPServer {                                            │
│    - Handles MCP protocol                                          │
│    - Tool registration system                                      │
│    - Request routing                                               │
│    - Error handling                                                │
│  }                                                                 │
│                                                                    │
│  Environment Variables:                                            │
│  • IGRIS_PROJECT_PATH - Points to any Igris-enabled project       │
│    (enables multi-project support)                                 │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
                                  │
                ┌─────────────────┼─────────────────┐
                │                 │                 │
                ▼                 ▼                 ▼
┌─────────────────────┐  ┌────────────────┐  ┌────────────────┐
│  tools/briefs.ts    │  │ tools/git.ts   │  │ tools/session.ts│
│  (Brief ops)        │  │ (Git ops)      │  │ (Session ops)  │
│                     │  │                │  │                │
│  registerBriefTools │  │ registerGit    │  │ registerSession│
│  └─ brief_list      │  │ Tools          │  │ Tools          │
│  └─ brief_read      │  │ └─ git_status  │  │ └─ session_get │
│  └─ brief_create    │  │ └─ git_diff    │  │ └─ session_    │
│  └─ brief_update    │  │ └─ git_log     │  │    update      │
│  └─ brief_archive   │  │ └─ git_commit  │  │                │
│                     │  │                │  │                │
│  Uses:              │  │ Uses:          │  │ Uses:          │
│  • fs/promises      │  │ • child_process│  │ • fs/promises  │
│  • Brief parsing    │  │ • Git CLI      │  │ • Session parse│
│                     │  │                │  │                │
└─────────────────────┘  └────────────────┘  └────────────────┘

        ▼                       ▼                       ▼
┌─────────────────────┐  ┌────────────────┐  ┌────────────────┐
│ tools/files.ts      │  │ tools/         │  │ tools/         │
│ (File ops)          │  │ langchain.ts   │  │ langgraph.ts   │
│                     │  │ (AI analysis)  │  │ (Multi-agent)  │
│ registerFileTools   │  │                │  │                │
│ └─ file_read        │  │ registerLang   │  │ registerLang   │
│                     │  │ ChainTools     │  │ GraphTools     │
│ Uses:               │  │ └─ generate_   │  │ └─ code_review │
│ • fs/promises       │  │    brief       │  │ └─ implement   │
│ • Path resolution   │  │ └─ analyze_    │  │ └─ planning    │
│                     │  │    code        │  │                │
│                     │  │                │  │                │
│                     │  │ Executes:      │  │ Executes:      │
│                     │  │ • Python shell │  │ • Python shell │
│                     │  │   scripts      │  │   scripts      │
│                     │  │ • Returns JSON │  │ • Returns JSON │
│                     │  │                │  │                │
└─────────────────────┘  └────────────────┘  └────────────────┘
```

---

## 🖥️ DESKTOP APPLICATION ARCHITECTURE

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    IGRIS_DESKTOP (Flutter/Dart)                              │
│                    v1.0.0+1 | 4,021 lines | MVVM Pattern                     │
└─────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  main.dart - App Entry Point                                       │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  IgrisApp (GetMaterialApp)                                         │
│    ├─ FDL Theme (Fifty Design Language)                           │
│    │   ├─ Crimson colors (#960E29)                                │
│    │   ├─ Dark mode only                                          │
│    │   └─ fifty_tokens package                                    │
│    │                                                               │
│    └─ DashboardView (Stateful)                                    │
│        ├─ _DashboardSidebar (280px width)                         │
│        │   ├─ Igris branding                                      │
│        │   ├─ Navigation (6 items)                                │
│        │   └─ Version footer                                      │
│        │                                                           │
│        └─ Screen Router                                           │
│            ├─ [0] BriefsScreen                                    │
│            ├─ [1] GitScreen                                       │
│            ├─ [2] SessionScreen                                   │
│            ├─ [3] ToolsScreen                                     │
│            └─ [4] TestMCPScreen                                   │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  SCREENS LAYER (6 Feature Screens)                                 │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  1. BriefsScreen                                                   │
│     ├─ Uses: MCPService.listBriefs()                              │
│     ├─ Displays: Brief cards in grid                              │
│     ├─ Features: Filters (status, priority), refresh              │
│     └─ Navigation: → BriefDetailScreen                            │
│                                                                    │
│  2. BriefDetailScreen (NEW - Today!)                               │
│     ├─ Uses: MCPService.readBrief(id)                             │
│     ├─ Displays: Full brief markdown                              │
│     ├─ Features: Sections, metadata, navigation                   │
│     └─ UI: Header + metadata card + content sections              │
│                                                                    │
│  3. GitScreen                                                      │
│     ├─ Uses: MCPService.getGitStatus(), getGitDiff()              │
│     ├─ Displays: Status, modified files, diffs                    │
│     └─ Features: Commit history, diff viewer                      │
│                                                                    │
│  4. SessionScreen                                                  │
│     ├─ Uses: MCPService.getSession()                              │
│     ├─ Displays: Current session state, progress                  │
│     └─ Features: Next steps, session history                      │
│                                                                    │
│  5. ToolsScreen (FR-003 - NEW Today!)                              │
│     ├─ Uses: MCPService.initialize(), tools getter                │
│     ├─ Displays: All 17 MCP tools                                 │
│     ├─ Features: Tool discovery, dynamic forms, execution         │
│     ├─ Layout: Split view (tool list | detail + form)            │
│     └─ Components: ToolCard, DynamicFormGenerator, ResultPanel   │
│                                                                    │
│  6. TestMCPScreen                                                  │
│     ├─ Uses: Direct MCP client testing                            │
│     └─ Purpose: Development/debugging                             │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  WIDGETS LAYER (Custom UI Components)                              │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  1. BriefCard (156 lines)                                          │
│     ├─ Input: Brief model                                         │
│     ├─ Displays: Icon, ID, title, badges (type, priority, status) │
│     ├─ Features: Clickable, hover effects                         │
│     └─ Used by: BriefsScreen                                      │
│                                                                    │
│  2. DynamicFormGenerator (446 lines) - CRITICAL COMPONENT!         │
│     ├─ Input: JSON Schema (from MCP tool.inputSchema)             │
│     ├─ Output: Flutter form widgets                               │
│     ├─ Supported Types:                                           │
│     │   ├─ string → TextFormField                                 │
│     │   ├─ enum → DropdownButton                                  │
│     │   ├─ number → Numeric TextFormField                         │
│     │   ├─ boolean → Checkbox                                     │
│     │   ├─ object → JSON text area                                │
│     │   └─ array → Comma-separated input                          │
│     ├─ Features: Validation, null-safety, real-time updates       │
│     └─ Used by: ToolsScreen                                       │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  SERVICES LAYER (Business Logic)                                   │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  1. MCPService (Primary Service)                                   │
│     ├─ Wraps: fifty_mcp_client package                            │
│     ├─ Methods:                                                    │
│     │   ├─ initialize() - Connect to MCP server                   │
│     │   ├─ listBriefs() - Get briefs with filters                 │
│     │   ├─ readBrief() - Get full brief content                   │
│     │   ├─ getGitStatus() - Get git status                        │
│     │   ├─ getSession() - Get session state                       │
│     │   └─ callTool() - Generic tool execution                    │
│     ├─ State: _isInitialized, _cachedTools                        │
│     └─ Used by: All screens                                       │
│                                                                    │
│  2. IgrisAIService                                                 │
│     ├─ High-level Igris operations                                │
│     └─ Workflow coordination                                      │
│                                                                    │
│  3. ClaudeCliService                                               │
│     ├─ Terminal integration                                       │
│     └─ Command execution                                          │
│                                                                    │
│  4. AnthropicService (Legacy)                                      │
│     ├─ Direct API calls                                           │
│     └─ Being phased out (replaced by MCP)                         │
│                                                                    │
│  5. IgrisBridgeService (Legacy)                                    │
│     ├─ HTTP bridge to Python                                      │
│     └─ Being phased out (replaced by MCP)                         │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  MODELS LAYER (Data Structures)                                    │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  1. Brief Model (153 lines)                                        │
│     ├─ Fields: id, title, type, priority, status, effort          │
│     ├─ Methods:                                                    │
│     │   ├─ parseList() - Parse markdown table → List<Brief>       │
│     │   ├─ getPriorityColor() - Color mapping                     │
│     │   ├─ getStatusColor() - Color mapping                       │
│     │   ├─ getTypeLabel() - Human-readable labels                 │
│     │   └─ getTypeIcon() - Emoji mapping                          │
│     └─ Used by: BriefsScreen, BriefCard, BriefDetailScreen        │
│                                                                    │
│  2. Message Model                                                  │
│     └─ Legacy chat (being removed)                                │
│                                                                    │
│  3. ApiResponse Model                                              │
│     └─ Generic response wrapper                                   │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  CORE UTILITIES                                                     │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  • api_response.dart - Response handling                           │
│  • Constants                                                       │
│  • Helpers                                                         │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

## 📦 FIFTY_MCP_CLIENT PACKAGE ARCHITECTURE

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    FIFTY_MCP_CLIENT (Dart Package)                           │
│                    v0.1.0 | 1,274 lines | Reusable MCP Client                │
└─────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  lib/src/mcp_client.dart - Main Client                             │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  class MCPClient {                                                 │
│    - MCP protocol implementation                                   │
│    - Stdio transport (Process.start)                               │
│    - JSON-RPC 2.0 messaging                                        │
│    - Tool discovery and execution                                  │
│  }                                                                 │
│                                                                    │
│  Key Methods:                                                      │
│  • initialize(clientName, version) → Handshake                     │
│  • listTools() → List<MCPTool>                                     │
│  • callTool(name, args) → MCPResponse                              │
│  • close() → Cleanup                                               │
│                                                                    │
│  Architecture:                                                     │
│  ┌──────────────────────────────────────────────────┐             │
│  │  MCPClient                                       │             │
│  │  ├─ Process (node mcp-server)                   │             │
│  │  │   └─ stdio transport                         │             │
│  │  ├─ StreamSubscription (stdout/stderr)          │             │
│  │  ├─ JSON-RPC message queue                      │             │
│  │  └─ Response handlers (Completer<T> per call)   │             │
│  └──────────────────────────────────────────────────┘             │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  lib/src/models/ - Data Models                                     │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  • MCPTool - Tool definition with schema                           │
│  • MCPResponse - Tool call response                                │
│  • MCPException - Error handling                                   │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

Transport Layer:
┌────────────────────────────────────────────────────────────────────┐
│  Dart Process.start('node', [serverPath])                          │
│  ├─ stdin ────────────> MCP Server                                 │
│  ├─ stdout <───────── MCP Server (responses)                       │
│  └─ stderr <───────── MCP Server (errors/logs)                     │
└────────────────────────────────────────────────────────────────────┘
```

---

## 🔄 COMPLETE DATA FLOW DIAGRAM

```
┌─────────────────────────────────────────────────────────────────────────────┐
│          END-TO-END WORKFLOW: "Execute igris_brief_list via Desktop"         │
└─────────────────────────────────────────────────────────────────────────────┘

USER ACTION                    DESKTOP UI                    MCP CLIENT
     │                              │                              │
     ├─ Clicks "Briefs" ────────>   │                              │
     │  in sidebar                  │                              │
     │                              │                              │
     │                         BriefsScreen                         │
     │                         initState()                          │
     │                              │                              │
     │                              ├─ _initialize() ───────────>  │
     │                              │                         MCPService
     │                              │                         .initialize()
     │                              │                              │
     │                              │                              ├─> fifty_mcp_client
     │                              │                              │   Process.start(node)
     │                              │                              │
     │                              │                              ├─> MCP Handshake
     │                              │                              │   {"method": "initialize"}
     │                              │                              │
     │                              │                         MCP SERVER
     │                              │                              │
     │                              │                         index.ts receives
     │                              │                         handshake
     │                              │                              │
     │                              │                              ├─> Returns server info
     │                              │                              │   {"name": "igris-ai"}
     │                              │                              │
     │                              │                              ├─> listTools() called
     │                              │                              │   Returns 17 tools
     │                              │                              │
     │                              │ <────────────────────────────┤
     │                              │   MCPService._cachedTools    │
     │                              │   = [17 tools]               │
     │                              │                              │
     │                              ├─ _loadBriefs() ──────────>   │
     │                              │                         MCPService
     │                              │                         .listBriefs()
     │                              │                              │
     │                              │                              ├─> callTool()
     │                              │                              │   name: "igris_brief_list"
     │                              │                              │   args: {}
     │                              │                              │
     │                              │                         MCP SERVER
     │                              │                              │
     │                              │                         tools/briefs.ts
     │                              │                         handleListBriefs()
     │                              │                              │
     │                              │                              ├─> Read IGRIS_PROJECT_PATH
     │                              │                              │   env var
     │                              │                              │
     │                              │                         PROJECT FILES
     │                              │                              │
     │                              │                              ├─> fs.readdir()
     │                              │                              │   ai/briefs/*.md
     │                              │                              │
     │                              │                              ├─> Parse 30 brief files
     │                              │                              │   Extract metadata
     │                              │                              │
     │                              │                              ├─> Format as markdown
     │                              │                              │   table
     │                              │                              │
     │                              │ <────────────────────────────┤
     │                              │   Returns markdown table     │
     │                              │   (30 briefs)                │
     │                              │                              │
     │                         Brief.parseList()                    │
     │                         Parses markdown → List<Brief>         │
     │                              │                              │
     │                         setState(_briefs = list)             │
     │                              │                              │
     │ <───────────────────────     │                              │
     │   UI Updates:                │                              │
     │   Shows 30 brief cards       │                              │
     │   with badges                │                              │
     │                              │                              │
     ├─ Clicks brief card ─────>    │                              │
     │                              │                              │
     │                         Get.to(BriefDetailScreen)            │
     │                              │                              │
     │                              ├─ readBrief(id) ──────────>   │
     │                              │                         MCPService
     │                              │                         .readBrief()
     │                              │                              │
     │                              │                              ├─> callTool()
     │                              │                              │   name: "igris_brief_read"
     │                              │                              │   args: {brief_id: "BR-003"}
     │                              │                              │
     │                              │                         MCP SERVER
     │                              │                              │
     │                              │                         tools/briefs.ts
     │                              │                              │
     │                              │                              ├─> Read file
     │                              │                              │   ai/briefs/BR-003-*.md
     │                              │                              │
     │                              │ <────────────────────────────┤
     │                              │   Full markdown content      │
     │                              │                              │
     │                         BriefDetailScreen                    │
     │                         _parseMarkdownSections()             │
     │                              │                              │
     │ <───────────────────────     │                              │
     │   UI Updates:                │                              │
     │   Shows full brief           │                              │
     │   with sections              │                              │
     │                              │                              │
```

---

## 🔌 PLUGIN HOOK EXECUTION FLOW

```
┌─────────────────────────────────────────────────────────────────────────────┐
│       ENHANCED WORKFLOW: "Generate Brief with LangChain Plugin"              │
└─────────────────────────────────────────────────────────────────────────────┘

CLAUDE CODE                MCP SERVER              LANGCHAIN PLUGIN
(User types:                   │                          │
"generate brief                │                          │
from git diff")                │                          │
     │                         │                          │
     ├─> MCP call ──────────>  │                          │
     │   igris_langchain_      │                          │
     │   generate_brief        │                          │
     │                         │                          │
     │                    index.ts                         │
     │                    receives call                    │
     │                         │                          │
     │                    tools/langchain.ts               │
     │                    handleGenerateBrief()            │
     │                         │                          │
     │                         ├─> Check if plugin         │
     │                         │   installed               │
     │                         │   (ai/plugins/            │
     │                         │    installed.json)        │
     │                         │                          │
     │                         ├─> Get hook script ────>  │
     │                         │   path                   │
     │                         │                     ai/langchain/
     │                         │                     hooks/
     │                         │                     generate_brief.sh
     │                         │                          │
     │                         ├─> Execute shell ──────>  │
     │                         │   script with args       │
     │                         │                          │
     │                         │                     PYTHON SCRIPT
     │                         │                          │
     │                         │                     ├─> Load LangChain
     │                         │                     │   environment
     │                         │                     │
     │                         │                     ├─> Create AI chain:
     │                         │                     │   PromptTemplate
     │                         │                     │   + ChatAnthropic
     │                         │                     │   + Output Parser
     │                         │                     │
     │                         │                     ├─> Get git diff
     │                         │                     │   (if from diff)
     │                         │                     │
     │                         │                     ├─> Call Claude API
     │                         │                     │   (3.5 Sonnet)
     │                         │                     │
     │                         │                     ├─> Parse response
     │                         │                     │   to JSON
     │                         │                     │
     │                         │  <──────────────────┤
     │                         │   Returns:           │
     │                         │   {                  │
     │                         │     "type": "BR",    │
     │                         │     "title": "...",  │
     │                         │     "priority": "P1",│
     │                         │     "problem": "...", │
     │                         │     "goal": "..."    │
     │                         │   }                  │
     │                         │                      │
     │                         ├─> Call brief_create  │
     │                         │   tool with AI data  │
     │                         │                      │
     │                         ├─> Create file:       │
     │                         │   ai/briefs/         │
     │                         │   BR-XXX-*.md        │
     │                         │                      │
     │  <──────────────────────┤                      │
     │  Returns:               │                      │
     │  "✅ Brief BR-012        │                      │
     │  created successfully"  │                      │
     │                         │                      │
```

---

## 🤖 LANGGRAPH AUTONOMOUS AGENT FLOW

```
┌─────────────────────────────────────────────────────────────────────────────┐
│     MULTI-AGENT WORKFLOW: "Autonomous Implementation of BR-XXX"              │
└─────────────────────────────────────────────────────────────────────────────┘

CLAUDE CODE              MCP SERVER           LANGGRAPH PLUGIN
(User types:                  │                        │
"implement BR-012             │                        │
autonomously")                │                        │
     │                        │                        │
     ├─> MCP call ─────────>  │                        │
     │   igris_langgraph_     │                        │
     │   implementation       │                        │
     │   {brief_id: "BR-012"} │                        │
     │                        │                        │
     │                   tools/langgraph.ts            │
     │                   handleImplementation()        │
     │                        │                        │
     │                        ├─> Execute hook ────>   │
     │                        │                   ai/langgraph/
     │                        │                   hooks/
     │                        │                   implement_brief.sh
     │                        │                        │
     │                        │                   PYTHON AGENT GRAPH
     │                        │                        │
     │                        │                   ┌────────────────┐
     │                        │                   │  StateGraph    │
     │                        │                   │  (LangGraph)   │
     │                        │                   └────────────────┘
     │                        │                        │
     │                        │            ┌───────────┴───────────┐
     │                        │            │                       │
     │                        │       [1] PLANNER NODE       [2] IMPLEMENTER
     │                        │            │                       NODE
     │                        │            ├─> Read brief          │
     │                        │            ├─> Read guidelines     ├─> Write code
     │                        │            ├─> Read codebase       ├─> Follow plan
     │                        │            └─> Create plan ────>   └─> Update files
     │                        │                                    │
     │                        │                              [3] TESTER NODE
     │                        │                                    │
     │                        │                                    ├─> Run tests
     │                        │                                    ├─> Check lint
     │                        │                                    └─> Validate
     │                        │                                    │
     │                        │                         ┌──────────┴──────────┐
     │                        │                         │                     │
     │                        │                   [4] REVIEWER NODE     [5] COMMITTER
     │                        │                         │                     NODE
     │                        │                         ├─> Review code       │
     │                        │                         ├─> Check criteria    ├─> git add
     │                        │                         └─> Approve? ──────>  ├─> git commit
     │                        │                                               └─> Update brief
     │                        │                                               │
     │                        │  <────────────────────────────────────────────┤
     │                        │   Agent execution complete                    │
     │                        │   Brief status: Done                          │
     │                        │   Commit SHA: abc123                          │
     │                        │                                               │
     │  <─────────────────────┤                                               │
     │  "✅ BR-012 implemented │                                               │
     │  autonomously!          │                                               │
     │  Commit: abc123"        │                                               │
     │                         │                                               │

Agent Graph Transitions:
┌────────┐    ┌──────────────┐    ┌────────┐    ┌──────────┐    ┌───────────┐
│PLANNER │───>│ IMPLEMENTER  │───>│ TESTER │───>│ REVIEWER │───>│ COMMITTER │
│        │    │              │    │        │    │          │    │           │
│ Plan   │    │ Code changes │    │ Verify │    │ Approve? │    │ Finalize  │
└────────┘    └──────────────┘    └────────┘    └────┬─────┘    └───────────┘
                                                      │
                                                      ├─> If fails: Loop back
                                                      │   to Implementer
                                                      │
                                                      └─> If passes: Commit
```

---

## 🎯 TOOLS CONTROL PANEL ARCHITECTURE (FR-003)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   TOOLS SCREEN INTERNAL ARCHITECTURE                         │
│                   lib/screens/tools_screen.dart (510 lines)                  │
└─────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  LAYOUT: Split View                                                │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌────────────────────┬──────────────────────────────────────┐    │
│  │  TOOL LIST         │  TOOL DETAIL + EXECUTION PANEL       │    │
│  │  (320px fixed)     │  (Expanded flex)                     │    │
│  ├────────────────────┼──────────────────────────────────────┤    │
│  │                    │                                      │    │
│  │  AVAILABLE TOOLS   │  Selected: igris_brief_create        │    │
│  │  (17)              │                                      │    │
│  │                    │  INPUT SCHEMA                        │    │
│  │  ┌──────────────┐  │  ┌────────────────────────────────┐ │    │
│  │  │ igris_brief_ │  │  │ [DynamicFormGenerator]         │ │    │
│  │  │ list         │  │  │                                │ │    │
│  │  └──────────────┘  │  │ Brief Type: [BR ▼]             │ │    │
│  │                    │  │ Title: [________________]      │ │    │
│  │  ┌──────────────┐  │  │ Priority: [P1 ▼]               │ │    │
│  │  │ igris_brief_ │  │  │ Problem: [________________]    │ │    │
│  │  │ read         │  │  │ Goal: [________________]       │ │    │
│  │  └──────────────┘  │  │                                │ │    │
│  │                    │  └────────────────────────────────┘ │    │
│  │  ┌──────────────┐  │                                      │    │
│  │  │ igris_brief_ │  │  [Execute Tool 🔥] <- Button         │    │
│  │  │ create ✓     │  │                                      │    │
│  │  └──────────────┘  │  RESULT                              │    │
│  │                    │  ┌────────────────────────────────┐ │    │
│  │  ┌──────────────┐  │  │ ✅ Brief BR-012 created!       │ │    │
│  │  │ ... (14 more)│  │  │                                │ │    │
│  │  └──────────────┘  │  └────────────────────────────────┘ │    │
│  │                    │                                      │    │
│  └────────────────────┴──────────────────────────────────────┘    │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

Component Breakdown:
┌────────────────────────────────────────────────────────────────────┐
│  _ToolsScreenState                                                 │
│  ├─ _tools: List<MCPTool>? (17 tools from server)                 │
│  ├─ _selectedTool: MCPTool? (currently selected)                  │
│  ├─ _executionResult: String? (last execution output)             │
│  ├─ _isExecuting: bool (loading state)                            │
│  └─ _formKey: GlobalKey<DynamicFormGeneratorState>                │
│                                                                    │
│  Methods:                                                          │
│  • _initialize() → MCPService.initialize() + cache tools          │
│  • _selectTool(tool) → Update UI to show tool detail              │
│  • _executeTool() → Validate form, call MCP, show result          │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

## 🧩 DYNAMIC FORM GENERATOR DEEP DIVE

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              DYNAMIC FORM GENERATOR - THE MAGIC COMPONENT                    │
│              lib/widgets/dynamic_form_generator.dart (446 lines)             │
└─────────────────────────────────────────────────────────────────────────────┘

INPUT: JSON Schema from MCP Tool
─────────────────────────────────
{
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "enum": ["BR", "FR", "TD", "MG", "TS"],
      "description": "Brief type"
    },
    "title": {
      "type": "string",
      "description": "Brief title"
    },
    "priority": {
      "type": "string",
      "enum": ["P0", "P1", "P2", "P3"],
      "description": "Priority level"
    },
    "problem": {
      "type": "string",
      "description": "Problem description"
    },
    "goal": {
      "type": "string",
      "description": "Expected outcome"
    }
  },
  "required": ["type", "title", "priority", "problem", "goal"]
}

                          ↓ PROCESSING ↓

DynamicFormGeneratorState._buildField()
├─ Detects type: "string" + enum → _buildEnumDropdown()
│  └─> Returns: DropdownButtonFormField<String>
│      ├─ Items: [BR, FR, TD, MG, TS]
│      ├─ Validation: Required check
│      └─ OnChanged: Updates _formValues map
│
├─ Detects type: "string" (no enum) → _buildTextField()
│  └─> Returns: TextFormField
│      ├─ Hint text: description
│      ├─ Validation: Required if in schema.required[]
│      └─ OnChanged: Updates _formValues map
│
└─ Builds all fields dynamically

                          ↓ OUTPUT ↓

FLUTTER UI (Generated)
─────────────────────────
┌────────────────────────────────────┐
│ Brief Type *                       │
│ ┌────────────────────────────────┐ │
│ │ BR                          ▼  │ │  <- Dropdown (from enum)
│ └────────────────────────────────┘ │
│                                    │
│ Title *                            │
│ ┌────────────────────────────────┐ │
│ │ Fix login bug                  │ │  <- Text field (string)
│ └────────────────────────────────┘ │
│                                    │
│ Priority *                         │
│ ┌────────────────────────────────┐ │
│ │ P1                          ▼  │ │  <- Dropdown (from enum)
│ └────────────────────────────────┘ │
│                                    │
│ Problem *                          │
│ ┌────────────────────────────────┐ │
│ │ Users can't login...           │ │  <- Text field (string)
│ └────────────────────────────────┘ │
│                                    │
│ Goal *                             │
│ ┌────────────────────────────────┐ │
│ │ Users can login successfully   │ │  <- Text field (string)
│ └────────────────────────────────┘ │
│                                    │
│ [Execute Tool 🔥]                  │  <- Button
└────────────────────────────────────┘

Form State Management:
┌────────────────────────────────────────────────────────────────┐
│  _formValues: Map<String, dynamic>                             │
│  {                                                             │
│    "type": "BR",                                               │
│    "title": "Fix login bug",                                   │
│    "priority": "P1",                                           │
│    "problem": "Users can't login...",                          │
│    "goal": "Users can login successfully"                      │
│  }                                                             │
│                                                                │
│  On Execute:                                                   │
│  1. validate() → Check required fields                         │
│  2. getValues() → Return _formValues (cleaned)                 │
│  3. MCPService.callTool(name, _formValues)                     │
│  4. Display result in ToolResultPanel                          │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## 📊 COMPLETE INTEGRATION MAP

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     FULL SYSTEM INTEGRATION MAP                              │
│                 (How Everything Connects Together)                           │
└─────────────────────────────────────────────────────────────────────────────┘

                                    USER
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
              CLAUDE CODE      igris_desktop     Terminal (Future)
                    │                │                │
                    └────────────────┼────────────────┘
                                     │
                              MCP PROTOCOL
                              (stdio/JSON-RPC)
                                     │
                    ┌────────────────▼────────────────┐
                    │    IGRIS MCP SERVER (Node.js)   │
                    │         17 Tools                │
                    └────────────────┬────────────────┘
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        │                            │                            │
        │                            │                            │
  DIRECT TOOLS              PLUGIN-ENHANCED TOOLS         FILE SYSTEM
  (No AI needed)            (Optional AI layer)          (Project Data)
        │                            │                            │
        ▼                            ▼                            ▼
┌───────────────┐          ┌──────────────────┐         ┌─────────────────┐
│ Brief Tools   │          │ LangChain Tools  │         │ ai/briefs/      │
│ • list        │          │ • generate_brief │         │ • 30 .md files  │
│ • read        │          │ • analyze_code   │         │                 │
│ • create      │          │                  │         │ ai/session/     │
│ • update      │          │ ┌──────────────┐ │         │ • CURRENT_      │
│ • archive     │          │ │ Python Env   │ │         │   SESSION.md    │
│               │          │ │ • LangChain  │ │         │ • DECISIONS.md  │
│ Session Tools │          │ │ • Claude API │ │         │ • BLOCKERS.md   │
│ • get         │          │ │ • ChromaDB   │ │         │                 │
│ • update      │          │ └──────────────┘ │         │ ai/context/     │
│               │          │                  │         │ • coding_       │
│ File Tools    │          │ LangGraph Tools  │         │   guidelines.md │
│ • read        │          │ • code_review    │         │                 │
│               │          │ • implementation │         │ ai/plugins/     │
│ Git Tools     │          │ • planning       │         │ • installed.json│
│ • status      │          │                  │         │                 │
│ • diff        │          │ ┌──────────────┐ │         │ scripts/        │
│ • log         │          │ │ Python Env   │ │         │ • 18 .sh files  │
│ • commit      │          │ │ • LangGraph  │ │         │                 │
│               │          │ │ • Claude API │ │         │ .git/           │
└───────────────┘          │ │ • State      │ │         │ • Git repo      │
                           │ │   Machine    │ │         │                 │
                           │ └──────────────┘ │         └─────────────────┘
                           │                  │
                           │ Hook Execution:  │
                           │ 1. Shell script  │
                           │ 2. Python agent  │
                           │ 3. AI reasoning  │
                           │ 4. File updates  │
                           │ 5. MCP response  │
                           │                  │
                           └──────────────────┘
```

---

## 🌊 DATA FLOW: Complete Request Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│        EXAMPLE: User Creates Brief via Desktop Tools Control Panel          │
└─────────────────────────────────────────────────────────────────────────────┘

[1] USER INTERFACE
    ├─ User opens igris_desktop
    ├─ Clicks "Tools" in sidebar
    ├─ Selects "igris_brief_create" from list
    └─ Fills dynamic form:
        • type: "BR"
        • title: "Fix login timeout"
        • priority: "P1"
        • problem: "Users timeout after 5 min"
        • goal: "Users stay logged in for 1 hour"

                    ↓

[2] FLUTTER UI LAYER (igris_desktop)
    ├─ ToolsScreen._executeTool() called
    ├─ DynamicFormGenerator.validate() → Pass
    ├─ DynamicFormGenerator.getValues() → Extract form data
    └─ Calls: MCPService.callTool("igris_brief_create", formData)

                    ↓

[3] SERVICE LAYER (MCPService)
    ├─ Method: callTool(toolName, arguments)
    ├─ Ensures: _isInitialized == true
    ├─ Wraps: fifty_mcp_client.callTool()
    └─ Sends MCP request via stdio

                    ↓

[4] MCP CLIENT (fifty_mcp_client)
    ├─ MCPClient.callTool() executed
    ├─ Creates JSON-RPC 2.0 message:
    │   {
    │     "jsonrpc": "2.0",
    │     "id": 42,
    │     "method": "tools/call",
    │     "params": {
    │       "name": "igris_brief_create",
    │       "arguments": {
    │         "type": "BR",
    │         "title": "Fix login timeout",
    │         ...
    │       }
    │     }
    │   }
    ├─ Writes to process.stdin
    └─ Awaits response via stdout stream

                    ↓

[5] MCP SERVER (index.ts)
    ├─ Receives JSON-RPC message on stdin
    ├─ Parses: tools/call request
    ├─ Routes to: tools/briefs.ts
    └─ Calls: handleCreateBrief(args)

                    ↓

[6] TOOL HANDLER (tools/briefs.ts)
    ├─ Validates: args against JSON Schema
    ├─ Reads: IGRIS_PROJECT_PATH env var
    ├─ Scans: ai/briefs/ for next BR number
    ├─ Finds: BR-011 is highest → next is BR-012
    ├─ Reads: ai/briefs/BR-TEMPLATE.md
    ├─ Substitutes: {{TITLE}}, {{PRIORITY}}, etc.
    ├─ Writes: ai/briefs/BR-012-fix-login-timeout.md
    └─ Returns: Success message

                    ↓

[7] MCP RESPONSE
    ├─ JSON-RPC response created:
    │   {
    │     "jsonrpc": "2.0",
    │     "id": 42,
    │     "result": {
    │       "content": [{
    │         "type": "text",
    │         "text": "✅ Brief registered: BR-012..."
    │       }]
    │     }
    │   }
    ├─ Written to stdout
    └─ MCP client receives response

                    ↓

[8] FLUTTER UI UPDATE
    ├─ MCPService.callTool() returns
    ├─ ToolsScreen.setState() called
    ├─ _executionResult = "✅ Brief registered: BR-012"
    ├─ UI rebuilds with result panel
    └─ User sees success message in green box

                    ↓

[9] PERSISTENCE
    ├─ New file created: ai/briefs/BR-012-fix-login-timeout.md
    ├─ Visible in: BriefsScreen (after refresh)
    ├─ Accessible via: All MCP clients
    └─ Git status: Untracked file (ready to commit)
```

---

## 🏗️ LAYERED ARCHITECTURE VIEW

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          LAYER ARCHITECTURE                                  │
│                    (Separation of Concerns)                                  │
└─────────────────────────────────────────────────────────────────────────────┘

LAYER 1: PRESENTATION (UI)
═══════════════════════════════════════════════════════════════════
Flutter Screens (igris_desktop/lib/screens/)
├─ BriefsScreen - Brief list with cards
├─ BriefDetailScreen - Full brief view
├─ GitScreen - Git operations UI
├─ SessionScreen - Session tracking UI
├─ ToolsScreen - MCP tools control panel
└─ TestMCPScreen - Debug/testing

Flutter Widgets (igris_desktop/lib/widgets/)
├─ BriefCard - Card component
└─ DynamicFormGenerator - Form builder

Responsibilities:
• User interaction
• Visual rendering
• Navigation
• Form validation
• State display

═══════════════════════════════════════════════════════════════════

LAYER 2: APPLICATION SERVICES
═══════════════════════════════════════════════════════════════════
Services (igris_desktop/lib/services/)
├─ MCPService - MCP client wrapper
├─ IgrisAIService - High-level operations
├─ ClaudeCliService - Terminal integration
└─ (Legacy services being phased out)

Responsibilities:
• Business logic
• MCP communication
• Data transformation
• State management
• Error handling

═══════════════════════════════════════════════════════════════════

LAYER 3: PROTOCOL LAYER
═══════════════════════════════════════════════════════════════════
MCP Client (fifty_mcp_client package)
├─ MCPClient class
├─ Stdio transport
├─ JSON-RPC 2.0 messaging
├─ Tool discovery
└─ Response parsing

Responsibilities:
• MCP protocol compliance
• Server communication
• Message serialization
• Connection management

═══════════════════════════════════════════════════════════════════

LAYER 4: MCP SERVER (Backend)
═══════════════════════════════════════════════════════════════════
Node.js Server (mcp-server/src/)
├─ index.ts - Server instance
├─ tools/briefs.ts - Brief operations
├─ tools/session.ts - Session operations
├─ tools/git.ts - Git operations
├─ tools/files.ts - File operations
├─ tools/langchain.ts - AI analysis
└─ tools/langgraph.ts - Multi-agent workflows

Responsibilities:
• Tool registration
• Request handling
• Plugin hook execution
• File system access
• Git operations

═══════════════════════════════════════════════════════════════════

LAYER 5: PLUGIN ENHANCEMENTS (Optional)
═══════════════════════════════════════════════════════════════════
Python Plugins (Enhancement Hooks)
├─ igris-langchain
│   ├─ LangChain AI analysis
│   ├─ Brief generation
│   ├─ Code review
│   └─ Test generation
│
└─ igris-langgraph
    ├─ Multi-agent coordination
    ├─ Autonomous implementation
    ├─ Code review consensus
    └─ Self-healing

Responsibilities:
• AI-powered enhancements
• Autonomous workflows
• Advanced analysis
• Multi-agent reasoning

═══════════════════════════════════════════════════════════════════

LAYER 6: DATA PERSISTENCE
═══════════════════════════════════════════════════════════════════
File System (Project Directory)
├─ ai/briefs/ - 30 brief .md files
├─ ai/session/ - Session state .md files
├─ ai/context/ - Architecture standards
├─ ai/plugins/ - Plugin manifest
├─ scripts/ - 18 shell scripts
└─ .git/ - Version control

Responsibilities:
• Data storage
• Version control
• Configuration
• Templates
```

---

## 🔄 EXECUTION FLOW DIAGRAMS

### Flow 1: Simple Tool Execution (No Plugin)

```
Desktop UI → MCPService → fifty_mcp_client → MCP Server → File System
   │             │              │                 │            │
   ├─ User       ├─ callTool()  ├─ JSON-RPC       ├─ Read     ├─ ai/briefs/
   │  clicks     │              │  over stdio     │  file      │   BR-*.md
   │  Execute    └─ Returns     └─ Receives       └─ Returns   │
   │                response       response          data      └─ Response
   └─ Display
      result
```

### Flow 2: Plugin-Enhanced Tool Execution

```
Desktop UI → MCPService → MCP Server → Plugin Hook → AI Agent → File System
   │             │            │             │            │           │
   ├─ User       ├─ callTool │  ├─ Detects  ├─ Executes ├─ Claude   ├─ Reads
   │  clicks     │            │  │  hook     │  shell    │  API call │  code
   │  Execute    │            │  │  exists   │  script   │           │
   │             │            │  │           │           ├─ LangChain│  Writes
   │             │            │  ├─ Calls    │           │  chain    │  output
   │             │            │  │  hook     │           │           │
   │             └─ Returns   │  │           │           └─ Returns  │
   │                result    │  └─ Returns  └─ Returns    AI output └─ Done
   │                          │     enhanced    JSON
   └─ Display                 │     result
      AI-powered               └─ Formats
      result                      response
```

### Flow 3: Multi-Agent Workflow (LangGraph)

```
Desktop → MCP → LangGraph → Agent Graph → Multiple Agents → Project Files
   │        │       │            │              │                │
   ├─ User  ├─ Call │  ├─ Start  │  ┌─────────┴────────┐        │
   │  clicks│  impl │  │  graph   │  │                  │        │
   │  "Auto│  tool  │  │          │  │  PLANNER AGENT   │        ├─ Read brief
   │  impl"│        │  │          │  │  ├─ Reads brief  │        ├─ Read code
   │        │        │  │          │  │  └─> Creates plan│        │
   │        │        │  │          │  └──────┬───────────┘        │
   │        │        │  │          │         │                    │
   │        │        │  │          │  ┌──────▼────────────┐       │
   │        │        │  │          │  │ IMPLEMENTER AGENT │       ├─ Write code
   │        │        │  │          │  │ ├─ Follows plan   │       │
   │        │        │  │          │  │ └─> Writes code   │       │
   │        │        │  │          │  └──────┬────────────┘       │
   │        │        │  │          │         │                    │
   │        │        │  │          │  ┌──────▼───────────┐        │
   │        │        │  │          │  │  TESTER AGENT    │        ├─ Run tests
   │        │        │  │          │  │  ├─ Runs tests   │        │
   │        │        │  │          │  │  └─> Validates   │        │
   │        │        │  │          │  └──────┬───────────┘        │
   │        │        │  │          │         │                    │
   │        │        │  │          │  ┌──────▼──────────┐         │
   │        │        │  │          │  │ REVIEWER AGENT  │         │
   │        │        │  │          │  │ ├─ Reviews code │         │
   │        │        │  │          │  │ └─> Approves?   │         │
   │        │        │  │          │  └──────┬──────────┘         │
   │        │        │  │          │         │                    │
   │        │        │  │          │  ┌──────▼─────────┐          │
   │        │        │  │          │  │ COMMITTER AGENT│          ├─ git add
   │        │        │  │          │  │ ├─ git commit  │          ├─ git commit
   │        │        │  │          │  │ └─> Updates    │          ├─ Update brief
   │        │        │  │          │  │     brief      │          │
   │        │        │  │          │  └────────────────┘          │
   │        │        │  │          │                              │
   │        │        │  └─ Graph   └─ State transitions           │
   │        │        │     complete   with memory                 │
   │        │        │                                            │
   │        │        └─ Returns: Implementation complete          │
   │        │           + commit SHA                              │
   │        │                                                     │
   │        └─ MCP response with full report                      │
   │                                                              │
   └─ Display: "✅ BR-012 implemented! Commit: abc123"            │
```

---

## 🧬 TECHNOLOGY STACK

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          COMPLETE TECH STACK                                 │
└─────────────────────────────────────────────────────────────────────────────┘

FRONTEND (Desktop UI)
├─ Flutter 3.9.2+ (Dart framework)
├─ GetX 4.6.6 (State management + navigation)
├─ fifty_tokens (FDL design system)
├─ fifty_mcp_client v0.1.0 (Custom MCP client)
├─ http 1.1.0 (HTTP requests - legacy)
└─ flutter_dotenv 5.1.0 (Environment variables)

BACKEND (MCP Server)
├─ Node.js 20.0+
├─ TypeScript 5.7+
├─ @modelcontextprotocol/sdk ^1.22.0
└─ Stdio transport (native MCP)

AI PLUGINS (Python)
├─ Python 3.9+ (langchain), 3.10+ (langgraph)
├─ LangChain ^0.1.0 (AI analysis)
├─ LangGraph ^0.1.0 (Multi-agent)
├─ Anthropic SDK (Claude API)
└─ ChromaDB (Vector store - optional)

AUTOMATION (Shell)
├─ Bash 4.0+
├─ Git 2.0+
├─ Python3 (required dependency)
└─ jq (optional, has fallback)

DESIGN SYSTEM
├─ Fifty Design Language (FDL)
├─ Crimson color palette (#960E29)
├─ Dark mode UI
├─ Monospace fonts
└─ Icon system (Material Icons + Emojis)

PROTOCOLS
├─ MCP (Model Context Protocol) - Primary
├─ JSON-RPC 2.0 (MCP messaging)
└─ Stdio (Transport layer)
```

---

## 📈 SCALABILITY & EXTENSIBILITY

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     HOW TO EXTEND THE SYSTEM                                 │
└─────────────────────────────────────────────────────────────────────────────┘

ADD NEW MCP TOOL
════════════════
1. Create tools/my_feature.ts
2. Export registerMyFeatureTools()
3. Import in index.ts
4. Call during server setup
5. Desktop UI discovers automatically!
   (DynamicFormGenerator handles new tool's schema)

ADD NEW PLUGIN
══════════════
1. Create plugin directory
2. Add plugin.json with metadata
3. Define enhancement hooks
4. Run: ./scripts/plugin_install.sh my-plugin.tar.gz
5. Hooks execute automatically at trigger points

ADD NEW CLIENT
══════════════
1. Implement MCP client in any language
2. Connect via stdio to mcp-server
3. Discover 17 tools automatically
4. Execute tools via JSON-RPC
5. No server changes needed!

Examples:
• Web UI: JavaScript MCP client
• Mobile: Dart MCP client (reuse fifty_mcp_client!)
• CLI: Python/Rust MCP client
• VS Code Extension: Use @modelcontextprotocol/sdk

ADD NEW BRIEF TYPE
══════════════════
1. Create ai/briefs/XX-TEMPLATE.md
2. Update MCP server tool schemas
3. Desktop UI updates automatically
   (Brief.parseList() handles new type)

ADD NEW AGENT
═════════════
1. Create agent in langgraph plugin
2. Define LangGraph state machine
3. Create hook script
4. Register in plugin.json
5. Call via igris_langgraph_* tool
```

---

## 🎯 KEY INTEGRATION POINTS

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CRITICAL INTEGRATION POINTS                           │
└─────────────────────────────────────────────────────────────────────────────┘

[1] IGRIS_PROJECT_PATH Environment Variable
    ├─ Set by: Client when starting MCP server
    ├─ Used by: All MCP tools to locate project files
    ├─ Enables: Multi-project support
    └─ Example: IGRIS_PROJECT_PATH=/path/to/project node mcp-server

[2] Plugin Installed Manifest (ai/plugins/installed.json)
    ├─ Contains: List of installed plugins
    ├─ Read by: MCP server on startup
    ├─ Enables: Automatic hook discovery
    └─ Format:
        {
          "plugins": [
            {
              "name": "igris-langchain",
              "version": "1.0.0-alpha",
              "hooks": {...}
            }
          ]
        }

[3] MCP Tool Registration Pattern
    ├─ Each tool module exports registerXxxTools(server)
    ├─ index.ts calls all registration functions
    ├─ Tools become discoverable via MCP listTools
    └─ Automatic schema validation via JSON Schema

[4] Brief File Format (Markdown)
    ├─ Standardized metadata block (YAML-like)
    ├─ Markdown sections (## Problem, ## Goal, etc.)
    ├─ Parsed by: Both MCP server AND Desktop UI
    └─ Enables: Dual-source truth (files + UI)

[5] Session Recovery Protocol
    ├─ CURRENT_SESSION.md (strategic level)
    ├─ Brief files with "Session State" section (tactical level)
    ├─ TodoWrite (execution level - in-memory)
    └─ Three-tier recovery ensures no lost work
```

---

## 🚀 DEPLOYMENT ARCHITECTURE

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        PRODUCTION DEPLOYMENT                                 │
└─────────────────────────────────────────────────────────────────────────────┘

DEVELOPER MACHINE
├─ /Users/m.elamin/StudioProjects/igris-ai/
│  ├─ MCP Server (compiled: mcp-server/dist/index.js)
│  ├─ Brief files (ai/briefs/*.md)
│  ├─ Session files (ai/session/*.md)
│  ├─ Plugin system (ai/plugins/)
│  └─ Scripts (scripts/*.sh)
│
├─ /Users/m.elamin/StudioProjects/igris_desktop/
│  ├─ Flutter app (lib/)
│  └─ Built app (build/macos/Build/Products/)
│
├─ /Users/m.elamin/StudioProjects/igris-ai-langchain/
│  └─ LangChain plugin (Python)
│
└─ /Users/m.elamin/StudioProjects/igris-ai-langgraph/
   └─ LangGraph plugin (Python)

RUNTIME PROCESSES
├─ igris_desktop.app (Flutter app)
│  └─ Spawns: node mcp-server/dist/index.js
│      ├─ IGRIS_PROJECT_PATH env var set
│      └─ Stdio communication
│
├─ Claude Code (VS Code)
│  └─ Connects to: Same MCP server (shared instance)
│      └─ Stdio communication
│
└─ Optional: Python virtual envs (for plugins)
   ├─ langchain venv (if LangChain active)
   └─ langgraph venv (if LangGraph active)

NETWORKING
├─ No external network required (all local!)
├─ Optional: Claude API calls (only if plugins enabled)
└─ No ports exposed (stdio only)
```

---

## 📊 FINAL STATISTICS

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SYSTEM METRICS v1.0                                  │
└─────────────────────────────────────────────────────────────────────────────┘

CODE METRICS
════════════════════════════════════════════════════════════════
Repository          Language      Lines    Files    Purpose
───────────────────────────────────────────────────────────────
igris-ai            TypeScript    1,318       7     MCP Server
                    Markdown     50,000+     30     Briefs + Docs
                    Shell         2,000+     18     Automation
igris_desktop       Dart          4,021      19     Dashboard UI
fifty_mcp_client    Dart          1,274       5     MCP Client
───────────────────────────────────────────────────────────────
TOTAL PRODUCTION                 ~8,613      49     Core System
════════════════════════════════════════════════════════════════

FEATURE METRICS
════════════════════════════════════════════════════════════════
Component              Count    Status
───────────────────────────────────────────────────────────────
MCP Tools                17     Complete (6 categories)
Desktop Screens           6     Complete (all functional)
Brief Types               5     Complete (BR,FR,TD,MG,TS)
Brief Files              30     Mixed (23 Done, 7 active)
Plugins Installed         3     Active (langchain, langgraph, persona)
Enhancement Hooks        11     Active (across 3 plugins)
Shell Scripts            18     Complete (all working)
Documentation Files      14     Complete (150KB+)
────────────────────────────────────────────────────────────────

INTEGRATION METRICS
════════════════════════════════════════════════════════════════
Integration            Status    Details
───────────────────────────────────────────────────────────────
Claude Code ↔ MCP      ✅        Native stdio, 17 tools
Desktop ↔ MCP          ✅        fifty_mcp_client, all tools
MCP ↔ LangChain        ✅        2 AI tools working
MCP ↔ LangGraph        ✅        3 agent tools working
MCP ↔ File System      ✅        IGRIS_PROJECT_PATH
MCP ↔ Git              ✅        4 git tools
Desktop ↔ Flutter      ✅        MVVM + GetX
Desktop ↔ FDL          ✅        fifty_tokens theming
────────────────────────────────────────────────────────────────
```

---

## ✅ CONCLUSION

**Igris AI v1.0 Architecture Summary:**

1. **Universal MCP Server** - 17 tools accessible from any client
2. **Flutter Desktop Dashboard** - Visual data display with MCP integration
3. **Reusable Dart MCP Client** - fifty_mcp_client package
4. **Plugin Enhancement System** - LangChain + LangGraph optional AI
5. **Brief Management System** - 30 briefs, 5 types, full workflow
6. **Session Recovery** - 3-tier architecture prevents data loss
7. **Multi-Client Ready** - Desktop working, Terminal/Web/Mobile future
8. **Cost Optimized** - $100/month (saves $600/year)
9. **Production Ready** - All core features complete

**The system is MODULAR, EXTENSIBLE, and PRODUCTION-READY.**

---

**Generated by:** Crimson (Igris AI v2.4.0)
**Date:** 2025-12-01
**Status:** Production Documentation
**For:** Fifty.ai (Partner)

🔥🐒⚡
