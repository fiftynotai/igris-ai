# Igris AI Coding Guidelines

**Version:** 5.0.0
**Languages:** Bash, TypeScript, Python
**Platform:** macOS, Linux, WSL
**Last Updated:** 2026-02-22

---

## Purpose

This document defines the coding standards for **Igris AI itself** - the bash scripts, TypeScript MCP server, Python utilities, and tools that make up the Igris AI system.

**Dogfooding:** We enforce `ai/context/coding_guidelines.md` on user projects. This document ensures Igris AI follows its own standards.

---

## Table of Contents

1. [File Structure](#1-file-structure)
2. [Naming Conventions](#2-naming-conventions)
3. [Bash Standards](#3-bash-standards)
4. [TypeScript Standards](#4-typescript-standards)
5. [Python Standards](#5-python-standards)
6. [Hook Conventions](#6-hook-conventions)
7. [Brain/MCP Standards](#7-brainmcp-standards)
8. [Error Handling](#8-error-handling)
9. [Multi-line Text Handling](#9-multi-line-text-handling)
10. [JSON Manipulation](#10-json-manipulation)
11. [User Experience](#11-user-experience)
12. [Testing Requirements](#12-testing-requirements)
13. [Documentation](#13-documentation)
14. [Security](#14-security)
15. [Performance](#15-performance)
16. [Conventional Commits](#16-conventional-commits)
17. [Code Review Checklist](#17-code-review-checklist)

---

## 1. File Structure

### v4 Directory Structure

```
igris-ai/
├── .claude/
│   ├── agents/          # 7 native subagents
│   ├── hooks/           # Session start, pre/post commit
│   ├── rules/           # 5 modular rules
│   ├── skills/          # 21 skills
│   └── settings.json    # Claude Code config
├── ai/
│   ├── briefs/          # Work items (9 brief types)
│   ├── context/         # Architecture docs
│   ├── hooks/           # Hook specs
│   ├── masks/           # Mask greeting files
│   ├── prompts/         # System prompts
│   ├── session/         # Session tracking + metrics
│   └── templates/       # PR/commit templates
├── docs/                # Documentation
├── mcp-server/          # Brain MCP server (TypeScript)
├── scripts/             # Shell scripts
├── test/                # Test suite (bats)
├── CLAUDE.md            # Claude Code instructions
├── SOUL.md              # Igris persona identity
└── version.txt          # Version (5.0.0)
```

### Script Organization (Bash)

Every bash script must follow this structure:

```bash
#!/bin/bash
set -e  # MANDATORY: Exit on error

# Description: Brief description of what this script does
# Usage: script_name.sh [arguments]

# Function definitions
function_name() {
  # Function body
}

# Main execution logic
main() {
  # Main logic here
}

# Run main
main "$@"
```

---

## 2. Naming Conventions

### Scripts (Bash)

- **Format:** `snake_case.sh`
- **Descriptive:** Name should indicate purpose
- **Extension:** Always `.sh`

**Examples:**
```bash
igris_init.sh
igris_install.sh
igris_brain_init.sh
emit_skill_event.sh
```

### TypeScript (MCP Server)

- **Files:** `kebab-case.ts` or `camelCase.ts`
- **Classes/Interfaces:** `PascalCase`
- **Functions/Variables:** `camelCase`
- **Constants:** `UPPER_SNAKE_CASE`

### Python (Scripts/Utilities)

- **Files:** `snake_case.py`
- **Classes:** `PascalCase`
- **Functions/Variables:** `snake_case`
- **Constants:** `UPPER_SNAKE_CASE`

### Variables (Bash)

- **UPPERCASE:** For constants and environment variables
- **lowercase:** For local variables
- **Descriptive:** Avoid single letters (except `i`, `j` in loops)

**Examples:**
```bash
IGRIS_VERSION="5.0.0"
target_dir="/path/to/dir"
brain_path="$HOME/.igris"
```

---

## 3. Bash Standards

### Fail-Fast (MANDATORY)

**Every script MUST start with:**
```bash
#!/bin/bash
set -e  # Exit immediately if a command exits with non-zero status
```

### Dependency Validation

**Validate all dependencies upfront** - before any work is done.

**Pattern:**
```bash
check_python3() {
  if ! command -v python3 &> /dev/null; then
    echo "Error: Python 3 is required but not installed"
    echo ""
    echo "Install Python 3:"
    echo "  macOS:  brew install python3"
    echo "  Ubuntu: sudo apt install python3"
    echo "  WSL:    sudo apt install python3"
    echo ""
    exit 1
  fi
}

# Call early in main()
check_python3
```

**Required dependencies for Igris AI:**
- `python3` - Always required
- `git` - Always required
- `sqlite3` - Required for brain operations
- `node` (v20+) - Optional (for MCP server)
- `jq` - Optional (provide fallback or clear error)

### User Input Validation

**Validate all parameters and file paths:**

```bash
# Validate required parameter
if [ -z "$TARGET_DIR" ]; then
  echo "Error: Target directory not specified"
  echo "Usage: $0 <directory>"
  exit 1
fi

# Validate directory exists
if [ ! -d "$TARGET_DIR" ]; then
  echo "Error: Directory '$TARGET_DIR' does not exist"
  exit 1
fi
```

### Exit Codes

- `0` - Success
- `1` - General error (validation failure, dependency missing)
- `2` - Usage error (wrong arguments)

### Multi-line Text Handling

**ALWAYS use perl for multi-line substitution:**

```bash
# WRONG (sed breaks with newlines)
sed "s|{{PLACEHOLDER}}|$MULTI_LINE_VAR|g" template.md > output.md

# CORRECT (perl handles newlines)
ESCAPED_VAR=$(printf '%s\n' "$MULTI_LINE_VAR" | perl -pe 's/([\\\/\$])/\\$1/g')
perl -pe "s/\{\{PLACEHOLDER\}\}/$ESCAPED_VAR/g" template.md > output.md
```

### JSON Manipulation

**Use Python3 for JSON operations** (Python3 is a required dependency):

```bash
# Extract value from JSON
PLUGIN_NAME=$(cat plugin.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(data.get('name', ''))
")
```

**Optional: jq (with fallback)**

```bash
if command -v jq &> /dev/null; then
  PLUGIN_NAME=$(jq -r '.name' plugin.json)
else
  PLUGIN_NAME=$(cat plugin.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(data.get('name', ''))
")
fi
```

### Quote All Variables

```bash
# GOOD
cp "$SOURCE_FILE" "$TARGET_DIR"
cd "$PROJECT_PATH"

# BAD (breaks with spaces in paths)
cp $SOURCE_FILE $TARGET_DIR
```

---

## 4. TypeScript Standards

Standards for the MCP server (`mcp-server/`) and any TypeScript tooling.

### Compiler Settings

- Use strict TypeScript (`strict: true` in tsconfig)
- Target ES2022 or later
- Module system: ES modules (`"type": "module"` in package.json)

### Runtime

- Node.js 20+ required
- Use native Node.js APIs where possible (avoid unnecessary dependencies)

### Code Style

```typescript
// Use explicit types for function signatures
function getProjectStatus(slug: string): ProjectStatus {
  // ...
}

// Use interfaces for data shapes
interface ProjectStatus {
  slug: string;
  path: string;
  status: "active" | "archived";
  lastUpdated: string;
}

// Use async/await (not raw Promises)
async function queryBrain(sql: string): Promise<QueryResult> {
  try {
    const result = await db.prepare(sql).all();
    return result;
  } catch (error) {
    throw new BrainQueryError(`Query failed: ${error}`);
  }
}
```

### Error Handling

- Use try/catch for all async operations
- Define custom error types for domain-specific errors
- Never swallow errors silently
- Log errors with context (operation name, parameters)

### Dependencies

- `better-sqlite3` for SQLite access
- Minimize external dependencies
- Pin dependency versions in package-lock.json

---

## 5. Python Standards

Standards for brain scripts and Python utilities.

### Version

- Use Python 3.10+ features
- Type hints encouraged on all function signatures

### Code Style

```python
from typing import Optional
import asyncio

async def get_session_status(project_path: str) -> Optional[dict]:
    """Return the current session status for a project."""
    session_file = Path(project_path) / "ai" / "session" / "CURRENT_SESSION.md"
    if not session_file.exists():
        return None
    return parse_session(session_file.read_text())
```

### Async Operations

- Use `asyncio` for async operations
- Use `FastAPI` for web servers
- Use `aiofiles` for async file I/O when needed

### Dependencies

- Keep requirements minimal
- Use virtual environments for isolation
- Pin versions in `requirements.txt`

---

## 6. Hook Conventions

Standards for Claude Code hooks (`.claude/hooks/`).

### Structure

- All hooks use `set -e`
- Input via stdin, output to stdout
- Keep hooks fast (< 2 seconds)

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error (hook failed) |
| `2` | Skip (hook does not apply) |

### Environment Variables

Hooks receive context through environment variables:

| Variable | Description |
|----------|-------------|
| `IGRIS_HOOK_TYPE` | Hook type (pre-commit, post-commit, session-start) |
| `IGRIS_PROJECT_ROOT` | Absolute path to project root |
| `IGRIS_VERSION` | Current Igris AI version |

### Example Hook

```bash
#!/bin/bash
set -e

# Description: Pre-commit hook that validates brief references
# Exit codes: 0=success, 1=error, 2=skip

PROJECT_ROOT="${IGRIS_PROJECT_ROOT:-.}"

# Check if commit message references a brief
if ! grep -qE "(BR|FR|TD|MG|TS|PI|DU|PF|AC)-[0-9]+" "$1"; then
  echo "Warning: No brief reference in commit message"
  exit 2  # Skip (warning only)
fi

exit 0
```

---

## 7. Brain/MCP Standards

Standards for the centralized brain (`~/.igris/`) and MCP server (`mcp-server/`).

### SQLite Configuration

- **WAL mode:** Always use Write-Ahead Logging for concurrent reads
- **FTS5:** Use Full-Text Search 5 for text search operations
- **Busy timeout:** Set to 5000ms to handle lock contention
- **Journal mode:** WAL (set on database creation)

```sql
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;
```

### Brain Operations

- All brain operations are **fire-and-forget** (never block workflows)
- Brain queries should complete in < 100ms for interactive use
- Use parameterized queries to prevent SQL injection
- Always close database connections after use

### Data Integrity

- Use transactions for multi-statement writes
- Validate data before insertion
- Use foreign keys for referential integrity
- Run `PRAGMA integrity_check` periodically

### MCP Tool Design

- Each tool should do one thing well
- Return structured JSON responses
- Include error context in failure responses
- Document all parameters and return types

---

## 8. Error Handling

### General Principles (All Languages)

- **Fail fast:** Detect errors early and report clearly
- **Actionable messages:** Tell the user how to fix it
- **Context:** Include what operation failed and why
- **No silent failures:** Always log or report errors

### Platform-Specific Error Messages

```bash
echo "Error: Python 3 is required but not installed"
echo ""
echo "Install Python 3:"
echo "  macOS:  brew install python3"
echo "  Ubuntu: sudo apt install python3"
echo "  WSL:    sudo apt install python3"
echo ""
exit 1
```

---

## 9. Multi-line Text Handling

### The Problem

**Sed breaks with newlines.** Multi-line content cannot be reliably substituted using `sed`.

### The Solution: Use perl

**ALWAYS use perl for multi-line substitution in Bash scripts.**

**Reference:** See `scripts/igris_init.sh` for the canonical implementation.

---

## 10. JSON Manipulation

### Bash: Use Python3

Python3 is a required dependency, making it the reliable choice for JSON operations in shell scripts.

### TypeScript: Use native JSON

```typescript
const data = JSON.parse(content);
```

### Python: Use json module

```python
import json
data = json.loads(content)
```

---

## 11. User Experience

### Clear Error Messages

Error messages MUST be clear, actionable, and platform-specific where applicable.

### Progress Indicators

Use clear progress messages in scripts:

```bash
echo "Igris initializing..."
echo "Creating directory structure..."
echo "Igris AI initialized successfully!"
```

### Confirmation Prompts

Ask before destructive operations:

```bash
if [ -f "CLAUDE.md" ]; then
  echo "CLAUDE.md already exists"
  read -p "Overwrite? [y/N]: " CONFIRM
  if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "Operation cancelled"
    exit 0
  fi
fi
```

---

## 12. Testing Requirements

### Test Coverage Targets

- **Critical paths:** 100% coverage (init, install, core workflows)
- **Error handling:** 80% coverage (all error cases tested)
- **Edge cases:** 60% coverage (unusual inputs handled)

### Bash Tests

**Framework:** bats (Bash Automated Testing System)

**Test files use `.test.bash` extension:**

```
test/
├── igris_init.test.bash
├── igris_install.test.bash
├── test_helper.bash
└── fixtures/
    └── sample_data/
```

**Running tests:**
```bash
bats test/
```

### TypeScript Tests

- Use the project's configured test runner
- Test MCP tool handlers individually
- Mock SQLite for unit tests

---

## 13. Documentation

### Inline Comments

**Comment the WHY, not the WHAT:**

```bash
# Use perl instead of sed because sed breaks with multi-line content
# See BR-005 for details on this bug
perl -pe "s/{{VAR}}/$VALUE/g" template > output
```

### Function Documentation

**Document complex functions:**

```bash
# Validates that Python 3 is installed and accessible
# Exits with error code 1 and helpful message if not found
# Used by: igris_init.sh, igris_install.sh
check_python3() {
  if ! command -v python3 &> /dev/null; then
    echo "Error: Python 3 is required but not installed"
    exit 1
  fi
}
```

### File Headers

**Every script should have a header:**

```bash
#!/bin/bash
set -e

# Description: Initializes Igris AI in a project directory
# Usage: igris_init.sh <target_directory>
# Dependencies: python3, git, sqlite3
# Exit codes:
#   0 - Success
#   1 - Error (dependency missing, invalid directory, etc.)
```

---

## 14. Security

### Quote All Variables (Bash)

Always quote variables to prevent word splitting and glob expansion.

### Validate File Paths

Check file existence before operations in all languages.

### Avoid eval (Bash)

Never use `eval` with user input.

### Parameterized Queries (SQLite)

Always use parameterized queries to prevent SQL injection:

```typescript
// GOOD
db.prepare("SELECT * FROM projects WHERE slug = ?").get(slug);

// BAD
db.prepare(`SELECT * FROM projects WHERE slug = '${slug}'`).get();
```

---

## 15. Performance

### Bash

- Avoid unnecessary subshells
- Use built-in commands where possible
- Minimize file operations

### TypeScript (MCP Server)

- Use connection pooling for SQLite
- Cache frequently accessed data
- Avoid blocking the event loop

### SQLite (Brain)

- Use WAL mode for concurrent access
- Create indexes for frequently queried columns
- Use FTS5 for text search (not LIKE queries)
- Keep transactions short

---

## 16. Conventional Commits

### Commit Format

```
<type>(<scope>): <short summary>

<optional body>

<optional footer>
```

### Commit Types

- `feat` - New feature
- `fix` - Bug fix
- `refactor` - Code refactoring (no functionality change)
- `docs` - Documentation only
- `chore` - Maintenance (dependencies, tooling)
- `test` - Test additions or modifications
- `style` - Code style changes (formatting, no logic change)

### Scope Examples

- `feat(mcp): add cross-project search tool`
- `fix(init): use perl instead of sed for multi-line substitution`
- `docs(readme): add brain setup instructions`
- `test(init): add test for directory creation`

### Reference Briefs in Footer

```
closes #TD-XXX
fixes #BR-XXX
refs #MG-XXX
```

---

## 17. Code Review Checklist

### Before Submitting PR

**Reviewer checklist (all must pass):**

- [ ] **Follows guidelines:** All sections of this document followed
- [ ] **Tests added/updated:** New code has corresponding tests
- [ ] **Tests pass:** All tests green (bats, TypeScript)
- [ ] **Linter passes:** shellcheck for Bash, tsc --noEmit for TypeScript
- [ ] **Documentation updated:** Inline comments and README if needed
- [ ] **Cross-platform tested:** Tested on macOS and Linux (or WSL) for shell scripts
- [ ] **Error messages clear:** All error messages are actionable
- [ ] **No hardcoded paths:** Uses variables or derives paths
- [ ] **Variables quoted:** All Bash variable references use `"$VAR"`
- [ ] **Parameterized queries:** All SQL uses parameterized queries
- [ ] **Conventional commits:** Commit message follows format
- [ ] **Brief referenced:** Commit footer references brief (if applicable)
- [ ] **set -e included:** Bash scripts fail fast on errors

### Automated Checks

**Run before committing:**

```bash
# Lint shell scripts
shellcheck scripts/*.sh

# Run bash tests
bats test/

# TypeScript (if modifying MCP server)
cd mcp-server && npm run build
```

---

## Compliance

### This Document is Mandatory

All code merged into Igris AI **MUST** follow these guidelines. No exceptions.

### Continuous Improvement

This document evolves. When you discover a pattern that should be standardized:

1. Create a brief (TD-XXX)
2. Update this document
3. Update existing code if needed
4. Reference in commit message

### Questions?

If these guidelines don't cover your situation, ask in:
- GitHub Issues (for public discussion)
- Pull Request (for PR-specific questions)

---

## References

### External Resources

- [Google Shell Style Guide](https://google.github.io/styleguide/shellguide.html)
- [shellcheck](https://www.shellcheck.net/) - Static analysis tool for Bash
- [bats](https://github.com/bats-core/bats-core) - Bash testing framework
- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/) - TypeScript reference

### Related Igris AI Briefs

- **BR-005:** Plugin install regeneration bug (perl vs sed)
- **TD-004:** Python3 dependency validation
- **TD-005:** Automated shell script testing
- **TD-006:** Inconsistent jq dependency handling
- **TD-020:** Documentation overhaul for v4.0

### Internal Documentation

- `ai/prompts/igris_os.md` - Igris AI operating system (for Claude)
- `ai/templates/commit_message.md` - Commit message template
- `CONTRIBUTING.md` - Contribution guide
- `README.md` - Project README

---

**Created:** 2025-10-26
**Version:** 5.0.0
**Last Updated:** 2026-02-22
**Maintained by:** Igris AI Team

---

Remember: We enforce coding guidelines on user projects. We MUST follow our own standards.

Dogfooding is not optional. It's how we build trust.
