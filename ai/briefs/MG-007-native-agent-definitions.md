# MG-007: Native Agent Definitions — Port Agents to .claude/agents/

**Type:** Migration
**Priority:** P2-Medium
**Effort:** L-Large (3-5d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Ready
**Created:** 2026-02-05
**Completed:** _(pending)_

---

## Current State

**What's the problem with the current implementation?**

Igris AI's 18 agents are defined in `.claude/agents/manifest.yaml` — a custom registry that maps agent names to Claude Code's native `Task` tool `subagent_type` parameter. The manifest provides metadata (persona aliases, tools, triggers) but the actual agent behavior relies on Claude Code's built-in agent types (planner, coder, tester, etc.) with no custom system prompts or tool restrictions.

Problems:
- No custom system prompts per agent — all agents use generic behavior
- No persistent memory — agents forget everything between invocations
- No per-agent tool restrictions — all agents inherit full tool access
- No per-agent hooks — cannot validate agent-specific operations
- No skill preloading — agents don't load domain-specific knowledge
- Persona aliases (ARCHITECT, FORGER, SENTINEL) are cosmetic only
- Custom agents (Tier 5) have no standardized definition format

**Why does it need to change?**

Claude Code now natively supports custom agent definitions as `.claude/agents/*.md` files with:
- **Custom system prompts** — detailed instructions per agent
- **`memory: project`** — persistent agent memory across sessions
- **`tools` field** — explicit tool allowlists/denylists
- **`skills` preloading** — inject skill content at agent startup
- **`hooks`** — per-agent lifecycle hooks
- **`model` selection** — route to haiku/sonnet/opus per agent
- **`permissionMode`** — control agent permissions

---

## Target State

**What should it look like after migration?**

```
.claude/agents/
├── architect.md          # planner - Implementation planning
├── forger.md             # coder - Code implementation
├── sentinel.md           # tester - Test execution
├── warden.md             # reviewer - Code review
├── artisan.md            # ui-designer - Visual design
├── chronicler.md         # documenter - Documentation
├── herald.md             # releaser - Release preparation
├── lawkeeper.md          # standardizer - Standards generation
├── inquisitor.md         # auditor - Code analysis
├── mender.md             # debugger - Error recovery
├── pathfinder.md         # migrator - Migration analysis
├── oracle.md             # ideator - Feature ideation
├── seeker.md             # explorer - Codebase research
├── sage.md               # flutter-mvvm-actions-expert
├── conductor.md          # multi-agent-coordinator
├── tactician.md          # agent-organizer
├── archivist.md          # context-manager
└── dispatcher.md         # task-distributor
```

Each agent file follows this pattern:

```markdown
---
name: architect
description: Strategic implementation planner. Use when planning implementation for briefs, designing architecture, or creating step-by-step plans. Use proactively before any code changes.
tools: Read, Grep, Glob
model: inherit
memory: project
skills:
  - api-conventions
---

You are ARCHITECT, Igris AI's strategic implementation planner.

## Your Role
Plan implementations for briefs by analyzing the codebase, identifying affected files, and creating step-by-step implementation plans.

## Standards
Follow patterns from coding_guidelines.md. Respect layer boundaries.

## Output Format
Return a structured plan with:
1. Affected files list
2. Dependency analysis
3. Step-by-step implementation tasks
4. Risk assessment
5. Test strategy
```

---

## Migration Steps

1. [ ] Design system prompt template for all agent types
2. [ ] Create Tier 1 agents (architect, forger, sentinel, warden, artisan)
3. [ ] Create Tier 2 agents (chronicler, herald, lawkeeper)
4. [ ] Create Tier 3 agents (inquisitor, mender, pathfinder)
5. [ ] Create Tier 4 agents (oracle, seeker)
6. [ ] Create Tier 5 agent (sage - flutter-mvvm-actions-expert)
7. [ ] Create Tier 6 meta agents (conductor, tactician, archivist, dispatcher)
8. [ ] Enable `memory: project` for all agents
9. [ ] Configure appropriate tool restrictions per agent
10. [ ] Preload relevant skills where applicable (after MG-005)
11. [ ] Add per-agent hooks where needed
12. [ ] Test each agent with real workflow tasks
13. [ ] Migrate manifest.yaml references to native agent discovery
14. [ ] Update igris_os.md agent registry documentation
15. [ ] Update DIGIVOLVE command to manage .claude/agents/ files

---

## Tasks

### Pending
- [ ] Task 1: Design agent system prompt template
- [ ] Task 2: Create all 18 agent .md files with system prompts
- [ ] Task 3: Configure tool restrictions per agent tier
- [ ] Task 4: Enable persistent memory for agents
- [ ] Task 5: Test agent delegation and handoff
- [ ] Task 6: Migrate DIGIVOLVE to manage native agent files
- [ ] Task 7: Deprecate manifest.yaml (keep as reference)

### In Progress
_(none)_

### Completed
_(none)_

---

## Workflow State

**Phase:** INIT
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered. Awaiting implementation.

### Next Steps
Design system prompt template, starting with Tier 1 core agents.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|

### Blockers
None (soft dependency on MG-005 for skill preloading)

---

## Impact Assessment

### Affected Files
- [ ] `.claude/agents/*.md` - 18 new agent definition files
- [ ] `.claude/agents/manifest.yaml` - Deprecated (kept as reference)
- [ ] `ai/prompts/igris_os.md` - Update agent registry section
- [ ] `ai/persona.json` - Agent aliases remain for display names
- [ ] `CLAUDE.md` - Update agent documentation references

### Affected Modules
- [ ] `Agent system` - Complete migration to native definitions
- [ ] `DIGIVOLVE` - Must manage .claude/agents/*.md files
- [ ] `HUNT workflow` - Agent invocation uses native agent names
- [ ] `Agent metrics` - Track native agent invocations

### Breaking Changes
- [x] **Yes** - Agent invocation changes from `subagent_type="planner"` to `subagent_type="architect"` (custom agent names). Requires updating HUNT workflow references.

### Dependencies
- [ ] Depends on: None (can proceed independently)
- [ ] Enhanced by: MG-005 (skills to preload into agents)
- [ ] Enhanced by: MG-006 (hooks for per-agent validation)
- [ ] Blocks: None

---

## Testing Strategy

### Manual Testing

#### Test Case 1: Agent Delegation
**Steps:**
1. Ask Claude to plan implementation of a brief
2. Verify ARCHITECT agent is invoked (not generic planner)
3. Check that agent uses custom system prompt

**Expected:** ARCHITECT agent runs with focused planning behavior
**Status:** [ ] Pass / [ ] Fail

#### Test Case 2: Persistent Agent Memory
**Steps:**
1. Run ARCHITECT on brief analysis
2. Start new session
3. Run ARCHITECT again on related task
4. Check if agent recalls previous learnings

**Expected:** Agent memory persists in `.claude/agent-memory/architect/`
**Status:** [ ] Pass / [ ] Fail

#### Test Case 3: Tool Restrictions
**Steps:**
1. Invoke SEEKER (explorer) agent
2. Verify it cannot use Write/Edit tools
3. Verify it can use Read/Grep/Glob

**Expected:** Read-only tools only, Write/Edit denied
**Status:** [ ] Pass / [ ] Fail

#### Test Case 4: HUNT Workflow with Native Agents
**Steps:**
1. Run full HUNT workflow on a brief
2. Verify each phase delegates to correct native agent
3. Verify agent handoffs work correctly

**Expected:** ARCHITECT → FORGER → SENTINEL → WARDEN → commit
**Status:** [ ] Pass / [ ] Fail

---

## Rollback Plan

1. Remove custom `.claude/agents/*.md` files
2. Restore manifest.yaml as primary agent registry
3. Revert HUNT workflow to use generic subagent_type names

**Rollback safe until:** Merged to main

---

## Acceptance Criteria

1. [ ] All 18 agents defined as `.claude/agents/*.md` files
2. [ ] Each agent has focused system prompt (not generic)
3. [ ] Persistent memory enabled for all agents (`memory: project`)
4. [ ] Tool restrictions appropriate per agent tier
5. [ ] HUNT workflow delegates to custom agents correctly
6. [ ] DIGIVOLVE manages native agent files
7. [ ] Agent memory accumulates useful codebase knowledge
8. [ ] No regression in autonomous workflow quality
9. [ ] Documentation updated

---

## References

**External References:**
- Claude Code Subagents Docs: https://code.claude.com/docs/en/sub-agents
- Custom agent .md file format
- `memory: user|project|local` persistent memory
- `skills` preloading into subagents
- `hooks` in agent frontmatter
- `/agents` interactive management command

**Related Briefs:**
- Enhanced by: MG-005 (Skills to preload)
- Enhanced by: MG-006 (Per-agent hooks)
- Builds on: MG-004 (Clean memory architecture)

---

## Notes

The biggest win here is **persistent agent memory**. Agents like ARCHITECT and FORGER can build up knowledge about the codebase over time — architectural patterns, common pitfalls, preferred approaches. This is institutional knowledge that survives context resets.

Consider starting with Tier 1 agents (architect, forger, sentinel, warden) since they're used in every HUNT workflow, then expanding to other tiers.

The `model` field per agent is powerful — route SEEKER to haiku for fast exploration, keep ARCHITECT on inherit/sonnet for quality planning.

---

**Created:** 2026-02-05
**Last Updated:** 2026-02-05
**Brief Owner:** Crimson (Fifty.ai)
