# Igris AI

**An operating system for AI-assisted engineering.**

**Version 4.0.0** | [MIT License](LICENSE)

Igris AI transforms Claude Code from a single general-purpose assistant into a disciplined multi-agent engineering team -- with persistent memory that survives context resets, syncs across machines, and learns across projects.

It is not a wrapper, a prompt library, or a set of templates. Igris is a complete operating system: agents with defined roles, a brief-first protocol that tracks every change, a centralized brain that remembers across projects, and quality gates that enforce standards before code is committed.

**7 Agents** | **21 Skills** | **27 Brain Tools** | **9 Brief Types** | **13 Scripts**

Plan. Build. Test. Review. Document. Ship. Maintain.

---

## The Problem

AI made coding faster -- but not better. Speed without structure created:

- Massive PRs with no context or traceability
- Code without tests, features without docs
- Architecture violations accumulating silently
- Context lost on every conversation reset
- Technical debt compounding with every prompt

The result was not engineering. It was chaos with better autocomplete.

---

## What is Igris v4.0

Igris is a multi-agent AI engineering system built on top of Claude Code. It provides the workflow, agents, memory, and quality gates that turn AI-assisted coding into AI-assisted engineering.

### Three-Layer Architecture

```
Layer 1: Igris OS
  CLAUDE.md + rules + prompts + session tracking + brief-first protocol
  Always active. Zero setup beyond install.

Layer 2: 7 Subagents
  architect, forger, sentinel, warden, mender, seeker, sage
  Delegated via Task tool. Each agent has one job.

Layer 3: Agent Teams (experimental)
  Parallel execution across multiple Claude Code instances.
  Multiple briefs implemented simultaneously.
```

### The Centralized Brain

Every Igris installation connects to a centralized brain at `~/.igris/`. The brain stores persistent memory in SQLite (WAL + FTS5), serves 27 MCP tools, and keeps core files in sync across all projects through symlinks.

Update the brain once -- every project gets the update instantly.

### Five Things That Change

| Capability | Without Igris | With Igris |
|------------|---------------|------------|
| Workflow | Ad-hoc prompts | Brief-first protocol with 9 types |
| Quality | Varies by prompt | Enforced via agents, tests, review |
| Memory | Lost on context reset | Persistent across sessions and projects |
| Agents | Single Claude instance | 7 specialized agents with defined roles |
| Accountability | No audit trail | Full tracking: briefs, decisions, metrics |

---

## How It Works

### Brief-First Protocol

Every file modification requires a brief. Briefs define what to build, why, and how to verify it. Read-only operations (questions, research, listing) do not require briefs.

**9 Brief Types:**

| Type | Prefix | Purpose |
|------|--------|---------|
| Bug/Feature | BR-XXX | General bugs and features |
| Feature Request | FR-XXX | New feature ideas |
| Technical Debt | TD-XXX | Code quality improvements |
| Migration | MG-XXX | System migrations |
| Testing | TS-XXX | Test additions and improvements |
| Process Improvement | PI-XXX | Workflow improvements |
| Dependency Update | DU-XXX | Dependency updates |
| Performance | PF-XXX | Performance improvements |
| Architecture Cleanup | AC-XXX | Architecture refactoring |

### The HUNT Workflow

`HUNT BR-005` triggers autonomous end-to-end implementation:

```
INIT (Main Agent)
  Read brief, assess complexity, update status
      |
PLANNING (architect)
  Analyze requirements, create implementation plan
      |
APPROVAL GATE
  S/M complexity: auto-approve
  L/XL complexity: user approval required
      |
BUILDING (forger)
  Implement code following the plan and architecture standards
      |
TESTING (sentinel) -- max 3 retries
  Run linter, tests, build validation
  On FAIL: mender diagnoses, forger fixes, sentinel re-tests
      |
REVIEWING (warden) -- max 2 rejects
  Code quality, security, architecture compliance
  On REJECT: forger fixes, warden re-reviews
      |
DOCUMENTING (conditional)
  Runs for new APIs, component changes, README-worthy features
  Skipped for internal refactors, bug fixes, test-only changes
      |
COMMITTING (Main Agent)
  Conventional commit, update brief to Done, save metrics
```

