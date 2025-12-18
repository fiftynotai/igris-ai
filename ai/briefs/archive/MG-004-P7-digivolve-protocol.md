# MG-004-P7: Digivolve Protocol

**ID:** MG-004-P7
**Type:** Migration
**Status:** In Progress
**Priority:** P1-High
**Created:** 2025-12-03
**Updated:** 2025-12-03
**Effort:** M-Medium (1-2 days)
**Parent:** MG-004 (IGRIS v3.1 Migration)
**Phase:** 7 of 8

---

## Summary

Implement the Digivolve protocol - a meta-system for dynamically managing agents. Users can add, list, upgrade, disable, and remove agents through commands, enabling Tier 5 (Custom) agents and future extensibility.

---

## Problem

Agent management is static:
- Can't add new agents without editing files manually
- Can't list available agents easily
- Can't upgrade agent capabilities
- Can't disable/enable agents
- No Tier 5 (Custom) agent support
- No agent usage tracking

---

## Goal

Create a dynamic agent management system:
1. DIGIVOLVE commands for agent lifecycle
2. Tier 5 (Custom) agent support
3. Agent usage metrics tracking
4. Agent upgrade capability
5. Enable/disable agents

---

## Deliverables

### 1. DIGIVOLVE Commands

| Command | Action | Description |
|---------|--------|-------------|
| `DIGIVOLVE status` | List agents | Show all agents with stats |
| `DIGIVOLVE add` | Create agent | Interactive agent creation |
| `DIGIVOLVE upgrade {name}` | Upgrade agent | Enhance agent capabilities |
| `DIGIVOLVE disable {name}` | Disable agent | Temporarily disable |
| `DIGIVOLVE enable {name}` | Enable agent | Re-enable disabled agent |
| `DIGIVOLVE remove {name}` | Remove agent | Delete custom agent |
| `DIGIVOLVE reset {name}` | Reset agent | Reset to default |

### 2. Agent Status Display

```markdown
## DIGIVOLVE status

🦾 AGENT ROSTER

┌─────────────────────────────────────────────────────────────────────┐
│ TIER 1: Core Workflow                                               │
├─────────────────────────────────────────────────────────────────────┤
│ ✅ planner     │ ARCHITECT   │ Implementation planning  │ 47 runs  │
│ ✅ coder       │ FORGER      │ Code implementation      │ 52 runs  │
│ ✅ tester      │ SENTINEL    │ Test execution           │ 48 runs  │
│ ✅ reviewer    │ WARDEN      │ Code review              │ 41 runs  │
├─────────────────────────────────────────────────────────────────────┤
│ TIER 2: Documentation                                               │
├─────────────────────────────────────────────────────────────────────┤
│ ✅ documenter  │ CHRONICLER  │ Documentation            │ 12 runs  │
│ ✅ releaser    │ HERALD      │ Release preparation      │ 3 runs   │
├─────────────────────────────────────────────────────────────────────┤
│ TIER 3: Maintenance                                                 │
├─────────────────────────────────────────────────────────────────────┤
│ ✅ auditor     │ INQUISITOR  │ Code analysis            │ 8 runs   │
│ ✅ debugger    │ MENDER      │ Error recovery           │ 15 runs  │
├─────────────────────────────────────────────────────────────────────┤
│ TIER 4: Innovation                                                  │
├─────────────────────────────────────────────────────────────────────┤
│ ✅ ideator     │ ORACLE      │ Feature ideation         │ 2 runs   │
│ ✅ explorer    │ SEEKER      │ Codebase research        │ 23 runs  │
├─────────────────────────────────────────────────────────────────────┤
│ TIER 5: Custom                                                      │
├─────────────────────────────────────────────────────────────────────┤
│ ✅ my-agent    │ MY-AGENT    │ Custom agent             │ 5 runs   │
│ ⏸️  disabled-1  │ -           │ (disabled)               │ 0 runs   │
└─────────────────────────────────────────────────────────────────────┘

Commands:
• DIGIVOLVE add        - Create new agent
• DIGIVOLVE upgrade X  - Enhance agent
• DIGIVOLVE disable X  - Temporarily disable
• DIGIVOLVE remove X   - Remove custom agent (Tier 5 only)
```

