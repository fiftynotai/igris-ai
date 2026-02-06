# ✦ IGRIS AI — Multi-Agent Engineering System

> *From Vibe Coding → Vibe Engineering*

**Version 3.3.0** | Production Ready

---

> *"AI made coding faster — but not better. IGRIS brings the discipline."*

**IGRIS** is a multi-agent AI engineering system that orchestrates Claude Code through 18 specialized subagents to build high-quality software with structure, testing, and documentation.

Not just code generation. **Autonomous engineering execution.**

**Philosophy:** Plan · Build · Test · Review · Document · Ship · Maintain

---

## ✦ The Problem We Solve

AI made coding faster — but not better. Speed without structure created:
- Massive PRs with no context
- Code without tests
- Features without docs
- Architecture violations everywhere
- Technical debt accumulating
- Unmaintainable codebases

**This was not engineering — it was chaos.**

---

## ✦ What is IGRIS v3.3?

**IGRIS** is a multi-agent AI engineering system powered by Claude Code that transforms how you build software through autonomous workflows.

**Category:** Multi-Agent AI Engineering Platform
**Core Promise:** Autonomous Quality Execution

### The v3.3 Architecture

**18 Native Subagents Across 6 Tiers:**

```
┌─────────────────────────────────────────────────────────────┐
│  YOU (Orchestrator) - Strategic decisions & architecture    │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│  IGRIS MAIN AGENT - Workflow orchestration & validation     │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ├─► TIER 1 (Core): architect → forger → sentinel → warden
                   │                    Plan       Build     Test      Review
                   │
                   ├─► TIER 2 (Docs): chronicler, herald, lawkeeper
                   │                   Write Docs   Releases   Guidelines
                   │
                   ├─► TIER 3 (Maintenance): inquisitor, mender, pathfinder
                   │                          Analyze      Fix     Migrate
                   │
                   ├─► TIER 4 (Innovation): oracle, seeker
                   │                         Imagine  Research
                   │
                   ├─► TIER 5 (Custom): sage (user-defined domain experts)
                   │                     Specialized Knowledge
                   │
                   └─► TIER 6 (Meta): conductor, tactician, archivist, dispatcher
                                       Orchestrate  Assemble   State     Queue
```

### How It Works

**1. Brief-First Protocol**
- All file modifications require a brief (BR, FR, TD, MG, etc.)
- Briefs define goals, acceptance criteria, test plans
- 9 brief types for different work (bugs, features, migrations, performance, etc.)

**2. Autonomous Workflows**
- `HUNT {brief_id}` triggers full autonomous implementation
- Workflow: PLANNING → BUILDING → TESTING → REVIEWING → COMMITTING
- Self-healing: Test failures loop back to forger (max 3 retries)
- Auto-approval for S/M tasks, user approval for L/XL

**3. Multi-Agent Orchestration**
- Main agent delegates work to specialized subagents
- Each subagent focuses on one role (planning, coding, testing, etc.)
- Agents have persistent memory in `.claude/agent-memory/<name>/`
- Main agent tracks workflow state and session recovery

**4. Quality Enforcement**
- Architecture standards enforced via `coding_guidelines.md`
- Automated testing before commits
- Code review by warden agent
- Conventional commits (no AI signatures)

**5. Session Recovery**
- Work tracked in `CURRENT_SESSION.md` and brief files
- Context resets automatically resume from last checkpoint
- Multi-level tracking (project → brief → task → agent)

---

## ✦ Quick Start

### Installation

```bash
# Clone IGRIS
git clone https://github.com/fiftynotai/igris-ai
cd your-project

# Initialize IGRIS in your project
../igris-ai/scripts/igris_init.sh
```

This creates:
- `ai/` - IGRIS directory with templates and prompts
- `.claude/agents/` - 18 native subagents
- `.claude/hooks/` - Startup hook for auto-initialization
- `CLAUDE.md` - Context for Claude Code CLI
- `scripts/` - Core IGRIS scripts

**MCP Server Setup (Optional):**

If Node.js 20+ is detected, you'll be prompted to build the MCP server for enhanced tool integration. This is optional — IGRIS works fully without MCP.

### Your First 5 Minutes

```bash
# 1. Launch Claude
claude
```

**You'll see:** Igris greeting + system assessment + recommended actions

```bash
# 2. Generate coding guidelines (foundation first)
```
"Generate coding guidelines for this project"
```

# 3. Register a task
```
"Register a bug: Users can't login with special characters"
```

# 4. Autonomous implementation
```
"HUNT BR-001"
```
```

**That's it.** IGRIS autonomously:
- Creates implementation plan (architect agent)
- Writes code following architecture (forger agent)
- Generates and runs tests (sentinel agent)
- Reviews quality and security (warden agent)
- Commits with conventional format (main agent)

### Commands Reference

