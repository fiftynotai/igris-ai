# Igris AI MCP Server

**Version:** 3.0.0
**Protocol:** Model Context Protocol (MCP)
**Transport:** stdio
**Built with:** TypeScript + @modelcontextprotocol/sdk

---

## Overview

Igris AI MCP Server exposes Igris AI capabilities via the Model Context Protocol, enabling any MCP client to access:

- **Brief management** (BR, FR, TD, MG, TS briefs)
- **Session tracking** and recovery
- **File operations**
- **LangChain/LangGraph** workflows (future)

This is the **foundational migration** (MG-001) transforming Igris from custom HTTP protocols to industry-standard MCP architecture.

---

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Build

```bash
npm run build
```

### 3. Run Server

```bash
npm start
# or
node dist/index.js
```

### 4. Test with MCP Inspector

```bash
npm run inspect
# or
npx @modelcontextprotocol/inspector node dist/index.js
```

---

## Available Tools (17 Total)

### Brief Management (5 tools)

**`igris_brief_list`** - List briefs with filters
- `type` (optional): BR, FR, TD, MG, TS, PI, DU, PF, AC
- `status` (optional): Ready, In Progress, Done, Draft
- `priority` (optional): P0, P1, P2, P3

**`igris_brief_read`** - Read specific brief
- `brief_id` (required): e.g., BR-001, MG-002

**`igris_brief_create`** - Create new brief
- `type` (required): BR, FR, TD, MG, TS
- `title` (required): Brief title
- `priority` (required): P0-P3
- `problem` (required): Problem description
- `goal` (required): Expected outcome

**`igris_brief_update`** - Update brief status/priority
- `brief_id` (required): Brief to update
- `status` (optional): Ready, In Progress, Done, Draft
- `priority` (optional): P0, P1, P2, P3

**`igris_brief_archive`** - Archive completed brief
- `brief_id` (required): Brief to archive (must be Done)

### Session Management (2 tools)

**`igris_session_get`** - Get current session state

**`igris_session_update`** - Update session state
- `status` (optional): Session status
- `next_steps` (optional): Next steps when resuming

### File Operations (1 tool)

**`igris_file_read`** - Read project file
- `path` (required): Relative path from project root

### Git Operations (4 tools)

**`igris_git_status`** - Get git status (short format)

**`igris_git_diff`** - Get git diff
- `file` (optional): Specific file to diff
- `staged` (optional): Show staged changes

**`igris_git_log`** - Get commit history
- `limit` (optional): Number of commits (default: 10)

**`igris_git_commit`** - Create git commit
- `message` (required): Commit message
- `files` (optional): Files to stage

### LangChain AI Tools (2 tools)

**`igris_langchain_generate_brief`** - AI-generated brief
- `description` (required): Natural language description
- `type` (optional): BR, FR, TD (default: BR)

**`igris_langchain_analyze_code`** - Code analysis with RAG
- `file_path` (required): File to analyze
- `question` (required): Question about the code

### LangGraph Agent Tools (3 tools)

**`igris_langgraph_code_review`** - Autonomous code review
- `files` (required): Files to review
- `guidelines_path` (optional): Coding guidelines path

**`igris_langgraph_implementation`** - Autonomous implementation
- `brief_id` (required): Brief to implement
- `instructions` (optional): Additional instructions

**`igris_langgraph_planning`** - Autonomous planning
- `goal` (required): Planning goal
- `context` (optional): Additional context

---

## Architecture

```
Igris MCP Server (TypeScript)
├─ index.ts             # Main server + stdio transport
├─ tools/
│  ├─ briefs.ts         # Brief management
│  ├─ session.ts        # Session tracking
│  └─ files.ts          # File operations
└─ types/               # Shared types (future)
```

**Key Design Decisions:**

1. **TypeScript chosen over Python** (see ai/session/DECISIONS.md)
   - Type safety for 50+ tools
   - Production-ready SDK
   - Clean separation: TS = protocol, Python = AI logic

2. **stdio transport** (not HTTP)
   - MCP standard
   - Works with Claude Code, Desktop UI, CLI

3. **Tool-based architecture**
   - Each category = separate module
   - Easy to extend with new tools

---

## Development

### Watch Mode

```bash
npm run dev
```

TypeScript will recompile on file changes.

### Testing

```bash
npm test
```

(Tests coming in Phase 2)

---

## Integration with Claude Code

**Step 1:** Add to Claude Code config (`~/.claude/config.json`):

```json
{
  "mcpServers": {
    "igris-ai": {
      "command": "node",
      "args": ["/path/to/igris-ai/dist/index.js"]
    }
  }
}
```

**Step 2:** Restart Claude Code

**Step 3:** Use Igris tools:

```
You: List all P0 briefs

Claude: [calls igris_brief_list with priority=P0]
```

---

## Roadmap

**Phase 1: Foundation** (MG-001 - Week 1) ✅ COMPLETE
- [x] TypeScript SDK setup
- [x] stdio transport
- [x] First 6 tools (brief list/read/create, session get/update, file read)
- [x] Test with MCP inspector
- [x] Documentation

**Phase 2: Core Tools** (Week 2) ✅ COMPLETE
- [x] Add brief update/archive tools (2 tools)
- [x] Add git operations tools (4 tools)
- [x] Integrate LangChain as MCP tools (2 tools)
- [x] Integrate LangGraph as MCP tools (3 tools)
- [x] **Total: 17 tools operational!**

**Phase 3: Claude Code Integration** (MG-002)
- [ ] Claude Code as execution brain
- [ ] Route file ops through Claude Code tools
- [ ] Shared context

**Phase 4: Desktop UI** (MG-003)
- [ ] Refactor Flutter UI to MCP client
- [ ] Test multi-client scenarios

---

## Contributing

See `ai/CONTRIBUTING.md` for development guidelines.

**Key principle:** Dogfooding - we enforce our own standards.

---

## License

MIT

---

**Built with FIRE by the Igris AI team** 🔥
**Developed by:** Fifty.ai
**Powered by:** Model Context Protocol

---

**For issues/questions:**
- GitHub: github.com/fiftynotai/igris-ai
- Docs: MG-001 brief (`ai/briefs/MG-001-igris-mcp-server-foundation.md`)