**Self-Healing:** Test failures loop back through mender and forger automatically (max 3 attempts). Review rejections trigger targeted fixes (max 2 rejects). If retries are exhausted, the brief enters BLOCKED state for human intervention.

---

## The 7 Agents

Agents are defined as native Claude Code agent files in `.claude/agents/`. Each agent has restricted tools, persistent memory, and a single focused role.

| Agent | Tier | Role | Tools | Model |
|-------|------|------|-------|-------|
| **architect** | 1 - Core | Strategic planning, brief analysis | Read, Grep, Glob | inherit |
| **forger** | 1 - Core | Code implementation | Read, Write, Edit, Bash, Grep, Glob | inherit |
| **sentinel** | 1 - Core | Test execution, validation | Read, Bash, Grep | inherit |
| **warden** | 1 - Core | Code review, security, auditing | Read, Grep, Glob | inherit |
| **mender** | 3 - Maintenance | Error diagnosis, self-healing | Read, Grep, Glob, Bash | inherit |
| **seeker** | 4 - Research | Codebase investigation | Read, Grep, Glob, Bash | haiku |
| **sage** | 5 - Custom | Flutter MVVM + Actions patterns | Read, Write, Edit, Bash, Glob, Grep | inherit |

**Key design decisions:**
- Read-only agents (architect, warden, seeker) cannot write files -- separation of concerns is enforced at the tool level.
- The seeker agent uses `model: haiku` for fast, low-cost codebase exploration.
- All agents have `memory: project`, storing learned context in `.claude/agent-memory/<name>/` across sessions.

---

## 21 Skills

Skills are slash commands defined in `.claude/skills/*/SKILL.md`. They replaced 11 retired agents in v3.4, reducing complexity while preserving all capabilities.

| Skill | Purpose |
|-------|---------|
| `/scan` | System status report |
| `/rest` | Pause or end session |
| `/awaken` | Start or resume session |
| `/register` | Create new brief |
| `/archive` | Archive completed brief |
| `/hunt` | Implement brief (full autonomous workflow) |
| `/digivolve` | Agent management and status |
| `/document` | Documentation generation |
| `/release` | Release preparation, changelog, versioning |
| `/standardize` | Generate coding guidelines (4 modes) |
| `/ideate` | Feature brainstorming, generates FR-XXX briefs |
| `/migrate-analyze` | Migration analysis and roadmap generation |
| `/audit` | Codebase audit (7 types), generates briefs |
| `/ui-design` | UI specs, design systems, accessibility review |
| `/higgsfield` | Higgsfield media generation |
| `/team` | Parallel execution with Agent Teams |
| `/projects` | List all brain-registered projects |
| `/portfolio` | Cross-project dashboard and insights |
| `/dashboard` | Cross-project brief and session tracker |
| `/sync` | VPS brain deployment and synchronization |
| `/fifty-kit` | Fifty Flutter Kit expert for FDL design system |

---

## The Brain

The brain lives at `~/.igris/` and provides persistent memory, cross-project intelligence, and zero-drift core files.

### Architecture

```
+-----------+  +-----------+  +-----------+
| Project A |  | Project B |  | Project C |
|  (Claude) |  |  (Claude) |  |  (Claude) |
+-----+-----+  +-----+-----+  +-----+-----+
      |               |               |
      |  symlinks +   |  symlinks +   |  symlinks +
      |  MCP calls    |  MCP calls    |  MCP calls
      +---------------+---------------+
                      |
           +----------v----------+
           |  ~/.igris/ (BRAIN)  |
           |                     |
           |  core/ (symlinked)  |
           |  knowledge.db (WAL) |
           |  staging/ (hooks)   |
           |  mcp-server/        |
           +---------------------+
```

### 27 MCP Tools

Tools are available globally via the `igris-brain` MCP server.

**Memory (4 tools)**

| Tool | Purpose |
|------|---------|
| `igris_memory_store` | Store a learning |
| `igris_memory_search` | Full-text search learnings |
| `igris_memory_recall` | Contextual retrieval |
| `igris_error_lookup` | Error solution catalog |

**Projects (4 tools)**

