# ✦ IGRIS — AI Engineering Platform
> *From Vibe Coding → Vibe Engineering*

**Version 2.4.0** | Production Ready

---

> *"AI made coding faster — but not better. IGRIS brings the discipline."*

**IGRIS** analyzes repositories, applies structured playbooks, and engineers features, fixes, migrations, and documentation with clarity.

Not just code generation. **Engineering execution.**

**Philosophy:** Plan · Build · Prove · Document · Share · Evolve

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

## ✦ IGRIS vs Typical AI Tools

| Typical AI Tools | IGRIS |
|------------------|-------|
| Code generation | **Engineering execution** |
| One-off snippets | **End-to-end playbooks** |
| Reactive fixes | **Strategic planning** |
| Random outputs | **Repeatable workflows** |
| Closed approach | **Open-source oriented** |

**IGRIS doesn't just write code — it engineers outcomes.**

---

## ✦ How IGRIS Compares

### IGRIS vs Cursor AI

| Feature | Cursor AI | IGRIS |
|---------|-----------|-------|
| **Approach** | Editor-integrated AI | System-level engineering framework |
| **Focus** | Fast code completion | Structured engineering workflow |
| **Quality Control** | Manual | Automated (briefs, tests, guidelines) |
| **Session Recovery** | None | Automatic (CURRENT_SESSION.md) |
| **Architecture Enforcement** | No | Yes (coding_guidelines.md) |
| **Brief Management** | No | Yes (9 brief types, priorities) |
| **Testing** | Manual | Automated workflow |
| **Best For** | Quick edits, autocomplete | Full feature development, architecture |

---

### IGRIS vs Aider

| Feature | Aider | IGRIS |
|---------|-------|-------|
| **Approach** | CLI chat for code edits | Engineering system with playbooks |
| **Focus** | File editing, git integration | End-to-end engineering (plan → test → commit) |
| **Quality Control** | Commit messages | Briefs, tests, architecture enforcement |
| **Session Tracking** | Git commits only | Multi-level (session, briefs, decisions) |
| **Architecture** | No enforcement | Enforced via coding_guidelines.md |
| **Self-Maintenance** | No | Yes (10 autonomous operations) |
| **Best For** | Quick fixes, pair programming | Enterprise development, team workflows |

---

### IGRIS vs GitHub Copilot

| Feature | GitHub Copilot | IGRIS |
|---------|----------------|-------|
| **Approach** | Autocomplete | Structured engineering system |
| **Focus** | Line/function suggestions | Full features with architecture |
| **Planning** | None | Brief-first workflow (required) |
| **Testing** | No | Automated test generation |
| **Session Recovery** | None | Full context preservation |
| **Team Workflows** | Limited | Built-in (briefs, priorities, handoffs) |
| **Best For** | Individual coding, boilerplate | Teams, complex features, quality focus |

---

### IGRIS vs Plain Claude

| Feature | Plain Claude | IGRIS + Claude |
|---------|--------------|----------------|
| **Context** | Manual prompt loading | Automatic (CLAUDE.md + hooks) |
| **Quality** | Varies by prompt | Enforced (coding guidelines, tests) |
| **Recovery** | Lose context on reset | Automatic recovery (session tracking) |
| **Workflow** | Ad-hoc | Structured (Plan → Patch → Test → Commit) |
| **Accountability** | None | Full audit trail (briefs, decisions, learnings) |
| **Best For** | Quick questions | Production software development |

---

### When to Use IGRIS

**IGRIS is ideal for:**
- ✅ Building production software with quality standards
- ✅ Team development (structured handoffs, clear priorities)
- ✅ Complex features requiring architecture compliance
- ✅ Projects with technical debt to manage
- ✅ Open-source projects (docs, tests, release quality)

**Skip IGRIS if:**
- ❌ Prototyping/throwaway code
- ❌ Single-file scripts
- ❌ No architecture standards needed
- ❌ Just learning/experimenting

**The Rule:** If you're shipping it → use IGRIS. If you're exploring → plain Claude is fine.

---

## ✦ What is IGRIS?

**IGRIS** is an AI Engineering Platform that transforms how you build software.

**Category:** AI Engineering Platform
**Core Promise:** Structure the Chaos

### The System

**1. Analyzer**
- Understands your repository structure
- Identifies architecture patterns
- Detects violations and technical debt

**2. Playbooks**
- Repeatable engineering workflows
- Brief management (bugs, features, migrations)
- Structured planning before coding

