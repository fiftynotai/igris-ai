# TD-007: Generate Coding Guidelines for Igris AI Itself

**Type:** Technical Debt
**Priority:** P2-Medium
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Started:** 2025-10-26
**Completed:** 2025-10-26

---

## What is the Technical Debt?

**Current situation:**

Igris AI enforces `ai/context/coding_guidelines.md` on user projects, but **Igris AI itself has no coding guidelines** for its own codebase.

**The irony:**
- ✅ Igris tells users: "Follow coding_guidelines.md"
- ❌ Igris has no coding_guidelines.md for itself
- ✅ Igris enforces architecture patterns on users
- ❌ Igris has no documented architecture patterns

**Why is it technical debt?**

- **Dogfooding failure** - We don't practice what we preach
- No documented bash scripting standards
- No error handling patterns documented
- No testing requirements defined
- New contributors don't know the standards
- Inconsistencies creep in (see BR-005, TD-004, TD-006)

**Examples:**

```bash
# Current reality:
- Some scripts use `set -e`, some don't
- Some validate dependencies, some don't
- Some use perl for multi-line, some use sed
- No documented standard for any of this
```

---

## Why It Matters

**Consequences of not fixing:**

- [x] **Maintainability:** No standards → inconsistent code → hard to maintain
- [x] **Readability:** Different styles confuse contributors
- [ ] **Performance:** (Not directly affected)
- [ ] **Security:** Error handling inconsistencies can miss issues
- [x] **Scalability:** Hard to scale team without standards
- [x] **Developer Experience:** Contributors don't know what's expected

**Impact:** Medium

Without guidelines:
- Contributors guess at standards
- Code reviews are subjective
- Bugs like BR-005 slip through (inconsistent patterns)
- Quality degrades over time

---

## Tasks

### Completed
- [x] Task 1: Analyze existing Igris AI scripts for patterns (completed: 2025-10-26 10:55)
- [x] Task 2: Extract current conventions (what we do consistently) (completed: 2025-10-26 10:55)
- [x] Task 3: Create comprehensive coding_guidelines.md document (completed: 2025-10-26 11:00)
- [x] Task 4: Update CONTRIBUTING.md to reference guidelines (completed: 2025-10-26 11:05)
- [x] Task 5: Update CHANGELOG.md (completed: 2025-10-26 11:10)

---

## Session State (Tactical - This Brief)

**Current State:** ✅ All tasks completed - TD-007 successfully implemented
**Next Steps When Resuming:** N/A - Brief complete
**Last Updated:** 2025-10-26 11:10
**Blockers:** None
**Final Status:** Dogfooding achieved - Igris AI now has comprehensive coding guidelines

**Note:** Strategic session state (overall plan/phase) managed in `ai/session/CURRENT_SESSION.md`

---

## Cleanup Steps

**How to pay off this debt:**

1. Analyze existing Igris AI scripts for patterns
2. Extract current conventions (what we do consistently)
3. Document bash scripting standards
4. Document error handling patterns
5. Document testing requirements (from TD-005)
6. Document dependency validation (from TD-004, TD-006)
7. Document file structure and organization
8. Create `ai/context/coding_guidelines.md`
9. Update CONTRIBUTING.md to reference guidelines
10. Update CHANGELOG.md

---

## Benefits of Fixing

**What improves after cleanup:**

- ✅ **Dogfooding** - We practice what we preach!
- ✅ **Consistency** - All scripts follow same patterns
- ✅ **Onboarding** - New contributors know the standards
- ✅ **Code quality** - Clear quality bar
- ✅ **Code reviews** - Objective criteria
- ✅ **Future briefs** - Can reference standards
- ✅ **Credibility** - Users trust a system that uses its own tools

**Return on Investment:** High

This is a one-time investment (1-2 days) that improves every future contribution.

---

## Affected Areas

### Files to Create
- `ai/context/coding_guidelines.md` - **NEW** (comprehensive guidelines)

### Files to Modify
- `ai/CONTRIBUTING.md` - Reference coding_guidelines.md
- `README.md` - Link to guidelines for contributors
- `CHANGELOG.md` - Document addition

### Count
**Total files affected:** 3 (1 new, 2 modified)
**Total lines to write:** ~500-800 (comprehensive guidelines document)

---

## Content Outline