| Tool | Purpose |
|------|---------|
| `igris_project_register` | Register a project |
| `igris_project_list` | List all projects |
| `igris_project_status` | Project dashboard |
| `igris_pattern_suggest` | Pattern recommendations |

**Metrics (3 tools)**

| Tool | Purpose |
|------|---------|
| `igris_metrics_record` | Record agent metric |
| `igris_metrics_query` | Query metrics |
| `igris_metrics_velocity` | Velocity dashboard |

**Sessions (3 tools)**

| Tool | Purpose |
|------|---------|
| `igris_session_sync` | Sync session snapshot |
| `igris_session_recall` | Recall recent sessions |
| `igris_session_file_sync` | Push session file to brain |

**Briefs (3 tools)**

| Tool | Purpose |
|------|---------|
| `igris_brief_sync` | Sync brief status |
| `igris_brief_dashboard` | Cross-project brief dashboard |
| `igris_brief_file_sync` | Push brief file to brain |

**Instances (3 tools)**

| Tool | Purpose |
|------|---------|
| `igris_instance_heartbeat` | Register or refresh instance |
| `igris_instance_list` | List active instances |
| `igris_instance_remove` | Remove an instance |

**Sync (4 tools)**

| Tool | Purpose |
|------|---------|
| `igris_brain_push` | Push data to remote brain |
| `igris_brain_pull` | Pull data from remote brain |
| `igris_sync_queue_status` | Check sync queue |
| `igris_sync_queue_drain` | Drain pending sync operations |

**Definitions (3 tools)**

| Tool | Purpose |
|------|---------|
| `igris_definition_sync` | Push agent/skill definitions to brain |
| `igris_definition_pull` | Pull definitions from brain |
| `igris_session_file_pull` | Pull session file from brain |

### Concurrency

Multiple Claude sessions safely share the brain:
- SQLite WAL mode for concurrent reads and serialized writes (~3ms each)
- `busy_timeout=5000ms` for automatic retry on contention
- Staging pattern: hooks write unique files, processed on next startup

### Brain Modes

| Mode | MCP Entry | Use Case |
|------|-----------|----------|
| `local` | `igris-brain` (stdio) | Single machine, default |
| `remote` | `igris-brain` (HTTP) | VPS brain, no local DB |
| `dual` | `igris-brain` (stdio) + `igris-brain-remote` (HTTP) | Full redundancy |

Switch modes anytime:

```bash
./scripts/igris_brain_switch.sh status   # Show current mode
./scripts/igris_brain_switch.sh local    # Local only
./scripts/igris_brain_switch.sh remote   # Remote only
./scripts/igris_brain_switch.sh dual     # Both active
```

For VPS deployment instructions, see [docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md).

---

## Quick Start

### Prerequisites

**Required:**
- Git
- Claude Code CLI
- Bash (macOS, Linux, or WSL)
- Python 3 (JSON parsing, brain operations)
- Node.js 20+ (brain MCP server)
- SQLite 3 with FTS5 support (brain database)
- Perl (CLAUDE.md template generation)

**Optional:**
- jq (faster JSON parsing in hooks — python3 fallback available)

### Install

```bash
# Clone Igris
git clone https://github.com/fiftynotai/igris-ai

# 1. Bootstrap the centralized brain (one-time)
./igris-ai/scripts/igris_brain_init.sh

# 2. Install in your project (symlink mode)
cd your-project
path/to/igris-ai/scripts/igris_install.sh
```

This creates:
- `ai/` directory with templates, prompts, and session tracking (symlinked from brain)
- `.claude/agents/` with 7 native subagents (symlinked from brain)
- `.claude/skills/` with 21 skills (symlinked from brain)
- `.claude/hooks/` with startup hook for auto-initialization
- `CLAUDE.md` context file for Claude Code
- Brain MCP server registered globally in `~/.claude.json`

### First 5 Minutes

```bash
# 1. Launch Claude Code
claude

# 2. Generate coding guidelines (foundation first)
/standardize analyze

# 3. Register a task
"Register a bug: Login fails with special characters in password"

# 4. Autonomous implementation
/hunt BR-001
```

Igris autonomously plans (architect), implements (forger), tests (sentinel), reviews (warden), documents if needed, and commits with conventional format.

### Commands Reference

