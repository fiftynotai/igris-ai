# Decision Log

Tracks architectural and technical decisions made during implementation.

---

## [2025-10-13] - Decision: Use flutter-mvvm-actions-arch as canonical reference

**Context:** Need to document architecture for Igris AI without duplicating docs

**Options:**
1. Document full architecture in repo
2. Reference external canonical architecture repo
3. Hybrid: brief summary + reference

**Decision:** Option 2 - Reference flutter-mvvm-actions-arch as canonical source

**Rationale:**
- Single source of truth (one place to maintain)
- Easy to update (change URL variable in template)
- Repo-specific docs focus on adaptations only
- Makes template reusable for other repos

**Consequences:**
- Must ensure base repo remains accessible
- architecture_map.md becomes lightweight adapter
- docs/ARCHITECTURE.md kept as expanded reference but notes base is canonical

---

## [2025-10-13] - Decision: Include session management system

**Context:** Need crash recovery and progress tracking for AI sessions

**Options:**
1. Use TodoWrite tool only (ephemeral)
2. Add persistent session files
3. No session management

**Decision:** Option 2 - Add /ai/session/ with 5 files (CURRENT_SESSION, DECISIONS, BLOCKERS, LEARNINGS, TEST_RESULTS)

**Rationale:**
- CLI crashes happen frequently
- Session limits cause interruptions
- Need to preserve context across sessions
- Knowledge capture for future reference
- Enables handoff between AI sessions

**Consequences:**
- 5 additional files to maintain
- Requires discipline to update during session
- TodoWrite must sync with CURRENT_SESSION.md
- Benefits outweigh maintenance cost

---

## [2025-10-13] - Decision: Create pilot task BR-001 (Printer Status Indicator)

**Context:** Need real task to test Igris AI workflow

**Options:**
1. Simple UI-only task
2. Full-stack feature (all layers)
3. Bug fix task

**Decision:** Option 2 - Printer connection status indicator (touches all layers)

**Rationale:**
- Tests entire workflow (View → Actions → ViewModel → Service)
- Safe (no backend changes, no data model changes)
- Useful (real user need from support tickets)
- Small (3-4 hours, fits in one session)
- Uses existing settings module (v2.6.0 feature)

**Consequences:**
- Good test of architecture adherence
- Validates brief format
- Proves session management system
- Template can be extracted after success

---

## [2025-10-13] - Decision: Track printer status separately from DeviceModel

**Context:** BR-001 requires tracking printer connection status (connected/offline/connecting)

**Options:**
1. Add status fields to DeviceModel (requires making it mutable or recreating often)
2. Track status separately in ViewModel using Map<String, PrinterStatus>
3. Create new PrinterWithStatus wrapper class

**Decision:** Option 2 - Track status in ViewModel using Map keyed by macAddress

**Rationale:**
- DeviceModel is immutable and used for persistence (good design)
- Connection status is transient and changes frequently (every 10s)
- Adding to DeviceModel would violate immutability or require constant recreation
- Map approach keeps concerns separated: DeviceModel = config, status = runtime state
- Easy to lookup status by macAddress when rendering UI

**Implementation:**
```dart
// In SettingsViewModel
final RxMap<String, PrinterStatus> _printerStatuses = <String, PrinterStatus>{}.obs;

class PrinterStatus {
  final bool isConnected;
  final String statusText;
  final Color statusColor;
}
```