| Command | Description | Agent Used |
|---------|-------------|------------|
| `HUNT {brief_id}` | Autonomous implementation | All Tier 1 |
| `STANDARDIZE {mode}` | Generate coding guidelines | lawkeeper |
| `MIGRATE analyze` | Migration analysis + briefs | pathfinder |
| `AUDIT {type}` | Code quality analysis | inquisitor |
| `DOCUMENT architecture` | Generate architecture docs | chronicler |
| `DIGIVOLVE status` | List all agents | - |

**Modes for STANDARDIZE:**
- `analyze` - Infer from current codebase
- `from-base` - Extract from base architecture repo
- `hybrid` - Combine base + project (base precedence)
- `minimal` - Use platform-specific industry standards

**AUDIT types:**
- `code_quality`, `bugs`, `standards`, `dependencies`, `test_coverage`, `performance`, `architecture`

---

## ✦ IGRIS vs Claude: Understanding the Architecture

**IGRIS is not a model. It is a multi-agent engineering system that orchestrates Claude Code to produce structured, high-quality software. Claude provides intelligence; IGRIS provides process, workflow, agents, and engineering discipline.**

### The Relationship

```
┌─────────────────────────────────────┐
│   IGRIS (Multi-Agent System)        │
│   - 18 Specialized Subagents         │
│   - Workflow Orchestration           │
│   - Architecture Enforcement         │
│   - Session Management               │
│   - Quality Standards                │
│   - Brief Management                 │
└──────────────┬──────────────────────┘
               │ Orchestrates
               ↓
┌─────────────────────────────────────┐
│   Claude Code (CLI)                  │
│   - Task delegation (Task tool)      │
│   - Context loading                  │
│   - File operations                  │
└──────────────┬──────────────────────┘
               │ Powered by
               ↓
┌─────────────────────────────────────┐
│   Claude (AI Model)                  │
│   - Intelligence                     │
│   - Code generation                  │
│   - Natural language understanding   │
└─────────────────────────────────────┘
```

**Think of it this way:**
- **Claude** = The brain (intelligence)
- **IGRIS** = The team (specialized roles, workflow, quality gates)
- **You** = The architect (strategic decisions, priorities)

**Without IGRIS:** Claude generates code based on prompts → random outputs
**With IGRIS:** 18 specialized agents engineer outcomes autonomously → disciplined execution

---

## ✦ The Multi-Agent Workflow

### Autonomous Implementation Flow

When you invoke `HUNT BR-005`:

```
┌──────────────────────────────────────────────────────────────┐
│ INIT (Main Agent)                                            │
│ ├─ Read brief BR-005                                         │
│ ├─ Create branch: implement/BR-005                           │
│ ├─ Update brief: Status = "In Progress"                      │
│ └─ Assess complexity: L → requires approval                  │
└────────────────┬─────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────┐
│ PLANNING (architect agent)                                   │
│ ├─ Analyze brief requirements                                │
│ ├─ Load coding_guidelines.md                                 │
│ ├─ Create implementation plan                                │
│ └─ Save to ai/plans/BR-005-plan.md                          │
└────────────────┬─────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────┐
│ APPROVAL GATE (Main Agent)                                   │
│ ├─ Display plan summary to user                              │
│ ├─ Wait for: "approve" | "reject" | "modify"                 │
│ └─ If S/M complexity → auto-approve                          │
└────────────────┬─────────────────────────────────────────────┘
                 │ approved
                 ▼
┌──────────────────────────────────────────────────────────────┐
│ BUILDING (forger agent)                                      │
│ ├─ Read plan                                                 │
│ ├─ Follow architecture standards                             │
│ ├─ Write clean, documented code                              │
│ └─ Verify git diff shows changes                             │
└────────────────┬─────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────┐
│ TESTING (sentinel agent) - Max 3 retries                     │
│ ├─ Generate test cases                                       │
│ ├─ Run test suite                                            │
│ ├─ Parse result: PASS | FAIL                                 │
│ └─ If FAIL → send failure back to forger → retry             │
└────────────────┬─────────────────────────────────────────────┘
                 │ pass
                 ▼
┌──────────────────────────────────────────────────────────────┐
│ REVIEWING (warden agent) - Max 2 rejects                     │
│ ├─ Code quality inspection                                   │
│ ├─ Security vulnerability check                              │
│ ├─ Architecture compliance                                   │
│ ├─ Verdict: APPROVE | REJECT                                 │
│ └─ If REJECT → send feedback to forger → fix → retry         │
└────────────────┬─────────────────────────────────────────────┘
                 │ approve
                 ▼
┌──────────────────────────────────────────────────────────────┐
│ COMMITTING (Main Agent)                                      │
│ ├─ git add -A                                                │
│ ├─ git commit -m "feat(BR-005): {title}"                     │
│ ├─ git checkout main                                         │
│ ├─ git merge implement/BR-005                                │
│ ├─ git branch -d implement/BR-005                            │
│ ├─ Update brief: Status = "Done"                             │
│ └─ Save metrics to ai/session/metrics/                       │
└──────────────────────────────────────────────────────────────┘
```

**Self-Healing:**
- Test failures automatically loop back to forger (max 3 attempts)
- Code review rejections trigger fixes (max 2 rejects)
- If max retries exceeded → BLOCKED state → human intervention