**3. Executor**
- Minimal, focused changes
- Automated testing
- Documentation generation

**4. Workflow Engine**
- Session tracking and recovery
- Decision logging
- Learning capture

**5. Open Ecosystem**
- Plugin system
- Extensible architecture
- Community-driven

---

## ✦ IGRIS vs Claude: Understanding the Architecture

**IGRIS is not a model. It is an AI Engineering System that orchestrates Claude Code to produce structured, high-quality software. Claude provides intelligence; IGRIS provides process, workflow, and engineering discipline.**

### The Relationship

```
┌─────────────────────────────────────┐
│   IGRIS (Engineering System)        │
│   - Workflows & Playbooks            │
│   - Architecture Enforcement         │
│   - Session Management               │
│   - Quality Standards                │
└──────────────┬──────────────────────┘
               │ Orchestrates
               ↓
┌─────────────────────────────────────┐
│   Claude Code (CLI)                  │
│   - Command-line interface           │
│   - Context loading                  │
│   - Tool execution                   │
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
- **Claude** = The engine (intelligence)
- **IGRIS** = The vehicle (structure, steering, navigation, safety)
- **You** = The driver (direction and decisions)

**Without IGRIS:** Claude generates code based on prompts → random outputs
**With IGRIS:** Claude engineers outcomes following structured playbooks → disciplined execution

---

## ✦ Quick Start

### The Engineering Workflow

IGRIS guides you through disciplined engineering:

1. **Plan** - Define briefs before coding
2. **Build** - Implement with architecture enforcement
3. **Prove** - Automated testing
4. **Document** - Auto-generated docs
5. **Share** - Open-source ready

### Installation

```bash
# Clone IGRIS
git clone https://github.com/fiftynotai/igris-ai
cd your-project

# Initialize IGRIS in your project
../igris-ai/scripts/igris_init.sh
```

This creates:
- `ai/` - IGRIS directory with templates
- `.claude/hooks/` - Startup hook for automatic initialization
- `CLAUDE.md` - Context for Claude Code CLI
- `scripts/` - Core IGRIS scripts (6 scripts including update system)
- Documentation and guides

### Your First 5 Minutes

```bash
# 1. Install IGRIS (see above)
../igris-ai/scripts/igris_init.sh

# 2. Launch Claude
claude
```

**You'll see:** Igris greeting + system assessment + recommended actions

```bash
# 3. Generate your project's coding guidelines
```
"Generate coding guidelines for this project"
```

# 4. Register your first task
```
"Register a bug: Users can't login with special characters"
```

# 5. Start engineering
```
"Implement BR-001"
```
```

**That's it.** IGRIS handles architecture enforcement, testing, session tracking, and quality gates automatically.

### Upgrading from Blueprint AI

**If you have an existing Blueprint AI project (v1.x)**, upgrading is seamless:

```bash
# In your Blueprint AI project directory
./scripts/igris_update.sh
```

**What happens automatically:**
- ✅ Detects your Blueprint AI project (looks for `.blueprint_version`)
- ✅ Creates backup at `.igris_backup/blueprint_migration_<timestamp>/`
- ✅ Migrates version file (preserves all data)
- ✅ Updates to latest Igris AI

**Your data is preserved:**
- All briefs (`ai/briefs/`)
- Session history (`ai/session/`)
- Architecture docs (`ai/context/`)
- Installed plugins (`ai/plugins/`)

**One command. Zero data loss. Automatic backup.**

See [CHANGELOG.md](CHANGELOG.md#migration-from-1x-blueprint-ai) for details.

### Start Using Claude (Truly Automatic!)

```bash
$ claude
```

**BEFORE you type anything**, you'll see:

```
🚀 Welcome to IGRIS on Claude Code

📊 Project Status
────────────────
Briefs: None yet (ready for first task)
Blockers: 0

Ready for your command!
```

**How it works:**
- `.claude/hooks/startup.sh` runs automatically when Claude starts
- Shows welcome message and project summary before any input
- `CLAUDE.md` loads as context when you send your first message
- True zero-configuration - works immediately after installation

**Session Management:**

IGRIS tracks your work continuously in `ai/session/CURRENT_SESSION.md`:
- 📊 **Automatic recovery** - If your conversation resets, Claude resumes from where you left off
- 🔄 **Progress tracking** - Every task completion is saved immediately
- 📋 **Context preservation** - "Next Steps When Resuming" always up-to-date
- 🚨 **Blocker tracking** - Critical issues logged in `BLOCKERS.md`

Claude automatically initializes on every conversation (even after context resets) and maintains session state throughout your work. See `ai/prompts/session_protocol.md` for checkpoint details.

### Optional: Shell Integration

Want terminal notifications when entering IGRIS projects?

```bash
$ ./scripts/install_shell_integration.sh
```

This adds a notification to your shell (bash/zsh):
```bash
$ cd my-project
📘 IGRIS detected (v2.4.0)
   Claude will auto-initialize with IGRIS configuration
