# Igris AI v6 - Context Routing Architecture

**Version:** 6.0.0
**Last Updated:** 2026-03-17

---

## Overview

Igris AI v6 replaced the monolithic context injection model (v5) with a
tree-routed, tiered architecture. Every actor -- orchestrator or subagent --
reads a single routing file to determine exactly which context to load. Nothing
more, nothing less.

**Result:** Context per agent dropped from ~93KB (v5) to ~5-9KB (v6), a 90%+
reduction.

---

## Context Routing Flow

```
+------------------------------------------------------+
|                    CLAUDE.md (3KB)                    |
|  Points every actor to the context tree.             |
|  Contains NO @imports -- just a routing pointer.     |
+---------------------------+--------------------------+
                            |
                            v
+------------------------------------------------------+
|           ~/.igris/core/igris_tree.json               |
|  The single source of truth for context routing.     |
|  Declares: context_files, tasks, agents.             |
+-------------+-------------------+--------------------+
              |                   |
     +--------+--------+  +------+--------+
     |  ORCHESTRATOR    |  |   SUBAGENT    |
     |  (no agent def)  |  |  (agent def)  |
     +--------+---------+  +------+--------+
              |                    |
              v                    v
+---------------------------+  +----------------------------+
| 1. Find task in           |  | 1. Find role in            |
|    tree.tasks              |  |    tree.agents              |
| 2. Load listed sections   |  | 2. Load listed context     |
|    of igris_os.md          |  |    files from ~/.igris/     |
| 3. Load listed context    |  | 3. Do NOT load igris_os.md |
|    files                   |  +----------------------------+
+---------------------------+
```

### Orchestrator Path

The orchestrator has no agent definition loaded. It reads `tree.tasks` to find
the current task (e.g. `/hunt`, `/register`, `/awaken`) and loads:

- **Selective sections** of `igris_os.md` (only what the task needs)
- **Project context files** listed under that task (e.g. `coding_guidelines`)

### Subagent Path

Each subagent has an agent definition loaded (from `.claude/agents/`). It reads
`tree.agents` to find its role and loads:

- **Only the context files listed** for that agent
- **Never** `igris_os.md` -- that is orchestrator-only
- **Conditional files** when applicable (e.g. `design_system` for UI tasks)

---

## The 4-Tier Context Model

All context files are classified into one of four tiers, controlling when and
how they are loaded.

```
+================================================================+
|                                                                |
|  TIER 1: BOOT (~5KB)                                          |
|  Always loaded. Identity + operating rules.                    |
|  Loaded by: Every actor on every invocation.                   |
|                                                                |
|    - SOUL.md (persona identity)                                |
|    - igris_os.md "identity" section (1.2KB)                    |
|    - igris_os.md "operating_rules" section (1.2KB)             |
|    - CLAUDE.md (3KB routing pointer)                           |
|                                                                |
+================================================================+
|                                                                |
|  TIER 2: TASK (5-28KB per task)                                |
|  Loaded per-task by the orchestrator.                          |
|  Selected sections of igris_os.md + project context.           |
|                                                                |
|    - igris_os.md sections: agent_delegation (18KB),            |
|      session_management (7KB), quality_standards (1.6KB),      |
|      brief_protocol (13KB)                                     |
|    - coding_guidelines.md (project)                            |
|    - architecture_map.md (project, optional)                   |
|    - api_pattern.md (project, optional)                        |
|    - design_system.md (project, optional)                      |
|    - test_standards.md (project, optional)                     |
|                                                                |
+================================================================+
|                                                                |
|  TIER 3: AGENT (0-19KB per agent)                              |
|  Loaded per-agent by subagents.                                |
|  Only the context files the agent needs.                       |
|                                                                |
|    - Subset of project context files                           |
|    - Conditional files (e.g. design_system for UI tasks)       |
|    - Agent definition (.claude/agents/*.md)                    |
|                                                                |
+================================================================+
|                                                                |
|  TIER 4: REFERENCE (on-demand)                                 |
|  Never auto-loaded. Available when explicitly needed.          |
|                                                                |
|    - igris_os.md "examples_walkthroughs" section (6KB)         |
|    - Any other large reference material                        |
|                                                                |
+================================================================+
```