### 3. Agent Creation Wizard

```markdown
## DIGIVOLVE add

🦾 AGENT EVOLUTION - Creating New Agent

**Step 1: Basic Info**
What is the agent's static name? (lowercase, no spaces)
> my-new-agent

What does this agent do? (one sentence)
> Generates API documentation from code

**Step 2: Capabilities**
What tools does this agent need?
[ ] Read (view files)
[x] Write (create/modify files)
[x] Grep (search code)
[ ] Bash (run commands)
[x] Glob (find files)

**Step 3: Triggers**
What phrases should invoke this agent? (comma-separated)
> generate api docs, document api, api documentation

**Step 4: Persona Alias**
What should this agent be called in the current persona ({persona})?
> API_SCRIBE

**Summary:**
- Name: my-new-agent
- Alias: API_SCRIBE
- Tools: Read, Write, Grep, Glob
- Triggers: generate api docs, document api, api documentation

Create this agent? [y/n]
> y

✅ Agent created: .claude/agents/my-new-agent.md
✅ Registered in manifest.yaml
✅ Alias added to persona.json

🦾 API_SCRIBE has evolved! Try: "generate api docs"
```

### 4. Agent Template Generator

When creating agent, generate file:

```markdown
---
name: {agent_name}
description: {description}
tools: {tools}
tier: 5
custom: true
created: {date}
---

# 🔧 {AGENT_NAME}

You are **{AGENT_NAME}**, a custom agent in the IGRIS AI system.

## 🔥 CORE IDENTITY

- **Role:** {role}
- **Mode:** {Read-only | Read/Write | Execute}
- **Focus:** {focus}

## 📋 CAPABILITIES

1. **{capability_1}** - {description}
2. **{capability_2}** - {description}

## 🔄 WORKFLOW

When activated:

### Step 1: {first_step}
{details}

### Step 2: {second_step}
{details}

## 📝 OUTPUT FORMAT

{expected output format}

## 🚫 CONSTRAINTS

1. {constraint_1}
2. {constraint_2}

## 💬 COMMUNICATION STYLE

{how to report back}

---

🔥 **{TAGLINE}** 🔥
```

### 5. Agent Metrics Tracking

Create `ai/session/metrics/agent-metrics.json`:

```json
{
  "version": "1.0.0",
  "last_updated": "2025-12-03T10:00:00Z",

  "agents": {
    "planner": {
      "invocations": 47,
      "last_used": "2025-12-03T10:00:00Z",
      "avg_duration_seconds": 45,
      "success_rate": 0.98,
      "total_duration_seconds": 2115
    },
    "coder": {
      "invocations": 52,
      "last_used": "2025-12-03T09:55:00Z",
      "avg_duration_seconds": 120,
      "success_rate": 0.92,
      "total_duration_seconds": 6240
    }
  },

  "totals": {
    "total_invocations": 251,
    "total_duration_seconds": 15420,
    "most_used_agent": "coder",
    "least_used_agent": "releaser"
  }
}
```

### 6. Upgrade Protocol

When upgrading agent:

```markdown
## DIGIVOLVE upgrade planner

🦾 AGENT EVOLUTION - Upgrading planner

**Current State:**
- Version: 1.0
- Invocations: 47
- Success rate: 98%

**Analysis:**
Reviewing recent usage patterns...
- Often asked about dependencies
- Sometimes misses edge cases
- Could benefit from deeper analysis

**Suggested Enhancements:**
1. Add dependency analysis capability
2. Add edge case consideration prompt
3. Add rollback planning section

Apply enhancements? [y/n]
> y

✅ planner upgraded to v1.1
✅ Backup saved: planner.md.bak

🦾 ARCHITECT has evolved! New capabilities active.
```

