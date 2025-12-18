# FR-004: Add MCP Server Setup to Init Script

**Type:** FR
**Priority:** P2
**Effort:** TBD
**Status:** In Progress
**Created:** 2025-12-18
**Completed:** _TBD_

---

## Problem

igris_init.sh does not handle MCP server setup. Users must manually: 1) Check for Node.js 20+, 2) Run npm install && npm run build in mcp-server/, 3) Configure ~/.claude/config.json with the server path. This creates friction for new users and leaves MCP tools unavailable without manual intervention.

---

## Goal

igris_init.sh automatically: 1) Detects Node.js availability (warns if missing, continues gracefully), 2) Offers to build MCP server if Node.js present, 3) Offers to configure ~/.claude/config.json with correct paths, 4) Works without MCP if Node.js unavailable (graceful degradation). Result: Zero-friction MCP setup for users with Node.js, clear messaging for those without.

---

## Tasks

### Pending
- [ ] TBD

### In Progress
_(None yet)_

### Completed
_(None yet)_

---

## Session State

**Current State:** Brief created
**Next Steps When Resuming:** Define tasks and acceptance criteria
**Last Updated:** 2025-12-18
**Blockers:** None

---

## Acceptance Criteria

1. [ ] TBD

---

**Created:** 2025-12-18
**Last Updated:** 2025-12-18