---

## ✦ The 18 Agents

As of v3.3, all agents are defined as **native Claude Code agent files** in `.claude/agents/`. Each agent has a persona-themed name, custom system prompt, tool restrictions, model selection, and persistent memory.

### Agent Definition Format

Each `.claude/agents/<name>.md` file uses YAML frontmatter:

```yaml
---
name: architect
description: Strategic implementation planner for Igris AI...
tools: Read, Grep, Glob
model: inherit
memory: project
---
```

| Field | Purpose | Values |
|-------|---------|--------|
| `name` | Agent identifier used in `subagent_type` | Persona name (e.g., `architect`) |
| `description` | When to invoke this agent | Free text |
| `tools` | Allowed tools (restricts agent capabilities) | Comma-separated tool names |
| `model` | Which Claude model powers this agent | `inherit` (same as parent) or `haiku` (fast/cheap) |
| `memory` | Persistent memory scope | `project` (stored in `.claude/agent-memory/<name>/`) |

### Agent Name Mapping (v3.2 → v3.3)

All agents were renamed from generic identifiers to persona-themed names in MG-007. Each agent retains a "(formerly X)" note in its system prompt for traceability.

| v3.2 Name (generic) | v3.3 Name (persona) | Tier | Role |
|---|---|---|---|
| planner | **architect** | 1 | Strategic planning |
| coder | **forger** | 1 | Code implementation |
| tester | **sentinel** | 1 | Test execution |
| reviewer | **warden** | 1 | Code review |
| ui-designer | **artisan** | 1 | Visual design |
| documenter | **chronicler** | 2 | Documentation |
| releaser | **herald** | 2 | Release prep |
| standardizer | **lawkeeper** | 2 | Standards generation |
| auditor | **inquisitor** | 3 | Code analysis |
| debugger | **mender** | 3 | Error recovery |
| migrator | **pathfinder** | 3 | Migration analysis |
| ideator | **oracle** | 4 | Feature ideation |
| explorer | **seeker** | 4 | Codebase research |
| flutter-mvvm-actions-expert | **sage** | 5 | Flutter MVVM + Actions |
| multi-agent-coordinator | **conductor** | 6 | Workflow orchestration |
| agent-organizer | **tactician** | 6 | Team assembly |
| context-manager | **archivist** | 6 | State management |
| task-distributor | **dispatcher** | 6 | Queue management |

### Tier 1: Core Workflow (Required)

| Agent | Role | Responsibilities | Tools | Model |
|-------|------|------------------|-------|-------|
| **architect** | Strategic planning | Creates implementation plans, analyzes briefs | Read, Grep, Glob | inherit |
| **forger** | Code implementation | Writes clean code following architecture | Read, Write, Edit, Bash, Grep, Glob | inherit |
| **sentinel** | Test execution | Generates tests, runs test suite, validates | Read, Bash, Grep | inherit |
| **warden** | Code review | Quality inspection, security checks | Read, Grep, Glob | inherit |
| **artisan** | Visual design | UI specs, design systems, accessibility | Read, Write, Edit, Bash, Glob, Grep | inherit |

### Tier 2: Documentation

| Agent | Role | Responsibilities | Tools | Model |
|-------|------|------------------|-------|-------|
| **chronicler** | Documentation | Writes/updates docs, README, code comments | Read, Write, Grep, Glob | inherit |
| **herald** | Release prep | Generates changelog, versions, release notes | Read, Write, Bash, Grep | inherit |
| **lawkeeper** | Standards gen | Generates coding_guidelines.md (4 modes) | Read, Write, Grep, Glob, Bash | inherit |

### Tier 3: Maintenance

| Agent | Role | Responsibilities | Tools | Model |
|-------|------|------------------|-------|-------|
| **inquisitor** | Code analysis | 7 audit operations, creates briefs for findings | Read, Grep, Glob, Bash | inherit |
| **mender** | Error recovery | Diagnoses errors, suggests fixes | Read, Grep, Glob, Bash | inherit |
| **pathfinder** | Migration analysis | Analyzes code vs standards, creates migration briefs | Read, Grep, Glob, Bash | inherit |

### Tier 4: Innovation

| Agent | Role | Responsibilities | Tools | Model |
|-------|------|------------------|-------|-------|
| **oracle** | Feature ideation | Brainstorms features, creates FR-XXX briefs | Read, Grep, Glob | inherit |
| **seeker** | Codebase research | Investigates and explains codebase | Read, Grep, Glob, Bash | haiku |

### Tier 5: Custom (User-Defined)

| Agent | Role | Responsibilities | Tools | Model |
|-------|------|------------------|-------|-------|
| **sage** | Flutter architecture | Kalvad MVVM + Actions Layer patterns, GetX | Read, Write, Edit, Bash, Glob, Grep | inherit |

### Tier 6: Meta-Orchestration