| Command | Description |
|---------|-------------|
| `/hunt BR-XXX` | Autonomous implementation (full workflow) |
| `/scan` | System status report |
| `/register` | Create new brief |
| `/archive BR-XXX` | Archive completed brief |
| `/standardize analyze` | Generate coding guidelines |
| `/audit code_quality` | Run codebase audit |
| `/migrate-analyze` | Migration analysis |
| `/document` | Generate documentation |
| `/team hunt FR-001 FR-002` | Parallel implementation |
| `/projects` | List all brain-registered projects |
| `/portfolio` | Cross-project dashboard |
| `/dashboard` | Cross-project brief and session tracker |
| `/digivolve status` | List all agents with stats |

### Migrating Existing Projects

```bash
cd existing-project
path/to/igris-ai/scripts/igris_migrate_to_v4.sh
```

The migration script converts copied files to symlinks, migrates learnings and decisions to `knowledge.db`, and registers the project in the brain.

---

## Core Capabilities

### Brief Management

**Brief Lifecycle:**
```
Draft -> Ready -> In Progress -> In Review -> Done -> Archived
```

```bash
# Register (don't implement yet)
"Register a bug: Login fails with @ symbol in password"

# List and filter
"List all P0 bugs"
"Show features in Ready status"

# Autonomous implementation
/hunt BR-001

# After completion
/archive BR-001

# Priority recommendation
"What should I work on next?"
```

### Codebase Auditing

The `/audit` skill runs 7 audit types, each generating actionable briefs:

| Audit Type | Creates | Command |
|------------|---------|---------|
| Code quality | TD-XXX | `/audit code_quality` |
| Bug detection | BR-XXX | `/audit bugs` |
| Standards compliance | TD-XXX | `/audit standards` |
| Process compliance | PI-XXX | `/audit process` |
| Dependencies | DU-XXX | `/audit dependencies` |
| Performance | PF-XXX | `/audit performance` |
| Architecture | AC-XXX | `/audit architecture` |

### Architecture Standards

Generate project-specific coding guidelines with `/standardize`:

| Mode | Purpose |
|------|---------|
| `analyze` | Infer standards from current codebase |
| `from-base` | Extract from a base architecture repo |
| `hybrid` | Combine base + project (base takes precedence) |
| `minimal` | Platform-specific industry standards |

Output: `ai/context/coding_guidelines.md` covering architecture, naming, testing, and patterns.

### Migration Analysis

```bash
/migrate-analyze
```

Scans the entire codebase against `coding_guidelines.md`, identifies architecture violations, and generates categorized briefs (MG-XXX, TD-XXX, BR-XXX, TS-XXX) with a prioritized migration roadmap. Ideal for onboarding existing codebases or enforcing new standards.

### Session Management

Igris tracks work at multiple levels:

```
PROJECT LEVEL (CURRENT_SESSION.md)
  Active briefs, session status, resume point

BRIEF LEVEL (Brief files in ai/briefs/)
  Tasks, workflow state, phase, active agent, retry count, agent log
```

If Claude's context resets mid-workflow, Igris reads `CURRENT_SESSION.md` to find the active brief, checks its workflow state, and resumes from the exact phase (for example, "TESTING phase, retry 2/3").

**Session files:** `CURRENT_SESSION.md`, `BLOCKERS.md`, `DECISIONS.md`, `LEARNINGS.md`, `PROTOCOL_VIOLATIONS.md`

### Common Workflows

**Starting a New Project:**
```bash
path/to/igris-ai/scripts/igris_install.sh   # Install Igris
claude                                        # Launch Claude Code
/standardize analyze                          # Generate coding guidelines
/document                                     # Generate architecture docs
"Register a feature: Add user authentication" # Create brief
/hunt FR-001                                  # Autonomous implementation
```

**Before a Major Release:**
```bash
/audit dependencies     # Security vulnerabilities
/audit bugs             # Find issues before users do
/audit test_coverage    # Quality gate
/audit standards        # Final polish
"List P0 bugs"          # Review critical issues
/hunt BR-008            # Fix them systematically
```

**Monthly Maintenance:**
```bash
/audit dependencies     # Stay current
/audit code_quality     # Detect new tech debt
"List TD briefs by priority"
/hunt TD-015            # Pay down debt
```