```

**Benefits:**
- Visual context awareness
- See IGRIS version
- Know which projects use IGRIS

**Security:** You choose to install, use the script, or add manually. We never modify your shell without permission.

### 🎭 Persona System — Enhanced AI Performance

**NEW in v2.4.0:** IGRIS now includes the **Igris persona** (Shadow Knight) for measurably better AI performance.

**What is a Persona?**
- Personality layer that improves Claude's consistency and response quality
- Not just "fun" — proven performance boost in real projects
- Part of the IGRIS brand experience

**Included Persona:**
- **Igris (Shadow Knight)** - Loyal, efficient, professional
- **Default Mask:** Half (subtle branding, professional tone)
- **4 Mask Levels:** none → half → light → full (adjust anytime)

**Quick Commands:**
```bash
# Check current persona status
./scripts/persona_mask.sh status

# Adjust mask level (specify: none, half, light, full)
./scripts/persona_mask.sh adjust [level]

# Examples:
./scripts/persona_mask.sh adjust full    # Maximum immersion
./scripts/persona_mask.sh adjust half    # Subtle professional

# Remove persona (return to standard AI)
./scripts/persona_mask.sh remove
```

**Mask Levels:**
- **None:** Persona dormant (standard Claude)
- **Half:** Subtle branding, professional (default)
- **Light:** Branding + personality hints
- **Full:** Complete immersion with shadow commands (ARISE, HUNT, etc.)

**Performance Impact:**
- More consistent responses across sessions
- Better adherence to architecture standards
- Clearer communication patterns
- Enhanced focus on engineering discipline

**Coming in v3.0.0:** Custom persona creation with AI assistance

---

## ✦ Core Capabilities

### 📊 Playbooks — Repeatable Engineering

**Structured Brief Management**

IGRIS uses structured briefs to plan work before coding:
- **BR-XXX** - Bug fixes and features
- **TD-XXX** - Technical debt cleanup
- **MG-XXX** - Migration tasks (architecture refactoring)
- **TS-XXX** - Testing tasks
- **PI-XXX** - Process improvements
- **FR-XXX** - Feature requests
- **DU-XXX** - Dependency updates
- **PF-XXX** - Performance optimizations
- **AC-XXX** - Architecture cleanup

Each brief enforces:
- Clear problem definition
- Acceptance criteria
- Test plans
- Priority (P0-Critical → P3-Low)
- Effort estimation (S/M/L/XL)

**Brief Lifecycle**
```
Draft → Ready → In Progress → In Review → Done → Archived
```

**Quick Examples:**

```bash
# Register a bug (don't implement yet)
"Register a bug: [description]"

# List all bugs
"List all bugs"