| Agent | Role | Responsibilities | Tools | Model |
|-------|------|------------------|-------|-------|
| **conductor** | Workflow orchestration | Complex multi-agent choreography, parallel execution | Read, Write, Edit, Glob, Grep | inherit |
| **tactician** | Team assembly | Agent capability assessment, optimal team selection | Read, Write, Edit, Glob, Grep | inherit |
| **archivist** | State management | Cross-agent context, recovery points, sync | Read, Write, Edit, Glob, Grep | inherit |
| **dispatcher** | Task scheduling | Queue management, load balancing, priority scheduling | Read, Write, Edit, Glob, Grep | inherit |

### Key Agent Features (v3.3)

- **Persistent Memory:** All agents have `memory: project`, storing learned context in `.claude/agent-memory/<name>/` across sessions.
- **Tool Restrictions:** Read-only agents (architect, warden, oracle) cannot write files. Implementation agents (forger, artisan, sage) have full Read/Write/Edit/Bash access.
- **Model Selection:** Most agents use `model: inherit` (same model as the orchestrator). The seeker agent uses `model: haiku` for fast, low-cost codebase exploration.
- **Traceability:** Each agent's system prompt includes `(formerly <old-name>)` to maintain backward compatibility understanding.

---

## ✦ Core Capabilities

### 1. Brief Management

**9 Brief Types:**

| Type | Purpose | Example |
|------|---------|---------|
| BR-XXX | Bugs & Features | "Fix login with special chars" |
| FR-XXX | Feature Requests | "Add dark mode support" |
| TD-XXX | Technical Debt | "Refactor authentication module" |
| MG-XXX | Migrations | "Migrate to new API pattern" |
| TS-XXX | Testing | "Add missing unit tests" |
| PI-XXX | Process Improvements | "Optimize CI/CD pipeline" |
| DU-XXX | Dependency Updates | "Update React to v18" |
| PF-XXX | Performance | "Optimize database queries" |
| AC-XXX | Architecture Cleanup | "Remove unused modules" |

**Brief Lifecycle:**
```
Draft → Ready → In Progress → In Review → Done → Archived
```

**Quick Commands:**
```bash
# Register a bug (don't implement yet)
"Register a bug: Login fails with @ symbol in password"

# List all briefs
"List all bugs"

# Autonomous implementation
"HUNT BR-001"

# After completion
"Archive BR-001"
```

### 2. Autonomous Quality Assurance (Inquisitor Agent)

**7 Audit Operations:**

| Operation | Creates | Trigger |
|-----------|---------|---------|
| CODE_QUALITY_AUDIT | TD-XXX briefs | "Audit code_quality" |
| BUG_HUNT | BR-XXX briefs | "Audit bugs" |
| STANDARDS_COMPLIANCE_CHECK | TD-XXX briefs | "Audit standards" |
| TEST_COVERAGE_ANALYSIS | TS-XXX briefs | "Audit test_coverage" |
| DEPENDENCY_AUDIT | DU-XXX briefs | "Audit dependencies" |
| PERFORMANCE_ANALYSIS | PF-XXX briefs | "Audit performance" |
| ARCHITECTURE_REVIEW | AC-XXX briefs | "Audit architecture" |

**Example Workflow:**
```bash
# Before major release
"Audit dependencies"        # Security first
"Audit bugs"               # Find issues before users
"Audit test_coverage"      # Quality gate
"Audit standards"          # Final polish

# Monthly maintenance
"Audit dependencies"       # Stay current
"Audit code_quality"       # Prevent debt accumulation
```

### 3. Architecture Standards Generation (Lawkeeper Agent)

**4 Generation Modes:**

```bash
# Mode 1: Analyze current codebase
"STANDARDIZE analyze"

# Mode 2: Extract from base architecture repo
"STANDARDIZE from-base"
Base repo: https://github.com/your-org/flutter-base

# Mode 3: Hybrid (base + project, base precedence)
"STANDARDIZE hybrid"
Base repo: https://github.com/your-org/flutter-base

# Mode 4: Minimal (platform-specific industry standards)
"STANDARDIZE minimal"
Platform: Flutter
```

**Output:** Comprehensive `ai/context/coding_guidelines.md` covering architecture, naming, testing, patterns.

### 4. Migration Analysis (Pathfinder Agent)

**Analyze entire codebase against standards:**

```bash
"MIGRATE analyze"
```

**The pathfinder agent will:**
1. Scan entire codebase
2. Compare against `coding_guidelines.md`
3. Identify architecture violations
4. Generate categorized briefs:
   - MG-XXX (migrations)
   - TD-XXX (technical debt)
   - BR-XXX (bugs)
   - TS-XXX (testing gaps)
5. Create prioritized migration roadmap

**Perfect for:**
- Onboarding existing codebases
- Modernizing legacy projects
- Enforcing new standards
- Planning architecture refactoring

### 5. Session Management

**Multi-Level Tracking:**