### Tier Descriptions

| Tier | Name | Size | Loaded By | Purpose |
|------|------|------|-----------|---------|
| 1 | **Boot** | ~5KB | All actors, always | Core identity and rules. The minimum context every actor needs to behave as Igris AI. |
| 2 | **Task** | 5-28KB | Orchestrator, per-task | Task-specific operating instructions. The orchestrator loads only the sections of `igris_os.md` relevant to the current skill/task, plus project context files. |
| 3 | **Agent** | 0-19KB | Subagents, per-role | Agent-specific project context. Each subagent loads only the files it needs for its role -- no orchestrator prompts, no other agents' context. |
| 4 | **Reference** | On-demand | Any actor, when needed | Large reference material that would waste context if auto-loaded. Only pulled in when explicitly required. |

---

## Agent Context Matrix

What each agent loads from `igris_tree.json`:

| Agent | coding_guidelines | architecture_map | api_pattern | design_system | test_standards | Notes |
|-------|:-:|:-:|:-:|:-:|:-:|-------|
| **architect** | Y | Y | - | - | - | Brief content passed via orchestrator prompt |
| **forger** | Y | Y | Y | conditional | - | `design_system` loaded only for UI tasks |
| **sentinel** | Y | - | - | - | Y | Focused on test execution |
| **warden** | Y | Y | - | - | - | Code review and audit |
| **mender** | - | - | - | - | - | Investigates on demand |
| **seeker** | - | - | - | - | - | Investigates on demand |
| **sage** | Y | - | - | - | - | Flutter MVVM specialist |

**Legend:** Y = always loaded, conditional = loaded when `load_if` condition met, - = not loaded

---

## Orchestrator Task Matrix

What the orchestrator loads per task:

| Task | igris_os sections | Context files |
|------|-------------------|---------------|
| `/awaken` | ALL sections | coding_guidelines, soul |
| `/hunt` | identity, brief_protocol, agent_delegation, quality_standards | coding_guidelines |
| `/register` | identity, brief_protocol | (none) |
| `/scan` | identity, session_management | (none) |
| `commit` | identity, quality_standards | (none) |
| `research` | identity | (none) |

---

## v5 vs v6 Comparison

```
v5 (monolithic)                     v6 (tree-routed)
+----------------------------+      +----------------------------+
|                            |      |                            |
|  Every agent receives:     |      |  Each agent receives:      |
|                            |      |                            |
|  - Full igris_os.md (45KB) |      |  - CLAUDE.md (3KB)         |
|  - All 5 rules (25.7KB)   |      |  - 1 universal rule (1.8KB)|
|  - All context files       |      |  - Only its listed files   |
|  - Full CLAUDE.md          |      |  - NO igris_os.md          |
|                            |      |                            |
|  Total: ~93KB per agent    |      |  Total: ~5-9KB per agent   |
|                            |      |                            |
+----------------------------+      +----------------------------+

                  Context reduction: ~90%+
```

---

## File Locations

| Component | Path |
|-----------|------|
| CLAUDE.md | `{project_root}/CLAUDE.md` |
| Context tree | `~/.igris/core/igris_tree.json` |
| igris_os.md | `~/.igris/core/prompts/igris_os.md` |
| SOUL.md | `~/.igris/core/SOUL.md` |
| Universal rule | `~/.igris/core/rules/00-igris-universal.md` |
| Agent definitions | `~/.igris/core/agents/*.md` (symlinked to `.claude/agents/`) |
| Project context | `~/.igris/projects/{project}/context/` |

---

**Architecture designed for minimal context, maximum capability.**
