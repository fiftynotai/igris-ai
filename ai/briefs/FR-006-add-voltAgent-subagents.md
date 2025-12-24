# FR-006: Add VoltAgent Subagents to Igris

**Type:** Feature Request
**Priority:** P2-Medium
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2025-12-24
**Completed:** 2025-12-24

---

## Feature Description

**What is the proposed feature?**

Add 5 new subagents from the VoltAgent awesome-claude-code-subagents repository to expand Igris capabilities in meta-orchestration and UI design.

**Why is this valuable?**

These agents add advanced orchestration capabilities (multi-agent coordination, task distribution, context management) and UI design expertise that complement Igris's existing 13 agents.

---

## Agents to Add

### Meta-Orchestration Agents (4)

| Agent | Description | Tools |
|-------|-------------|-------|
| **multi-agent-coordinator** | Workflow orchestration, inter-agent communication, parallel execution | Read, Write, Edit, Glob, Grep |
| **agent-organizer** | Team assembly, agent capability assessment, workflow optimization | Read, Write, Edit, Glob, Grep |
| **context-manager** | Information storage/retrieval, state sync, version control | Read, Write, Edit, Glob, Grep |
| **task-distributor** | Load balancing, queue management, priority scheduling | Read, Write, Edit, Glob, Grep |

### Core Development Agent (1)

| Agent | Description | Tools |
|-------|-------------|-------|
| **ui-designer** | Visual design, design systems, interaction patterns, accessibility | Read, Write, Edit, Bash, Glob, Grep |

---

## Source URLs

1. https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/09-meta-orchestration/multi-agent-coordinator.md
2. https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/09-meta-orchestration/agent-organizer.md
3. https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/09-meta-orchestration/context-manager.md
4. https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/09-meta-orchestration/task-distributor.md
5. https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/categories/01-core-development/ui-designer.md

---

## Integration Considerations

### Tier Assignment
- Meta-orchestration agents → Could be Tier 4 (Innovation) or new Tier 6 (Orchestration)
- ui-designer → Tier 5 (Custom) or Tier 2 (Docs) since it produces design artifacts

### Persona Aliases (Crimson Theme)
Need to define aliases for each new agent:
- multi-agent-coordinator → ?
- agent-organizer → ?
- context-manager → ?
- task-distributor → ?
- ui-designer → ?

### Potential Conflicts
- `context-manager` may overlap with Igris's session management
- `multi-agent-coordinator` may overlap with Igris orchestrator role
- Need to clarify scope boundaries

---

## Tasks

### Pending
- [ ] Create implementation plan with planner agent
- [ ] Create 5 agent .md files in .claude/agents/
- [ ] Update manifest.yaml (agent_count: 18)
- [ ] Define persona aliases for new agents
- [ ] Update persona.json with aliases
- [ ] Update documentation (README, CLAUDE.md, igris_os.md, etc.)
- [ ] Verify install/update scripts handle new agents

### In Progress
_(none)_

### Completed
- [x] Fetch agent definitions from VoltAgent repo
- [x] Create brief

---

## Acceptance Criteria

1. [ ] 5 new agent .md files created
2. [ ] manifest.yaml updated with all agents
3. [ ] Documentation updated (12→18 agents across tiers)
4. [ ] Persona aliases defined and added
5. [ ] Install/update scripts verified
6. [ ] No conflicts with existing Igris functionality

---

**Created:** 2025-12-24
**Brief Owner:** Crimson (Igris AI)