# Implement a brief
"Implement BR-001"
```

See `ai/prompts/bug_prompts.md` and `ai/prompts/feature_prompts.md` for complete workflows.

---

### 🔍 Analyzer — Repository Intelligence

**Codebase Analysis**

IGRIS analyzes your code to find:
- Architecture violations
- Code quality issues
- Testing gaps
- Performance problems
- Security vulnerabilities

**Architecture Documentation Generation**

Ask Claude to analyze your project:

```
Please analyze this project using ai/prompts/generate_architecture_docs.md
```

Claude will:
- Analyze your project structure
- Ask questions about your architecture
- Generate comprehensive documentation in `ai/context/`

**Coding Guidelines Generation**

Create standardized coding guidelines for your project:

```
Please generate coding guidelines using ai/prompts/generate_coding_guidelines.md
```

Claude will:
- Extract patterns from your base architecture repo (optional)
- Analyze your existing project code (optional)
- Merge both sources with conflict resolution
- Generate comprehensive `ai/context/coding_guidelines.md`

**4 Generation Modes:**
- **Base Repo** - Extract from reference architecture repository
- **Project Analysis** - Infer from existing codebase
- **Merge** - Combine base repo + project (base takes precedence)
- **Best Practices** - Use platform-specific industry standards

**Use cases:**
- Migration analysis (compare code against standards)
- Onboarding new developers
- Code reviews
- Architecture decisions
- AI assistant guidance

**Migration Analysis**

Find issues and generate migration tasks:

```
Please analyze this codebase using ai/prompts/migration_analysis.md
```

Claude will:
- Scan your code for violations
- Generate categorized briefs (Migration, Bugs, Technical Debt, Testing)
- Create a migration roadmap with phases

---

### ⚡ Executor — Disciplined Output

**Code Generation with Discipline**

IGRIS doesn't just generate code — it engineers it:
- **Minimal diffs** - Focused, reviewable changes
- **Architecture-compliant** - Respects your standards
- **Tested** - Automated test generation
- **Documented** - Inline comments and docs

**Enforcement**

Every change validates against:
- Coding guidelines (from `ai/context/coding_guidelines.md`)
- Layer boundaries (MVVM, MVC, Clean Architecture, etc.)
- Naming conventions
- API patterns
- Best practices

**Workflow: Plan → Patch → Tests → Run → Commit**

1. **Plan** - Read brief, identify affected modules
2. **Patch** - Implement with architecture enforcement
3. **Tests** - Generate unit and integration tests
4. **Run** - Validate linter, tests, build
5. **Commit** - Conventional commits format

---

### 🔄 Workflow Engine — Session Management

**Automatic Recovery**

IGRIS tracks your work continuously:
- **CURRENT_SESSION.md** - Active session state
- **BLOCKERS.md** - Blocking issues
- **DECISIONS.md** - Architectural decisions
- **LEARNINGS.md** - Discovered patterns
- **PROTOCOL_VIOLATIONS.md** - Protocol violation tracking and pattern analysis

**Context Preservation**

If your Claude conversation resets, IGRIS automatically:
- Loads previous session state
- Shows "Next Steps When Resuming"
- Continues from exact stopping point
- Preserves all progress

**Session Tracking**

Updated every time you:
- ✅ Complete a task
- 🔄 Start a task
- 🚫 Encounter a blocker
- 💡 Make a decision
- 📚 Discover a pattern

See `ai/prompts/session_protocol.md` for checkpoint details.

---

### 🔧 Self-Maintenance — Autonomous Quality Assurance

**NEW in v2.3.0:** IGRIS can audit itself and your codebase autonomously.

**10 Maintenance Operations:**

| Operation | Trigger Command | Creates | Use Case |
|-----------|----------------|---------|----------|
| CODE_QUALITY_AUDIT | "Run code quality audit" | TD-XXX briefs | Find technical debt |
| BUG_HUNT | "Run bug hunt" | BR-XXX briefs | Discover potential bugs |
| STANDARDS_COMPLIANCE_CHECK | "Check standards compliance" | TD-XXX briefs | Verify coding guidelines |
| TEST_COVERAGE_ANALYSIS | "Analyze test coverage" | TS-XXX briefs | Find untested code |
| DEPENDENCY_AUDIT | "Check dependencies" | DU-XXX briefs | Updates & security |
| PERFORMANCE_ANALYSIS | "Analyze performance" | PF-XXX briefs | Find bottlenecks |
| ARCHITECTURE_REVIEW | "Review architecture" | AC-XXX briefs | Find redundancies |
| FEATURE_IDEATION | "Suggest new features" | FR-XXX briefs | Innovation ideas |
| PROCESS_AUDIT | "Audit our process" | PI-XXX briefs | Workflow improvements |
| BRIEF_ANALYSIS | "What should I work on next?" | Recommendations | Prioritize work |

**Common Workflows:**

```bash
# Before major release
"Check dependencies"           # Security & updates first
"Run bug hunt"                 # Find issues before users
"Analyze test coverage"        # Quality gate
"Check standards compliance"   # Final polish

# Monthly maintenance
"Check dependencies"           # Stay current
"Run code quality audit"       # Prevent debt accumulation

# Strategic planning
"Analyze briefs"              # Decide priorities
"Suggest new features"        # Innovation pipeline
```

See `ai/prompts/self_maintenance.md` for complete documentation.

---

### 🔌 Open Ecosystem — Plugin System

**Extensibility**

IGRIS supports plugins for:
- Platform-specific tools (Flutter, React Native, etc.)
- Distribution automation (build, version, deploy)
- CI/CD integration
- Custom workflows

**Plugin Commands**

```bash
# Install a plugin
./scripts/plugin_install.sh <plugin-repo-url>