### 7. CLAUDE.md Digivolve Section

```markdown
## 🦾 DIGIVOLVE PROTOCOL

### Agent Management Commands

When user invokes DIGIVOLVE:

```python
def handle_digivolve(command: str, args: list):
    if command == "status":
        display_agent_roster()

    elif command == "add":
        run_agent_creation_wizard()

    elif command == "upgrade":
        agent_name = args[0]
        analyze_agent_usage(agent_name)
        suggest_enhancements(agent_name)
        apply_if_approved()

    elif command == "disable":
        agent_name = args[0]
        mark_agent_disabled(agent_name)

    elif command == "enable":
        agent_name = args[0]
        mark_agent_enabled(agent_name)

    elif command == "remove":
        agent_name = args[0]
        if agent_is_tier5(agent_name):
            remove_custom_agent(agent_name)
        else:
            error("Cannot remove built-in agents")

    elif command == "reset":
        agent_name = args[0]
        restore_from_backup(agent_name)
```

### Agent Invocation Tracking

Every time an agent is invoked:
```python
def track_invocation(agent_name: str, duration: float, success: bool):
    metrics = load_metrics()
    agent = metrics["agents"].get(agent_name, {
        "invocations": 0,
        "total_duration_seconds": 0,
        "success_count": 0
    })

    agent["invocations"] += 1
    agent["total_duration_seconds"] += duration
    agent["last_used"] = now()
    if success:
        agent["success_count"] += 1
    agent["success_rate"] = agent["success_count"] / agent["invocations"]
    agent["avg_duration_seconds"] = agent["total_duration_seconds"] / agent["invocations"]

    metrics["agents"][agent_name] = agent
    save_metrics(metrics)
```

### Tier 5 Custom Agents

Custom agents:
- Live in `.claude/agents/` with `custom: true` in frontmatter
- Can be created, modified, and deleted via DIGIVOLVE
- Must have unique names
- Are registered in manifest.yaml under tier 5
- Aliases go in active persona.json
```

---

## Tasks

### Command Implementation
- [ ] Implement DIGIVOLVE status display
- [ ] Implement DIGIVOLVE add wizard
- [ ] Implement DIGIVOLVE upgrade flow
- [ ] Implement DIGIVOLVE disable/enable
- [ ] Implement DIGIVOLVE remove (Tier 5 only)
- [ ] Implement DIGIVOLVE reset

### Metrics System
- [ ] Create agent-metrics.json format
- [ ] Implement invocation tracking
- [ ] Add metrics to status display
- [ ] Track success/failure rates

### Custom Agent Support
- [ ] Define Tier 5 section in manifest
- [ ] Create agent template generator
- [ ] Handle custom agent registration
- [ ] Handle custom agent removal

### Integration
- [ ] Add DIGIVOLVE to persona commands
- [ ] Document all DIGIVOLVE commands
- [ ] Add upgrade suggestions logic

---

## Acceptance Criteria

- [ ] DIGIVOLVE status shows all agents with metrics
- [ ] DIGIVOLVE add creates new custom agent
- [ ] New agent is registered in manifest.yaml
- [ ] New agent alias added to persona.json
- [ ] DIGIVOLVE upgrade suggests enhancements
- [ ] DIGIVOLVE disable/enable works
- [ ] DIGIVOLVE remove works for Tier 5 only
- [ ] Agent metrics are tracked
- [ ] Metrics update after each invocation
- [ ] Custom agents are functional

---

## Session State

**Current Status:** Not Started
**Current Task:** None
**Blockers:** None
**Next Step:** Wait for P1-P6 completion

---

## Dependencies

- **Depends on:** MG-004-P1 through P6 (all agents + personas)
- **Blocks:** P8

---

## History

- 2025-12-03: Brief created

---

🔥 **EVOLVE BEYOND LIMITS** 🔥