**Consequences:**
- ViewModel slightly more complex (manages both devices and statuses)
- No changes needed to DeviceModel (preserves immutability)
- Status not persisted (acceptable - it's transient anyway)

---

## [2025-11-15] - Decision: Architectural Pivot - Igris as MCP Server with Claude Code Brain

**Context:** Built Igris Desktop UI + Python bridge using Claude API directly. Realized this deviates from core vision and wastes Claude Code Max subscription.

**Original Vision:**
- Igris as universal MCP server
- Claude Code as the brain (using existing Max subscription)
- Connect from anywhere: Desktop, Terminal, Phone, Web
- LangChain/LangGraph as specialized agent chain
- Multiple MCP connections (GitHub, FS, Git, etc.)

**What Was Built (Wrong Direction):**
- Python HTTP server (not MCP protocol)
- Claude API direct calls (bypassing Claude Code, duplicate cost)
- Desktop UI standalone (not MCP client)
- LangChain isolated (not integrated with Claude Code)

**Options Evaluated:**
1. **Keep current** - Python bridge + Claude API (works but wrong architecture, wastes money)
2. **Full Claude Code** - Everything through Claude Code (pure but inflexible)
3. **Igris MCP + Claude Code brain** - Igris exposes MCP tools, uses Claude Code as execution engine (BEST)

**Decision:** Option 3 - Build Igris as proper MCP server with Claude Code as brain

**Rationale:**
- ✅ Uses Claude Code Max subscription (no duplicate API costs)
- ✅ True MCP architecture (future-proof for multi-client)
- ✅ Claude Code's full power (Read, Write, Edit, Bash tools)
- ✅ LangChain/LangGraph as MCP tools within Igris
- ✅ Can connect from Desktop, Phone, Web, Terminal
- ✅ Aligns with industry direction (MCP is the standard)
- ✅ Orchestrated intelligence (smart routing to best tool)

**Implementation Plan:**
1. Build Igris MCP server (TypeScript/Python with MCP SDK)
2. Expose 50+ tools: briefs, sessions, code analysis, LangChain chains, LangGraph workflows
3. Integrate Claude Code as execution engine (not just another client)
4. Desktop UI becomes MCP client
5. Future: Phone, Web, VS Code extensions (all MCP clients)

**Cost Impact:**
- Before: Claude Code Max ($100) + API calls ($X) = Paying twice
- After: Claude Code Max ($100) only = One subscription, full power

**Technical Benefits:**
- Shared context across all interfaces
- Unified API usage tracking
- No duplicate logic
- Industry-standard protocol (MCP)
- Easier to add new clients

**Consequences:**
- Current Python bridge becomes legacy (archive/reference)
- Desktop UI needs MCP client refactor (worth it)
- More upfront work but better long-term architecture
- Aligns system with original vision

**Status:** Decision approved, pivot in progress

---

## [2025-11-16] - Decision: TypeScript for Igris MCP Server (not Python)

**Context:** MG-001 requires choosing SDK for building Igris as MCP server. Two official SDKs: TypeScript and Python.

**Research Summary:**
- **TypeScript SDK:** v1.22.0, 16,366 projects using it, mature, type-safe, Zod validation built-in
- **Python SDK:** v1.21.1, FastMCP for quick setup, asyncio event loop, good for data science

**Both Options:**

**TypeScript Pros:**
- Type safety catches errors at compile time
- Single-threaded non-blocking event loop excels at I/O-bound MCP server tasks
- Richest VS Code UX for generated servers
- Most mature official SDK (official reference implementation)
- Zod schemas baked into SDK (robust validation out of the box)
- Production-ready (used to build official reference servers)
- Better tooling for protocol itself
- OAuth support just added (production requirement)
- Easy npm publishing/distribution

**TypeScript Cons:**
- Can't directly import Python LangChain/LangGraph code
- Need subprocess calls to Python for AI chains
- Team less familiar with TypeScript vs Python

**Python Pros:**
- Can directly import LangChain/LangGraph modules (same language)
- Familiar to team (already using Python)
- FastMCP provides quick setup
- Good for data science workloads
- Asyncio event loop suitable for I/O

**Python Cons:**
- Less type safety (runtime errors vs compile-time)
- Smaller ecosystem for MCP specifically
- Less mature OAuth support
- Not ideal for long-running server processes

**Decision:** **TypeScript** for Igris MCP Server

**Rationale:**
1. **Production maturity** - TypeScript SDK is reference implementation, most battle-tested
2. **Type safety** - Critical for 50+ tools with complex schemas
3. **Performance** - Event loop perfect for I/O-bound MCP server workload
4. **Industry standard** - Most MCP servers in wild use TypeScript
5. **Future-proof** - Better tooling, OAuth support, ecosystem momentum
6. **Clean separation** - MCP server (TypeScript) calls Python modules via subprocess
   - Forces clean API boundaries
   - Python stays focused on AI logic
   - TypeScript stays focused on protocol/tools
7. **VS Code integration** - Best dev experience for MCP development

**Implementation Approach:**
```typescript
// Igris MCP server (TypeScript)
server.tool('igris_analyze_code', async (args) => {
  // Call Python LangChain via subprocess
  const result = await execPython('langchain/analyze.py', args);
  return result;
});
```

**Consequences:**
- Need Node.js/npm in deployment (acceptable)
- Python modules become subprocess calls (actually cleaner!)
- Learning curve for TypeScript (worth it for quality)
- Can publish as npm package later (`npx igris-mcp-server`)

**Status:** Decided - TypeScript MCP Server

---

_Add new decisions as they are made during implementation_
