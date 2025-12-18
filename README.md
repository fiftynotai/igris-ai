# ✦ IGRIS — AI Engineering Platform
> *From Vibe Coding → Vibe Engineering*

**Version 3.2.0** | Production Ready

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
- `.claude/agents/` - 12 native subagents for autonomous workflows
- `CLAUDE.md` - Context for Claude Code CLI
- `scripts/` - Core IGRIS scripts (6 scripts including update system)
- Documentation and guides

**MCP Server Setup (Optional):**

During initialization, if Node.js 20+ is detected, you'll be prompted to:
1. Build the MCP server for enhanced tool integration
2. Configure Claude Code to use the MCP server

This is optional — IGRIS works fully without MCP. MCP adds shortcut tools for brief management, session tracking, and git operations.

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
📘 IGRIS detected (v3.2.0)
   IGRIS will auto-initialize on first message
```

**Benefits:**
- Visual context awareness
- See IGRIS version
- Know which projects use IGRIS

**Security:** You choose to install, use the script, or add manually. We never modify your shell without permission.

### 🎭 Persona System — Enhanced AI Performance

IGRIS includes the **Igris persona** (Shadow Knight) for measurably better AI performance.

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

See `ai/prompts/igris_os.md` for complete brief management workflows.

---

### 🔍 Analyzer — Repository Intelligence

**Codebase Analysis**

IGRIS analyzes your code to find:
- Architecture violations
- Code quality issues
- Testing gaps
- Performance problems
- Security vulnerabilities

**Architecture Documentation Generation (v3.2)**

Use the **documenter** agent to analyze your project:

```
DOCUMENT architecture
```

Or ask naturally:
```
"Generate architecture documentation for this project"
```

The documenter agent will:
- Analyze your project structure
- Ask questions about your architecture
- Generate comprehensive documentation in `ai/context/`

**Coding Guidelines Generation (v3.2)**

Use the **standardizer** agent to create coding guidelines:

```
STANDARDIZE analyze
```

**4 Generation Modes:**
- `STANDARDIZE analyze` - Infer from existing codebase
- `STANDARDIZE from-base` - Extract from reference architecture repository
- `STANDARDIZE hybrid` - Combine base repo + project (base takes precedence)
- `STANDARDIZE minimal` - Use platform-specific industry standards

The standardizer agent will generate comprehensive `ai/context/coding_guidelines.md`

**Use cases:**
- Migration analysis (compare code against standards)
- Onboarding new developers
- Code reviews
- Architecture decisions
- AI assistant guidance

**Migration Analysis (v3.2)**

Use the **migrator** agent to find issues and generate migration tasks:

```
MIGRATE analyze
```

The migrator agent will:
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

IGRIS can audit itself and your codebase autonomously.

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

See `ai/prompts/igris_os.md` for complete Self-Maintenance Operations documentation.

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

## ✦ Working with IGRIS — Best Practices

### Clear Communication = Best Results

IGRIS works perfectly with clear, structured communication. The system is reliable — but AI interpretation varies with prompt quality.

**Best Practices:**

**1. Be Explicit About Your Intent**
```bash
✅ GOOD: "Register a bug: Login fails with special characters in password"
❌ VAGUE: "Fix the login thing"

✅ GOOD: "Implement BR-005"
❌ UNCLEAR: "Do that authentication task we talked about"
```

**2. Work in Focused Sessions**
```bash
# Small, focused sessions work best
✅ One brief per session (BR-005 → implement → commit → done)
✅ Clear session boundaries (ARISE → work → RETREAT)
❌ Multiple briefs in one long conversation (context degrades)
```

**3. Reset After Big Briefs**
```bash
# After completing a major brief:
1. Verify brief marked "Done"
2. Commit all changes
3. Start fresh conversation
4. Say "ARISE" to reinitialize

# Why: Fresh context = better performance
```

**4. Monitor and Correct**
```bash
# If IGRIS bypasses protocol:
"Igris, you violated the protocol by modifying files without a brief.
Record this violation in PROTOCOL_VIOLATIONS.md and create the missing brief."

# IGRIS will:
- Self-document the violation
- Analyze what went wrong
- Create the brief retroactively
- Suggest process improvements
```

---

### When Violations Happen

**Common violation scenarios:**

**Scenario 1: Time Pressure**
```
User: "Quick fix, no brief needed, we're shipping in 30 min"
IGRIS: *Modifies files directly*

✅ Fix: "Create brief BR-XXX first (takes 2 min), mark P0-Critical, then implement"
```

**Scenario 2: Vague Instructions**
```
User: "Make it better"
IGRIS: *Guesses what 'better' means, modifies random files*