```
PROJECT LEVEL (CURRENT_SESSION.md)
├─ Active briefs (IDs only)
├─ Session status (In Progress / Paused / None)
├─ Resume point
└─ Last session summary

BRIEF LEVEL (Brief Files)
├─ Tasks (Pending/In Progress/Completed)
├─ Workflow State
│   ├─ Phase: PLANNING → BUILDING → TESTING → REVIEWING → COMPLETE
│   ├─ Active Agent: architect | forger | sentinel | warden | none
│   ├─ Retry Count
│   └─ Agent Log (timestamped history)
├─ Current work description
└─ Next steps for resuming
```

**Automatic Recovery:**

If Claude context resets mid-workflow:
1. IGRIS reads `CURRENT_SESSION.md` → which brief is active?
2. Reads that brief file → checks Workflow State
3. Resumes from exact phase (e.g., "TESTING phase, retry 2/3")

**Session Files:**
- `CURRENT_SESSION.md` - Active session state
- `BLOCKERS.md` - Blocking issues
- `DECISIONS.md` - Architectural decisions
- `LEARNINGS.md` - Discovered patterns
- `PROTOCOL_VIOLATIONS.md` - Violation tracking

---

## ✦ IGRIS vs Other Tools

### IGRIS vs Cursor AI

| Feature | Cursor AI | IGRIS |
|---------|-----------|-------|
| **Approach** | Editor-integrated AI | Multi-agent engineering system |
| **Focus** | Fast code completion | Autonomous end-to-end workflows |
| **Quality Control** | Manual | Automated (18 agents, quality gates) |
| **Session Recovery** | None | Automatic (multi-level tracking) |
| **Architecture Enforcement** | No | Yes (coding_guidelines.md) |
| **Brief Management** | No | Yes (9 brief types, priorities) |
| **Testing** | Manual | Automated (sentinel agent) |
| **Best For** | Quick edits, autocomplete | Full feature development, teams |

### IGRIS vs Aider

| Feature | Aider | IGRIS |
|---------|-------|-------|
| **Approach** | CLI chat for code edits | Multi-agent autonomous system |
| **Focus** | File editing, git integration | End-to-end engineering (plan → test → commit) |
| **Agents** | Single agent | 18 specialized agents |
| **Quality Control** | Commit messages | Briefs, tests, architecture, warden agent |
| **Session Tracking** | Git commits only | Multi-level (session, briefs, workflow, agents) |
| **Self-Healing** | No | Yes (test failures loop to forger) |
| **Best For** | Quick fixes, pair programming | Enterprise development, quality focus |

### IGRIS vs GitHub Copilot

| Feature | GitHub Copilot | IGRIS |
|---------|----------------|-------|
| **Approach** | Autocomplete | Multi-agent autonomous workflows |
| **Focus** | Line/function suggestions | Full features with architecture |
| **Planning** | None | architect agent creates plans |
| **Testing** | No | sentinel agent generates + runs tests |
| **Quality Assurance** | No | warden agent + inquisitor agent |
| **Session Recovery** | None | Full context preservation |
| **Team Workflows** | Limited | Built-in (briefs, priorities, handoffs) |
| **Best For** | Individual coding, boilerplate | Teams, complex features, quality |

### IGRIS vs Plain Claude

| Feature | Plain Claude | IGRIS + Claude |
|---------|--------------|----------------|
| **Context** | Manual prompt loading | Automatic (CLAUDE.md + hooks) |
| **Workflow** | Ad-hoc | Autonomous (HUNT command) |
| **Agents** | Single Claude | 18 specialized subagents |
| **Quality** | Varies by prompt | Enforced (guidelines, tests, review) |
| **Recovery** | Lose context on reset | Automatic (session tracking) |
| **Accountability** | None | Full audit trail (briefs, decisions) |
| **Best For** | Quick questions | Production software development |

---

## ✦ When to Use IGRIS

**IGRIS is ideal for:**
- ✅ Building production software with quality standards
- ✅ Team development (structured handoffs, clear priorities)
- ✅ Complex features requiring architecture compliance
- ✅ Projects with technical debt to manage
- ✅ Open-source projects (docs, tests, release quality)
- ✅ Onboarding existing codebases (migration analysis)

**Skip IGRIS if:**
- ❌ Prototyping/throwaway code
- ❌ Single-file scripts
- ❌ No architecture standards needed
- ❌ Just learning/experimenting

**The Rule:** If you're shipping it → use IGRIS. If you're exploring → plain Claude is fine.

---

## ✦ Common Workflows

### Starting a New Project

```bash
# 1. Install IGRIS
../igris-ai/scripts/igris_init.sh

# 2. Launch Claude
claude

# 3. Generate coding guidelines (foundation first)
"STANDARDIZE analyze"

# 4. Generate architecture documentation
"DOCUMENT architecture"

# 5. Start engineering
"Register a bug: [describe issue]"
"HUNT BR-001"
```

**Result:** Professional setup in < 10 minutes

### Onboarding an Existing Codebase

```bash
# 1. Install IGRIS in existing project
cd existing-project
../igris-ai/scripts/igris_init.sh

# 2. Generate standards from codebase
claude
"STANDARDIZE analyze"

# 3. Run migration analysis
"MIGRATE analyze"

# The pathfinder agent will:
# - Scan entire codebase
# - Identify violations
# - Generate briefs (MG-XXX, TD-XXX, BR-XXX, TS-XXX)
# - Create prioritized roadmap

# 4. Review generated briefs
"List all briefs"

# 5. Start with high-priority items
"What should I work on next?"
"HUNT BR-005"  # Fix critical bug first
```

