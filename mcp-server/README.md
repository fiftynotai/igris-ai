# Igris AI MCP Server

**Version:** 3.2.0
**Protocol:** Model Context Protocol (MCP)
**Transport:** stdio
**Built with:** TypeScript + @modelcontextprotocol/sdk

---

## Overview

Igris AI MCP Server exposes Igris AI capabilities via the Model Context Protocol, enabling any MCP client to access:

- **Brief management** (BR, FR, TD, MG, TS briefs)
- **Session tracking** and recovery
- **File operations**
- **Git operations**

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

## Available Tools (12 Total)

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
   - Type safety for tools
   - Production-ready SDK
   - Clean architecture

2. **stdio transport** (not HTTP)
   - MCP standard
   - Works with Claude Code, Desktop UI, CLI

3. **Tool-based architecture**
   - Each category = separate module
   - Easy to extend with new tools

---

## v3.2 Changes

**What Changed:**

In v3.2, Igris AI moved from external LangChain/LangGraph plugins to **native Claude Code subagents**. This affects the MCP server:

- **Removed:** LangChain AI tools (2 tools) - now handled by native subagents
- **Removed:** LangGraph Agent tools (3 tools) - now handled by native subagents
- **Kept:** Core brief, session, file, and git operations (12 tools)

**Why:**

Native Claude Code subagents provide the same functionality at zero additional cost. The MCP server focuses on data operations while Claude Code handles AI workflows directly.

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

---

## Integration with Claude Code

**Step 1:** Add to Claude Code config (`~/.claude/config.json`):

```json
{
  "mcpServers": {
    "igris-ai": {
      "command": "node",
      "args": ["/path/to/igris-ai/mcp-server/dist/index.js"]
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

**Phase 1: Foundation** (MG-001) ✅ COMPLETE
- [x] TypeScript SDK setup
- [x] stdio transport
- [x] Brief management tools
- [x] Session and file tools
- [x] Documentation

**Phase 2: Core Tools** ✅ COMPLETE
- [x] Add brief update/archive tools
- [x] Add git operations tools

**Phase 3: Claude Code Integration** (MG-002) ✅ COMPLETE
- [x] Claude Code as execution brain
- [x] Shared context via MCP

**Phase 4: Desktop UI** (MG-003) ✅ COMPLETE
- [x] Flutter UI as MCP client
- [x] Multi-client support

**Phase 5: Native Subagents** (v3.2) ✅ CURRENT
- [x] 12 native Claude Code subagents
- [x] Zero-cost AI operations
- [x] Simplified MCP (data only, AI via Claude Code)

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