✅ Fix: "Describe specific improvement → IGRIS asks clarifying questions → Brief created → Implementation"
```

**Scenario 3: Exploration Mode — Learning IGRIS**
```
User: "Let's try different ways to communicate and see what works best"
User: *Tests various prompt styles, monitors IGRIS behavior*

✅ This is ENCOURAGED! Every user has a different communication style.

Experiment with:
- Formal vs casual language
- Detailed vs brief instructions
- Step-by-step vs high-level goals
- Questions vs commands

Monitor IGRIS responses:
- Does it ask clarifying questions? (prompt was unclear)
- Does it create briefs proactively? (good)
- Does it bypass protocols? (prompt was too permissive)
- Does it follow your intent accurately? (communication aligned)

Find your communication style that gets the best results.

Once you find what works:
- Use those prompt patterns consistently
- Share with your team (standardize communication)
- Document in project README if helpful
```

**The Rule:**
- **Exploring IGRIS?** Experiment with prompts, find your style
- **Shipping code?** Use clear prompts, follow structure

---

### Recording Protocol Violations

**You don't need to manually edit files.** Just tell IGRIS:

```bash
"Igris, you violated the protocol. Record the violation."

"You modified files without a brief. Document this in PROTOCOL_VIOLATIONS.md and create the missing brief."
```

IGRIS will:
1. Analyze what happened
2. Record violation in `ai/session/PROTOCOL_VIOLATIONS.md`
3. Identify root cause (time pressure? vague prompt? bug?)
4. Suggest prevention strategy
5. Create brief if needed

**Self-improvement loop:**
```
Violation → Record → Pattern Analysis → Process Improvement (PI-XXX) → Protocol Update
```

---

### Why the Brief System Matters

**Briefs aren't bureaucracy — they're memory, accountability, and intelligence.**

**What Briefs Enable:**

**1. Track What Was Done**
```
"List all briefs we completed this month"
"Show me P0 bugs we fixed"
"What did we accomplish this week?"
```

**Result:** Complete audit trail of your work

**2. Understand Past Decisions**
```
"We did a feature about user authentication — which brief was that?"

"Check briefs and tell me: why did we implement BR-015 before BR-012?"
```

IGRIS finds the brief, shows:
- Problem definition
- Architecture decisions made
- Why it was prioritized
- What was tested
- Complete implementation context

**3. Generate Reports**
```
"Create a summary report of our work this week"

"Analyze completed briefs and show what we accomplished this sprint"

"Generate a status report for the team: what's done, what's in progress, what's blocked"
```

IGRIS will:
- Read all completed briefs from date range
- Categorize by type (bugs, features, tech debt)
- Show metrics (velocity, priority distribution, effort)
- Highlight accomplishments and blockers
- Format as professional report

**4. Onboard New Developers**
```
"Show me all briefs related to the authentication module"

"What technical debt exists in the payment system?"

"Give me a summary of all architecture decisions in MG-XXX briefs"
```

New developer gets:
- Complete context on past work
- Understanding of current issues
- Prioritized task list
- Architecture evolution history

**5. Plan Future Work**
```
"Analyze briefs and recommend what to work on next"

"Show P1 bugs that are blocking features"

"What should we prioritize this sprint based on brief analysis?"
```

IGRIS provides data-driven recommendations based on:
- Priority levels
- Effort estimates
- Dependencies between briefs
- Current blockers

**Without briefs:** "What did I do last week?" → Can't remember
**With briefs:** "Show last week's work" → Instant detailed report

---

### The Sweet Spot

**IGRIS works best when you:**
- ✅ Use clear, explicit prompts
- ✅ Work in small, focused sessions (1-2 briefs)
- ✅ Create briefs for all shipped code
- ✅ Monitor and correct violations when they happen
- ✅ Reset context after completing major briefs
- ✅ Experiment to find your communication style

**IGRIS works okay when you:**
- ⚠️ Use vague prompts (IGRIS asks clarifying questions, takes longer)
- ⚠️ Long sessions (context degrades, but session tracking helps recovery)
- ⚠️ Exploration without briefs (fine for prototyping, create brief when shipping)

**IGRIS struggles when you:**
- ❌ Constantly bypass protocols ("skip the brief, just do it" repeatedly)
- ❌ Never reset context (200+ message conversations lose coherence)
- ❌ Ignore violation warnings (patterns repeat)

**The Truth:**
IGRIS amplifies discipline. Clear communication + structure = exceptional results. Vague prompts + protocol resistance = standard AI chaos.

**You control the outcome.**

---

### You Drive, IGRIS Assists

**The biggest problem with "vibe coding":** People rely on AI too much and lose control.

**The difference between vibe coding and vibe engineering:**
- **Vibe Coding:** AI in charge → "Just build me a login feature" → Hope it works
- **Vibe Engineering:** You in charge → "Register BR-015, analyze requirements, propose architecture" → You decide, AI executes

**IGRIS enforces the correct relationship:**

**User-Driven Workflow Examples:**

**Example 1: Discovering Blockers**
```
# You're implementing BR-012 (frontend feature)
# You discover a backend API issue