### ai/context/coding_guidelines.md Structure

```markdown
# Igris AI Coding Guidelines

**Version:** 2.0.0
**Language:** Bash
**Platform:** macOS, Linux, WSL

---

## 1. File Structure

### Script Organization
- Shebang: `#!/bin/bash`
- Fail-fast: `set -e` (always)
- Description comment block
- Function definitions
- Main execution logic

### Directory Structure
- scripts/ - Core scripts
- test/ - Test files
- ai/ - Igris AI directory structure
- docs/ - Documentation

---

## 2. Naming Conventions

### Scripts
- snake_case: `igris_init.sh`, `plugin_install.sh`
- Descriptive: Name indicates purpose
- Extension: Always `.sh`

### Functions
- snake_case: `check_python3()`, `create_directories()`
- Verbs: Start with action word

### Variables
- UPPERCASE for constants: `IGRIS_VERSION`
- lowercase for local: `target_dir`
- Descriptive: Avoid single letters (except i, j in loops)

---

## 3. Error Handling

### Fail-Fast
```bash
set -e  # Exit on error (ALWAYS include)
```

### Dependency Validation
```bash
# Validate dependencies upfront
check_python3() {
  if ! command -v python3 &> /dev/null; then
    echo "❌ Error: Python 3 is required but not installed"
    echo ""
    echo "Install Python 3:"
    echo "  macOS: brew install python3"
    echo "  Ubuntu: sudo apt install python3"
    echo ""
    exit 1
  fi
}

# Call early in script
check_python3
```

### User Input Validation
```bash
# Validate required parameters
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
```

---

## 4. Multi-line Text Handling

### Use perl for Multi-line Substitution
```bash
# WRONG (sed breaks with newlines):
sed "s|{{PLACEHOLDER}}|$MULTI_LINE_VAR|g" template > output

# CORRECT (perl handles newlines):
ESCAPED_VAR=$(printf '%s\n' "$MULTI_LINE_VAR" | perl -pe 's/([\\\/\$])/\\$1/g')
perl -pe "s/\{\{PLACEHOLDER\}\}/$ESCAPED_VAR/g" template > output
```

---

## 5. JSON Manipulation

### Use Python3 for JSON
```bash
# Extract from JSON
PLUGIN_NAME=$(cat plugin.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(data['name'])
")

# Update JSON
python3 <<EOF > updated.json
import json
with open('input.json', 'r') as f:
    data = json.load(f)
data['new_field'] = 'value'
print(json.dumps(data, indent=2))
EOF
```

### Use jq If Available (Optional)
```bash
# Check if jq available
if command -v jq &> /dev/null; then
  PLUGIN_NAME=$(jq -r '.name' plugin.json)
else
  # Fallback to python3 or warn user
fi
```

---

## 6. User Experience

### Clear Messages
```bash
# ✅ GOOD (clear, actionable)
echo "❌ Error: Python 3 is required but not installed"
echo ""
echo "Install Python 3:"
echo "  macOS: brew install python3"
echo "  Ubuntu: sudo apt install python3"
echo ""
exit 1

# ❌ BAD (cryptic, no guidance)
echo "Error: missing dependency"
exit 1
```

### Progress Indicators
```bash
echo "📦 Creating directory structure..."
mkdir -p ai/{briefs,session,context}

echo "📄 Copying templates..."
cp templates/* ai/

echo "✅ Igris AI initialized successfully!"
```

### Confirmation Prompts
```bash
read -p "Continue and overwrite? [y/N]: " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "❌ Operation cancelled"
  exit 0
fi
```

---

## 7. Testing Requirements

### Test Coverage
- Critical paths: 100%
- Error handling: 80%
- Edge cases: 60%

### Test Framework
- Use bats (Bash Automated Testing System)
- Tests in test/ directory
- Fixtures in test/fixtures/

### Test Naming
```bash
@test "igris_init creates ai/ directory" {
  # ... test
}

@test "plugin_install validates plugin.json exists" {
  # ... test
}
```

---

## 8. Documentation

### Inline Comments
```bash
# Good: Explain WHY, not WHAT
# Use perl instead of sed because sed breaks with multi-line content
perl -pe "s/{{VAR}}/$VALUE/g" template > output

# Bad: States the obvious
# Replace VAR with VALUE
perl -pe "s/{{VAR}}/$VALUE/g" template > output
```

