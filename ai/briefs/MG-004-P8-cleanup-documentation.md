# MG-004-P8: Cleanup & Documentation

**ID:** MG-004-P8
**Type:** Migration
**Status:** Done
**Priority:** P1-High
**Created:** 2025-12-03
**Updated:** 2025-12-03
**Effort:** M-Medium (1-2 days)
**Parent:** MG-004 (IGRIS v3.1 Migration)
**Phase:** 8 of 8

---

## Summary

Complete the v3.1 migration by removing deprecated plugins (LangChain/LangGraph), updating all documentation, cleaning up references, and validating the final system.

---

## Problem

After migration, cleanup is needed:
- LangChain/LangGraph directories still exist (unused)
- MCP server still has langchain.ts, langgraph.ts files
- Documentation references old architecture
- README doesn't document new agent system
- igris_desktop may have LangGraph-specific UI elements
- ai/plugins/installed.json lists deprecated plugins
- CLAUDE.md references old plugin hooks

---

## Goal

Clean system with no legacy artifacts:
1. Remove all LangChain/LangGraph code
2. Update all documentation for v3.1
3. Update igris_desktop if affected
4. Create migration guide for users
5. Validate complete system
6. Prepare release

---

## Deliverables

### 1. Remove Deprecated Directories

```bash
# Remove LangChain plugin
rm -rf ai/langchain/

# Remove LangGraph plugin
rm -rf ai/langgraph/

# Verify removal
ls ai/
# Should show: briefs/ context/ hooks/ personas/ plugins/ prompts/ session/
```

### 2. Update ai/plugins/installed.json

**Before:**
```json
{
  "installed": [
    "igris-langchain",
    "igris-langgraph",
    "igris-persona-cyber-monkey"
  ]
}
```

**After:**
```json
{
  "installed": [
    "igris-persona-cyber-monkey"
  ],
  "deprecated": [
    {
      "name": "igris-langchain",
      "removed_in": "3.1.0",
      "reason": "Replaced by native Claude Code subagents"
    },
    {
      "name": "igris-langgraph",
      "removed_in": "3.1.0",
      "reason": "Replaced by native Claude Code subagents"
    }
  ]
}
```

### 3. Update MCP Server (if applicable)

Check and remove deprecated tool files:

```
fifty_mcp_client/
├── src/
│   ├── tools/
│   │   ├── igris/
│   │   │   ├── briefs.ts        ✅ Keep
│   │   │   ├── session.ts       ✅ Keep
│   │   │   ├── git.ts           ✅ Keep
│   │   │   ├── file.ts          ✅ Keep
│   │   │   ├── langchain.ts     ❌ Remove
│   │   │   └── langgraph.ts     ❌ Remove
```

### 4. Update CLAUDE.md

Remove or update these sections:

**Remove/Update:**
```markdown
## Enhancement Hooks

❌ Remove: "igris-langchain, igris-langgraph" from installed plugins

✅ Update to:
**Installed Enhancement Plugins:** igris-persona-cyber-monkey, igris-subagents
```

**Add new section:**
```markdown
## 🦾 Subagent Architecture

IGRIS v3.1 uses native Claude Code subagents for autonomous workflows:

### Agent Tiers
| Tier | Agents | Purpose |
|------|--------|---------|
| 1 - Core | planner, coder, tester, reviewer | Development workflow |
| 2 - Docs | documenter, releaser | Documentation pipeline |
| 3 - Maintenance | auditor, debugger | Quality & recovery |
| 4 - Innovation | ideator, explorer | Research & ideas |
| 5 - Custom | user-defined | Extensibility |

### Workflow Commands
- `HUNT {brief-id}` - Trigger autonomous implementation
- `AUDIT {type}` - Run code analysis
- `DIGIVOLVE status` - View agent roster

### Persona Aliases
Agents have static names internally. Personas define display aliases in persona.json.
See `.claude/agents/manifest.yaml` for full agent registry.
```

### 5. Update README.md

Add v3.1 architecture section:

```markdown
## Architecture

### IGRIS v3.1 - Native Subagent Ecosystem

IGRIS uses Claude Code's native subagent capability for autonomous development:

```
┌─────────────────────────────────────────────────────────────┐
│                    IGRIS MAIN AGENT                         │
│         (Orchestrator, MCP Owner, Decision Maker)           │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ Task tool
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     AGENT MANIFEST                          │
│                  .claude/agents/manifest.yaml               │
└─────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
    ┌──────────┐        ┌──────────┐        ┌──────────┐
    │ Tier 1   │        │ Tier 2   │        │ Tier 3   │
    │ Core     │        │ Docs     │        │ Maint    │
    ├──────────┤        ├──────────┤        ├──────────┤
    │ planner  │        │documenter│        │ auditor  │
    │ coder    │        │ releaser │        │ debugger │
    │ tester   │        └──────────┘        └──────────┘
    │ reviewer │
    └──────────┘
```

### Key Benefits
- **$0 Extra Cost** - No external API calls
- **10 Specialized Agents** - Right tool for every job
- **Self-Healing** - Automatic error recovery
- **Persona Themes** - Customizable agent names
```

### 6. Create Migration Guide

Create `docs/migration-v3.1.md`:

