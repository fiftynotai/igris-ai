# Igris AI

**Intelligent code quality and architecture management system powered by AI**

**Version:** 2.0.0 | **Status:** ✅ Production Ready

Igris AI helps teams maintain high code quality and architectural standards by providing:
- 🎯 Systematic bug and feature tracking
- 📋 Architecture compliance enforcement
- 🤖 AI-powered code analysis and migration planning
- 📚 Comprehensive documentation generation
- 🔌 Extensible plugin system

---

## What is Igris AI?

Igris AI is a project management system designed to work seamlessly with Claude AI to help you:

1. **Maintain Architecture Standards** - Define and enforce your project's architecture patterns
2. **Track Bugs & Features** - Manage development work with structured briefs
3. **Analyze Codebases** - Automatically identify technical debt and violations
4. **Plan Migrations** - Generate actionable tasks to bring projects up to standard
5. **Document Everything** - Auto-generate architecture documentation

---

## Quick Start

### Installation

```bash
# Clone Igris AI
git clone https://github.com/Fifty50ai/igris-ai
cd your-project

# Initialize Igris AI in your project
../igris-ai/scripts/igris_init.sh
```

This creates:
- `ai/` - Igris AI directory with templates
- `.claude/hooks/` - Startup hook for automatic initialization
- `CLAUDE.md` - Context for Claude Code CLI
- `scripts/` - Core Igris AI scripts (6 scripts including update system)
- Documentation and guides

### Start Using Claude (Truly Automatic!)

```bash
$ claude
```

**BEFORE you type anything**, you'll see:

```
🚀 Welcome to Igris AI on Claude Code

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

Igris AI tracks your work continuously in `ai/session/CURRENT_SESSION.md`:
- 📊 **Automatic recovery** - If your conversation resets, Claude resumes from where you left off
- 🔄 **Progress tracking** - Every task completion is saved immediately
- 📋 **Context preservation** - "Next Steps When Resuming" always up-to-date
- 🚨 **Blocker tracking** - Critical issues logged in `BLOCKERS.md`

Claude automatically initializes on every conversation (even after context resets) and maintains session state throughout your work. See `ai/prompts/session_protocol.md` for checkpoint details.

### Optional: Shell Integration

Want terminal notifications when entering Igris AI projects?

```bash
$ ./scripts/install_shell_integration.sh
```

This adds a notification to your shell (bash/zsh):
```bash
$ cd my-project
📘 Igris AI detected (v1.0.4)
   Claude will auto-initialize with Igris AI configuration
```

**Benefits:**
- Visual context awareness
- See Igris AI version
- Know which projects use Igris AI

**Security:** You choose to install, use the script, or add manually. We never modify your shell without permission.

### Generate Architecture Documentation

Ask Claude to analyze your project:

```
Please analyze this project using ai/prompts/generate_architecture_docs.md
```

Claude will:
- Analyze your project structure
- Ask questions about your architecture
- Generate comprehensive documentation in `ai/context/`

### Generate Coding Guidelines

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

### Analyze Your Codebase

Find issues and generate migration tasks:

```
Please analyze this codebase using ai/prompts/migration_analysis.md
```

Claude will:
- Scan your code for violations
- Generate categorized briefs (Migration, Bugs, Technical Debt, Testing)
- Create a migration roadmap with phases

### Start Managing Work

```
# Register a bug (don't implement yet)
"Register a bug: [description]"

# List all bugs
"List all bugs"