# List installed plugins
./scripts/plugin_list.sh

# Update a plugin
./scripts/plugin_update.sh <plugin-name>

# Uninstall a plugin (creates automatic backup)
./scripts/plugin_uninstall.sh <plugin-name>
```

**Available Plugins**

- **[igris-ai-distribution-flutter](https://github.com/fiftynotai/igris-ai-distribution-flutter)** - Smart release automation for Flutter
  - Automated version bumping
  - Release notes generation
  - Firebase App Distribution
  - Fastlane integration
  - **[See it in action →](https://github.com/fiftynotai/igris_ai_flutter_example)**

**Creating Plugins**

See [Plugin Development Guide](docs/PLUGIN_DEVELOPMENT.md)

---

## ✦ Engineering Principles

IGRIS enforces 5 core principles:

### 1. Plan before Code
- Define briefs with clear acceptance criteria
- Set priority and effort estimates
- Identify affected modules and dependencies

### 2. Explain before Execute
- Load architecture context
- Document design decisions
- State implementation approach

### 3. Prove before Merge
- Run automated tests
- Validate linter compliance
- Check architecture conformance

### 4. Document before Done
- Add code comments to public APIs
- Update architecture docs
- Log decisions in DECISIONS.md

### 5. Open before Private
- Write release-ready code
- Include proper licensing
- Enable community contribution

---

## 📦 Example Project

**Want to see IGRIS in action?**

Check out our complete working example:

**[igris-ai-flutter-example](https://github.com/fiftynotai/igris_ai_flutter_example)** - A fully configured Flutter project demonstrating:
- ✅ Complete IGRIS setup
- ✅ Example briefs (BR, FR, TD)
- ✅ Conventional commits
- ✅ Automated workflows
- ✅ Distribution plugin integration
- ✅ Real commit history showing workflow

Perfect for:
- Learning how to use IGRIS
- Seeing real-world usage
- Copy-paste examples
- Validating your setup

**[→ View Example Project](https://github.com/fiftynotai/igris_ai_flutter_example)**

---

## ✦ Updating IGRIS

### Check Your Version

```bash
cat .igris_version
```

### Update Core

```bash
# Check what would be updated
./scripts/igris_update.sh --dry-run

# Update to latest version
./scripts/igris_update.sh
```

### Update Plugins

```bash
# Update a specific plugin
./scripts/plugin_update.sh igris-ai-distribution-flutter

