# Igris AI Setup Guide

Complete guide to setting up Igris AI in your project.

---

## Prerequisites

Before you begin, ensure you have:

- ✅ **Git** - Version control system
- ✅ **Claude AI** - Access to Claude (Claude Code CLI or Claude.ai)
- ✅ **Python 3** - For JSON manipulation (usually pre-installed on Mac/Linux)
- ✅ **Bash** - Shell environment (Mac/Linux/WSL on Windows)

---

## Installation

### Step 1: Clone Igris AI

```bash
# Navigate to your projects directory
cd /path/to/projects/

# Clone Igris AI
git clone https://github.com/yourorg/igris-ai
```

This creates a `igris-ai` directory you'll reference for all projects.

### Step 2: Initialize in Your Project

```bash
# Navigate to your project
cd /path/to/your-project/

# Run Igris AI initialization
../igris-ai/scripts/igris_init.sh
```

**What this does:**
- Creates `ai/` directory with all templates
- Copies core scripts to `scripts/`
- Creates empty session files
- Sets up plugin registry

**Output:**
```
🎯 Igris AI - Project Initialization
========================================

📁 Target directory: /path/to/your-project
📦 Creating directory structure...
📄 Copying templates...
📝 Creating session files...
🔧 Installing Igris AI scripts...

✅ Igris AI initialized successfully!
```

### Step 3: Verify Installation

```bash
# Check that ai/ directory exists
ls -la ai/

# Expected output:
# ai/
# ├── briefs/
# ├── context/
# ├── prompts/
# ├── session/
# ├── checks/
# ├── templates/
# └── plugins/
```

---

## Configuration

### Generate Architecture Documentation

After installation, generate project-specific documentation:

**Use the DOCUMENT command:**
```
DOCUMENT architecture
```

**The documenter agent will:**
1. Scan your project structure
2. Ask clarifying questions about your architecture
3. Generate 4 documentation files in `ai/context/`:
   - `architecture_map.md` - Architecture overview
   - `api_pattern.md` - API interaction patterns
   - `coding_guidelines.md` - Code style and conventions
   - `module_catalog.md` - Module inventory

**Example interaction:**
```
IGRIS: I can see this is a Flutter project using MVVM + GetX.

Let me ask a few questions:

1. Are you using the Actions layer pattern consistently?
2. How do you handle API state (loading/success/error)?
3. What's your dependency injection strategy?

[After answering...]

Great! I'll generate the documentation files now.

[Creates 4 files in ai/context/]

✅ Architecture documentation generated!
```

---

## Analyze Your Codebase

Generate migration tasks and identify issues:

**Use the MIGRATE command:**
```
MIGRATE analyze
```

**The migrator agent will:**
1. Scan all source files
2. Identify architecture violations
3. Find code quality issues
4. Detect testing gaps
5. Generate categorized briefs:
   - **MG-XXX** - Migration tasks
   - **BR-XXX** - Bugs found
   - **TD-XXX** - Technical debt
   - **TS-XXX** - Testing gaps

**Output:**
```
📊 Codebase Analysis Complete

Found 25 issues:
- 🔴 2 Critical (P0)
- 🟠 6 High (P1)
- 🟡 12 Medium (P2)
- 🟢 5 Low (P3)

Created 25 briefs in ai/briefs/
Created migration roadmap in ai/session/MIGRATION_ROADMAP.md

Estimated migration time: 3-4 weeks
```

---

## First Brief

Now that you have generated briefs, let's work on one:

### List Briefs

**Command:**
```
List all bugs
```

**IGRIS shows:**
```
## Bug Briefs (5 total)

| ID | Title | Priority | Status | Effort |
|----|-------|----------|--------|--------|
| BR-001 | Memory leak in ViewModel | P0 | Ready | S |
| BR-002 | Null pointer exception | P1 | Ready | S |
| BR-003 | UI overflow on tablet | P2 | Ready | M |
```

### Implement a Brief

**Command:**
```
Implement BR-001
```

**IGRIS will:**
1. Read the brief from `ai/briefs/BR-001-*.md`
2. Load architecture context
3. Create session in `ai/session/CURRENT_SESSION.md`
4. Plan → Code → Test → Commit workflow
5. Mark brief as Done

---

## Daily Workflow

### Morning: Check Status

```bash
# See all active work
SCAN  # or: cat ai/session/CURRENT_SESSION.md

# List pending briefs
List all bugs in Ready status
```

### Register New Work

```bash
# Bug found during testing
REGISTER bug:
Module: user profile
Issue: Profile picture doesn't update after upload
Steps: 1) Upload new picture, 2) Check profile page
Expected: New picture shows
Actual: Old picture still visible
Priority: P1
```

