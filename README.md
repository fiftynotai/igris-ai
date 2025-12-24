# ✦ IGRIS AI — Multi-Agent Engineering System

> *From Vibe Coding → Vibe Engineering*

**Version 3.2.0** | Production Ready

---

> *"AI made coding faster — but not better. IGRIS brings the discipline."*

**IGRIS** is a multi-agent AI engineering system that orchestrates Claude Code through 13 specialized subagents to build high-quality software with structure, testing, and documentation.

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

## ✦ What is IGRIS v3.2?

**IGRIS** is a multi-agent AI engineering system powered by Claude Code that transforms how you build software through autonomous workflows.

**Category:** Multi-Agent AI Engineering Platform
**Core Promise:** Autonomous Quality Execution

### The v3.2 Architecture

**13 Native Subagents Across 5 Tiers:**

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
                   ├─► TIER 1 (Core): planner → coder → tester → reviewer
                   │                    Plan     Build    Test     Review
                   │
                   ├─► TIER 2 (Docs): documenter, releaser, standardizer
                   │                   Write Docs   Releases   Guidelines
                   │
                   ├─► TIER 3 (Maintenance): auditor, debugger, migrator
                   │                          Analyze   Fix      Migrate
                   │
                   ├─► TIER 4 (Innovation): ideator, explorer
                   │                            Imagine   Research
                   │
                   └─► TIER 5 (Custom): user-defined domain experts
                                            Specialized Knowledge