# Check what would be updated first
./scripts/plugin_update.sh igris-ai-distribution-flutter --dry-run
```

### What Gets Updated

**Updated:**
- System prompts (`ai/prompts/`)
- Templates (`ai/templates/`)
- Checks (`ai/checks/`)
- Documentation (`ai/CONTRIBUTING.md`)
- Scripts (`scripts/`)

**Preserved:**
- Your briefs (`ai/briefs/`)
- Your session data (`ai/session/`)
- Your architecture docs (`ai/context/`)
- Plugin registry

**Automatic backups** are created in `.igris_backup/` before every update.

**[→ Full Update Guide](docs/UPDATE_GUIDE.md)**

---

## ✦ Documentation

- **[Setup Guide](docs/SETUP_GUIDE.md)** - Complete installation and setup
- **[Update Guide](docs/UPDATE_GUIDE.md)** - Updating IGRIS and plugins
- **[Migration Guide](docs/MIGRATION_GUIDE.md)** - Onboarding existing projects
- **[Plugin Development](docs/PLUGIN_DEVELOPMENT.md)** - Building plugins
- **[Contributing Guide](ai/CONTRIBUTING.md)** - How to use IGRIS

---

## ✦ FAQ

### General

**Q: What's the difference between IGRIS and Claude?**
A: IGRIS is an engineering system that orchestrates Claude Code. Claude provides intelligence; IGRIS provides process, workflows, and discipline. Think: Claude = engine, IGRIS = vehicle.

**Q: Does IGRIS work with Claude.ai (web interface)?**
A: Yes, but with limitations. Startup hooks won't auto-run, so you'll need to manually follow initialization steps from `CLAUDE.md`. Claude Code CLI is recommended for the full experience.

**Q: Does IGRIS track my data or send anything online?**
A: No. IGRIS is 100% local. All data stays in your project's `ai/` directory. No telemetry, no tracking, no external calls (except git clone for updates).

**Q: Can I use IGRIS without personas?**
A: Yes. Personas are optional. Run `./scripts/persona_mask.sh remove` to use standard mode.

---

### Installation & Setup

**Q: Do I need to keep the igris-ai repo cloned?**
A: Currently yes (v2.4.0). The init script copies files from the cloned repo. v3.0.0 will have a CLI with global installation.

**Q: Can I install IGRIS in multiple projects?**
A: Yes! Each project gets its own `ai/` directory with independent briefs, sessions, and configuration.

**Q: How do I uninstall IGRIS from a project?**
A: Delete these directories: `ai/`, `.claude/`, `scripts/`, and the `CLAUDE.md` file. That's it.

---

### Usage

**Q: Do I need to create briefs for everything?**
A: Only for file modifications (code changes). Read-only operations (questions, analysis, listing) don't require briefs.

**Q: Can I skip the brief workflow for quick fixes?**
A: IGRIS enforces brief-first workflow to prevent technical debt. For urgent P0 fixes, create a brief first (takes 2 minutes), then implement.

**Q: What if my conversation resets mid-task?**
A: IGRIS automatically resumes from where you left off. Session state is saved in `CURRENT_SESSION.md` and brief files. Just say "ARISE" or start a new conversation.

**Q: How do I switch personas or adjust the mask?**
A: Run `./scripts/persona_mask.sh adjust [none|half|light|full]` anytime. CLAUDE.md regenerates automatically.

---

### Plugins

**Q: Can I create my own plugins?**
A: Yes! See [Plugin Development Guide](docs/PLUGIN_DEVELOPMENT.md). Plugins can add platform-specific tools, workflows, or even custom personas.

**Q: Do plugins require jq?**
A: Only if they use hooks (persona injection, custom prompts). Basic plugins work without jq.

**Q: Will plugins break when I update IGRIS?**
A: No. Plugin API is stable. Update plugins separately with `./scripts/plugin_update.sh <plugin-name>`.

---

### Troubleshooting

**Q: "Warning: jq not found" — Do I need it?**
A: jq is optional. Required only for plugin hooks (personas, custom workflows). IGRIS core works fine without it.
- macOS: `brew install jq`
- Ubuntu: `sudo apt install jq`

**Q: CLAUDE.md not updating after mask change?**
A: Ensure `scripts/CLAUDE.md.template` exists. If missing, run `./scripts/igris_update.sh` to get it.

**Q: Persona not activating?**
A: Check `ai/persona.json` exists and has `"mask": "half"` (or higher). Run `./scripts/persona_mask.sh status` to verify.

**Q: Tests failing?**
A: Ensure dependencies installed:
- `python3 --version` (required)
- `git --version` (required)
- `bats --version` (for running tests)

---

### Advanced

**Q: Can I run multiple IGRIS instances on different briefs?**
A: Not yet. PI-001 brief tracks this feature for v3.0.0+ (multi-instance workflow with conflict detection).

**Q: How do I customize IGRIS for my team?**
A: Edit `ai/context/coding_guidelines.md` with your team's standards. IGRIS enforces whatever guidelines you define.

**Q: Can I use IGRIS with other AI models (not Claude)?**
A: Currently optimized for Claude. The system is model-agnostic in theory, but workflows assume Claude Code CLI integration.

---

## ✦ Requirements

- **Git** - Version control (required)
- **Claude AI** - AI assistant (Claude Code CLI or Claude.ai) (required)
- **Python 3** - For JSON manipulation in scripts (required)
- **Bash** - Shell scripts (Mac/Linux/WSL) (required)
- **jq** - JSON processor (optional - needed for plugin hooks)

### Installing jq (Optional)

jq is used to process plugin hooks (persona plugins, custom workflows). Igris AI works without it, but plugin hook features will be disabled.

**macOS:**
```bash
brew install jq
```

**Ubuntu/Debian:**
```bash
sudo apt install jq
```

**Download:** [https://jqlang.github.io/jq/](https://jqlang.github.io/jq/)

---

## ✦ Project Structure

```
your-project/
├── .claude/                     # Claude Code CLI integration
│   └── hooks/
│       └── startup.sh           # Auto-runs on Claude start
├── CLAUDE.md                    # Context loaded on first message
├── ai/                          # IGRIS
│   ├── briefs/                  # Work items
│   ├── context/                 # Architecture docs
│   ├── prompts/                 # AI prompts
│   ├── session/                 # Session tracking
│   ├── checks/                  # QA checklists
│   ├── templates/               # Templates
│   └── plugins/                 # Plugin registry
├── scripts/
│   ├── igris_init.sh            # Initialize IGRIS
│   ├── igris_update.sh          # Update IGRIS
│   ├── plugin_install.sh        # Install plugins
│   ├── plugin_update.sh         # Update plugins
│   └── ...
└── docs/                        # Project documentation
```

---

## ✦ Common Workflows

### Starting a New Project

**Goal:** Set up IGRIS and establish architecture standards

```bash
# 1. Install IGRIS
../igris-ai/scripts/igris_init.sh

