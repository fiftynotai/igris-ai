---
name: digivolve
description: Agent management - status, add, upgrade, disable, enable, remove, reset
disable-model-invocation: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
triggers:
  - "DIGIVOLVE"
  - "SUMMON"
  - "agent status"
  - "list agents"
  - "show agents"
  - "agent management"
---

# DIGIVOLVE - Agent Management

Manage the Igris AI agent registry (18 native subagents).

## Usage

```
/digivolve              # Show agent status (default)
/digivolve status       # Show agent status
/digivolve add          # Create new custom agent
/digivolve upgrade X    # Upgrade agent capabilities
/digivolve disable X    # Temporarily disable agent
/digivolve enable X     # Re-enable disabled agent
/digivolve remove X     # Remove custom agent (Tier 5 only)
/digivolve reset X      # Reset agent to default
```

## Arguments

`$ARGUMENTS` format: `[subcommand] [agent_name]`

If empty, defaults to `status`.

## Agent Registry

Agents are defined in `.claude/agents/manifest.yaml`:

| Tier | Agent | Alias | Role |
|------|-------|-------|------|
| 1 | planner | ARCHITECT | Strategic planning |
| 1 | coder | FORGER | Code implementation |
| 1 | tester | SENTINEL | Test execution |
| 1 | reviewer | WARDEN | Code review |
| 1 | ui-designer | ARTISAN | Visual design |
| 2 | documenter | CHRONICLER | Documentation |
| 2 | releaser | HERALD | Release prep |
| 2 | standardizer | LAWKEEPER | Standards generation |
| 3 | auditor | INQUISITOR | Code analysis |
| 3 | debugger | MENDER | Error recovery |
| 3 | migrator | PATHFINDER | Migration analysis |
| 4 | ideator | ORACLE | Feature ideation |
| 4 | explorer | SEEKER | Codebase research |
| 5 | (custom) | (custom) | User-defined |
| 6 | multi-agent-coordinator | CONDUCTOR | Workflow orchestration |
| 6 | agent-organizer | TACTICIAN | Team assembly |
| 6 | context-manager | ARCHIVIST | State management |
| 6 | task-distributor | DISPATCHER | Queue management |

## Subcommands

### status (default)

Display all agents with their status and usage metrics.

1. Read `.claude/agents/manifest.yaml` for agent definitions
2. Read `ai/session/metrics/agent-metrics.json` for usage stats
3. Format as roster display (see agent-roster.md template)

Output format:
```
## Agent Roster (18 Agents)

### Tier 1: Core Workflow
| Agent | Alias | Status | Invocations | Last Used |
|-------|-------|--------|-------------|-----------|
| planner | ARCHITECT | Active | 42 | 2026-02-06 |
| coder | FORGER | Active | 38 | 2026-02-06 |
| tester | SENTINEL | Active | 35 | 2026-02-06 |
| reviewer | WARDEN | Active | 30 | 2026-02-06 |
| ui-designer | ARTISAN | Active | 5 | 2026-02-05 |

### Tier 2: Documentation
[...]

### Tier 6: Meta (Orchestration)
[...]

### Custom Agents (Tier 5)
[List any custom agents or "None defined"]

Total invocations this session: X
```

### add

Interactive agent creation for Tier 5 (Custom) agents.

1. Ask for agent name
2. Ask for agent role/purpose
3. Ask for allowed tools
4. Create `.claude/agents/{name}.md` from template
5. Update manifest.yaml

Output:
```
Agent created: {name}

File: .claude/agents/{name}.md
Tier: 5 (Custom)
Role: {role}

To use: Delegate tasks via Task tool with subagent_type="{name}"
```

### upgrade {agent_name}

Enhance agent capabilities.

1. Find agent in manifest
2. Read current agent definition
3. Suggest enhancements (more tools, better prompts)
4. Update agent file

### disable {agent_name}

Temporarily disable an agent.

1. Find agent in manifest
2. Set status: disabled
3. Agent won't be invoked until re-enabled

Output: "Agent {name} disabled. Use '/digivolve enable {name}' to re-enable."

### enable {agent_name}

Re-enable a disabled agent.

1. Find agent in manifest
2. Set status: active
3. Agent available for invocation

Output: "Agent {name} enabled."

### remove {agent_name}

Delete a custom agent (Tier 5 only).

1. Verify agent is Tier 5 (Custom)
2. If built-in (Tier 1-4, 6): Refuse with error
3. Confirm with user
4. Delete `.claude/agents/{name}.md`
5. Remove from manifest

Output: "Agent {name} removed from registry."

### reset {agent_name}

Reset agent to default state.

1. Find agent in manifest
2. Restore default configuration
3. Clear any customizations

Output: "Agent {name} reset to defaults."

## Error Handling

- Unknown subcommand: "Unknown command. Available: status, add, upgrade, disable, enable, remove, reset"
- Agent not found: "Agent '{name}' not found. Run '/digivolve status' to see all agents."
- Cannot remove built-in: "Cannot remove {name} - built-in agents can only be disabled."