---

## Agent Teams

Agent Teams is an experimental parallel execution layer that spawns multiple independent Claude Code instances (teammates) working simultaneously, coordinated by the Igris Lead.

**Requires:** `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: 1` in `~/.claude/settings.json`

**4 Team Modes:**

| Mode | Command | Description |
|------|---------|-------------|
| Parallel HUNT | `/team hunt FR-022 FR-023` | Each brief gets its own teammate |
| Multi-Angle Review | `/team review` | 3 reviewers: security, performance, standards |
| Competitive Investigation | `/team investigate BR-015` | Multiple hypotheses tested in parallel |
| Parallel Refactoring | `/team refactor mod-a mod-b` | Each module refactored independently |

**Management:** `/team status`, `/team message <name> <msg>`, `/team broadcast <msg>`, `/team shutdown`

**When to use:** Single brief -- use `/hunt`. Multiple briefs in parallel -- use `/team hunt`.

---

> **Note:** The Crimson Arena monitoring dashboard has been extracted to a separate repository for independent development and release.

---

## Identity System

Igris uses two simple markdown files for identity configuration -- no plugin system required.

- **`SOUL.md`** (project root) -- Defines the AI persona: name, personality, mask level, greeting style. Edit this file to change how Igris presents itself.
- **`~/.igris/USER.md`** (global) -- Defines the developer: name, preferred addressing mode, preferences. Shared across all projects.

**4 Mask Levels:**

| Level | Behavior |
|-------|----------|
| none | Standard professional tone, minimal personality |
| light | Subtle personality, professional but warmer |
| half | Moderate personality, themed language active |
| full | Full personality expression, all themed commands active |

---

## Project Structure

**In your project (symlinked from brain):**

```
your-project/
├── .claude/
│   ├── agents/              # 7 native subagents
│   ├── skills/              # 21 skills (slash commands)
│   ├── rules/               # 5 modular rules
│   │   ├── 01-igris-init.md       # Boot sequence, context reset detection
│   │   ├── 02-igris-briefs.md     # Brief-first protocol gate
│   │   ├── 03-igris-commits.md    # Commit standards, quality checklist
│   │   ├── 04-igris-agents.md     # Agent delegation, workflow state
│   │   └── 05-igris-persona.md    # Persona config, mask behavior
│   ├── agent-memory/        # Persistent per-agent memory
│   └── hooks/               # Claude Code event hooks
├── CLAUDE.md                # Context loaded on first message
├── ai/
│   ├── briefs/              # Work items (9 types)
│   ├── context/             # coding_guidelines.md, architecture docs
│   ├── prompts/             # igris_os.md, session_protocol.md
│   ├── session/             # CURRENT_SESSION.md, BLOCKERS.md, metrics/
│   ├── plans/               # Implementation plans from architect
│   └── templates/           # Brief templates
└── scripts/                 # 13 utility scripts
    ├── igris_brain_init.sh
    ├── igris_install.sh
    ├── igris_init.sh
    ├── igris_update.sh
    ├── igris_migrate_to_v4.sh
    ├── igris_brain_switch.sh
    ├── igris_brain_backup.sh
    ├── igris_brain_restore.sh
    ├── igris_brain_deploy.sh
    ├── igris_vps_update.sh
    ├── igris-sync.sh
    ├── igris_brain_schema.sql
    ├── install_shell_integration.sh
    └── emit_skill_event.sh
```

**Centralized brain:**

```
~/.igris/
├── config.json              # Brain configuration
├── user_profile.json        # Developer identity
├── core/                    # Symlink source for all projects
│   ├── agents/
│   ├── skills/
│   ├── rules/
│   ├── prompts/
│   └── templates/
├── memory/
│   ├── knowledge.db         # SQLite WAL + FTS5
│   └── patterns/
├── staging/                 # Hook pipeline (per-project)
└── mcp-server/              # Brain MCP server (TypeScript)
    ├── dist/
    └── src/
```

---

## FAQ

**Q: What is the relationship between Igris and Claude?**
Claude provides the intelligence. Igris provides the engineering discipline -- agents, memory, workflow, and quality gates that turn raw AI capability into structured engineering output.