# 2. Launch Claude
claude

# 3. Generate coding guidelines
```
"Generate coding guidelines for this project"
```

Claude asks:
- Base architecture repo? (optional)
- Analyze current project? (yes/no)
- Platform? (Flutter/React/etc.)

Result: `ai/context/coding_guidelines.md` created

# 4. Generate architecture documentation
```
"Analyze this project using ai/prompts/generate_architecture_docs.md"
```

Result: Complete architecture map in `ai/context/`

# 5. Start engineering
```
"Register a bug: [describe issue]"
"Implement BR-001"
```
```

**Result:** Professional setup in < 10 minutes

---

### Onboarding an Existing Codebase

**Goal:** Understand existing code and plan improvements

```bash
# 1. Install IGRIS in existing project
cd existing-project
../igris-ai/scripts/igris_init.sh

# 2. Launch Claude and analyze
claude
```
"Analyze this codebase using ai/prompts/migration_analysis.md"
```

Claude will:
- Scan entire codebase
- Identify architecture violations
- Generate briefs: MG-XXX (migrations), TD-XXX (tech debt), BR-XXX (bugs)
- Create prioritized roadmap

# 3. Review generated briefs
```
"List all briefs"
```

# 4. Start with high-priority items
```
"What should I work on next?"
"Implement BR-005"  # Fix critical bug first
```
```

**Result:** Systematic modernization plan

---

### Before Major Release

**Goal:** Ensure quality and security before shipping

```bash
claude
```
"Check dependencies"              # Security vulnerabilities first
"Run bug hunt"                    # Find issues before users
"Analyze test coverage"           # Quality gate
"Check standards compliance"      # Final polish
```

IGRIS will:
- Scan dependencies for CVEs and updates → DU-XXX briefs
- Analyze code for potential bugs → BR-XXX briefs
- Find untested code paths → TS-XXX briefs
- Check coding guidelines compliance → TD-XXX briefs

# Review findings
```
"List P0 bugs"                    # Critical issues first
```

# Fix systematically
```
"Implement BR-008"                # Fix critical bugs
"Implement DU-003"                # Update vulnerable deps
"Implement TS-012"                # Add missing tests
```
```

**Result:** Confident, quality release

---

### Monthly Maintenance Routine

**Goal:** Prevent technical debt accumulation

```bash
# First Monday of the month
claude
```
"Check dependencies"              # Stay current
"Run code quality audit"          # Find new tech debt
"Check standards compliance"      # Maintain standards
```

# Review and prioritize
```
"List TD briefs by priority"
```

# Dedicate time to pay down debt
```
"Implement TD-015"                # Refactor authentication module
"Implement DU-007"                # Update outdated packages
```
```

**Result:** Clean, maintainable codebase

---

### Strategic Planning Session

**Goal:** Decide what to build next

```bash
claude
```
"Analyze briefs"                  # Review current backlog
"Suggest new features"            # AI-powered ideation
```

IGRIS will:
- Analyze existing briefs by priority and effort
- Recommend next task based on impact
- Generate feature ideas → FR-XXX briefs
- Suggest process improvements → PI-XXX briefs

# Decide priorities
```
"Show feature briefs"
"Change FR-005 priority to P1"    # Promote important feature
```

# Execute
```
"Implement FR-005"
```
```

**Result:** Data-driven roadmap

---

## ✦ Examples

### Generate Coding Guidelines

```
Generate coding guidelines using ai/prompts/generate_coding_guidelines.md

