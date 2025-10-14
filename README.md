# Blueprint AI

**Intelligent code quality and architecture management system powered by AI**

Blueprint AI helps teams maintain high code quality and architectural standards by providing:
- 🎯 Systematic bug and feature tracking
- 📋 Architecture compliance enforcement
- 🤖 AI-powered code analysis and migration planning
- 📚 Comprehensive documentation generation
- 🔌 Extensible plugin system

---

## What is Blueprint AI?

Blueprint AI is a project management system designed to work seamlessly with Claude AI to help you:

1. **Maintain Architecture Standards** - Define and enforce your project's architecture patterns
2. **Track Bugs & Features** - Manage development work with structured briefs
3. **Analyze Codebases** - Automatically identify technical debt and violations
4. **Plan Migrations** - Generate actionable tasks to bring projects up to standard
5. **Document Everything** - Auto-generate architecture documentation

---

## Quick Start

### Installation

```bash
# Clone Blueprint AI
git clone https://github.com/Mohamed50/blueprint-ai
cd your-project

# Initialize Blueprint AI in your project
../blueprint-ai/scripts/blueprint_init.sh
```

This creates:
- `ai/` - Blueprint AI directory with templates
- `scripts/` - Core Blueprint AI scripts
- Documentation and guides

### Generate Architecture Documentation

Ask Claude to analyze your project:

```
Please analyze this project using ai/prompts/generate_architecture_docs.md
```

Claude will:
- Analyze your project structure
- Ask questions about your architecture
- Generate comprehensive documentation in `ai/context/`

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

**Want to see Blueprint AI in action?**

Check out our complete working example:

**[blueprint-ai-flutter-example](https://github.com/Mohamed50/blueprint_ai_flutter_example)** - A fully configured Flutter project demonstrating:
- ✅ Complete Blueprint AI setup
- ✅ Example briefs (BR, FR, TD)
- ✅ Conventional commits
- ✅ Automated workflows
- ✅ Distribution plugin integration
- ✅ Real commit history showing workflow

Perfect for:
- Learning how to use Blueprint AI
- Seeing real-world usage
- Copy-paste examples
- Validating your setup

**[→ View Example Project](https://github.com/Mohamed50/blueprint_ai_flutter_example)**

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
- Layer boundaries (MVVM, MVC, Clean Architecture, etc.)
- Coding guidelines
- API patterns
- Module structure

### 🤖 AI-Powered Analysis

Claude analyzes your code to find:
- Architecture violations
- Code quality issues
- Testing gaps
- Performance problems
- Security vulnerabilities

### 🔌 Plugin System

Extend Blueprint AI with plugins for:
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

Blueprint AI tracks your work:
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

- **[blueprint-ai-distribution-flutter](https://github.com/Mohamed50/blueprint-ai-distribution-flutter)** - Smart release automation for Flutter
  - Automated version bumping
  - Release notes generation
  - Firebase App Distribution
  - Fastlane integration
  - **[See it in action →](https://github.com/Mohamed50/blueprint_ai_flutter_example)**

### Creating Plugins

See [Plugin Development Guide](docs/PLUGIN_DEVELOPMENT.md)

---

## Documentation

- **[Setup Guide](docs/SETUP_GUIDE.md)** - Complete installation and setup
- **[Migration Guide](docs/MIGRATION_GUIDE.md)** - Onboarding existing projects
- **[Plugin Development](docs/PLUGIN_DEVELOPMENT.md)** - Building plugins
- **[Contributing Guide](ai/CONTRIBUTING.md)** - How to use Blueprint AI

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
├── ai/                          # Blueprint AI
│   ├── briefs/                  # Work items
│   ├── context/                 # Architecture docs
│   ├── prompts/                 # AI prompts
│   ├── session/                 # Session tracking
│   ├── checks/                  # QA checklists
│   ├── templates/               # Templates
│   └── plugins/                 # Plugin registry
├── scripts/
│   ├── blueprint_init.sh        # Initialize Blueprint AI
│   ├── plugin_install.sh        # Install plugins
│   └── ...
└── docs/                        # Project documentation
```

---

## Examples

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

## Why Blueprint AI?

### Without Blueprint AI
- ❌ Architecture violations go unnoticed
- ❌ Technical debt accumulates
- ❌ Inconsistent code quality
- ❌ Manual tracking in spreadsheets
- ❌ Tribal knowledge, no documentation

### With Blueprint AI
- ✅ Enforce architecture automatically
- ✅ Track and pay down tech debt systematically
- ✅ Consistent code quality across team
- ✅ Structured work items with Claude AI
- ✅ Auto-generated, always-up-to-date documentation

---

## Community

- **Issues:** [GitHub Issues](https://github.com/Mohamed50/blueprint-ai/issues)
- **Discussions:** [GitHub Discussions](https://github.com/Mohamed50/blueprint-ai/discussions)
- **Example Project:** [blueprint-ai-flutter-example](https://github.com/Mohamed50/blueprint_ai_flutter_example)
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
# Initialize Blueprint AI in your project
./scripts/blueprint_init.sh

# Generate architecture docs
# Ask Claude: "Analyze this project using ai/prompts/generate_architecture_docs.md"

# Analyze codebase
# Ask Claude: "Analyze codebase using ai/prompts/migration_analysis.md"
```

**Happy coding! 🚀**
