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

## Available Tools

### Brief Management

**`igris_brief_list`**
List briefs with optional filters

Parameters:
- `type` (optional): BR, FR, TD, MG, TS, PI, DU, PF, AC
- `status` (optional): Ready, In Progress, Done, Draft
- `priority` (optional): P0, P1, P2, P3

**`igris_brief_read`**
Read a specific brief by ID

Parameters:
- `brief_id` (required): e.g., BR-001, MG-002

**`igris_brief_create`**
Create a new brief

Parameters:
- `type` (required): Brief type
- `title` (required): Brief title
- `priority` (required): P0-P3
- `problem` (required): Problem description
- `goal` (required): Expected outcome

### Session Management

**`igris_session_get`**
Get current session state (reads CURRENT_SESSION.md)

**`igris_session_update`**
Update session state

Parameters:
- `status` (optional): Session status
- `next_steps` (optional): Next steps when resuming

### File Operations

**`igris_file_read`**
Read a file from the project

Parameters:
- `path` (required): Relative path from project root

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

**Phase 1: Foundation** (MG-001 - Week 1)
- [x] TypeScript SDK setup
- [x] stdio transport
- [x] First 6 tools (brief list/read/create, session get/update, file read)
- [ ] Test with MCP inspector
- [ ] Documentation

**Phase 2: Core Tools** (Week 2)
- [ ] Add brief update/archive tools
- [ ] Add git operations tools
- [ ] Integrate LangChain as MCP tools
- [ ] Integrate LangGraph as MCP tools

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
