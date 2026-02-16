# MG-009 Phase 2: Knowledge Base — Implementation Plan

**Brief:** MG-009 — Centralized Brain Architecture
**Phase:** 2 of 4 — Knowledge Base (MCP Server + Staging Pipeline)
**Created:** 2026-02-16

---

## Overview

Phase 2 builds the centralized MCP server at `~/.igris/mcp-server/` with:
- Memory tools: `igris_memory_store`, `igris_memory_search`, `igris_memory_recall`
- Error tools: `igris_error_lookup`
- Project tools: `igris_project_register`, `igris_project_list`, `igris_project_status`
- Staging pipeline: hook script + processor for session-end data capture
- Global registration in `~/.claude.json`

---

## Implementation Steps

### Step 1: Create MCP Server Package

New `mcp-server/` directory inside the igris-ai repo (will be copied to `~/.igris/mcp-server/` by brain_init.sh).

**package.json:**
- Name: `igris-brain-mcp-server`
- Dependencies: `@modelcontextprotocol/sdk`, `better-sqlite3`
- Dev deps: `@types/better-sqlite3`, `typescript`, `@types/node`

**Why better-sqlite3:** Synchronous API is simpler for MCP tool handlers. WAL mode support. Much better performance than spawning sqlite3 CLI per query.

### Step 2: Implement Database Helper (`src/db.ts`)

Shared database connection with:
- WAL mode, busy_timeout=5000, trusted_schema=ON
- Connection singleton (one per MCP server process)
- Helper methods for common queries

### Step 3: Implement Memory Tools (`src/tools/memory.ts`)

**igris_memory_store:** Store a learning in the knowledge DB
- Params: project, category, title, content, tags, tech_stack, source_brief, scope
- Insert into learnings table
- Return: learning ID

**igris_memory_search:** Full-text search across learnings
- Params: query, project (optional), scope (optional), limit
- Uses FTS5 MATCH on learnings_fts
- Supports cross-project search when scope='global' or project omitted
- Returns: matching learnings with rank score

**igris_memory_recall:** Contextual retrieval for current project
- Params: project, context (what you're working on), limit
- Combines: project-local learnings + global learnings matching context
- Uses FTS5 for relevance ranking
- Returns: relevant learnings sorted by relevance

### Step 4: Implement Error Tools (`src/tools/errors.ts`)

**igris_error_lookup:** Look up or store error solutions
- Params: message, project, solution (optional)
- If solution provided: store/update error entry
- If no solution: search for matching errors by fingerprint or FTS
- Fingerprinting: normalize error message (strip paths, line numbers, hashes) then hash
- Returns: known solutions or "no match"

### Step 5: Implement Project Tools (`src/tools/projects.ts`)

**igris_project_register:** Register a project in the brain
- Params: slug, name, path, tech_stack
- INSERT OR REPLACE into projects table
- Returns: project record

**igris_project_list:** List all registered projects
- Params: status (optional filter)
- Returns: all projects with last_session timestamp

**igris_project_status:** Get detailed status of a project
- Params: slug
- Returns: project info + learning count + error count + recent agent metrics

### Step 6: Implement Metrics Tools (`src/tools/metrics.ts`)

**igris_metrics_record:** Record an agent metric
- Params: project, agent, brief_id, action, result, duration_ms, retry_count
- Insert into agent_metrics table

**igris_metrics_query:** Query agent performance
- Params: project (optional), agent (optional), limit
- Returns: aggregated metrics (success rate, avg duration, by agent)

### Step 7: Create MCP Server Entry Point (`src/index.ts`)

- Register all tools from memory, errors, projects, metrics modules
- Initialize DB connection on startup
- Process any pending staging files on startup
- stdio transport (standard MCP pattern)

### Step 8: Create Staging Pipeline

**`scripts/igris-sync.sh`:** Hook script for SessionEnd
- Captures session learnings from CURRENT_SESSION.md, DECISIONS.md, LEARNINGS.md
- Writes JSON files to `~/.igris/staging/{project-slug}/`
- Unique filenames: `{timestamp}-{uuid}.json`

**Staging processor** (in MCP server `src/staging.ts`):
- On server startup, scan staging directory
- Process each JSON file → insert into knowledge.db
- Delete processed files after successful commit
- Idempotent (safe to re-run)

### Step 9: Update `igris_brain_init.sh`

- Copy the new MCP server source to `~/.igris/mcp-server/`
- Run `npm install && npm run build` in `~/.igris/mcp-server/`
- Register MCP server in `~/.claude.json` (global config)

### Step 10: Register in `~/.claude.json`

Add to the global Claude config:
```json
{
  "mcpServers": {
    "igris-brain": {
      "command": "node",
      "args": ["~/.igris/mcp-server/dist/index.js"]
    }
  }
}
```

---

## Files to Create

| # | File | Purpose |
|---|------|---------|
| 1 | `brain-mcp-server/package.json` | Package manifest |
| 2 | `brain-mcp-server/tsconfig.json` | TypeScript config |
| 3 | `brain-mcp-server/src/index.ts` | MCP server entry point |
| 4 | `brain-mcp-server/src/db.ts` | SQLite database helper |
| 5 | `brain-mcp-server/src/tools/memory.ts` | Memory store/search/recall tools |
| 6 | `brain-mcp-server/src/tools/errors.ts` | Error lookup tool |
| 7 | `brain-mcp-server/src/tools/projects.ts` | Project register/list/status tools |
| 8 | `brain-mcp-server/src/tools/metrics.ts` | Agent metrics tools |
| 9 | `brain-mcp-server/src/staging.ts` | Staging file processor |
| 10 | `scripts/igris-sync.sh` | SessionEnd hook script |

## Files to Modify

| # | File | Change |
|---|------|--------|
| 1 | `scripts/igris_brain_init.sh` | Add MCP server build + registration steps |

---

**Plan Status:** Ready for implementation