### Function Documentation
```bash
# Validates that Python 3 is installed
# Exits with error message if not found
check_python3() {
  # ...
}
```

---

## 9. Security

### Quote Variables
```bash
# ✅ GOOD (prevents word splitting)
cp "$SOURCE_FILE" "$TARGET_DIR"

# ❌ BAD (breaks with spaces)
cp $SOURCE_FILE $TARGET_DIR
```

### Validate File Paths
```bash
# Check file exists before reading
if [ ! -f "$CONFIG_FILE" ]; then
  echo "❌ Error: Config file not found: $CONFIG_FILE"
  exit 1
fi
```

---

## 10. Performance

### Avoid Unnecessary Subshells
```bash
# ✅ GOOD
version=$(cat version.txt)

# ❌ BAD (unnecessary cat)
version=$(cat version.txt | head -n 1)
```

### Use Built-in Commands
```bash
# ✅ GOOD
if [ -d "$DIR" ]; then

# ❌ BAD (spawns process)
if test -d "$DIR"; then
```

---

## 11. Conventional Commits

### Commit Format
```
<type>(<scope>): <short summary>

<optional body>

<optional footer>
```

### Types
- feat: New feature
- fix: Bug fix
- refactor: Code refactoring
- docs: Documentation
- chore: Maintenance
- test: Tests

### Examples
```
feat(plugin): add hook system for persona injection

fix(init): use perl instead of sed for multi-line substitution

Fixes BR-005. The sed approach broke with newlines in persona content.
Now uses perl which handles newlines correctly.
```

---

## 12. Code Review Checklist

Before submitting PR:
- [ ] Follows all guidelines above
- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] shellcheck passes
- [ ] Tested on macOS and Linux
- [ ] Error messages are clear
- [ ] No hardcoded paths
- [ ] Variables quoted
- [ ] Conventional commit format
```

---

## Testing

### Regression Testing
- [ ] Existing scripts still follow guidelines (audit)
- [ ] No functionality changes

### Verification
**How to verify cleanup is successful:**

1. Guidelines document created
2. All sections comprehensive
3. Examples provided for each pattern
4. CONTRIBUTING.md references guidelines
5. Future PRs can be reviewed against guidelines

---

## Acceptance Criteria

**The debt is paid off when:**

1. [ ] `ai/context/coding_guidelines.md` created
2. [ ] All bash scripting patterns documented
3. [ ] Error handling patterns documented
4. [ ] Testing requirements documented
5. [ ] Examples provided for each pattern
6. [ ] CONTRIBUTING.md references guidelines
7. [ ] README.md links to guidelines
8. [ ] CHANGELOG.md updated

---

## References

**Best Practices:**
- [Google Shell Style Guide](https://google.github.io/styleguide/shellguide.html)
- [shellcheck](https://www.shellcheck.net/) - Static analysis
- [Defensive Bash Programming](https://www.kfirlavi.com/blog/2012/11/14/defensive-bash-programming/)

**Related Briefs:**
- BR-005 - Would have been prevented by documented multi-line pattern
- TD-004 - Python3 validation pattern needs documentation
- TD-005 - Testing requirements need documentation
- TD-006 - jq handling pattern needs documentation

**Existing Igris AI Documentation:**
- `ai/prompts/igris_os.md` - Operating system (for Claude)
- `ai/templates/commit_message.md` - Commit format
- `ai/CONTRIBUTING.md` - Contribution guide

---

## Notes

### Why This Matters

**Credibility:** Users trust systems that use their own tools. If Igris enforces coding guidelines but doesn't have its own, users will question the value.

**Example conversation:**
```
User: "Should I create coding_guidelines.md for my project?"
Igris: "Yes! It's critical for code quality."
User: "Does Igris AI have coding_guidelines.md?"
Igris: "..."
```

This is embarrassing. We need to fix it.

### Content Sources

Extract from existing code:
- igris_init.sh - Good error handling examples
- plugin_install.sh - Multi-line handling (both correct and broken!)
- All scripts - Consistent patterns (set -e, progress messages, etc.)

---

**Created:** 2025-10-25
**Last Updated:** 2025-10-25
**Brief Owner:** Igris AI Self-Audit