**Result:** Systematic modernization plan

### Before Major Release

```bash
claude

# Security and quality checks
"Audit dependencies"              # Security vulnerabilities
"Audit bugs"                      # Find issues before users
"Audit test_coverage"             # Quality gate
"Audit standards"                 # Final polish

# Review findings
"List P0 bugs"                    # Critical issues

# Fix systematically
"HUNT BR-008"                     # Fix critical bugs
"HUNT DU-003"                     # Update vulnerable deps
"HUNT TS-012"                     # Add missing tests
```

**Result:** Confident, quality release

### Monthly Maintenance Routine

```bash
# First Monday of the month
claude

"Audit dependencies"              # Stay current
"Audit code_quality"              # Find new tech debt
"Audit standards"                 # Maintain standards

# Review and prioritize
"List TD briefs by priority"

# Dedicate time to pay down debt
"HUNT TD-015"                     # Refactor module
"HUNT DU-007"                     # Update packages
```

**Result:** Clean, maintainable codebase

---

## ✦ Agent Management (Digivolve Protocol)

**List all agents:**
```bash
"DIGIVOLVE status"
```

**Output:**
```
AGENT ROSTER

Tier 1: Core Workflow
✅ architect    | Implementation planning  | 47 runs
✅ forger       | Code implementation      | 52 runs
✅ sentinel     | Test execution           | 48 runs
✅ warden       | Code review              | 41 runs
✅ artisan      | Visual design            | 3 runs

Tier 2: Documentation
✅ chronicler   | Documentation            | 12 runs
✅ herald       | Release preparation      | 3 runs
✅ lawkeeper    | Standards generation     | 5 runs

Tier 3: Maintenance
✅ inquisitor   | Code analysis            | 8 runs
✅ mender       | Error recovery           | 15 runs
✅ pathfinder   | Migration analysis       | 2 runs

Tier 4: Innovation
✅ oracle       | Feature ideation         | 2 runs
✅ seeker       | Codebase research        | 23 runs

Tier 5: Custom
✅ sage         | Flutter MVVM + Actions   | 6 runs

Tier 6: Meta-Orchestration
✅ conductor    | Workflow orchestration    | 4 runs
✅ tactician    | Team assembly            | 2 runs
✅ archivist    | State management         | 5 runs
✅ dispatcher   | Queue management         | 3 runs
```

**Agent metrics tracked in:** `ai/session/metrics/agent-metrics.json`

---

## ✦ MCP Server (Optional)

**Core IGRIS works via CLAUDE.md + file operations.** MCP adds convenience tools.

**MCP provides:**
- `igris_brief_list` - List briefs with filters
- `igris_brief_read` - Read brief by ID
- `igris_brief_create` - Create new brief
- `igris_brief_update` - Update brief status/priority
- `igris_session_read` - Read current session
- `igris_session_update` - Update session state
- `git_status` - Get git status
- `git_diff` - Show git diff

**Setup (if Node.js 20+ installed):**
```bash
# During igris_init.sh, you'll be prompted:
Build MCP server? (y/n)

# If yes:
cd ai/mcp
npm install
npm run build
```

**Without MCP:** IGRIS uses standard file operations (Read/Write). Works perfectly, just uses more tokens.

---

## ✦ Persona System

IGRIS includes the **Igris persona** (Shadow Knight) for improved AI consistency.

**Default Persona:** Igris (Shadow Knight)
**Default Mask:** Half (subtle branding, professional)

**Adjust mask anytime:**
```bash
./scripts/persona_mask.sh adjust [none|half|light|full]
```

**Mask Levels:**
- **None:** Persona dormant (standard Claude)
- **Half:** Subtle branding, professional (default)
- **Light:** Branding + personality hints
- **Full:** Complete immersion with shadow commands (ARISE, HUNT, etc.)

**Remove persona:**
```bash
./scripts/persona_mask.sh remove
```

---

## ✦ Updating IGRIS

**Check version:**
```bash
cat .igris_version
```

**Update core:**
```bash
./scripts/igris_update.sh
```

**Update plugins:**
```bash
./scripts/plugin_update.sh <plugin-name>
```

**What's preserved:**
- Your briefs (`ai/briefs/`)
- Your session data (`ai/session/`)
- Your architecture docs (`ai/context/`)
- Plugin registry

**Automatic backups** created in `.igris_backup/` before every update.

---

## ✦ Requirements

**Required:**
- Git
- Claude Code CLI or Claude.ai
- Python 3
- Bash (Mac/Linux/WSL)

**Optional:**
- Node.js 20+ (for MCP server)
- jq (for plugin hooks)

---

## ✦ Project Structure