# Implement a bug fix
"Implement BR-001"
```

See `ai/prompts/bug_prompts.md` and `ai/prompts/feature_prompts.md` for complete workflows.

---

## 📦 Example Project

**Want to see Igris AI in action?**

Check out our complete working example:

**[igris-ai-flutter-example](https://github.com/Fifty50ai/igris_ai_flutter_example)** - A fully configured Flutter project demonstrating:
- ✅ Complete Igris AI setup
- ✅ Example briefs (BR, FR, TD)
- ✅ Conventional commits
- ✅ Automated workflows
- ✅ Distribution plugin integration
- ✅ Real commit history showing workflow

Perfect for:
- Learning how to use Igris AI
- Seeing real-world usage
- Copy-paste examples
- Validating your setup

**[→ View Example Project](https://github.com/Fifty50ai/igris_ai_flutter_example)**

---

## Features

### 📋 Structured Brief Management

- **BR-XXX** - Bug fixes and features
- **MG-XXX** - Migration tasks (architecture refactoring)
- **TD-XXX** - Technical debt cleanup
- **TS-XXX** - Testing tasks

Each brief includes:
- Problem description
- Acceptance criteria
- Test plan
- Priority and effort estimates

### 🎯 Architecture Enforcement

Define your architecture once, enforce it everywhere:
- **Coding Guidelines Generation** - Extract from base repo or infer from project
- Layer boundaries (MVVM, MVC, Clean Architecture, etc.)
- Naming conventions and code structure
- API patterns and best practices
- Module organization

**NEW:** `generate_coding_guidelines.md` creates standardized guidelines by:
- Analyzing your base architecture repository
- Extracting patterns from existing code
- Merging multiple sources with conflict resolution
- Using platform-specific best practices as fallback

### 🤖 AI-Powered Analysis

Claude analyzes your code to find:
- Architecture violations
- Code quality issues
- Testing gaps
- Performance problems
- Security vulnerabilities

### 🔌 Plugin System

Extend Igris AI with plugins for:
- Distribution automation (Flutter, React Native, etc.)
- CI/CD integration
- Custom workflows
- Platform-specific tools

---

## Core Concepts

### Briefs

Briefs are structured work items that capture:
- What needs to be done
- Why it's important
- How to verify it's complete
- Testing requirements

### Session Tracking

Igris AI tracks your work:
- **CURRENT_SESSION.md** - Active work
- **BLOCKERS.md** - Blocking issues
- **DECISIONS.md** - Architectural decisions
- **LEARNINGS.md** - Discovered patterns

### Brief Lifecycle

```
Draft → Ready → In Progress → In Review → Done → Archived
```

### Priority Levels

- **P0 - Critical** - Blockers, crashes, security issues
- **P1 - High** - Important features, major bugs
- **P2 - Medium** - Standard work
- **P3 - Low** - Nice-to-haves, polish

---

## Plugin System

### Installing Plugins

```bash
./scripts/plugin_install.sh <plugin-repo-url>
```

### Available Plugins

- **[igris-ai-distribution-flutter](https://github.com/Fifty50ai/igris-ai-distribution-flutter)** - Smart release automation for Flutter
  - Automated version bumping
  - Release notes generation
  - Firebase App Distribution
  - Fastlane integration
  - **[See it in action →](https://github.com/Fifty50ai/igris_ai_flutter_example)**

### Creating Plugins

See [Plugin Development Guide](docs/PLUGIN_DEVELOPMENT.md)

---

## Updating Igris AI

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

## Documentation

- **[Setup Guide](docs/SETUP_GUIDE.md)** - Complete installation and setup
- **[Update Guide](docs/UPDATE_GUIDE.md)** - Updating Igris AI and plugins
- **[Migration Guide](docs/MIGRATION_GUIDE.md)** - Onboarding existing projects
- **[Plugin Development](docs/PLUGIN_DEVELOPMENT.md)** - Building plugins
- **[Contributing Guide](ai/CONTRIBUTING.md)** - How to use Igris AI

---

## Requirements

- **Git** - Version control
- **Claude AI** - AI assistant (Claude Code CLI or Claude.ai)
- **Python 3** - For JSON manipulation in scripts
- **Bash** - Shell scripts (Mac/Linux/WSL)

---

## Project Structure

```
your-project/
├── .claude/                     # Claude Code CLI integration
│   └── hooks/
│       └── startup.sh           # Auto-runs on Claude start
├── CLAUDE.md                    # Context loaded on first message
├── ai/                          # Igris AI
│   ├── briefs/                  # Work items
│   ├── context/                 # Architecture docs
│   ├── prompts/                 # AI prompts
│   ├── session/                 # Session tracking
│   ├── checks/                  # QA checklists
│   ├── templates/               # Templates
│   └── plugins/                 # Plugin registry
├── scripts/
│   ├── igris_init.sh        # Initialize Igris AI
│   ├── igris_update.sh      # Update Igris AI
│   ├── plugin_install.sh        # Install plugins
│   ├── plugin_update.sh         # Update plugins
│   └── ...
└── docs/                        # Project documentation
```

---

## Examples

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

## Why Igris AI?

### Without Igris AI
- ❌ Architecture violations go unnoticed
- ❌ Technical debt accumulates
- ❌ Inconsistent code quality
- ❌ Manual tracking in spreadsheets
- ❌ Tribal knowledge, no documentation

### With Igris AI
- ✅ Enforce architecture automatically
- ✅ Track and pay down tech debt systematically
- ✅ Consistent code quality across team
- ✅ Structured work items with Claude AI
- ✅ Auto-generated, always-up-to-date documentation

---

## Community

- **Issues:** [GitHub Issues](https://github.com/Fifty50ai/igris-ai/issues)
- **Discussions:** [GitHub Discussions](https://github.com/Fifty50ai/igris-ai/discussions)
- **Example Project:** [igris-ai-flutter-example](https://github.com/Fifty50ai/igris_ai_flutter_example)
- **Contributing:** See [CONTRIBUTING.md](ai/CONTRIBUTING.md)

---

## License

[MIT License](LICENSE)

---

## Acknowledgments

Built for teams using Claude AI to maintain high-quality codebases.

---

**Ready to get started?**

```bash
# Initialize Igris AI in your project
./scripts/igris_init.sh

# Generate coding guidelines (recommended first step)
# Ask Claude: "Generate coding guidelines using ai/prompts/generate_coding_guidelines.md"

# Generate architecture docs
# Ask Claude: "Analyze this project using ai/prompts/generate_architecture_docs.md"

# Analyze codebase
# Ask Claude: "Analyze codebase using ai/prompts/migration_analysis.md"
```

**Happy coding! 🚀**