**Q: Does Igris work with Claude.ai (web)?**
Partially. Startup hooks will not auto-run, and the Task tool (subagents) may not be available. Claude Code CLI is recommended for the full experience.

**Q: How do agents communicate?**
The main agent (orchestrator) delegates work to subagents via the Task tool. Subagents are stateless -- they receive instructions, do work, and return results. The main agent tracks workflow state across the full pipeline.

**Q: What are Agent Teams?**
An experimental parallel execution layer. While subagents run sequentially within one session, Agent Teams spawns multiple independent Claude Code instances that work in parallel. Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: 1`.

**Q: Can I disable specific agents?**
Yes. Remove or rename the agent's `.md` file in `.claude/agents/`, or use `/digivolve disable {agent}`.

**Q: Why are some agents read-only?**
Tool restrictions enforce separation of concerns. The architect (planning) and warden (review) should never write code -- they only analyze and advise. The forger has full write access because its job is to produce code.

**Q: Why does seeker use haiku?**
The seeker agent handles research and investigation, not code generation. A lighter model provides faster responses without sacrificing quality for that role.

**Q: Do I need to create briefs for everything?**
Only for file modifications. Read-only operations (questions, analysis, listing, research) do not require briefs.

**Q: What if my conversation resets mid-task?**
Igris automatically resumes from where you left off. Session state is saved in `CURRENT_SESSION.md` and brief files. Start a new conversation and Igris picks up the thread.

**Q: Can I use Igris with other AI models?**
Currently optimized for Claude Code CLI. The system is model-agnostic in theory, but workflows assume the Task tool for subagent delegation.

**Q: What is the DOCUMENTING phase in HUNT?**
A conditional step between REVIEWING and COMMITTING. After the warden approves code, the orchestrator evaluates whether documentation needs updating. If changes introduce new public APIs, modify component libraries, or add README-worthy features, the `/document` skill is invoked. For internal refactors, bug fixes, or test-only changes, the phase is skipped entirely.

**Q: What is agent memory?**
All 7 agents have `memory: project` enabled, which stores persistent knowledge in `.claude/agent-memory/<name>/`. This allows agents to remember project-specific context across sessions -- the architect remembers past plans, the warden remembers past review patterns, and so on.

**Q: How does Igris enforce commit quality?**
Conventional Commits format is required. Before committing, the workflow verifies that the linter passes, tests are green, code review is approved, documentation is current, and session state is updated. No AI attribution is added to commits.

**Q: What happens when I run `/standardize`?**
Igris analyzes your codebase (or a base architecture repo, or both) and generates a comprehensive `ai/context/coding_guidelines.md` file. This file becomes the single source of truth for architecture, naming conventions, testing standards, and patterns. All agents reference it during their work.

---

## Documentation

| Resource | Location |
|----------|----------|
| Operating System | `ai/prompts/igris_os.md` |
| Setup Guide | `docs/SETUP_GUIDE.md` |
| Update Guide | `docs/UPDATE_GUIDE.md` |
| Migration Guide | `docs/MIGRATION_GUIDE.md` |
| Brand Book | `docs/IGRIS_BRAND_BOOK.md` |
| Desktop Quickstart | `docs/IGRIS_DESKTOP_QUICKSTART.md` |
| UI Architecture | `docs/IGRIS_UI_ARCHITECTURE.md` |
| Contributing | `CONTRIBUTING.md` |

---

## Community and Contributing

- **Repository:** [github.com/fiftynotai/igris-ai](https://github.com/fiftynotai/igris-ai)
- **Issues:** [Report bugs, request features](https://github.com/fiftynotai/igris-ai/issues)
- **Discussions:** [Share ideas, get help](https://github.com/fiftynotai/igris-ai/discussions)
- **Example Project:** [igris-ai-flutter-example](https://github.com/fiftynotai/igris_ai_flutter_example)
- **Contributing:** See [CONTRIBUTING.md](CONTRIBUTING.md)

**License:** [MIT](LICENSE)

Built for developers and teams using Claude Code to engineer production software with autonomous multi-agent workflows.

---

## Legacy Migration

For migrating from v3.x to v4.0, see [docs/MIGRATION_GUIDE.md](docs/MIGRATION_GUIDE.md).