"Igris, we're blocked on BR-012. The /api/users endpoint returns
500 error instead of user data. Record this in BLOCKERS.md and note
it in the BR-012 brief. We need backend team to fix this first."

IGRIS will:
- Add blocker to BLOCKERS.md
- Update BR-012 brief with blocker info
- Update session state
- Ask if you want to create a new brief for backend team

# Later, backend fixes the issue
"Igris, BR-012 blocker resolved. Backend team fixed the endpoint.
Update BLOCKERS.md and resume BR-012 implementation."

IGRIS will:
- Mark blocker as resolved
- Resume BR-012 from where you stopped
- Continue implementation
```

**Example 2: Adapting to Changes**
```
# Mid-implementation, backend changes API response format

"Igris, backend developer changed the endpoint response format
for BR-012. New format is { user: {...}, metadata: {...} } instead
of just {...}. Update the brief with this context and adjust our
implementation."

IGRIS will:
- Update BR-012 brief with API change note
- Add to DECISIONS.md (API format change)
- Adjust implementation to new format
- Update tests to match new structure
```

**Example 3: Changing Priorities**
```
# P2 bug becomes critical

"Igris, BR-018 just caused production outage. Change priority
to P0-Critical, add to BLOCKERS.md, and tell me what we need
to do to fix it immediately."

IGRIS will:
- Update BR-018 priority
- Add to BLOCKERS.md
- Read the brief
- Recommend immediate action plan
- Ask if you want to pause current work
```

**Example 4: Context Handoff**
```
# You need to hand off work to teammate

"Igris, I'm going offline. Update CURRENT_SESSION.md with exact
stopping point for BR-025. What should the next person know to
continue this work?"

IGRIS will:
- Update session state
- Write clear "Next Steps When Resuming"
- List uncommitted changes
- Note any blockers or decisions
- Provide context summary for handoff

# Teammate continues later
"Igris, what was the last person working on?"
IGRIS: *Reads session, explains BR-025 status, shows next steps*
```

**The Pattern:**
- ✅ **You** notice issues, make decisions, set priorities, guide direction
- ✅ **IGRIS** records, tracks, executes, and reminds
- ✅ **You** stay in control of architecture and strategy
- ❌ Don't wait for IGRIS to notice problems (it won't — you notice, you tell it)
- ❌ Don't let IGRIS make strategic decisions (it shouldn't — you decide, it executes)

**This is vibe engineering:**
You are the architect with vision and judgment.
IGRIS is the discipline that turns vision into reality.

**Not vibe coding:**
AI guesses what you want and hopes for the best.

**You are in charge. Always.**

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

# 4. Generate architecture documentation (v3.2)
```
"DOCUMENT architecture"
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

# 2. Launch Claude and analyze (v3.2)
claude
```
"MIGRATE analyze"
```

The migrator agent will:
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

### Generate Coding Guidelines (v3.2)

```
STANDARDIZE hybrid

Base architecture repo: https://github.com/your-org/flutter-base-architecture
Also analyze current project: Yes
Platform: Flutter
```

The standardizer agent will:
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

IGRIS will:
1. Read the brief
2. Load architecture context
3. Plan the implementation
4. Write code following architecture
5. Write tests
6. Run verification
7. Create commit

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

## ✦ Requirements

- **Git** - Version control (required)
- **Claude AI** - AI assistant (Claude Code CLI or Claude.ai) (required)
- **Python 3** - For JSON manipulation in scripts (required)
- **Bash** - Shell scripts (Mac/Linux/WSL) (required)
- **Node.js 20+** - For MCP server (optional - enables enhanced tool integration)
- **jq** - JSON processor (optional - needed for plugin hooks)

### Installing Node.js (Optional)

Node.js 20+ enables the MCP (Model Context Protocol) server for enhanced Claude Code integration. IGRIS works without it, but MCP tools won't be available.

**macOS:**
```bash
brew install node
```

**Ubuntu/Debian:**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

**Download:** [https://nodejs.org/](https://nodejs.org/) (LTS version 20+)

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

**The Open Source Call:**
> *Create boldly. Release openly. Engineer with discipline.*

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

# v3.2 Commands:
# STANDARDIZE analyze   - Generate coding guidelines
# DOCUMENT architecture - Generate architecture docs
# MIGRATE analyze       - Analyze codebase for migrations
# Implement BR-001      - Autonomous implementation
```

**From Vibe Coding → Vibe Engineering.**