```

### How It Works

**1. Brief-First Protocol**
- All file modifications require a brief (BR, FR, TD, MG, etc.)
- Briefs define goals, acceptance criteria, test plans
- 9 brief types for different work (bugs, features, migrations, performance, etc.)

**2. Autonomous Workflows**
- `HUNT {brief_id}` triggers full autonomous implementation
- Workflow: PLANNING → BUILDING → TESTING → REVIEWING → COMMITTING
- Self-healing: Test failures loop back to coder (max 3 retries)
- Auto-approval for S/M tasks, user approval for L/XL

**3. Multi-Agent Orchestration**
- Main agent delegates work to specialized subagents
- Each subagent focuses on one role (planning, coding, testing, etc.)
- Stateless agents receive tasks, return results
- Main agent tracks workflow state and session recovery

**4. Quality Enforcement**
- Architecture standards enforced via `coding_guidelines.md`
- Automated testing before commits
- Code review by reviewer agent
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
- `.claude/agents/` - 13 native subagents
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
- Creates implementation plan (planner agent)
- Writes code following architecture (coder agent)
- Generates and runs tests (tester agent)
- Reviews quality and security (reviewer agent)
- Commits with conventional format (main agent)

### Commands Reference

| Command | Description | Agent Used |
|---------|-------------|------------|
| `HUNT {brief_id}` | Autonomous implementation | All Tier 1 |
| `STANDARDIZE {mode}` | Generate coding guidelines | standardizer |
| `MIGRATE analyze` | Migration analysis + briefs | migrator |
| `AUDIT {type}` | Code quality analysis | auditor |
| `DOCUMENT architecture` | Generate architecture docs | documenter |
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
│   - 13 Specialized Subagents         │
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
**With IGRIS:** 13 specialized agents engineer outcomes autonomously → disciplined execution

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
│ PLANNING (planner agent)                                     │
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
│ BUILDING (coder agent)                                       │
│ ├─ Read plan                                                 │
│ ├─ Follow architecture standards                             │
│ ├─ Write clean, documented code                              │
│ └─ Verify git diff shows changes                             │
└────────────────┬─────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────┐
│ TESTING (tester agent) - Max 3 retries                       │
│ ├─ Generate test cases                                       │
│ ├─ Run test suite                                            │
│ ├─ Parse result: PASS | FAIL                                 │
│ └─ If FAIL → send failure back to coder → retry              │
└────────────────┬─────────────────────────────────────────────┘
                 │ pass
                 ▼
┌──────────────────────────────────────────────────────────────┐
│ REVIEWING (reviewer agent) - Max 2 rejects                   │
│ ├─ Code quality inspection                                   │
│ ├─ Security vulnerability check                              │
│ ├─ Architecture compliance                                   │
│ ├─ Verdict: APPROVE | REJECT                                 │
│ └─ If REJECT → send feedback to coder → fix → retry          │
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
- Test failures automatically loop back to coder (max 3 attempts)
- Code review rejections trigger fixes (max 2 rejects)
- If max retries exceeded → BLOCKED state → human intervention

---

## ✦ The 13 Agents

### Tier 1: Core Workflow (Required)

| Agent | Role | Responsibilities | Tools |
|-------|------|------------------|-------|
| **planner** | Strategic planning | Creates implementation plans, analyzes briefs | Read, Grep, Glob |
| **coder** | Code implementation | Writes clean code following architecture | Read, Write, Edit, Bash |
| **tester** | Test execution | Generates tests, runs test suite, validates | Read, Bash, Grep |
| **reviewer** | Code review | Quality inspection, security checks | Read, Grep, Glob |

### Tier 2: Documentation

| Agent | Role | Responsibilities | Tools |
|-------|------|------------------|-------|
| **documenter** | Documentation | Writes/updates docs, README, code comments | Read, Write, Grep, Glob |
| **releaser** | Release prep | Generates changelog, versions, release notes | Read, Write, Bash, Grep |
| **standardizer** | Standards gen | Generates coding_guidelines.md (4 modes) | Read, Write, Grep, Glob, Bash |

### Tier 3: Maintenance

| Agent | Role | Responsibilities | Tools |
|-------|------|------------------|-------|
| **auditor** | Code analysis | 7 audit operations, creates briefs for findings | Read, Grep, Glob, Bash |
| **debugger** | Error recovery | Diagnoses errors, suggests fixes | Read, Grep, Glob, Bash |
| **migrator** | Migration analysis | Analyzes code vs standards, creates migration briefs | Read, Grep, Glob, Bash |

### Tier 4: Innovation

| Agent | Role | Responsibilities | Tools |
|-------|------|------------------|-------|
| **ideator** | Feature ideation | Brainstorms features, creates FR-XXX briefs | Read, Grep, Glob |
| **explorer** | Codebase research | Investigates and explains codebase | Read, Grep, Glob, Bash |

### Tier 5: Custom (User-Defined)

| Agent | Role | Responsibilities | Tools |
|-------|------|------------------|-------|
| **flutter-mvvm-actions-expert** | Flutter architecture | Kalvad MVVM + Actions Layer patterns, GetX | Read, Write, Edit, Bash, Glob, Grep |

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

### 2. Autonomous Quality Assurance (Auditor Agent)

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

### 3. Architecture Standards Generation (Standardizer Agent)

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

### 4. Migration Analysis (Migrator Agent)

**Analyze entire codebase against standards:**

```bash
"MIGRATE analyze"
```

**The migrator agent will:**
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
│   ├─ Active Agent: planner | coder | tester | reviewer | none
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
| **Quality Control** | Manual | Automated (13 agents, quality gates) |
| **Session Recovery** | None | Automatic (multi-level tracking) |
| **Architecture Enforcement** | No | Yes (coding_guidelines.md) |
| **Brief Management** | No | Yes (9 brief types, priorities) |
| **Testing** | Manual | Automated (tester agent) |
| **Best For** | Quick edits, autocomplete | Full feature development, teams |

### IGRIS vs Aider

| Feature | Aider | IGRIS |
|---------|-------|-------|
| **Approach** | CLI chat for code edits | Multi-agent autonomous system |
| **Focus** | File editing, git integration | End-to-end engineering (plan → test → commit) |
| **Agents** | Single agent | 12 specialized agents |
| **Quality Control** | Commit messages | Briefs, tests, architecture, review agent |
| **Session Tracking** | Git commits only | Multi-level (session, briefs, workflow, agents) |
| **Self-Healing** | No | Yes (test failures loop to coder) |
| **Best For** | Quick fixes, pair programming | Enterprise development, quality focus |

### IGRIS vs GitHub Copilot

| Feature | GitHub Copilot | IGRIS |
|---------|----------------|-------|
| **Approach** | Autocomplete | Multi-agent autonomous workflows |
| **Focus** | Line/function suggestions | Full features with architecture |
| **Planning** | None | planner agent creates plans |
| **Testing** | No | tester agent generates + runs tests |
| **Quality Assurance** | No | reviewer agent + auditor agent |
| **Session Recovery** | None | Full context preservation |
| **Team Workflows** | Limited | Built-in (briefs, priorities, handoffs) |
| **Best For** | Individual coding, boilerplate | Teams, complex features, quality |

### IGRIS vs Plain Claude

| Feature | Plain Claude | IGRIS + Claude |
|---------|--------------|----------------|
| **Context** | Manual prompt loading | Automatic (CLAUDE.md + hooks) |
| **Workflow** | Ad-hoc | Autonomous (HUNT command) |
| **Agents** | Single Claude | 13 specialized subagents |
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

# The migrator agent will:
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
✅ planner     | Implementation planning  | 47 runs
✅ coder       | Code implementation      | 52 runs
✅ tester      | Test execution           | 48 runs
✅ reviewer    | Code review              | 41 runs

Tier 2: Documentation
✅ documenter  | Documentation            | 12 runs
✅ releaser    | Release preparation      | 3 runs
✅ standardizer| Standards generation     | 5 runs

Tier 3: Maintenance
✅ auditor     | Code analysis            | 8 runs
✅ debugger    | Error recovery           | 15 runs
✅ migrator    | Migration analysis       | 2 runs

Tier 4: Innovation
✅ ideator     | Feature ideation         | 2 runs
✅ explorer    | Codebase research        | 23 runs
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
│   ├── agents/                  # 13 native subagents
│   │   ├── manifest.yaml        # Agent registry
│   │   ├── planner.md
│   │   ├── coder.md
│   │   ├── tester.md
│   │   ├── reviewer.md
│   │   ├── documenter.md
│   │   ├── releaser.md
│   │   ├── standardizer.md
│   │   ├── auditor.md
│   │   ├── debugger.md
│   │   ├── migrator.md
│   │   ├── ideator.md
│   │   └── explorer.md
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
A: IGRIS is a multi-agent engineering system that orchestrates Claude Code through 13 specialized subagents. Claude provides intelligence; IGRIS provides process, agents, and discipline.

**Q: Does IGRIS work with Claude.ai (web interface)?**
A: Yes, but with limitations. Startup hooks won't auto-run, and Task tool (subagents) may not be available. Claude Code CLI is recommended.

**Q: How do agents communicate?**
A: Main agent (orchestrator) delegates work to subagents via Task tool. Subagents are stateless — they receive task instructions, do work, return results. Main agent tracks workflow state.

**Q: Can I disable specific agents?**
A: Yes. Edit `.claude/agents/manifest.yaml` or use `DIGIVOLVE disable {agent}` (coming soon).

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
- **Autonomy** — 13 agents working together to ship quality software

**The Open Source Call:**
> *Create boldly. Release openly. Engineer with discipline.*

---

## ✦ License

[MIT License](LICENSE) - Build freely, share openly.

---

## ✦ Acknowledgments

Built for developers and teams using Claude AI to engineer high-quality software with autonomous multi-agent workflows.

---

> **IGRIS — Where Creativity Meets Discipline, Powered by 13 Autonomous Agents.**

```bash
# Ready to engineer?
./scripts/igris_init.sh

# v3.2 Commands:
# HUNT BR-001           - Autonomous implementation
# STANDARDIZE analyze   - Generate coding guidelines
# DOCUMENT architecture - Generate architecture docs
# MIGRATE analyze       - Analyze codebase for migrations
# AUDIT {type}          - Code quality analysis
# DIGIVOLVE status      - List all agents
```

**From Vibe Coding → Vibe Engineering.**