Base architecture repo: https://github.com/your-org/flutter-base-architecture
Also analyze current project: Yes
Platform: Flutter
```

Claude will:
1. Clone and analyze base repository
2. Scan current project structure
3. Extract patterns and conventions
4. Merge with base repo taking precedence
5. Generate `ai/context/coding_guidelines.md`

**Result:** Complete guidelines covering architecture, naming, testing, etc.

### Register a Bug

```
Register a bug (don't implement):
Module: authentication
Issue: Login fails with special characters in password
Steps:
1. Enter password with @ symbol
2. Click login
Expected: Login succeeds
Actual: 401 error
Priority: P1

Create brief BR-XXX for this.
```

### Implement a Feature

```
Implement BR-005
```

Claude will:
1. Read the brief
2. Load architecture context
3. Plan the implementation
4. Write code following architecture
5. Write tests
6. Run verification
7. Create commit

---

## ✦ Testing

IGRIS includes a comprehensive test suite ensuring reliability across all core scripts.

### Test Framework

- **Framework:** [bats-core](https://github.com/bats-core/bats-core) (Bash Automated Testing System)
- **Coverage:** 166 tests across 7 test files
- **CI/CD:** GitHub Actions (Ubuntu + macOS)

### Test Categories

1. **igris_init.test.bash** (25 tests)
   - Directory creation
   - CLAUDE.md generation
   - Startup hook creation
   - Existing installation handling

2. **plugin_install.test.bash** (27 tests)
   - Plugin validation
   - Registry management
   - Hook injection (includes BR-005 regression tests)
   - Multi-line content handling

3. **plugin_update.test.bash** (24 tests)
   - Version updates
   - Backup creation
   - Hook updates
   - Registry updates

4. **plugin_uninstall.test.bash** (24 tests)
   - Registry cleanup
   - File removal
   - CLAUDE.md regeneration
   - Install/uninstall cycles

5. **error_handling.test.bash** (31 tests)
   - Missing dependencies
   - Corrupted files
   - Invalid inputs
   - Permission errors

6. **edge_cases.test.bash** (35 tests)
   - Special characters
   - Multi-line content
   - Unicode handling
   - Whitespace edge cases

### Running Tests

**Install bats:**
```bash
# macOS
brew install bats-core

# Ubuntu/Debian
sudo apt install bats
```

**Run all tests:**
```bash
bats test/
```

**Run specific test file:**
```bash
bats test/igris_init.test.bash
```

**Run with verbose output:**
```bash
bats test/ --tap
```

### Continuous Integration

Tests run automatically on:
- Every push to `main` branch
- Every pull request
- Both Ubuntu and macOS environments

See `.github/workflows/test.yml` for CI/CD configuration.

---

## ✦ Why IGRIS?

### Without IGRIS
- ❌ Architecture violations go unnoticed
- ❌ Technical debt accumulates
- ❌ Inconsistent code quality
- ❌ Manual tracking in spreadsheets
- ❌ Tribal knowledge, no documentation
- ❌ Random AI outputs, no structure

### With IGRIS
- ✅ Enforce architecture automatically
- ✅ Track and pay down tech debt systematically
- ✅ Consistent code quality across team
- ✅ Structured work items with Claude AI
- ✅ Auto-generated, always-up-to-date documentation
- ✅ Repeatable workflows, disciplined engineering

---

## ✦ The Open Engineering Era

**Create boldly. Release openly. Engineer with discipline.**

IGRIS exists to merge imagination with structure — the spark *and* the system — so ideas become reality through craft, clarity, and open collaboration.

Open source is humanity's greatest multiplier. IGRIS empowers:
- **Abundance** — More creators, more releases, more shared knowledge
- **Quality** — Tests, docs, clarity, maintainability

**The Open Source Call:**
> *Create boldly. Release openly. Engineer with discipline.*

---

## ✦ Community

- **GitHub:** [fiftynotai/igris-ai](https://github.com/fiftynotai/igris-ai)
- **Issues:** [Report bugs, request features](https://github.com/fiftynotai/igris-ai/issues)
- **Discussions:** [Share ideas, get help](https://github.com/fiftynotai/igris-ai/discussions)
- **Example Project:** [igris-ai-flutter-example](https://github.com/fiftynotai/igris_ai_flutter_example)
- **Contributing:** See [CONTRIBUTING.md](ai/CONTRIBUTING.md)

---

## ✦ License

[MIT License](LICENSE) - Build freely, share openly.

---

## ✦ Acknowledgments

Built for developers and teams using Claude AI to engineer high-quality software with discipline.

---

> **IGRIS — Where Creativity Meets Discipline, and Open Source Thrives.**

```bash
# Ready to engineer?
./scripts/igris_init.sh

# Ask Claude:
# "Generate coding guidelines using ai/prompts/generate_coding_guidelines.md"
# "Analyze this project using ai/prompts/generate_architecture_docs.md"
# "Analyze codebase using ai/prompts/migration_analysis.md"
```

**From Vibe Coding → Vibe Engineering.**