```
your-project/
├── .claude/
│   ├── agents/                  # 18 native subagents (.md files)
│   │   ├── architect.md         # Tier 1: Strategic planning
│   │   ├── forger.md            # Tier 1: Code implementation
│   │   ├── sentinel.md          # Tier 1: Test execution
│   │   ├── warden.md            # Tier 1: Code review
│   │   ├── artisan.md           # Tier 1: Visual design
│   │   ├── chronicler.md        # Tier 2: Documentation
│   │   ├── herald.md            # Tier 2: Release prep
│   │   ├── lawkeeper.md         # Tier 2: Standards generation
│   │   ├── inquisitor.md        # Tier 3: Code analysis
│   │   ├── mender.md            # Tier 3: Error recovery
│   │   ├── pathfinder.md        # Tier 3: Migration analysis
│   │   ├── oracle.md            # Tier 4: Feature ideation
│   │   ├── seeker.md            # Tier 4: Codebase research
│   │   ├── sage.md              # Tier 5: Flutter MVVM + Actions
│   │   ├── conductor.md         # Tier 6: Workflow orchestration
│   │   ├── tactician.md         # Tier 6: Team assembly
│   │   ├── archivist.md         # Tier 6: State management
│   │   ├── dispatcher.md        # Tier 6: Queue management
│   │   └── manifest.yaml        # [DEPRECATED] Legacy agent registry
│   ├── agent-memory/            # Persistent per-agent memory
│   │   ├── architect/
│   │   ├── forger/
│   │   └── ...
│   └── hooks/
│       └── startup.sh           # Auto-runs on Claude start
├── CLAUDE.md                    # Context loaded on first message
├── ai/
│   ├── briefs/                  # Work items (9 types)
│   ├── context/                 # Architecture docs
│   │   ├── coding_guidelines.md
│   │   ├── architecture_map.md
│   │   ├── api_pattern.md
│   │   └── module_catalog.md
│   ├── prompts/                 # AI prompts (igris_os.md, etc.)
│   ├── session/                 # Session tracking
│   │   ├── CURRENT_SESSION.md
│   │   ├── BLOCKERS.md
│   │   ├── DECISIONS.md
│   │   ├── LEARNINGS.md
│   │   └── metrics/
│   │       └── agent-metrics.json
│   ├── plans/                   # Implementation plans
│   ├── templates/               # Brief templates
│   └── plugins/                 # Plugin registry
└── scripts/                     # IGRIS scripts
    ├── igris_init.sh
    ├── igris_update.sh
    ├── plugin_install.sh
    └── ...
```

---

## ✦ Migration Guide: v3.2 → v3.3 (MG-007)

### Breaking Change: Agent Names

In v3.3, all 18 agents were migrated from generic identifiers to persona-themed names defined as native Claude Code agent files. The legacy `manifest.yaml` registry is deprecated.

**What changed:**
- Agent files moved from generic names (e.g., `planner.md`) to persona names (e.g., `architect.md`)
- `subagent_type` values in Task tool invocations must use the new names
- `manifest.yaml` is deprecated (retained with header notice, no longer the source of truth)
- Each agent now has a custom system prompt, tool restrictions, model selection, and persistent memory

**If you have custom scripts or workflows that reference agent names, update them:**

| Before (v3.2) | After (v3.3) |
|---|---|
| `subagent_type: "planner"` | `subagent_type: "architect"` |
| `subagent_type: "coder"` | `subagent_type: "forger"` |
| `subagent_type: "tester"` | `subagent_type: "sentinel"` |
| `subagent_type: "reviewer"` | `subagent_type: "warden"` |
| `subagent_type: "ui-designer"` | `subagent_type: "artisan"` |
| `subagent_type: "documenter"` | `subagent_type: "chronicler"` |
| `subagent_type: "releaser"` | `subagent_type: "herald"` |
| `subagent_type: "standardizer"` | `subagent_type: "lawkeeper"` |
| `subagent_type: "auditor"` | `subagent_type: "inquisitor"` |
| `subagent_type: "debugger"` | `subagent_type: "mender"` |
| `subagent_type: "migrator"` | `subagent_type: "pathfinder"` |
| `subagent_type: "ideator"` | `subagent_type: "oracle"` |
| `subagent_type: "explorer"` | `subagent_type: "seeker"` |
| `subagent_type: "flutter-mvvm-actions-expert"` | `subagent_type: "sage"` |
| `subagent_type: "multi-agent-coordinator"` | `subagent_type: "conductor"` |
| `subagent_type: "agent-organizer"` | `subagent_type: "tactician"` |
| `subagent_type: "context-manager"` | `subagent_type: "archivist"` |
| `subagent_type: "task-distributor"` | `subagent_type: "dispatcher"` |

**New capabilities per agent (v3.3):**
- `memory: project` -- agents persist learned knowledge across sessions
- Per-agent `tools` restrictions -- read-only agents cannot write files
- `model` selection -- seeker uses `haiku` for fast exploration
- Custom system prompts with persona identity, capabilities, constraints, and tagline

---

## ✦ Documentation

