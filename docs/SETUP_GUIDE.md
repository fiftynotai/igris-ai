# Igris AI Setup Guide

Complete guide to setting up Igris AI v5.0 in your project.

---

## Prerequisites

Before you begin, ensure you have:

- **Git** - Version control system
- **Claude Code** - Claude Code CLI installed and configured
- **Python 3** - For JSON manipulation and utilities (usually pre-installed on Mac/Linux)
- **Bash** - Shell environment (Mac/Linux/WSL on Windows)
- **sqlite3** - For brain database operations (usually pre-installed)
- **Node.js 20+** - (Optional) Required only if using the MCP brain server

---

## Installation

Igris AI v5.0 offers two installation paths.

### Path 1: Brain-First Install (Recommended)

This installs the centralized brain at `~/.igris/` and uses symlinks so all projects share the same Igris AI files. Updates to the brain automatically propagate to all linked projects.

```bash
# Step 1: Clone Igris AI
cd /path/to/projects/
git clone https://github.com/fiftynotai/igris-ai

# Step 2: Initialize the brain
cd igris-ai
igris init

# Step 3: Install into your project (symlinks)
cd /path/to/your-project/
igris install .
```

**What this does:**
- Creates the centralized brain at `~/.igris/`
- Initializes SQLite database with FTS5 search
- Symlinks `.claude/` directory (agents, rules, skills) into your project
- Creates `ai/` directory with templates and session files
- Sets up `CLAUDE.md` for Claude Code integration

### Path 2: Copy-Based Install (Standalone)

This copies all files directly into your project. Useful when you want a self-contained setup or cannot use symlinks.

```bash
# Step 1: Clone Igris AI
cd /path/to/projects/
git clone https://github.com/fiftynotai/igris-ai

# Step 2: Initialize in your project (copies files)
cd /path/to/your-project/
/path/to/igris-ai/scripts/igris_init.sh .
```

**What this does:**
- Creates `ai/` directory with all templates
- Copies `.claude/` directory (agents, rules, skills)
- Creates session files and brief templates
- Sets up `CLAUDE.md` for Claude Code integration

### Verify Installation

```bash
# Check that the core directories exist
ls -la .claude/
ls -la ai/

# Expected structure:
# .claude/
# ├── agents/          # 7 native subagents
# ├── hooks/           # Session start, pre/post commit
# ├── rules/           # 5 modular rules
# ├── skills/          # 21 skills
# └── settings.json    # Claude Code config
#
# ai/
# ├── briefs/          # Work items (9 brief types)
# ├── context/         # Architecture docs
# ├── masks/           # Mask greeting files
# ├── prompts/         # System prompts
# ├── session/         # Session tracking
# └── templates/       # PR/commit templates
#
# CLAUDE.md            # Claude Code instructions
# SOUL.md              # Igris persona identity (if brain-first)
```

### Check Brain Health (Brain-First Only)

```bash
# Verify brain is installed
ls ~/.igris/

# Check database integrity
sqlite3 ~/.igris/memory/knowledge.db "PRAGMA integrity_check; PRAGMA journal_mode;"

# List registered projects
sqlite3 ~/.igris/memory/knowledge.db "SELECT slug, path, status FROM projects;"
```

---

## Optional: MCP Server Setup

The MCP (Model Context Protocol) server provides 27 brain tools for cross-project intelligence. This is optional but recommended for multi-project workflows.

```bash
# Navigate to MCP server directory
cd /path/to/igris-ai/mcp-server

# Install dependencies
npm install

# Build the server
npm run build

# The server is configured in .claude/settings.json
# It will be available as MCP tools in Claude Code
```

---

## Configuration

### Generate Architecture Documentation

After installation, generate project-specific documentation:

```
/document architecture
```

This will:
1. Scan your project structure
2. Ask clarifying questions about your architecture
3. Generate documentation files in `~/.igris/projects/{project}/context/`:
   - `architecture_map.md` - Architecture overview
   - `api_pattern.md` - API interaction patterns
   - `coding_guidelines.md` - Code style and conventions
   - `module_catalog.md` - Module inventory

### Generate Coding Guidelines

```
/standardize analyze
```

This analyzes your codebase and generates project-specific coding guidelines.

---

## First Brief

### List Briefs

```
List all bugs
```

### Register a New Brief

```
/register bug "Memory leak in UserViewModel"
```

### Implement a Brief

```
/hunt BR-001
```

This activates the multi-agent workflow:
1. **ARCHITECT** plans the implementation
2. **FORGER** writes the code
3. **SENTINEL** runs tests
4. **WARDEN** reviews the changes
5. Commit and mark brief as Done

---

## Daily Workflow

### Morning: Check Status

```
/scan
```

This shows session status, active briefs, blockers, and recommendations.

### Register New Work

```
/register bug "Profile picture doesn't update after upload"
```

### Implement Work

```
# Ask for recommendations
What should I work on next?

# Implement the recommendation
/hunt BR-005
```

### End of Day

```
/rest
```

This archives the current session to `~/.igris/projects/{project}/session/archive/`.

---

## Available Commands

| Command | Purpose |
|---------|---------|
| `/scan` | System status report |
| `/awaken` | Start/resume session |
| `/rest` | Pause/end session |
| `/register` | Create new brief |
| `/hunt` | Implement brief (full workflow) |
| `/archive` | Archive completed brief |
| `/digivolve` | Agent management |
| `/document` | Documentation workflow |
| `/standardize` | Generate coding guidelines |
| `/release` | Release preparation |
| `/ideate` | Feature brainstorming |
| `/audit` | Codebase audit |
| `/team` | Parallel execution |
| `/projects` | List brain-registered projects |
| `/portfolio` | Cross-project dashboard |
| `/dashboard` | Brief and session tracker |

---

## Troubleshooting

### Issue: "Igris AI not initialized"

**Solution:**
```bash
# Run the appropriate initialization script
# Brain-first:
igris install .
# Or standalone:
/path/to/igris-ai/scripts/igris_init.sh .
```

### Issue: "Permission denied" when running scripts

**Solution:**
```bash
chmod +x scripts/*.sh
```

### Issue: Python not found

**Solution:**
```bash
# Mac:
brew install python3
# Ubuntu:
sudo apt-get install python3
```

### Issue: sqlite3 not found

**Solution:**
```bash
# Mac (usually pre-installed):
brew install sqlite3
# Ubuntu:
sudo apt-get install sqlite3
```

### Issue: Brain database corrupted

**Solution:**
```bash
# Check integrity
sqlite3 ~/.igris/memory/knowledge.db "PRAGMA integrity_check;"

# If corrupted, re-initialize
/path/to/igris-aigris init
```

### Issue: Symlinks broken after moving Igris AI repo

**Solution:**
```bash
# Re-run the install script to recreate symlinks
igris install .
```

---

## Next Steps

After setup:

1. **Generate architecture docs** - Run `/document architecture`
2. **Analyze codebase** - Run `/migrate-analyze`
3. **Review generated briefs** - Run `List all briefs`
4. **Start implementing** - Run `/hunt BR-XXX`
5. **Set up MCP** - (Optional) Build the MCP server for cross-project intelligence

---

## Getting Help

- **Documentation:** See `CONTRIBUTING.md` for contribution guidelines
- **Issues:** https://github.com/fiftynotai/igris-ai/issues
- **Discussions:** https://github.com/fiftynotai/igris-ai/discussions

---

**Setup complete! You're ready to use Igris AI v5.0.**
