# Igris AI Coding Guidelines

**Version:** 2.0.0
**Language:** Bash
**Platform:** macOS, Linux, WSL
**Last Updated:** 2025-10-26

---

## Purpose

This document defines the coding standards for **Igris AI itself** - the bash scripts, templates, and tools that make up the Igris AI system.

**Dogfooding:** We enforce `ai/context/coding_guidelines.md` on user projects. This document ensures Igris AI follows its own standards.

---

## Table of Contents

1. [File Structure](#1-file-structure)
2. [Naming Conventions](#2-naming-conventions)
3. [Error Handling](#3-error-handling)
4. [Multi-line Text Handling](#4-multi-line-text-handling)
5. [JSON Manipulation](#5-json-manipulation)
6. [User Experience](#6-user-experience)
7. [Testing Requirements](#7-testing-requirements)
8. [Documentation](#8-documentation)
9. [Security](#9-security)
10. [Performance](#10-performance)
11. [Conventional Commits](#11-conventional-commits)
12. [Code Review Checklist](#12-code-review-checklist)

---

## 1. File Structure

### Script Organization

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

### Directory Structure

```
igris-ai/
├── scripts/           # Core installation and management scripts
│   ├── igris_init.sh
│   ├── plugin_install.sh
│   └── templates/     # File templates
├── ai/                # Igris AI operational files
│   ├── briefs/        # Brief management
│   ├── session/       # Session tracking
│   ├── context/       # Project context (including this file)
│   └── prompts/       # System prompts
├── test/              # Test files (bats framework)
│   ├── fixtures/      # Test fixtures
│   └── *.bats         # Test files
└── docs/              # Documentation
```

---

## 2. Naming Conventions

### Scripts

- **Format:** `snake_case.sh`
- **Descriptive:** Name should indicate purpose
- **Extension:** Always `.sh`

**Examples:**
```bash
✅ igris_init.sh
✅ plugin_install.sh
✅ persona_mask.sh
❌ init.sh           # Too generic
❌ installPlugin.sh  # camelCase (wrong)
```

### Functions

- **Format:** `snake_case`
- **Verbs:** Start with action word
- **Descriptive:** Clear purpose

**Examples:**
```bash
✅ check_python3()
✅ create_directories()
✅ validate_plugin_json()
❌ check()           # Too vague
❌ doStuff()         # camelCase (wrong)
```

### Variables

- **UPPERCASE:** For constants and environment variables
- **lowercase:** For local variables
- **Descriptive:** Avoid single letters (except `i`, `j` in loops)

**Examples:**
```bash
✅ IGRIS_VERSION="2.0.0"
✅ target_dir="/path/to/dir"
✅ plugin_name="igris-persona"
❌ DIR="..."         # Not descriptive enough for non-constant
❌ x="value"         # Single letter (avoid)
```

---

## 3. Error Handling

### Fail-Fast (MANDATORY)

**Every script MUST start with:**
```bash
#!/bin/bash
set -e  # Exit immediately if a command exits with non-zero status
```

**Why:** Prevents cascading failures. If one command fails, stop immediately rather than continuing in broken state.

### Dependency Validation

**Validate all dependencies upfront** - before any work is done.

**Pattern:**
```bash
check_python3() {
  if ! command -v python3 &> /dev/null; then
    echo "❌ Error: Python 3 is required but not installed"
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
- `jq` - Optional (provide fallback or clear error)

### User Input Validation

**Validate all parameters and file paths:**

```bash
# Validate required parameter
if [ -z "$TARGET_DIR" ]; then
  echo "❌ Error: Target directory not specified"
  echo "Usage: $0 <directory>"
  exit 1
fi

# Validate directory exists
if [ ! -d "$TARGET_DIR" ]; then
  echo "❌ Error: Directory '$TARGET_DIR' does not exist"
  exit 1
fi

# Validate file exists
if [ ! -f "$CONFIG_FILE" ]; then
  echo "❌ Error: Config file not found: $CONFIG_FILE"
  exit 1
fi
```

### Exit Codes

- `0` - Success
- `1` - General error (validation failure, dependency missing)
- `2` - Usage error (wrong arguments)

---

## 4. Multi-line Text Handling

### The Problem

**Sed breaks with newlines.** Multi-line content (like persona greetings) cannot be reliably substituted using `sed`.

### The Solution: Use perl

**ALWAYS use perl for multi-line substitution:**

```bash
# ❌ WRONG (sed breaks with newlines)
sed "s|{{PLACEHOLDER}}|$MULTI_LINE_VAR|g" template.md > output.md

# ✅ CORRECT (perl handles newlines)
ESCAPED_VAR=$(printf '%s\n' "$MULTI_LINE_VAR" | perl -pe 's/([\\\/\$])/\\$1/g')
perl -pe "s/\{\{PLACEHOLDER\}\}/$ESCAPED_VAR/g" template.md > output.md
```

**Why:** This pattern was established in BR-005 (plugin install regeneration bug fix). Sed's multi-line handling is inconsistent across platforms.

### Reference Implementation

See `scripts/igris_init.sh` for the canonical implementation of multi-line substitution.

---

## 5. JSON Manipulation

### Primary Method: Python3

**Use Python3 for JSON operations** (Python3 is a required dependency):

```bash
# Extract value from JSON
PLUGIN_NAME=$(cat plugin.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(data.get('name', ''))
")

# Update JSON file
python3 <<EOF > updated.json
import json
with open('input.json', 'r') as f:
    data = json.load(f)
data['new_field'] = 'value'
print(json.dumps(data, indent=2))
EOF
```

### Optional: jq (with fallback)

**If jq is available, you may use it** - but MUST provide fallback:

```bash
# Check if jq available
if command -v jq &> /dev/null; then
  # Use jq (faster)
  PLUGIN_NAME=$(jq -r '.name' plugin.json)
else
  # Fallback to python3
  PLUGIN_NAME=$(cat plugin.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(data.get('name', ''))
")
fi
```

**Why:** Not all systems have jq installed. Python3 is mandatory, so it's the reliable choice.

**Reference:** See TD-006 for jq dependency handling patterns.

---

## 6. User Experience

### Clear Error Messages

**Error messages MUST be:**
- ✅ Clear about what went wrong
- ✅ Actionable (tell user how to fix it)
- ✅ Platform-specific (show install command for their OS)

**Pattern:**
```bash
# ✅ GOOD (clear, actionable, helpful)
echo "❌ Error: Python 3 is required but not installed"
echo ""
echo "Install Python 3:"
echo "  macOS:  brew install python3"
echo "  Ubuntu: sudo apt install python3"
echo "  WSL:    sudo apt install python3"
echo ""
exit 1

# ❌ BAD (cryptic, no guidance)
echo "Error: missing dependency"
exit 1
```

### Progress Indicators

**Use emojis and clear progress messages:**

```bash
echo "⚙️  Igris initializing..."
echo ""
echo "📦 Creating directory structure..."
mkdir -p ai/{briefs,session,context,prompts}

echo "📄 Copying templates..."
cp -r scripts/templates/* ai/

echo "✅ Igris AI initialized successfully!"
echo ""
echo "Next steps:"
echo "  1. Review CLAUDE.md"
echo "  2. Run your first session"
```

**Standard emojis:**
- ⚙️ - Initializing / processing
- 📦 - Creating / installing
- 📄 - Copying / writing files
- ✅ - Success
- ❌ - Error
- ⚠️  - Warning

### Confirmation Prompts

**Ask before destructive operations:**

```bash
if [ -f "CLAUDE.md" ]; then
  echo "⚠️  CLAUDE.md already exists"
  read -p "Overwrite? [y/N]: " CONFIRM
  if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "❌ Operation cancelled"
    exit 0
  fi
fi
```

---

## 7. Testing Requirements

### Test Coverage Targets

- **Critical paths:** 100% coverage (init, install, core workflows)
- **Error handling:** 80% coverage (all error cases tested)
- **Edge cases:** 60% coverage (unusual inputs handled)

### Test Framework

**Use bats (Bash Automated Testing System):**

```bash
# Install bats
npm install -g bats

# Run tests
bats test/
```

### Test Structure

**Tests live in `test/` directory:**

```
test/
├── igris_init.bats
├── plugin_install.bats
└── fixtures/
    ├── sample_plugin.json
    └── sample_persona.json
```

### Test Naming

```bash
@test "igris_init creates ai/ directory structure" {
  run ./scripts/igris_init.sh "$TEST_DIR"
  [ "$status" -eq 0 ]
  [ -d "$TEST_DIR/ai/briefs" ]
  [ -d "$TEST_DIR/ai/session" ]
  [ -d "$TEST_DIR/ai/context" ]
}

@test "plugin_install validates plugin.json exists" {
  run ./scripts/plugin_install.sh nonexistent-plugin.tar.gz
  [ "$status" -eq 1 ]
  [[ "$output" =~ "plugin.json not found" ]]
}

@test "check_python3 fails when python3 not in PATH" {
  PATH="/usr/bin" run ./scripts/igris_init.sh
  [ "$status" -eq 1 ]
  [[ "$output" =~ "Python 3 is required" ]]
}
```

### Test Best Practices

- **Isolation:** Each test runs in clean environment
- **Fixtures:** Use `test/fixtures/` for sample data
- **Cleanup:** Use `teardown()` to clean up after tests
- **Fast:** Tests should run in < 5 seconds total

**Reference:** See TD-005 for automated testing implementation.

---

## 8. Documentation

### Inline Comments

**Comment the WHY, not the WHAT:**

```bash
# ✅ GOOD (explains WHY)
# Use perl instead of sed because sed breaks with multi-line content
# See BR-005 for details on this bug
perl -pe "s/{{VAR}}/$VALUE/g" template > output

# ❌ BAD (states the obvious WHAT)
# Replace VAR with VALUE
perl -pe "s/{{VAR}}/$VALUE/g" template > output
```

### Function Documentation

**Document complex functions:**

```bash
# Validates that Python 3 is installed and accessible
# Exits with error code 1 and helpful message if not found
# Used by: igris_init.sh, plugin_install.sh
check_python3() {
  if ! command -v python3 &> /dev/null; then
    echo "❌ Error: Python 3 is required but not installed"
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
# Dependencies: python3, git
# Exit codes:
#   0 - Success
#   1 - Error (dependency missing, invalid directory, etc.)
```

---

## 9. Security

### Quote All Variables

**ALWAYS quote variables to prevent word splitting and glob expansion:**

```bash
# ✅ GOOD (prevents word splitting)
cp "$SOURCE_FILE" "$TARGET_DIR"
cd "$PROJECT_PATH"
rm -rf "$TEMP_DIR"

# ❌ BAD (breaks with spaces in paths)
cp $SOURCE_FILE $TARGET_DIR
cd $PROJECT_PATH
rm -rf $TEMP_DIR
```

### Validate File Paths

**Check file existence before operations:**

```bash
# Validate before reading
if [ ! -f "$CONFIG_FILE" ]; then
  echo "❌ Error: Config file not found: $CONFIG_FILE"
  exit 1
fi

# Validate before modifying
if [ ! -w "$TARGET_FILE" ]; then
  echo "❌ Error: Cannot write to: $TARGET_FILE"
  exit 1
fi
```

### Avoid eval

**Never use `eval` with user input:**

```bash
# ❌ DANGEROUS
eval "$USER_INPUT"

# ✅ SAFE: Use proper substitution
"${COMMANDS[$USER_CHOICE]}"
```

---

## 10. Performance

### Avoid Unnecessary Subshells

```bash
# ✅ GOOD (direct read)
version=$(cat version.txt)

# ❌ BAD (unnecessary pipe)
version=$(cat version.txt | head -n 1)

# ✅ BETTER (bash builtin)
version=$(<version.txt)
```

### Use Built-in Commands

```bash
# ✅ GOOD (bash builtin)
if [ -d "$DIR" ]; then
  echo "Directory exists"
fi

# ❌ BAD (spawns external process)
if test -d "$DIR"; then
  echo "Directory exists"
fi
```

### Minimize File Operations

```bash
# ✅ GOOD (single pass)
while IFS= read -r line; do
  process_line "$line"
done < input.txt

# ❌ BAD (reads file multiple times)
for line in $(cat input.txt); do
  process_line "$line"
done
```

---

## 11. Conventional Commits

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

- `feat(plugin): add hook system for persona injection`
- `fix(init): use perl instead of sed for multi-line substitution`
- `docs(readme): add installation instructions`
- `test(init): add test for directory creation`

### Commit Message Guidelines

```
✅ GOOD:
feat(plugin): add hook system for persona injection

Implemented {{PERSONA_INJECTION}} placeholder in CLAUDE.md template.
Plugin install script now reads hooks from plugin.json and injects
them during igris_init.sh execution.

closes #TD-003

✅ GOOD:
fix(init): use perl instead of sed for multi-line substitution

Fixes BR-005. The sed approach broke with newlines in persona content.
Now uses perl which handles newlines correctly across platforms.

❌ BAD:
fix: fixed bug

❌ BAD:
update files
```

### Reference Briefs in Footer

```
closes #TD-XXX
fixes #BR-XXX
refs #MG-XXX
```

---

## 12. Code Review Checklist

### Before Submitting PR

**Reviewer checklist (all must pass):**

- [ ] **Follows guidelines:** All sections of this document followed
- [ ] **Tests added/updated:** New code has corresponding tests
- [ ] **Tests pass:** `bats test/` runs successfully
- [ ] **Documentation updated:** Inline comments and README if needed
- [ ] **shellcheck passes:** `shellcheck scripts/*.sh` shows no errors
- [ ] **Cross-platform tested:** Tested on macOS and Linux (or WSL)
- [ ] **Error messages clear:** All error messages are actionable
- [ ] **No hardcoded paths:** Uses variables or derives paths
- [ ] **Variables quoted:** All variable references use `"$VAR"`
- [ ] **Conventional commits:** Commit message follows format
- [ ] **Brief referenced:** Commit footer references brief (if applicable)
- [ ] **set -e included:** Script fails fast on errors
- [ ] **Dependencies validated:** All required commands checked upfront

### Automated Checks

**Run before committing:**

```bash
# Lint all scripts
shellcheck scripts/*.sh

# Run tests
bats test/

# Check for common issues
grep -r "eval " scripts/    # Should return nothing
grep -r '\$[A-Z_]*[^"]' scripts/  # Find unquoted variables
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
- [shellcheck](https://www.shellcheck.net/) - Static analysis tool
- [Defensive Bash Programming](https://www.kfirlavi.com/blog/2012/11/14/defensive-bash-programming/)
- [bats](https://github.com/bats-core/bats-core) - Bash testing framework

### Related Igris AI Briefs

- **BR-005:** Plugin install regeneration bug (perl vs sed)
- **TD-004:** Python3 dependency validation
- **TD-005:** Automated shell script testing
- **TD-006:** Inconsistent jq dependency handling

### Internal Documentation

- `ai/prompts/igris_os.md` - Igris AI operating system (for Claude)
- `ai/templates/commit_message.md` - Commit message template
- `ai/CONTRIBUTING.md` - Contribution guide
- `README.md` - Project README

---

**Created:** 2025-10-26
**Version:** 2.0.0
**Maintained by:** Igris AI Team

---

✅ **Remember:** We enforce coding guidelines on user projects. We MUST follow our own standards.

Dogfooding is not optional. It's how we build trust.