- **Operating System:** `ai/prompts/igris_os.md` (complete system, all protocols)
- **Setup Guide:** `docs/SETUP_GUIDE.md`
- **Update Guide:** `docs/UPDATE_GUIDE.md`
- **Migration Guide:** `docs/MIGRATION_GUIDE.md`
- **Plugin Development:** `docs/PLUGIN_DEVELOPMENT.md`
- **Contributing:** `ai/CONTRIBUTING.md`
- **Main Repository:** https://github.com/fiftynotai/igris-ai

---

## ✦ FAQ

**Q: What's the difference between IGRIS and Claude?**
A: IGRIS is a multi-agent engineering system that orchestrates Claude Code through 18 specialized subagents. Claude provides intelligence; IGRIS provides process, agents, and discipline.

**Q: Does IGRIS work with Claude.ai (web interface)?**
A: Yes, but with limitations. Startup hooks won't auto-run, and Task tool (subagents) may not be available. Claude Code CLI is recommended.

**Q: How do agents communicate?**
A: Main agent (orchestrator) delegates work to subagents via Task tool. Subagents are stateless — they receive task instructions, do work, return results. Main agent tracks workflow state.

**Q: Can I disable specific agents?**
A: Yes. Remove or rename the agent's `.md` file in `.claude/agents/`, or use `DIGIVOLVE disable {agent}`.

**Q: What is the agent memory feature?**
A: All agents have `memory: project` enabled, which stores persistent knowledge in `.claude/agent-memory/<name>/`. This allows agents to remember project-specific context across sessions.

**Q: Why are some agents read-only?**
A: Tool restrictions enforce the separation of concerns. For example, the architect agent (planning) and warden agent (review) should never write code -- they only analyze and advise. The forger agent (implementation) has full write access because its job is to produce code.

**Q: Why does the seeker agent use a different model?**
A: The seeker agent uses `model: haiku` for fast, low-cost codebase exploration. Since its role is research and investigation (not code generation), a lighter model provides faster responses without sacrificing quality.

**Q: Do I need Node.js?**
A: No. Node.js 20+ enables the optional MCP server for convenience tools. Core IGRIS works via CLAUDE.md + file operations.

**Q: Do I need to create briefs for everything?**
A: Only for file modifications (code changes). Read-only operations (questions, analysis, listing) don't require briefs.

**Q: What if my conversation resets mid-task?**
A: IGRIS automatically resumes from where you left off. Session state is saved in `CURRENT_SESSION.md` and brief files. Just start a new conversation.

**Q: Can I use IGRIS with other AI models (not Claude)?**
A: Currently optimized for Claude Code CLI. The system is model-agnostic in theory, but workflows assume Task tool for subagent delegation.

---

## ✦ Example Project

**Want to see IGRIS in action?**

**[igris-ai-flutter-example](https://github.com/fiftynotai/igris_ai_flutter_example)** - A fully configured Flutter project demonstrating:
- ✅ Complete IGRIS setup
- ✅ Example briefs (BR, FR, TD)
- ✅ Conventional commits
- ✅ Autonomous workflows
- ✅ Distribution plugin integration
- ✅ Real commit history showing workflow

**[→ View Example Project](https://github.com/fiftynotai/igris_ai_flutter_example)**

---

## ✦ Community

- **GitHub:** [fiftynotai/igris-ai](https://github.com/fiftynotai/igris-ai)
- **Issues:** [Report bugs, request features](https://github.com/fiftynotai/igris-ai/issues)
- **Discussions:** [Share ideas, get help](https://github.com/fiftynotai/igris-ai/discussions)
- **Example Project:** [igris-ai-flutter-example](https://github.com/fiftynotai/igris_ai_flutter_example)
- **Contributing:** See [CONTRIBUTING.md](ai/CONTRIBUTING.md)

---

## ✦ The Open Engineering Era

**Create boldly. Release openly. Engineer with discipline.**

IGRIS exists to merge imagination with structure — the spark *and* the system — so ideas become reality through craft, clarity, and open collaboration.

Open source is humanity's greatest multiplier. IGRIS empowers:
- **Abundance** — More creators, more releases, more shared knowledge
- **Quality** — Tests, docs, clarity, maintainability
- **Autonomy** — 18 agents working together to ship quality software

**The Open Source Call:**
> *Create boldly. Release openly. Engineer with discipline.*

---

## ✦ License

[MIT License](LICENSE) - Build freely, share openly.

---

## ✦ Acknowledgments

Built for developers and teams using Claude AI to engineer high-quality software with autonomous multi-agent workflows.

---

> **IGRIS — Where Creativity Meets Discipline, Powered by 18 Autonomous Agents.**

```bash
# Ready to engineer?
./scripts/igris_init.sh

# v3.3 Commands:
# HUNT BR-001           - Autonomous implementation
# STANDARDIZE analyze   - Generate coding guidelines
# DOCUMENT architecture - Generate architecture docs
# MIGRATE analyze       - Analyze codebase for migrations
# AUDIT {type}          - Code quality analysis
# DIGIVOLVE status      - List all agents
```

**From Vibe Coding → Vibe Engineering.**
