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

Manage the Igris AI agent registry (7 native subagents).

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

Agents are defined as individual files in `.claude/agents/*.md`:

| Tier | Agent | Alias | Role |
|------|-------|-------|------|
| 1 | architect | ARCHITECT | Strategic planning |
| 1 | forger | FORGER | Code implementation |
| 1 | sentinel | SENTINEL | Test execution |
| 1 | warden | WARDEN | Code review + auditing |
| 3 | mender | MENDER | Error recovery |
| 4 | seeker | SEEKER | Codebase research |
| 5 | sage | SAGE | Flutter MVVM + Actions |

## Subcommands

### status (default)

Display all agents with their status and usage metrics.

1. Read `.claude/agents/manifest.yaml` for agent definitions
2. Read `ai/session/metrics/agent-metrics.json` for usage stats
3. Format as roster display (see agent-roster.md template)

Output format:
```
## Agent Roster (7 Agents)

### Tier 1: Core Workflow
| Agent | Alias | Status | Invocations | Last Used |
|-------|-------|--------|-------------|-----------|
| architect | ARCHITECT | Active | 42 | 2026-02-06 |
| forger | FORGER | Active | 38 | 2026-02-06 |
| sentinel | SENTINEL | Active | 35 | 2026-02-06 |
| warden | WARDEN | Active | 30 | 2026-02-06 |

### Tier 3: Maintenance
| Agent | Alias | Status | Invocations | Last Used |
|-------|-------|--------|-------------|-----------|
| mender | MENDER | Active | 12 | 2026-02-05 |

### Tier 4: Research
| Agent | Alias | Status | Invocations | Last Used |
|-------|-------|--------|-------------|-----------|
| seeker | SEEKER | Active | 8 | 2026-02-04 |

### Tier 5: Custom
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
2. If Tier 1 (Core): Refuse with error - built-in core agents cannot be removed
3. Tier 3/4 agents can be disabled but not removed
4. Confirm with user
5. Delete `.claude/agents/{name}.md`
6. Remove from manifest

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
- Cannot remove Tier 1 agent: "Cannot remove {name} - Tier 1 core agents can only be disabled."
- Cannot remove Tier 3/4 agent: "Cannot remove {name} - built-in agents can only be disabled. Use '/digivolve disable {name}' instead."