```markdown
# Migration Guide: v2.x/v3.0 → v3.1

## Overview

IGRIS v3.1 replaces external LangChain/LangGraph plugins with native Claude Code subagents.

## Breaking Changes

### Removed Plugins
- `igris-langchain` - No longer needed
- `igris-langgraph` - No longer needed

### Removed Directories
```
ai/langchain/    → Removed
ai/langgraph/    → Removed
```

### New Directories
```
.claude/agents/  → Agent definitions
```

## Migration Steps

### Step 1: Backup (Optional)
```bash
cp -r ai/langchain ai/langchain.bak
cp -r ai/langgraph ai/langgraph.bak
```

### Step 2: Remove Old Plugins
```bash
rm -rf ai/langchain
rm -rf ai/langgraph
```

### Step 3: Update installed.json
Edit `ai/plugins/installed.json`:
- Remove "igris-langchain" from installed array
- Remove "igris-langgraph" from installed array

### Step 4: Update Persona (if custom)
If you have a custom persona, add `agent_aliases` section:

```json
{
  "agent_aliases": {
    "planner": "YOUR_PLANNER_NAME",
    "coder": "YOUR_CODER_NAME",
    "tester": "YOUR_TESTER_NAME",
    "reviewer": "YOUR_REVIEWER_NAME",
    "documenter": "YOUR_DOCUMENTER_NAME",
    "releaser": "YOUR_RELEASER_NAME",
    "auditor": "YOUR_AUDITOR_NAME",
    "debugger": "YOUR_DEBUGGER_NAME",
    "ideator": "YOUR_IDEATOR_NAME",
    "explorer": "YOUR_EXPLORER_NAME"
  }
}
```

### Step 5: Verify
Start a new Claude Code session and verify:
```
SCAN
```
Should show agent roster without LangChain/LangGraph references.

## FAQ

### Q: What if I customized LangChain/LangGraph?
A: Custom chains/graphs need to be recreated as subagent prompts in `.claude/agents/`.

### Q: Can I still use external APIs?
A: Yes, but via the main agent's MCP tools, not subagents.

### Q: How do I create custom agents?
A: Use `DIGIVOLVE add` to create Tier 5 custom agents.
```

### 7. Update igris_desktop (if needed)

Check for LangGraph-specific UI elements:

**Locations to check:**
- `lib/features/langgraph/` - Remove if exists
- `lib/widgets/langgraph_*` - Remove if exists
- `lib/services/langgraph_service.dart` - Remove if exists

**Add new UI elements (if applicable):**
- Agent roster display
- Agent metrics dashboard
- Workflow state visualization

### 8. Final Validation Checklist

```markdown
## Pre-Release Validation

### Code Cleanup
- [ ] ai/langchain/ directory removed
- [ ] ai/langgraph/ directory removed
- [ ] MCP langchain.ts removed (if existed)
- [ ] MCP langgraph.ts removed (if existed)
- [ ] ai/plugins/installed.json updated
- [ ] No grep hits for "langchain" in active code
- [ ] No grep hits for "langgraph" in active code

### New System
- [ ] .claude/agents/ directory exists
- [ ] manifest.yaml contains all 10 agents
- [ ] All 10 agent .md files exist
- [ ] Persona aliases resolve correctly
- [ ] Workflow state machine works
- [ ] Self-healing triggers on test failure
- [ ] DIGIVOLVE commands work

### Documentation
- [ ] CLAUDE.md updated for v3.1
- [ ] README.md has architecture section
- [ ] Migration guide created
- [ ] All briefs have updated references

### Testing
- [ ] Full workflow test (HUNT a brief)
- [ ] Audit test (AUDIT code_quality)
- [ ] Documentation test (CHRONICLE)
- [ ] Release test (HERALD)
- [ ] Persona alias test (both crimson and igris)
```

### 9. Release Preparation

After validation, trigger releaser agent:

```markdown
## Release v3.1.0

### Changelog Entry
- See MG-004-P3 releaser agent for format

### Version Bump
- MAJOR: Breaking changes (removed plugins)
- New version: 3.1.0

### GitHub Release
- Tag: v3.1.0
- Title: "IGRIS v3.1 - The Complete Ecosystem"
- Include migration guide link
```

---

## Tasks

### Cleanup
- [ ] Remove ai/langchain/ directory
- [ ] Remove ai/langgraph/ directory
- [ ] Update ai/plugins/installed.json
- [ ] Check/update MCP server tools
- [ ] Remove langchain/langgraph references from CLAUDE.md

### Documentation Updates
- [ ] Update CLAUDE.md with subagent section
- [ ] Update README.md with architecture
- [ ] Create docs/migration-v3.1.md
- [ ] Update any docs referencing old plugins

### Desktop Updates (if applicable)
- [ ] Audit igris_desktop for langgraph UI
- [ ] Remove deprecated UI elements
- [ ] Add agent roster display (optional)

### Validation
- [ ] Run cleanup validation grep
- [ ] Test full autonomous workflow
- [ ] Test persona alias resolution
- [ ] Test all DIGIVOLVE commands

### Release
- [ ] Generate changelog with releaser
- [ ] Create GitHub release
- [ ] Tag v3.1.0

---

## Acceptance Criteria

- [ ] ai/langchain/ removed
- [ ] ai/langgraph/ removed
- [ ] Zero grep hits for "langchain" in active code
- [ ] Zero grep hits for "langgraph" in active code
- [ ] CLAUDE.md documents new subagent system
- [ ] README.md has architecture diagram
- [ ] Migration guide exists and is complete
- [ ] Full workflow test passes
- [ ] Persona aliases work correctly
- [ ] DIGIVOLVE commands functional
- [ ] Release v3.1.0 created

---

## Session State

**Current Status:** Not Started
**Current Task:** None
**Blockers:** None
**Next Step:** Wait for P1-P7 completion

---

## Dependencies

- **Depends on:** ALL prior phases (P1-P7 must be complete)
- **Blocks:** Nothing (final phase)

---

## History

- 2025-12-03: Brief created

---

🔥 **CLEAN HOUSE. SHIP IT.** 🔥