### Implement Work

```bash
# Start work on highest priority
What should I work on next?

# Implement the recommendation
Implement BR-005
```

### End of Day: Archive Session

```bash
# If session is complete
REST  # or: Archive current session

# This moves CURRENT_SESSION.md to ai/session/archive/
```

---

## Plugin Installation

### Install a Plugin

```bash
# Example: Installing Flutter distribution plugin
./scripts/plugin_install.sh https://github.com/yourorg/igris-ai-distribution-flutter
```

**Plugin installer will:**
1. Clone the plugin
2. Run plugin's install script
3. Copy plugin files to your project
4. Register in `ai/plugins/installed.json`

### List Installed Plugins

```bash
./scripts/plugin_list.sh
```

**Output:**
```
🔌 Igris AI Installed Plugins
==================================

Found 1 plugin(s):

📦 igris-ai-distribution-flutter v1.0.0
   Installed: 2025-10-13T15:30:00Z
   Capabilities: distribution, versioning, release_notes
   Repository: https://github.com/yourorg/igris-ai-distribution-flutter
```

### Uninstall a Plugin

```bash
./scripts/plugin_uninstall.sh igris-ai-distribution-flutter
```

---

## File Structure Reference

After setup, your project will have:

```
your-project/
├── ai/                                # Igris AI
│   ├── briefs/                        # Work items
│   │   ├── BR-TEMPLATE.md             # Bug/feature template
│   │   ├── MG-TEMPLATE.md             # Migration template
│   │   ├── TD-TEMPLATE.md             # Technical debt template
│   │   ├── TS-TEMPLATE.md             # Testing template
│   │   └── [generated briefs]
│   ├── context/                       # Architecture docs (generated)
│   │   ├── architecture_map.md
│   │   ├── api_pattern.md
│   │   ├── coding_guidelines.md
│   │   └── module_catalog.md
│   ├── prompts/                       # AI prompts (v3.2 consolidated)
│   │   ├── igris_os.md                 # Core operating system
│   │   └── session_protocol.md         # Session tracking protocol
│   ├── session/                       # Session tracking
│   │   ├── CURRENT_SESSION.md         # Active work
│   │   ├── BLOCKERS.md                # Blocking issues
│   │   ├── DECISIONS.md               # Decisions log
│   │   ├── LEARNINGS.md               # Patterns discovered
│   │   └── archive/                   # Completed sessions
│   ├── checks/                        # QA checklists
│   │   └── qa_runbook.md
│   ├── templates/                     # Templates
│   │   ├── commit_message.md
│   │   └── pr_description.md
│   ├── plugins/                       # Plugin system
│   │   ├── README.md
│   │   └── installed.json
│   └── CONTRIBUTING.md                # Usage guide
│
├── scripts/                           # Scripts
│   ├── igris_init.sh              # (from Igris AI)
│   ├── plugin_install.sh              # (from Igris AI)
│   ├── plugin_uninstall.sh            # (from Igris AI)
│   ├── plugin_list.sh                 # (from Igris AI)
│   └── [plugin scripts if installed]
│
└── [your project files...]
```

---

## Troubleshooting

### Issue: "Igris AI not initialized"

**Solution:**
```bash
# Run initialization script
../igris-ai/scripts/igris_init.sh
```

### Issue: "Permission denied" when running scripts

**Solution:**
```bash
# Make scripts executable
chmod +x scripts/*.sh
```

### Issue: Python not found

**Solution:**
```bash
# Install Python 3
# Mac: brew install python3
# Ubuntu: sudo apt-get install python3
```

### Issue: Can't find Igris AI directory

**Solution:**
```bash
# Clone Igris AI first
git clone https://github.com/yourorg/igris-ai

# Then reference it with correct path
/full/path/to/igris-ai/scripts/igris_init.sh
```

---

## Next Steps

After setup:

1. **Generate architecture docs** - Run `DOCUMENT architecture`
2. **Analyze codebase** - Run `MIGRATE analyze`
3. **Review generated briefs** - Run `List all briefs`
4. **Start implementing** - Run `Implement BR-XXX`
5. **Install plugins** - Add distribution, CI/CD, or custom plugins

---

## Getting Help

- **Documentation:** See `ai/CONTRIBUTING.md` for detailed usage
- **Issues:** https://github.com/yourorg/igris-ai/issues
- **Discussions:** https://github.com/yourorg/igris-ai/discussions

---

**Setup complete! You're ready to use Igris AI. 🎉**
